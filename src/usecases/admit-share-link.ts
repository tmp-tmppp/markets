import { normaliseEmail } from "../domain/share-link.js";
import type { Clock, Store } from "./ports.js";
import { findActiveLink, sharedMarketOf } from "./share-support.js";
import type { AdmitShareLinkInput, AdmitShareLinkUseCase, ShareLinkAdmission } from "./use-cases.js";

/**
 * What a share link lets a signed-in caller do, for tenants (the service adds the membership itself; markets cannot see
 * memberships and tenants cannot see the links). It changes nothing, so it may be repeated. `everyone` admits; `profiles`
 * admits a caller whose verified e-mail is on the list and says `denied` to every other; `members` never admits (the
 * link is for people who belong to the organization already). An unknown, expired or revoked token is the one 404.
 */
export class AdmitShareLink implements AdmitShareLinkUseCase {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  async execute(input: AdmitShareLinkInput): Promise<ShareLinkAdmission> {
    const link = await findActiveLink(this.store, input.token, this.clock.now());
    const market = await sharedMarketOf(this.store, link);
    let decision: ShareLinkAdmission["decision"];
    if (link.type === "everyone") decision = "join";
    else if (link.type === "members") decision = "members_only";
    else decision = input.emailVerified && input.userEmail !== null && link.emails.includes(normaliseEmail(input.userEmail)) ? "join" : "denied";
    return { decision, linkType: link.type, tenantId: link.tenantId, marketId: market.id };
  }
}
