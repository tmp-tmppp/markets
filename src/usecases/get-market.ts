import type { Market } from "../domain/market.js";
import { NotFound, TenantNotReady } from "./errors.js";
import type { Store } from "./ports.js";
import { canSee } from "./support.js";
import type { GetMarketUseCase, MarketInput } from "./use-cases.js";

/**
 * A market the caller may not see answers exactly like a missing one (404), so a trader cannot tell a draft or an
 * opening market from one that does not exist. A market of another tenant is not in this tenant's schema at all.
 */
export class GetMarket implements GetMarketUseCase {
  constructor(private readonly store: Store) {}

  async execute(input: MarketInput): Promise<Market> {
    const tenant = await this.store.forTenant(input.actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(input.marketId);
    if (!market || !canSee(input.actor.role, market.status)) throw new NotFound();
    return market;
  }
}
