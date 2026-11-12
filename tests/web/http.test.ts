import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_A } from "../support/fakes.js";
import { asAdmin, asPlatformAdmin, asTrader, call, createHarness, draftMarket, expectContract, openedMarket, validMarket } from "../support/harness.js";
import type { Harness } from "../support/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.app.close();
});

const NO_STORE = "private, no-store";

describe("Cache-Control (INF-02)", () => {
  it("is private, no-store on every kind of API answer: 200, 201, 202, 400, 401, 403, 404, 409 and 503", async () => {
    const draft = await draftMarket(h, asAdmin("cache-admin"));
    const open = await openedMarket(h, asAdmin("cache-admin"));
    h.core.funding.mode = "unknown";
    const second = await draftMarket(h, asAdmin("cache-admin"));
    const answers = [
      await call(h, "GET", "/v1/markets"), // 200
      await call(h, "GET", `/v1/markets/${draft["id"]}`), // 200
      await call(h, "POST", "/v1/markets", { body: validMarket(h) }), // 201
      await call(h, "POST", `/v1/markets/${second["id"]}/open`, { token: asAdmin("cache-admin") }), // 202
      await call(h, "GET", "/v1/markets?limit=0"), // 400
      await call(h, "GET", "/v1/markets", { token: null }), // 401
      await call(h, "GET", "/v1/markets", { token: asPlatformAdmin() }), // 403
      await call(h, "GET", "/v1/markets/018f3c1e-7a00-7000-8000-0000000000f4"), // 404
      await call(h, "POST", `/v1/markets/${open["id"]}/open`, { token: asAdmin("cache-admin") }), // 409
      await call(h, "GET", "/v1/markets", { token: asAdmin("someone", "018f3c1e-7a00-7000-8000-0000000000cc") }), // 503
      await call(h, "GET", "/v1/nothing-here"), // 404 of an unknown path
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 201, 202, 400, 401, 403, 404, 409, 503, 404]);
    for (const answer of answers) expect(answer.headers["cache-control"], `status ${answer.status}`).toBe(NO_STORE);
    h.core.funding.mode = "funded";
  });

  it("also covers the answers Fastify gives before a route matches: a path parameter that is far too long", async () => {
    const answer = await call(h, "GET", `/v1/markets/${"a".repeat(600)}`);
    expect(answer.status).toBe(414);
    expect(answer.headers["content-type"]).toContain("application/problem+json");
    expect(answer.headers["cache-control"]).toBe(NO_STORE);
    // The detail is a fixed text; Fastify's own message repeats the whole URL.
    expect(answer.body).toMatchObject({ code: "uri_too_long", detail: "A path parameter is too long" });
  });

  it("is left off the health probes, which carry no tenant data", async () => {
    for (const probe of ["startup", "ready", "live"]) {
      const answer = await h.app.inject({ method: "GET", url: `/health/${probe}` });
      expect(answer.headers["cache-control"], probe).toBeUndefined();
    }
  });
});

describe("problem details (RFC 9457)", () => {
  it("answers an unknown path with a 404 problem and an unsupported method with a 404 problem too", async () => {
    const unknown = await call(h, "GET", "/v1/unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ status: 404, code: "not_found", instance: "/v1/unknown" });
    const put = await h.app.inject({ method: "PUT", url: "/v1/markets", headers: await h.bearer(asAdmin()) });
    expect(put.statusCode).toBe(404);
    expect(put.headers["content-type"]).toContain("application/problem+json");
  });

  it("keeps the query out of the problem's instance and answers with the stable type of the code", async () => {
    const answer = await call(h, "GET", "/v1/markets?limit=0");
    expect(answer.body).toMatchObject({ instance: "/v1/markets", type: "urn:chance:problem:validation-failed", title: "Bad Request" });
  });

  it("never leaks an internal error: a failing use case answers 500 with a fixed text and is logged", async () => {
    const failing = await createHarness();
    failing.core.useCases.listMarkets.execute = () => Promise.reject(new Error("database password is hunter2"));
    const answer = await call(failing, "GET", "/v1/markets");
    expect(answer.status).toBe(500);
    expect(answer.body).toMatchObject({ status: 500, code: "internal_error", detail: "The service failed to handle the request" });
    expect(JSON.stringify(answer.body)).not.toContain("hunter2");
    await failing.app.close();
  });
});

describe("correlation", () => {
  it("returns the correlation id the caller sent and puts it into the events", async () => {
    const draft = await draftMarket(h, asAdmin("corr-admin"));
    const opened = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token: asAdmin("corr-admin"), headers: { "x-correlation-id": "trace-abc.123" } });
    expect(opened.headers["x-correlation-id"]).toBe("trace-abc.123");
    const event = h.core.store.snapshot().outbox.find((row) => row.aggregateId === draft["id"]);
    expect(event?.payload).toMatchObject({ correlationid: "trace-abc.123", tenantid: TENANT_A });
  });

  it("generates a UUID when none is sent or when the value is not acceptable, also on errors", async () => {
    const none = await call(h, "GET", "/v1/markets");
    expect(none.headers["x-correlation-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const odd = await call(h, "GET", "/v1/markets", { headers: { "x-correlation-id": "bad value with spaces\u0000" } });
    expect(odd.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const unauthorized = await call(h, "GET", "/v1/markets", { token: null, headers: { "x-correlation-id": "on-a-401" } });
    expect(unauthorized.headers["x-correlation-id"]).toBe("on-a-401");
  });

  it("binds the correlation id, the user and the tenant to the request log", async () => {
    await call(h, "GET", "/v1/markets", { token: asTrader("log-user"), headers: { "x-correlation-id": "log-corr-1" } });
    const lines = h.logLines.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line["correlationId"] === "log-corr-1" && line["userId"] === "log-user" && line["tenantId"] === TENANT_A)).toBe(true);
  });
});

describe("health", () => {
  it("answers the three probes without a token, as the contract says", async () => {
    for (const [probe, path] of [
      ["startup", "/health/startup"],
      ["ready", "/health/ready"],
      ["live", "/health/live"],
    ] as const) {
      const answer = await call(h, "GET", `/health/${probe}`, { token: null });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ status: "up" });
      expectContract(path, "GET", answer);
    }
  });

  it("is not ready when the database does not answer, and still alive", async () => {
    const own = await createHarness();
    own.core.store.ping = () => Promise.reject(new Error("the database is down"));
    const ready = await call(own, "GET", "/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "not_ready" });
    expectContract("/health/ready", "GET", ready);
    expect((await call(own, "GET", "/health/live", { token: null })).status).toBe(200);
    await own.app.close();
  });

  it("turns not ready as soon as the process drains (SIGTERM), while the other probes and the API keep answering", async () => {
    const own = await createHarness();
    own.setDraining(true);
    const ready = await call(own, "GET", "/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "shutting_down" });
    expectContract("/health/ready", "GET", ready);
    expect((await call(own, "GET", "/health/live", { token: null })).status).toBe(200);
    expect((await call(own, "GET", "/health/startup", { token: null })).status).toBe(200);
    expect((await call(own, "GET", "/v1/markets")).status).toBe(200);
    await own.app.close();
  });

  it("does not ask the database while draining", async () => {
    const own = await createHarness();
    let asked = 0;
    own.core.store.ping = () => {
      asked += 1;
      return Promise.resolve();
    };
    own.setDraining(true);
    await call(own, "GET", "/health/ready", { token: null });
    expect(asked).toBe(0);
    await own.app.close();
  });
});
