import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { OpeningRetryWorker } from "../../src/adapters/opening-retry/worker.js";
import { newMarket } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import type { PendingOpening } from "../../src/usecases/ports.js";
import { OPENING_LEASE_MS, PENDING_OPENING_BATCH, openingRetryDelayMs } from "../../src/usecases/support.js";
import type { FinishOpeningOutcome, RetryOpeningUseCase } from "../../src/usecases/use-cases.js";
import { RecordingLogger, SequentialIds, TENANT_A, TENANT_B, TestClock } from "../support/fakes.js";

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const RULES = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 60_000 };

/** A scripted RetryOpening: the test decides what each row's attempt does; the rows it is called with are recorded. */
class ScriptedRetry implements RetryOpeningUseCase {
  readonly calls: PendingOpening[] = [];
  /** Called for each row; the default settles nothing and says the outcome is still unknown. */
  behaviour: (pending: PendingOpening) => Promise<FinishOpeningOutcome> | FinishOpeningOutcome;

  /** What FinishOpening answers when the funding outcome stays unknown, and when another call settled the market first. */
  readonly unknown: FinishOpeningOutcome;
  readonly settled: FinishOpeningOutcome;

  constructor(market: Market) {
    this.unknown = { kind: "unknown", market };
    this.settled = { kind: "settled_before", market };
    this.behaviour = () => this.unknown;
  }

  async execute(pending: PendingOpening): Promise<FinishOpeningOutcome> {
    this.calls.push(pending);
    return this.behaviour(pending);
  }
}

async function setup(openings = 1, options: { batchSize?: number; leaseMs?: number; worstCallMs?: number } = {}) {
  const store = new MemoryStore();
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  await store.repositories.tenants.provision(TENANT_A, clock.now());
  await store.repositories.tenants.provision(TENANT_B, clock.now());
  const market = newMarket(
    { id: ids.newId(), tenantId: TENANT_A, question: "Will the new bridge open before 2027?", closeTime: new Date(clock.now().getTime() + 86_400_000).toISOString(), startingPrice: 0.4, fundingAmount: 500, createdBy: "admin-1", now: clock.now() },
    RULES,
  );
  const retry = new ScriptedRetry(market);
  const marketIds: string[] = [];
  for (let i = 0; i < openings; i += 1) {
    const marketId = ids.newId();
    marketIds.push(marketId);
    clock.tick();
    await store.transaction((repositories) =>
      repositories.pendingOpenings.add({ tenantId: TENANT_A, marketId, correlationId: `corr-${i}`, causationId: `req-${i}`, now: clock.now(), leaseUntil: clock.now() }),
    );
  }
  clock.tick();
  const worker = new OpeningRetryWorker({ store, retry, clock, logger, intervalMs: 5, ...options });
  return { store, clock, logger, retry, worker, market, marketIds };
}

const rowsOf = (store: MemoryStore) => store.snapshot().pendingOpenings;

describe("OpeningRetryWorker", () => {
  it("claims the due rows, runs the retry for each with the row's own ids, and leases them", async () => {
    const { worker, retry, store, clock, marketIds } = await setup(2);

    expect(await worker.runOnce()).toEqual({ claimed: 2 });

    expect(retry.calls.map((call) => [call.tenantId, call.marketId, call.correlationId, call.causationId, call.attempts])).toEqual([
      [TENANT_A, marketIds[0], "corr-0", "req-0", 0],
      [TENANT_A, marketIds[1], "corr-1", "req-1", 0],
    ]);
    // Nothing settled the rows, so they stay leased for the lease time: another poll right away claims nothing.
    expect(rowsOf(store).every((row) => row.leaseUntil?.getTime() === clock.now().getTime() + OPENING_LEASE_MS)).toBe(true);
    expect(await worker.runOnce()).toEqual({ claimed: 0 });
    expect(retry.calls).toHaveLength(2);
  });

  it("claims the batch size at most, earliest due first, and the rest at the next poll", async () => {
    const { worker, retry, marketIds } = await setup(7);
    expect(PENDING_OPENING_BATCH).toBe(5);

    expect(await worker.runOnce()).toEqual({ claimed: 5 });
    expect(await worker.runOnce()).toEqual({ claimed: 2 });

    expect(retry.calls.map((call) => call.marketId)).toEqual(marketIds);
  });

  it("takes a rescheduled row again when it is due, with the attempts the use case recorded", async () => {
    const { worker, retry, store, clock, marketIds } = await setup(1);
    retry.behaviour = async (pending) => {
      // What FinishOpening does when the funding outcome is unknown: attempts + 1, due later, the lease cleared.
      await store.repositories.pendingOpenings.reschedule(pending.tenantId, pending.marketId, new Date(clock.now().getTime() + openingRetryDelayMs(pending.attempts + 1)), "timeout");
      return retry.unknown;
    };

    await worker.runOnce();
    expect(rowsOf(store)[0]).toMatchObject({ attempts: 1, leaseUntil: null, lastError: "timeout" });
    expect(await worker.runOnce()).toEqual({ claimed: 0 }); // not due yet: 2 s

    clock.advanceMs(2000);
    expect(await worker.runOnce()).toEqual({ claimed: 1 });
    expect(retry.calls.map((call) => [call.marketId, call.attempts])).toEqual([
      [marketIds[0], 0],
      [marketIds[0], 1],
    ]);
  });

  it("claims a leased row only after the lease has ended (a request that died after beginning the opening)", async () => {
    const { store, retry, worker, clock, marketIds } = await setup(0);
    clock.tick();
    await store.transaction((repositories) =>
      repositories.pendingOpenings.add({ tenantId: TENANT_A, marketId: "00000000-0000-7000-8000-0000000000f1", correlationId: "c", causationId: "r", now: clock.now(), leaseUntil: new Date(clock.now().getTime() + 60_000) }),
    );
    expect(marketIds).toEqual([]);

    expect(await worker.runOnce()).toEqual({ claimed: 0 });
    clock.advanceMs(60_000);
    expect(await worker.runOnce()).toEqual({ claimed: 1 });
    expect(retry.calls[0]?.marketId).toBe("00000000-0000-7000-8000-0000000000f1");
  });

  it("goes on with the other rows when one fails, and logs the failure with the ids", async () => {
    const { worker, retry, logger, marketIds } = await setup(3);
    retry.behaviour = (pending) => {
      if (pending.marketId === marketIds[1]) return Promise.reject(new Error("database is down"));
      return retry.unknown;
    };

    expect(await worker.runOnce()).toEqual({ claimed: 3 });

    expect(retry.calls).toHaveLength(3);
    const errors = logger.lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ tenantId: TENANT_A, marketId: marketIds[1], correlationId: "corr-1", attempts: 0 });
  });

  it("leaves the rest of a batch to the next claim once the lease has passed", async () => {
    const { worker, retry, clock, logger } = await setup(3, { leaseMs: 1000 });
    retry.behaviour = () => {
      clock.advanceMs(600); // each row takes 600 ms: the lease of 1000 ms is over before the third
      return retry.unknown;
    };

    expect(await worker.runOnce()).toEqual({ claimed: 3 });

    expect(retry.calls).toHaveLength(2);
    expect(logger.lines.some((line) => line.level === "warn" && (line.fields as { skipped?: number }).skipped === 1)).toBe(true);
  });

  it("starts a row only when one whole funding call (worstCallMs) still fits in the rest of the lease", async () => {
    const { worker, retry, clock, logger } = await setup(3, { leaseMs: 1000, worstCallMs: 500 });
    retry.behaviour = () => {
      clock.advanceMs(300); // 0 + 500 and 300 + 500 are inside the lease of 1000 ms; at 600 ms a call of up to 500 ms would end after it
      return retry.unknown;
    };

    expect(await worker.runOnce()).toEqual({ claimed: 3 });

    // Without worstCallMs the third row would start at 600 ms, inside the lease, and could outlast it.
    expect(retry.calls).toHaveLength(2);
    expect(logger.lines.some((line) => line.level === "warn" && (line.fields as { skipped?: number }).skipped === 1)).toBe(true);
  });

  it("polls in the background, finishes rows that become due, and stops cleanly", async () => {
    const { worker, retry, store, marketIds } = await setup(1);
    retry.behaviour = async (pending) => {
      // A settled opening: the use case removes the row.
      await store.repositories.pendingOpenings.remove(pending.tenantId, pending.marketId);
      return retry.settled;
    };

    worker.start();
    worker.start(); // a second start changes nothing
    await waitFor(() => rowsOf(store).length === 0);
    await worker.stop();
    expect(retry.calls.map((call) => call.marketId)).toEqual(marketIds);

    // Stopped: a row added now stays untouched.
    await store.transaction((repositories) =>
      repositories.pendingOpenings.add({ tenantId: TENANT_A, marketId: "00000000-0000-7000-8000-0000000000f2", correlationId: "c", causationId: "r", now: new Date(0), leaseUntil: new Date(0) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(retry.calls).toHaveLength(1);
  });

  it("keeps running when the table cannot be read, and logs it", async () => {
    const { worker, retry, store, logger } = await setup(1);
    const claim = store.repositories.pendingOpenings.claim.bind(store.repositories.pendingOpenings);
    let failures = 2;
    store.repositories.pendingOpenings.claim = (...args) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("database is down"));
      }
      return claim(...args);
    };

    worker.start();
    await waitFor(() => retry.calls.length === 1);
    await worker.stop();

    expect(logger.lines.filter((line) => line.level === "error")).toHaveLength(2);
  });

  it("does not start rows after stop() was called and finishes the one in progress", async () => {
    const { worker, retry, marketIds } = await setup(3);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    retry.behaviour = async () => {
      await gate;
      return retry.unknown;
    };

    worker.start();
    await waitFor(() => retry.calls.length === 1);
    const stopped = worker.stop();
    release();
    await stopped;

    expect(retry.calls.map((call) => call.marketId)).toEqual([marketIds[0]]);
  });
});
