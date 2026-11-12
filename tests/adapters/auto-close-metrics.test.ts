import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { AutoCloseWorker } from "../../src/adapters/auto-close/worker.js";
import { AUTO_CLOSE_METRIC, AUTO_CLOSE_OUTCOMES, MeteredCloseDueMarkets, createAutoCloseCounter } from "../../src/adapters/metrics/auto-close-metrics.js";
import { CloseDueMarkets } from "../../src/usecases/close-due-markets.js";
import type { CloseDueMarketsInput, CloseDueMarketsResult, CloseDueMarketsUseCase } from "../../src/usecases/use-cases.js";
import { closeTimeIn } from "../support/fakes.js";
import { TENANT_A, TENANT_B, createCore, createDraft, failingOutboxFor, tenantAdmin } from "../usecases/core.js";

// markets_auto_close_total{outcome}: the one metric that is specific to markets (src/adapters/metrics/auto-close-metrics.ts).

async function values(registry: Registry): Promise<Record<string, number>> {
  const metric = registry.getSingleMetric(AUTO_CLOSE_METRIC);
  if (!metric) throw new Error(`no metric ${AUTO_CLOSE_METRIC}`);
  const found: Record<string, number> = {};
  for (const sample of (await metric.get()).values) found[String(sample.labels["outcome"])] = sample.value;
  return found;
}

class ScriptedClose implements CloseDueMarketsUseCase {
  behaviour: (input: CloseDueMarketsInput) => CloseDueMarketsResult = () => ({ closed: 0, failed: 0, more: false });
  // Like the real use case, the answer (or the failure) comes through the promise, also when the script throws at once.
  execute(input: CloseDueMarketsInput): Promise<CloseDueMarketsResult> {
    return Promise.resolve().then(() => this.behaviour(input));
  }
}

const input: CloseDueMarketsInput = { tenantId: TENANT_A, limit: 50 };

describe("createAutoCloseCounter", () => {
  it("registers the counter with exactly the three outcomes, each at 0, so that rate() has a series from the start", async () => {
    const registry = new Registry();
    createAutoCloseCounter(registry);
    expect(await values(registry)).toEqual({ closed: 0, market_failed: 0, tenant_failed: 0 });
    expect([...AUTO_CLOSE_OUTCOMES]).toEqual(["closed", "market_failed", "tenant_failed"]);
    expect(await registry.metrics()).toContain(`# TYPE ${AUTO_CLOSE_METRIC} counter`);
  });
});

describe("MeteredCloseDueMarkets", () => {
  function setup() {
    const registry = new Registry();
    const inner = new ScriptedClose();
    return { registry, inner, metered: new MeteredCloseDueMarkets(inner, createAutoCloseCounter(registry)) };
  }

  it("adds the markets closed and the markets that failed, and returns the result as it is", async () => {
    const { registry, inner, metered } = setup();
    inner.behaviour = () => ({ closed: 3, failed: 2, more: false });
    expect(await metered.execute(input)).toEqual({ closed: 3, failed: 2, more: false });
    inner.behaviour = () => ({ closed: 1, failed: 0, more: true });
    expect(await metered.execute(input)).toEqual({ closed: 1, failed: 0, more: true });
    expect(await values(registry)).toEqual({ closed: 4, market_failed: 2, tenant_failed: 0 });
  });

  it("counts nothing for a tenant with nothing due", async () => {
    const { registry, metered } = setup();
    await metered.execute(input);
    expect(await values(registry)).toEqual({ closed: 0, market_failed: 0, tenant_failed: 0 });
  });

  it("counts a tenant whose markets could not be read and throws the same error again", async () => {
    const { registry, inner, metered } = setup();
    const failure = new Error("the schema of the tenant is missing");
    inner.behaviour = () => {
      throw failure;
    };
    await expect(metered.execute(input)).rejects.toBe(failure);
    expect(await values(registry)).toEqual({ closed: 0, market_failed: 0, tenant_failed: 1 });
  });

  it("never puts a tenant id or a market id into a label", async () => {
    const { registry, inner, metered } = setup();
    inner.behaviour = () => ({ closed: 1, failed: 1, more: false });
    await metered.execute({ tenantId: TENANT_B, limit: 5 });
    const text = await registry.metrics();
    expect(text).not.toContain(TENANT_B);
    expect(text).not.toMatch(/tenant="|tenantId|marketId/);
  });
});

describe("the automatic close of the real use case, counted through the worker", () => {
  it("counts the markets closed and the one that failed, over two tenants", async () => {
    const core = await createCore();
    const open = async (tenantId: string) => {
      const by = tenantAdmin("admin-1", tenantId);
      const draft = await createDraft(core, by, { closeTime: closeTimeIn(core.clock, 2) });
      const { market } = await core.useCases.openMarket.execute({ actor: by, marketId: draft.id });
      return market;
    };
    const okA = await open(TENANT_A);
    const brokenA = await open(TENANT_A);
    const okB = await open(TENANT_B);
    core.clock.advanceMs(3 * 3_600_000);

    const registry = new Registry();
    const close = new MeteredCloseDueMarkets(new CloseDueMarkets({ ...core.deps, store: failingOutboxFor(core.store, brokenA.id) }), createAutoCloseCounter(registry));
    const worker = new AutoCloseWorker({ store: core.store, close, logger: core.logger, settings: () => ({ enabled: true, intervalMs: 5 }) });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ closed: 2, failedMarkets: 1, failedTenants: 0 });
    expect(await values(registry)).toEqual({ closed: 2, market_failed: 1, tenant_failed: 0 });
    const statuses = new Map(core.store.snapshot().markets.map((market) => [market.id, market.status]));
    expect(statuses.get(okA.id)).toBe("closed");
    expect(statuses.get(okB.id)).toBe("closed");
    expect(statuses.get(brokenA.id)).toBe("open");
  });
});
