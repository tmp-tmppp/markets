import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { beginOpening, newMarket } from "../../src/domain/market.js";
import type { Market, MarketStatus } from "../../src/domain/market.js";
import type { OutboxMessage, TenantStore } from "../../src/usecases/ports.js";
import { RecordingLogger, TENANT_A, TENANT_B } from "../support/fakes.js";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const RULES = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 300_000 };
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const idOf = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function market(n: number, overrides: Partial<Market> = {}, tenantId = TENANT_A): Market {
  const draft = newMarket(
    { id: idOf(n), tenantId, question: "Will the bridge open in time?", closeTime: "2026-11-02T10:00:00.000Z", startingPrice: 0.5, fundingAmount: 500, createdBy: "admin-1", now: NOW },
    RULES,
  );
  return { ...draft, ...overrides };
}

async function tenantOf(store: MemoryStore, tenantId = TENANT_A): Promise<TenantStore> {
  await store.repositories.tenants.provision(tenantId, NOW);
  const tenant = await store.forTenant(tenantId);
  if (!tenant) throw new Error("the tenant was just registered");
  return tenant;
}

function message(id: string, seconds: number): OutboxMessage {
  return {
    id,
    aggregateId: "market-1",
    subject: `chance.markets.MarketClosed.${TENANT_A}`,
    type: "si.chance.markets.MarketClosed.v1",
    payload: {
      specversion: "1.0",
      id,
      source: "/chance/markets",
      type: "si.chance.markets.MarketClosed.v1",
      subject: "market/market-1",
      time: at(seconds).toISOString(),
      datacontenttype: "application/json",
      tenantid: TENANT_A,
      correlationid: "c",
      causationid: "k",
      data: {},
    },
    createdAt: at(seconds),
  };
}

const pendingRow = (n: number, seconds: number, leaseSeconds: number, tenantId = TENANT_A) => ({
  tenantId,
  marketId: idOf(n),
  correlationId: "c",
  causationId: "k",
  now: at(seconds),
  leaseUntil: at(leaseSeconds),
});

describe("MemoryStore, tenants", () => {
  it("answers null for a tenant that has no schema, and registers one on provision", async () => {
    const store = new MemoryStore();
    expect(await store.forTenant(TENANT_A)).toBeNull();
    expect(await store.repositories.tenants.isRegistered(TENANT_A)).toBe(false);

    await store.repositories.tenants.provision(TENANT_A, NOW);
    await store.repositories.tenants.provision(TENANT_A, NOW);

    expect(await store.repositories.tenants.isRegistered(TENANT_A)).toBe(true);
    expect((await store.forTenant(TENANT_A))?.tenantId).toBe(TENANT_A);
    expect(store.snapshot().tenants).toEqual([TENANT_A]);
  });

  it("with autoProvision registers a tenant on its first use and logs it once", async () => {
    const logger = new RecordingLogger();
    const store = new MemoryStore({ autoProvision: true, logger });

    await store.forTenant(TENANT_A);
    await store.forTenant(TENANT_A);
    await store.forTenant(TENANT_B);

    expect(store.snapshot().tenants).toEqual([TENANT_A, TENANT_B]);
    expect(logger.lines).toEqual([
      expect.objectContaining({ level: "info", message: "APP_ENV=local: tenant provisioned on first use", fields: { tenantId: TENANT_A } }),
      expect.objectContaining({ level: "info", fields: { tenantId: TENANT_B } }),
    ]);
  });

  it("autoProvision without a logger still registers", async () => {
    const store = new MemoryStore({ autoProvision: true });

    expect(await store.forTenant(TENANT_A)).not.toBeNull();
  });

  it("keeps the markets of one tenant invisible to the store of another", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store, TENANT_A);
    const b = await tenantOf(store, TENANT_B);
    await a.repositories.markets.insert(market(1));

    expect(await b.repositories.markets.findById(idOf(1))).toBeNull();
    expect(await b.repositories.markets.list({ statuses: ["draft"], limit: 10, beforeId: null })).toEqual([]);
    expect(await b.repositories.markets.update(market(1, { version: 2 }), { status: "draft", version: 1 })).toBe(false);
    expect((await a.repositories.markets.findById(idOf(1)))?.version).toBe(1);
  });
});

describe("MemoryStore, markets", () => {
  it("refuses a duplicate id and a market of another tenant, as the schema's key and the tenant's own table would", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    await a.repositories.markets.insert(market(1));

    await expect(a.repositories.markets.insert(market(1))).rejects.toThrow("exists already");
    await expect(a.repositories.markets.insert(market(2, {}, TENANT_B))).rejects.toThrow("belongs to tenant");
    expect(store.snapshot().markets).toHaveLength(1);
  });

  it("lists newest first (id descending), by status, after a cursor id and up to the limit", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    const statuses: MarketStatus[] = ["draft", "open", "open", "closed", "open"];
    for (const [index, status] of statuses.entries()) await a.repositories.markets.insert(market(index + 1, { status }));

    const ids = async (query: { statuses: MarketStatus[]; limit: number; beforeId: string | null }) => (await a.repositories.markets.list(query)).map((m) => m.id);

    expect(await ids({ statuses: ["draft", "open", "closed"], limit: 10, beforeId: null })).toEqual([5, 4, 3, 2, 1].map(idOf));
    expect(await ids({ statuses: ["open"], limit: 10, beforeId: null })).toEqual([5, 3, 2].map(idOf));
    expect(await ids({ statuses: ["open"], limit: 2, beforeId: null })).toEqual([5, 3].map(idOf));
    expect(await ids({ statuses: ["open"], limit: 10, beforeId: idOf(3) })).toEqual([idOf(2)]);
    expect(await ids({ statuses: ["resolved"], limit: 10, beforeId: null })).toEqual([]);
  });

  it("updates only when the stored status and version are the expected ones", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    const draft = market(1);
    await a.repositories.markets.insert(draft);
    const opening = beginOpening(draft, at(5));

    expect(await a.repositories.markets.update(opening, { status: "draft", version: 2 })).toBe(false);
    expect(await a.repositories.markets.update(opening, { status: "open", version: 1 })).toBe(false);
    expect((await a.repositories.markets.findById(draft.id))?.status).toBe("draft");
    expect(await a.repositories.markets.update(opening, { status: "draft", version: 1 })).toBe(true);
    expect(await a.repositories.markets.update(opening, { status: "draft", version: 1 })).toBe(false);
    expect(await a.repositories.markets.findById(draft.id)).toEqual(opening);
  });

  it("hands out copies: changing a returned market changes nothing in the store", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    await a.repositories.markets.insert(market(1));

    const read = await a.repositories.markets.findById(idOf(1));
    (read as { question: string }).question = "changed";
    read?.closeTime.setUTCFullYear(2030);

    const again = await a.repositories.markets.findById(idOf(1));
    expect(again?.question).toBe("Will the bridge open in time?");
    expect(again?.closeTime.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(store.snapshot().markets[0]?.question).toBe("Will the bridge open in time?");
  });

  it("snapshot is a deep copy", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    await a.repositories.markets.insert(market(1));

    store.snapshot().markets.length = 0;

    expect(store.snapshot().markets).toHaveLength(1);
  });
});

describe("MemoryStore, transactions", () => {
  it("commits what the callback wrote, and leaves nothing behind when it fails", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);

    await a.transaction(async (repositories) => {
      await repositories.markets.insert(market(1));
      await repositories.outbox.add(message("event-1", 1));
    });
    await expect(
      a.transaction(async (repositories) => {
        await repositories.markets.insert(market(2));
        await repositories.outbox.add(message("event-2", 2));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const state = store.snapshot();
    expect(state.markets.map((m) => m.id)).toEqual([idOf(1)]);
    expect(state.outbox.map((row) => row.id)).toEqual(["event-1"]);
  });

  it("runs the shared transaction (outbox, inbox, registry) as one unit too", async () => {
    const store = new MemoryStore();

    await expect(
      store.transaction(async (repositories) => {
        await repositories.tenants.provision(TENANT_A, NOW);
        await repositories.inbox.record({ consumer: "c", eventId: "e", eventType: "t", processedAt: NOW });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(store.snapshot()).toMatchObject({ tenants: [], inbox: [] });
  });

  it("runs transactions one by one, so two that read and then write lose no update", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    const counted = async (id: number) =>
      a.transaction(async (repositories) => {
        const seen = (await repositories.markets.list({ statuses: ["draft"], limit: 10, beforeId: null })).length;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await repositories.markets.insert(market(id, { version: seen + 1 }));
        return seen;
      });

    const seen = await Promise.all([counted(1), counted(2), counted(3)]);

    expect(seen).toEqual([0, 1, 2]);
    expect(store.snapshot().markets.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("makes a call outside a transaction wait for the one in progress, so that its write is not lost", async () => {
    const store = new MemoryStore();
    const a = await tenantOf(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = a.transaction(async (repositories) => {
      await repositories.outbox.add(message("inside", 1));
      await gate;
    });
    let outsideDone = false;
    const outside = store.repositories.outbox.add(message("outside", 2)).then(() => (outsideDone = true));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outsideDone).toBe(false);
    release();
    await Promise.all([running, outside]);

    expect(store.snapshot().outbox.map((row) => row.id).sort()).toEqual(["inside", "outside"]);
  });

  it("keeps working after a failed transaction", async () => {
    const store = new MemoryStore();
    await expect(store.transaction(() => Promise.reject(new Error("first")))).rejects.toThrow("first");

    await expect(store.transaction(() => Promise.resolve("second"))).resolves.toBe("second");
    await expect(store.ping()).resolves.toBeUndefined();
  });
});

describe("MemoryStore, outbox and inbox", () => {
  it("claims unpublished rows oldest first, as copies, up to the limit", async () => {
    const store = new MemoryStore();
    await store.repositories.outbox.add(message("late", 30));
    await store.repositories.outbox.add(message("early", 10));
    await store.repositories.outbox.add(message("middle", 20));

    const claimed = await store.repositories.outbox.claimBatch(2);
    claimed[0]!.attempts = 99;

    expect(claimed.map((row) => row.id)).toEqual(["early", "middle"]);
    expect(store.snapshot().outbox.find((row) => row.id === "early")?.attempts).toBe(0);
  });

  it("marks published and failed rows, and purges only published rows older than the cut-off", async () => {
    const store = new MemoryStore();
    for (const [id, seconds] of [["a", 1], ["b", 2], ["c", 3], ["d", 4]] as const) await store.repositories.outbox.add(message(id, seconds));

    await store.repositories.outbox.markPublished("a", at(100));
    await store.repositories.outbox.markPublished("b", at(200));
    await store.repositories.outbox.markPublished("missing", at(1));
    await store.repositories.outbox.markFailed("c", "broker down");
    await store.repositories.outbox.markFailed("c", "broker down again");
    await store.repositories.outbox.markFailed("missing", "x");

    expect((await store.repositories.outbox.claimBatch(10)).map((row) => row.id)).toEqual(["c", "d"]);
    expect(store.snapshot().outbox.find((row) => row.id === "c")).toMatchObject({ attempts: 2, lastError: "broker down again" });
    expect(await store.repositories.outbox.purgePublished(at(150))).toBe(1);
    expect(store.snapshot().outbox.map((row) => row.id)).toEqual(["b", "c", "d"]);
  });

  it("records an inbox entry once per consumer and event id, and purges the old ones", async () => {
    const store = new MemoryStore();
    const entry = (consumer: string, eventId: string, seconds: number) => ({ consumer, eventId, eventType: "t", processedAt: at(seconds) });

    expect(await store.repositories.inbox.record(entry("tenant-created", "e1", 10))).toBe(true);
    expect(await store.repositories.inbox.record(entry("tenant-created", "e1", 99))).toBe(false);
    expect(await store.repositories.inbox.record(entry("other", "e1", 20))).toBe(true);
    expect(await store.repositories.inbox.record(entry("tenant-created", "e2", 30))).toBe(true);

    expect(await store.repositories.inbox.purge(at(25))).toBe(2);
    expect(store.snapshot().inbox.map((row) => `${row.consumer}/${row.eventId}`)).toEqual(["tenant-created/e2"]);
  });
});

describe("MemoryStore, pending openings", () => {
  it("adds a row due now with attempts 0, and refuses an unregistered tenant and a second row for the same market", async () => {
    const store = new MemoryStore();
    await tenantOf(store);

    await expect(store.repositories.pendingOpenings.add(pendingRow(1, 0, 60, TENANT_B))).rejects.toThrow("not registered");
    await store.repositories.pendingOpenings.add(pendingRow(1, 0, 60));
    await expect(store.repositories.pendingOpenings.add(pendingRow(1, 5, 65))).rejects.toThrow("pending opening already");

    expect(store.snapshot().pendingOpenings).toEqual([
      { tenantId: TENANT_A, marketId: idOf(1), correlationId: "c", causationId: "k", attempts: 0, nextAttemptAt: at(0), leaseUntil: at(60), lastError: null, createdAt: at(0) },
    ]);
  });

  it("claims rows that are due and not leased, earliest due first, and leases them in the same step", async () => {
    const store = new MemoryStore();
    await tenantOf(store);
    const pending = store.repositories.pendingOpenings;
    await pending.add(pendingRow(1, 30, 0)); // due at 30
    await pending.add(pendingRow(2, 10, 0)); // due at 10
    await pending.add(pendingRow(3, 20, 0)); // due at 20
    await pending.add(pendingRow(4, 5, 500)); // leased until 500
    await pending.add(pendingRow(5, 900, 0)); // due at 900

    const first = await pending.claim(2, at(1000), at(100));

    expect(first.map((row) => row.marketId)).toEqual([idOf(2), idOf(3)]);
    expect(first.every((row) => row.leaseUntil?.getTime() === at(1000).getTime())).toBe(true);
    const second = await pending.claim(5, at(1100), at(100));
    expect(second.map((row) => row.marketId)).toEqual([idOf(1)]);
    expect(await pending.claim(5, at(1200), at(100))).toEqual([]);
  });

  it("makes a row claimable again when its lease has ended, and reschedule clears the lease and counts the attempt", async () => {
    const store = new MemoryStore();
    await tenantOf(store);
    const pending = store.repositories.pendingOpenings;
    await pending.add(pendingRow(1, 0, 60));

    expect(await pending.claim(5, at(200), at(59))).toEqual([]);
    expect((await pending.claim(5, at(200), at(60))).map((row) => row.marketId)).toEqual([idOf(1)]);
    expect(await pending.claim(5, at(300), at(100))).toEqual([]);

    await pending.reschedule(TENANT_A, idOf(1), at(400), "timeout");
    await pending.reschedule(TENANT_A, idOf(99), at(400), "no such row");

    expect(store.snapshot().pendingOpenings).toEqual([expect.objectContaining({ attempts: 1, nextAttemptAt: at(400), leaseUntil: null, lastError: "timeout" })]);
    expect(await pending.claim(5, at(500), at(399))).toEqual([]);
    expect((await pending.claim(5, at(500), at(400))).map((row) => row.attempts)).toEqual([1]);
  });

  it("removes a row, and does not complain about one that is gone", async () => {
    const store = new MemoryStore();
    await tenantOf(store);
    const pending = store.repositories.pendingOpenings;
    await pending.add(pendingRow(1, 0, 60));
    await pending.add(pendingRow(2, 0, 60));

    await pending.remove(TENANT_A, idOf(1));
    await pending.remove(TENANT_A, idOf(1));

    expect(store.snapshot().pendingOpenings.map((row) => row.marketId)).toEqual([idOf(2)]);
  });

  it("two concurrent claims never return the same row", async () => {
    const store = new MemoryStore();
    await tenantOf(store);
    for (let n = 1; n <= 6; n += 1) await store.repositories.pendingOpenings.add(pendingRow(n, n, 0));

    const [first, second] = await Promise.all([
      store.repositories.pendingOpenings.claim(4, at(1000), at(100)),
      store.repositories.pendingOpenings.claim(4, at(1000), at(100)),
    ]);

    const all = [...first, ...second].map((row) => row.marketId);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
  });
});
