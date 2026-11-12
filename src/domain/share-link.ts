import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "./errors.js";
import { parseDateTime } from "./market.js";
import type { LinkType } from "./sharing.js";

// A share link (plan: sharing a market by link). The link is a secret token of 32 random bytes; the service keeps only
// its SHA-256, so a copy of the database holds no usable link. Pure: the use cases pass in the clock and the random token.

/** 32 random bytes in base64url: 43 characters, no padding. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_EMAILS = 50;
/** RFC 5321: a forward path is at most 254 characters. */
export const MAX_EMAIL_LENGTH = 254;

export interface ShareLink {
  readonly id: string;
  /** SHA-256 of the token, 64 lower-case hex digits. */
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly marketId: string;
  readonly type: LinkType;
  /** Lower case, each address once; empty unless the type is `profiles`. */
  readonly emails: readonly string[];
  /** Subject of the user who made the link. */
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export type ShareLinkStatus = "active" | "revoked" | "expired";

export const isWellFormedToken = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);

/** What the database stores of a token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two token hashes (hex of the same length). */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Revoked wins over expired: a revoked link stays revoked after its expiry time. */
export function linkStatus(link: Pick<ShareLink, "expiresAt" | "revokedAt">, now: Date): ShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

// One @, a local part and a domain with at least one dot, no spaces, quotes, angle brackets or control characters: the
// shape a sign-in provider verifies. It is a plausibility check, the real proof is the verified claim of the caller.
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** An address as it is compared: trimmed and in lower case. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * The addresses of a `profiles` link: 1 to 50, each a valid address of at most 254 characters, trimmed, in lower case
 * and kept once (the first spelling counts). Throws a DomainError that names the field.
 */
export function validateEmails(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_EMAILS) {
    throw new DomainError("invalid_share_link", `emails must be a list of 1 to ${MAX_EMAILS} addresses`, "emails");
  }
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    const address = typeof item === "string" ? normaliseEmail(item) : "";
    if (address.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(address)) {
      throw new DomainError("invalid_share_link", "every entry of emails must be a valid e-mail address", `emails.${index}`);
    }
    seen.add(address);
  }
  return [...seen];
}

/** The expiry of a new link: an RFC 3339 date-time with a time zone, later than now. */
export function validateExpiresAt(input: unknown, now: Date): Date {
  const at = typeof input === "string" ? parseDateTime(input) : null;
  if (!at) throw new DomainError("invalid_share_link", "expiresAt must be an ISO 8601 date-time with a time zone", "expiresAt");
  if (at.getTime() <= now.getTime()) throw new DomainError("invalid_share_link", "expiresAt must be in the future", "expiresAt");
  return at;
}

export interface NewShareLinkInput {
  id: string;
  tokenHash: string;
  tenantId: string;
  marketId: string;
  type: LinkType;
  emails?: unknown;
  expiresAt?: unknown;
  createdBy: string;
  now: Date;
}

/** A new link. `emails` belong to the type `profiles` alone: given for another type, or missing for `profiles`, they are refused. */
export function newShareLink(input: NewShareLinkInput): ShareLink {
  let emails: string[] = [];
  if (input.type === "profiles") {
    emails = validateEmails(input.emails);
  } else if (input.emails !== undefined) {
    throw new DomainError("invalid_share_link", "emails are only allowed for a link of type profiles", "emails");
  }
  return {
    id: input.id,
    tokenHash: input.tokenHash,
    tenantId: input.tenantId,
    marketId: input.marketId,
    type: input.type,
    emails,
    createdBy: input.createdBy,
    createdAt: input.now,
    expiresAt: input.expiresAt === undefined ? null : validateExpiresAt(input.expiresAt, input.now),
    revokedAt: null,
  };
}
