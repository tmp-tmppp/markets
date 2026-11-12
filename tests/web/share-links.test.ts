import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { natsSubject } from "../../src/domain/events.js";
import { eventErrors } from "../support/contracts.js";
import { SequentialTokens, TENANT_A, TENANT_B } from "../support/fakes.js";
import { INTERNAL_AUDIENCE, asAdmin, asPlatformAdmin, asService, asTrader, call, createHarness, draftMarket, expectContract, validMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";
import type { TokenOptions } from "../support/tokens.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.app.close();
});

const LOOKUP = "/v1/shared-markets/lookup";
const ADMISSION = "/v1/internal/share-links/admission";
const linksUrl = (marketId: string) => `/v1/markets/${marketId}/share-links`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** An open market of tenant A with the given sharing policy (default: members share with members). */
async function openMarket(sharing?: unknown, token = asAdmin("owner-1")): Promise<string> {
  const draft = await draftMarket(h, token, sharing === undefined ? {} : { sharing });
  const opened = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return String(draft["id"]);
}

const ALL_TYPES = { whoMayShare: "members", linkTypes: ["members", "profiles", "everyone"] };

/** Makes a link and returns its answer body (the token is in it). */
async function makeLink(marketId: string, body: Record<string, unknown>, token = asAdmin("owner-1")): Promise<Record<string, any>> {
  h.core.clock.tick();
  const answer = await call(h, "POST", linksUrl(marketId), { token, body });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body ?? {};
}

describe("sharing policy of a market", () => {
  it("defaults to members sharing with members, and returns the policy on every read", async () => {
    const draft = await draftMarket(h);
    expect(draft["sharing"]).toEqual({ whoMayShare: "members", linkTypes: ["members"] });
    const read = await call(h, "GET", `/v1/markets/${draft["id"]}`);
    expect(read.body?.["sharing"]).toEqual({ whoMayShare: "members", linkTypes: ["members"] });
    expectContract("/v1/markets/{id}", "GET", read);
    const list = await call(h, "GET", "/v1/markets");
    expectContract("/v1/markets", "GET", list);
  });

  it("stores the policy given at creation, once each and in the canonical order", async () => {
    const draft = await draftMarket(h, asAdmin(), { sharing: { whoMayShare: "admins", linkTypes: ["everyone", "members", "everyone"] } });
    expect(draft["sharing"]).toEqual({ whoMayShare: "admins", linkTypes: ["members", "everyone"] });
    const partial = await draftMarket(h, asAdmin(), { sharing: { whoMayShare: "none" } });
    expect(partial["sharing"]).toEqual({ whoMayShare: "none", linkTypes: ["members"] });
    const empty = await draftMarket(h, asAdmin(), { sharing: { linkTypes: [] } });
    expect(empty["sharing"]).toEqual({ whoMayShare: "members", linkTypes: [] });
  });

  it("refuses a policy that is not valid, naming the field", async () => {
    const bad: Array<[unknown, string]> = [
      [{ whoMayShare: "everybody" }, "sharing.whoMayShare"],
      [{ linkTypes: ["members", "world"] }, "sharing.linkTypes"],
      [{ linkTypes: "members" }, "sharing.linkTypes"],
      [{ whoMayShare: "members", extra: 1 }, "sharing.extra"],
    ];
    for (const [sharing, field] of bad) {
      const answer = await call(h, "POST", "/v1/markets", { body: validMarket(h, { sharing }) });
      expect(answer.status, JSON.stringify(sharing)).toBe(400);
      expect(answer.body?.["errors"]).toEqual([expect.objectContaining({ field })]);
      expectContract("/v1/markets", "POST", answer);
    }
  });
});

describe("making a share link", () => {
  it("answers 201 with the token once and the share URL path, and stores only the hash and one event", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const created = await call(h, "POST", linksUrl(marketId), { token: asTrader("trader-7"), body: { type: "members" } });
    expect(created.status).toBe(201);
    expectContract("/v1/markets/{id}/share-links", "POST", created);
    const body = created.body ?? {};
    expect(body["token"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body["urlPath"]).toBe(`/share#${String(body["token"])}`);
    expect(created.headers["location"]).toBe(`/v1/markets/${marketId}/share-links/${String(body["id"])}`);
    expect(created.headers["cache-control"]).toBe("private, no-store");
    expect(body).toMatchObject({ marketId, type: "members", emails: [], createdBy: "trader-7", expiresAt: null, revokedAt: null, status: "active" });

    const stored = h.core.store.snapshot().shareLinks.find((link) => link.id === body["id"]);
    expect(stored?.tokenHash).toBe(sha256(String(body["token"])));
    expect(JSON.stringify(h.core.store.snapshot())).not.toContain(String(body["token"]));

    const row = h.core.store.snapshot().outbox.find((message) => message.type === "si.chance.markets.ShareLinkCreated.v1" && message.payload.data !== undefined && (message.payload.data as { shareLinkId?: string }).shareLinkId === body["id"]);
    expect(row).toBeDefined();
    expect(eventErrors("ShareLinkCreatedEvent", row?.payload)).toEqual([]);
    expect(row?.subject).toBe(natsSubject("ShareLinkCreated", TENANT_A));
    expect(row?.payload.data).toMatchObject({ marketId, shareLinkId: body["id"], linkType: "members", actorId: "trader-7", expiresAt: null });
    expect(JSON.stringify(row)).not.toContain(String(body["token"]));
  });

  it("never writes the token into a log line, also when the request is refused", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const body = await makeLink(marketId, { type: "everyone" });
    await call(h, "POST", LOOKUP, { token: null, body: { token: body["token"] } });
    await call(h, "POST", ADMISSION, { token: asService(), body: { token: body["token"], userEmail: null, emailVerified: false } });
    expect(h.logLines.join("")).not.toContain(String(body["token"]));
  });

  it("keeps the e-mail addresses of a profiles link in lower case, once each, and out of the event", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const body = await makeLink(marketId, { type: "profiles", emails: [" Ana@Example.test ", "ana@example.test", "bor@example.test"] });
    expect(body["emails"]).toEqual(["ana@example.test", "bor@example.test"]);
    const event = h.core.store.snapshot().outbox.filter((message) => message.type.endsWith("ShareLinkCreated.v1")).at(-1);
    expect(JSON.stringify(event?.payload)).not.toContain("example.test");
  });

  it("refuses what the sharing policy does not allow: who, and which type", async () => {
    const none = await openMarket({ whoMayShare: "none", linkTypes: ["members", "profiles", "everyone"] });
    expect((await call(h, "POST", linksUrl(none), { token: asAdmin("owner-1"), body: { type: "members" } })).status).toBe(403);

    const admins = await openMarket({ whoMayShare: "admins", linkTypes: ["members"] });
    const trader = await call(h, "POST", linksUrl(admins), { token: asTrader(), body: { type: "members" } });
    expect(trader.status).toBe(403);
    expect(trader.body).toMatchObject({ code: "forbidden" });
    expectContract("/v1/markets/{id}/share-links", "POST", trader);
    expect((await call(h, "POST", linksUrl(admins), { token: asAdmin("owner-1"), body: { type: "members" } })).status).toBe(201);

    const typed = await openMarket({ whoMayShare: "members", linkTypes: ["members"] });
    const everyone = await call(h, "POST", linksUrl(typed), { token: asAdmin("owner-1"), body: { type: "everyone" } });
    expect(everyone.status).toBe(403);
    expect(everyone.body?.["detail"]).toContain("everyone");
    expect((await call(h, "POST", linksUrl(typed), { token: asTrader(), body: { type: "profiles", emails: ["a@example.test"] } })).status).toBe(403);
  });

  it("checks the body: the type, the addresses and the expiry", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const token = asAdmin("owner-1");
    const send = (body: unknown) => call(h, "POST", linksUrl(marketId), { token, body: body as object });
    const cases: Array<[unknown, string]> = [
      [{}, "type"],
      [{ type: "world" }, "type"],
      [{ type: "profiles" }, "emails"],
      [{ type: "profiles", emails: [] }, "emails"],
      [{ type: "profiles", emails: Array.from({ length: 51 }, (_, i) => `u${i}@example.test`) }, "emails"],
      [{ type: "profiles", emails: ["not an address"] }, "emails.0"],
      [{ type: "profiles", emails: ["a@b"] }, "emails.0"],
      [{ type: "members", emails: ["a@example.test"] }, "emails"],
      [{ type: "everyone", expiresAt: "tomorrow" }, "expiresAt"],
      [{ type: "everyone", expiresAt: "2026-10-01T00:00:00Z" }, "expiresAt"],
      [{ type: "everyone", surprise: true }, "surprise"],
    ];
    for (const [body, field] of cases) {
      const answer = await send(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body?.["errors"]?.[0]?.field, JSON.stringify(body)).toBe(field);
      expectContract("/v1/markets/{id}/share-links", "POST", answer);
    }
    expect((await send({ type: "profiles", emails: Array.from({ length: 50 }, (_, i) => `u${i}@example.test`) })).status).toBe(201);
  });

  it("answers 404 for another tenant's market and a trader's draft, 409 for a draft, 403 for a platform admin, 401 without a token", async () => {
    const draft = await draftMarket(h, asAdmin("owner-1"), { sharing: ALL_TYPES });
    const id = String(draft["id"]);
    const conflict = await call(h, "POST", linksUrl(id), { token: asAdmin("owner-1"), body: { type: "members" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "invalid_state" });
    expect((await call(h, "POST", linksUrl(id), { token: asTrader(), body: { type: "members" } })).status).toBe(404);
    expect((await call(h, "POST", linksUrl(id), { token: asAdmin("other", TENANT_B), body: { type: "members" } })).status).toBe(404);
    expect((await call(h, "POST", linksUrl(id), { token: asPlatformAdmin(), body: { type: "members" } })).status).toBe(403);
    expect((await call(h, "POST", linksUrl(id), { token: null, body: { type: "members" } })).status).toBe(401);
    expect((await call(h, "POST", linksUrl("not-a-uuid"), { token: asAdmin(), body: { type: "members" } })).status).toBe(400);
  });
});

describe("listing and revoking share links", () => {
  it("shows a tenant admin every link and a trader the own ones, page by page, without tokens", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const mine = await makeLink(marketId, { type: "members" }, asTrader("t-1"));
    await makeLink(marketId, { type: "everyone" }, asTrader("t-2"));
    await makeLink(marketId, { type: "members" }, asAdmin("owner-1"));

    const own = await call(h, "GET", linksUrl(marketId), { token: asTrader("t-1") });
    expect(own.status).toBe(200);
    expectContract("/v1/markets/{id}/share-links", "GET", own);
    expect(own.body?.["items"]).toEqual([expect.objectContaining({ id: mine["id"] })]);

    const first = await call(h, "GET", `${linksUrl(marketId)}?limit=2`, { token: asAdmin("owner-2") });
    expect(first.body?.["items"]).toHaveLength(2);
    expect(first.body?.["nextCursor"]).toEqual(expect.any(String));
    const second = await call(h, "GET", `${linksUrl(marketId)}?limit=2&cursor=${String(first.body?.["nextCursor"])}`, { token: asAdmin("owner-2") });
    expect(second.body?.["items"]).toHaveLength(1);
    expect(second.body?.["nextCursor"]).toBeNull();
    const ids = [...(first.body?.["items"] as Array<{ id: string }>), ...(second.body?.["items"] as Array<{ id: string }>)].map((item) => item.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(JSON.stringify([first.body, second.body])).not.toMatch(/token|urlPath/);
    expect((await call(h, "GET", `${linksUrl(marketId)}?cursor=junk`, { token: asAdmin() })).status).toBe(400);
  });

  it("lets the creator and any tenant admin revoke, hides other traders' links, and repeats safely with one event", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "everyone" }, asTrader("t-1"));
    const url = `${linksUrl(marketId)}/${String(link["id"])}`;
    expect((await call(h, "DELETE", url, { token: asTrader("t-2") })).status).toBe(404);
    const revoked = await call(h, "DELETE", url, { token: asTrader("t-1") });
    expect(revoked.status).toBe(204);
    expectContract("/v1/markets/{id}/share-links/{linkId}", "DELETE", revoked);
    expect((await call(h, "DELETE", url, { token: asAdmin("owner-2") })).status).toBe(204);
    const events = h.core.store
      .snapshot()
      .outbox.filter((message) => message.type.endsWith("ShareLinkRevoked.v1") && (message.payload.data as { shareLinkId?: string }).shareLinkId === link["id"]);
    expect(events).toHaveLength(1);
    expect(eventErrors("ShareLinkRevokedEvent", events[0]?.payload)).toEqual([]);
    expect(events[0]?.payload.data).toMatchObject({ shareLinkId: link["id"], actorId: "t-1" });

    const listed = await call(h, "GET", linksUrl(marketId), { token: asAdmin() });
    expect(listed.body?.["items"]).toEqual([expect.objectContaining({ id: link["id"], status: "revoked" })]);
    const lookup = await call(h, "POST", LOOKUP, { token: null, body: { token: link["token"] } });
    expect(lookup.status).toBe(404);

    const otherMarket = await openMarket(ALL_TYPES);
    expect((await call(h, "DELETE", `${linksUrl(otherMarket)}/${String(link["id"])}`, { token: asAdmin() })).status).toBe(404);
    expect((await call(h, "DELETE", `${linksUrl(marketId)}/${String(link["id"])}`, { token: asAdmin("x", TENANT_B) })).status).toBe(404);
  });
});

describe("the public lookup", () => {
  it("shows an everyone link to an anonymous caller, with the organization's display name", async () => {
    await h.core.useCases.provisionTenant.execute({
      eventId: "00000000-0000-7000-8000-00000000f001",
      eventType: "si.chance.tenants.TenantCreated.v1",
      tenantId: TENANT_A,
      correlationId: null,
      name: "Acme Bets",
    });
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "everyone" });
    const answer = await call(h, "POST", LOOKUP, { token: null, body: { token: link["token"] } });
    expect(answer.status).toBe(200);
    expectContract(LOOKUP, "POST", answer);
    expect(answer.body).toEqual({
      linkType: "everyone",
      market: { id: marketId, question: "Will the new bridge open before 2027?", status: "open", closeTime: expect.any(String) },
      organization: { alias: TENANT_A, name: "Acme Bets" },
      next: ["sign_in"],
    });
    expect(answer.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers one and the same 404 for an unknown, a revoked and an expired token", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const revoked = await makeLink(marketId, { type: "everyone" });
    await call(h, "DELETE", `${linksUrl(marketId)}/${String(revoked["id"])}`, { token: asAdmin() });
    const expiring = await makeLink(marketId, { type: "everyone", expiresAt: new Date(h.core.clock.now().getTime() + 3_600_000).toISOString() });
    expect((await call(h, "POST", LOOKUP, { token: null, body: { token: expiring["token"] } })).status).toBe(200);
    h.core.clock.advanceMs(2 * 3_600_000);
    const answers = [
      await call(h, "POST", LOOKUP, { token: null, body: { token: SequentialTokens.tokenNumber(9999) } }),
      await call(h, "POST", LOOKUP, { token: null, body: { token: revoked["token"] } }),
      await call(h, "POST", LOOKUP, { token: null, body: { token: expiring["token"] } }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expectContract(LOOKUP, "POST", answer);
      expect({ ...answer.body, instance: undefined }).toEqual({ ...answers[0]?.body, instance: undefined });
    }
  });

  it("shows a members link to a member of that organization only", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "members" });
    const body = { token: link["token"] };

    const anonymous = await call(h, "POST", LOOKUP, { token: null, body });
    expect(anonymous.status).toBe(403);
    expect(anonymous.body).toMatchObject({ code: "share_link_not_permitted", next: ["sign_in"] });
    // An anonymous caller is told no organization name: it drives the switch of a signed-in caller only.
    expect(anonymous.body?.["organization"]).toEqual({ name: null });
    expectContract(LOOKUP, "POST", anonymous);
    // The refusal says nothing of the market or the link.
    expect(JSON.stringify(anonymous.body)).not.toContain(marketId);
    expect(JSON.stringify(anonymous.body)).not.toContain("bridge");

    const member = await call(h, "POST", LOOKUP, { token: asTrader("t-5"), body });
    expect(member.status).toBe(200);
    expect(member.body).toMatchObject({ linkType: "members", next: ["trade"] });
    expect((await call(h, "POST", LOOKUP, { token: asAdmin("a-5"), body })).body).toMatchObject({ next: ["trade"] });

    const otherOrganization = await call(h, "POST", LOOKUP, { token: asTrader("t-6", TENANT_B), body });
    expect(otherOrganization.status).toBe(403);
    expect(otherOrganization.body).toMatchObject({ next: ["switch_organization"], organization: { name: "Acme Bets" } });
    // A token without an organization, a platform admin, and a realm role named trader are no members.
    for (const token of [{ sub: "u-1", roles: ["trader"] }, asPlatformAdmin(), { sub: "u-2", organization: [TENANT_A], realmAccessRoles: ["trader"] }]) {
      expect((await call(h, "POST", LOOKUP, { token, body })).status).toBe(403);
    }
  });

  it("shows a profiles link to a signed-in caller with a listed, verified e-mail address, whatever its case", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "profiles", emails: ["guest@example.test"] });
    const body = { token: link["token"] };
    const listed = await call(h, "POST", LOOKUP, { token: { sub: "g-1", email: "Guest@Example.test", emailVerified: true }, body });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ linkType: "profiles", next: ["join"] });
    // A caller who is a member of the organization by token trades; the list is what admits, not the membership.
    expect((await call(h, "POST", LOOKUP, { token: { ...asTrader("t-1"), email: "guest@example.test", emailVerified: true }, body })).body).toMatchObject({ next: ["trade"] });

    const refused: Array<TokenOptions | null> = [
      null,
      { sub: "g-2" },
      { sub: "g-2", email: "guest@example.test" },
      { sub: "g-2", email: "guest@example.test", emailVerified: false },
      { sub: "g-2", email: "guest@example.test", emailVerified: "true" },
      { sub: "g-2", email: "other@example.test", emailVerified: true },
      asTrader("t-1"),
    ];
    for (const token of refused) {
      const answer = await call(h, "POST", LOOKUP, { token, body });
      expect(answer.status, JSON.stringify(token)).toBe(403);
      expect(answer.body?.["next"]).toEqual(token === null ? ["sign_in"] : []);
    }
  });

  it("lets nobody trade on a closed market, and answers 401 for a wrong bearer token and 400 for a bad body", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "members" });
    await call(h, "POST", `/v1/markets/${marketId}/close`, { token: asAdmin("owner-1") });
    expect((await call(h, "POST", LOOKUP, { token: asTrader(), body: { token: link["token"] } })).body).toMatchObject({ market: { status: "closed" }, next: [] });
    expect((await call(h, "POST", LOOKUP, { token: null, headers: { authorization: "Bearer not.a.jwt" }, body: { token: link["token"] } })).status).toBe(401);
    for (const body of [{}, { token: "short" }, { token: `${String(link["token"])}x` }, { token: link["token"], extra: 1 }]) {
      const answer = await call(h, "POST", LOOKUP, { token: null, body });
      expect(answer.status).toBe(400);
      expectContract(LOOKUP, "POST", answer);
      expect(JSON.stringify(answer.body)).not.toContain(String(link["token"]));
    }
    // The token is a body value only: it is no path and no query.
    expect((await call(h, "GET", `${LOOKUP}?token=${String(link["token"])}`, { token: null })).status).toBe(404);
  });
});

describe("the admission endpoint for tenants", () => {
  const admit = (token: TokenOptions | null, body: Record<string, unknown>) => call(h, "POST", ADMISSION, { token, body });

  it("decides join, members_only and denied by the link type, and changes nothing", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const everyone = await makeLink(marketId, { type: "everyone" });
    const members = await makeLink(marketId, { type: "members" });
    const profiles = await makeLink(marketId, { type: "profiles", emails: ["guest@example.test"] });
    const before = JSON.stringify(h.core.store.snapshot());

    const cases: Array<[Record<string, any>, string | null, boolean, string]> = [
      [everyone, null, false, "join"],
      [members, "guest@example.test", true, "members_only"],
      [profiles, "GUEST@example.test", true, "join"],
      [profiles, "guest@example.test", false, "denied"],
      [profiles, null, true, "denied"],
      [profiles, "other@example.test", true, "denied"],
    ];
    for (const [link, userEmail, emailVerified, decision] of cases) {
      const answer = await admit(asService(), { token: link["token"], userEmail, emailVerified });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ decision, linkType: link["type"], tenantId: TENANT_A, marketId });
      expectContract(ADMISSION, "POST", answer);
    }
    expect(JSON.stringify(h.core.store.snapshot())).toBe(before);
  });

  it("answers the same 404 as the lookup for an unknown, revoked or expired token", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const revoked = await makeLink(marketId, { type: "everyone" });
    await call(h, "DELETE", `${linksUrl(marketId)}/${String(revoked["id"])}`, { token: asAdmin() });
    for (const token of [SequentialTokens.tokenNumber(4242), revoked["token"]]) {
      const answer = await admit(asService(), { token, userEmail: null, emailVerified: false });
      expect(answer.status).toBe(404);
      expectContract(ADMISSION, "POST", answer);
    }
  });

  it("admits the service tenants only: 401 without a token or with a wrong audience, 403 for a user's token or another client", async () => {
    const marketId = await openMarket(ALL_TYPES);
    const link = await makeLink(marketId, { type: "everyone" });
    const body = { token: link["token"], userEmail: null, emailVerified: false };
    expect((await admit(null, body)).status).toBe(401);
    expect((await admit({ ...asService(), audience: "chance-test" }, body)).status).toBe(401);
    // A user's token carries the users' audience: with a separate internal audience it fails the audience check (401).
    expect(INTERNAL_AUDIENCE).not.toBe("chance-test");
    expect((await admit(asAdmin(), body)).status).toBe(401);
    // With the audience right (the default setting uses one audience), the client claim still keeps every other caller out.
    const inAudience = { audience: INTERNAL_AUDIENCE };
    for (const token of [{ ...asAdmin(), ...inAudience }, { ...asTrader(), ...inAudience }, { ...asAdmin(), azp: "web", ...inAudience }, asService("payments"), { sub: "svc", ...inAudience }]) {
      const answer = await admit(token, body);
      expect(answer.status, JSON.stringify(token)).toBe(403);
      expectContract(ADMISSION, "POST", answer);
    }
    // The check of the caller comes before the validation of the body.
    expect((await admit({ ...asAdmin(), ...inAudience }, { nonsense: true })).status).toBe(403);
  });

  it("checks the body", async () => {
    const link = await makeLink(await openMarket(ALL_TYPES), { type: "everyone" });
    const good = { token: link["token"], userEmail: null, emailVerified: false };
    for (const body of [{}, { ...good, token: "short" }, { ...good, emailVerified: "yes" }, { ...good, extra: 1 }, { token: good.token, emailVerified: false }]) {
      const answer = await admit(asService(), body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expectContract(ADMISSION, "POST", answer);
    }
  });
});

describe("token contract v2 in markets", () => {
  beforeEach(() => h.core.clock.tick());

  it("takes the tenant role from the organization's group and ignores a realm role of that name", async () => {
    const own = { sub: "u", organization: [TENANT_A] };
    expect((await call(h, "GET", "/v1/markets", { token: { ...own, roles: ["trader"] } })).status).toBe(200);
    expect((await call(h, "GET", "/v1/markets", { token: { ...own, groups: ["/trader"] } })).status).toBe(200);
    expect((await call(h, "POST", "/v1/markets", { token: { ...own, roles: ["tenant-admin"] }, body: validMarket(h) })).status).toBe(201);
    for (const token of [
      { ...own, realmAccessRoles: ["trader"] },
      { ...own, realmAccessRoles: ["tenant-admin"] },
      { ...own, groups: ["/trader", "/tenant-admin"] },
      { ...own, groups: ["/viewer"] },
      { ...own, groups: ["trader"] },
    ]) {
      expect((await call(h, "GET", "/v1/markets", { token })).status, JSON.stringify(token)).toBe(403);
    }
  });
});
