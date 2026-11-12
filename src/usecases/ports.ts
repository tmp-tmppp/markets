import type { CloudEvent } from "../domain/events.js";
import type { Market, MarketRules, MarketStatus } from "../domain/market.js";
import type { ShareLink } from "../domain/share-link.js";

// Ports: everything a use case needs from the outside world. Adapters implement them (ADR-001).

/** Who is acting and which request it is, for the events a use case writes. */
export interface Caller {
  userId: string;
  correlationId: string;
  /** The id of the request that caused the work; it becomes "causationid" of the events. */
  causationId: string;
}

/** The two roles of a tenant that may use markets. A platform admin is refused by the web layer before any use case. */
export type MarketRole = "trader" | "tenant-admin";

/** A caller of a tenant's market endpoints: the tenant and the role come only from the token. */
export interface Actor extends Caller {
  /** The tenant of the token, a UUID in lower case. */
  tenantId: string;
  role: MarketRole;
}

// Markets: the table "markets" of the tenant's own schema (migrations/tenant).

export interface MarketListQuery {
  /** Only markets with one of these statuses; never empty. */
  statuses: readonly MarketStatus[];
  /** Rows to return (the use case asks for one more than the page size). */
  limit: number;
  /** Only markets whose id is lower than this one (the last id of the previous page); null for the first page. */
  beforeId: string | null;
}

export interface MarketRepository {
  insert(market: Market): Promise<void>;
  /** With lock, the row stays locked until the end of the transaction (SELECT ... FOR UPDATE). */
  findById(id: string, options?: { lock: boolean }): Promise<Market | null>;
  /** Newest first: ordered by id descending (UUIDv7 ids grow with the creation time). */
  list(query: MarketListQuery): Promise<Market[]>;
  /**
   * Stores `market` (the result of a domain transition) only if the stored row still has the expected status and
   * version: UPDATE ... WHERE id = $1 AND status = $expected AND version = $expected (DM-19: one concurrent writer
   * wins). Returns false when no row matched, because someone else changed the market first.
   */
  update(market: Market, expected: { status: MarketStatus; version: number }): Promise<boolean>;
  /**
   * Whether an open market has a close time at or before `now` (UC-15): one index probe on the partial index of
   * migrations/tenant/003, so that a tenant with nothing due costs next to nothing. Call it outside a transaction.
   */
  hasDue(now: Date): Promise<boolean>;
  /**
   * Takes up to `limit` open markets whose close time is at or before `now`, earliest close time first, and locks them
   * until the end of the transaction: SELECT ... FOR UPDATE SKIP LOCKED, so several instances never get the same market
   * and a market another transaction holds is passed over, not waited for. The ids in `skip` (markets that failed
   * earlier in the same run) are not returned. Call it inside a transaction.
   */
  claimDue(now: Date, limit: number, skip: readonly string[]): Promise<Market[]>;
}

// Shared tables (migrations/shared): outbox, inbox, tenant registry, pending openings.

export interface OutboxMessage {
  /** Equals the id of the event; it is also the deduplication id on the broker. */
  id: string;
  aggregateId: string;
  /** NATS subject. */
  subject: string;
  type: string;
  /** The whole CloudEvent. */
  payload: CloudEvent<unknown>;
  createdAt: Date;
}

export interface OutboxRow extends OutboxMessage {
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  /**
   * Unpublished rows, oldest first, locked for this transaction. Only one instance publishes at a time, so that the
   * events of a tenant keep their order with several replicas: the claim takes a lock that is held until the end of
   * the transaction, and returns no rows when another transaction holds it. Call it inside a transaction.
   */
  claimBatch(limit: number): Promise<OutboxRow[]>;
  markPublished(id: string, at: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Deletes the rows published before `olderThan`; unpublished rows stay however old they are. Returns how many went. */
  purgePublished(olderThan: Date): Promise<number>;
}

export interface InboxEntry {
  /** One consumer per kind of event (ADR-053), for example "tenant-created". */
  consumer: string;
  eventId: string;
  eventType: string;
  processedAt: Date;
}

/** Ids of consumed events, stored in the transaction of the change they caused: a redelivery changes nothing. */
export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING: true when the entry is new, false when the event was processed before. */
  record(entry: InboxEntry): Promise<boolean>;
  /** Deletes the entries processed before `olderThan` (DM-06). Returns how many went. */
  purge(olderThan: Date): Promise<number>;
}

/** The tenants this service has a schema for. */
export interface TenantRegistry {
  /**
   * Creates the tenant's schema if it is missing, applies every tenant migration it lacks and registers the tenant.
   * Idempotent. Call it inside a transaction: when that rolls back, no schema and no registration are left behind.
   */
  provision(tenantId: string, now: Date, name?: string | null): Promise<void>;
  isRegistered(tenantId: string): Promise<boolean>;
  /** Every registered tenant, ordered by id: the automatic close (UC-15) visits each tenant's schema. */
  listTenantIds(): Promise<string[]>;
  /** The organization's display name from its TenantCreated event; null when the tenant is unknown or no name was learned. */
  displayNameOf(tenantId: string): Promise<string | null>;
}

// Share links: the table "share_links" of the shared schema (migrations/shared). A public lookup knows a token and
// nothing else, so the links of all tenants live in one table and are found by the hash of the token.

export interface ShareLinkListQuery {
  tenantId: string;
  marketId: string;
  /** Only the links this user made; null lists every link of the market. */
  createdBy: string | null;
  /** Rows to return (the use case asks for one more than the page size). */
  limit: number;
  /** Only links whose id is lower than this one; null for the first page. */
  beforeId: string | null;
}

export interface ShareLinkRepository {
  insert(link: ShareLink): Promise<void>;
  /** By the SHA-256 of the token, in any tenant. */
  findByTokenHash(tokenHash: string): Promise<ShareLink | null>;
  /** A link of this tenant; another tenant's link is null. */
  findById(tenantId: string, id: string): Promise<ShareLink | null>;
  /** Newest first: ordered by id descending (UUIDv7 ids grow with the creation time). */
  list(query: ShareLinkListQuery): Promise<ShareLink[]>;
  /** Sets revoked_at where it is still null; true when this call revoked the link, false when it was revoked before. */
  revoke(tenantId: string, id: string, at: Date): Promise<boolean>;
}

/** A market in "opening" whose funding outcome is not settled yet (DM-19 saga, table shared.pending_openings). */
export interface PendingOpening {
  tenantId: string;
  marketId: string;
  /** Of the request that began the opening: the MarketOpened event of a later retry carries them too. */
  correlationId: string;
  causationId: string;
  /** Funding calls whose outcome stayed unknown. */
  attempts: number;
  nextAttemptAt: Date;
  /** An instance works on the row until this time; null when nobody does. */
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface PendingOpeningRepository {
  /**
   * Inserts the row of a market that just became "opening": attempts 0, due at `now`, leased until `leaseUntil`,
   * because the request that began the opening makes the first funding call itself. If that request dies, the lease
   * ends and the retry worker takes over. Call it in the transaction that changes the market's status.
   */
  add(row: { tenantId: string; marketId: string; correlationId: string; causationId: string; now: Date; leaseUntil: Date }): Promise<void>;
  /** The opening settled (open, or back to draft): the row goes. No error when it is gone already. */
  remove(tenantId: string, marketId: string): Promise<void>;
  /** The outcome is still unknown: attempts + 1, due at `retryAt`, the lease cleared, the error kept. */
  reschedule(tenantId: string, marketId: string, retryAt: Date, error: string): Promise<void>;
  /**
   * Takes up to `limit` rows that are due at `now` and not leased at `now` (no lease, or one that has ended), the
   * earliest due first, and leases them until `leaseUntil`, all in one statement (FOR UPDATE SKIP LOCKED): several
   * instances never get the same row. Call it outside a transaction.
   */
  claim(limit: number, leaseUntil: Date, now: Date): Promise<PendingOpening[]>;
}

export interface SharedRepositories {
  outbox: OutboxRepository;
  inbox: InboxRepository;
  tenants: TenantRegistry;
  pendingOpenings: PendingOpeningRepository;
  shareLinks: ShareLinkRepository;
}

/** The repositories of one tenant: its own schema's tables and the shared ones, in the same transaction. */
export interface TenantRepositories extends SharedRepositories {
  markets: MarketRepository;
}

export interface TenantStore {
  readonly tenantId: string;
  /** Repositories outside a transaction: each call is on its own. */
  readonly repositories: TenantRepositories;
  /** Everything the callback does through the given repositories commits together or not at all. */
  transaction<T>(work: (repositories: TenantRepositories) => Promise<T>): Promise<T>;
}

export interface Store {
  /** The shared tables outside a transaction: each call is on its own. */
  readonly repositories: SharedRepositories;
  /** A transaction on the shared tables (outbox relay, TenantCreated inbox). */
  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T>;
  /**
   * The store of a registered tenant, or null while the tenant has no schema yet (its TenantCreated event has not been
   * processed): the use case then answers TenantNotReady (503). An adapter may remember registered tenants, because a
   * registration is never undone.
   */
  forTenant(tenantId: string): Promise<TenantStore | null>;
  /** Cheap check that the store answers (readiness). */
  ping(): Promise<void>;
}

// The funding call to trading (contracts/outgoing/trading-market-funding.openapi.yaml).

export interface FundingRequest {
  marketId: string;
  tenantId: string;
  /** The creator of the market, whose credits fund it. */
  creatorId: string;
  /** Credits, the market's fundingAmount. */
  amount: number;
}

/**
 * Every outcome of one funding call, after the client's own retries. The client never throws: each failure is one
 * of these, and the use case decides what it means for the market.
 */
export type FundingResult =
  /** 200 or 201: the credits were taken (a repeat with the same Idempotency-Key answers the same). */
  | { kind: "funded" }
  /** 409 with the problem code insufficient_credits: nothing was taken. */
  | { kind: "insufficient_credits" }
  /**
   * Another 4xx (400, 401, 403, 404, 409 with another code, 422): trading refused the request, nothing was taken by it.
   * On a retry FinishOpening does not trust a 401 or 403: it says nothing about an earlier call whose outcome was unknown.
   */
  | { kind: "rejected"; status: number; detail: string }
  /**
   * Nothing was sent by this call: the circuit is open, or no service token could be obtained. On a retry an earlier call
   * may still have funded the market, so FinishOpening keeps it opening there.
   */
  | { kind: "not_sent"; reason: string; retryAfterSeconds: number }
  /** Timeouts, network errors, 408, 429 or 5xx after the retries: trading may or may not have taken the credits. */
  | { kind: "unknown"; reason: string };

export interface FundingClient {
  /** POST /v1/internal/market-funding with the header Idempotency-Key: the same key always means the same funding. */
  fund(request: FundingRequest, idempotencyKey: string): Promise<FundingResult>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** A UUIDv7. */
  newId(): string;
}

/** The limits of new markets; they may change while the service runs (runtime configuration, ADR-037). */
export interface MarketRulesSource {
  current(): MarketRules;
}

/** Publishes one event to the broker; used by the outbox relay. */
export interface EventPublisher {
  publish(subject: string, event: CloudEvent<unknown>, messageId: string): Promise<void>;
}

export interface Logger {
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

/** What the use cases of the requests need. */
export interface UseCaseDeps {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
}

/** Makes the secret token of a share link. */
export interface ShareTokenGenerator {
  /** 32 random bytes in base64url (43 characters). */
  newToken(): string;
}

/** The share-link use cases that write. */
export interface ShareLinkDeps extends UseCaseDeps {
  tokens: ShareTokenGenerator;
}

/** The opening saga also calls trading. */
export interface OpeningDeps extends UseCaseDeps {
  funding: FundingClient;
}
