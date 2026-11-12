import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_A, TENANT_B } from "../support/fakes.js";
import { asAdmin, asTrader, call, closedMarket, createHarness, draftMarket, expectContract, openedMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

const MISSING_ID = "018f3c1e-7a00-7000-8000-0000000000f9";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});

const outboxTypes = () => h.core.store.snapshot().outbox.map((row) => row.type);

describe("POST /v1/markets/{id}/open", () => {
  it("funds the market and answers 200 with the open market; MarketOpened is written in the same commit", async () => {
    const draft = await draftMarket(h, asAdmin("creator-1"));
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token: asAdmin("creator-1"), headers: { "x-correlation-id": "open-corr-1" } });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: draft["id"], status: "open", version: 3, openedAt: expect.any(String) as string, outcome: null });
    expectContract("/v1/markets/{id}/open", "POST", answer);

    expect(h.core.funding.calls).toEqual([
      { request: { marketId: draft["id"], tenantId: TENANT_A, creatorId: "creator-1", amount: 500 }, idempotencyKey: draft["id"] },
    ]);
    const [event, ...rest] = h.core.store.snapshot().outbox;
    expect(rest).toEqual([]);
    expect(event?.type).toBe("si.chance.markets.MarketOpened.v1");
    expect(event?.payload).toMatchObject({ tenantid: TENANT_A, correlationid: "open-corr-1", subject: `market/${draft["id"]}` });
    expect(event?.payload["causationid"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.core.store.snapshot().pendingOpenings).toEqual([]);
  });

  it("accepts Content-Type: application/json with no body (the contract says: no request body)", async () => {
    const draft = await draftMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { headers: { "content-type": "application/json" } });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: draft["id"], status: "open" });
    expectContract("/v1/markets/{id}/open", "POST", answer);
  });

  it("answers 409 insufficient_credits when trading says so; the market is back in draft and nothing is published", async () => {
    h.core.funding.mode = "insufficient";
    const draft = await draftMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`);

    expect(answer.status).toBe(409);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.body).toMatchObject({ code: "insufficient_credits", type: "urn:chance:problem:insufficient-credits", status: 409 });
    expectContract("/v1/markets/{id}/open", "POST", answer);

    const after = await call(h, "GET", `/v1/markets/${draft["id"]}`);
    expect(after.body).toMatchObject({ status: "draft", version: 3, openedAt: null });
    expect(outboxTypes()).toEqual([]);
    expect(h.core.store.snapshot().pendingOpenings).toEqual([]);

    // The creator may try again once the credits are there.
    h.core.funding.mode = "funded";
    expect((await call(h, "POST", `/v1/markets/${draft["id"]}/open`)).status).toBe(200);
  });

  it("answers 502 funding_rejected when trading refuses the request; the market is back in draft", async () => {
    h.core.funding.enqueue({ kind: "rejected", status: 422, detail: "the key was used with another body" });
    const draft = await draftMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`);

    expect(answer.status).toBe(502);
    expect(answer.body).toMatchObject({ code: "funding_rejected", type: "urn:chance:problem:funding-rejected", status: 502 });
    expectContract("/v1/markets/{id}/open", "POST", answer);
    expect((await call(h, "GET", `/v1/markets/${draft["id"]}`)).body).toMatchObject({ status: "draft" });
    expect(outboxTypes()).toEqual([]);
  });

  it("answers 503 trading_unavailable with Retry-After when nothing was sent; the market is back in draft", async () => {
    h.core.funding.enqueue({ kind: "not_sent", reason: "the circuit to trading is open", retryAfterSeconds: 10 });
    const draft = await draftMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`);

    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("10");
    expect(answer.body).toMatchObject({ code: "trading_unavailable", type: "urn:chance:problem:trading-unavailable", status: 503 });
    expectContract("/v1/markets/{id}/open", "POST", answer);
    expect((await call(h, "GET", `/v1/markets/${draft["id"]}`)).body).toMatchObject({ status: "draft" });
  });

  it("answers 202 with the opening market when the outcome is unknown, and 202 again without a new call", async () => {
    h.core.funding.mode = "unknown";
    const draft = await draftMarket(h);
    const first = await call(h, "POST", `/v1/markets/${draft["id"]}/open`);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ id: draft["id"], status: "opening", version: 2 });
    expectContract("/v1/markets/{id}/open", "POST", first);
    expect(h.core.store.snapshot().pendingOpenings).toHaveLength(1);

    const again = await call(h, "POST", `/v1/markets/${draft["id"]}/open`);
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ status: "opening", version: 2 });
    expect(h.core.funding.calls).toHaveLength(1);
    expect(outboxTypes()).toEqual([]);
  });

  it("finishes an opening that the request left unknown, when the retry worker's use case gets an answer", async () => {
    h.core.funding.mode = "unknown";
    const draft = await draftMarket(h);
    await call(h, "POST", `/v1/markets/${draft["id"]}/open`);
    const [pending] = h.core.store.snapshot().pendingOpenings;
    expect(pending).toBeDefined();

    h.core.funding.mode = "funded";
    h.core.clock.advanceMs(10 * 60_000);
    const outcome = await h.core.useCases.retryOpening.execute(pending!);
    expect(outcome.kind).toBe("opened");
    const after = await call(h, "GET", `/v1/markets/${draft["id"]}`);
    expect(after.body).toMatchObject({ status: "open", version: 3 });
    expect(h.core.funding.calls.map((c) => c.idempotencyKey)).toEqual([draft["id"], draft["id"]]);
  });

  it("answers 403 to another tenant admin: only the creator's credits fund a market", async () => {
    const draft = await draftMarket(h, asAdmin("creator-1"));
    const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token: asAdmin("other-admin") });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "forbidden" });
    expectContract("/v1/markets/{id}/open", "POST", answer);
    expect(h.core.funding.calls).toEqual([]);
    expect((await call(h, "GET", `/v1/markets/${draft["id"]}`)).body).toMatchObject({ status: "draft", version: 1 });
  });

  it("answers 409 invalid_state for a market that is not a draft", async () => {
    const open = await openedMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${open["id"]}/open`);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "invalid_state", type: "urn:chance:problem:invalid-state" });
    expectContract("/v1/markets/{id}/open", "POST", answer);
    expect(h.core.funding.calls).toHaveLength(1);
  });

  it("answers 404 for a market that does not exist and for one of another tenant", async () => {
    const theirs = await draftMarket(h, asAdmin("creator-b", TENANT_B));
    for (const id of [MISSING_ID, theirs["id"]]) {
      const answer = await call(h, "POST", `/v1/markets/${id}/open`, { token: asAdmin("creator-b", TENANT_A) });
      expect(answer.status).toBe(404);
      expectContract("/v1/markets/{id}/open", "POST", answer);
    }
    expect(h.core.funding.calls).toEqual([]);
  });
});

describe("POST /v1/markets/{id}/close", () => {
  it("closes an open market for any admin of the tenant and publishes MarketClosed", async () => {
    const open = await openedMarket(h, asAdmin("creator-1"));
    const answer = await call(h, "POST", `/v1/markets/${open["id"]}/close`, { token: asAdmin("other-admin"), headers: { "x-correlation-id": "close-corr" } });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "closed", version: 4, closedBy: "other-admin", closedAt: expect.any(String) as string });
    expectContract("/v1/markets/{id}/close", "POST", answer);
    expect(outboxTypes()).toEqual(["si.chance.markets.MarketOpened.v1", "si.chance.markets.MarketClosed.v1"]);
    expect(h.core.store.snapshot().outbox[1]?.payload).toMatchObject({ correlationid: "close-corr", data: { marketId: open["id"], version: 4 } });
  });

  it("accepts Content-Type: application/json with no body (the contract says: no request body), and with an empty object", async () => {
    const json = { "content-type": "application/json" };
    const first = await openedMarket(h);
    const empty = await call(h, "POST", `/v1/markets/${first["id"]}/close`, { headers: json });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ status: "closed" });
    expectContract("/v1/markets/{id}/close", "POST", empty);

    const second = await openedMarket(h);
    const object = await call(h, "POST", `/v1/markets/${second["id"]}/close`, { body: {} });
    expect(object.status).toBe(200);
  });

  it.each([
    ["a draft", async () => draftMarket(h)],
    ["a closed market", async () => closedMarket(h)],
  ])("answers 409 invalid_state for %s", async (_name, make) => {
    const market = await make();
    const answer = await call(h, "POST", `/v1/markets/${market["id"]}/close`);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "invalid_state" });
    expectContract("/v1/markets/{id}/close", "POST", answer);
  });

  it("answers 404 for a market of another tenant, and 403 to a trader before anything else", async () => {
    const theirs = await openedMarket(h, asAdmin("creator-b", TENANT_B));
    const other = await call(h, "POST", `/v1/markets/${theirs["id"]}/close`, { token: asAdmin("admin-a", TENANT_A) });
    expect(other.status).toBe(404);
    expectContract("/v1/markets/{id}/close", "POST", other);
    const trader = await call(h, "POST", `/v1/markets/${theirs["id"]}/close`, { token: asTrader("t-1", TENANT_B) });
    expect(trader.status).toBe(403);
    expect((await call(h, "GET", `/v1/markets/${theirs["id"]}`, { token: asAdmin("creator-b", TENANT_B) })).body).toMatchObject({ status: "open" });
  });
});

describe("POST /v1/markets/{id}/resolve", () => {
  it.each(["YES", "NO", "INVALID"])("resolves a closed market with %s and publishes MarketResolved", async (outcome) => {
    const closed = await closedMarket(h, asAdmin("creator-1"));
    const answer = await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`, { token: asAdmin("other-admin"), body: { outcome } });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ status: "resolved", outcome, version: 5, resolvedBy: "other-admin", resolvedAt: expect.any(String) as string });
    expectContract("/v1/markets/{id}/resolve", "POST", answer);
    expect(outboxTypes()).toEqual([
      "si.chance.markets.MarketOpened.v1",
      "si.chance.markets.MarketClosed.v1",
      "si.chance.markets.MarketResolved.v1",
    ]);
    expect(h.core.store.snapshot().outbox[2]?.payload).toMatchObject({ data: { marketId: closed["id"], outcome, creatorId: "creator-1", version: 5 } });
  });

  it.each([
    ["an outcome that is neither YES, NO nor INVALID", { outcome: "MAYBE" }],
    ["an outcome in lower case", { outcome: "yes" }],
    ["INVALID in lower case", { outcome: "invalid" }],
    ["no outcome", {}],
    ["an unknown field", { outcome: "YES", reason: "because" }],
    ["an outcome that is not text", { outcome: { value: "YES" } }],
  ])("answers 400 for %s and changes nothing", async (_name, body) => {
    const closed = await closedMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`, { body });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ code: "validation_failed" });
    expectContract("/v1/markets/{id}/resolve", "POST", answer);
    expect((await call(h, "GET", `/v1/markets/${closed["id"]}`)).body).toMatchObject({ status: "closed", outcome: null });
  });

  it("answers 400 when the request has no body at all", async () => {
    const closed = await closedMarket(h);
    const answer = await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`);
    expect(answer.status).toBe(400);
  });

  it("answers 409 invalid_state for a market that is not closed, and for one that is resolved already", async () => {
    const open = await openedMarket(h);
    const early = await call(h, "POST", `/v1/markets/${open["id"]}/resolve`, { body: { outcome: "YES" } });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "invalid_state" });
    expectContract("/v1/markets/{id}/resolve", "POST", early);

    const closed = await closedMarket(h);
    expect((await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`, { body: { outcome: "NO" } })).status).toBe(200);
    const twice = await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`, { body: { outcome: "YES" } });
    expect(twice.status).toBe(409);
    expect((await call(h, "GET", `/v1/markets/${closed["id"]}`)).body).toMatchObject({ outcome: "NO", version: 5 });
    expect((await call(h, "POST", `/v1/markets/${closed["id"]}/close`)).status).toBe(409);
  });

  it("answers 404 for a market of another tenant or one that does not exist", async () => {
    const theirs = await closedMarket(h, asAdmin("creator-b", TENANT_B));
    for (const id of [MISSING_ID, theirs["id"]]) {
      const answer = await call(h, "POST", `/v1/markets/${id}/resolve`, { token: asAdmin("admin-a", TENANT_A), body: { outcome: "YES" } });
      expect(answer.status).toBe(404);
      expectContract("/v1/markets/{id}/resolve", "POST", answer);
    }
  });
});

describe("the whole life of a market", () => {
  it("goes draft, opening, open, closed, resolved with the version rising by one at every step (DM-04)", async () => {
    const draft = await draftMarket(h, asAdmin("creator-1"));
    const versions = [draft["version"]];
    h.core.funding.mode = "unknown";
    const opening = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token: asAdmin("creator-1") });
    versions.push(opening.body?.["version"]);
    h.core.funding.mode = "funded";
    const [pending] = h.core.store.snapshot().pendingOpenings;
    await h.core.useCases.retryOpening.execute(pending!);
    versions.push((await call(h, "GET", `/v1/markets/${draft["id"]}`)).body?.["version"]);
    versions.push((await call(h, "POST", `/v1/markets/${draft["id"]}/close`)).body?.["version"]);
    versions.push((await call(h, "POST", `/v1/markets/${draft["id"]}/resolve`, { body: { outcome: "YES" } })).body?.["version"]);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });
});
