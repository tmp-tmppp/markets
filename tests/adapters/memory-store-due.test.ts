import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { beginOpening, closeMarket, completeOpening, newMarket } from "../../src/domain/market.js";
import type { Market } from "../../src/domain/market.js";
import { TENANT_A, TENANT_B } from "../support/fakes.js";

const RULES = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 60_000 };
const CREATED = new Date("2026-11-01T10:00:00.000Z");
const HOUR = 3_600_000;
const NOW = new Date(CREATED.getTime() + 10 * HOUR);

function market(n: number, hoursAhead: number, tenantId = TENANT_A, status: "draft" | "open" | "closed" = "open"): Market {
  const draft = newMarket(
    { id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, tenantId, question: "Will the new bridge open before 2027?", closeTime: new Date(CREATED.getTime() + hoursAhead * HOUR).toISOString(), startingPrice: 0.4, fundingAmount: 500, createdBy: "admin-1", now: CREATED },
    RULES,
  );
  if (status === "draft") return draft;
  const open = completeOpening(beginOpening(draft, CREATED), CREATED);
  return status === "open" ? open : closeMarket(open, "admin-1", CREATED);
}

async function seeded() {
  const store = new MemoryStore();
  await store.repositories.tenants.provision(TENANT_B, CREATED);
  await store.repositories.tenants.provision(TENANT_A, CREATED);
  const tenantA = await store.forTenant(TENANT_A);
  const tenantB = await store.forTenant(TENANT_B);
  if (!tenantA || !tenantB) throw new Error("tenants are registered");
  return { store, tenantA, tenantB };
}

describe("MemoryStore: the markets that are due", () => {
  it("lists the registered tenants ordered by id", async () => {
    const { store } = await seeded();

    expect(await store.repositories.tenants.listTenantIds()).toEqual([TENANT_A, TENANT_B]);
  });

  it("claims open markets whose close time has passed, earliest first, up to the limit, and nothing in another status or tenant", async () => {
    const { tenantA, tenantB } = await seeded();
    for (const row of [market(1, 5), market(2, 2), market(3, 8), market(4, 20), market(5, 1, TENANT_A, "closed"), market(6, 1, TENANT_A, "draft")]) await tenantA.repositories.markets.insert(row);
    await tenantB.repositories.markets.insert(market(7, 1, TENANT_B));

    const claimed = await tenantA.transaction((repositories) => repositories.markets.claimDue(NOW, 10, []));

    expect(claimed.map((row) => row.id.slice(-1))).toEqual(["2", "1", "3"]);
    expect((await tenantA.transaction((repositories) => repositories.markets.claimDue(NOW, 2, []))).map((row) => row.id.slice(-1))).toEqual(["2", "1"]);
  });

  it("leaves out the ids in the skip list and breaks ties of the close time by id", async () => {
    const { tenantA } = await seeded();
    for (const row of [market(2, 3), market(1, 3), market(3, 3)]) await tenantA.repositories.markets.insert(row);

    const all = await tenantA.transaction((repositories) => repositories.markets.claimDue(NOW, 10, []));
    const skipped = await tenantA.transaction((repositories) => repositories.markets.claimDue(NOW, 10, [all[0]?.id ?? ""]));

    expect(all.map((row) => row.id.slice(-1))).toEqual(["1", "2", "3"]);
    expect(skipped.map((row) => row.id.slice(-1))).toEqual(["2", "3"]);
  });

  it("answers the cheap probe: true only when an open market is due", async () => {
    const { tenantA, tenantB } = await seeded();
    await tenantA.repositories.markets.insert(market(1, 20));
    await tenantA.repositories.markets.insert(market(2, 1, TENANT_A, "closed"));
    await tenantB.repositories.markets.insert(market(3, 1, TENANT_B));

    expect(await tenantA.repositories.markets.hasDue(NOW)).toBe(false);
    expect(await tenantA.repositories.markets.hasDue(new Date(CREATED.getTime() + 20 * HOUR))).toBe(true);
    expect(await tenantB.repositories.markets.hasDue(NOW)).toBe(true);
  });
});
