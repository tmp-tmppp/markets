import { marketClosedEvent } from "../domain/events.js";
import { closeMarket } from "../domain/market.js";
import type { Market } from "../domain/market.js";
import { NotFound, TenantNotReady, guardDomain, invalidState } from "./errors.js";
import type { TenantRepositories, UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage, requireTenantAdmin } from "./support.js";
import type { CloseMarketUseCase, MarketInput } from "./use-cases.js";

/** Who closes the market and which request or run it belongs to; they end up in the market row and in the event. */
export interface CloseOrigin {
  /** The admin's subject, or AUTO_CLOSE_ACTOR for the automatic close. */
  closedBy: string;
  correlationId: string;
  causationId: string;
}

/**
 * The one place where a market is closed, for the admin's request (CloseMarket) and for the automatic close at the close
 * time (CloseDueMarkets, UC-15): the domain transition (open -> closed, version + 1), the update that is conditional on
 * the status and version that were read, and the MarketClosed event in the outbox. Call it inside the tenant's
 * transaction, so that the change and the event commit together (REL-01). Returns null when the stored row no longer has
 * the status and version of `market`, because someone changed it first.
 */
export async function closeInTransaction(
  deps: { ids: UseCaseDeps["ids"] },
  repositories: TenantRepositories,
  market: Market,
  origin: CloseOrigin,
  now: Date,
): Promise<Market | null> {
  const next = guardDomain(() => closeMarket(market, origin.closedBy, now));
  const event = marketClosedEvent(next, eventContext(deps, origin, now));
  if (!(await repositories.markets.update(next, { status: market.status, version: market.version }))) return null;
  await repositories.outbox.add(outboxMessage("MarketClosed", event, market.id, now));
  return next;
}

/**
 * open -> closed by any admin of the tenant. The state change and the MarketClosed event commit together (outbox,
 * REL-01). The update is conditional on the status and version that were read, so two concurrent closes cannot both
 * succeed: the loser reloads and answers 409.
 */
export class CloseMarket implements CloseMarketUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: MarketInput): Promise<Market> {
    const { store, clock, logger } = this.deps;
    const { actor, marketId } = input;
    requireTenantAdmin(actor.role);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(marketId);
    if (!market) throw new NotFound();

    const now = clock.now();
    const origin: CloseOrigin = { closedBy: actor.userId, correlationId: actor.correlationId, causationId: actor.causationId };
    const closed = await tenant.transaction((repositories) => closeInTransaction(this.deps, repositories, market, origin, now));
    if (!closed) {
      const current = await tenant.repositories.markets.findById(marketId);
      throw invalidState(`The market was changed by another request${current ? ` and is now ${current.status}` : ""}`);
    }
    logger.info({ tenantId: actor.tenantId, marketId, correlationId: actor.correlationId, version: closed.version }, "Market closed");
    return closed;
  }
}
