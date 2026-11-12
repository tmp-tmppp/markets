import { describe, expect, it } from "vitest";
import { closeMarket } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { CloseMarket } from "../../src/usecases/close-market.js";
import { Forbidden, NotFound, TenantNotReady, ValidationFailed } from "../../src/usecases/errors.js";
import { ResolveMarket } from "../../src/usecases/resolve-market.js";
import { ADMIN, OTHER_ADMIN, TENANT_A, TENANT_B, createClosedMarket, createCore, createDraft, createOpenMarket, racing, tenantAdmin, trader } from "./core.js";
import type { Core } from "./core.js";

const CLOSED = "si.chance.markets.MarketClosed.v1";
const RESOLVED = "si.chance.markets.MarketResolved.v1";
const UNKNOWN_MARKET = "00000000-0000-7000-8000-0000000000ff";

const close = (core: Core, market: Market, by = tenantAdmin()) => core.useCases.closeMarket.execute({ actor: by, marketId: market.id });
const resolve = (core: Core, market: Market, outcome: string, by = tenantAdmin()) => core.useCases.resolveMarket.execute({ actor: by, marketId: market.id, outcome });
const eventsOf = (core: Core, type: string) => core.store.snapshot().outbox.filter((row) => row.type === type);

describe("CloseMarket", () => {
  it("closes an open market: version 4, closedAt and closedBy, and one MarketClosed event in the same commit", async () => {
    const core = await createCore();
    const market = await createOpenMarket(core);
    core.clock.advanceMs(5000);

    const closed = await close(core, market, tenantAdmin(OTHER_ADMIN));

    expect(closed).toMatchObject({ status: "closed", version: 4, closedAt: core.clock.now(), closedBy: OTHER_ADMIN, updatedAt: core.clock.now(), createdBy: ADMIN });
    expect(core.store.snapshot().markets[0]).toEqual(closed);
    const [row] = eventsOf(core, CLOSED);
    expect(eventsOf(core, CLOSED)).toHaveLength(1);
    expect(row).toMatchObject({ aggregateId: market.id, subject: `chance.markets.MarketClosed.${TENANT_A}`, publishedAt: null });
    expect(row?.id).toBe(row?.payload.id);
    expect(row?.payload).toMatchObject({
      specversion: "1.0",
      source: "/chance/markets",
      type: CLOSED,
      subject: `market/${market.id}`,
      tenantid: TENANT_A,
      correlationid: `corr-${OTHER_ADMIN}`,
      causationid: `req-${OTHER_ADMIN}`,
      time: core.clock.now().toISOString(),
      data: { marketId: market.id, version: 4, closedAt: core.clock.now().toISOString(), closedBy: OTHER_ADMIN },
    });
  });

  it("refuses a trader, even before it looks for the market", async () => {
    const core = await createCore();

    await expect(core.useCases.closeMarket.execute({ actor: trader(), marketId: UNKNOWN_MARKET })).rejects.toBeInstanceOf(Forbidden);
  });

  it("answers 404 for an unknown market and for a market of another tenant, 503 while the tenant has no schema", async () => {
    const core = await createCore();
    const market = await createOpenMarket(core);

    await expect(core.useCases.closeMarket.execute({ actor: tenantAdmin(), marketId: UNKNOWN_MARKET })).rejects.toBeInstanceOf(NotFound);
    await expect(close(core, market, tenantAdmin(ADMIN, TENANT_B))).rejects.toBeInstanceOf(NotFound);
    const empty = await createCore({ provision: false });
    await expect(empty.useCases.closeMarket.execute({ actor: tenantAdmin(), marketId: UNKNOWN_MARKET })).rejects.toBeInstanceOf(TenantNotReady);
  });

  it.each([
    ["draft", (core: Core) => createDraft(core)],
    ["closed", (core: Core) => createClosedMarket(core)],
  ])("answers 409 invalid_state for a %s market and writes no event", async (_status, make) => {
    const core = await createCore();
    const market = await make(core);
    const eventsBefore = core.store.snapshot().outbox.length;

    await expect(close(core, market)).rejects.toMatchObject({ kind: "conflict", code: "invalid_state" });
    expect(core.store.snapshot().outbox).toHaveLength(eventsBefore);
  });

  it("answers 409 for an opening market", async () => {
    const core = await createCore({ fundingMode: "unknown" });
    const draft = await createDraft(core);
    const { market } = await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id });

    await expect(close(core, market)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("lets one of two concurrent closes win: the loser gets 409 naming the new status and writes no event", async () => {
    const core = await createCore();
    const market = await createOpenMarket(core);
    let armed = true;
    const store = racing(core.store, async () => {
      if (!armed) return;
      armed = false;
      const tenant = await core.store.forTenant(TENANT_A);
      await tenant?.repositories.markets.update(closeMarket(market, "someone-else", core.clock.now()), { status: "open", version: market.version });
    });

    const attempt = new CloseMarket({ ...core.deps, store }).execute({ actor: tenantAdmin(), marketId: market.id });

    await expect(attempt).rejects.toMatchObject({ kind: "conflict", code: "invalid_state", message: expect.stringContaining("closed") });
    expect(eventsOf(core, CLOSED)).toHaveLength(0);
    expect(core.store.snapshot().markets[0]).toMatchObject({ status: "closed", closedBy: "someone-else" });
  });
});

describe("ResolveMarket", () => {
  it.each(["YES", "NO", "INVALID"] as const)("resolves a closed market as %s: version 5, resolver, one MarketResolved event with the creator", async (outcome) => {
    const core = await createCore();
    const market = await createClosedMarket(core, tenantAdmin(ADMIN));
    core.clock.advanceMs(7000);

    const resolved = await resolve(core, market, outcome, tenantAdmin(OTHER_ADMIN));

    expect(resolved).toMatchObject({ status: "resolved", outcome, version: 5, resolvedAt: core.clock.now(), resolvedBy: OTHER_ADMIN, closedBy: ADMIN });
    expect(core.store.snapshot().markets[0]).toEqual(resolved);
    const rows = eventsOf(core, RESOLVED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aggregateId: market.id, subject: `chance.markets.MarketResolved.${TENANT_A}` });
    expect(rows[0]?.payload).toMatchObject({
      type: RESOLVED,
      subject: `market/${market.id}`,
      tenantid: TENANT_A,
      correlationid: `corr-${OTHER_ADMIN}`,
      causationid: `req-${OTHER_ADMIN}`,
      data: { marketId: market.id, outcome, version: 5, resolvedAt: core.clock.now().toISOString(), resolvedBy: OTHER_ADMIN, creatorId: ADMIN },
    });
  });

  it("increments the version once per transition and every event carries the version of its market", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    expect(draft.version).toBe(1);
    const { market: open } = await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id });
    const closed = await close(core, open);
    const resolved = await resolve(core, closed, "YES");

    expect([open.version, closed.version, resolved.version]).toEqual([3, 4, 5]);
    const versions = core.store.snapshot().outbox.map((row) => (row.payload.data as { version: number }).version);
    expect(versions).toEqual([3, 4, 5]);
    expect(core.store.snapshot().outbox.map((row) => row.type)).toEqual(["si.chance.markets.MarketOpened.v1", CLOSED, RESOLVED]);
  });

  it.each(["MAYBE", "yes", "", "1"])("rejects the outcome %j as a validation error on the field outcome, even for a market that is not closed", async (outcome) => {
    const core = await createCore();
    const open = await createOpenMarket(core);

    const attempt = resolve(core, open, outcome);

    await expect(attempt).rejects.toBeInstanceOf(ValidationFailed);
    await expect(attempt).rejects.toMatchObject({ fields: [expect.objectContaining({ field: "outcome" })] });
  });

  it.each([
    ["open", (core: Core) => createOpenMarket(core)],
    ["draft", (core: Core) => createDraft(core)],
  ])("answers 409 invalid_state for a %s market with a valid outcome", async (_status, make) => {
    const core = await createCore();
    const market = await make(core);

    await expect(resolve(core, market, "YES")).rejects.toMatchObject({ kind: "conflict", code: "invalid_state" });
    expect(eventsOf(core, RESOLVED)).toEqual([]);
  });

  it("cannot resolve an INVALID market again, and cannot turn a YES market INVALID: 409, one event each", async () => {
    const core = await createCore();
    const first = await createClosedMarket(core);
    await resolve(core, first, "INVALID");
    await expect(resolve(core, first, "YES")).rejects.toMatchObject({ code: "invalid_state" });
    await expect(resolve(core, first, "INVALID")).rejects.toMatchObject({ code: "invalid_state" });

    const second = await createClosedMarket(core);
    await resolve(core, second, "YES");
    await expect(resolve(core, second, "INVALID")).rejects.toMatchObject({ code: "invalid_state" });

    const byId = new Map(core.store.snapshot().markets.map((market) => [market.id, market]));
    expect(byId.get(first.id)).toMatchObject({ status: "resolved", outcome: "INVALID", version: 5 });
    expect(byId.get(second.id)).toMatchObject({ status: "resolved", outcome: "YES", version: 5 });
    expect(eventsOf(core, RESOLVED).map((row) => (row.payload.data as { outcome: string }).outcome).sort()).toEqual(["INVALID", "YES"]);
  });

  it("refuses INVALID like any outcome on a market that is not closed: 409 invalid_state, no event", async () => {
    const core = await createCore();
    const open = await createOpenMarket(core);
    await expect(resolve(core, open, "INVALID")).rejects.toMatchObject({ kind: "conflict", code: "invalid_state" });
    expect(eventsOf(core, RESOLVED)).toEqual([]);
  });

  it("cannot resolve twice: the second call is 409 and the outcome stays", async () => {
    const core = await createCore();
    const closed = await createClosedMarket(core);
    await resolve(core, closed, "YES");

    await expect(resolve(core, closed, "NO")).rejects.toMatchObject({ code: "invalid_state" });
    expect(core.store.snapshot().markets[0]).toMatchObject({ outcome: "YES", version: 5 });
    expect(eventsOf(core, RESOLVED)).toHaveLength(1);
  });

  it("refuses a trader, answers 404 for another tenant's market and 503 while the tenant has no schema", async () => {
    const core = await createCore();
    const closed = await createClosedMarket(core);

    await expect(resolve(core, closed, "YES", trader())).rejects.toBeInstanceOf(Forbidden);
    await expect(resolve(core, closed, "YES", tenantAdmin(ADMIN, TENANT_B))).rejects.toBeInstanceOf(NotFound);
    await expect(core.useCases.resolveMarket.execute({ actor: tenantAdmin(), marketId: UNKNOWN_MARKET, outcome: "YES" })).rejects.toBeInstanceOf(NotFound);
    const empty = await createCore({ provision: false });
    await expect(empty.useCases.resolveMarket.execute({ actor: tenantAdmin(), marketId: UNKNOWN_MARKET, outcome: "YES" })).rejects.toBeInstanceOf(TenantNotReady);
  });

  it("lets one of two concurrent resolves win: the loser gets 409 naming the new status, with no second event", async () => {
    const core = await createCore();
    const market = await createClosedMarket(core);
    let armed = true;
    const store = racing(core.store, async () => {
      if (!armed) return;
      armed = false;
      await resolve(core, market, "NO", tenantAdmin("someone-else"));
    });

    const attempt = new ResolveMarket({ ...core.deps, store }).execute({ actor: tenantAdmin(), marketId: market.id, outcome: "YES" });

    await expect(attempt).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("resolved") });
    expect(eventsOf(core, RESOLVED)).toHaveLength(1);
    expect(core.store.snapshot().markets[0]).toMatchObject({ outcome: "NO", resolvedBy: "someone-else" });
  });
});
