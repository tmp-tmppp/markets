import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_A, TENANT_B } from "../support/fakes.js";
import { asAdmin, asTrader, call, createHarness, draftMarket, expectContract, openedMarket, validMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

const UNPROVISIONED = "018f3c1e-7a00-7000-8000-0000000000cc";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});

describe("POST /v1/markets", () => {
  it("creates a draft at version 1 for the caller's tenant, answers 201 with Location and the contract's body", async () => {
    const answer = await call(h, "POST", "/v1/markets", { token: asAdmin("admin-7"), body: validMarket(h, { question: "  Will the new bridge open before 2027?  " }) });

    expect(answer.status).toBe(201);
    expect(answer.headers["location"]).toBe(`/v1/markets/${answer.body?.["id"]}`);
    expect(answer.body).toMatchObject({
      tenantId: TENANT_A,
      question: "Will the new bridge open before 2027?",
      description: "Counts the first day the bridge is open to traffic.",
      startingPrice: 0.4,
      fundingAmount: 500,
      status: "draft",
      outcome: null,
      version: 1,
      createdBy: "admin-7",
      openedAt: null,
      closedAt: null,
      closedBy: null,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(answer.body?.["closeTime"]).toBe(validMarket(h)["closeTime"]);
    expect(answer.body?.["createdAt"]).toBe("2026-11-01T10:00:00.000Z");
    expectContract("/v1/markets", "POST", answer);
    // A draft is private: it writes no event.
    expect(h.core.store.snapshot().outbox).toEqual([]);
  });

  it("defaults the description to an empty text", async () => {
    const { description: _unused, ...withoutDescription } = validMarket(h);
    const answer = await call(h, "POST", "/v1/markets", { body: withoutDescription });
    expect(answer.status).toBe(201);
    expect(answer.body?.["description"]).toBe("");
  });

  it("answers 400 and names every field the schema refuses: missing, unknown and mistyped", async () => {
    const answer = await call(h, "POST", "/v1/markets", { body: { question: 12, bogus: true, startingPrice: "high" } });
    expect(answer.status).toBe(400);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.body).toMatchObject({ status: 400, code: "validation_failed", type: "urn:chance:problem:validation-failed" });
    const fields = (answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field);
    expect(fields).toEqual(expect.arrayContaining(["bogus", "closeTime", "fundingAmount"]));
    expectContract("/v1/markets", "POST", answer);
  });

  it("answers 400 for a body that is not an object, and for malformed JSON, as problem details", async () => {
    const notObject = await call(h, "POST", "/v1/markets", { body: [] });
    expect(notObject.status).toBe(400);
    const malformed = await h.app.inject({
      method: "POST",
      url: "/v1/markets",
      headers: { ...(await h.bearer(asAdmin())), "content-type": "application/json" },
      payload: '{"question": ',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/problem+json");
  });

  it("answers 413 as problem details for a body over the limit", async () => {
    const answer = await call(h, "POST", "/v1/markets", { body: validMarket(h, { description: "x".repeat(20_000) }) });
    expect(answer.status).toBe(413);
    expect(answer.body).toMatchObject({ status: 413 });
  });

  it.each([
    ["a question that is too short", { question: "Short?" }, "question"],
    ["a question of only spaces", { question: "               " }, "question"],
    ["a question over 200 characters", { question: "q".repeat(201) }, "question"],
    ["a question with a control character", { question: "Will it\u0000 rain tomorrow?" }, "question"],
    ["a description over 2000 characters", { description: "d".repeat(2001) }, "description"],
    // The contract says number, integer and string: a value of another type is refused, not converted.
    ["a starting price sent as text", { startingPrice: "0.35" }, "startingPrice"],
    ["a funding amount sent as text", { fundingAmount: "500" }, "fundingAmount"],
    ["a question sent as a number", { question: 1_234_567_890 }, "question"],
    ["a description that is null", { description: null }, "description"],
    ["a starting price of 0", { startingPrice: 0 }, "startingPrice"],
    ["a starting price of 1", { startingPrice: 1 }, "startingPrice"],
    ["a starting price with three decimals", { startingPrice: 0.123 }, "startingPrice"],
    ["a funding amount below the minimum", { fundingAmount: 99 }, "fundingAmount"],
    ["a funding amount above the maximum", { fundingAmount: 100_001 }, "fundingAmount"],
    ["a funding amount that is not a whole number", { fundingAmount: 100.5 }, "fundingAmount"],
    ["a close time that is not a date", { closeTime: "next tuesday" }, "closeTime"],
    ["a close time without a time zone", { closeTime: "2027-01-01T10:00:00" }, "closeTime"],
    ["a close time inside the minimum lead (4 minutes ahead)", { closeTime: new Date(Date.parse("2026-11-01T10:04:00.000Z")).toISOString() }, "closeTime"],
    ["a close time in the past", { closeTime: "2026-10-01T10:00:00.000Z" }, "closeTime"],
    ["a close time more than 366 days ahead", { closeTime: "2028-01-01T10:00:00.000Z" }, "closeTime"],
  ])("answers 400 naming the field for %s", async (_name, override, field) => {
    const answer = await call(h, "POST", "/v1/markets", { body: validMarket(h, override) });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "validation_failed" });
    expect((answer.body?.["errors"] as Array<{ field: string }>).map((error) => error.field)).toContain(field);
    expectContract("/v1/markets", "POST", answer);
    expect(h.core.store.snapshot().markets).toEqual([]);
  });

  it("answers 400 validation_failed, not a framework error, for Content-Type: application/json with an empty body", async () => {
    const answer = await call(h, "POST", "/v1/markets", { headers: { "content-type": "application/json" } });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "validation_failed" });
    expectContract("/v1/markets", "POST", answer);
  });

  it("still coerces the querystring, which arrives as text", async () => {
    await draftMarket(h);
    await draftMarket(h);
    const answer = await call(h, "GET", "/v1/markets?limit=1");
    expect(answer.status).toBe(200);
    expect(answer.body?.["items"]).toHaveLength(1);
    expect((await call(h, "GET", "/v1/markets?limit=abc")).status).toBe(400);
  });

  it("uses the funding bounds of the runtime configuration as they are at the moment of the request", async () => {
    h.core.rules.set({ ...h.core.rules.get(), marketRules: { fundingMin: 10, fundingMax: 50, minLeadMs: 60_000 } });
    expect((await call(h, "POST", "/v1/markets", { body: validMarket(h, { fundingAmount: 60 }) })).status).toBe(400);
    expect((await call(h, "POST", "/v1/markets", { body: validMarket(h, { fundingAmount: 20 }) })).status).toBe(201);
  });
});

describe("GET /v1/markets", () => {
  it("lists newest first and pages with the cursor of the response", async () => {
    const created: string[] = [];
    for (let n = 0; n < 5; n += 1) created.push((await draftMarket(h))["id"] as string);

    const first = await call(h, "GET", "/v1/markets?limit=2");
    expect(first.status).toBe(200);
    expect(first.body?.["items"].map((m: { id: string }) => m.id)).toEqual([created[4], created[3]]);
    expect(first.body?.["nextCursor"]).toEqual(expect.any(String));
    expectContract("/v1/markets", "GET", first);

    const second = await call(h, "GET", `/v1/markets?limit=2&cursor=${encodeURIComponent(first.body?.["nextCursor"])}`);
    expect(second.body?.["items"].map((m: { id: string }) => m.id)).toEqual([created[2], created[1]]);
    const third = await call(h, "GET", `/v1/markets?limit=2&cursor=${encodeURIComponent(second.body?.["nextCursor"])}`);
    expect(third.body).toMatchObject({ items: [{ id: created[0] }], nextCursor: null });
    expectContract("/v1/markets", "GET", third);
  });

  it("filters by status, and lets a tenant admin see every status", async () => {
    const draft = await draftMarket(h);
    const open = await openedMarket(h);
    h.core.funding.mode = "unknown";
    const opening = (await call(h, "POST", `/v1/markets/${(await draftMarket(h))["id"]}/open`)).body ?? {};
    expect(opening["status"]).toBe("opening");

    const all = await call(h, "GET", "/v1/markets");
    expect(all.body?.["items"].map((m: { status: string }) => m.status).sort()).toEqual(["draft", "open", "opening"]);
    for (const [status, id] of [
      ["draft", draft["id"]],
      ["open", open["id"]],
      ["opening", opening["id"]],
    ] as const) {
      const filtered = await call(h, "GET", `/v1/markets?status=${status}`);
      expect(filtered.body?.["items"].map((m: { id: string }) => m.id)).toEqual([id]);
    }
    expect((await call(h, "GET", "/v1/markets?status=resolved")).body?.["items"]).toEqual([]);
  });

  it("leaves draft and opening markets out of a trader's list, and answers 403 when a trader asks for them", async () => {
    await draftMarket(h);
    h.core.funding.mode = "unknown";
    await call(h, "POST", `/v1/markets/${(await draftMarket(h))["id"]}/open`);
    h.core.funding.mode = "funded";
    const open = await openedMarket(h);

    const trader = asTrader();
    const list = await call(h, "GET", "/v1/markets", { token: trader });
    expect(list.body?.["items"].map((m: { id: string }) => m.id)).toEqual([open["id"]]);
    for (const status of ["draft", "opening"]) {
      const forbidden = await call(h, "GET", `/v1/markets?status=${status}`, { token: trader });
      expect(forbidden.status, status).toBe(403);
      expect(forbidden.body).toMatchObject({ code: "forbidden" });
      expectContract("/v1/markets", "GET", forbidden);
    }
    expect((await call(h, "GET", "/v1/markets?status=open", { token: trader })).status).toBe(200);
  });

  it("shows a tenant only its own markets", async () => {
    const mine = await draftMarket(h, asAdmin("admin-a", TENANT_A));
    const theirs = await draftMarket(h, asAdmin("admin-b", TENANT_B));
    const listA = await call(h, "GET", "/v1/markets", { token: asAdmin("admin-a", TENANT_A) });
    const listB = await call(h, "GET", "/v1/markets", { token: asAdmin("admin-b", TENANT_B) });
    expect(listA.body?.["items"].map((m: { id: string }) => m.id)).toEqual([mine["id"]]);
    expect(listB.body?.["items"].map((m: { id: string }) => m.id)).toEqual([theirs["id"]]);
    expect(listB.body?.["items"][0].tenantId).toBe(TENANT_B);
  });

  it.each([
    ["a limit of 0", "limit=0"],
    ["a limit over 100", "limit=101"],
    ["a limit that is not a number", "limit=many"],
    ["an unknown status", "status=pending"],
    ["a cursor that is not one of ours", "cursor=AAAA"],
    ["an unknown query parameter", "sort=asc"],
  ])("answers 400 for %s", async (_name, query) => {
    const answer = await call(h, "GET", `/v1/markets?${query}`);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "validation_failed" });
    expectContract("/v1/markets", "GET", answer);
  });
});

describe("GET /v1/markets/{id}", () => {
  it("returns the market to a tenant admin in any status, and to a trader once it is open", async () => {
    const draft = await draftMarket(h);
    const asAdminAnswer = await call(h, "GET", `/v1/markets/${draft["id"]}`);
    expect(asAdminAnswer.status).toBe(200);
    expect(asAdminAnswer.body).toEqual(draft);
    expectContract("/v1/markets/{id}", "GET", asAdminAnswer);

    const asTraderAnswer = await call(h, "GET", `/v1/markets/${draft["id"]}`, { token: asTrader() });
    expect(asTraderAnswer.status).toBe(404);
    expect(asTraderAnswer.body).toMatchObject({ code: "not_found", status: 404 });
    expectContract("/v1/markets/{id}", "GET", asTraderAnswer);

    const open = await openedMarket(h);
    expect((await call(h, "GET", `/v1/markets/${open["id"]}`, { token: asTrader() })).status).toBe(200);
  });

  it("answers 404 for a trader about an opening market", async () => {
    h.core.funding.mode = "unknown";
    const opening = (await call(h, "POST", `/v1/markets/${(await draftMarket(h))["id"]}/open`)).body ?? {};
    expect((await call(h, "GET", `/v1/markets/${opening["id"]}`)).status).toBe(200);
    expect((await call(h, "GET", `/v1/markets/${opening["id"]}`, { token: asTrader() })).status).toBe(404);
  });

  it("answers 404, never 403, for a market of another tenant, exactly like one that does not exist", async () => {
    const theirs = await draftMarket(h, asAdmin("admin-b", TENANT_B));
    const other = await call(h, "GET", `/v1/markets/${theirs["id"]}`, { token: asAdmin("admin-a", TENANT_A) });
    const missing = await call(h, "GET", "/v1/markets/018f3c1e-7a00-7000-8000-0000000000f2", { token: asAdmin("admin-a", TENANT_A) });
    expect(other.status).toBe(404);
    expect({ ...other.body, instance: "", detail: "" }).toEqual({ ...missing.body, instance: "", detail: "" });
  });

  it("accepts a market id in upper case and answers 400 for an id that is not a UUID", async () => {
    const draft = await draftMarket(h);
    expect((await call(h, "GET", `/v1/markets/${String(draft["id"]).toUpperCase()}`)).status).toBe(200);
    const bad = await call(h, "GET", "/v1/markets/not-a-uuid");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "validation_failed" });
    expectContract("/v1/markets/{id}", "GET", bad);
  });
});

describe("a tenant that is not set up yet (503)", () => {
  it("answers 503 tenant_not_ready with Retry-After on every endpoint, and creates nothing", async () => {
    const token = asAdmin("admin-c", UNPROVISIONED);
    const id = "018f3c1e-7a00-7000-8000-0000000000f3";
    const requests = [
      ["GET", "/v1/markets", "/v1/markets", undefined],
      ["GET", `/v1/markets/${id}`, "/v1/markets/{id}", undefined],
      ["POST", "/v1/markets", "/v1/markets", validMarket(h)],
      ["POST", `/v1/markets/${id}/open`, "/v1/markets/{id}/open", undefined],
      ["POST", `/v1/markets/${id}/close`, "/v1/markets/{id}/close", undefined],
      ["POST", `/v1/markets/${id}/resolve`, "/v1/markets/{id}/resolve", { outcome: "NO" }],
    ] as const;
    for (const [method, url, path, body] of requests) {
      const answer = await call(h, method, url, { token, ...(body === undefined ? {} : { body }) });
      expect(answer.status, `${method} ${url}`).toBe(503);
      expect(answer.headers["retry-after"]).toBe("5");
      expect(answer.headers["content-type"]).toContain("application/problem+json");
      expect(answer.body).toMatchObject({ code: "tenant_not_ready", type: "urn:chance:problem:tenant-not-ready", status: 503 });
      expectContract(path, method, answer);
    }
    expect(h.core.store.snapshot().markets).toEqual([]);
    expect(h.core.funding.calls).toEqual([]);
  });

  it("serves the tenant as soon as its TenantCreated has been processed", async () => {
    const token = asAdmin("admin-c", UNPROVISIONED);
    expect((await call(h, "GET", "/v1/markets", { token })).status).toBe(503);
    await h.core.useCases.provisionTenant.execute({
      eventId: "018f3c1e-7a00-7000-8000-0000000000e1",
      eventType: "si.chance.tenants.TenantCreated.v1",
      tenantId: UNPROVISIONED,
      correlationId: null,
    });
    expect((await call(h, "GET", "/v1/markets", { token })).status).toBe(200);
  });

  it("provisions a tenant on its first request when the store runs in local mode", async () => {
    const local = await createHarness({ autoProvision: true, provision: false });
    const answer = await call(local, "POST", "/v1/markets", { token: asAdmin("admin-c", UNPROVISIONED), body: validMarket(local) });
    expect(answer.status).toBe(201);
    await local.app.close();
  });
});
