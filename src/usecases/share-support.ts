import type { Market } from "../domain/market.js";
import { TRADER_VISIBLE_STATUSES } from "../domain/market.js";
import { hashToken, linkStatus, sameHash } from "../domain/share-link.js";
import type { ShareLink } from "../domain/share-link.js";
import { NotFound } from "./errors.js";
import type { Store } from "./ports.js";
import type { ShareLinkView } from "./use-cases.js";

/** The one answer for every token that leads nowhere: unknown, expired, revoked, or a market that is not shown any more. */
export const SHARE_LINK_NOT_FOUND = "No such share link";

export const shareLinkView = ({ tokenHash: _hidden, ...link }: ShareLink, now: Date): ShareLinkView => ({ ...link, status: linkStatus(link, now) });

/**
 * The active link of a token. The token is looked up by its hash (an indexed equality on a value that an attacker cannot
 * steer), and the stored hash is compared again in constant time. Nothing here says why a token fails.
 */
export async function findActiveLink(store: Store, token: string, now: Date): Promise<ShareLink> {
  const tokenHash = hashToken(token);
  const link = await store.repositories.shareLinks.findByTokenHash(tokenHash);
  if (!link || !sameHash(link.tokenHash, tokenHash) || linkStatus(link, now) !== "active") throw new NotFound(SHARE_LINK_NOT_FOUND);
  return link;
}

/** The market a link points to, if it is still one that members may see (open, closed or resolved); else the same 404. */
export async function sharedMarketOf(store: Store, link: ShareLink): Promise<Market> {
  const tenant = await store.forTenant(link.tenantId);
  const market = tenant ? await tenant.repositories.markets.findById(link.marketId) : null;
  if (!market || !TRADER_VISIBLE_STATUSES.includes(market.status)) throw new NotFound(SHARE_LINK_NOT_FOUND);
  return market;
}
