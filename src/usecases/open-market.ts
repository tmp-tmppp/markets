import { beginOpening } from "../domain/market.js";
import { Forbidden, FundingRejected, InsufficientCredits, NotFound, TenantNotReady, TradingUnavailable, guardDomain, invalidState } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { OPENING_LEASE_MS, requireTenantAdmin } from "./support.js";
import type { FinishOpeningUseCase, MarketInput, OpenMarketResult, OpenMarketUseCase } from "./use-cases.js";

/**
 * The opening saga (DM-19), step 1 and the mapping of its end. Transaction A turns the draft into "opening" and writes the
 * pending row in one commit; the funding call and transaction B are FinishOpening's. Only the creator may open: their
 * credits fund the market. A market that is already opening answers "opening" without a new call; the saga in flight,
 * or the retry worker, settles it.
 */
export class OpenMarket implements OpenMarketUseCase {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly finishOpening: FinishOpeningUseCase,
  ) {}

  async execute(input: MarketInput): Promise<OpenMarketResult> {
    const { store, clock } = this.deps;
    const { actor, marketId } = input;
    requireTenantAdmin(actor.role);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(marketId);
    if (!market) throw new NotFound();
    if (actor.userId !== market.createdBy) throw new Forbidden("Only the creator of a market can open it: their credits fund it");
    if (market.status === "opening") return { market, state: "opening" };

    const now = clock.now();
    const next = guardDomain(() => beginOpening(market, now));
    // Transaction A. The update matches only the draft at the version that was read, so of two concurrent openers one
    // wins; the pending row is written with it, and holds a lease for this request, which makes the funding call itself.
    const began = await tenant.transaction(async (repositories) => {
      if (!(await repositories.markets.update(next, { status: "draft", version: market.version }))) return false;
      await repositories.pendingOpenings.add({
        tenantId: actor.tenantId,
        marketId,
        correlationId: actor.correlationId,
        causationId: actor.causationId,
        now,
        leaseUntil: new Date(now.getTime() + OPENING_LEASE_MS),
      });
      return true;
    });
    if (!began) {
      const current = await tenant.repositories.markets.findById(marketId);
      if (current?.status === "opening") return { market: current, state: "opening" };
      throw invalidState("The market was changed by another request; read it and try again");
    }

    const outcome = await this.finishOpening.execute({
      tenantId: actor.tenantId,
      marketId,
      correlationId: actor.correlationId,
      causationId: actor.causationId,
      attempts: 0,
      // Transaction A has just written the row: this is the first call of this opening.
      firstCall: true,
    });
    switch (outcome.kind) {
      case "opened":
        return { market: outcome.market, state: "open" };
      case "unknown":
        return { market: outcome.market, state: "opening" };
      case "insufficient_credits":
        throw new InsufficientCredits();
      case "rejected":
        throw new FundingRejected(outcome.status);
      case "not_sent":
        throw new TradingUnavailable(outcome.retryAfterSeconds);
      case "settled_before":
        // Someone else (the worker after the lease ended) settled the market while this request waited.
        if (outcome.market.status === "open" || outcome.market.status === "opening") return { market: outcome.market, state: outcome.market.status };
        throw invalidState(`The market was changed by another request and is now ${outcome.market.status}`);
      case "missing":
        throw new NotFound();
    }
  }
}
