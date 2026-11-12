import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetrics } from "../../src/adapters/metrics/metrics.js";
import type { Metrics } from "../../src/adapters/metrics/metrics.js";
import { tenantOfRequest } from "../../src/web/auth.js";
import { TENANT_A } from "../support/fakes.js";
import { asAdmin, asPlatformAdmin, asService, asTrader, call, createHarness, draftMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

// The metrics wired into the real application the way src/main.ts wires them: the tenant label is the tenant of the
// token that the service verified. The convention itself is tested in tests/adapters/metrics.test.ts.

let metrics: Metrics;
let h: Harness;
beforeAll(async () => {
  metrics = createMetrics({ tenantOf: tenantOfRequest });
  h = await createHarness({ metrics });
});
afterAll(async () => {
  await h.app.close();
});

async function counter(labels: Record<string, string>): Promise<number> {
  const metric = metrics.registry.getSingleMetric("http_requests_total");
  const values = metric ? (await metric.get()).values : [];
  return values.filter((sample) => Object.entries(labels).every(([key, value]) => sample.labels[key] === value)).reduce((sum, sample) => sum + sample.value, 0);
}

describe("the metrics of the real application", () => {
  it("counts a request of a tenant under the template of its route and the tenant of its token", async () => {
    const answer = await call(h, "GET", "/v1/markets", { token: asTrader() });
    expect(answer.status).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/markets", status_code: "200", tenant: TENANT_A })).toBe(1);
  });

  it("uses the template for a route with a path parameter, never the market id", async () => {
    const draft = await draftMarket(h);
    const id = String(draft["id"]);
    expect((await call(h, "GET", `/v1/markets/${id}`)).status).toBe(200);
    expect(await counter({ method: "GET", route: "/v1/markets/:id", status_code: "200", tenant: TENANT_A })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(id);
  });

  it("counts the share-link routes of a market under their templates, with the answer's status", async () => {
    const draft = await draftMarket(h, asAdmin("owner-1"));
    const url = `/v1/markets/${String(draft["id"])}/share-links`;
    // A link needs an open market: a draft is a 409.
    const answer = await call(h, "POST", url, { token: asAdmin("owner-1"), body: { type: "members" } });
    expect(answer.status).toBe(409);
    expect(await counter({ method: "POST", route: "/v1/markets/:id/share-links", status_code: "409", tenant: TENANT_A })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(String(draft["id"]));
  });

  it("counts the public lookup under the tenant of the token when there is one, else as none", async () => {
    const lookup = "/v1/shared-markets/lookup";
    const body = { token: "x".repeat(43) };
    await call(h, "POST", lookup, { token: asTrader("viewer-1"), body });
    await call(h, "POST", lookup, { token: null, body });
    expect(await counter({ method: "POST", route: lookup, tenant: TENANT_A })).toBe(1);
    expect(await counter({ method: "POST", route: lookup, tenant: "none" })).toBe(1);
    // The share token is in the body, never in a label.
    expect(await metrics.registry.metrics()).not.toContain(body.token);
  });

  it('counts a service token of the internal surface as the tenant "none": it names no tenant of the platform', async () => {
    const admission = "/v1/internal/share-links/admission";
    await call(h, "POST", admission, { token: asService(), body: { token: "y".repeat(43), userEmail: null, emailVerified: false } });
    expect(await counter({ method: "POST", route: admission, tenant: "none" })).toBe(1);
    expect(await counter({ route: admission, tenant: TENANT_A })).toBe(0);
  });

  it('counts a refused request under the tenant of its token, and a platform admin (no tenant) as "none"', async () => {
    expect((await call(h, "GET", "/v1/markets", { token: asPlatformAdmin() })).status).toBe(403);
    expect(await counter({ method: "GET", route: "/v1/markets", status_code: "403", tenant: "none" })).toBe(1);
    const forbidden = await call(h, "POST", "/v1/markets", { token: asTrader(), body: {} });
    expect(forbidden.status).toBe(403);
    expect(await counter({ method: "POST", route: "/v1/markets", status_code: "403", tenant: TENANT_A })).toBe(1);
  });

  it('counts a request without a token as 401 for the tenant "none"', async () => {
    const answer = await call(h, "GET", "/v1/markets", { token: null });
    expect(answer.status).toBe(401);
    expect(await counter({ method: "GET", route: "/v1/markets", status_code: "401", tenant: "none" })).toBe(1);
  });

  it("never takes the tenant from a header", async () => {
    await call(h, "GET", "/v1/markets", { token: null, headers: { "x-tenant-id": TENANT_A, "x-tenant": TENANT_A } });
    expect(await counter({ route: "/v1/markets", status_code: "401", tenant: TENANT_A })).toBe(0);
  });

  it("counts the probes under their own routes", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect(await counter({ method: "GET", route: "/health/live", status_code: "200", tenant: "none" })).toBe(1);
  });

  it('does not serve /metrics on the API port: the answer is a 404 counted as "unmatched"', async () => {
    const response = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("http_requests_total");
    expect(await counter({ method: "GET", route: "unmatched", status_code: "404", tenant: "none" })).toBe(1);
  });

  it("answers the same without the metrics: the hook is optional", async () => {
    const plain = await createHarness();
    expect((await plain.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await plain.app.close();
  });
});
