import { isDueForClose } from "../../domain/market.js";
import type { Market } from "../../domain/market.js";
import type { ShareLink } from "../../domain/share-link.js";
import type {
  InboxEntry,
  Logger,
  MarketRepository,
  OutboxRow,
  PendingOpening,
  SharedRepositories,
  Store,
  TenantRepositories,
  TenantStore,
} from "../../usecases/ports.js";

/** Everything the store holds, as the PostgreSQL tables would: the tenant registry, the markets and the shared tables. */
interface State {
  tenants: string[];
  /** Display names from TenantCreated, by tenant id (the column `name` of the registry). */
  tenantNames: Record<string, string>;
  markets: Market[];
  outbox: OutboxRow[];
  inbox: InboxEntry[];
  pendingOpenings: PendingOpening[];
  shareLinks: ShareLink[];
}

/** A deep copy of the stored data, for assertions in tests. */
export interface MemorySnapshot {
  tenants: string[];
  tenantNames: Record<string, string>;
  markets: Market[];
  outbox: OutboxRow[];
  inbox: InboxEntry[];
  pendingOpenings: PendingOpening[];
  shareLinks: ShareLink[];
}

/** How a repository reaches the data and runs one operation: on the live data (queued) or on a transaction's draft. */
interface Access {
  state: () => State;
  run: <T>(operation: () => T) => Promise<T>;
}

const emptyState = (): State => ({ tenants: [], tenantNames: {}, markets: [], outbox: [], inbox: [], pendingOpenings: [], shareLinks: [] });

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sharedRepositories({ state, run }: Access): SharedRepositories {
  return {
    outbox: {
      add: (message) =>
        run(() => {
          state().outbox.push({ ...message, publishedAt: null, attempts: 0, lastError: null });
        }),
      claimBatch: (limit) =>
        run(() =>
          state()
            .outbox.filter((row) => row.publishedAt === null)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit)
            .map((row) => structuredClone(row)),
        ),
      markPublished: (id, at) =>
        run(() => {
          const row = state().outbox.find((candidate) => candidate.id === id);
          if (row) row.publishedAt = at;
        }),
      markFailed: (id, error) =>
        run(() => {
          const row = state().outbox.find((candidate) => candidate.id === id);
          if (row) {
            row.attempts += 1;
            row.lastError = error;
          }
        }),
      purgePublished: (olderThan) =>
        run(() => {
          const rows = state().outbox;
          const kept = rows.filter((row) => row.publishedAt === null || row.publishedAt.getTime() >= olderThan.getTime());
          const purged = rows.length - kept.length;
          rows.splice(0, rows.length, ...kept);
          return purged;
        }),
    },
    inbox: {
      // INSERT ... ON CONFLICT DO NOTHING: the primary key is (consumer, event id).
      record: (entry) =>
        run(() => {
          const rows = state().inbox;
          if (rows.some((row) => row.consumer === entry.consumer && row.eventId === entry.eventId)) return false;
          rows.push({ ...entry });
          return true;
        }),
      purge: (olderThan) =>
        run(() => {
          const rows = state().inbox;
          const kept = rows.filter((row) => row.processedAt.getTime() >= olderThan.getTime());
          const purged = rows.length - kept.length;
          rows.splice(0, rows.length, ...kept);
          return purged;
        }),
    },
    tenants: {
      // A name that is given replaces the stored one; no name keeps what is there (COALESCE in the SQL).
      provision: (tenantId, _now, name) =>
        run(() => {
          const registered = state().tenants;
          if (!registered.includes(tenantId)) registered.push(tenantId);
          if (name) state().tenantNames[tenantId] = name;
        }),
      isRegistered: (tenantId) => run(() => state().tenants.includes(tenantId)),
      listTenantIds: () => run(() => [...state().tenants].sort(compare)),
      displayNameOf: (tenantId) => run(() => state().tenantNames[tenantId] ?? null),
    },
    // The table has the unique token hash, the foreign key to the tenant registry and the checks of the type and the e-mails.
    shareLinks: {
      insert: (link) =>
        run(() => {
          const rows = state().shareLinks;
          if (!state().tenants.includes(link.tenantId)) throw new Error(`The tenant ${link.tenantId} is not registered`);
          if (rows.some((row) => row.id === link.id || row.tokenHash === link.tokenHash)) throw new Error(`The share link ${link.id} exists already`);
          rows.push(structuredClone(link));
        }),
      findByTokenHash: (tokenHash) => run(() => structuredClone(state().shareLinks.find((row) => row.tokenHash === tokenHash) ?? null)),
      findById: (tenantId, id) => run(() => structuredClone(state().shareLinks.find((row) => row.tenantId === tenantId && row.id === id) ?? null)),
      list: (query) =>
        run(() =>
          state()
            .shareLinks.filter(
              (row) =>
                row.tenantId === query.tenantId &&
                row.marketId === query.marketId &&
                (query.createdBy === null || row.createdBy === query.createdBy) &&
                (query.beforeId === null || row.id < query.beforeId),
            )
            .sort((a, b) => compare(b.id, a.id))
            .slice(0, query.limit)
            .map((row) => structuredClone(row)),
        ),
      revoke: (tenantId, id, at) =>
        run(() => {
          const row = state().shareLinks.find((candidate) => candidate.tenantId === tenantId && candidate.id === id);
          if (!row || row.revokedAt !== null) return false;
          state().shareLinks[state().shareLinks.indexOf(row)] = { ...row, revokedAt: at };
          return true;
        }),
    },
    pendingOpenings: {
      add: (row) =>
        run(() => {
          const rows = state().pendingOpenings;
          // The table has a foreign key to the tenant registry and the primary key (tenant_id, market_id).
          if (!state().tenants.includes(row.tenantId)) throw new Error(`The tenant ${row.tenantId} is not registered`);
          if (rows.some((existing) => existing.tenantId === row.tenantId && existing.marketId === row.marketId)) {
            throw new Error(`The market ${row.marketId} has a pending opening already`);
          }
          rows.push({
            tenantId: row.tenantId,
            marketId: row.marketId,
            correlationId: row.correlationId,
            causationId: row.causationId,
            attempts: 0,
            nextAttemptAt: row.now,
            leaseUntil: row.leaseUntil,
            lastError: null,
            createdAt: row.now,
          });
        }),
      remove: (tenantId, marketId) =>
        run(() => {
          const rows = state().pendingOpenings;
          const kept = rows.filter((row) => !(row.tenantId === tenantId && row.marketId === marketId));
          rows.splice(0, rows.length, ...kept);
        }),
      reschedule: (tenantId, marketId, retryAt, error) =>
        run(() => {
          const row = state().pendingOpenings.find((candidate) => candidate.tenantId === tenantId && candidate.marketId === marketId);
          if (!row) return;
          row.attempts += 1;
          row.nextAttemptAt = retryAt;
          row.leaseUntil = null;
          row.lastError = error;
        }),
      // The same rule as the SQL: due at `now`, no lease or one that has ended, earliest due first; the claimed rows
      // are leased in the same step, so two claims never return the same row.
      claim: (limit, leaseUntil, now) =>
        run(() => {
          const due = state()
            .pendingOpenings.filter(
              (row) => row.nextAttemptAt.getTime() <= now.getTime() && (row.leaseUntil === null || row.leaseUntil.getTime() <= now.getTime()),
            )
            .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || compare(a.tenantId + a.marketId, b.tenantId + b.marketId))
            .slice(0, limit);
          for (const row of due) row.leaseUntil = leaseUntil;
          return due.map((row) => structuredClone(row));
        }),
    },
  };
}

/** The markets of one tenant: another tenant's rows are invisible, as they live in another schema in PostgreSQL. */
function marketRepository(tenantId: string, { state, run }: Access): MarketRepository {
  const own = (): Market[] => state().markets.filter((market) => market.tenantId === tenantId);
  return {
    insert: (market) =>
      run(() => {
        if (market.tenantId !== tenantId) throw new Error(`The market belongs to tenant ${market.tenantId}, not to ${tenantId}`);
        if (state().markets.some((existing) => existing.id === market.id)) throw new Error(`The market ${market.id} exists already`);
        state().markets.push(structuredClone(market));
      }),
    // Transactions run one by one, so a lock needs no extra work.
    findById: (id) => run(() => structuredClone(own().find((market) => market.id === id) ?? null)),
    list: (query) =>
      run(() =>
        own()
          .filter((market) => query.statuses.includes(market.status) && (query.beforeId === null || market.id < query.beforeId))
          .sort((a, b) => compare(b.id, a.id))
          .slice(0, query.limit)
          .map((market) => structuredClone(market)),
      ),
    update: (market, expected) =>
      run(() => {
        const rows = state().markets;
        const index = rows.findIndex(
          (row) => row.id === market.id && row.tenantId === tenantId && row.status === expected.status && row.version === expected.version,
        );
        if (index === -1) return false;
        rows[index] = structuredClone(market);
        return true;
      }),
    hasDue: (now) => run(() => own().some((market) => isDueForClose(market, now))),
    // Transactions run one by one, so no other claim can interleave and the rows need no lock.
    claimDue: (now, limit, skip) =>
      run(() =>
        own()
          .filter((market) => isDueForClose(market, now) && !skip.includes(market.id))
          .sort((a, b) => a.closeTime.getTime() - b.closeTime.getTime() || compare(a.id, b.id))
          .slice(0, limit)
          .map((market) => structuredClone(market)),
      ),
  };
}

/**
 * In-memory store for unit tests and for local runs without a database. A transaction works on a copy of the data and
 * replaces it on success, so a failed transaction leaves nothing behind; transactions run one by one, and a call
 * outside a transaction waits for the one in progress, so it never writes into data that is about to be replaced.
 * Do not call a repository method of the store itself from inside a transaction callback: use the callback's own
 * repositories, or the call waits for the transaction that waits for it.
 *
 * With `autoProvision` (local runs only, APP_ENV=local) a tenant is registered on its first use, so that local
 * development needs no TenantCreated event; the default is off, and an unknown tenant answers null (HTTP 503).
 */
export class MemoryStore implements Store {
  private state: State = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly autoProvision: boolean;
  private readonly logger: Logger | undefined;

  constructor(options: { autoProvision?: boolean; logger?: Logger } = {}) {
    this.autoProvision = options.autoProvision ?? false;
    this.logger = options.logger;
  }

  private readonly live: Access = {
    state: () => this.state,
    run: (operation) => this.exclusive(operation),
  };

  readonly repositories: SharedRepositories = sharedRepositories(this.live);

  transaction<T>(work: (repositories: SharedRepositories) => Promise<T>): Promise<T> {
    return this.inTransaction((access) => work(sharedRepositories(access)));
  }

  async forTenant(tenantId: string): Promise<TenantStore | null> {
    const registered = await this.exclusive(() => {
      if (this.state.tenants.includes(tenantId)) return true;
      if (!this.autoProvision) return false;
      this.state.tenants.push(tenantId);
      return "provisioned" as const;
    });
    if (registered === false) return null;
    if (registered === "provisioned") this.logger?.info({ tenantId }, "APP_ENV=local: tenant provisioned on first use");
    const tenantRepositories = (access: Access): TenantRepositories => ({ ...sharedRepositories(access), markets: marketRepository(tenantId, access) });
    return {
      tenantId,
      repositories: tenantRepositories(this.live),
      transaction: (work) => this.inTransaction((access) => work(tenantRepositories(access))),
    };
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** A deep copy of everything stored, for assertions in tests. */
  snapshot(): MemorySnapshot {
    return structuredClone(this.state);
  }

  private inTransaction<T>(work: (access: Access) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      // Inside a transaction an operation runs at once (the queue is already ours); a throw becomes a rejection.
      const result = await work({ state: () => draft, run: <R>(operation: () => R) => new Promise<R>((resolve) => resolve(operation())) });
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private exclusive<T>(operation: () => T): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
