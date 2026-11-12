import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_RUNTIME_SETTINGS,
  MAX_SHUTDOWN_DELAY_MS,
  keycloakTokenUrl,
  loadConfig,
  parseRuntimeFile,
  runtimeKeysInEnv,
  runtimeSettingsOf,
  worstFundingCallMs,
} from "../src/config.js";
import { OPENING_LEASE_MS } from "../src/usecases/support.js";

const production = {
  DATABASE_URL: "postgres://markets:pw@db:5432/markets", // hooks:allow local development only
  NATS_URL: "nats://nats:4222",
  TRADING_URL: "http://trading:8081/",
  KEYCLOAK_URL: "http://keycloak:8080/",
  KEYCLOAK_REALM: "chance",
  MARKETS_CLIENT_SECRET: "client-pw", // hooks:allow local development only
  AUTH_JWKS_URL: "http://keycloak:8080/realms/chance/protocol/openid-connect/certs",
  AUTH_ISSUER: "http://keycloak:8080/realms/chance",
  AUTH_AUDIENCE: "chance",
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
  return [];
};

describe("loadConfig", () => {
  it("reads a complete production configuration and applies the defaults", () => {
    const config = loadConfig(production);
    expect(config).toEqual({
      appEnv: "production",
      isLocal: false,
      port: 8080,
      metricsPort: 9464,
      logLevel: "info",
      runtimeConfigFile: null,
      runtimeConfigPollMs: 10_000,
      databaseUrl: production.DATABASE_URL,
      databasePoolMax: 5,
      natsUrl: production.NATS_URL,
      keycloak: { url: "http://keycloak:8080", realm: "chance", clientId: "markets", clientSecret: "client-pw" },
      trading: { baseUrl: "http://trading:8081" },
      funding: { timeoutMs: 3000, retries: 2, circuitFailures: 5, circuitHalfOpenMs: 10_000 },
      fakeFundingMode: "funded",
      marketRules: { fundingMin: 100, fundingMax: 100_000, minLeadMs: 300_000 },
      autoClose: { enabled: true, intervalMs: 15_000 },
      auth: {
        jwksUrl: production.AUTH_JWKS_URL,
        issuer: production.AUTH_ISSUER,
        audience: "chance",
        rolesClaim: "realm_access.roles",
        tenantClaim: "organization",
        // The internal surface: its audience follows the users' unless set, and the claim and the client have defaults.
        internalAudience: "chance",
        internalClientClaim: "azp",
        tenantsClientId: "tenants-markets",
      },
      outboxPollMs: 300,
      streamMaxAgeDays: 30,
      openingRetryIntervalMs: 5000,
      shutdownDelayMs: 5000,
    });
    expect(keycloakTokenUrl(config.keycloak!)).toBe("http://keycloak:8080/realms/chance/protocol/openid-connect/token");
  });

  it("reads every parameter from the environment", () => {
    const config = loadConfig({
      ...production,
      PORT: "9090",
      LOG_LEVEL: "debug",
      RUNTIME_CONFIG_FILE: "/etc/markets/runtime/runtime.env",
      RUNTIME_CONFIG_POLL_MS: "5000",
      DATABASE_POOL_MAX: "10",
      MARKETS_CLIENT_ID: "markets-test",
      FUNDING_TIMEOUT_MS: "1500",
      FUNDING_RETRIES: "0",
      FUNDING_CIRCUIT_FAILURES: "3",
      FUNDING_CIRCUIT_HALF_OPEN_MS: "20000",
      MARKET_FUNDING_MIN: "10",
      MARKET_FUNDING_MAX: "500",
      MARKET_MIN_LEAD_MS: "0",
      OUTBOX_POLL_MS: "1000",
      STREAM_MAX_AGE_DAYS: "90",
      OPENING_RETRY_INTERVAL_MS: "2000",
      SHUTDOWN_DELAY_MS: "0",
      AUTH_ROLES_CLAIM: "roles",
      AUTH_TENANT_CLAIM: "tenant",
    });
    expect(config).toMatchObject({
      port: 9090,
      logLevel: "debug",
      runtimeConfigFile: "/etc/markets/runtime/runtime.env",
      runtimeConfigPollMs: 5000,
      databasePoolMax: 10,
      keycloak: { clientId: "markets-test" },
      funding: { timeoutMs: 1500, retries: 0, circuitFailures: 3, circuitHalfOpenMs: 20_000 },
      marketRules: { fundingMin: 10, fundingMax: 500, minLeadMs: 0 },
      outboxPollMs: 1000,
      streamMaxAgeDays: 90,
      openingRetryIntervalMs: 2000,
      shutdownDelayMs: 0,
      auth: { rolesClaim: "roles", tenantClaim: "tenant" },
    });
  });

  it("reads STREAM_MAX_AGE_DAYS: 30 days by default, 1 to 365 days allowed, anything else is reported", () => {
    expect(loadConfig(production).streamMaxAgeDays).toBe(30);
    expect(loadConfig({ ...production, STREAM_MAX_AGE_DAYS: "1" }).streamMaxAgeDays).toBe(1);
    expect(loadConfig({ ...production, STREAM_MAX_AGE_DAYS: "365" }).streamMaxAgeDays).toBe(365);
    for (const bad of ["0", "366", "-7", "1.5", "thirty"]) {
      expect(problemsOf({ ...production, STREAM_MAX_AGE_DAYS: bad }), bad).toEqual(["STREAM_MAX_AGE_DAYS must be an integer from 1 to 365"]);
    }
  });

  it("requires every external system outside local mode and names each missing one", () => {
    const problems = problemsOf({});
    for (const name of ["DATABASE_URL", "NATS_URL", "TRADING_URL", "KEYCLOAK_URL", "AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
      expect(problems.some((problem) => problem.startsWith(`${name} is required`)), name).toBe(true);
    }
  });

  it("lets APP_ENV=local run without any of them, with the fake funding mode and no drain delay", () => {
    const config = loadConfig({ APP_ENV: "local", FAKE_FUNDING_MODE: "insufficient" });
    expect(config).toMatchObject({
      isLocal: true,
      databaseUrl: null,
      natsUrl: null,
      trading: null,
      keycloak: null,
      fakeFundingMode: "insufficient",
      shutdownDelayMs: 0,
      auth: { issuer: "http://localhost:8081/realms/chance", audience: "chance" },
    });
  });

  it("needs the token settings whenever trading is called, also locally", () => {
    expect(problemsOf({ APP_ENV: "local", TRADING_URL: "http://localhost:8082" })).toEqual([
      "KEYCLOAK_URL is required when TRADING_URL is set: the funding call needs a service token",
    ]);
    const { KEYCLOAK_REALM: _realm, MARKETS_CLIENT_SECRET: _secret, ...partial } = production;
    expect(problemsOf(partial)).toEqual([
      "KEYCLOAK_REALM is required when KEYCLOAK_URL is set",
      "MARKETS_CLIENT_SECRET is required when KEYCLOAK_URL is set",
    ]);
  });

  it("refuses bad values, and never repeats them", () => {
    const problems = problemsOf({
      ...production,
      APP_ENV: "Prod!",
      PORT: "0",
      LOG_LEVEL: "loud",
      DATABASE_URL: "mysql://db/markets",
      NATS_URL: "http://nats:4222",
      TRADING_URL: "http://user:secret@trading:8081",
      FUNDING_RETRIES: "-1",
      FUNDING_TIMEOUT_MS: "fast",
      MARKET_FUNDING_MIN: "0",
      MARKET_MIN_LEAD_MS: "604800001",
      FAKE_FUNDING_MODE: "maybe",
      SHUTDOWN_DELAY_MS: String(MAX_SHUTDOWN_DELAY_MS + 1),
    });
    expect(problems).toHaveLength(13);
    expect(problems.join("\n")).not.toMatch(/secret@|mysql:\/\/db/);
    expect(problems).toContain("FAKE_FUNDING_MODE is only allowed with APP_ENV=local");
    expect(problems).toContain("FAKE_FUNDING_MODE must be one of: funded, insufficient, unknown");
  });

  it("counts the longest funding call: every attempt times out and every wait is the longest (3 x 3000 + 2 x 2000 by default)", () => {
    expect(worstFundingCallMs(loadConfig(production).funding)).toBe(13_000);
    expect(worstFundingCallMs({ timeoutMs: 1000, retries: 0 })).toBe(1000);
  });

  it("refuses a funding policy whose longest call does not fit in the opening lease, with room to spare", () => {
    // 3 x 30000 + 2 x 2000 = 94 s against a lease of 60 s: another instance would claim the row during the call.
    const problems = problemsOf({ ...production, FUNDING_TIMEOUT_MS: "30000", FUNDING_RETRIES: "2" });
    expect(problems).toEqual([expect.stringContaining("FUNDING_TIMEOUT_MS and FUNDING_RETRIES") as string]);
    expect(problems[0]).toContain(`${OPENING_LEASE_MS} ms lease`);
    // The boundary: 3 x 17000 + 2 x 2000 + 5000 margin = the lease exactly.
    expect(problemsOf({ ...production, FUNDING_TIMEOUT_MS: "17000", FUNDING_RETRIES: "2" })).toEqual([]);
    expect(problemsOf({ ...production, FUNDING_TIMEOUT_MS: "17001", FUNDING_RETRIES: "2" })).toHaveLength(1);
    expect(problemsOf({ ...production, FUNDING_TIMEOUT_MS: "5000", FUNDING_RETRIES: "10" })).toHaveLength(1);
  });

  it("refuses a minimum funding above the maximum", () => {
    expect(problemsOf({ ...production, MARKET_FUNDING_MIN: "5000", MARKET_FUNDING_MAX: "1000" })).toEqual([
      "MARKET_FUNDING_MIN must not be greater than MARKET_FUNDING_MAX",
    ]);
  });
});

describe("METRICS_PORT (the listener that serves GET /metrics)", () => {
  it("defaults to 9464, also in local mode, and is read from the environment", () => {
    expect(loadConfig(production).metricsPort).toBe(9464);
    expect(loadConfig({ APP_ENV: "local" }).metricsPort).toBe(9464);
    expect(loadConfig({ ...production, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
    expect(loadConfig({ ...production, METRICS_PORT: "1" }).metricsPort).toBe(1);
    expect(loadConfig({ ...production, METRICS_PORT: "65535" }).metricsPort).toBe(65_535);
  });

  it.each(["0", "65536", "-1", "9464.5", "abc"])("refuses METRICS_PORT=%j", (value) => {
    expect(problemsOf({ ...production, METRICS_PORT: value })).toEqual(["METRICS_PORT must be an integer from 1 to 65535"]);
  });

  it("must differ from PORT: the API port never serves /metrics", () => {
    const problem = "METRICS_PORT must differ from PORT (the API port never serves /metrics)";
    expect(problemsOf({ ...production, PORT: "9000", METRICS_PORT: "9000" })).toEqual([problem]);
    // The default metrics port is taken by an API port of 9464 as well.
    expect(problemsOf({ ...production, PORT: "9464" })).toEqual([problem]);
    expect(loadConfig({ ...production, PORT: "9464", METRICS_PORT: "9465" })).toMatchObject({ port: 9464, metricsPort: 9465 });
  });
});

describe("the automatic close's settings at startup", () => {
  it("default to on, every 15 seconds, and are read from the environment", () => {
    expect(loadConfig(production).autoClose).toEqual({ enabled: true, intervalMs: 15_000 });
    expect(loadConfig({ ...production, AUTO_CLOSE_ENABLED: "false", AUTO_CLOSE_INTERVAL_MS: "60000" }).autoClose).toEqual({ enabled: false, intervalMs: 60_000 });
  });

  it.each(["flase", "", " ", "True", "0"])("fail closed on AUTO_CLOSE_ENABLED=%j: the start is refused and names the key, never a running switch", (value) => {
    expect(() => loadConfig({ ...production, AUTO_CLOSE_ENABLED: value })).toThrow(/AUTO_CLOSE_ENABLED must be true or false/);
  });

  it("refuse an interval outside 1000 to 3600000", () => {
    expect(() => loadConfig({ ...production, AUTO_CLOSE_INTERVAL_MS: "500" })).toThrow(/AUTO_CLOSE_INTERVAL_MS must be an integer from 1000 to 3600000/);
    expect(() => loadConfig({ ...production, AUTO_CLOSE_INTERVAL_MS: "3600001" })).toThrow(ConfigError);
  });
});

describe("parseRuntimeFile", () => {
  const startup = runtimeSettingsOf(loadConfig({ ...production, MARKET_FUNDING_MAX: "50000" }));

  it("starts from the defaults and the environment", () => {
    expect(startup).toEqual({ logLevel: "info", marketRules: { ...DEFAULT_RUNTIME_SETTINGS.marketRules, fundingMax: 50_000 }, autoClose: { enabled: true, intervalMs: 15_000 } });
  });

  it("overrides the runtime keys; a key that is not in the file keeps its startup value", () => {
    const content = "# runtime keys of markets\n\nLOG_LEVEL = debug\r\nMARKET_FUNDING_MIN=200\nMARKET_FUNDING_MIN=300\n";
    expect(parseRuntimeFile(content, startup)).toEqual({
      settings: { logLevel: "debug", marketRules: { fundingMin: 300, fundingMax: 50_000, minLeadMs: 300_000 }, autoClose: startup.autoClose },
      problems: [],
      autoCloseFailedClosed: false,
    });
    expect(parseRuntimeFile("", startup)).toEqual({ settings: startup, problems: [], autoCloseFailedClosed: false });
  });

  it("an environment variable wins over the file (ADR-037): the file's value for that key is ignored and reported", () => {
    const fromEnv = runtimeSettingsOf(loadConfig({ ...production, LOG_LEVEL: "error", MARKET_FUNDING_MAX: "50000" }));
    const setInEnv = runtimeKeysInEnv({ LOG_LEVEL: "error", MARKET_FUNDING_MAX: "50000", MARKET_FUNDING_MIN: " ", PORT: "8080" });
    expect(setInEnv).toEqual(["LOG_LEVEL", "MARKET_FUNDING_MAX"]);
    const result = parseRuntimeFile("LOG_LEVEL=debug\nMARKET_FUNDING_MAX=90000\nMARKET_FUNDING_MIN=500\n", fromEnv, setInEnv);
    expect(result.settings).toEqual({ logLevel: "error", marketRules: { fundingMin: 500, fundingMax: 50_000, minLeadMs: 300_000 }, autoClose: fromEnv.autoClose });
    expect(result.problems).toEqual([
      "LOG_LEVEL is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored",
      "MARKET_FUNDING_MAX is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored",
    ]);
  });

  it("a contradicting funding pair falls back to the startup pair only: a valid lead time of the same file still applies", () => {
    const result = parseRuntimeFile("MARKET_FUNDING_MIN=5000\nMARKET_FUNDING_MAX=1000\nMARKET_MIN_LEAD_MS=60000\nLOG_LEVEL=warn\n", startup);
    expect(result.settings).toEqual({ logLevel: "warn", marketRules: { fundingMin: 100, fundingMax: 50_000, minLeadMs: 60_000 }, autoClose: startup.autoClose });
    expect(result.problems).toEqual(["MARKET_FUNDING_MIN must not be greater than MARKET_FUNDING_MAX"]);
  });

  it("applies the automatic close's switch and interval from the file", () => {
    const result = parseRuntimeFile("AUTO_CLOSE_ENABLED=false\nAUTO_CLOSE_INTERVAL_MS=2000\n", startup);
    expect(result.settings.autoClose).toEqual({ enabled: false, intervalMs: 2000 });
    expect(result.problems).toEqual([]);
    expect(result.autoCloseFailedClosed).toBe(false);
    expect(parseRuntimeFile("AUTO_CLOSE_ENABLED=true\n", { ...startup, autoClose: { enabled: false, intervalMs: 15_000 } }).settings.autoClose.enabled).toBe(true);
  });

  it.each(["flase", "TRUE", "1", "yes", ""])("fails closed on AUTO_CLOSE_ENABLED=%j in the file: the switch is off whatever was running", (value) => {
    const running = { ...startup, autoClose: { enabled: true, intervalMs: 15_000 } };
    const result = parseRuntimeFile(`AUTO_CLOSE_ENABLED=${value}\nAUTO_CLOSE_INTERVAL_MS=3000\n`, running);
    expect(result.settings.autoClose).toEqual({ enabled: false, intervalMs: 3000 });
    expect(result.autoCloseFailedClosed).toBe(true);
    expect(result.problems).toEqual([expect.stringMatching(/^AUTO_CLOSE_ENABLED must be true or false; .* switches it off/)]);
  });

  it("keeps the startup interval for an invalid AUTO_CLOSE_INTERVAL_MS and does not touch the switch", () => {
    for (const bad of ["999", "3600001", "soon", "1.5"]) {
      const result = parseRuntimeFile(`AUTO_CLOSE_INTERVAL_MS=${bad}\n`, startup);
      expect(result.settings.autoClose).toEqual(startup.autoClose);
      expect(result.problems).toEqual([expect.stringMatching(/^AUTO_CLOSE_INTERVAL_MS must be an integer from 1000 to 3600000/)]);
      expect(result.autoCloseFailedClosed).toBe(false);
    }
  });

  it("an environment value of the kill switch wins over the file, and a file value for a key set in the environment fails nothing", () => {
    const fromEnv = runtimeSettingsOf(loadConfig({ ...production, AUTO_CLOSE_ENABLED: "false" }));
    const result = parseRuntimeFile("AUTO_CLOSE_ENABLED=true\n", fromEnv, runtimeKeysInEnv({ AUTO_CLOSE_ENABLED: "false" }));
    expect(result.settings.autoClose.enabled).toBe(false);
    expect(result.autoCloseFailedClosed).toBe(false);
  });

  it("reports unknown keys and invalid values and keeps the startup values for them", () => {
    const content = "DATABASE_URL=postgres://elsewhere/db\nnot a setting\nLOG_LEVEL=loud\nMARKET_MIN_LEAD_MS=-5\nMARKET_FUNDING_MAX=10\n";
    const result = parseRuntimeFile(content, startup);
    expect(result.settings).toEqual(startup);
    expect(result.problems).toEqual([
      expect.stringMatching(/^Line 1: DATABASE_URL is not a runtime key/),
      expect.stringMatching(/^Line 2: a line without KEY=value is not a runtime key/),
      expect.stringMatching(/^LOG_LEVEL must be one of/),
      expect.stringMatching(/^MARKET_MIN_LEAD_MS must be an integer/),
      "MARKET_FUNDING_MIN must not be greater than MARKET_FUNDING_MAX",
    ]);
  });
});
