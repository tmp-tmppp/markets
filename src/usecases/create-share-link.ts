import { shareLinkCreatedEvent } from "../domain/events.js";
import { TRADER_VISIBLE_STATUSES } from "../domain/market.js";
import { hashToken, newShareLink } from "../domain/share-link.js";
import { mayMakeLink } from "../domain/sharing.js";
import { Forbidden, NotFound, TenantNotReady, guardDomain, invalidState } from "./errors.js";
import type { ShareLinkDeps } from "./ports.js";
import { shareLinkView } from "./share-support.js";
import { canSee, eventContext, outboxMessage } from "./support.js";
import type { CreateShareLinkInput, CreateShareLinkUseCase, CreatedShareLink } from "./use-cases.js";

/**
 * Makes a share link. The market's sharing policy decides who may and with which types, and it is checked here, never
 * only in the web layer. The link and its ShareLinkCreated event commit together (outbox, REL-01). The token exists in
 * clear text only in the returned value: the store keeps its SHA-256, and no log line holds either.
 */
export class CreateShareLink implements CreateShareLinkUseCase {
  constructor(private readonly deps: ShareLinkDeps) {}

  async execute(input: CreateShareLinkInput): Promise<CreatedShareLink> {
    const { store, clock, ids, tokens, logger } = this.deps;
    const { actor } = input;
    const tenant = await store.forTenant(actor.tenantId);
    if (!tenant) throw new TenantNotReady();
    const market = await tenant.repositories.markets.findById(input.marketId);
    if (!market || !canSee(actor.role, market.status)) throw new NotFound();
    if (!mayMakeLink(market.sharing, actor.role, input.type)) {
      throw new Forbidden(
        market.sharing.whoMayShare === "none" || (market.sharing.whoMayShare === "admins" && actor.role !== "tenant-admin")
          ? "The sharing policy of this market does not let you make share links"
          : `The sharing policy of this market does not allow share links of type ${input.type}`,
      );
    }
    if (!TRADER_VISIBLE_STATUSES.includes(market.status)) {
      throw invalidState(`A market that is ${market.status} cannot be shared yet: share links exist for open, closed and resolved markets`);
    }

    const now = clock.now();
    const token = tokens.newToken();
    const link = guardDomain(() =>
      newShareLink({
        id: ids.newId(),
        tokenHash: hashToken(token),
        tenantId: actor.tenantId,
        marketId: market.id,
        type: input.type,
        emails: input.emails,
        expiresAt: input.expiresAt,
        createdBy: actor.userId,
        now,
      }),
    );
    const event = shareLinkCreatedEvent(link, eventContext(this.deps, actor, now));
    await tenant.transaction(async (repositories) => {
      await repositories.shareLinks.insert(link);
      await repositories.outbox.add(outboxMessage("ShareLinkCreated", event, market.id, now));
    });
    logger.info(
      { tenantId: actor.tenantId, marketId: market.id, shareLinkId: link.id, linkType: link.type, correlationId: actor.correlationId },
      "Share link created",
    );
    return { link: shareLinkView(link, now), token };
  }
}
