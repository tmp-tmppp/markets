import { DomainError } from "../domain/errors.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28):
// validation 400, forbidden 403, not_found 404, conflict 409, bad_gateway 502, unavailable 503 with Retry-After.
// The problem type of an answer is urn:chance:problem:<code with dashes>, for example ...:insufficient-credits.
export type UseCaseErrorKind = "validation" | "forbidden" | "not_found" | "conflict" | "bad_gateway" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "insufficient_credits". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  /** Members the problem details carry besides the standard ones (RFC 9457 extension members); empty for most errors. */
  get extensions(): Readonly<Record<string, unknown>> {
    return {};
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid") {
    super("validation", "validation_failed", message, fields);
  }
}

/** The caller's role does not allow the action (a trader writing, an admin opening someone else's market). */
export class Forbidden extends UseCaseError {
  constructor(message: string) {
    super("forbidden", "forbidden", message);
  }
}

/** No such market in the caller's tenant; also the answer for a market a trader may not see yet. */
export class NotFound extends UseCaseError {
  constructor(message = "No such market") {
    super("not_found", "not_found", message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string) {
    super("conflict", code, message);
  }
}

/** What a caller who may not see a share link's market can do about it (contracts/openapi.yaml, `NextAction`). */
export type NextAction = "sign_in" | "join" | "switch_organization" | "trade";

/**
 * The share link is valid but not for this caller. The problem names the organization's display name and what the caller
 * may do next, and nothing else of the link or the market.
 */
export class ShareLinkNotPermitted extends UseCaseError {
  constructor(
    readonly organizationName: string | null,
    readonly next: readonly NextAction[],
  ) {
    super("forbidden", "share_link_not_permitted", "This share link is not for you");
  }

  override get extensions(): Readonly<Record<string, unknown>> {
    return { organization: { name: this.organizationName }, next: [...this.next] };
  }
}

/** The market is not in a state that allows the action (code invalid_state). */
export function invalidState(message: string): Conflict {
  return new Conflict("invalid_state", message);
}

/** Trading answered 409 insufficient credits; the market is back in draft. */
export class InsufficientCredits extends UseCaseError {
  constructor(message = "The creator does not have enough credits to fund the market; it is back in draft") {
    super("conflict", "insufficient_credits", message);
  }
}

/** Trading refused the funding request with another 4xx: nothing was funded, the market is back in draft (HTTP 502). */
export class FundingRejected extends UseCaseError {
  constructor(
    readonly upstreamStatus: number,
    message = "Trading rejected the funding request; the market is back in draft",
  ) {
    super("bad_gateway", "funding_rejected", message);
  }
}

/** Worth retrying after `retryAfterSeconds` (HTTP 503 with Retry-After). */
export class Unavailable extends UseCaseError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super("unavailable", code, message);
  }
}

/** Trading could not be called and nothing was sent (open circuit); the market is back in draft. */
export class TradingUnavailable extends Unavailable {
  constructor(retryAfterSeconds: number) {
    super("trading_unavailable", "Trading is unavailable and the funding was not sent; the market is back in draft", retryAfterSeconds);
  }
}

/** Seconds a client waits when its tenant's schema does not exist yet. */
export const TENANT_NOT_READY_RETRY_AFTER_SECONDS = 5;

/** The tenant's TenantCreated event has not been processed yet, so it has no schema (plan section 9). */
export class TenantNotReady extends Unavailable {
  constructor(retryAfterSeconds = TENANT_NOT_READY_RETRY_AFTER_SECONDS) {
    super("tenant_not_ready", "The tenant is being set up in this service; try again shortly", retryAfterSeconds);
  }
}

/** Turns a rule violation of the domain into the use-case error a caller can act on. */
export function fromDomainError(error: DomainError): UseCaseError {
  switch (error.code) {
    case "invalid_question":
    case "invalid_description":
    case "invalid_close_time":
    case "invalid_starting_price":
    case "invalid_funding_amount":
    case "invalid_outcome":
    case "invalid_tenant_id":
    case "invalid_sharing":
    case "invalid_share_link":
      return new ValidationFailed([{ field: error.field ?? "request", message: error.message }]);
    case "invalid_transition":
      return invalidState(error.message);
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) throw fromDomainError(error);
    throw error;
  }
}
