import { describe, expect, it } from "vitest";
import { Forbidden, TenantNotReady, ValidationFailed } from "../../src/usecases/errors.js";
import { TENANT_A, TENANT_B, createCore, createDraft, createInput, tenantAdmin, trader } from "./core.js";

describe("CreateMarket", () => {
  it("stores a draft at version 1 with the creator and the tenant of the token, and writes no event", async () => {
    const core = await createCore();

    const market = await core.useCases.createMarket.execute({ actor: tenantAdmin("admin-1"), ...createInput(core) });

    expect(market).toMatchObject({
      id: "00000000-0000-7000-8000-000000000001",
      tenantId: TENANT_A,
      question: "Will the new bridge open before 2027?",
      description: "",
      startingPrice: 0.4,
      fundingAmount: 500,
      status: "draft",
      outcome: null,
      version: 1,
      createdBy: "admin-1",
      createdAt: core.clock.now(),
      updatedAt: core.clock.now(),
      openedAt: null,
    });
    expect(market.closeTime.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    const state = core.store.snapshot();
    expect(state.markets).toEqual([market]);
    expect(state.outbox).toEqual([]);
    expect(state.pendingOpenings).toEqual([]);
    expect(core.logger.lines).toContainEqual(
      expect.objectContaining({ level: "info", fields: expect.objectContaining({ tenantId: TENANT_A, marketId: market.id, correlationId: "corr-admin-1" }) }),
    );
  });

  it("trims the question and the description", async () => {
    const core = await createCore();

    const market = await core.useCases.createMarket.execute({
      actor: tenantAdmin(),
      ...createInput(core, { question: "  Will it rain on Sunday?  ", description: "\n Judged by the national weather service. " }),
    });

    expect(market.question).toBe("Will it rain on Sunday?");
    expect(market.description).toBe("Judged by the national weather service.");
  });

  it("refuses a trader before it looks at the tenant or at the input", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.createMarket.execute({ actor: trader(), ...createInput(core, { question: "short" }) })).rejects.toBeInstanceOf(Forbidden);
    expect(core.store.snapshot().markets).toEqual([]);
  });

  it("answers TenantNotReady (503, Retry-After 5) while the tenant has no schema, before it validates", async () => {
    const core = await createCore({ provision: false });

    await expect(core.useCases.createMarket.execute({ actor: tenantAdmin(), ...createInput(core, { question: "short" }) })).rejects.toMatchObject({
      kind: "unavailable",
      code: "tenant_not_ready",
      retryAfterSeconds: 5,
    });
    await expect(core.useCases.createMarket.execute({ actor: tenantAdmin(), ...createInput(core) })).rejects.toBeInstanceOf(TenantNotReady);
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ["a question under 10 characters", { question: "Too short" }, "question"],
    ["a question over 200 characters", { question: "q".repeat(201) }, "question"],
    ["a description over 2000 characters", { description: "d".repeat(2001) }, "description"],
    ["a close time without a time zone", { closeTime: "2026-12-01T10:00:00" }, "closeTime"],
    ["a close time inside the minimum lead (5 minutes)", { closeTime: "2026-11-01T10:05:00.000Z" }, "closeTime"],
    ["a close time more than 366 days ahead", { closeTime: "2027-11-03T10:00:00.000Z" }, "closeTime"],
    ["a price of 0.295", { startingPrice: 0.295 }, "startingPrice"],
    ["a price of 1", { startingPrice: 1 }, "startingPrice"],
    ["a price of 0", { startingPrice: 0 }, "startingPrice"],
    ["a funding amount under the minimum", { fundingAmount: 99 }, "fundingAmount"],
    ["a funding amount over the maximum", { fundingAmount: 100_001 }, "fundingAmount"],
    ["a funding amount with decimals", { fundingAmount: 150.5 }, "fundingAmount"],
  ];

  it.each(bad)("rejects %s as a validation error on the right field and stores nothing", async (_name, overrides, field) => {
    const core = await createCore();

    const attempt = core.useCases.createMarket.execute({ actor: tenantAdmin(), ...createInput(core, overrides) });

    await expect(attempt).rejects.toBeInstanceOf(ValidationFailed);
    await expect(attempt).rejects.toMatchObject({ kind: "validation", fields: [expect.objectContaining({ field })] });
    expect(core.store.snapshot().markets).toEqual([]);
  });

  it("accepts the edges: 10 and 200 characters, the minimum and maximum funding, 0.01 and 0.99", async () => {
    const core = await createCore();

    const lowest = await createDraft(core, tenantAdmin(), { question: "q".repeat(10), fundingAmount: 100, startingPrice: 0.01 });
    const highest = await createDraft(core, tenantAdmin(), { question: "q".repeat(200), fundingAmount: 100_000, startingPrice: 0.99 });

    expect([lowest.startingPrice, highest.startingPrice]).toEqual([0.01, 0.99]);
    expect(core.store.snapshot().markets).toHaveLength(2);
  });

  it("reads the limits from the rules source on every request, so a runtime change applies at once", async () => {
    const core = await createCore();
    await expect(core.useCases.createMarket.execute({ actor: tenantAdmin(), ...createInput(core, { fundingAmount: 50_000 }) })).resolves.toMatchObject({ fundingAmount: 50_000 });

    core.rules.rules = { ...core.rules.rules, fundingMax: 1000 };

    await expect(core.useCases.createMarket.execute({ actor: tenantAdmin(), ...createInput(core, { fundingAmount: 50_000 }) })).rejects.toBeInstanceOf(ValidationFailed);
  });

  it("keeps the markets of two tenants apart", async () => {
    const core = await createCore();

    const a = await createDraft(core, tenantAdmin("admin-1", TENANT_A));
    const b = await createDraft(core, tenantAdmin("admin-9", TENANT_B));

    const storeA = await core.store.forTenant(TENANT_A);
    const storeB = await core.store.forTenant(TENANT_B);
    expect(await storeA?.repositories.markets.findById(a.id)).not.toBeNull();
    expect(await storeA?.repositories.markets.findById(b.id)).toBeNull();
    expect(await storeB?.repositories.markets.findById(b.id)).toMatchObject({ tenantId: TENANT_B, createdBy: "admin-9" });
  });
});
