import { describe, expect, it } from "vitest";
import type { Market } from "../../src/domain/market.js";
import { Forbidden, NotFound, TenantNotReady, ValidationFailed } from "../../src/usecases/errors.js";
import { decodeCursor } from "../../src/usecases/support.js";
import { TENANT_B, createCore, createClosedMarket, createDraft, createOpenMarket, tenantAdmin, trader } from "./core.js";
import type { Core } from "./core.js";

/** One market in every status: draft, opening, open, closed, resolved; created in this order, so ids grow in this order. */
async function marketsInEveryStatus(core: Core) {
  const admin = tenantAdmin();
  const draft = await createDraft(core, admin);
  core.funding.enqueue({ kind: "unknown", reason: "timeout" });
  const opening = (await core.useCases.openMarket.execute({ actor: admin, marketId: (await createDraft(core, admin)).id })).market;
  const open = await createOpenMarket(core, admin);
  const closed = await createClosedMarket(core, admin);
  const resolvedBase = await createClosedMarket(core, admin);
  const resolved = await core.useCases.resolveMarket.execute({ actor: admin, marketId: resolvedBase.id, outcome: "YES" });
  return { draft, opening, open, closed, resolved };
}

const idsOf = (markets: Market[]) => markets.map((market) => market.id);

describe("ListMarkets", () => {
  it("shows a tenant admin every status, newest first", async () => {
    const core = await createCore();
    const { draft, opening, open, closed, resolved } = await marketsInEveryStatus(core);

    const page = await core.useCases.listMarkets.execute({ actor: tenantAdmin() });

    expect(idsOf(page.items)).toEqual([resolved.id, closed.id, open.id, opening.id, draft.id].sort().reverse());
    expect(page.items.map((market) => market.status).sort()).toEqual(["closed", "draft", "open", "opening", "resolved"]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves draft and opening markets out of a trader's list", async () => {
    const core = await createCore();
    const { open, closed, resolved } = await marketsInEveryStatus(core);

    const page = await core.useCases.listMarkets.execute({ actor: trader() });

    expect(idsOf(page.items)).toEqual([resolved.id, closed.id, open.id].sort().reverse());
  });

  it("filters by one status, for the admin and for the trader", async () => {
    const core = await createCore();
    const { draft, open } = await marketsInEveryStatus(core);

    expect(idsOf((await core.useCases.listMarkets.execute({ actor: tenantAdmin(), status: "draft" })).items)).toEqual([draft.id]);
    expect(idsOf((await core.useCases.listMarkets.execute({ actor: tenantAdmin(), status: "opening" })).items)).toHaveLength(1);
    expect(idsOf((await core.useCases.listMarkets.execute({ actor: trader(), status: "open" })).items)).toEqual([open.id]);
  });

  it.each(["draft", "opening"] as const)("refuses a trader who asks for %s markets with 403, before any read", async (status) => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.listMarkets.execute({ actor: trader(), status })).rejects.toBeInstanceOf(Forbidden);
  });

  it("pages with a cursor: a page of two, then the rest, with no market twice", async () => {
    const core = await createCore();
    const created: Market[] = [];
    for (let index = 0; index < 5; index += 1) created.push(await createDraft(core));
    const newestFirst = idsOf(created).reverse();

    const first = await core.useCases.listMarkets.execute({ actor: tenantAdmin(), limit: 2 });
    const second = await core.useCases.listMarkets.execute({ actor: tenantAdmin(), limit: 2, cursor: first.nextCursor ?? undefined });
    const third = await core.useCases.listMarkets.execute({ actor: tenantAdmin(), limit: 2, cursor: second.nextCursor ?? undefined });

    expect(idsOf(first.items)).toEqual(newestFirst.slice(0, 2));
    expect(idsOf(second.items)).toEqual(newestFirst.slice(2, 4));
    expect(idsOf(third.items)).toEqual(newestFirst.slice(4));
    expect(first.nextCursor).not.toBeNull();
    expect(decodeCursor(first.nextCursor ?? undefined)).toBe(newestFirst[1]);
    expect(third.nextCursor).toBeNull();
  });

  it("returns an empty page for a tenant without markets", async () => {
    const core = await createCore();

    await expect(core.useCases.listMarkets.execute({ actor: tenantAdmin() })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "not-a-cursor" }])("rejects the page input %j with a validation error", async (page) => {
    const core = await createCore();

    await expect(core.useCases.listMarkets.execute({ actor: tenantAdmin(), ...page })).rejects.toBeInstanceOf(ValidationFailed);
  });

  it("never shows another tenant's markets", async () => {
    const core = await createCore();
    await createDraft(core, tenantAdmin("admin-1"));
    const other = await createOpenMarket(core, tenantAdmin("admin-9", TENANT_B));

    const forB = await core.useCases.listMarkets.execute({ actor: trader("t-9", TENANT_B) });
    const forA = await core.useCases.listMarkets.execute({ actor: tenantAdmin() });

    expect(idsOf(forB.items)).toEqual([other.id]);
    expect(idsOf(forA.items)).not.toContain(other.id);
  });

  it("answers TenantNotReady while the tenant has no schema", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.listMarkets.execute({ actor: tenantAdmin() })).rejects.toBeInstanceOf(TenantNotReady);
  });
});

describe("GetMarket", () => {
  it("returns any market to a tenant admin, a draft included", async () => {
    const core = await createCore();
    const draft = await createDraft(core);

    await expect(core.useCases.getMarket.execute({ actor: tenantAdmin("admin-2"), marketId: draft.id })).resolves.toEqual(draft);
  });

  it("returns open, closed and resolved markets to a trader", async () => {
    const core = await createCore();
    const { open, closed, resolved } = await marketsInEveryStatus(core);

    for (const market of [open, closed, resolved]) {
      await expect(core.useCases.getMarket.execute({ actor: trader(), marketId: market.id })).resolves.toEqual(market);
    }
  });

  it("answers 404 to a trader for a draft and for an opening market, exactly as for a missing one", async () => {
    const core = await createCore();
    const { draft, opening } = await marketsInEveryStatus(core);

    for (const id of [draft.id, opening.id, "00000000-0000-7000-8000-0000000000ff"]) {
      await expect(core.useCases.getMarket.execute({ actor: trader(), marketId: id })).rejects.toEqual(new NotFound());
    }
  });

  it("answers 404 for a market of another tenant", async () => {
    const core = await createCore();
    const mine = await createOpenMarket(core, tenantAdmin("admin-1"));

    await expect(core.useCases.getMarket.execute({ actor: tenantAdmin("admin-9", TENANT_B), marketId: mine.id })).rejects.toBeInstanceOf(NotFound);
    await expect(core.useCases.getMarket.execute({ actor: trader("t-9", TENANT_B), marketId: mine.id })).rejects.toBeInstanceOf(NotFound);
  });

  it("answers TenantNotReady while the tenant has no schema", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.getMarket.execute({ actor: trader(), marketId: "00000000-0000-7000-8000-000000000001" })).rejects.toBeInstanceOf(TenantNotReady);
  });
});
