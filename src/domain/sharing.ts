import { DomainError } from "./errors.js";

// The sharing policy of a market and the rules that tell whether a member may make a share link of a type.
// Pure: no clock, no ids, no I/O.

export const WHO_MAY_SHARE = ["none", "admins", "members"] as const;
export type WhoMayShare = (typeof WHO_MAY_SHARE)[number];

/** Members of the organization, listed profiles (verified e-mail addresses), or everyone who has the link. */
export const LINK_TYPES = ["members", "profiles", "everyone"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface SharingPolicy {
  readonly whoMayShare: WhoMayShare;
  /** The link types the market may be shared with, each once, in the order of LINK_TYPES. */
  readonly linkTypes: readonly LinkType[];
}

/** The policy of a market created without `sharing`: members share with members. */
export const DEFAULT_SHARING: SharingPolicy = { whoMayShare: "members", linkTypes: ["members"] };

export const isWhoMayShare = (value: unknown): value is WhoMayShare => typeof value === "string" && (WHO_MAY_SHARE as readonly string[]).includes(value);
export const isLinkType = (value: unknown): value is LinkType => typeof value === "string" && (LINK_TYPES as readonly string[]).includes(value);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The policy of a new market from the request's `sharing` (undefined: the default). A field that is left out takes its
 * default; an unknown field, an unknown value or a list that is no list is refused. The link types are kept once each,
 * in the canonical order, so that two requests that mean the same store the same policy.
 */
export function validateSharing(input: unknown): SharingPolicy {
  if (input === undefined) return DEFAULT_SHARING;
  if (!isObject(input)) throw new DomainError("invalid_sharing", "sharing must be an object", "sharing");
  for (const key of Object.keys(input)) {
    if (key !== "whoMayShare" && key !== "linkTypes") throw new DomainError("invalid_sharing", `sharing has no field ${key}`, `sharing.${key}`);
  }
  const who = input["whoMayShare"] === undefined ? DEFAULT_SHARING.whoMayShare : input["whoMayShare"];
  if (!isWhoMayShare(who)) {
    throw new DomainError("invalid_sharing", `whoMayShare must be one of: ${WHO_MAY_SHARE.join(", ")}`, "sharing.whoMayShare");
  }
  const types = input["linkTypes"] === undefined ? DEFAULT_SHARING.linkTypes : input["linkTypes"];
  if (!Array.isArray(types) || !types.every(isLinkType)) {
    throw new DomainError("invalid_sharing", `linkTypes must be a list of: ${LINK_TYPES.join(", ")}`, "sharing.linkTypes");
  }
  return { whoMayShare: who, linkTypes: LINK_TYPES.filter((type) => types.includes(type)) };
}

/** Reads a stored policy again (a database row): the same checks, so a row that was edited by hand cannot widen sharing. */
export function sharingFromStored(whoMayShare: string, linkTypes: readonly string[]): SharingPolicy {
  return validateSharing({ whoMayShare, linkTypes: [...linkTypes] });
}

/** Whether a caller of this role may make a link of this type: the policy's `whoMayShare` and `linkTypes` both must allow it. */
export function mayMakeLink(policy: SharingPolicy, role: "trader" | "tenant-admin", type: LinkType): boolean {
  if (policy.whoMayShare === "none") return false;
  if (policy.whoMayShare === "admins" && role !== "tenant-admin") return false;
  return policy.linkTypes.includes(type);
}
