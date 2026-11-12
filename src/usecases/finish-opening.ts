import { marketOpenedEvent } from "../domain/events.js";
import { completeOpening, revertOpening } from "../domain/market.js";
import type { Market } from "../domain/market.js";
import type { FundingResult, OpeningDeps, TenantStore } from "./ports.js";
import { eventContext, fundingIdempotencyKey, openingRetryDelayMs, outboxMessage } from "./support.js";
import type { FinishOpeningInput, FinishOpeningOutcome, FinishOpeningUseCase } from "./use-cases.js";

/** What one funding answer means for the market: a settlement, or "keep it opening and try again later". */
type Answer =
  | Exclude<FundingResult, { kind: "unknown" }>
  | { kind: "retry"; reason: string; minWaitMs: number; alert: boolean };

/**
 * Only the first call of an opening can prove that nothing was taken; for a retry, "not sent" and the answers of
 * trading's authentication layer (401, 403: it answers before it looks at the Idempotency-Key) prove nothing.
 */
function answerOf(result: FundingResult, firstCall: boolean): Answer {
  switch (result.kind) {
    case "unknown":
      return { kind: "retry", reason: result.reason, minWaitMs: 0, alert: false };
    case "not_sent":
      return firstCall ? result : { kind: "retry", reason: result.reason, minWaitMs: result.retryAfterSeconds * 1000, alert: false };
    case "rejected":
      if (!firstCall && (result.status === 401 || result.status === 403)) {
        return {
          kind: "retry",
          reason: `trading refused the authentication of a repeat (${result.status}); an earlier call may have been booked`,
          minWaitMs: 0,
          alert: true,
        };
      }
      return result;
    default:
      return result;
  }
}

/**
 * Steps 2 and 3 of the opening saga (DM-19): one funding call to trading, outside any transaction, and then transaction B
 * that settles the market. OpenMarket runs it for the request, RetryOpening for every row the worker claims; both use
 * the same Idempotency-Key (the market id), so a repeat after an unknown outcome never funds a market twice.
 *
 * A funding outcome is never thrown: it is the returned kind, and OpenMarket turns it into the HTTP answer. A market
 * whose outcome stays unknown remains "opening" and its pending row is rescheduled with a growing wait; there is no
 * give-up, because every retry is safe and the credits were possibly taken already.
 *
 * "Nothing was taken" is known only for the first call of an opening (input.firstCall, the request that has just written
 * the row). A retry may follow a call whose answer was lost, so there "not sent" (circuit open, no service token) and a
 * 401 or 403 (trading's authentication answers before it looks at the Idempotency-Key) are no proof: the market stays
 * opening and the row is rescheduled, waiting at least the time the client asked for.
 */
export class FinishOpening implements FinishOpeningUseCase {
  constructor(private readonly deps: OpeningDeps) {}

  async execute(input: FinishOpeningInput): Promise<FinishOpeningOutcome> {
    const { store, funding, clock, logger } = this.deps;
    const { tenantId, marketId } = input;
    const logFields = { tenantId, marketId, correlationId: input.correlationId };

    const tenant = await store.forTenant(tenantId);
    const market = tenant ? await tenant.repositories.markets.findById(marketId) : null;
    if (!tenant || !market) {
      await store.repositories.pendingOpenings.remove(tenantId, marketId);
      logger.warn(logFields, "The market of a pending opening does not exist; its pending row was removed");
      return { kind: "missing" };
    }
    if (market.status !== "opening") {
      // Another call (the request or the worker) settled it first: nothing is left to do, and nothing is called.
      await store.repositories.pendingOpenings.remove(tenantId, marketId);
      return { kind: "settled_before", market };
    }

    const answered = await funding.fund({ marketId, tenantId, creatorId: market.createdBy, amount: market.fundingAmount }, fundingIdempotencyKey(marketId));
    // The clock is read after the call: it can take seconds, and these are the times of the settlement.
    const now = clock.now();
    const result = answerOf(answered, input.firstCall);

    if (result.kind === "retry") {
      const attempts = input.attempts + 1;
      const retryAt = new Date(now.getTime() + Math.max(openingRetryDelayMs(attempts), result.minWaitMs));
      await store.repositories.pendingOpenings.reschedule(tenantId, marketId, retryAt, result.reason);
      const fields = { ...logFields, attempts, retryAt: retryAt.toISOString(), reason: result.reason };
      if (result.alert) logger.error(fields, "Trading refused the authentication of a funding repeat; the market stays opening and is retried (check the service token and trading's configuration)");
      else logger.warn(fields, "The funding outcome is unknown; the market stays opening and is retried");
      return { kind: "unknown", market };
    }

    // Transaction B: funded opens the market and writes MarketOpened; every other answer means nothing was taken, so the
    // market goes back to draft (a "not sent" or an authentication refusal of a retry never gets here: see answerOf).
    // The row of the saga goes in the same transaction. The update is the version check: if
    // another call settled the market meanwhile, it matches no row, and nothing of this transaction is written.
    const next = result.kind === "funded" ? completeOpening(market, now) : revertOpening(market, now);
    const event = result.kind === "funded" ? marketOpenedEvent(next, eventContext(this.deps, input, now)) : null;
    const settled = await tenant.transaction(async (repositories) => {
      if (!(await repositories.markets.update(next, { status: "opening", version: market.version }))) return false;
      if (event) await repositories.outbox.add(outboxMessage("MarketOpened", event, market.id, now));
      await repositories.pendingOpenings.remove(tenantId, marketId);
      return true;
    });
    if (!settled) return this.settledMeanwhile(tenant, marketId, logFields);

    switch (result.kind) {
      case "funded":
        logger.info({ ...logFields, attempts: input.attempts, version: next.version }, "Market opened after funding");
        return { kind: "opened", market: next };
      case "insufficient_credits":
        logger.info(logFields, "Funding refused: not enough credits; the market is back in draft");
        return { kind: "insufficient_credits", market: next };
      case "rejected":
        // Trading refused the request itself (a contract or configuration problem), not the credits: worth an alert.
        logger.error({ ...logFields, status: result.status, detail: result.detail }, "Trading rejected the funding request; the market is back in draft");
        return { kind: "rejected", market: next, status: result.status };
      case "not_sent":
        logger.warn({ ...logFields, reason: result.reason }, "The funding was not sent; the market is back in draft");
        return { kind: "not_sent", market: next, retryAfterSeconds: result.retryAfterSeconds };
    }
  }

  private async settledMeanwhile(tenant: TenantStore, marketId: string, logFields: object): Promise<FinishOpeningOutcome> {
    const current: Market | null = await tenant.repositories.markets.findById(marketId);
    this.deps.logger.info(logFields, "The market was settled by another call while this funding call ran");
    return current ? { kind: "settled_before", market: current } : { kind: "missing" };
  }
}
