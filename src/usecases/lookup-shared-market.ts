import { normaliseEmail } from "../domain/share-link.js";
import type { ShareLink } from "../domain/share-link.js";
import { ShareLinkNotPermitted } from "./errors.js";
import type { NextAction } from "./errors.js";
import type { Clock, Store } from "./ports.js";
import { findActiveLink, sharedMarketOf } from "./share-support.js";
import type { LookupSharedMarketInput, LookupSharedMarketUseCase, LookupViewer, SharedMarketLookup } from "./use-cases.js";

/** Whether the link lets this caller see the market (and nothing else: joining is tenants' job). */
function admits(link: ShareLink, viewer: LookupViewer | null): boolean {
  if (link.type === "everyone") return true;
  if (viewer === null) return false;
  if (link.type === "members") return isMember(link, viewer);
  return viewer.emailVerified && viewer.email !== null && link.emails.includes(normaliseEmail(viewer.email));
}

/** A member of the link's organization by the token alone: the token's organization and a tenant role. */
const isMember = (link: ShareLink, viewer: LookupViewer): boolean => viewer.role !== null && viewer.tenantId?.toLowerCase() === link.tenantId;

/**
 * The public lookup. It tells an unknown, an expired and a revoked token apart from nothing: one 404. For a link that is
 * valid it shows the market's summary to the callers the link's type admits, and to nobody else it shows more than a
 * refusal (403), which names the organization's display name only for a signed-in caller of a members link (the web's
 * organization switch). Every check of the caller reads the token alone (contract v2): the organization of
 * the token and its group, or the verified e-mail claim.
 */
export class LookupSharedMarket implements LookupSharedMarketUseCase {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  async execute(input: LookupSharedMarketInput): Promise<SharedMarketLookup> {
    const { viewer } = input;
    const link = await findActiveLink(this.store, input.token, this.clock.now());
    const market = await sharedMarketOf(this.store, link);
    const name = await this.store.repositories.tenants.displayNameOf(link.tenantId);

    if (!admits(link, viewer)) {
      // A members link: the caller may belong to the organization with another token, so the web may offer a switch.
      const next: NextAction[] = viewer === null ? ["sign_in"] : link.type === "members" ? ["switch_organization"] : [];
      // The display name only drives the organization switch of a signed-in caller of a members link: nobody else learns it.
      throw new ShareLinkNotPermitted(next.includes("switch_organization") ? name : null, next);
    }
    let next: NextAction[];
    if (viewer === null) next = ["sign_in"];
    else if (isMember(link, viewer)) next = market.status === "open" ? ["trade"] : [];
    else next = ["join"];

    return {
      linkType: link.type,
      market: { id: market.id, question: market.question, status: market.status, closeTime: market.closeTime },
      organization: { alias: link.tenantId, name },
      next,
    };
  }
}
