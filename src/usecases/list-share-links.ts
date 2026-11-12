import { NotFound, TenantNotReady } from "./errors.js";
import type { Clock, Store } from "./ports.js";
import { shareLinkView } from "./share-support.js";
import { canSee, readPage } from "./support.js";
import type { PageOf } from "./support.js";
import type { ListShareLinksInput, ListShareLinksUseCase, ShareLinkView } from "./use-cases.js";

/**
 * A tenant admin sees every link of the market, a trader only the links the trader made. The tokens are not stored, so
 * they cannot be listed. A market the caller may not see answers 404, like everywhere else.
 */
export class ListShareLinks implements ListShareLinksUseCase {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  async execute(input: ListShareLinksInput): Promise<PageOf<ShareLinkView>> {
    const { actor } = input;
    const tenant = await this.store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(input.marketId);
    if (!market || !canSee(actor.role, market.status)) throw new NotFound();

    const createdBy = actor.role === "tenant-admin" ? null : actor.userId;
    const page = await readPage(
      input,
      (limit, beforeId) => tenant.repositories.shareLinks.list({ tenantId: actor.tenantId, marketId: market.id, createdBy, limit, beforeId }),
      (link) => link.id,
    );
    const now = this.clock.now();
    return { items: page.items.map((link) => shareLinkView(link, now)), nextCursor: page.nextCursor };
  }
}
