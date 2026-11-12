import { describe, expect, it } from "vitest";
import { AutoCloseWorker } from "../../src/adapters/auto-close/worker.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import type { AutoCloseSettings } from "../../src/config.js";
import { AUTO_CLOSE_ACTOR } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { CloseDueMarkets } from "../../src/usecases/close-due-markets.js";
import type { Actor, Store } from "../../src/usecases/ports.js";
import type { CloseDueMarketsInput, CloseDueMarketsResult, CloseDueMarketsUseCase } from "../../src/usecases/use-cases.js";
import { RecordingLogger, TENANT_A, TENANT_B, TestClock, closeTimeIn } from "../support/fakes.js";
import type { Core } from "../usecases/core.js";
import { createCore, createDraft, failingOutboxFor, racing, tenantAdmin } from "../usecases/core.js";

const TENANT_C = "018f3c1e-7a00-7000-8000-0000000000cc";

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A scripted use case: the test decides what each tenant's call does; the inputs it is called with are recorded. */
class ScriptedClose implements CloseDueMarketsUseCase {
  readonly calls: CloseDueMarketsInput[] = [];
  behaviour: (input: CloseDueMarketsInput) => Promise<CloseDueMarketsResult> | CloseDueMarketsResult = () => ({ closed: 0, failed: 0, more: false });
  async execute(input: CloseDueMarketsInput): Promise<CloseDueMarketsResult> {
    this.calls.push(input);
    return this.behaviour(input);
  }
}

async function setup(settings: AutoCloseSettings = { enabled: true, intervalMs: 5 }, options: { batchSize?: number; maxSliceMs?: number } = {}) {
  const store = new MemoryStore();
  const clock = new TestClock();
  const logger = new RecordingLogger();
  // Registered out of order on purpose: the worker visits them ordered by id.
  for (const tenant of [TENANT_B, TENANT_C, TENANT_A]) await store.repositories.tenants.provision(tenant, clock.now());
  const close = new ScriptedClose();
  const state = { ...settings };
  const worker = new AutoCloseWorker({ store, close, logger, settings: () => state, ...options });
  return { store, logger, close, state, worker };
}

describe("AutoCloseWorker.runOnce", () => {
  it("visits every registered tenant in id order with the batch size and adds up the results", async () => {
    const { close, worker } = await setup(undefined, { batchSize: 7 });
    close.behaviour = ({ tenantId }) => ({ closed: tenantId === TENANT_A ? 2 : 1, failed: tenantId === TENANT_B ? 1 : 0, more: false });

    const result = await worker.runOnce();

    expect(close.calls.map(({ tenantId, limit }) => ({ tenantId, limit }))).toEqual([
      { tenantId: TENANT_A, limit: 7 },
      { tenantId: TENANT_B, limit: 7 },
      { tenantId: TENANT_C, limit: 7 },
    ]);
    expect(result).toEqual({ skipped: false, tenants: 3, closed: 4, failedMarkets: 1, failedTenants: 0, more: false });
  });

  it("uses a batch of 50 markets per tenant by default", async () => {
    const { close, worker } = await setup();

    await worker.runOnce();

    expect(close.calls.every((call) => call.limit === 50)).toBe(true);
  });

  it("reports that more may be due when a tenant reached its limit", async () => {
    const { close, worker } = await setup();
    close.behaviour = ({ tenantId }) => ({ closed: 50, failed: 0, more: tenantId === TENANT_B });

    expect((await worker.runOnce()).more).toBe(true);
  });

  it("closes nothing while the kill switch is off, says so once, and goes on when it is true again", async () => {
    const { close, logger, state, worker } = await setup({ enabled: false, intervalMs: 5 });

    expect(await worker.runOnce()).toEqual({ skipped: true, tenants: 0, closed: 0, failedMarkets: 0, failedTenants: 0, more: false });
    await worker.runOnce();
    expect(close.calls).toHaveLength(0);
    expect(logger.messages("warn")).toEqual(["AUTO_CLOSE_ENABLED is false: markets are not closed automatically until it is true"]);

    state.enabled = true;
    expect((await worker.runOnce()).tenants).toBe(3);
    expect(close.calls).toHaveLength(3);
    expect(logger.messages("info")).toEqual(["AUTO_CLOSE_ENABLED is true again: closing markets automatically"]);
  });

  it("stops before the next tenant when the kill switch is switched off in the middle of a run", async () => {
    const { close, state, worker } = await setup();
    close.behaviour = () => {
      state.enabled = false;
      return { closed: 1, failed: 0, more: false };
    };

    const result = await worker.runOnce();

    expect(close.calls.map((call) => call.tenantId)).toEqual([TENANT_A]);
    expect(result).toMatchObject({ skipped: false, tenants: 1, closed: 1 });
  });

  it("isolates a tenant that fails: the others are still visited and the failure is logged with the tenant", async () => {
    const { close, logger, worker } = await setup();
    close.behaviour = ({ tenantId }) => {
      if (tenantId === TENANT_B) throw new Error('relation "tenant_b.markets" does not exist');
      return { closed: 1, failed: 0, more: false };
    };

    const result = await worker.runOnce();

    expect(close.calls.map((call) => call.tenantId)).toEqual([TENANT_A, TENANT_B, TENANT_C]);
    expect(result).toEqual({ skipped: false, tenants: 3, closed: 2, failedMarkets: 0, failedTenants: 1, more: false });
    expect(logger.lines.filter((line) => line.level === "error")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ tenantId: TENANT_B }), message: "Closing the due markets of a tenant failed; the other tenants go on" }),
    ]);
  });

  it("rejects when the registry of tenants cannot be read, so that the loop can back off", async () => {
    const { store, close } = await setup();
    const broken: Store = {
      ...store,
      repositories: { ...store.repositories, tenants: { ...store.repositories.tenants, listTenantIds: () => Promise.reject(new Error("database down")) } },
      transaction: (work) => store.transaction(work),
      forTenant: (tenantId) => store.forTenant(tenantId),
      ping: () => store.ping(),
    };
    const worker = new AutoCloseWorker({ store: broken, close, logger: new RecordingLogger(), settings: () => ({ enabled: true, intervalMs: 5 }) });

    await expect(worker.runOnce()).rejects.toThrow("database down");
  });
});

describe("AutoCloseWorker loop", () => {
  it("runs again and again after start, and stop waits for the run in progress", async () => {
    const { close, worker } = await setup();

    worker.start();
    worker.start();
    await waitFor(() => close.calls.length >= 9);
    await worker.stop();
    const callsAtStop = close.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(close.calls.length).toBe(callsAtStop);
  });

  it("stop wakes a long sleep at once", async () => {
    const { close, worker } = await setup({ enabled: true, intervalMs: 3_600_000 });

    worker.start();
    await waitFor(() => close.calls.length >= 3);
    const started = Date.now();
    await worker.stop();

    expect(Date.now() - started).toBeLessThan(500);
  });

  it("goes on at once, without waiting the interval, while a tenant reaches its limit", async () => {
    const { close, worker } = await setup({ enabled: true, intervalMs: 3_600_000 });
    let rounds = 0;
    close.behaviour = ({ tenantId }) => {
      if (tenantId === TENANT_A) rounds += 1;
      return { closed: 50, failed: 0, more: rounds < 4 };
    };

    worker.start();
    await waitFor(() => rounds >= 4);
    await worker.stop();

    expect(rounds).toBe(4);
  });

  it("applies a changed interval within one sleep slice, not after the old interval", async () => {
    const { close, state, worker } = await setup({ enabled: true, intervalMs: 3_600_000 }, { maxSliceMs: 10 });

    worker.start();
    await waitFor(() => close.calls.length >= 3);
    state.intervalMs = 20;
    await waitFor(() => close.calls.length >= 6);
    await worker.stop();

    expect(close.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps running while the kill switch is off and closes again once it is on", async () => {
    const { close, state, worker } = await setup({ enabled: false, intervalMs: 5 });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(close.calls).toHaveLength(0);
    state.enabled = true;
    await waitFor(() => close.calls.length >= 3);
    await worker.stop();

    expect(close.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("logs a registry failure, backs off and recovers", async () => {
    const { store, close, logger } = await setup();
    let failing = true;
    const flaky: Store = {
      ...store,
      repositories: {
        ...store.repositories,
        tenants: { ...store.repositories.tenants, listTenantIds: () => (failing ? Promise.reject(new Error("database down")) : store.repositories.tenants.listTenantIds()) },
      },
      transaction: (work) => store.transaction(work),
      forTenant: (tenantId) => store.forTenant(tenantId),
      ping: () => store.ping(),
    };
    const worker = new AutoCloseWorker({ store: flaky, close, logger, settings: () => ({ enabled: true, intervalMs: 5 }) });

    worker.start();
    await waitFor(() => logger.messages("error").length >= 1);
    expect(close.calls).toHaveLength(0);
    failing = false;
    await waitFor(() => close.calls.length >= 3);
    await worker.stop();

    expect(logger.messages("error")[0]).toBe("The automatic close could not read the registry of tenants");
  });
});

describe("AutoCloseWorker with the real use case", () => {
  it("closes the due markets of every tenant, once, as the system actor, and leaves the others open", async () => {
    const core = await createCore();
    const openClosingIn = async (hours: number, by: Actor) => {
      const draft = await createDraft(core, by, { closeTime: closeTimeIn(core.clock, hours) });
      return (await core.useCases.openMarket.execute({ actor: by, marketId: draft.id })).market;
    };
    const dueA = await openClosingIn(2, tenantAdmin());
    const dueB = await openClosingIn(2, tenantAdmin("admin-b", TENANT_B));
    const later = await openClosingIn(30, tenantAdmin());
    core.clock.advanceMs(3 * 3_600_000);
    const worker = new AutoCloseWorker({ store: core.store, close: core.useCases.closeDueMarkets, logger: core.logger, settings: () => ({ enabled: true, intervalMs: 5 }) });

    const first = await worker.runOnce();
    const second = await worker.runOnce();

    expect(first).toMatchObject({ skipped: false, tenants: 2, closed: 2, failedMarkets: 0, failedTenants: 0 });
    expect(second.closed).toBe(0);
    const markets = core.store.snapshot().markets;
    expect(markets.filter((market) => market.status === "closed").map((market) => market.id).sort()).toEqual([dueA.id, dueB.id].sort());
    expect(markets.find((market) => market.id === later.id)?.status).toBe("open");
    expect(markets.filter((market) => market.status === "closed").every((market) => market.closedBy === AUTO_CLOSE_ACTOR && market.version === 4)).toBe(true);
    expect(core.store.snapshot().outbox.filter((row) => row.type === "si.chance.markets.MarketClosed.v1")).toHaveLength(2);
  });

  /** A funded, open market of tenant A that closes `hours` after the clock's time. */
  const openDueIn = async (core: Core, hours: number): Promise<Market> => {
    const draft = await createDraft(core, tenantAdmin(), { closeTime: closeTimeIn(core.clock, hours) });
    return (await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id })).market;
  };

  it("a shutdown during a tenant's run finishes the market in progress and leaves the rest open for the next run", async () => {
    const core = await createCore();
    for (const hours of [2, 3, 4, 5]) await openDueIn(core, hours);
    core.clock.advanceMs(6 * 3_600_000);
    const holder: { worker?: AutoCloseWorker } = {};
    const stops: Promise<void>[] = [];
    // The shutdown arrives while the first market is being closed.
    const store = racing(core.store, () => {
      const stopping = stops.length === 0 ? holder.worker?.stop() : undefined;
      if (stopping) stops.push(stopping);
      return Promise.resolve();
    });
    const worker = new AutoCloseWorker({ store: core.store, close: new CloseDueMarkets({ ...core.deps, store }), logger: core.logger, settings: () => ({ enabled: true, intervalMs: 3_600_000 }) });
    holder.worker = worker;
    const closedCount = () => core.store.snapshot().markets.filter((market) => market.status === "closed").length;

    worker.start();
    await waitFor(() => stops.length > 0);
    await stops[0];

    expect(closedCount()).toBe(1);
    // Nothing is lost: the next run closes the rest.
    expect(await worker.runOnce()).toMatchObject({ closed: 3, failedMarkets: 0 });
    expect(closedCount()).toBe(4);
  });

  it("does not run again at once when every close of a tenant fails: the next try is after the interval", async () => {
    const core = await createCore();
    const due = [await openDueIn(core, 2), await openDueIn(core, 3), await openDueIn(core, 4)];
    core.clock.advanceMs(5 * 3_600_000);
    const real = new CloseDueMarkets({ ...core.deps, store: failingOutboxFor(core.store, ...due.map((market) => market.id)) });
    const holder: { worker?: AutoCloseWorker } = {};
    const stops: Promise<void>[] = [];
    let executes = 0;
    const close: CloseDueMarketsUseCase = {
      execute: (input) => {
        executes += 1;
        // A loop without any wait never lets a timer fire, so a run that would repeat is ended from inside.
        if (executes === 8) {
          const stopping = holder.worker?.stop();
          if (stopping) stops.push(stopping);
        }
        return real.execute(input);
      },
    };
    const worker = new AutoCloseWorker({ store: core.store, close, logger: core.logger, settings: () => ({ enabled: true, intervalMs: 3_600_000 }), batchSize: 2 });
    holder.worker = worker;

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterFirstRun = executes;
    await worker.stop();
    await Promise.all(stops);

    // One visit to each of the two tenants, then the wait for the interval.
    expect(afterFirstRun).toBe(2);
    expect(core.logger.messages("error").filter((message) => message?.startsWith("Closing a market automatically failed"))).toHaveLength(2);
    expect(core.store.snapshot().markets.filter((market) => market.status === "closed")).toHaveLength(0);
  });
});
