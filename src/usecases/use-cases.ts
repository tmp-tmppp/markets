import type { Market, MarketStatus } from "../domain/market.js";
import type { ShareLink, ShareLinkStatus } from "../domain/share-link.js";
import type { LinkType } from "../domain/sharing.js";
import type { TenantCreatedNotice } from "../domain/tenant.js";
import type { NextAction } from "./errors.js";
import type { Actor, MarketRole, PendingOpening } from "./ports.js";
import type { PageInput, PageOf } from "./support.js";

// The use cases as the web layer, the opening-retry worker and the TenantCreated consumer see them. Each one is a
// class in its own file (src/usecases/<name>.ts) that implements the interface below; the composition root wires the
// classes, and the callers depend on these interfaces only. Errors are those of ./errors.ts.

export interface CreateMarketInput {
  actor: Actor;
  question: string;
  description?: string | undefined;
  /** RFC 3339 date-time with a time zone. */
  closeTime: string;
  startingPrice: number;
  fundingAmount: number;
  /** The sharing policy as received; undefined takes the default (members share with members). */
  sharing?: unknown;
}

/** Tenant admin only. Stores a draft market, version 1. Errors: Forbidden, ValidationFailed, TenantNotReady. */
export interface CreateMarketUseCase {
  execute(input: CreateMarketInput): Promise<Market>;
}

export interface ListMarketsInput extends PageInput {
  actor: Actor;
  status?: MarketStatus | undefined;
}

/** Newest first. Traders see open, closed and resolved only. Errors: Forbidden (a trader asking draft or opening), ValidationFailed, TenantNotReady. */
export interface ListMarketsUseCase {
  execute(input: ListMarketsInput): Promise<PageOf<Market>>;
}

export interface MarketInput {
  actor: Actor;
  marketId: string;
}

/** Errors: NotFound (also a draft or opening market for a trader), TenantNotReady. */
export interface GetMarketUseCase {
  execute(input: MarketInput): Promise<Market>;
}

export interface OpenMarketResult {
  market: Market;
  /** "open": funded (HTTP 200). "opening": the funding outcome is unknown and retried in the background (HTTP 202). */
  state: "open" | "opening";
}

/**
 * The opening saga (DM-19), tenant admin and creator only. A market that is already opening answers "opening" without a
 * new funding call. Errors: Forbidden, NotFound, Conflict invalid_state, InsufficientCredits, FundingRejected,
 * TradingUnavailable, TenantNotReady.
 */
export interface OpenMarketUseCase {
  execute(input: MarketInput): Promise<OpenMarketResult>;
}

/** open -> closed, any tenant admin. Errors: Forbidden, NotFound, Conflict invalid_state, TenantNotReady. */
export interface CloseMarketUseCase {
  execute(input: MarketInput): Promise<Market>;
}

export interface CloseDueMarketsInput {
  /** The tenant whose due markets are closed. */
  tenantId: string;
  /** The most markets this call closes (or fails on); more may be due. */
  limit: number;
  /** Asked before each market; true ends the call (the market in progress is finished). The worker sets it at shutdown. */
  shouldStop?: () => boolean;
}

export interface CloseDueMarketsResult {
  /** Markets closed by this call. */
  closed: number;
  /** Markets that failed and stay open until the next run. */
  failed: number;
  /**
   * The limit was reached by closing markets, so more may be due and another call is worthwhile at once. False when
   * any market of the call failed: a failing market is retried at the next interval, not in a loop.
   */
  more: boolean;
}

/**
 * UC-15, the automatic close: the open markets of one tenant whose close time has passed become closed, closedBy is
 * "system:auto-close", each in its own transaction with its MarketClosed event (the same step as the admin's close).
 * Never throws for one market; throws when the tenant's markets cannot be read at all.
 */
export interface CloseDueMarketsUseCase {
  execute(input: CloseDueMarketsInput): Promise<CloseDueMarketsResult>;
}

export interface ResolveMarketInput extends MarketInput {
  /** "YES" or "NO"; the domain checks it again. */
  outcome: string;
}

/** closed -> resolved, any tenant admin. Errors: Forbidden, NotFound, Conflict invalid_state, ValidationFailed, TenantNotReady. */
export interface ResolveMarketUseCase {
  execute(input: ResolveMarketInput): Promise<Market>;
}

export interface FinishOpeningInput {
  tenantId: string;
  marketId: string;
  correlationId: string;
  causationId: string;
  /** Unknown outcomes so far: 0 from the request, the row's attempts from the worker. */
  attempts: number;
  /**
   * True only for the funding call of the request that has just written the pending row (OpenMarket): no earlier call of
   * this opening exists, so "nothing was sent" proves that nothing was taken. False for the retry worker (RetryOpening),
   * whose row may follow a call whose answer was lost, also when the row's attempts are 0 (the request died mid-call).
   */
  firstCall: boolean;
}

/** What one funding call did to a market in "opening". Never thrown: OpenMarket turns it into the HTTP answer. */
export type FinishOpeningOutcome =
  | { kind: "opened"; market: Market }
  | { kind: "insufficient_credits"; market: Market }
  | { kind: "rejected"; market: Market; status: number }
  | { kind: "not_sent"; market: Market; retryAfterSeconds: number }
  /** Still opening; the pending row was rescheduled. */
  | { kind: "unknown"; market: Market }
  /** The market was not opening any more (another call settled it first); its pending row, if any, was removed. */
  | { kind: "settled_before"; market: Market }
  /** The market or its tenant no longer exists; its pending row was removed. */
  | { kind: "missing" };

/** One funding call and its transaction B (saga steps 2 and 3); shared by OpenMarket and RetryOpening. */
export interface FinishOpeningUseCase {
  execute(input: FinishOpeningInput): Promise<FinishOpeningOutcome>;
}

/** The step of the opening-retry worker: FinishOpening for one claimed row of shared.pending_openings. */
export interface RetryOpeningUseCase {
  execute(pending: PendingOpening): Promise<FinishOpeningOutcome>;
}

/** "duplicate": the event id was in the inbox already, nothing changed. */
export type ProvisionTenantResult = "provisioned" | "duplicate";

/**
 * TenantCreated: in one transaction, record the event in the inbox (a duplicate commits and changes nothing), create
 * and migrate the tenant's schema and register the tenant.
 */
export interface ProvisionTenantUseCase {
  execute(notice: TenantCreatedNotice): Promise<ProvisionTenantResult>;
}

// Share links: contracts/openapi.yaml, tag Sharing.

/** A link as the API shows it: the stored fields without the token hash, and its status at the time of the call. */
export type ShareLinkView = Omit<ShareLink, "tokenHash"> & { status: ShareLinkStatus };

export interface CreateShareLinkInput {
  actor: Actor;
  marketId: string;
  type: LinkType;
  /** As received; the domain checks it (1 to 50 valid addresses for `profiles`, none for the other types). */
  emails?: unknown;
  /** As received (RFC 3339 text); the domain checks it. */
  expiresAt?: unknown;
}

export interface CreatedShareLink {
  link: ShareLinkView;
  /** The only time the token exists in clear text; the store keeps its SHA-256. */
  token: string;
}

/**
 * Makes a share link when the market's sharing policy allows this caller and this type. Errors: NotFound (also a market
 * the caller may not see), Forbidden, Conflict invalid_state (draft or opening market), ValidationFailed, TenantNotReady.
 */
export interface CreateShareLinkUseCase {
  execute(input: CreateShareLinkInput): Promise<CreatedShareLink>;
}

export interface ListShareLinksInput extends PageInput {
  actor: Actor;
  marketId: string;
}

/** Tenant admins see every link of the market, traders their own. Errors: NotFound, ValidationFailed, TenantNotReady. */
export interface ListShareLinksUseCase {
  execute(input: ListShareLinksInput): Promise<PageOf<ShareLinkView>>;
}

export interface RevokeShareLinkInput {
  actor: Actor;
  marketId: string;
  linkId: string;
}

/** The creator or a tenant admin; a repeat changes nothing. Errors: NotFound (also another trader's link), TenantNotReady. */
export interface RevokeShareLinkUseCase {
  execute(input: RevokeShareLinkInput): Promise<void>;
}

/** Who asks the public lookup, as far as the token tells; null is an anonymous caller. */
export interface LookupViewer {
  userId: string;
  /** The organization of the token (a tenant id in lower case, or the alias as sent); null when the token has none. */
  tenantId: string | null;
  /** The tenant role of the token; null for none, and for a platform admin (who sees no tenant's data). */
  role: MarketRole | null;
  email: string | null;
  emailVerified: boolean;
}

export interface LookupSharedMarketInput {
  token: string;
  viewer: LookupViewer | null;
}

export interface SharedMarketLookup {
  linkType: LinkType;
  market: { id: string; question: string; status: MarketStatus; closeTime: Date };
  organization: { alias: string; name: string | null };
  next: NextAction[];
}

/**
 * Public. One NotFound for an unknown, expired or revoked token and for a market that is no longer visible; for a caller
 * the link does not admit, ShareLinkNotPermitted (the organization's display name and what to do next, nothing else).
 */
export interface LookupSharedMarketUseCase {
  execute(input: LookupSharedMarketInput): Promise<SharedMarketLookup>;
}

export interface AdmitShareLinkInput {
  token: string;
  userEmail: string | null;
  emailVerified: boolean;
}

export interface ShareLinkAdmission {
  decision: "join" | "members_only" | "denied";
  linkType: LinkType;
  tenantId: string;
  marketId: string;
}

/** Internal, for the service `tenants`. Changes nothing. Errors: NotFound (unknown, expired, revoked). */
export interface AdmitShareLinkUseCase {
  execute(input: AdmitShareLinkInput): Promise<ShareLinkAdmission>;
}

/** What the web layer needs of the share links (src/web/context.ts). */
export interface ShareLinkUseCases {
  createShareLink: CreateShareLinkUseCase;
  listShareLinks: ListShareLinksUseCase;
  revokeShareLink: RevokeShareLinkUseCase;
  lookupSharedMarket: LookupSharedMarketUseCase;
  admitShareLink: AdmitShareLinkUseCase;
}

/** What the web layer needs (src/web/context.ts). */
export interface MarketUseCases {
  createMarket: CreateMarketUseCase;
  listMarkets: ListMarketsUseCase;
  getMarket: GetMarketUseCase;
  openMarket: OpenMarketUseCase;
  closeMarket: CloseMarketUseCase;
  resolveMarket: ResolveMarketUseCase;
}
