import { shareLinkRevokedEvent } from "../domain/events.js";
import { NotFound, TenantNotReady } from "./errors.js";
import type { UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage } from "./support.js";
import type { RevokeShareLinkInput, RevokeShareLinkUseCase } from "./use-cases.js";

/**
 * The creator of a link, or a tenant admin, revokes it. Another trader's link is as invisible as one that does not exist
 * (404). A link that is revoked already stays as it is: no second event. The conditional update lets two concurrent
 * revokes agree on who wrote the event.
 */
export class RevokeShareLink implements RevokeShareLinkUseCase {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: RevokeShareLinkInput): Promise<void> {
    const { store, clock, logger } = this.deps;
    const { actor } = input;
    if (!(await store.repositories.tenants.isRegistered(actor.tenantId))) throw new TenantNotReady();
    const link = await store.repositories.shareLinks.findById(actor.tenantId, input.linkId);
    if (!link || link.marketId !== input.marketId) throw new NotFound("No such share link");
    if (actor.role !== "tenant-admin" && link.createdBy !== actor.userId) throw new NotFound("No such share link");
    if (link.revokedAt !== null) return;

    const now = clock.now();
    const event = shareLinkRevokedEvent(link, actor.userId, now, eventContext(this.deps, actor, now));
    const revoked = await store.transaction(async (repositories) => {
      if (!(await repositories.shareLinks.revoke(actor.tenantId, link.id, now))) return false;
      await repositories.outbox.add(outboxMessage("ShareLinkRevoked", event, link.marketId, now));
      return true;
    });
    if (revoked) {
      logger.info({ tenantId: actor.tenantId, marketId: link.marketId, shareLinkId: link.id, correlationId: actor.correlationId }, "Share link revoked");
    }
  }
}
