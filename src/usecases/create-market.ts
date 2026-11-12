import { newMarket } from "../domain/market.js";
import type { Market } from "../domain/market.js";
import { TenantNotReady, guardDomain } from "./errors.js";
import type { MarketRulesSource, UseCaseDeps } from "./ports.js";
import { requireTenantAdmin } from "./support.js";
import type { CreateMarketInput, CreateMarketUseCase } from "./use-cases.js";

/**
 * Stores a draft market. No event: a draft is the tenant admins' private work, and consumers learn of a market when it
 * opens (MarketOpened). The limits come from the rules source, so a change of the runtime configuration (ADR-037)
 * applies to the next request without a restart.
 */
export class CreateMarket implements CreateMarketUseCase {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly rules: MarketRulesSource,
  ) {}

  async execute(input: CreateMarketInput): Promise<Market> {
    const { store, clock, ids, logger } = this.deps;
    const { actor } = input;
    requireTenantAdmin(actor.role);
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();

    const market = guardDomain(() =>
      newMarket(
        {
          id: ids.newId(),
          tenantId: actor.tenantId,
          question: input.question,
          description: input.description,
          closeTime: input.closeTime,
          startingPrice: input.startingPrice,
          fundingAmount: input.fundingAmount,
          createdBy: actor.userId,
          now: clock.now(),
          sharing: input.sharing,
        },
        this.rules.current(),
      ),
    );
    await tenant.transaction((repositories) => repositories.markets.insert(market));
    logger.info({ tenantId: market.tenantId, marketId: market.id, correlationId: actor.correlationId }, "Market created as a draft");
    return market;
  }
}
