import pg from "pg";
import type { CloudEvent } from "../../domain/events.js";
import type { Market, MarketStatus, Outcome } from "../../domain/market.js";
import type { ShareLink } from "../../domain/share-link.js";
import { sharingFromStored } from "../../domain/sharing.js";
import type { LinkType } from "../../domain/sharing.js";
import { isTenantId, tenantSchemaIdentifier } from "../../domain/tenant.js";
import type {
  InboxRepository,
  Logger,
  MarketRepository,
  OutboxRepository,
  OutboxRow,
  PendingOpening,
  PendingOpeningRepository,
  SharedRepositories,
  ShareLinkRepository,
  Store,
  TenantRegistry,
  TenantRepositories,
  TenantStore,
} from "../../usecases/ports.js";
import { provisionTenantSchema } from "./migrate.js";

type Queryable = Pick<pg.Pool, "query">;

// Key of the advisory lock that lets one outbox relay claim at a time. Advisory locks of a database share one key
// space; the migration lock (migrate.ts) is 727001, so this one is the next number.
export const OUTBOX_RELAY_LOCK_KEY = 727_002;

/** Longest error text kept in a row: an error message is not allowed to grow a row without limit. */
const MAX_ERROR_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

// Shared tables are always written with the prefix "shared."; the tables of a tenant with the quoted schema name that
// tenantSchemaIdentifier (domain/tenant.ts) makes from the validated tenant id, never from request text.

// ---- Outbox ----------------------------------------------------------------------------------------------------------

interface OutboxDbRow {
  id: string;
  aggregate_id: string;
  subject: string;
  type: string;
  payload: CloudEvent<unknown>;
  created_at: Date;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

const toOutboxRow = (row: OutboxDbRow): OutboxRow => ({
  id: row.id,
  aggregateId: row.aggregate_id,
  subject: row.subject,
  type: row.type,
  payload: row.payload,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  attempts: row.attempts,
  lastError: row.last_error,
});

function outboxRepository(db: Queryable): OutboxRepository {
  return {
    async add(message) {
      await db.query(
        `INSERT INTO shared.outbox (id, aggregate_id, subject, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [message.id, message.aggregateId, message.subject, message.type, JSON.stringify(message.payload), message.createdAt],
      );
    },
    async claimBatch(limit) {
      // One relay at a time: the batches of the instances must not be published in parallel, or the events of a
      // tenant could arrive out of order. The lock belongs to the transaction (it ends with COMMIT or ROLLBACK,
      // also when the connection breaks), so a relay that crashes cannot keep it. Outside a transaction it would
      // be released at once; the relay always claims inside one.
      const lock = await db.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS locked", [OUTBOX_RELAY_LOCK_KEY]);
      if (lock.rows[0]?.locked !== true) return [];
      const result = await db.query<OutboxDbRow>(
        `SELECT * FROM shared.outbox
          WHERE published_at IS NULL
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      return result.rows.map(toOutboxRow);
    },
    async markPublished(id, at) {
      await db.query("UPDATE shared.outbox SET published_at = $2 WHERE id = $1", [id, at]);
    },
    async markFailed(id, error) {
      await db.query("UPDATE shared.outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1", [id, error.slice(0, MAX_ERROR_LENGTH)]);
    },
    async purgePublished(olderThan) {
      const result = await db.query("DELETE FROM shared.outbox WHERE published_at IS NOT NULL AND published_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- Inbox -----------------------------------------------------------------------------------------------------------

function inboxRepository(db: Queryable): InboxRepository {
  return {
    async record(entry) {
      const result = await db.query(
        "INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, $3, $4) ON CONFLICT (consumer, event_id) DO NOTHING",
        [entry.consumer, entry.eventId, entry.eventType, entry.processedAt],
      );
      return result.rowCount === 1;
    },
    async purge(olderThan) {
      const result = await db.query("DELETE FROM shared.inbox WHERE processed_at < $1", [olderThan]);
      return result.rowCount ?? 0;
    },
  };
}

// ---- Tenant registry -------------------------------------------------------------------------------------------------

/**
 * `provision` needs a connection that is inside a transaction (`inTransaction`): its advisory lock and its DDL belong to
 * that transaction. Over the pool it refuses, because each statement would run on another connection.
 */
function tenantRegistry(db: Queryable, inTransaction: boolean, logger: Logger): TenantRegistry {
  return {
    async provision(tenantId, now, name) {
      if (!inTransaction) throw new Error("A tenant schema is provisioned inside a transaction only");
      await provisionTenantSchema(db, tenantId, now, logger, undefined, name ?? null);
    },
    async isRegistered(tenantId) {
      if (!isTenantId(tenantId)) return false;
      const result = await db.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
      return (result.rowCount ?? 0) > 0;
    },
    async listTenantIds() {
      const result = await db.query<{ tenant_id: string }>("SELECT tenant_id FROM shared.tenant_registry ORDER BY tenant_id");
      return result.rows.map((row) => row.tenant_id);
    },
    async displayNameOf(tenantId) {
      if (!isTenantId(tenantId)) return null;
      const result = await db.query<{ name: string | null }>("SELECT name FROM shared.tenant_registry WHERE tenant_id = $1", [tenantId.toLowerCase()]);
      return result.rows[0]?.name ?? null;
    },
  };
}

// ---- Share links -----------------------------------------------------------------------------------------------------

interface ShareLinkDbRow {
  id: string;
  token_hash: string;
  tenant_id: string;
  market_id: string;
  type: LinkType;
  emails: string[];
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const SHARE_LINK_COLUMNS = "id, token_hash, tenant_id, market_id, type, emails, created_by, created_at, expires_at, revoked_at";

const toShareLink = (row: ShareLinkDbRow): ShareLink => ({
  id: row.id,
  tokenHash: row.token_hash,
  tenantId: row.tenant_id,
  marketId: row.market_id,
  type: row.type,
  emails: row.emails,
  createdBy: row.created_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

function shareLinkRepository(db: Queryable): ShareLinkRepository {
  return {
    async insert(link) {
      await db.query(`INSERT INTO shared.share_links (${SHARE_LINK_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10)`, [
        link.id,
        link.tokenHash,
        link.tenantId,
        link.marketId,
        link.type,
        [...link.emails],
        link.createdBy,
        link.createdAt,
        link.expiresAt,
        link.revokedAt,
      ]);
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query<ShareLinkDbRow>(`SELECT ${SHARE_LINK_COLUMNS} FROM shared.share_links WHERE token_hash = $1`, [tokenHash]);
      const row = result.rows[0];
      return row ? toShareLink(row) : null;
    },
    async findById(tenantId, id) {
      if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(tenantId)) return null;
      const result = await db.query<ShareLinkDbRow>(`SELECT ${SHARE_LINK_COLUMNS} FROM shared.share_links WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      const row = result.rows[0];
      return row ? toShareLink(row) : null;
    },
    async list(query) {
      const params: unknown[] = [query.tenantId, query.marketId, query.limit];
      let filters = "";
      if (query.createdBy !== null) {
        params.push(query.createdBy);
        filters += ` AND created_by = $${params.length}`;
      }
      if (query.beforeId !== null) {
        if (!UUID_PATTERN.test(query.beforeId)) return [];
        params.push(query.beforeId);
        filters += ` AND id < $${params.length}`;
      }
      const result = await db.query<ShareLinkDbRow>(
        `SELECT ${SHARE_LINK_COLUMNS} FROM shared.share_links WHERE tenant_id = $1 AND market_id = $2${filters} ORDER BY id DESC LIMIT $3`,
        params,
      );
      return result.rows.map(toShareLink);
    },
    async revoke(tenantId, id, at) {
      const result = await db.query("UPDATE shared.share_links SET revoked_at = $3 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL", [tenantId, id, at]);
      return result.rowCount === 1;
    },
  };
}

// ---- Pending openings ------------------------------------------------------------------------------------------------

interface PendingOpeningDbRow {
  tenant_id: string;
  market_id: string;
  correlation_id: string;
  causation_id: string;
  attempts: number;
  next_attempt_at: Date;
  lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
}

const toPendingOpening = (row: PendingOpeningDbRow): PendingOpening => ({
  tenantId: row.tenant_id,
  marketId: row.market_id,
  correlationId: row.correlation_id,
  causationId: row.causation_id,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  leaseUntil: row.lease_until,
  lastError: row.last_error,
  createdAt: row.created_at,
});

function pendingOpeningRepository(db: Queryable): PendingOpeningRepository {
  return {
    async add(row) {
      // A plain INSERT: the row of a market exists only while it is "opening", so a second row for the same market is
      // a bug that must roll the transaction back, not something to paper over.
      await db.query(
        `INSERT INTO shared.pending_openings
           (tenant_id, market_id, correlation_id, causation_id, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, NULL, $5, $5)`,
        [row.tenantId, row.marketId, row.correlationId, row.causationId, row.now, row.leaseUntil],
      );
    },
    async remove(tenantId, marketId) {
      await db.query("DELETE FROM shared.pending_openings WHERE tenant_id = $1 AND market_id = $2", [tenantId, marketId]);
    },
    async reschedule(tenantId, marketId, retryAt, error) {
      // The port carries no clock, so updated_at is the database's time; it is informational only.
      await db.query(
        `UPDATE shared.pending_openings
            SET attempts = attempts + 1, next_attempt_at = $3, lease_until = NULL, last_error = $4, updated_at = now()
          WHERE tenant_id = $1 AND market_id = $2`,
        [tenantId, marketId, retryAt, error.slice(0, MAX_ERROR_LENGTH)],
      );
    },
    async claim(limit, leaseUntil, now) {
      // One statement: the inner SELECT locks the rows that are due and not leased and skips rows that another worker
      // has locked at the same moment; the UPDATE sets their lease. A row that another claim leased and committed
      // between this statement's snapshot and its row lock fails the WHERE again when PostgreSQL re-checks the locked
      // row, so two workers never get the same row. The due time is not moved: it keeps the order of the claims.
      const result = await db.query<PendingOpeningDbRow>(
        `UPDATE shared.pending_openings
            SET lease_until = $2, updated_at = $3
          WHERE (tenant_id, market_id) IN (
                  SELECT tenant_id, market_id FROM shared.pending_openings
                   WHERE next_attempt_at <= $3 AND (lease_until IS NULL OR lease_until <= $3)
                   ORDER BY next_attempt_at, tenant_id, market_id
                   LIMIT $1
                   FOR UPDATE SKIP LOCKED)
        RETURNING tenant_id, market_id, correlation_id, causation_id, attempts, next_attempt_at, lease_until, last_error, created_at`,
        [limit, leaseUntil, now],
      );
      return result.rows.map(toPendingOpening).sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
    },
  };
}

// ---- Markets ---------------------------------------------------------------------------------------------------------

interface MarketDbRow {
  id: string;
  tenant_id: string;
  question: string;
  description: string;
  close_time: Date;
  /** numeric comes back from pg as a string. */
  starting_price: string;
  funding_amount: number;
  status: MarketStatus;
  outcome: Outcome | null;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  opened_at: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  sharing_who: string;
  sharing_link_types: string[];
}

const MARKET_COLUMNS =
  "id, tenant_id, question, description, close_time, starting_price, funding_amount, status, outcome, version, created_by, created_at, updated_at, opened_at, closed_at, closed_by, resolved_at, resolved_by, sharing_who, sharing_link_types";

const toMarket = (row: MarketDbRow): Market => ({
  id: row.id,
  tenantId: row.tenant_id,
  question: row.question,
  description: row.description,
  closeTime: row.close_time,
  startingPrice: Number(row.starting_price),
  fundingAmount: row.funding_amount,
  status: row.status,
  outcome: row.outcome,
  version: row.version,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  closedBy: row.closed_by,
  resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by,
  sharing: sharingFromStored(row.sharing_who, row.sharing_link_types),
});

/** The markets of one tenant, in that tenant's schema. The schema name is derived from the tenant id and nothing else. */
function marketRepository(db: Queryable, tenantId: string): MarketRepository {
  const table = `${tenantSchemaIdentifier(tenantId)}.markets`;
  return {
    async insert(market) {
      await db.query(
        `INSERT INTO ${table} (${MARKET_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::text[])`,
        [
          market.id,
          market.tenantId,
          market.question,
          market.description,
          market.closeTime,
          market.startingPrice,
          market.fundingAmount,
          market.status,
          market.outcome,
          market.version,
          market.createdBy,
          market.createdAt,
          market.updatedAt,
          market.openedAt,
          market.closedAt,
          market.closedBy,
          market.resolvedAt,
          market.resolvedBy,
          market.sharing.whoMayShare,
          [...market.sharing.linkTypes],
        ],
      );
    },
    async findById(id, options) {
      // A value that is no UUID cannot be an id: answer "not found" instead of letting the driver raise a type error.
      if (!UUID_PATTERN.test(id)) return null;
      const result = await db.query<MarketDbRow>(`SELECT ${MARKET_COLUMNS} FROM ${table} WHERE id = $1${options?.lock === true ? " FOR UPDATE" : ""}`, [id]);
      const row = result.rows[0];
      return row ? toMarket(row) : null;
    },
    async list(query) {
      const params: unknown[] = [[...query.statuses], query.limit];
      let cursor = "";
      if (query.beforeId !== null) {
        if (!UUID_PATTERN.test(query.beforeId)) return [];
        params.push(query.beforeId);
        cursor = " AND id < $3";
      }
      const result = await db.query<MarketDbRow>(
        `SELECT ${MARKET_COLUMNS} FROM ${table} WHERE status = ANY($1::text[])${cursor} ORDER BY id DESC LIMIT $2`,
        params,
      );
      return result.rows.map(toMarket);
    },
    async update(market, expected) {
      // The optimistic check of DM-19 and DM-04: the row changes only when it still has the status and the version the
      // caller read, so of two concurrent writers exactly one wins.
      const result = await db.query(
        `UPDATE ${table}
            SET status = $4, outcome = $5, version = $6, updated_at = $7,
                opened_at = $8, closed_at = $9, closed_by = $10, resolved_at = $11, resolved_by = $12
          WHERE id = $1 AND status = $2 AND version = $3`,
        [
          market.id,
          expected.status,
          expected.version,
          market.status,
          market.outcome,
          market.version,
          market.updatedAt,
          market.openedAt,
          market.closedAt,
          market.closedBy,
          market.resolvedAt,
          market.resolvedBy,
        ],
      );
      return result.rowCount === 1;
    },
    async hasDue(now) {
      // One probe on markets_open_close_time_idx (migrations/tenant/003): the index holds open markets only.
      const result = await db.query(`SELECT 1 FROM ${table} WHERE status = 'open' AND close_time <= $1 LIMIT 1`, [now]);
      return (result.rowCount ?? 0) > 0;
    },
    async claimDue(now, limit, skip) {
      // FOR UPDATE SKIP LOCKED: a market that another instance is closing right now is passed over, so two instances
      // never close the same market. The rows stay locked until the end of the caller's transaction. The skip list holds
      // the service's own market ids; a value that is no UUID cannot be an id and is dropped before it reaches the cast.
      const result = await db.query<MarketDbRow>(
        `SELECT ${MARKET_COLUMNS} FROM ${table}
          WHERE status = 'open' AND close_time <= $1 AND NOT (id = ANY($3::uuid[]))
          ORDER BY close_time, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit, skip.filter((id) => UUID_PATTERN.test(id))],
      );
      return result.rows.map(toMarket);
    },
  };
}

// ---- The store -------------------------------------------------------------------------------------------------------

/** The shared repositories over one connection (inside a transaction) or over the pool (each call on its own). */
export function sharedRepositoriesOver(db: Queryable, inTransaction: boolean, logger: Logger): SharedRepositories {
  return {
    outbox: outboxRepository(db),
    inbox: inboxRepository(db),
    tenants: tenantRegistry(db, inTransaction, logger),
    pendingOpenings: pendingOpeningRepository(db),
    shareLinks: shareLinkRepository(db),
  };
}

function tenantRepositoriesOver(db: Queryable, inTransaction: boolean, tenantId: string, logger: Logger): TenantRepositories {
  return { ...sharedRepositoriesOver(db, inTransaction, logger), markets: marketRepository(db, tenantId) };
}

export class PostgresStore implements Store {
  readonly repositories: SharedRepositories;
  /** Tenants known to be registered: a registration is never undone, so a positive answer is kept. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger = silent,
  ) {
    this.repositories = sharedRepositoriesOver(pool, false, logger);
  }

  /** One transaction on one connection: BEGIN, the work, COMMIT; ROLLBACK when the work throws. */
  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction((client) => work(sharedRepositoriesOver(client, true, this.logger)));
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    if (!isTenantId(tenantId)) return null;
    const id = tenantId.toLowerCase();
    if (!this.registered.has(id)) {
      if (!(await this.repositories.tenants.isRegistered(id))) return null;
      this.registered.add(id);
    }
    const store: TenantStore = {
      tenantId: id,
      repositories: tenantRepositoriesOver(this.pool, false, id, this.logger),
      transaction: (work) => this.inTransaction((client) => work(tenantRepositoriesOver(client, true, id, this.logger))),
    };
    return store;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}

/**
 * The connection pool. An idle connection that the server drops raises "error" on the pool; without a listener that
 * would end the process, so it is logged (when a logger is given) and the pool opens a new connection when needed.
 */
export function createPool(connectionString: string, max: number, logger: Logger = silent): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000, idleTimeoutMillis: 30_000 });
  pool.on("error", (error) => {
    logger.warn({ err: error }, "An idle database connection failed");
  });
  return pool;
}
