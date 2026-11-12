import type { Market } from "../domain/market.js";
import { TenantNotReady } from "./errors.js";
import type { Store } from "./ports.js";
import { readPage, visibleStatuses } from "./support.js";
import type { PageOf } from "./support.js";
import type { ListMarketsInput, ListMarketsUseCase } from "./use-cases.js";

/** Newest first. The statuses come first, so a trader asking for draft or opening gets 403 before anything is read. */
export class ListMarkets implements ListMarketsUseCase {
  constructor(private readonly store: Store) {}

  async execute(input: ListMarketsInput): Promise<PageOf<Market>> {
    const statuses = visibleStatuses(input.actor.role, input.status);
    const tenant = await this.store.forTenant(input.actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    return readPage(
      input,
      (limit, beforeId) => tenant.repositories.markets.list({ statuses, limit, beforeId }),
      (market) => market.id,
    );
  }
}
