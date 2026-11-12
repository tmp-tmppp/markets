import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TradingFundingClient } from "../../src/adapters/trading/trading-funding-client.js";
import { marketClosedEvent, marketOpenedEvent, marketResolvedEvent, natsSubject } from "../../src/domain/events.js";
import type { EventName } from "../../src/domain/events.js";
import type { Market } from "../../src/domain/market.js";
import type { FundingRequest } from "../../src/usecases/ports.js";
import { asyncapi, documentedFundingStatuses, eventErrors, fundingContract, fundingRequestErrors, openapi } from "../support/contracts.js";
import { asAdmin, call, closedMarket, createHarness } from "../support/harness.js";
import { TENANT_A } from "../support/fakes.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

describe("contracts/openapi.yaml", () => {
  it("lists exactly the routes the application registers", async () => {
    const harness = await createHarness();
    const registered = harness.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    const documented = Object.entries(openapi["paths"] as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).filter((key) => METHODS.includes(key)).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    await harness.app.close();

    expect(registered).toHaveLength(14);
    expect(registered).toEqual(documented);
  });

  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(openapi["components"].securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(openapi["security"]).toEqual([{ bearerAuth: [] }]);

    const ids: string[] = [];
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { operationId?: string }>>)) {
      for (const [method, operation] of Object.entries(item)) if (METHODS.includes(method)) ids.push(operation.operationId ?? "");
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], openapi);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("leaves only the health probes without a security requirement", () => {
    const open: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[] }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.includes(method) && Array.isArray(operation.security) && operation.security.length === 0) open.push(path);
      }
    }
    expect(open.sort()).toEqual(["/health/live", "/health/ready", "/health/startup"]);
  });

  it("documents 503 with a Retry-After header on every authenticated operation, through one shared response", () => {
    const shared = openapi["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const authenticated: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[]; responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        authenticated.push(`${method.toUpperCase()} ${path}`);
        expect(operation.responses["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      }
    }
    // The six market operations, the three share-link operations of a member, the lookup (optional token) and the admission.
    expect(authenticated).toHaveLength(11);
  });

  it("documents the problem+json answer of every error status", () => {
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;
          const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
          expect(Object.keys(resolved.content), `${method} ${status}`).toEqual(["application/problem+json"]);
        }
      }
    }
  });

  it("documents Cache-Control on every success answer of the API, and the opening answers 200, 202, 409, 502 and 503", () => {
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[]; responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith("2")) continue;
          expect(response.headers?.["Cache-Control"], `${method} ${path} ${status}`).toEqual({ $ref: "#/components/headers/CacheControl" });
        }
      }
    }
    const open = openapi["paths"]["/v1/markets/{id}/open"].post.responses as Record<string, unknown>;
    expect(Object.keys(open).sort()).toEqual(["200", "202", "400", "401", "403", "404", "409", "502", "503"]);
  });
});

describe("contracts/asyncapi.yaml", () => {
  const ctx = { eventId: "018f3c1e-7a00-7000-8000-000000000001", now: new Date("2026-11-01T10:00:00.000Z"), correlationId: "corr-1", causationId: "req-1" };
  const market = (status: Market["status"], extra: Partial<Market> = {}): Market => ({
    id: "018f3c1e-7a00-7000-8000-000000000011",
    tenantId: TENANT_A,
    question: "Will the new bridge open before 2027?",
    description: "",
    closeTime: new Date("2026-12-01T10:00:00.000Z"),
    startingPrice: 0.4,
    fundingAmount: 500,
    status,
    outcome: null,
    version: 3,
    createdBy: "admin-1",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    openedAt: ctx.now,
    closedAt: null,
    closedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    sharing: { whoMayShare: "members", linkTypes: ["members"] },
    ...extra,
  });

  it("is AsyncAPI 3.0 with one channel and one send operation per published event, and the consumed TenantCreated", () => {
    expect(asyncapi["asyncapi"]).toMatch(/^3\.0\./);
    const names: EventName[] = ["MarketOpened", "MarketClosed", "MarketResolved", "ShareLinkCreated", "ShareLinkRevoked"];
    const channels = Object.values(asyncapi["channels"] as Record<string, { address: string }>).map((channel) => channel.address).sort();
    expect(channels).toEqual([...names.map((name) => natsSubject(name, "{tenantId}")), "chance.tenants.TenantCreated.{tenantId}"].sort());
    const actions = Object.values(asyncapi["operations"] as Record<string, { action: string }>).map((operation) => operation.action).sort();
    expect(actions).toEqual(["receive", "send", "send", "send", "send", "send"]);
  });

  it("accepts what the three event builders produce", () => {
    expect(eventErrors("MarketOpenedEvent", marketOpenedEvent(market("open"), ctx))).toEqual([]);
    const closed = market("closed", { closedAt: ctx.now, closedBy: "admin-2", version: 4 });
    expect(eventErrors("MarketClosedEvent", marketClosedEvent(closed, ctx))).toEqual([]);
    // UC-15: the automatic close names a fixed system actor; the field stays a string, the contract documents the value.
    const closedByTimer = market("closed", { closedAt: ctx.now, closedBy: "system:auto-close", version: 4 });
    expect(eventErrors("MarketClosedEvent", marketClosedEvent(closedByTimer, ctx))).toEqual([]);
    expect(JSON.stringify(asyncapi)).toContain("system:auto-close");
    expect(JSON.stringify(openapi)).toContain("system:auto-close");
    const resolved = market("resolved", { closedAt: ctx.now, closedBy: "admin-2", resolvedAt: ctx.now, resolvedBy: "admin-2", outcome: "YES", version: 5 });
    expect(eventErrors("MarketResolvedEvent", marketResolvedEvent(resolved, ctx))).toEqual([]);
    // UC-16: INVALID is a valid outcome of MarketResolved.
    expect(eventErrors("MarketResolvedEvent", marketResolvedEvent({ ...resolved, outcome: "INVALID" }, ctx))).toEqual([]);
  });

  it("accepts the events the use cases really write to the outbox, in the order they were written", async () => {
    const h = await createHarness();
    const closed = await closedMarket(h, asAdmin("creator-1"));
    await call(h, "POST", `/v1/markets/${closed["id"]}/resolve`, { token: asAdmin("creator-1"), body: { outcome: "NO" } });

    const bySchema: Record<string, string> = {
      "si.chance.markets.MarketOpened.v1": "MarketOpenedEvent",
      "si.chance.markets.MarketClosed.v1": "MarketClosedEvent",
      "si.chance.markets.MarketResolved.v1": "MarketResolvedEvent",
    };
    const rows = h.core.store.snapshot().outbox;
    expect(rows.map((row) => row.type)).toEqual(Object.keys(bySchema));
    for (const row of rows) {
      expect(eventErrors(bySchema[row.type] ?? "", row.payload), row.type).toEqual([]);
      expect(row.id).toBe(row.payload.id);
      expect(row.subject).toBe(natsSubject(row.type.split(".")[3] as EventName, TENANT_A));
    }
    await h.app.close();
  });

  it("rejects an event that breaks the contract", () => {
    const good = marketOpenedEvent(market("open"), ctx);
    const { tenantid: _removed, ...withoutTenant } = good;
    expect(eventErrors("MarketOpenedEvent", withoutTenant)).not.toEqual([]);
    expect(eventErrors("MarketOpenedEvent", { ...good, specversion: "0.3" })).not.toEqual([]);
    expect(eventErrors("MarketOpenedEvent", { ...good, type: "si.chance.markets.MarketClosed.v1" })).not.toEqual([]);
    // A field the contract does not know, such as the creator's e-mail address, must not slip into the data (DM-14).
    expect(eventErrors("MarketOpenedEvent", { ...good, data: { ...good.data, email: "someone@example.test" } })).not.toEqual([]);
    expect(eventErrors("MarketOpenedEvent", { ...good, id: "not-a-uuid" })).not.toEqual([]);
  });
});

describe("contracts/outgoing/trading-market-funding.openapi.yaml", () => {
  const request: FundingRequest = { marketId: "018f3c1e-7a00-7000-8000-000000000011", tenantId: TENANT_A, creatorId: "admin-1", amount: 500 };

  it("names the trading address the chart calls, on trading's internal port", () => {
    const values = parse(readFileSync(new URL("../../helm/values.yaml", import.meta.url), "utf8")) as { trading: { host: string; port: number } };
    const servers = fundingContract["servers"] as Array<{ url: string }>;
    expect(values.trading.port).toBe(8081);
    expect(servers[0]?.url).toBe(`http://${values.trading.host}:${values.trading.port}`);
  });

  it("tells trading to store only a completed funding under the key, so a refused market can be opened again", () => {
    const description = String((fundingContract["info"] as { description: string }).description).replace(/\s+/g, " ");
    expect(description).toContain("Only a completed funding is stored under the key.");
    expect(description).toContain("409 `insufficient_credits`, and any other refusal");
    expect(description).toContain("is not stored, so a later call with the same key and body is decided anew");
    expect(description).toContain("is opened again with the same key (its id) after the creator topped up");
  });

  /** What the client sends, captured through an injected fetch. */
  async function sentBy(answerStatus = 201) {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchStub = ((url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return Promise.resolve(new Response("{}", { status: answerStatus, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    const client = new TradingFundingClient({
      baseUrl: "http://trading.test:8080",
      tokens: { token: () => Promise.resolve("service-token") },
      policy: { timeoutMs: 1000, retries: 0, circuitFailures: 5, circuitHalfOpenMs: 10_000 },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      fetch: fetchStub,
    });
    const result = await client.fund(request, request.marketId);
    return { seen, result };
  }

  it("sends a body that is valid against MarketFundingRequest, to the documented path, with the Idempotency-Key header", async () => {
    const { seen, result } = await sentBy();
    expect(result).toEqual({ kind: "funded" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`http://trading.test:8080${Object.keys(fundingContract["paths"])[0]}`);
    expect(fundingRequestErrors(seen[0]?.body)).toEqual([]);
    expect(seen[0]?.headers["idempotency-key"]).toBe(request.marketId);
    expect(seen[0]?.headers["idempotency-key"]).toBe((seen[0]?.body as { marketId: string }).marketId);
  });

  it("rejects a body that breaks the contract", () => {
    const body = { ...request };
    expect(fundingRequestErrors(body)).toEqual([]);
    expect(fundingRequestErrors({ ...body, amount: 0 })).not.toEqual([]);
    expect(fundingRequestErrors({ ...body, amount: 1.5 })).not.toEqual([]);
    expect(fundingRequestErrors({ ...body, amount: 1_000_001 })).not.toEqual([]);
    expect(fundingRequestErrors({ ...body, marketId: "not-a-uuid" })).not.toEqual([]);
    expect(fundingRequestErrors({ ...body, email: "someone@example.test" })).not.toEqual([]);
    const { creatorId: _removed, ...withoutCreator } = body;
    expect(fundingRequestErrors(withoutCreator)).not.toEqual([]);
  });

  it("documents every status the client maps by name", () => {
    // 200 and 201 funded; 409 insufficient credits or another code; 400, 401, 403, 404, 422 rejected; 503 retried.
    expect(documentedFundingStatuses().sort()).toEqual([200, 201, 400, 401, 403, 404, 409, 422, 503]);
  });
});
