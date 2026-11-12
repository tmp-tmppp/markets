import { describe, expect, it } from "vitest";
import { beginOpening, completeOpening } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { FinishOpening } from "../../src/usecases/finish-opening.js";
import type { PendingOpening, Store, TenantStore } from "../../src/usecases/ports.js";
import { OPENING_LEASE_MS, openingRetryDelayMs } from "../../src/usecases/support.js";
import type { FinishOpeningInput, FinishOpeningUseCase } from "../../src/usecases/use-cases.js";
import { RetryOpening } from "../../src/usecases/retry-opening.js";
import { RecordingLogger } from "../support/fakes.js";
import { TENANT_A, createCore, createDraft, tenantAdmin } from "./core.js";
import type { Core } from "./core.js";

const UNKNOWN_MARKET = "00000000-0000-7000-8000-0000000000ff";

/** A market that is "opening" with its pending row, as transaction A leaves it, without any funding call. */
async function openingMarket(core: Core, correlationId = "corr-request", causationId = "req-request") {
  const draft = await createDraft(core);
  const tenant = await core.store.forTenant(TENANT_A);
  const next = beginOpening(draft, core.clock.now());
  await tenant?.transaction(async (repositories) => {
    await repositories.markets.update(next, { status: "draft", version: 1 });
    await repositories.pendingOpenings.add({
      tenantId: TENANT_A,
      marketId: draft.id,
      correlationId,
      causationId,
      now: core.clock.now(),
      leaseUntil: new Date(core.clock.now().getTime() + OPENING_LEASE_MS),
    });
  });
  return next;
}

/**
 * A store whose tenant reads the market once and never again, and whose transactions always lose the version check:
 * the market was settled and then vanished, so FinishOpening cannot re-read it.
 */
function losingStore(core: Core, tenant: TenantStore | null): Store {
  if (!tenant) throw new Error("a registered tenant is expected");
  let reads = 0;
  return {
    repositories: core.store.repositories,
    transaction: (work) => core.store.transaction(work),
    ping: () => core.store.ping(),
    forTenant: (): Promise<TenantStore | null> =>
      Promise.resolve({
        tenantId: tenant.tenantId,
        repositories: {
          ...tenant.repositories,
          markets: {
            ...tenant.repositories.markets,
            findById: (id) => {
              reads += 1;
              return reads === 1 ? tenant.repositories.markets.findById(id) : Promise.resolve(null);
            },
          },
        },
        transaction: (work) => tenant.transaction((repositories) => work({ ...repositories, markets: { ...repositories.markets, update: () => Promise.resolve(false) } })),
      }),
  };
}

/** The input of the request's first call by default (attempts 0); a call with attempts, or firstCall false, is a worker retry. */
const inputFor = (market: Market, attempts = 0, correlationId = "corr-request", causationId = "req-request", firstCall = attempts === 0): FinishOpeningInput => ({
  tenantId: market.tenantId,
  marketId: market.id,
  correlationId,
  causationId,
  attempts,
  firstCall,
});

describe("FinishOpening, nothing to settle", () => {
  it("answers missing for an unknown market, calls nothing and removes a leftover row", async () => {
    const core = await createCore();
    await core.store.repositories.pendingOpenings.add({
      tenantId: TENANT_A,
      marketId: UNKNOWN_MARKET,
      correlationId: "c",
      causationId: "k",
      now: core.clock.now(),
      leaseUntil: core.clock.now(),
    });

    const outcome = await core.useCases.finishOpening.execute({ tenantId: TENANT_A, marketId: UNKNOWN_MARKET, correlationId: "c", causationId: "k", attempts: 3, firstCall: false });

    expect(outcome).toEqual({ kind: "missing" });
    expect(core.funding.calls).toEqual([]);
    expect(core.store.snapshot().pendingOpenings).toEqual([]);
    expect(core.logger.messages("warn")).toHaveLength(1);
  });

  it("answers missing for a tenant that has no schema", async () => {
    const core = await createCore({ provision: false });

    const outcome = await core.useCases.finishOpening.execute({ tenantId: TENANT_A, marketId: UNKNOWN_MARKET, correlationId: "c", causationId: "k", attempts: 0, firstCall: true });

    expect(outcome).toEqual({ kind: "missing" });
    expect(core.funding.calls).toEqual([]);
  });

  it.each(["draft", "open"] as const)("answers settled_before for a %s market, calls nothing and removes the row", async (status) => {
    const core = await createCore();
    const draft = await createDraft(core);
    const tenant = await core.store.forTenant(TENANT_A);
    if (status === "open") {
      const opened = completeOpening(beginOpening(draft, core.clock.now()), core.clock.now());
      await tenant?.repositories.markets.update(opened, { status: "draft", version: 1 });
    }
    await core.store.repositories.pendingOpenings.add({ tenantId: TENANT_A, marketId: draft.id, correlationId: "c", causationId: "k", now: core.clock.now(), leaseUntil: core.clock.now() });

    const outcome = await core.useCases.finishOpening.execute(inputFor(draft));

    expect(outcome).toMatchObject({ kind: "settled_before", market: { id: draft.id, status } });
    expect(core.funding.calls).toEqual([]);
    expect(core.store.snapshot().pendingOpenings).toEqual([]);
  });
});

describe("FinishOpening, one funding call", () => {
  it("funded: opens the market and writes MarketOpened with the correlation of the request that began the opening", async () => {
    const core = await createCore();
    const opening = await openingMarket(core, "corr-original", "req-original");

    const outcome = await core.useCases.finishOpening.execute(inputFor(opening, 0, "corr-original", "req-original"));

    expect(outcome).toMatchObject({ kind: "opened", market: { status: "open", version: 3 } });
    const state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.payload).toMatchObject({ correlationid: "corr-original", causationid: "req-original", data: { version: 3, creatorId: "admin-1" } });
    expect(core.logger.messages("info")).toContain("Market opened after funding");
  });

  it("insufficient credits, rejected and not sent: the market goes back to draft, the row goes, there is no event", async () => {
    const results = [
      [{ kind: "insufficient_credits" }, { kind: "insufficient_credits" }],
      [{ kind: "rejected", status: 403, detail: "forbidden" }, { kind: "rejected", status: 403 }],
      [{ kind: "not_sent", reason: "circuit open", retryAfterSeconds: 10 }, { kind: "not_sent", retryAfterSeconds: 10 }],
    ] as const;
    for (const [funding, expected] of results) {
      const core = await createCore();
      const opening = await openingMarket(core);
      core.funding.enqueue(funding);

      const outcome = await core.useCases.finishOpening.execute(inputFor(opening));

      expect(outcome).toMatchObject({ ...expected, market: { status: "draft", version: 3, openedAt: null } });
      const state = core.store.snapshot();
      expect(state.markets[0]).toMatchObject({ status: "draft", version: 3 });
      expect(state.pendingOpenings).toEqual([]);
      expect(state.outbox).toEqual([]);
    }
  });

  it("unknown: the market stays opening and the row is rescheduled with the doubling wait, capped at 300 seconds", async () => {
    const core = await createCore();
    const opening = await openingMarket(core);
    const waits: number[] = [];

    for (const attempts of [0, 1, 2, 8, 30]) {
      core.funding.enqueue({ kind: "unknown", reason: `timeout ${attempts}` });
      const outcome = await core.useCases.finishOpening.execute(inputFor(opening, attempts));
      expect(outcome).toMatchObject({ kind: "unknown", market: { status: "opening", version: 2 } });
      const row = core.store.snapshot().pendingOpenings[0];
      waits.push((row?.nextAttemptAt.getTime() ?? 0) - core.clock.now().getTime());
      expect(row).toMatchObject({ lastError: `timeout ${attempts}`, leaseUntil: null });
    }

    expect(waits).toEqual([2000, 4000, 8000, 300_000, 300_000]);
    expect(waits.slice(0, 3)).toEqual([0, 1, 2].map((attempts) => openingRetryDelayMs(attempts + 1)));
    expect(core.store.snapshot().pendingOpenings[0]?.attempts).toBe(5);
    expect(core.store.snapshot().outbox).toEqual([]);
  });

  it("reads the clock after the funding call for the times of the settlement and of the retry", async () => {
    const core: Core = await createCore({
      funding: {
        fund: () => {
          core.clock.advanceMs(3000);
          return Promise.resolve({ kind: "unknown", reason: "timeout" } as const);
        },
      },
    });
    const opening = await openingMarket(core);
    const started = core.clock.now();

    await core.useCases.finishOpening.execute(inputFor(opening));

    expect(core.store.snapshot().pendingOpenings[0]?.nextAttemptAt.getTime()).toBe(started.getTime() + 3000 + 2000);
  });

  it("answers settled_before, writes nothing and keeps the funding call, when another call settled the market during it", async () => {
    const core: Core = await createCore({
      funding: {
        fund: async () => {
          // The worker (lease ended) or the request finished the same opening while this call was on its way.
          const tenant = await core.store.forTenant(TENANT_A);
          const current = tenant ? await tenant.repositories.markets.findById(opening.id) : null;
          if (current && tenant) {
            await tenant.transaction(async (repositories) => {
              await repositories.markets.update(completeOpening(current, core.clock.now()), { status: "opening", version: 2 });
              await repositories.pendingOpenings.remove(TENANT_A, opening.id);
            });
          }
          return { kind: "funded" } as const;
        },
      },
    });
    const opening = await openingMarket(core);

    const outcome = await core.useCases.finishOpening.execute(inputFor(opening));

    expect(outcome).toMatchObject({ kind: "settled_before", market: { status: "open", version: 3 } });
    expect(core.store.snapshot().outbox).toEqual([]);
    expect(core.store.snapshot().markets[0]).toMatchObject({ status: "open", version: 3 });
  });

  it("answers missing when the market is gone after a lost race (it cannot be re-read)", async () => {
    const core = await createCore();
    const opening = await openingMarket(core);

    const outcome = await new FinishOpening({ ...core.deps, store: losingStore(core, await core.store.forTenant(TENANT_A)), funding: core.funding }).execute(inputFor(opening));

    expect(outcome).toEqual({ kind: "missing" });
  });

  it("sends the same Idempotency-Key and the same body on every attempt", async () => {
    const core = await createCore();
    const opening = await openingMarket(core);
    core.funding.enqueue({ kind: "unknown", reason: "a" }, { kind: "unknown", reason: "b" });

    await core.useCases.finishOpening.execute(inputFor(opening, 0));
    await core.useCases.finishOpening.execute(inputFor(opening, 1));
    await core.useCases.finishOpening.execute(inputFor(opening, 2));

    expect(core.funding.calls).toHaveLength(3);
    expect(new Set(core.funding.calls.map((call) => call.idempotencyKey))).toEqual(new Set([opening.id]));
    expect(new Set(core.funding.calls.map((call) => JSON.stringify(call.request))).size).toBe(1);
  });
});

describe("FinishOpening, a retry after an earlier call (firstCall false)", () => {
  // The earlier call may have sent the funding and lost the answer, so "nothing was sent now" proves nothing: the market
  // must stay opening, or its credits would be booked at trading while the market is a draft that nobody retries.
  const notSent = [
    ["the circuit is open", { kind: "not_sent", reason: "the circuit to trading is open", retryAfterSeconds: 10 }],
    ["no service token could be had", { kind: "not_sent", reason: "no service token for trading: Keycloak is down", retryAfterSeconds: 10 }],
  ] as const;

  it.each(notSent.flatMap(([name, funding]) => [0, 2].map((attempts) => [name, funding, attempts] as const)))(
    "not sent because %s, at attempts %i: the market stays opening and the row is rescheduled, at least the time the client asked for",
    async (_name, funding, attempts) => {
      const core = await createCore();
      const opening = await openingMarket(core);
      core.funding.enqueue(funding);

      const outcome = await core.useCases.finishOpening.execute(inputFor(opening, attempts, "corr-request", "req-request", false));

      expect(outcome).toMatchObject({ kind: "unknown", market: { status: "opening", version: 2 } });
      const state = core.store.snapshot();
      expect(state.markets[0]).toMatchObject({ status: "opening", version: 2 });
      expect(state.outbox).toEqual([]);
      const row = state.pendingOpenings[0];
      expect(row).toMatchObject({ attempts: 1, lastError: funding.reason, leaseUntil: null });
      // 10 s from the client beats the 2 s or 8 s of the backoff.
      expect((row?.nextAttemptAt.getTime() ?? 0) - core.clock.now().getTime()).toBe(10_000);
      expect(core.logger.messages("warn")).toContain("The funding outcome is unknown; the market stays opening and is retried");
    },
  );

  it("not sent: a backoff longer than the client's wait still wins", async () => {
    const core = await createCore();
    const opening = await openingMarket(core);
    core.funding.enqueue({ kind: "not_sent", reason: "circuit open", retryAfterSeconds: 1 });

    await core.useCases.finishOpening.execute(inputFor(opening, 3, "corr-request", "req-request", false));

    expect((core.store.snapshot().pendingOpenings[0]?.nextAttemptAt.getTime() ?? 0) - core.clock.now().getTime()).toBe(openingRetryDelayMs(4));
  });

  it.each([401, 403])("rejected with %i (the authentication, not the key): the market stays opening, the row is rescheduled and an error is logged", async (status) => {
    const core = await createCore();
    const opening = await openingMarket(core);
    core.funding.enqueue({ kind: "rejected", status, detail: "bad token" });

    const outcome = await core.useCases.finishOpening.execute(inputFor(opening, 1, "corr-request", "req-request", false));

    expect(outcome).toMatchObject({ kind: "unknown", market: { status: "opening", version: 2 } });
    const state = core.store.snapshot();
    expect(state.markets[0]).toMatchObject({ status: "opening", version: 2 });
    expect(state.pendingOpenings[0]).toMatchObject({ attempts: 1, lastError: expect.stringContaining(String(status)) as string });
    expect(state.outbox).toEqual([]);
    expect(core.logger.messages("error")).toHaveLength(1);
  });

  it("still settles what is certain: 404 and 422 revert to draft, insufficient credits reverts to draft, funded opens", async () => {
    for (const [funding, status] of [
      [{ kind: "rejected", status: 404, detail: "no account" }, "draft"],
      [{ kind: "rejected", status: 422, detail: "invalid" }, "draft"],
      [{ kind: "insufficient_credits" }, "draft"],
      [{ kind: "funded" }, "open"],
    ] as const) {
      const core = await createCore();
      const opening = await openingMarket(core);
      core.funding.enqueue(funding);

      await core.useCases.finishOpening.execute(inputFor(opening, 1, "corr-request", "req-request", false));

      expect(core.store.snapshot().markets[0]?.status).toBe(status);
      expect(core.store.snapshot().pendingOpenings).toEqual([]);
    }
  });

  it("a first call (firstCall true) that is not sent, or refused with 401, still goes back to draft: nothing was ever sent before", async () => {
    for (const funding of [
      { kind: "not_sent", reason: "circuit open", retryAfterSeconds: 10 },
      { kind: "rejected", status: 401, detail: "bad token" },
    ] as const) {
      const core = await createCore();
      const opening = await openingMarket(core);
      core.funding.enqueue(funding);

      const outcome = await core.useCases.finishOpening.execute(inputFor(opening, 0, "corr-request", "req-request", true));

      expect(outcome).toMatchObject({ kind: funding.kind, market: { status: "draft" } });
      expect(core.store.snapshot().pendingOpenings).toEqual([]);
    }
  });

  it("the worker path never reverts: a claimed row of a request that died mid-call (attempts 0) stays opening on not_sent", async () => {
    const core = await createCore();
    const opening = await openingMarket(core);
    // The request's lease runs out: the worker claims the row, which has attempts 0 although the request may have sent the funding.
    core.clock.advanceMs(OPENING_LEASE_MS + 1000);
    const [row] = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + OPENING_LEASE_MS), core.clock.now());
    expect(row).toMatchObject({ marketId: opening.id, attempts: 0 });
    core.funding.enqueue({ kind: "not_sent", reason: "the circuit to trading is open", retryAfterSeconds: 10 });

    const outcome = await core.useCases.retryOpening.execute(row as PendingOpening);

    expect(outcome).toMatchObject({ kind: "unknown", market: { status: "opening" } });
    expect(core.store.snapshot().pendingOpenings).toHaveLength(1);
    expect(core.store.snapshot().markets[0]?.status).toBe("opening");
  });

  it("an unknown outcome, then a retry that is not sent, then a funded retry: the market opens once, with one MarketOpened", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "unknown", reason: "timeout" }, { kind: "not_sent", reason: "circuit open", retryAfterSeconds: 2 });
    expect((await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id })).state).toBe("opening");

    core.clock.advanceMs(60_000);
    const [first] = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + OPENING_LEASE_MS), core.clock.now());
    expect(await core.useCases.retryOpening.execute(first as PendingOpening)).toMatchObject({ kind: "unknown" });
    core.clock.advanceMs(60_000);
    const [second] = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + OPENING_LEASE_MS), core.clock.now());
    const outcome = await core.useCases.retryOpening.execute(second as PendingOpening);

    expect(outcome).toMatchObject({ kind: "opened", market: { status: "open", version: 3 } });
    expect(core.store.snapshot().outbox).toHaveLength(1);
  });
});

describe("RetryOpening", () => {
  it("runs FinishOpening for a claimed row with the row's ids and attempts, and logs the attempt", async () => {
    const seen: FinishOpeningInput[] = [];
    const logger = new RecordingLogger();
    const finishing: FinishOpeningUseCase = {
      execute: (input) => {
        seen.push(input);
        return Promise.resolve({ kind: "missing" });
      },
    };
    const pending: PendingOpening = {
      tenantId: TENANT_A,
      marketId: UNKNOWN_MARKET,
      correlationId: "corr-row",
      causationId: "req-row",
      attempts: 4,
      nextAttemptAt: new Date(0),
      leaseUntil: new Date(0),
      lastError: "timeout",
      createdAt: new Date(0),
    };

    const outcome = await new RetryOpening(finishing, logger).execute(pending);

    expect(outcome).toEqual({ kind: "missing" });
    expect(seen).toEqual([{ tenantId: TENANT_A, marketId: UNKNOWN_MARKET, correlationId: "corr-row", causationId: "req-row", attempts: 4, firstCall: false }]);
    expect(logger.lines).toEqual([
      expect.objectContaining({ level: "info", fields: expect.objectContaining({ tenantId: TENANT_A, marketId: UNKNOWN_MARKET, attempts: 4, outcome: "missing" }) }),
    ]);
    await expect(new RetryOpening(finishing).execute(pending)).resolves.toEqual({ kind: "missing" });
  });

  it("finishes an opening whose first outcome was unknown: claimed after the wait, the same key, one MarketOpened, row gone", async () => {
    const core = await createCore();
    const draft = await createDraft(core);
    core.funding.enqueue({ kind: "unknown", reason: "timeout" });
    const first = await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id });
    expect(first.state).toBe("opening");

    const tooEarly = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + 60_000), core.clock.now());
    expect(tooEarly).toEqual([]);
    core.clock.advanceMs(2000);
    const claimed = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + 60_000), core.clock.now());
    expect(claimed).toHaveLength(1);
    const outcome = await core.useCases.retryOpening.execute(claimed[0] as PendingOpening);

    expect(outcome).toMatchObject({ kind: "opened", market: { status: "open", version: 3 } });
    const state = core.store.snapshot();
    expect(state.pendingOpenings).toEqual([]);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.payload).toMatchObject({ correlationid: "corr-admin-1", causationid: "req-admin-1" });
    expect(core.funding.calls.map((call) => call.idempotencyKey)).toEqual([draft.id, draft.id]);
    expect(core.logger.messages("info")).toContain("Opening retry attempt finished");
  });

  it("keeps retrying while the outcome stays unknown: the row's attempts grow and the wait doubles", async () => {
    const core = await createCore({ fundingMode: "unknown" });
    const draft = await createDraft(core);
    await core.useCases.openMarket.execute({ actor: tenantAdmin(), marketId: draft.id });

    const waits: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      core.clock.advanceMs(300_000);
      const [row] = await core.store.repositories.pendingOpenings.claim(5, new Date(core.clock.now().getTime() + 60_000), core.clock.now());
      expect(row?.attempts).toBe(round + 1);
      await core.useCases.retryOpening.execute(row as PendingOpening);
      waits.push((core.store.snapshot().pendingOpenings[0]?.nextAttemptAt.getTime() ?? 0) - core.clock.now().getTime());
    }

    expect(waits).toEqual([4000, 8000, 16_000]);
    expect(core.store.snapshot().markets[0]?.status).toBe("opening");
  });
});
