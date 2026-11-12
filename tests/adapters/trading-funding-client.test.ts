import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { TokenUnavailable } from "../../src/adapters/trading/token-provider.js";
import type { AccessTokenSource } from "../../src/adapters/trading/token-provider.js";
import { TradingFundingClient } from "../../src/adapters/trading/trading-funding-client.js";
import type { FundingPolicyConfig } from "../../src/config.js";
import type { FundingRequest } from "../../src/usecases/ports.js";
import { RecordingLogger, TENANT_A } from "../support/fakes.js";

// The client against a real HTTP server on 127.0.0.1: what trading answers, in the order it answers, and what reaches it.

interface Scripted {
  status: number;
  body?: unknown;
  /** Text sent as it is (not JSON). */
  text?: string;
  delayMs?: number;
  headers?: Record<string, string>;
}

interface Received {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let baseUrl = "";
const received: Received[] = [];
const script: Scripted[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const next = script.shift() ?? { status: 201, body: { marketId: "x", amount: 1 } };
      const send = () => {
        const text = next.text ?? (next.body === undefined ? "" : JSON.stringify(next.body));
        res.writeHead(next.status, { "content-type": next.text === undefined ? "application/json" : "text/html", ...next.headers });
        res.end(text);
      };
      if (next.delayMs) setTimeout(send, next.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  script.length = 0;
});

const MARKET_ID = "018f3c1e-7a00-7000-8000-000000000001";
const REQUEST: FundingRequest = { marketId: MARKET_ID, tenantId: TENANT_A, creatorId: "admin-1", amount: 500 };
const TOKEN = "service-token-abc";

const POLICY: FundingPolicyConfig = { timeoutMs: 150, retries: 2, circuitFailures: 5, circuitHalfOpenMs: 10_000 };

interface SpyTokens extends AccessTokenSource {
  token: Mock<() => Promise<string>>;
  invalidate: Mock<() => void>;
}

function tokenSource(): SpyTokens {
  return { token: vi.fn(() => Promise.resolve(TOKEN)), invalidate: vi.fn<() => void>() };
}

function makeClient(policy: Partial<FundingPolicyConfig> = {}, tokens: AccessTokenSource = tokenSource(), url = baseUrl) {
  const logger = new RecordingLogger();
  const client = new TradingFundingClient({
    baseUrl: url,
    tokens,
    policy: { ...POLICY, ...policy },
    logger,
    retryInitialDelayMs: 1,
    retryMaxDelayMs: 5,
  });
  return { client, logger };
}

const problem = (status: number, code: string, detail = `detail of ${code}`, type = `urn:chance:problem:${code.replaceAll("_", "-")}`) => ({
  type,
  title: "Problem",
  status,
  detail,
  code,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the request", () => {
  it("POSTs the funding as the outgoing contract describes, with the market id as Idempotency-Key and the bearer token", async () => {
    script.push({ status: 201, body: { marketId: MARKET_ID, amount: 500 } });
    const { client, logger } = makeClient({}, tokenSource(), `${baseUrl}/`);

    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });

    expect(received).toHaveLength(1);
    const [call] = received;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("/v1/internal/market-funding");
    expect(call?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers["idempotency-key"]).toBe(MARKET_ID);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.body ?? "")).toEqual({ marketId: MARKET_ID, tenantId: TENANT_A, creatorId: "admin-1", amount: 500 });
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
  });

  it("logs the tenant, the market, the attempts and the outcome", async () => {
    const { client, logger } = makeClient();
    await client.fund(REQUEST, MARKET_ID);
    expect(logger.lines).toEqual([
      { level: "info", fields: { tenantId: TENANT_A, marketId: MARKET_ID, attempts: 1, outcome: "funded" }, message: "Trading answered the funding call" },
    ]);
  });
});

describe("definitive answers", () => {
  it.each([200, 201])("maps %i to funded", async (status) => {
    script.push({ status, body: { marketId: MARKET_ID, amount: 500 } });
    expect(await makeClient().client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(received).toHaveLength(1);
  });

  it("maps 409 with the problem code insufficient_credits to insufficient_credits", async () => {
    script.push({ status: 409, body: problem(409, "insufficient_credits") });
    const { client, logger } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "insufficient_credits" });
    expect(received).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "info", fields: { outcome: "insufficient_credits" } });
  });

  it("maps 409 with only the problem type of insufficient credits to insufficient_credits", async () => {
    script.push({ status: 409, body: { type: "urn:chance:problem:insufficient-credits", title: "Conflict", status: 409 } });
    expect(await makeClient().client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "insufficient_credits" });
  });

  it("maps 409 with another code, or with no readable body, to rejected", async () => {
    script.push({ status: 409, body: problem(409, "idempotency_conflict", "the key is in use") }, { status: 409, text: "<html>conflict</html>" });
    const { client } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "rejected", status: 409, detail: "the key is in use" });
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "rejected", status: 409, detail: "trading answered 409" });
  });

  it.each([400, 401, 403, 404, 422, 418])("maps %i to rejected with the problem's detail, and does not retry", async (status) => {
    script.push({ status, body: problem(status, "some_problem", `trading says no (${status})`) });
    const { client, logger } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "rejected", status, detail: `trading says no (${status})` });
    expect(received).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({ level: "warn", fields: { tenantId: TENANT_A, marketId: MARKET_ID, status, attempts: 1 } });
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
  });

  it("keeps the detail of a rejection to 200 characters and falls back to the title, then to the status", async () => {
    script.push(
      { status: 400, body: { ...problem(400, "bad"), detail: "x".repeat(500) } },
      { status: 400, body: { title: "Bad Request", status: 400 } },
      { status: 400, text: "not json at all" },
    );
    const { client } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "rejected", detail: "x".repeat(200) });
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "rejected", detail: "Bad Request" });
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "rejected", detail: "trading answered 400" });
  });

  it("forgets the cached token when trading answers 401, so the next call fetches a new one", async () => {
    script.push({ status: 401, body: problem(401, "unauthorized") });
    const tokens = tokenSource();
    expect(await makeClient({}, tokens).client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "rejected", status: 401 });
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
  });

  it.each([202, 204, 302])("treats the unexpected status %i as an unknown outcome and does not follow a redirect", async (status) => {
    script.push({ status, headers: { location: `${baseUrl}/elsewhere` } });
    const { client } = makeClient();
    const result = await client.fund(REQUEST, MARKET_ID);
    expect(result).toEqual({ kind: "unknown", reason: `trading answered with the unexpected status ${status}` });
    // One request: no retry, and the bearer token went nowhere else.
    expect(received.map((call) => call.url)).toEqual(["/v1/internal/market-funding"]);
  });
});

describe("failures that are retried", () => {
  it.each([500, 502, 503, 408, 429])("retries %i and returns funded when the next attempt succeeds", async (status) => {
    script.push({ status, body: problem(status, "busy") }, { status: 201, body: {} });
    const { client, logger } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(received).toHaveLength(2);
    // Every attempt carries the same key and body: that is what makes the repeat safe.
    expect(new Set(received.map((call) => call.headers["idempotency-key"]))).toEqual(new Set([MARKET_ID]));
    expect(new Set(received.map((call) => call.body)).size).toBe(1);
    expect(logger.lines[0]).toMatchObject({ fields: { attempts: 2, outcome: "funded" } });
  });

  it("answers unknown after FUNDING_RETRIES + 1 attempts of 5xx", async () => {
    script.push({ status: 500 }, { status: 503 }, { status: 502 }, { status: 201 });
    const { client, logger } = makeClient({ retries: 2 });
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "unknown", reason: "trading answered 502" });
    expect(received).toHaveLength(3);
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", fields: { tenantId: TENANT_A, marketId: MARKET_ID, attempts: 3, reason: "trading answered 502" } });
  });

  it("makes one attempt when FUNDING_RETRIES is 0", async () => {
    script.push({ status: 500 });
    expect(await makeClient({ retries: 0 }).client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "unknown" });
    expect(received).toHaveLength(1);
  });

  it("times out an attempt that is too slow, repeats it, and answers unknown when every attempt is slow", async () => {
    script.push({ status: 201, delayMs: 600 }, { status: 201, delayMs: 600 }, { status: 201, delayMs: 600 });
    const slow = await makeClient({ timeoutMs: 80 }).client.fund(REQUEST, MARKET_ID);
    expect(slow).toEqual({ kind: "unknown", reason: "trading did not answer in time" });
    expect(received).toHaveLength(3);
  });

  it("recovers when only the first attempt times out", async () => {
    script.push({ status: 201, delayMs: 600 }, { status: 201 });
    expect(await makeClient({ timeoutMs: 80 }).client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(received).toHaveLength(2);
  });

  it("treats 409 idempotency_in_progress as transient: it is repeated, and funded once the first call with the key has completed", async () => {
    script.push({ status: 409, body: problem(409, "idempotency_in_progress") }, { status: 200, body: {} });
    const { client } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(received).toHaveLength(2);
  });

  it("answers unknown, never rejected, when every attempt meets 409 idempotency_in_progress: the first call may yet be booked", async () => {
    script.push(
      { status: 409, body: problem(409, "idempotency_in_progress") },
      { status: 409, body: problem(409, "idempotency_in_progress") },
      { status: 409, body: problem(409, "idempotency_in_progress") },
    );
    expect(await makeClient({ retries: 2 }).client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "unknown", reason: "trading answered 409" });
    expect(received).toHaveLength(3);
  });

  it.each([401, 403])("answers unknown, not rejected, for %i to a repeat after an attempt that timed out: that attempt may have been booked", async (status) => {
    script.push({ status: 201, delayMs: 600 }, { status, body: problem(status, "unauthorized") });
    const tokens = tokenSource();
    const { client } = makeClient({ timeoutMs: 80 }, tokens);

    const result = await client.fund(REQUEST, MARKET_ID);

    expect(result).toMatchObject({ kind: "unknown", reason: expect.stringContaining(`(${status})`) as string });
    expect(received).toHaveLength(2);
    // A 401 still says the cached token is no good.
    expect(tokens.invalidate).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it("answers unknown for 401 to a repeat after a 5xx attempt, and rejected for 401 on the first attempt", async () => {
    script.push({ status: 503 }, { status: 401, body: problem(401, "unauthorized") }, { status: 401, body: problem(401, "unauthorized") });
    const { client } = makeClient();
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "unknown" });
    expect(received).toHaveLength(2);
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "rejected", status: 401 });
    expect(received).toHaveLength(3);
  });

  it("answers unknown when trading cannot be reached at all, naming the cause and never the token", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const { client, logger } = makeClient({}, tokenSource(), url);
    const result = await client.fund(REQUEST, MARKET_ID);
    expect(result).toEqual({ kind: "unknown", reason: "trading cannot be reached (ECONNREFUSED)" });
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
  });
});

describe("the circuit breaker", () => {
  it("opens after FUNDING_CIRCUIT_FAILURES consecutive failures: nothing is sent, the answer is not_sent with the half-open time", async () => {
    script.push({ status: 500 }, { status: 500 }, { status: 500 }, { status: 201 });
    const { client, logger } = makeClient({ retries: 0, circuitFailures: 3, circuitHalfOpenMs: 2500 });

    for (let call = 0; call < 3; call += 1) expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "unknown" });
    expect(received).toHaveLength(3);

    const refused = await client.fund(REQUEST, MARKET_ID);
    expect(refused).toEqual({ kind: "not_sent", reason: "the circuit to trading is open", retryAfterSeconds: 3 });
    expect(received).toHaveLength(3);
    expect(logger.lines.at(-1)).toMatchObject({ level: "warn", fields: { tenantId: TENANT_A, marketId: MARKET_ID, attempts: 0 } });
  });

  it("lets one trial call through after the half-open time and closes again when it succeeds", async () => {
    script.push({ status: 500 }, { status: 500 }, { status: 201 }, { status: 201 });
    const { client } = makeClient({ retries: 0, circuitFailures: 2, circuitHalfOpenMs: 60 });
    await client.fund(REQUEST, MARKET_ID);
    await client.fund(REQUEST, MARKET_ID);
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "not_sent", retryAfterSeconds: 1 });

    await sleep(90);
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
    expect(received).toHaveLength(4);
  });

  it("opens again when the trial call fails", async () => {
    script.push({ status: 500 }, { status: 500 }, { status: 503 });
    const { client } = makeClient({ retries: 0, circuitFailures: 2, circuitHalfOpenMs: 60 });
    await client.fund(REQUEST, MARKET_ID);
    await client.fund(REQUEST, MARKET_ID);
    await sleep(90);
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "unknown" });
    expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "not_sent" });
    expect(received).toHaveLength(3);
  });

  it("is not opened by answers that are not failures: a 4xx or a 409 shows trading is up and resets the count", async () => {
    script.push({ status: 500 }, { status: 500 }, { status: 422, body: problem(422, "idempotency_key_reused") }, { status: 500 }, { status: 500 }, { status: 201 });
    const { client } = makeClient({ retries: 0, circuitFailures: 3 });
    const kinds: string[] = [];
    for (let call = 0; call < 6; call += 1) kinds.push((await client.fund(REQUEST, MARKET_ID)).kind);
    expect(kinds).toEqual(["unknown", "unknown", "rejected", "unknown", "unknown", "funded"]);
    expect(received).toHaveLength(6);
  });

  it("answers unknown, not not_sent, when the circuit opens during a call whose first attempt was sent", async () => {
    script.push({ status: 500 }, { status: 500 }, { status: 201 });
    const { client } = makeClient({ retries: 2, circuitFailures: 2 });
    const result = await client.fund(REQUEST, MARKET_ID);
    expect(result.kind).toBe("unknown");
    expect(result).toMatchObject({ reason: expect.stringContaining("the circuit to trading is open after an attempt was sent") as string });
    expect(received).toHaveLength(2);
  });
});

describe("the service token", () => {
  it("answers not_sent after 5 seconds' wait when no token can be had, and sends nothing", async () => {
    const tokens = tokenSource();
    tokens.token.mockRejectedValue(new TokenUnavailable("The token endpoint answered 503"));
    const { client, logger } = makeClient({}, tokens);
    const result = await client.fund(REQUEST, MARKET_ID);
    expect(result).toEqual({ kind: "not_sent", reason: "no service token for trading: The token endpoint answered 503", retryAfterSeconds: 5 });
    expect(received).toHaveLength(0);
    expect(logger.lines.at(-1)?.level).toBe("warn");
  });

  it("does not count a missing token against the circuit", async () => {
    const tokens = tokenSource();
    tokens.token.mockRejectedValue(new TokenUnavailable("down"));
    const { client } = makeClient({ retries: 0, circuitFailures: 2 }, tokens);
    for (let call = 0; call < 4; call += 1) expect(await client.fund(REQUEST, MARKET_ID)).toMatchObject({ kind: "not_sent", retryAfterSeconds: 5 });
    tokens.token.mockResolvedValue(TOKEN);
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "funded" });
  });

  it("answers unknown when the token is lost after an attempt was already sent", async () => {
    script.push({ status: 503 });
    const tokens = tokenSource();
    tokens.token.mockResolvedValueOnce(TOKEN).mockRejectedValue(new TokenUnavailable("down"));
    const result = await makeClient({}, tokens).client.fund(REQUEST, MARKET_ID);
    expect(result.kind).toBe("unknown");
    expect(received).toHaveLength(1);
  });

  it("never throws: a defect in the client is an unknown outcome with an error log", async () => {
    const tokens = tokenSource();
    tokens.token.mockRejectedValue(new RangeError("boom"));
    const { client, logger } = makeClient({}, tokens);
    expect(await client.fund(REQUEST, MARKET_ID)).toEqual({ kind: "unknown", reason: "RangeError: boom" });
    expect(logger.lines.at(-1)).toMatchObject({ level: "error", fields: { tenantId: TENANT_A, marketId: MARKET_ID } });
  });
});
