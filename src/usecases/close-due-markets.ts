import { AUTO_CLOSE_ACTOR, isDueForClose } from "../domain/market.js";
import { closeInTransaction } from "./close-market.js";
import type { UseCaseDeps } from "./ports.js";
import type { CloseDueMarketsInput, CloseDueMarketsResult, CloseDueMarketsUseCase } from "./use-cases.js";

/**
 * UC-15: closes the open markets of one tenant whose close time has passed, as the service itself (closedBy is
 * AUTO_CLOSE_ACTOR). Each market goes through closeInTransaction, the same step as the admin's close: open -> closed,
 * version + 1 and the MarketClosed event in the outbox, in one transaction.
 *
 * Several instances run this at the same time. A cheap probe comes first (no transaction when nothing is due); then
 * every market is claimed and closed in a transaction of its own: claimDue takes the row with FOR UPDATE SKIP LOCKED, so
 * an instance passes over a market that another one is closing, and the market's change and event commit together before
 * the next market is looked at. One transaction per market is also the failure isolation: a market that fails (a database
 * error on its row) rolls back alone, is logged, is left out of the rest of this run and is tried again at the next one,
 * while the markets closed before it stay closed. A market that is not open any more (an admin closed it first) is not
 * claimed, so a market is never closed twice and never gets a second event.
 *
 * `more` is true only when the whole batch was closed (`closed` reached the limit): then a call at once is worthwhile.
 * A run with a failure answers false even when the limit was reached, so a market that keeps failing is tried once per
 * interval of the worker and not in a loop without a pause.
 *
 * `shouldStop` is asked before each market (the worker sets it at shutdown): when it answers true the loop ends, the
 * market in progress is already finished and the rest stay open for the next run, so a shutdown never waits for a whole batch.
 *
 * It throws only when a tenant's markets cannot be read at all (its schema is missing or the database fails before a
 * market is claimed); the worker isolates that per tenant.
 */
export class CloseDueMarkets implements CloseDueMarketsUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: CloseDueMarketsInput): Promise<CloseDueMarketsResult> {
    const { store, clock, ids, logger } = this.deps;
    const none: CloseDueMarketsResult = { closed: 0, failed: 0, more: false };
    const tenant = await store.forTenant(input.tenantId);
    if (!tenant) return none;
    if (!(await tenant.repositories.markets.hasDue(clock.now()))) return none;

    let closed = 0;
    const failed: string[] = [];
    while (closed + failed.length < input.limit && !input.shouldStop?.()) {
      const now = clock.now();
      // Set once a market is claimed, so that a failure can be tied to it (a holder object, because the assignment
      // happens inside the callback).
      const attempt: { marketId: string | null } = { marketId: null };
      try {
        const done = await tenant.transaction(async (repositories) => {
          const [market] = await repositories.markets.claimDue(now, 1, failed);
          if (!market || !isDueForClose(market, now)) return null;
          attempt.marketId = market.id;
          // No request caused this close: the run is its own correlation and its own cause.
          const runId = ids.newId();
          const result = await closeInTransaction(this.deps, repositories, market, { closedBy: AUTO_CLOSE_ACTOR, correlationId: runId, causationId: runId }, now);
          if (!result) throw new Error("The market was changed while it was locked");
          return { market: result, correlationId: runId };
        });
        if (!done) break;
        closed += 1;
        logger.info(
          { tenantId: input.tenantId, marketId: done.market.id, correlationId: done.correlationId, version: done.market.version, closeTime: done.market.closeTime.toISOString() },
          "Market closed automatically at its close time",
        );
      } catch (error) {
        // Nothing claimed: the tenant's markets cannot be read, which is not one market's failure.
        if (attempt.marketId === null) throw error;
        failed.push(attempt.marketId);
        logger.error(
          { tenantId: input.tenantId, marketId: attempt.marketId, err: error },
          "Closing a market automatically failed; it is left open and tried again at the next run",
        );
      }
    }
    return { closed, failed: failed.length, more: closed >= input.limit };
  }
}
