import { describe, expect, it } from "vitest";
import { AUTO_CLOSE_ACTOR } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { CloseDueMarkets } from "../../src/usecases/close-due-markets.js";
import type { Store } from "../../src/usecases/ports.js";
import { eventErrors } from "../support/contracts.js";
import { closeTimeIn } from "../support/fakes.js";
import { ADMIN, TENANT_A, TENANT_B, createCore, createDraft, failingOutboxFor, tenantAdmin } from "./core.js";
import type { Core, createInput } from "./core.js";

const HOUR = 3_600_000;
const CLOSED = "si.chance.markets.MarketClosed.v1";
const OPENED = "si.chance.markets.MarketOpened.v1";

const run = (core: Core, tenantId = TENANT_A, limit = 50) => core.useCases.closeDueMarkets.execute({ tenantId, limit });
const eventsOf = (core: Core, type: string) => core.store.snapshot().outbox.filter((row) => row.type === type);
const stored = (core: Core, id: string): Market => {
  const market = core.store.snapshot().markets.find((candidate) => candidate.id === id);
  if (!market) throw new Error(`no market ${id}`);
  return market;
};

/** A funded, open market that closes `hours` after the clock's time. */
async function openClosingIn(core: Core, hours: number, by = tenantAdmin(), overrides: Parameters<typeof createInput>[1] = {}): Promise<Market> {
  const draft = await createDraft(core, by, { closeTime: closeTimeIn(core.clock, hours), ...overrides });
  const { market } = await core.useCases.openMarket.execute({ actor: by, marketId: draft.id });
  return market;
}

describe("CloseDueMarkets", () => {
  it("closes an open market whose close time has passed: version + 1, the system actor, and the MarketClosed event in the same commit", async () => {
    const core = await createCore();
    const market = await openClosingIn(core, 2);
    expect(market.version).toBe(3);
    core.clock.advanceMs(3 * HOUR);

    const result = await run(core);

    expect(result).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, market.id)).toMatchObject({
      status: "closed",
      version: 4,
      closedAt: core.clock.now(),
      closedBy: AUTO_CLOSE_ACTOR,
      updatedAt: core.clock.now(),
      closeTime: market.closeTime,
      createdBy: ADMIN,
    });
    const rows = eventsOf(core, CLOSED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aggregateId: market.id, subject: `chance.markets.MarketClosed.${TENANT_A}`, publishedAt: null });
    expect(rows[0]?.id).toBe(rows[0]?.payload.id);
    expect(rows[0]?.payload).toMatchObject({
      specversion: "1.0",
      source: "/chance/markets",
      type: CLOSED,
      subject: `market/${market.id}`,
      tenantid: TENANT_A,
      time: core.clock.now().toISOString(),
      data: { marketId: market.id, version: 4, closedAt: core.clock.now().toISOString(), closedBy: "system:auto-close" },
    });
    // No request caused the close: the run is its own correlation and its own cause, and both are present.
    expect(rows[0]?.payload.correlationid).toMatch(/^\S+$/);
    expect(rows[0]?.payload.causationid).toBe(rows[0]?.payload.correlationid);
    expect(core.logger.messages("info")).toContain("Market closed automatically at its close time");
  });

  it("closes at the close time itself, not a millisecond before", async () => {
    const core = await createCore();
    const market = await openClosingIn(core, 2);
    core.clock.advanceMs(market.closeTime.getTime() - core.clock.now().getTime() - 1);

    expect(await run(core)).toEqual({ closed: 0, failed: 0, more: false });
    expect(stored(core, market.id).status).toBe("open");
    expect(eventsOf(core, CLOSED)).toHaveLength(0);

    core.clock.advanceMs(1);
    expect(await run(core)).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, market.id)).toMatchObject({ status: "closed", closedBy: AUTO_CLOSE_ACTOR });
  });

  it("never touches a market that is not open: draft, closed and resolved stay as they are, and so does an opening one", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    const adminClosed = await openClosingIn(core, 2, tenantAdmin("admin-9"));
    await core.useCases.closeMarket.execute({ actor: tenantAdmin("admin-9"), marketId: adminClosed.id });
    const resolved = await openClosingIn(core, 2);
    await core.useCases.closeMarket.execute({ actor: tenantAdmin(), marketId: resolved.id });
    await core.useCases.resolveMarket.execute({ actor: tenantAdmin(), marketId: resolved.id, outcome: "YES" });
    const open = await openClosingIn(core, 2);
    const unknown = await createCore({ fundingMode: "unknown" });
    const opening = (await openClosingIn(unknown, 2)).id;
    expect(stored(unknown, opening).status).toBe("opening");
    core.clock.advanceMs(48 * HOUR);
    unknown.clock.advanceMs(48 * HOUR);
    const before = core.store.snapshot();
    const openingBefore = unknown.store.snapshot();

    expect(await run(core)).toEqual({ closed: 1, failed: 0, more: false });
    expect(await run(unknown)).toEqual({ closed: 0, failed: 0, more: false });

    const after = core.store.snapshot();
    expect(stored(core, open.id)).toMatchObject({ status: "closed", version: 4, closedBy: AUTO_CLOSE_ACTOR });
    for (const untouched of [draft, adminClosed, resolved]) {
      expect(after.markets.find((market) => market.id === untouched.id)).toEqual(before.markets.find((market) => market.id === untouched.id));
    }
    expect(stored(core, adminClosed.id).closedBy).toBe("admin-9");
    expect(after.outbox.filter((row) => row.type === CLOSED).map((row) => row.aggregateId).sort()).toEqual([adminClosed.id, resolved.id, open.id].sort());
    expect(unknown.store.snapshot()).toEqual(openingBefore);
  });

  it("does not close a market again that an admin closed first, and writes no second event", async () => {
    const core = await createCore();
    const market = await openClosingIn(core, 2);
    core.clock.advanceMs(3 * HOUR);
    await core.useCases.closeMarket.execute({ actor: tenantAdmin("admin-9"), marketId: market.id });

    expect(await run(core)).toEqual({ closed: 0, failed: 0, more: false });

    expect(stored(core, market.id)).toMatchObject({ status: "closed", version: 4, closedBy: "admin-9" });
    expect(eventsOf(core, CLOSED)).toHaveLength(1);
  });

  it("closes each market once: a second run finds nothing and writes no event", async () => {
    const core = await createCore();
    await openClosingIn(core, 2);
    await openClosingIn(core, 3);
    core.clock.advanceMs(4 * HOUR);

    expect(await run(core)).toEqual({ closed: 2, failed: 0, more: false });
    const afterFirst = core.store.snapshot();
    expect(await run(core)).toEqual({ closed: 0, failed: 0, more: false });

    expect(core.store.snapshot()).toEqual(afterFirst);
    expect(eventsOf(core, CLOSED)).toHaveLength(2);
  });

  it("works on one tenant at a time: another tenant's due market stays open until its own run", async () => {
    const core = await createCore();
    const mine = await openClosingIn(core, 2);
    const theirs = await openClosingIn(core, 2, tenantAdmin("admin-b", TENANT_B));
    core.clock.advanceMs(3 * HOUR);

    expect(await run(core, TENANT_A)).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, mine.id).status).toBe("closed");
    expect(stored(core, theirs.id).status).toBe("open");

    expect(await run(core, TENANT_B)).toEqual({ closed: 1, failed: 0, more: false });
    expect(eventsOf(core, CLOSED).map((row) => row.payload.tenantid).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it("answers nothing for a tenant that is not registered", async () => {
    const core = await createCore({ provision: false });

    expect(await run(core)).toEqual({ closed: 0, failed: 0, more: false });
  });

  it("closes the earliest close times first, at most `limit` per call, and says when more may be due", async () => {
    const core = await createCore();
    const late = await openClosingIn(core, 4);
    const early = await openClosingIn(core, 2);
    const middle = await openClosingIn(core, 3);
    core.clock.advanceMs(5 * HOUR);

    expect(await run(core, TENANT_A, 2)).toEqual({ closed: 2, failed: 0, more: true });
    expect(stored(core, early.id).status).toBe("closed");
    expect(stored(core, middle.id).status).toBe("closed");
    expect(stored(core, late.id).status).toBe("open");

    expect(await run(core, TENANT_A, 2)).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, late.id)).toMatchObject({ status: "closed", version: 4 });
  });

  it("isolates a market that fails: the others are closed, it stays open, is left out of the run and closes at the next one", async () => {
    const core = await createCore();
    const first = await openClosingIn(core, 2);
    const second = await openClosingIn(core, 3);
    const third = await openClosingIn(core, 4);
    core.clock.advanceMs(5 * HOUR);

    const result = await new CloseDueMarkets({ ...core.deps, store: failingOutboxFor(core.store, first.id) }).execute({ tenantId: TENANT_A, limit: 50 });

    expect(result).toEqual({ closed: 2, failed: 1, more: false });
    expect(stored(core, first.id)).toMatchObject({ status: "open", version: 3, closedBy: null });
    expect(stored(core, second.id)).toMatchObject({ status: "closed", version: 4 });
    expect(stored(core, third.id)).toMatchObject({ status: "closed", version: 4 });
    expect(eventsOf(core, CLOSED).map((row) => row.aggregateId).sort()).toEqual([second.id, third.id].sort());
    expect(core.logger.lines.find((line) => line.level === "error")).toMatchObject({ fields: { tenantId: TENANT_A, marketId: first.id } });

    expect(await run(core)).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, first.id)).toMatchObject({ status: "closed", version: 4, closedBy: AUTO_CLOSE_ACTOR });
  });

  it("asks for another call at once only after a full batch was closed: a run with a failure waits for the next interval, so a failing tenant is not retried in a loop", async () => {
    const core = await createCore();
    const first = await openClosingIn(core, 2);
    const second = await openClosingIn(core, 3);
    const third = await openClosingIn(core, 4);
    core.clock.advanceMs(5 * HOUR);

    // Every close of the batch fails: nothing was won, so retrying at once would only repeat the failures.
    const allFail = new CloseDueMarkets({ ...core.deps, store: failingOutboxFor(core.store, first.id, second.id, third.id) });
    expect(await allFail.execute({ tenantId: TENANT_A, limit: 2 })).toEqual({ closed: 0, failed: 2, more: false });
    // One failed and one closed fill the batch, but the failure must still wait: the market is retried once per interval.
    const oneFails = new CloseDueMarkets({ ...core.deps, store: failingOutboxFor(core.store, first.id) });
    expect(await oneFails.execute({ tenantId: TENANT_A, limit: 2 })).toEqual({ closed: 1, failed: 1, more: false });
    expect(stored(core, second.id).status).toBe("closed");
    expect(stored(core, third.id).status).toBe("open");

    // Without a failure the full batch is closed (the market that failed is the earliest one, so it goes first) and more may be due.
    expect(await run(core, TENANT_A, 1)).toEqual({ closed: 1, failed: 0, more: true });
    expect(stored(core, first.id).status).toBe("closed");
    expect(stored(core, third.id).status).toBe("open");
  });

  it("stops before the next market when asked to: the market in progress is finished, the rest stay open for the next run", async () => {
    const core = await createCore();
    const first = await openClosingIn(core, 2);
    const second = await openClosingIn(core, 3);
    const third = await openClosingIn(core, 4);
    core.clock.advanceMs(5 * HOUR);
    // The check is made before each market: it is false for the first one and true from then on.
    let checks = 0;

    const result = await core.useCases.closeDueMarkets.execute({ tenantId: TENANT_A, limit: 50, shouldStop: () => ++checks > 1 });

    expect(result).toEqual({ closed: 1, failed: 0, more: false });
    expect(stored(core, first.id).status).toBe("closed");
    expect(stored(core, second.id).status).toBe("open");
    expect(stored(core, third.id).status).toBe("open");
    expect(eventsOf(core, CLOSED)).toHaveLength(1);

    // The next run, without the stop, closes the rest.
    expect(await run(core)).toEqual({ closed: 2, failed: 0, more: false });
  });

  it("claims nothing when it is asked to stop before the first market", async () => {
    const core = await createCore();
    const market = await openClosingIn(core, 2);
    core.clock.advanceMs(3 * HOUR);

    expect(await core.useCases.closeDueMarkets.execute({ tenantId: TENANT_A, limit: 50, shouldStop: () => true })).toEqual({ closed: 0, failed: 0, more: false });
    expect(stored(core, market.id)).toMatchObject({ status: "open", version: 3 });
  });

  it("throws when the tenant's markets cannot be read at all, so that the worker can isolate the tenant", async () => {
    const core = await createCore();
    await openClosingIn(core, 2);
    core.clock.advanceMs(3 * HOUR);
    const unreadable: Store = {
      repositories: core.store.repositories,
      transaction: (work) => core.store.transaction(work),
      ping: () => core.store.ping(),
      async forTenant(tenantId) {
        const tenant = await core.store.forTenant(tenantId);
        if (!tenant) return null;
        const repositories = { ...tenant.repositories, markets: { ...tenant.repositories.markets, hasDue: () => Promise.reject(new Error('schema "tenant_x" does not exist')) } };
        return { tenantId: tenant.tenantId, repositories, transaction: (work) => tenant.transaction(work) };
      },
    };

    await expect(new CloseDueMarkets({ ...core.deps, store: unreadable }).execute({ tenantId: TENANT_A, limit: 5 })).rejects.toThrow("does not exist");
  });
});

describe("the automatic close and the admin's close are one step", () => {
  it("write events of the same shape, one version apart from the opening, and the event matches the contract", async () => {
    const core = await createCore();
    const byAdmin = await openClosingIn(core, 2);
    const byTimer = await openClosingIn(core, 2);
    await core.useCases.closeMarket.execute({ actor: tenantAdmin("admin-9"), marketId: byAdmin.id });
    core.clock.advanceMs(3 * HOUR);
    await run(core);

    const closedEvents = eventsOf(core, CLOSED);
    expect(closedEvents).toHaveLength(2);
    const [adminEvent, timerEvent] = closedEvents.map((row) => row.payload);
    expect(Object.keys(timerEvent ?? {}).sort()).toEqual(Object.keys(adminEvent ?? {}).sort());
    expect(Object.keys(timerEvent?.data ?? {}).sort()).toEqual(Object.keys(adminEvent?.data ?? {}).sort());
    expect(timerEvent?.type).toBe(adminEvent?.type);
    for (const row of closedEvents) expect(eventErrors("MarketClosedEvent", row.payload)).toEqual([]);
    expect(adminEvent?.data).toMatchObject({ closedBy: "admin-9" });
    expect(timerEvent?.data).toMatchObject({ closedBy: "system:auto-close" });
    expect(byTimer.version).toBe(3);
  });

  it("keep the version guard of the consumers working: a consumer copy applies the events only where version < new, in any order and repeated", async () => {
    const core = await createCore();
    const market = await openClosingIn(core, 2);
    core.clock.advanceMs(3 * HOUR);
    await run(core);
    const events = core.store.snapshot().outbox.filter((row) => row.aggregateId === market.id);
    const opened = events.find((row) => row.type === OPENED)?.payload.data as { version: number };
    const closed = events.find((row) => row.type === CLOSED)?.payload.data as { version: number };

    // The rule of contracts/README.md: update a copy only WHERE version < the event's version.
    const apply = (copy: { version: number; status: string }, type: string, version: number) => {
      if (copy.version < version) Object.assign(copy, { version, status: type === CLOSED ? "closed" : "open" });
    };
    const inOrder = { version: 0, status: "" };
    apply(inOrder, OPENED, opened.version);
    apply(inOrder, CLOSED, closed.version);
    apply(inOrder, CLOSED, closed.version);
    const reversed = { version: 0, status: "" };
    apply(reversed, CLOSED, closed.version);
    apply(reversed, OPENED, opened.version);

    expect(closed.version).toBe(opened.version + 1);
    expect(closed.version).toBe(stored(core, market.id).version);
    expect(inOrder).toEqual({ version: closed.version, status: "closed" });
    expect(reversed).toEqual(inOrder);
  });
});
