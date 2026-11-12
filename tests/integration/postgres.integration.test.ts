import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeFundingClient } from "../../src/adapters/memory/fake-funding-client.js";
import { MemoryEventPublisher } from "../../src/adapters/memory/memory-publisher.js";
import { AutoCloseWorker } from "../../src/adapters/auto-close/worker.js";
import { OpeningRetryWorker } from "../../src/adapters/opening-retry/worker.js";
import { OutboxRelay } from "../../src/adapters/outbox/relay.js";
import { MIGRATIONS_DIRS, listTenantSchemas, migrateTenantSchema, provisionTenantSchema, runMigrations } from "../../src/adapters/postgres/migrate.js";
import { PostgresStore, createPool, sharedRepositoriesOver } from "../../src/adapters/postgres/postgres-store.js";
import { beginOpening, completeOpening, newMarket } from "../../src/domain/market.js";
import type { Market, MarketRules } from "../../src/domain/market.js";
import { hashToken } from "../../src/domain/share-link.js";
import type { ShareLink } from "../../src/domain/share-link.js";
import { tenantSchemaIdentifier, tenantSchemaName } from "../../src/domain/tenant.js";
import { AdmitShareLink } from "../../src/usecases/admit-share-link.js";
import { CloseDueMarkets } from "../../src/usecases/close-due-markets.js";
import { CloseMarket } from "../../src/usecases/close-market.js";
import { CreateMarket } from "../../src/usecases/create-market.js";
import { CreateShareLink } from "../../src/usecases/create-share-link.js";
import { FinishOpening } from "../../src/usecases/finish-opening.js";
import { ListMarkets } from "../../src/usecases/list-markets.js";
import { LookupSharedMarket } from "../../src/usecases/lookup-shared-market.js";
import { OpenMarket } from "../../src/usecases/open-market.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import { RetryOpening } from "../../src/usecases/retry-opening.js";
import { RevokeShareLink } from "../../src/usecases/revoke-share-link.js";
import { RecordingLogger, SequentialIds, SequentialTokens, TENANT_B, TestClock, actor, closeTimeIn } from "../support/fakes.js";

// These tests need a running Docker daemon: "npm run test:integration". They are not part of "npm test".

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let store: PostgresStore;
let extraDir: string;
const logger = new RecordingLogger();
const now = new Date("2026-11-01T10:00:00.000Z");
const T1 = "00000000-0000-7000-8000-000000000001";
const T2 = "00000000-0000-7000-8000-000000000002";
const T3 = "00000000-0000-7000-8000-000000000003";
const T4 = "00000000-0000-7000-8000-000000000004";
const RULES: MarketRules = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 60_000 };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18").withDatabase("markets").start();
  pool = createPool(container.getConnectionUri(), 10, logger);
  extraDir = await mkdtemp(join(tmpdir(), "markets-tenant-migrations-"));
  // The real tenant migrations, to which a test adds one more (003_add_note.sql).
  await copyFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.tenant)), join(extraDir, "001_init.sql"));
  await copyFile(fileURLToPath(new URL("002_sharing_policy.sql", MIGRATIONS_DIRS.tenant)), join(extraDir, "002_sharing_policy.sql"));
  store = new PostgresStore(pool, logger);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  if (extraDir) await rm(extraDir, { recursive: true, force: true });
});

const schemaExists = async (name: string): Promise<boolean> =>
  ((await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [name])).rowCount ?? 0) > 0;
const columns = async (schema: string, table: string): Promise<string[]> =>
  (
    await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [schema, table],
    )
  ).rows.map((row) => row.column_name);

/** "23514:markets_question_length": the SQLSTATE and the constraint (or column) a statement violated, or "none". */
const violation = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    const { code, constraint, column } = error as { code?: string; constraint?: string; column?: string };
    return `${code ?? "no code"}:${constraint ?? column ?? ""}`;
  }
  return "none";
};

async function ensureTenant(tenantId: string): Promise<void> {
  await store.transaction((repositories) => repositories.tenants.provision(tenantId, now));
}

function draft(tenantId: string, id: string, overrides: Partial<Market> = {}): Market {
  const market = newMarket(
    {
      id,
      tenantId,
      question: "Will the new bridge open before 2027?",
      closeTime: new Date(now.getTime() + 86_400_000).toISOString(),
      startingPrice: 0.4,
      fundingAmount: 500,
      createdBy: "admin-1",
      now,
    },
    RULES,
  );
  return { ...market, ...overrides };
}

const marketId = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const SHARED_MIGRATIONS = ["001_init.sql", "002_share_links.sql", "003_tenant_names.sql"];

describe("shared migrations", () => {
  it("create the shared tables and apply nothing on a second run", async () => {
    const first = await runMigrations(pool, logger);
    expect(first).toEqual({ shared: SHARED_MIGRATIONS, tenants: {} });
    const tables = (
      await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'shared' ORDER BY table_name")
    ).rows.map((row) => row.table_name);
    expect(tables).toEqual(["inbox", "outbox", "pending_openings", "schema_migrations", "share_links", "tenant_registry"]);
    expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
  });

  it("guard the shared tables with constraints", async () => {
    const insertInbox = (consumer: string, eventId: string) =>
      pool.query("INSERT INTO shared.inbox (consumer, event_id, event_type, processed_at) VALUES ($1, $2, 't', $3)", [consumer, eventId, now]);
    await insertInbox("tenant-created", "e1");
    expect(await violation(insertInbox("tenant-created", "e1"))).toBe("23505:inbox_pkey");
    await insertInbox("another-consumer", "e1");
    expect(await violation(insertInbox("", "e2"))).toBe("23514:inbox_consumer_length");
    expect(await violation(insertInbox("tenant-created", ""))).toBe("23514:inbox_event_id_length");

    const register = (tenantId: string, schema: string) =>
      pool.query("INSERT INTO shared.tenant_registry (tenant_id, schema_name, created_at) VALUES ($1, $2, $3)", [tenantId, schema, now]);
    expect(await violation(register(T1, "tenant_ffffffffffffffffffffffffffffffff"))).toBe("23514:tenant_registry_schema_matches_id");
    expect(await violation(register(T1, "public"))).toBe("23514:tenant_registry_schema_format");

    // Pending openings need a registered tenant and one row per market.
    const addPending = (tenantId: string, id: string, attempts = 0, correlationId = "corr-1") =>
      pool.query(
        `INSERT INTO shared.pending_openings (tenant_id, market_id, correlation_id, causation_id, attempts, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'req-1', $4, $5, $5, $5)`,
        [tenantId, id, correlationId, attempts, now],
      );
    expect(await violation(addPending(T1, marketId(1)))).toBe("23503:pending_openings_tenant_id_fkey");
    await migrateTenantSchema(pool, T1, now, logger);
    await addPending(T1, marketId(1));
    expect(await violation(addPending(T1, marketId(1)))).toBe("23505:pending_openings_pkey");
    expect(await violation(addPending(T1, marketId(2), -1))).toBe("23514:pending_openings_attempts_positive");
    expect(await violation(addPending(T1, marketId(2), 0, ""))).toBe("23514:pending_openings_correlation_id_length");
    await pool.query("TRUNCATE shared.pending_openings, shared.inbox");
  });

  it("refuse a file that was changed after it was applied", async () => {
    const changed = await mkdtemp(join(tmpdir(), "markets-changed-shared-"));
    try {
      await writeFile(join(changed, "001_init.sql"), `${await readFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.shared)), "utf8")}\n-- edited\n`);
      await expect(runMigrations(pool, logger, { shared: pathToFileURL(`${changed}/`), tenant: MIGRATIONS_DIRS.tenant })).rejects.toThrow(
        "Migration 001_init.sql of schema shared was changed after it was applied",
      );
      // The refusal must not leave the migration lock behind.
      expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
    } finally {
      await rm(changed, { recursive: true, force: true });
    }
  });

  it("let several instances start at once: one applies the files, the others find nothing to do", async () => {
    await pool.query("DROP DATABASE IF EXISTS fresh_probe WITH (FORCE)");
    await pool.query("CREATE DATABASE fresh_probe");
    const url = new URL(container.getConnectionUri());
    url.pathname = "/fresh_probe";
    const probe = createPool(url.toString(), 6, logger);
    try {
      const reports = await Promise.all([runMigrations(probe, logger), runMigrations(probe, logger), runMigrations(probe, logger)]);
      expect(reports.filter((report) => report.shared.length > 0)).toHaveLength(1);
      expect(reports.flatMap((report) => report.shared)).toEqual(SHARED_MIGRATIONS);
    } finally {
      await probe.end();
      await pool.query("DROP DATABASE IF EXISTS fresh_probe WITH (FORCE)");
    }
  });
});

describe("tenant schemas", () => {
  it("are created, migrated and registered by provisionTenantSchema, named by the one naming function, and the call is idempotent", async () => {
    await migrateTenantSchema(pool, T2, now, logger);

    for (const id of [T1, T2]) {
      const schema = tenantSchemaName(id);
      expect(schema).toBe(`tenant_${id.replaceAll("-", "")}`);
      expect(await columns(schema, "markets")).toContain("starting_price");
      expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations ORDER BY version`)).rows).toEqual([
        { version: "001_init.sql" },
        { version: "002_sharing_policy.sql" },
        { version: "003_auto_close_index.sql" },
        { version: "004_invalid_outcome.sql" },
      ]);
    }
    expect((await pool.query("SELECT tenant_id, schema_name FROM shared.tenant_registry ORDER BY tenant_id")).rows).toEqual([
      { tenant_id: T1, schema_name: tenantSchemaName(T1) },
      { tenant_id: T2, schema_name: tenantSchemaName(T2) },
    ]);
    expect(await migrateTenantSchema(pool, T1, now, logger)).toEqual([]);
    expect(await listTenantSchemas(pool)).toEqual([tenantSchemaName(T1), tenantSchemaName(T2)]);
  });

  it("keep nothing behind when the transaction of the inbox rolls back, and leave the search path alone", async () => {
    const client = await pool.connect();
    try {
      const before = (await client.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path;
      await client.query("BEGIN");
      await provisionTenantSchema(client, T3, now, logger);
      expect((await client.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path).toBe(before);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await schemaExists(tenantSchemaName(T3))).toBe(false);
    expect((await pool.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [T3])).rowCount).toBe(0);
  });

  it("refuse a tenant id that is not a UUID before any statement runs", async () => {
    const statements: string[] = [];
    const spy = { query: (...args: unknown[]) => (statements.push(String(args[0])), Promise.resolve({ rows: [], rowCount: 0 })) } as unknown as pg.PoolClient;

    await expect(provisionTenantSchema(spy, 'x"; DROP SCHEMA shared; --', now, logger)).rejects.toThrow("tenantId must be a UUID");

    expect(statements).toEqual([]);
  });

  it("provision the same tenant from two transactions at once: one creates it, the other finds it", async () => {
    const results = await Promise.all([migrateTenantSchema(pool, T4, now, logger), migrateTenantSchema(pool, T4, now, logger)]);

    // One creates the schema and applies every tenant file (001 init, 002 sharing policy, 003 auto-close index, 004
    // INVALID outcome).
    expect(results.map((applied) => applied.length).sort()).toEqual([0, 4]);
    expect((await pool.query("SELECT 1 FROM shared.tenant_registry WHERE tenant_id = $1", [T4])).rowCount).toBe(1);
  });

  it("refuse a tenant file that was changed after it was applied", async () => {
    const changed = await mkdtemp(join(tmpdir(), "markets-changed-tenant-"));
    try {
      await writeFile(join(changed, "001_init.sql"), `${await readFile(fileURLToPath(new URL("001_init.sql", MIGRATIONS_DIRS.tenant)), "utf8")}\n-- edited\n`);
      await expect(runMigrations(pool, logger, { shared: MIGRATIONS_DIRS.shared, tenant: pathToFileURL(`${changed}/`) })).rejects.toThrow(
        "was changed after it was applied",
      );
      expect(await runMigrations(pool, logger)).toEqual({ shared: [], tenants: {} });
    } finally {
      await rm(changed, { recursive: true, force: true });
    }
  });

  it("get a new tenant migration at the next start, every registered schema alike, so the schemas never drift", async () => {
    await writeFile(join(extraDir, "003_add_note.sql"), "ALTER TABLE markets ADD COLUMN note text;\n");
    const directories = { shared: MIGRATIONS_DIRS.shared, tenant: pathToFileURL(`${extraDir}/`) };

    const report = await runMigrations(pool, logger, directories);

    expect(report.shared).toEqual([]);
    expect(report.tenants).toEqual({
      [tenantSchemaName(T1)]: ["003_add_note.sql"],
      [tenantSchemaName(T2)]: ["003_add_note.sql"],
      [tenantSchemaName(T4)]: ["003_add_note.sql"],
    });
    for (const id of [T1, T2, T4]) expect(await columns(tenantSchemaName(id), "markets")).toContain("note");

    // A tenant created later gets every file at once; its schema agrees with the others.
    expect(await migrateTenantSchema(pool, T3, now, logger, directories)).toEqual(["001_init.sql", "002_sharing_policy.sql", "003_add_note.sql"]);
    expect(await columns(tenantSchemaName(T3), "markets")).toEqual(await columns(tenantSchemaName(T1), "markets"));
    expect(await runMigrations(pool, logger, directories)).toEqual({ shared: [], tenants: {} });
  });
});

describe("the constraints of the markets table", () => {
  let counter = 0;
  const valid = { question: "Will the new bridge open before 2027?", description: "", price: 0.4, funding: 500, status: "draft", outcome: null as string | null, version: 1, createdBy: "admin-1" };
  const insert = (overrides: Partial<typeof valid> = {}, schema = tenantSchemaName(T1)) => {
    const row = { ...valid, ...overrides };
    counter += 1;
    return pool.query(
      `INSERT INTO "${schema}".markets (id, tenant_id, question, description, close_time, starting_price, funding_amount, status, outcome, version, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $5, $5)`,
      [marketId(1000 + counter), T1, row.question, row.description, now, row.price, row.funding, row.status, row.outcome, row.version, row.createdBy],
    );
  };

  it("accept a valid row and the edge values", async () => {
    expect(await violation(insert())).toBe("none");
    expect(await violation(insert({ question: "x".repeat(10) }))).toBe("none");
    expect(await violation(insert({ question: "x".repeat(200), description: "d".repeat(2000) }))).toBe("none");
    expect(await violation(insert({ price: 0.01 }))).toBe("none");
    expect(await violation(insert({ price: 0.99 }))).toBe("none");
    expect(await violation(insert({ funding: 1 }))).toBe("none");
    expect(await violation(insert({ status: "resolved", outcome: "NO" }))).toBe("none");
    // UC-16 (tenant migration 004): INVALID is the third outcome of a resolved market.
    expect(await violation(insert({ status: "resolved", outcome: "INVALID" }))).toBe("none");
    expect(await violation(insert({ status: "open", outcome: null }))).toBe("none");
  });

  it("count the question and the description in code points, as the domain does", async () => {
    // Ten emoji are 20 UTF-16 units but 10 code points: valid. Nine are refused.
    expect(await violation(insert({ question: "🙂".repeat(10) }))).toBe("none");
    expect(await violation(insert({ question: "🙂".repeat(9) }))).toBe("23514:markets_question_length");
    expect(await violation(insert({ question: "🙂".repeat(200) }))).toBe("none");
    expect(await violation(insert({ question: "🙂".repeat(201) }))).toBe("23514:markets_question_length");
    expect(await violation(insert({ description: "🙂".repeat(2000) }))).toBe("none");
  });

  it("refuse every value outside its range", async () => {
    expect(await violation(insert({ question: "x".repeat(9) }))).toBe("23514:markets_question_length");
    expect(await violation(insert({ question: "x".repeat(201) }))).toBe("23514:markets_question_length");
    expect(await violation(insert({ description: "d".repeat(2001) }))).toBe("23514:markets_description_length");
    expect(await violation(insert({ price: 0 }))).toBe("23514:markets_starting_price_range");
    expect(await violation(insert({ price: 1 }))).toBe("23514:markets_starting_price_range");
    expect(await violation(insert({ funding: 0 }))).toBe("23514:markets_funding_amount_positive");
    expect(await violation(insert({ funding: -5 }))).toBe("23514:markets_funding_amount_positive");
    expect(await violation(insert({ status: "pending" }))).toBe("23514:markets_status_values");
    expect(await violation(insert({ status: "resolved", outcome: "MAYBE" }))).toBe("23514:markets_outcome_values");
    expect(await violation(insert({ version: 0 }))).toBe("23514:markets_version_positive");
    expect(await violation(insert({ createdBy: "" }))).toBe("23514:markets_created_by_length");
    expect(await violation(insert({ createdBy: "u".repeat(256) }))).toBe("23514:markets_created_by_length");
  });

  it("require an outcome exactly when the market is resolved", async () => {
    expect(await violation(insert({ status: "resolved", outcome: null }))).toBe("23514:markets_outcome_iff_resolved");
    expect(await violation(insert({ status: "closed", outcome: "YES" }))).toBe("23514:markets_outcome_iff_resolved");
    expect(await violation(insert({ status: "draft", outcome: "NO" }))).toBe("23514:markets_outcome_iff_resolved");
  });

  it("refuse a repeated id and missing required columns", async () => {
    const row = marketId(5000);
    const plain = (id: string) =>
      pool.query(
        `INSERT INTO "${tenantSchemaName(T1)}".markets (id, tenant_id, question, close_time, starting_price, funding_amount, created_by, created_at, updated_at)
         VALUES ($1, $2, 'Will the new bridge open before 2027?', $3, 0.4, 500, 'admin-1', $3, $3)`,
        [id, T1, now],
      );
    await plain(row);
    expect(await violation(plain(row))).toBe("23505:markets_pkey");
    expect(await violation(pool.query(`INSERT INTO "${tenantSchemaName(T1)}".markets (id) VALUES ($1)`, [marketId(5001)]))).toBe("23502:tenant_id");
  });

  it("store the price with two decimals", async () => {
    await insert({ price: 0.4 });
    const stored = await pool.query<{ starting_price: string }>(`SELECT starting_price FROM "${tenantSchemaName(T1)}".markets WHERE id = $1`, [marketId(1000 + counter)]);
    expect(stored.rows[0]?.starting_price).toBe("0.40");
  });
});

describe("the store: markets", () => {
  beforeAll(async () => {
    await ensureTenant(T1);
    await ensureTenant(T2);
  });

  it("answers null for a tenant that is not registered, and for a value that is no tenant id", async () => {
    expect(await store.forTenant("00000000-0000-7000-8000-0000000000ee")).toBeNull();
    expect(await store.forTenant("not-a-uuid")).toBeNull();
    expect(await store.forTenant('x"; DROP SCHEMA shared; --')).toBeNull();
    expect(await store.repositories.tenants.isRegistered(T1)).toBe(true);
    expect(await store.repositories.tenants.isRegistered("00000000-0000-7000-8000-0000000000ee")).toBe(false);
    expect(await store.repositories.tenants.isRegistered("not-a-uuid")).toBe(false);
  });

  it("registers a tenant only inside a transaction", async () => {
    await expect(store.repositories.tenants.provision(T3, now)).rejects.toThrow("inside a transaction only");
  });

  it("round-trips a market, including the numeric price, and keeps the tenants apart", async () => {
    const tenantOne = await store.forTenant(T1);
    const tenantTwo = await store.forTenant(T2);
    if (!tenantOne || !tenantTwo) throw new Error("the tenants are registered");
    const market = draft(T1, marketId(100), { description: "Resolved by the city council announcement." });
    await tenantOne.transaction((repositories) => repositories.markets.insert(market));

    const found = await tenantOne.repositories.markets.findById(market.id);

    expect(found).toEqual(market);
    expect(typeof found?.startingPrice).toBe("number");
    expect(found?.startingPrice).toBe(0.4);
    expect(found?.closeTime).toBeInstanceOf(Date);
    // Another tenant's schema holds none of it, even for the same id.
    expect(await tenantTwo.repositories.markets.findById(market.id)).toBeNull();
    expect(await tenantTwo.repositories.markets.list({ statuses: ["draft"], limit: 10, beforeId: null })).toEqual([]);
    expect(await tenantOne.repositories.markets.findById("not-a-uuid")).toBeNull();
    expect(await tenantOne.repositories.markets.findById(marketId(404))).toBeNull();
  });

  it("lists newest first by id, filtered by status, with the cursor", async () => {
    const tenantOne = await store.forTenant(T1);
    if (!tenantOne) throw new Error("the tenant is registered");
    await pool.query(`TRUNCATE "${tenantSchemaName(T1)}".markets`);
    await tenantOne.transaction(async (repositories) => {
      await repositories.markets.insert(draft(T1, marketId(201)));
      await repositories.markets.insert(draft(T1, marketId(202), { status: "open", version: 3, openedAt: now }));
      await repositories.markets.insert(draft(T1, marketId(203), { status: "open", version: 3, openedAt: now }));
      await repositories.markets.insert(draft(T1, marketId(204), { status: "closed", version: 4, openedAt: now, closedAt: now, closedBy: "admin-1" }));
    });
    const list = (statuses: Market["status"][], limit: number, beforeId: string | null = null) =>
      tenantOne.repositories.markets.list({ statuses, limit, beforeId }).then((rows) => rows.map((row) => row.id));

    expect(await list(["draft", "opening", "open", "closed", "resolved"], 10)).toEqual([marketId(204), marketId(203), marketId(202), marketId(201)]);
    expect(await list(["open"], 10)).toEqual([marketId(203), marketId(202)]);
    expect(await list(["open", "closed"], 2)).toEqual([marketId(204), marketId(203)]);
    expect(await list(["open", "closed"], 2, marketId(203))).toEqual([marketId(202)]);
    expect(await list(["resolved"], 10)).toEqual([]);
    expect(await list(["open"], 10, "not-a-uuid")).toEqual([]);
  });

  it("updates only when the stored status and version are the expected ones (one concurrent writer wins)", async () => {
    const tenantOne = await store.forTenant(T1);
    if (!tenantOne) throw new Error("the tenant is registered");
    const original = draft(T1, marketId(300));
    await tenantOne.transaction((repositories) => repositories.markets.insert(original));
    const opening = { ...original, status: "opening" as const, version: 2, updatedAt: new Date(now.getTime() + 1000) };

    expect(await tenantOne.repositories.markets.update(opening, { status: "draft", version: 5 })).toBe(false);
    expect(await tenantOne.repositories.markets.update(opening, { status: "open", version: 1 })).toBe(false);
    expect((await tenantOne.repositories.markets.findById(original.id))?.status).toBe("draft");

    expect(await tenantOne.repositories.markets.update(opening, { status: "draft", version: 1 })).toBe(true);
    expect(await tenantOne.repositories.markets.findById(original.id)).toEqual(opening);
    // The same transition a second time finds the new status and version: it lost.
    expect(await tenantOne.repositories.markets.update(opening, { status: "draft", version: 1 })).toBe(false);

    const resolved = { ...opening, status: "resolved" as const, outcome: "YES" as const, version: 3, resolvedAt: now, resolvedBy: "admin-2", closedAt: now, closedBy: "admin-2", openedAt: now };
    expect(await tenantOne.repositories.markets.update(resolved, { status: "opening", version: 2 })).toBe(true);
    expect(await tenantOne.repositories.markets.findById(original.id)).toEqual(resolved);
  });

  it("rolls back everything of a transaction that throws, in both schemas", async () => {
    const tenantOne = await store.forTenant(T1);
    if (!tenantOne) throw new Error("the tenant is registered");
    await expect(
      tenantOne.transaction(async (repositories) => {
        await repositories.markets.insert(draft(T1, marketId(400)));
        await repositories.inbox.record({ consumer: "tenant-created", eventId: "rolled-back", eventType: "t", processedAt: now });
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");

    expect(await tenantOne.repositories.markets.findById(marketId(400))).toBeNull();
    expect((await pool.query("SELECT 1 FROM shared.inbox WHERE event_id = 'rolled-back'")).rowCount).toBe(0);
  });

  it("locks a row read with lock: a second locking read waits for the first transaction to end", async () => {
    const tenantOne = await store.forTenant(T1);
    if (!tenantOne) throw new Error("the tenant is registered");
    await tenantOne.transaction((repositories) => repositories.markets.insert(draft(T1, marketId(500))));
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const first = tenantOne.transaction(async (repositories) => {
      await repositories.markets.findById(marketId(500), { lock: true });
      locked();
      await held;
      order.push("first commits");
    });
    await lockTaken;
    const second = tenantOne.transaction(async (repositories) => {
      await repositories.markets.findById(marketId(500), { lock: true });
      order.push("second reads");
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);

    expect(order).toEqual(["first commits", "second reads"]);
  });
});

describe("the store: outbox", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE shared.outbox");
  });

  const message = (n: number, createdAt: Date) => ({
    id: marketId(7000 + n),
    aggregateId: marketId(1),
    subject: `chance.markets.MarketClosed.${T1}`,
    type: "si.chance.markets.MarketClosed.v1",
    payload: { specversion: "1.0" as const, id: marketId(7000 + n), data: { n, text: "čšž 🙂" } } as never,
    createdAt,
  });

  it("claims unpublished rows oldest first up to the limit, with the payload as it was written", async () => {
    await store.transaction(async (repositories) => {
      await repositories.outbox.add(message(2, new Date(now.getTime() + 2000)));
      await repositories.outbox.add(message(1, new Date(now.getTime() + 1000)));
      await repositories.outbox.add(message(3, new Date(now.getTime() + 3000)));
    });

    const rows = await store.transaction((repositories) => repositories.outbox.claimBatch(2));

    expect(rows.map((row) => row.id)).toEqual([marketId(7001), marketId(7002)]);
    expect(rows[0]).toMatchObject({ aggregateId: marketId(1), subject: `chance.markets.MarketClosed.${T1}`, publishedAt: null, attempts: 0, lastError: null });
    expect(rows[0]?.payload).toEqual({ specversion: "1.0", id: marketId(7001), data: { n: 1, text: "čšž 🙂" } });
    expect(rows[0]?.createdAt).toEqual(new Date(now.getTime() + 1000));
  });

  it("marks rows published or failed, and deletes only old published rows", async () => {
    await store.transaction(async (repositories) => {
      for (const n of [1, 2, 3]) await repositories.outbox.add(message(n, new Date(now.getTime() + n * 1000)));
      await repositories.outbox.markPublished(marketId(7001), new Date(now.getTime() + 10_000));
      await repositories.outbox.markPublished(marketId(7002), new Date(now.getTime() + 50_000));
      await repositories.outbox.markFailed(marketId(7003), "broker down");
      await repositories.outbox.markFailed(marketId(7003), "broker down again");
    });

    const pending = await store.transaction((repositories) => repositories.outbox.claimBatch(10));
    expect(pending.map((row) => [row.id, row.attempts, row.lastError])).toEqual([[marketId(7003), 2, "broker down again"]]);

    expect(await store.repositories.outbox.purgePublished(new Date(now.getTime() + 20_000))).toBe(1);
    const left = (await pool.query<{ id: string }>("SELECT id FROM shared.outbox ORDER BY id")).rows.map((row) => row.id);
    expect(left).toEqual([marketId(7002), marketId(7003)]);
  });

  it("lets one relay claim at a time: while a transaction holds the claim, another gets no rows", async () => {
    await store.transaction((repositories) => repositories.outbox.add(message(1, now)));
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      const mine = await sharedRepositoriesOver(holder, true, logger).outbox.claimBatch(10);
      expect(mine).toHaveLength(1);

      expect(await store.transaction((repositories) => repositories.outbox.claimBatch(10))).toEqual([]);

      await holder.query("COMMIT");
    } finally {
      holder.release();
    }
    expect(await store.transaction((repositories) => repositories.outbox.claimBatch(10))).toHaveLength(1);
  });

  it("is published by the relay in order and the rows are then marked", async () => {
    await store.transaction(async (repositories) => {
      for (const n of [1, 2, 3]) await repositories.outbox.add(message(n, new Date(now.getTime() + n * 1000)));
    });
    const publisher = new MemoryEventPublisher();
    const relay = new OutboxRelay({ store, publisher, clock: { now: () => new Date(now.getTime() + 60_000) }, logger, pollMs: 5, streamMaxAgeMs: 7 * 86_400_000 });

    expect(await relay.runOnce()).toEqual({ published: 3, failed: false });
    expect(await relay.runOnce()).toEqual({ published: 0, failed: false });

    expect(publisher.published.map((published) => published.messageId)).toEqual([marketId(7001), marketId(7002), marketId(7003)]);
    expect((await pool.query("SELECT count(*)::int AS n FROM shared.outbox WHERE published_at IS NOT NULL")).rows[0]).toEqual({ n: 3 });
  });

  it("is purged by the relay together with the old inbox entries (DM-06)", async () => {
    await pool.query("TRUNCATE shared.inbox");
    const old = new Date(now.getTime() - 9 * 86_400_000);
    await store.transaction(async (repositories) => {
      await repositories.outbox.add(message(1, old));
      await repositories.outbox.markPublished(marketId(7001), old);
      await repositories.inbox.record({ consumer: "tenant-created", eventId: "old-event", eventType: "t", processedAt: old });
      await repositories.inbox.record({ consumer: "tenant-created", eventId: "recent-event", eventType: "t", processedAt: new Date(now.getTime() - 86_400_000) });
    });
    const relay = new OutboxRelay({ store, publisher: new MemoryEventPublisher(), clock: { now: () => now }, logger, pollMs: 5, streamMaxAgeMs: 7 * 86_400_000 });

    expect(await relay.purgeIfDue()).toBe(1);

    expect((await pool.query("SELECT 1 FROM shared.outbox")).rowCount).toBe(0);
    expect((await pool.query<{ event_id: string }>("SELECT event_id FROM shared.inbox")).rows).toEqual([{ event_id: "recent-event" }]);
  });
});

describe("the store: inbox", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE shared.inbox");
  });

  const entry = (eventId: string, processedAt = now, consumer = "tenant-created") => ({ consumer, eventId, eventType: "si.chance.tenants.TenantCreated.v1", processedAt });

  it("records an event once: the second record says it was seen", async () => {
    expect(await store.transaction((repositories) => repositories.inbox.record(entry("e1")))).toBe(true);
    expect(await store.transaction((repositories) => repositories.inbox.record(entry("e1")))).toBe(false);
    expect(await store.transaction((repositories) => repositories.inbox.record(entry("e1", now, "another-consumer")))).toBe(true);
    expect((await pool.query("SELECT 1 FROM shared.inbox")).rowCount).toBe(2);
  });

  it("makes two concurrent deliveries of one event process it once", async () => {
    const outcomes = await Promise.all([
      store.transaction((repositories) => repositories.inbox.record(entry("same"))),
      store.transaction((repositories) => repositories.inbox.record(entry("same"))),
    ]);

    expect(outcomes.sort()).toEqual([false, true]);
  });

  it("forgets an entry when the transaction that recorded it rolls back", async () => {
    await expect(
      store.transaction(async (repositories) => {
        await repositories.inbox.record(entry("rolled-back"));
        throw new Error("the change failed");
      }),
    ).rejects.toThrow("the change failed");

    expect(await store.transaction((repositories) => repositories.inbox.record(entry("rolled-back")))).toBe(true);
  });

  it("purges the entries processed before the given time", async () => {
    await store.transaction(async (repositories) => {
      await repositories.inbox.record(entry("old", new Date(now.getTime() - 10_000)));
      await repositories.inbox.record(entry("edge", now));
      await repositories.inbox.record(entry("new", new Date(now.getTime() + 10_000)));
    });

    expect(await store.repositories.inbox.purge(now)).toBe(1);

    expect((await pool.query<{ event_id: string }>("SELECT event_id FROM shared.inbox ORDER BY event_id")).rows.map((row) => row.event_id)).toEqual(["edge", "new"]);
  });
});

describe("the store: pending openings", () => {
  const lease = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const add = (tenantId: string, id: string, options: { due?: Date; leaseUntil?: Date; correlationId?: string } = {}) =>
    store.transaction((repositories) =>
      repositories.pendingOpenings.add({
        tenantId,
        marketId: id,
        correlationId: options.correlationId ?? "corr-1",
        causationId: "req-1",
        now: options.due ?? now,
        leaseUntil: options.leaseUntil ?? now,
      }),
    );
  const rows = async () => (await pool.query("SELECT * FROM shared.pending_openings ORDER BY next_attempt_at, market_id")).rows;

  beforeAll(async () => {
    await ensureTenant(T1);
    await ensureTenant(T2);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE shared.pending_openings");
  });

  it("adds a row with attempts 0, due at the given time and leased to the creating request", async () => {
    await add(T1, marketId(1), { due: now, leaseUntil: lease(60), correlationId: "corr-77" });

    expect(await rows()).toEqual([
      expect.objectContaining({
        tenant_id: T1,
        market_id: marketId(1),
        correlation_id: "corr-77",
        causation_id: "req-1",
        attempts: 0,
        next_attempt_at: now,
        lease_until: lease(60),
        last_error: null,
        created_at: now,
      }),
    ]);
  });

  it("refuses a second row for the same market and a market of a tenant that is not registered, and rolls the transaction back", async () => {
    await add(T1, marketId(1));
    await expect(add(T1, marketId(1))).rejects.toMatchObject({ code: "23505" });
    await expect(add("00000000-0000-7000-8000-0000000000ee", marketId(2))).rejects.toMatchObject({ code: "23503" });
    expect(await rows()).toHaveLength(1);
  });

  it("claims only rows that are due and not leased, earliest due first, and leases them", async () => {
    await add(T1, marketId(1), { due: lease(-30) });
    await add(T2, marketId(2), { due: lease(-20), leaseUntil: lease(60) }); // leased by a request that is still running
    await add(T1, marketId(3), { due: lease(-10), leaseUntil: lease(-1) }); // its lease has ended
    await add(T1, marketId(4), { due: lease(30) }); // not due yet
    await add(T2, marketId(5), { due: lease(-5) });

    const claimed = await store.repositories.pendingOpenings.claim(10, lease(60), now);

    expect(claimed.map((row) => row.marketId)).toEqual([marketId(1), marketId(3), marketId(5)]);
    expect(claimed[0]).toEqual({
      tenantId: T1,
      marketId: marketId(1),
      correlationId: "corr-1",
      causationId: "req-1",
      attempts: 0,
      nextAttemptAt: lease(-30),
      leaseUntil: lease(60),
      lastError: null,
      createdAt: lease(-30),
    });
    // Leased now: a second claim at the same time gets nothing, and the due times did not move.
    expect(await store.repositories.pendingOpenings.claim(10, lease(120), now)).toEqual([]);
    expect((await rows()).find((row) => row.market_id === marketId(1))?.next_attempt_at).toEqual(lease(-30));
  });

  it("claims at most the limit and the rest at the next claim", async () => {
    for (let n = 1; n <= 7; n += 1) await add(T1, marketId(n), { due: lease(-100 + n) });

    const first = await store.repositories.pendingOpenings.claim(5, lease(60), now);
    const second = await store.repositories.pendingOpenings.claim(5, lease(60), now);

    expect(first.map((row) => row.marketId)).toEqual([1, 2, 3, 4, 5].map(marketId));
    expect(second.map((row) => row.marketId)).toEqual([6, 7].map(marketId));
  });

  it("makes a row claimable again when its lease has ended", async () => {
    await add(T1, marketId(1), { due: lease(-10) });
    expect(await store.repositories.pendingOpenings.claim(5, lease(60), now)).toHaveLength(1);

    expect(await store.repositories.pendingOpenings.claim(5, lease(120), lease(59))).toEqual([]);
    const again = await store.repositories.pendingOpenings.claim(5, lease(120), lease(60));

    expect(again.map((row) => row.marketId)).toEqual([marketId(1)]);
  });

  it("reschedules with attempts + 1, the new due time, no lease and the error; removes without an error for a missing row", async () => {
    await add(T1, marketId(1), { due: lease(-10) });
    await store.repositories.pendingOpenings.claim(5, lease(60), now);

    await store.repositories.pendingOpenings.reschedule(T1, marketId(1), lease(2), "timeout after 3000 ms");
    await store.repositories.pendingOpenings.reschedule(T1, marketId(1), lease(4), "e".repeat(5000));

    const [row] = await rows();
    expect(row).toMatchObject({ attempts: 2, next_attempt_at: lease(4), lease_until: null });
    expect((row as { last_error: string }).last_error).toHaveLength(2000);
    expect(await store.repositories.pendingOpenings.claim(5, lease(120), lease(3))).toEqual([]);
    expect((await store.repositories.pendingOpenings.claim(5, lease(120), lease(4))).map((claimed) => claimed.attempts)).toEqual([2]);

    await store.repositories.pendingOpenings.remove(T1, marketId(1));
    await store.repositories.pendingOpenings.remove(T1, marketId(1));
    expect(await rows()).toEqual([]);
  });

  it("never hands one row to two claims that run at the same time", async () => {
    for (let n = 1; n <= 24; n += 1) await add(T1, marketId(n), { due: lease(-1000 + n) });

    const rounds = await Promise.all(Array.from({ length: 6 }, () => store.repositories.pendingOpenings.claim(5, lease(60), now)));
    const claimed = rounds.flat().map((row) => row.marketId);
    for (;;) {
      const rest = await store.repositories.pendingOpenings.claim(5, lease(60), now);
      if (rest.length === 0) break;
      claimed.push(...rest.map((row) => row.marketId));
    }

    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual(Array.from({ length: 24 }, (_unused, index) => marketId(index + 1)));
    for (const round of rounds) expect(round.length).toBeLessThanOrEqual(5);
  });

  it("skips a row that another transaction has locked instead of waiting for it", async () => {
    await add(T1, marketId(1), { due: lease(-30) });
    await add(T1, marketId(2), { due: lease(-20) });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      // What a request does while it settles an opening: it holds the row until its transaction ends.
      await holder.query("SELECT 1 FROM shared.pending_openings WHERE market_id = $1 FOR UPDATE", [marketId(1)]);

      const claimed = await store.repositories.pendingOpenings.claim(5, lease(60), now);

      expect(claimed.map((row) => row.marketId)).toEqual([marketId(2)]);
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
    expect((await store.repositories.pendingOpenings.claim(5, lease(60), now)).map((row) => row.marketId)).toEqual([marketId(1)]);
  });
});

describe("the automatic close over PostgreSQL (UC-15)", () => {
  const STATUS_OPEN_INDEX = "markets_open_close_time_idx";
  const CLOSED_EVENT = "si.chance.markets.MarketClosed.v1";
  const admin = actor("admin-1", "tenant-admin", T1);

  beforeAll(async () => {
    await ensureTenant(T1);
    await ensureTenant(T2);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE "${tenantSchemaName(T1)}".markets, "${tenantSchemaName(T2)}".markets`);
    await pool.query("TRUNCATE shared.outbox, shared.pending_openings");
  });

  /** The use cases and the clock of one "service instance"; instances share the pool, as replicas share the database. */
  function instance(clock: TestClock, ids: SequentialIds) {
    const deps = { store, clock, ids, logger: new RecordingLogger() };
    const close = new CloseDueMarkets(deps);
    return { deps, close, worker: new AutoCloseWorker({ store, close, logger: deps.logger, settings: () => ({ enabled: true, intervalMs: 5 }) }), admin: new CloseMarket(deps) };
  }

  /** An open market of the tenant that closes `hours` after the clock's time, inserted as the saga would leave it. */
  async function insertOpen(clock: TestClock, tenantId: string, n: number, hours: number): Promise<Market> {
    const draft = newMarket(
      { id: marketId(n), tenantId, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(clock, hours), startingPrice: 0.4, fundingAmount: 500, createdBy: "admin-1", now: clock.now() },
      RULES,
    );
    const open = completeOpening(beginOpening(draft, clock.now()), clock.now());
    const tenant = await store.forTenant(tenantId);
    if (!tenant) throw new Error(`tenant ${tenantId} is not registered`);
    await tenant.repositories.markets.insert(open);
    return open;
  }

  const rowsOf = async (tenantId: string) =>
    (await pool.query<{ id: string; status: string; version: number; closed_by: string | null }>(`SELECT id, status, version, closed_by FROM "${tenantSchemaName(tenantId)}".markets ORDER BY id`)).rows;
  const closedEvents = async () =>
    (await pool.query<{ aggregate_id: string; payload: { data: { version: number; closedBy: string } } }>("SELECT aggregate_id, payload FROM shared.outbox WHERE type = $1 ORDER BY aggregate_id", [CLOSED_EVENT])).rows;

  it("has a partial index on the open markets in every tenant schema", async () => {
    for (const tenantId of [T1, T2]) {
      const result = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'markets' AND indexname = $2", [tenantSchemaName(tenantId), STATUS_OPEN_INDEX]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.indexdef).toMatch(/\(close_time, id\) WHERE \(status = 'open'::text\)/);
    }
    expect(await store.repositories.tenants.listTenantIds()).toEqual(expect.arrayContaining([T1, T2]));
  });

  it("claims only open markets that are due, earliest first, and answers the probe", async () => {
    const clock = new TestClock();
    for (const [n, hours] of [[3, 5], [1, 2], [2, 3], [4, 30]] as const) await insertOpen(clock, T1, n, hours);
    const draft = newMarket({ id: marketId(9), tenantId: T1, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(clock, 1), startingPrice: 0.4, fundingAmount: 500, createdBy: "admin-1", now: clock.now() }, RULES);
    const tenant = await store.forTenant(T1);
    await tenant?.repositories.markets.insert(draft);
    const due = new Date(clock.now().getTime() + 6 * 3_600_000);

    expect(await tenant?.repositories.markets.hasDue(clock.now())).toBe(false);
    expect(await tenant?.repositories.markets.hasDue(due)).toBe(true);
    const claimed = await tenant?.transaction((repositories) => repositories.markets.claimDue(due, 10, []));
    expect(claimed?.map((market) => market.id)).toEqual([marketId(1), marketId(2), marketId(3)]);
    expect((await tenant?.transaction((repositories) => repositories.markets.claimDue(due, 10, [marketId(1), "not-a-uuid"])))?.map((market) => market.id)).toEqual([marketId(2), marketId(3)]);
  });

  it("skips a market that another transaction holds instead of waiting for it", async () => {
    const clock = new TestClock();
    for (const n of [1, 2, 3]) await insertOpen(clock, T1, n, n + 1);
    const due = new Date(clock.now().getTime() + 6 * 3_600_000);
    const tenant = await store.forTenant(T1);
    if (!tenant) throw new Error("tenant T1 is registered");
    let locked!: () => void;
    const lockedFirst = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let first: string[] = [];
    const holder = tenant.transaction(async (repositories) => {
      first = (await repositories.markets.claimDue(due, 1, [])).map((market) => market.id);
      locked();
      await hold;
    });
    await lockedFirst;

    const second = await tenant.transaction((repositories) => repositories.markets.claimDue(due, 10, []));

    expect(first).toEqual([marketId(1)]);
    expect(second.map((market) => market.id)).toEqual([marketId(2), marketId(3)]);
    release();
    await holder;
    expect((await tenant.transaction((repositories) => repositories.markets.claimDue(due, 10, []))).map((market) => market.id)).toEqual([marketId(1), marketId(2), marketId(3)]);
  });

  it("closes every due market exactly once when three workers run at the same time over two tenants", async () => {
    const clock = new TestClock();
    const ids = new SequentialIds();
    for (let n = 1; n <= 30; n += 1) await insertOpen(clock, T1, n, 1 + (n % 5));
    for (let n = 101; n <= 120; n += 1) await insertOpen(clock, T2, n, 1 + (n % 5));
    await insertOpen(clock, T1, 200, 48);
    clock.advanceMs(6 * 3_600_000);
    const workers = [instance(clock, ids), instance(clock, ids), instance(clock, ids)];

    const results = await Promise.all(workers.map((one) => one.worker.runOnce()));

    expect(results.reduce((sum, result) => sum + result.closed, 0)).toBe(50);
    expect(results.every((result) => result.failedMarkets === 0 && result.failedTenants === 0 && !result.skipped)).toBe(true);
    for (const rows of [await rowsOf(T1), await rowsOf(T2)]) {
      for (const row of rows.filter((candidate) => candidate.id !== marketId(200))) expect(row).toMatchObject({ status: "closed", version: 4, closed_by: "system:auto-close" });
    }
    expect((await rowsOf(T1)).find((row) => row.id === marketId(200))).toMatchObject({ status: "open", version: 3, closed_by: null });
    const events = await closedEvents();
    expect(events).toHaveLength(50);
    expect(new Set(events.map((event) => event.aggregate_id)).size).toBe(50);
    expect(events.every((event) => event.payload.data.version === 4 && event.payload.data.closedBy === "system:auto-close")).toBe(true);

    // A later run finds nothing to do and writes nothing.
    const again = await workers[0]?.worker.runOnce();
    expect(again?.closed).toBe(0);
    expect(await closedEvents()).toHaveLength(50);
  });

  it("lets exactly one win when an admin closes a market at the moment the automatic close claims it", async () => {
    const clock = new TestClock();
    const ids = new SequentialIds();
    await insertOpen(clock, T1, 1, 2);
    clock.advanceMs(3 * 3_600_000);
    const one = instance(clock, ids);

    const results = await Promise.allSettled([one.admin.execute({ actor: admin, marketId: marketId(1) }), one.close.execute({ tenantId: T1, limit: 5 })]);

    expect(results.map((result) => result.status === "rejected" ? (result.reason as { code?: string }).code : "ok").filter((outcome) => outcome !== "ok" && outcome !== "invalid_state")).toEqual([]);
    expect(await rowsOf(T1)).toEqual([expect.objectContaining({ id: marketId(1), status: "closed", version: 4 })]);
    expect(await closedEvents()).toHaveLength(1);
  });

  it("goes on with the other tenants when one tenant's table cannot be read", async () => {
    const clock = new TestClock();
    const ids = new SequentialIds();
    await insertOpen(clock, T1, 1, 2);
    await insertOpen(clock, T2, 101, 2);
    clock.advanceMs(3 * 3_600_000);
    const one = instance(clock, ids);
    await pool.query(`ALTER TABLE "${tenantSchemaName(T2)}".markets RENAME TO markets_broken`);
    try {
      const result = await one.worker.runOnce();

      expect(result.failedTenants).toBeGreaterThanOrEqual(1);
      expect(result.closed).toBe(1);
      expect((await rowsOf(T1))[0]).toMatchObject({ status: "closed", closed_by: "system:auto-close" });
      expect(one.deps.logger.lines.some((line) => line.level === "error" && JSON.stringify(line.fields).includes(T2))).toBe(true);
    } finally {
      await pool.query(`ALTER TABLE "${tenantSchemaName(T2)}".markets_broken RENAME TO markets`);
    }
    expect((await one.worker.runOnce()).closed).toBe(1);
    expect((await rowsOf(T2))[0]).toMatchObject({ status: "closed", version: 4 });
  });
});

describe("the use cases over PostgreSQL", () => {
  const admin = actor("admin-1", "tenant-admin", T1);

  async function core(mode: "funded" | "insufficient" | "unknown" = "funded") {
    await ensureTenant(T1);
    await pool.query(`TRUNCATE "${tenantSchemaName(T1)}".markets`);
    await pool.query("TRUNCATE shared.pending_openings, shared.outbox");
    const clock = new TestClock();
    const ids = new SequentialIds();
    const funding = new FakeFundingClient(mode);
    const deps = { store, clock, ids, logger: new RecordingLogger() };
    const finishOpening = new FinishOpening({ ...deps, funding });
    return {
      clock,
      funding,
      deps,
      create: new CreateMarket(deps, { current: () => RULES }),
      open: new OpenMarket(deps, finishOpening),
      close: new CloseMarket(deps),
      list: new ListMarkets(store),
      retry: new RetryOpening(finishOpening, deps.logger),
    };
  }

  const stored = async (id: string) => (await (await store.forTenant(T1))?.repositories.markets.findById(id)) ?? null;
  const outbox = async () => (await pool.query<{ type: string; subject: string; payload: { correlationid: string; causationid: string; data: { version: number } } }>("SELECT type, subject, payload FROM shared.outbox ORDER BY created_at, id")).rows;
  const pendingCount = async () => (await pool.query("SELECT 1 FROM shared.pending_openings")).rowCount;

  it("opens a funded market: opening, open, the MarketOpened event in the outbox and no pending row", async () => {
    const c = await core("funded");
    const created = await c.create.execute({ actor: admin, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(c.clock, 24), startingPrice: 0.4, fundingAmount: 500 });

    const opened = await c.open.execute({ actor: admin, marketId: created.id });

    expect(opened.state).toBe("open");
    expect(await stored(created.id)).toMatchObject({ status: "open", version: 3, openedAt: expect.any(Date) });
    expect(await pendingCount()).toBe(0);
    expect(c.funding.calls).toHaveLength(1);
    expect(c.funding.calls[0]).toMatchObject({ idempotencyKey: created.id, request: { marketId: created.id, tenantId: T1, creatorId: "admin-1", amount: 500 } });
    const events = await outbox();
    expect(events.map((event) => [event.type, event.subject, event.payload.data.version])).toEqual([["si.chance.markets.MarketOpened.v1", `chance.markets.MarketOpened.${T1}`, 3]]);
  });

  it("puts a market back to draft when the credits are insufficient, with no event and no pending row", async () => {
    const c = await core("insufficient");
    const created = await c.create.execute({ actor: admin, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(c.clock, 24), startingPrice: 0.4, fundingAmount: 500 });

    await expect(c.open.execute({ actor: admin, marketId: created.id })).rejects.toMatchObject({ kind: "conflict", code: "insufficient_credits" });

    expect(await stored(created.id)).toMatchObject({ status: "draft", version: 3 });
    expect(await pendingCount()).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  it("leaves a market opening when the outcome is unknown, and the worker finishes it with the original correlation id", async () => {
    const c = await core("unknown");
    const created = await c.create.execute({ actor: admin, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(c.clock, 24), startingPrice: 0.4, fundingAmount: 500 });

    const first = await c.open.execute({ actor: admin, marketId: created.id });

    expect(first.state).toBe("opening");
    expect(await stored(created.id)).toMatchObject({ status: "opening", version: 2 });
    const pending = (await pool.query("SELECT attempts, next_attempt_at, lease_until, last_error, correlation_id FROM shared.pending_openings")).rows;
    expect(pending).toEqual([expect.objectContaining({ attempts: 1, lease_until: null, last_error: "FAKE_FUNDING_MODE=unknown", correlation_id: "corr-admin-1" })]);
    expect(await outbox()).toEqual([]);

    // Not due yet: the worker finds nothing. Later, trading answers, and the same Idempotency-Key finishes the opening.
    const worker = new OpeningRetryWorker({ store, retry: c.retry, clock: c.clock, logger: c.deps.logger, intervalMs: 5 });
    expect(await worker.runOnce()).toEqual({ claimed: 0 });
    c.funding.mode = "funded";
    c.clock.advanceMs(2000);
    expect(await worker.runOnce()).toEqual({ claimed: 1 });

    expect(await stored(created.id)).toMatchObject({ status: "open", version: 3 });
    expect(await pendingCount()).toBe(0);
    expect(c.funding.calls.map((call) => call.idempotencyKey)).toEqual([created.id, created.id]);
    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ correlationid: "corr-admin-1", causationid: "req-admin-1" });
  });

  it("lets exactly one of two concurrent openers call trading", async () => {
    const c = await core("funded");
    const created = await c.create.execute({ actor: admin, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(c.clock, 24), startingPrice: 0.4, fundingAmount: 500 });

    const results = await Promise.allSettled([c.open.execute({ actor: admin, marketId: created.id }), c.open.execute({ actor: admin, marketId: created.id })]);

    expect(c.funding.calls).toHaveLength(1);
    const winners = results.filter((result) => result.status === "fulfilled" && result.value.state === "open");
    expect(winners).toHaveLength(1);
    expect(await stored(created.id)).toMatchObject({ status: "open", version: 3 });
    expect(await outbox()).toHaveLength(1);
    expect(await pendingCount()).toBe(0);
  });

  it("closes an open market in one transaction with its event, and lists markets newest first with the cursor", async () => {
    const c = await core("funded");
    const make = async () => {
      c.clock.tick();
      const created = await c.create.execute({ actor: admin, question: "Will the new bridge open before 2027?", closeTime: closeTimeIn(c.clock, 24), startingPrice: 0.4, fundingAmount: 500 });
      await c.open.execute({ actor: admin, marketId: created.id });
      return created.id;
    };
    const [a, b, d] = [await make(), await make(), await make()];

    const closed = await c.close.execute({ actor: admin, marketId: b });

    expect(closed).toMatchObject({ status: "closed", version: 4, closedBy: "admin-1" });
    expect((await outbox()).map((event) => event.type)).toEqual([
      "si.chance.markets.MarketOpened.v1",
      "si.chance.markets.MarketOpened.v1",
      "si.chance.markets.MarketOpened.v1",
      "si.chance.markets.MarketClosed.v1",
    ]);
    const firstPage = await c.list.execute({ actor: admin, limit: 2 });
    expect(firstPage.items.map((market) => market.id)).toEqual([d, b]);
    const secondPage = await c.list.execute({ actor: admin, limit: 2, ...(firstPage.nextCursor === null ? {} : { cursor: firstPage.nextCursor }) });
    expect(secondPage.items.map((market) => market.id)).toEqual([a]);
  });

  it("provisions a tenant from a TenantCreated notice once, also when two deliveries arrive at the same time", async () => {
    const notice = { eventId: "018f3c1e-7a00-7000-8000-000000000e77", eventType: "si.chance.tenants.TenantCreated.v1", tenantId: TENANT_B, correlationId: "corr-t" };
    const provision = new ProvisionTenant({ store, clock: { now: () => now }, logger: new RecordingLogger() });
    await pool.query("DELETE FROM shared.inbox WHERE event_id = $1", [notice.eventId]);

    const results = await Promise.all([provision.execute(notice), provision.execute(notice)]);

    expect([...results].sort()).toEqual(["duplicate", "provisioned"]);
    expect(await schemaExists(tenantSchemaName(TENANT_B))).toBe(true);
    expect(await columns(tenantSchemaName(TENANT_B), "markets")).toContain("funding_amount");
    expect(await store.forTenant(TENANT_B)).not.toBeNull();
    expect((await pool.query("SELECT 1 FROM shared.inbox WHERE consumer = 'tenant-created' AND event_id = $1", [notice.eventId])).rowCount).toBe(1);
    expect(await provision.execute(notice)).toBe("duplicate");
  });

  it("rolls the inbox entry back when provisioning fails, so the redelivery is processed", async () => {
    const provision = new ProvisionTenant({ store, clock: { now: () => now }, logger: new RecordingLogger() });
    const broken = { eventId: "018f3c1e-7a00-7000-8000-000000000e78", eventType: "si.chance.tenants.TenantCreated.v1", tenantId: "not-a-uuid", correlationId: null };

    await expect(provision.execute(broken)).rejects.toThrow();

    expect((await pool.query("SELECT 1 FROM shared.inbox WHERE event_id = $1", [broken.eventId])).rowCount).toBe(0);
  });
});

describe("share links and the sharing policy", () => {
  const T_SHARE = "00000000-0000-7000-8000-0000000000a1";
  const T_OTHER = "00000000-0000-7000-8000-0000000000a2";
  const link = (n: number, overrides: Partial<ShareLink> = {}): ShareLink => ({
    id: marketId(9000 + n),
    tokenHash: hashToken(`token-${n}`),
    tenantId: T_SHARE,
    marketId: marketId(9500),
    type: "everyone",
    emails: [],
    createdBy: "member-1",
    createdAt: new Date(now.getTime() + n),
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });

  beforeAll(async () => {
    await ensureTenant(T_SHARE);
    await ensureTenant(T_OTHER);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE shared.share_links");
  });

  it("stores the sharing policy with the market and gives older rows the default", async () => {
    const tenant = (await store.forTenant(T_SHARE))!;
    const policy = { whoMayShare: "admins", linkTypes: ["members", "everyone"] } as const;
    await tenant.repositories.markets.insert(draft(T_SHARE, marketId(9501), { sharing: policy }));
    expect((await tenant.repositories.markets.findById(marketId(9501)))?.sharing).toEqual(policy);

    const schema = tenantSchemaIdentifier(T_SHARE);
    await pool.query(
      `INSERT INTO ${schema}.markets (id, tenant_id, question, close_time, starting_price, funding_amount, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Will the old rows be shared?', $3, 0.5, 100, 'admin-1', $3, $3)`,
      [marketId(9502), T_SHARE, now],
    );
    expect((await tenant.repositories.markets.findById(marketId(9502)))?.sharing).toEqual({ whoMayShare: "members", linkTypes: ["members"] });

    expect(await violation(pool.query(`UPDATE ${schema}.markets SET sharing_who = 'anyone' WHERE id = $1`, [marketId(9501)]))).toBe("23514:markets_sharing_who_values");
    expect(await violation(pool.query(`UPDATE ${schema}.markets SET sharing_link_types = ARRAY['members','world'] WHERE id = $1`, [marketId(9501)]))).toBe(
      "23514:markets_sharing_link_types_values",
    );
  });

  it("keeps the organization's display name, a given name replacing and none keeping it", async () => {
    expect(await store.repositories.tenants.displayNameOf(T_SHARE)).toBeNull();
    await store.transaction((repositories) => repositories.tenants.provision(T_SHARE, now, "Acme Bets"));
    expect(await store.repositories.tenants.displayNameOf(T_SHARE)).toBe("Acme Bets");
    await store.transaction((repositories) => repositories.tenants.provision(T_SHARE, now, null));
    expect(await store.repositories.tenants.displayNameOf(T_SHARE)).toBe("Acme Bets");
    await store.transaction((repositories) => repositories.tenants.provision(T_SHARE, now, "Acme Predictions"));
    expect(await store.repositories.tenants.displayNameOf(T_SHARE)).toBe("Acme Predictions");
    expect(await store.repositories.tenants.displayNameOf("not-a-uuid")).toBeNull();
    expect(await store.repositories.tenants.displayNameOf("00000000-0000-7000-8000-0000000000ff")).toBeNull();
  });

  it("finds a link by the hash of its token, lists newest first with a cursor and a creator filter, and revokes once", async () => {
    const links = [link(1), link(2, { createdBy: "member-2" }), link(3, { type: "profiles", emails: ["a@example.test"] })];
    for (const row of links) await store.repositories.shareLinks.insert(row);

    expect(await store.repositories.shareLinks.findByTokenHash(hashToken("token-2"))).toEqual(links[1]);
    expect(await store.repositories.shareLinks.findByTokenHash(hashToken("token-404"))).toBeNull();
    expect(await store.repositories.shareLinks.findById(T_SHARE, links[2]!.id)).toEqual(links[2]);
    expect(await store.repositories.shareLinks.findById(T_OTHER, links[2]!.id)).toBeNull();
    expect(await store.repositories.shareLinks.findById(T_SHARE, "not-a-uuid")).toBeNull();

    const query = { tenantId: T_SHARE, marketId: marketId(9500), createdBy: null, limit: 2, beforeId: null };
    const first = await store.repositories.shareLinks.list(query);
    expect(first.map((row) => row.id)).toEqual([links[2]!.id, links[1]!.id]);
    expect((await store.repositories.shareLinks.list({ ...query, beforeId: first[1]!.id })).map((row) => row.id)).toEqual([links[0]!.id]);
    expect((await store.repositories.shareLinks.list({ ...query, createdBy: "member-2" })).map((row) => row.id)).toEqual([links[1]!.id]);
    expect(await store.repositories.shareLinks.list({ ...query, tenantId: T_OTHER })).toEqual([]);
    expect(await store.repositories.shareLinks.list({ ...query, beforeId: "junk" })).toEqual([]);

    const at = new Date(now.getTime() + 60_000);
    expect(await store.repositories.shareLinks.revoke(T_SHARE, links[0]!.id, at)).toBe(true);
    expect(await store.repositories.shareLinks.revoke(T_SHARE, links[0]!.id, new Date(at.getTime() + 1))).toBe(false);
    expect(await store.repositories.shareLinks.revoke(T_OTHER, links[1]!.id, at)).toBe(false);
    expect((await store.repositories.shareLinks.findById(T_SHARE, links[0]!.id))?.revokedAt).toEqual(at);
  });

  it("guards the table with constraints: unique token hash, hash format, type, addresses of the type, lower case, tenant", async () => {
    await store.repositories.shareLinks.insert(link(1));
    const attempt = (row: ShareLink) => violation(store.repositories.shareLinks.insert(row));
    expect(await attempt(link(1))).toBe("23505:share_links_pkey");
    expect(await attempt(link(2, { tokenHash: hashToken("token-1") }))).toBe("23505:share_links_token_hash_key");
    expect(await attempt(link(3, { tokenHash: "ABC" }))).toBe("23514:share_links_token_hash_format");
    expect(await attempt(link(4, { type: "world" as never }))).toBe("23514:share_links_type_values");
    expect(await attempt(link(5, { type: "profiles", emails: [] }))).toBe("23514:share_links_emails_match_type");
    expect(await attempt(link(6, { type: "members", emails: ["a@example.test"] }))).toBe("23514:share_links_emails_match_type");
    expect(await attempt(link(7, { type: "profiles", emails: Array.from({ length: 51 }, (_, i) => `u${i}@example.test`) }))).toBe("23514:share_links_emails_match_type");
    expect(await attempt(link(8, { type: "profiles", emails: ["Mixed@Example.test"] }))).toBe("23514:share_links_emails_lower_case");
    expect(await attempt(link(9, { createdBy: "" }))).toBe("23514:share_links_created_by_length");
    expect(await attempt(link(10, { tenantId: "00000000-0000-7000-8000-0000000000fe" }))).toBe("23503:share_links_tenant_id_fkey");
    expect(await attempt(link(11, { type: "profiles", emails: Array.from({ length: 50 }, (_, i) => `u${i}@example.test`) }))).toBe("none");
  });

  it("runs the share-link use cases over PostgreSQL: create with an event, look up, admit, revoke with an event", async () => {
    const clock = { now: () => now };
    const ids = new SequentialIds();
    const tokens = new SequentialTokens();
    const rules = { current: () => RULES };
    const deps = { store, clock, ids, logger: new RecordingLogger() };
    const admin = actor("admin-1", "tenant-admin", T_SHARE);
    const trader = actor("trader-1", "trader", T_SHARE);
    await pool.query("TRUNCATE shared.outbox");

    const created = await new CreateMarket(deps, rules).execute({
      actor: admin,
      question: "Will the new bridge open before 2027?",
      closeTime: closeTimeIn(clock, 24),
      startingPrice: 0.4,
      fundingAmount: 500,
      sharing: { whoMayShare: "members", linkTypes: ["everyone", "profiles"] },
    });
    const tenant = (await store.forTenant(T_SHARE))!;
    const opening = beginOpening(created, now);
    await tenant.repositories.markets.update(opening, { status: created.status, version: created.version });
    await tenant.repositories.markets.update(completeOpening(opening, now), { status: opening.status, version: opening.version });

    const create = new CreateShareLink({ ...deps, tokens });
    const everyone = await create.execute({ actor: trader, marketId: created.id, type: "everyone" });
    const profiles = await create.execute({ actor: trader, marketId: created.id, type: "profiles", emails: ["Guest@Example.test"] });
    await expect(create.execute({ actor: trader, marketId: created.id, type: "members" })).rejects.toThrow(/does not allow share links of type members/);
    expect(everyone.token).toBe(SequentialTokens.tokenNumber(1));
    expect(JSON.stringify((await pool.query("SELECT * FROM shared.share_links")).rows)).not.toContain(everyone.token);

    const lookup = new LookupSharedMarket(store, clock);
    expect(await lookup.execute({ token: everyone.token, viewer: null })).toMatchObject({ linkType: "everyone", organization: { alias: T_SHARE }, next: ["sign_in"] });
    await expect(lookup.execute({ token: profiles.token, viewer: null })).rejects.toMatchObject({ code: "share_link_not_permitted" });
    const guest = { userId: "g", tenantId: null, role: null, email: "GUEST@example.test", emailVerified: true };
    expect(await lookup.execute({ token: profiles.token, viewer: guest })).toMatchObject({ linkType: "profiles", next: ["join"] });
    await expect(lookup.execute({ token: SequentialTokens.tokenNumber(77), viewer: null })).rejects.toMatchObject({ code: "not_found" });

    const admit = new AdmitShareLink(store, clock);
    expect(await admit.execute({ token: profiles.token, userEmail: "guest@example.test", emailVerified: true })).toEqual({
      decision: "join",
      linkType: "profiles",
      tenantId: T_SHARE,
      marketId: created.id,
    });

    const revoke = new RevokeShareLink(deps);
    await revoke.execute({ actor: trader, marketId: created.id, linkId: everyone.link.id });
    await revoke.execute({ actor: admin, marketId: created.id, linkId: everyone.link.id });
    await expect(lookup.execute({ token: everyone.token, viewer: null })).rejects.toMatchObject({ code: "not_found" });

    const events = (await pool.query<{ type: string }>("SELECT type FROM shared.outbox ORDER BY created_at, id")).rows.map((row) => row.type);
    expect(events.filter((type) => type.endsWith("ShareLinkCreated.v1"))).toHaveLength(2);
    expect(events.filter((type) => type.endsWith("ShareLinkRevoked.v1"))).toHaveLength(1);
    const payloads = JSON.stringify((await pool.query("SELECT payload FROM shared.outbox")).rows);
    expect(payloads).not.toContain(everyone.token);
    expect(payloads).not.toContain("example.test");
  });
});
