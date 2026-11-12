import { marketResolvedEvent } from "../domain/events.js";
import { parseOutcome, resolveMarket } from "../domain/market.js";
import type { Market } from "../domain/market.js";
import { NotFound, TenantNotReady, guardDomain, invalidState } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage, requireTenantAdmin } from "./support.js";
import type { ResolveMarketInput, ResolveMarketUseCase } from "./use-cases.js";

/**
 * closed -> resolved with the outcome, by any admin of the tenant. As CloseMarket: the state change and MarketResolved
 * commit together, and the conditional update lets one of two concurrent resolves win. The outcome is checked again
 * here (the web schema checks it first), and a bad one is a validation error even before the state is looked at.
 */
export class ResolveMarket implements ResolveMarketUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: ResolveMarketInput): Promise<Market> {
    const { store, clock, logger } = this.deps;
    const { actor, marketId } = input;
    requireTenantAdmin(actor.role);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(marketId);
    if (!market) throw new NotFound();

    const now = clock.now();
    const next = guardDomain(() => resolveMarket(market, parseOutcome(input.outcome), actor.userId, now));
    const event = marketResolvedEvent(next, eventContext(this.deps, actor, now));
    const resolved = await tenant.transaction(async (repositories) => {
      if (!(await repositories.markets.update(next, { status: market.status, version: market.version }))) return false;
      await repositories.outbox.add(outboxMessage("MarketResolved", event, market.id, now));
      return true;
    });
    if (!resolved) {
      const current = await tenant.repositories.markets.findById(marketId);
      throw invalidState(`The market was changed by another request${current ? ` and is now ${current.status}` : ""}`);
    }
    logger.info({ tenantId: actor.tenantId, marketId, correlationId: actor.correlationId, version: next.version, outcome: next.outcome }, "Market resolved");
    return next;
  }
}
