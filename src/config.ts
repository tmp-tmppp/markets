import { DEFAULT_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS } from "./adapters/retention.js";
import type { MarketRules } from "./domain/market.js";
import { OPENING_LEASE_MS } from "./usecases/support.js";

// Typed configuration, validated once at startup. A bad or missing setting stops the start with a message that names
// every problem; values are never printed (they may hold passwords).
// ADR-037: defaults, then the watched runtime file, then environment variables (the chart's ConfigMap and Secret), so
// an environment variable always wins. The runtime keys (RUNTIME_KEYS) are read here as their startup values; the
// watcher of RUNTIME_CONFIG_FILE (src/adapters/runtime-config.ts) applies the file with parseRuntimeFile while the
// service runs, without a restart, for every runtime key the environment does not set (the chart sets none there).

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/** In-memory funding outcomes of a local run without trading (APP_ENV=local only). */
export const FAKE_FUNDING_MODES = ["funded", "insufficient", "unknown"] as const;
export type FakeFundingMode = (typeof FAKE_FUNDING_MODES)[number];

/** The client "markets" of the identity provider: markets asks it for a client-credentials token for trading. */
export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

/** Trading's internal funding endpoint (contracts/outgoing/trading-market-funding.openapi.yaml). */
export interface TradingConfig {
  baseUrl: string;
}

/** The resilience policy of the funding call (cockatiel, one policy per process). */
export interface FundingPolicyConfig {
  /** Per attempt. */
  timeoutMs: number;
  /** Retries after the first attempt, on network errors, timeouts, 408, 429 and 5xx. */
  retries: number;
  /** Consecutive failures that open the circuit. */
  circuitFailures: number;
  /** How long the circuit stays open before one call may try again (half-open). */
  circuitHalfOpenMs: number;
}

export interface AuthConfig {
  jwksUrl: string;
  issuer: string;
  audience: string;
  rolesClaim: string;
  tenantClaim: string;
  /** The audience of the service tokens of the internal surface (INTERNAL_AUTH_AUDIENCE); the user tokens' audience when unset. */
  internalAudience: string;
  /** The claim that names the calling client in a service token (INTERNAL_AUTH_CLIENT_CLAIM). */
  internalClientClaim: string;
  /** The identity provider's client id of tenants, the only caller of the share-link admission endpoint. */
  tenantsClientId: string;
}

/** The automatic close of markets at their close time (UC-15). */
export interface AutoCloseSettings {
  /** AUTO_CLOSE_ENABLED, the kill switch: false stops the worker from closing anything. An invalid value means false. */
  enabled: boolean;
  /** AUTO_CLOSE_INTERVAL_MS: the wait between two runs over the tenants. */
  intervalMs: number;
}

/** The keys that may change while the service runs. */
export interface RuntimeSettings {
  logLevel: string;
  marketRules: MarketRules;
  autoClose: AutoCloseSettings;
}

export interface Config {
  /** "local" allows in-memory fallbacks; any other value (default "production") requires every setting. */
  appEnv: string;
  isLocal: boolean;
  port: number;
  /** The port of the separate listener that serves GET /metrics; never the API port. */
  metricsPort: number;
  /** Startup value of a runtime key. */
  logLevel: string;
  /** Path of the file the chart mounts from the ConfigMap (a directory mount, never subPath); null: no file is watched. */
  runtimeConfigFile: string | null;
  /** How often the runtime file is read again; a ConfigMap update replaces the file by a link swap. */
  runtimeConfigPollMs: number;
  /** Null only in local mode: the service then keeps its data in memory. */
  databaseUrl: string | null;
  databasePoolMax: number;
  /** Null only in local mode: events are then logged instead of published, and no TenantCreated is consumed. */
  natsUrl: string | null;
  /** Null only in local mode without trading. */
  keycloak: KeycloakConfig | null;
  /** Null only in local mode: a fake funding client answers as FAKE_FUNDING_MODE says. */
  trading: TradingConfig | null;
  funding: FundingPolicyConfig;
  fakeFundingMode: FakeFundingMode;
  /** Startup value of runtime keys. */
  marketRules: MarketRules;
  /** Startup value of runtime keys. */
  autoClose: AutoCloseSettings;
  auth: AuthConfig;
  outboxPollMs: number;
  /**
   * How long this service's stream keeps its messages (STREAM_MAX_AGE_DAYS, 1 to 365 days, default 30). main.ts turns it
   * into one number for the NATS publisher (the stream's max_age) and the relay (its purge), so the two agree.
   */
  streamMaxAgeDays: number;
  /** How often the opening-retry worker looks for due rows of shared.pending_openings. */
  openingRetryIntervalMs: number;
  /**
   * After SIGTERM the service first answers 503 on the readiness probe and keeps serving for this long, so that the
   * load balancer and the endpoints stop sending requests; only then does it close the server, the loops and the pools.
   */
  shutdownDelayMs: number;
}

/** The longest drain delay: with the 10 seconds a shutdown may then take, it ends inside the chart's 30 seconds. */
export const MAX_SHUTDOWN_DELAY_MS = 15_000;
/** payments' amount bounds: a market can never be funded with more credits than one amount may hold. */
export const FUNDING_AMOUNT_LIMIT = 1_000_000;
/** The longest MARKET_MIN_LEAD_MS: one week. */
export const MAX_MIN_LEAD_MS = 7 * 24 * 3_600_000;
/** The longest wait between two attempts of one funding call (the client's exponential backoff is capped at it). */
export const FUNDING_RETRY_MAX_DELAY_MS = 2000;
/** Room kept in the opening lease beyond the longest funding call: the claim, the settlement and a slow clock. */
export const FUNDING_LEASE_MARGIN_MS = 5000;

/** The longest one funding call can take: every attempt times out and every wait is the longest. */
export function worstFundingCallMs(policy: Pick<FundingPolicyConfig, "timeoutMs" | "retries">): number {
  return (policy.retries + 1) * policy.timeoutMs + policy.retries * FUNDING_RETRY_MAX_DELAY_MS;
}

/** Bounds of AUTO_CLOSE_INTERVAL_MS: not faster than every second (each run visits every tenant), not slower than an hour. */
export const AUTO_CLOSE_INTERVAL_MIN_MS = 1000;
export const AUTO_CLOSE_INTERVAL_MAX_MS = 3_600_000;

/** The keys RUNTIME_CONFIG_FILE may set; any other key in the file is reported and ignored. */
export const RUNTIME_KEYS = ["LOG_LEVEL", "MARKET_FUNDING_MIN", "MARKET_FUNDING_MAX", "MARKET_MIN_LEAD_MS", "AUTO_CLOSE_ENABLED", "AUTO_CLOSE_INTERVAL_MS"] as const;

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

// Local defaults of the token settings, matching a Keycloak on port 8081 (see README). Tokens are always verified.
const LOCAL_AUTH = {
  jwksUrl: "http://localhost:8081/realms/chance/protocol/openid-connect/certs",
  issuer: "http://localhost:8081/realms/chance",
  audience: "chance",
};

type Source = Readonly<Record<string, string | undefined>>;

/** Readers of one source of settings; each records its problems instead of throwing, so all of them are reported. */
function readerOf(source: Source, problems: string[]) {
  const text = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };
  const choice = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(", ")}`);
    return fallback;
  };
  const url = (name: string, protocols: readonly string[], value: string | undefined): string | null => {
    if (value === undefined) return null;
    try {
      const parsed = new URL(value);
      if (protocols.includes(parsed.protocol) && parsed.username === "" && parsed.password === "") return value;
      // A database URL carries its login: only the other URLs must not.
      if (protocols.includes(parsed.protocol) && protocols.includes("postgres:")) return value;
    } catch {
      // Reported below.
    }
    problems.push(`${name} must be a URL starting with ${protocols.map((p) => `${p}//`).join(" or ")} (only a database URL may hold a user name and password)`);
    return null;
  };
  /** The runtime keys, read on top of `base`; MARKET_FUNDING_MIN must not be above MARKET_FUNDING_MAX. */
  const runtime = (base: RuntimeSettings): RuntimeSettings => {
    const logLevel = choice("LOG_LEVEL", LOG_LEVELS, base.logLevel);
    let fundingMin = integer("MARKET_FUNDING_MIN", base.marketRules.fundingMin, 1, FUNDING_AMOUNT_LIMIT);
    let fundingMax = integer("MARKET_FUNDING_MAX", base.marketRules.fundingMax, 1, FUNDING_AMOUNT_LIMIT);
    const minLeadMs = integer("MARKET_MIN_LEAD_MS", base.marketRules.minLeadMs, 0, MAX_MIN_LEAD_MS);
    if (fundingMin > fundingMax) {
      // Only the pair that contradicts itself falls back to the startup values; a valid lead time of the same file stays.
      problems.push("MARKET_FUNDING_MIN must not be greater than MARKET_FUNDING_MAX");
      fundingMin = base.marketRules.fundingMin;
      fundingMax = base.marketRules.fundingMax;
    }
    const autoClose: AutoCloseSettings = {
      enabled: killSwitch("AUTO_CLOSE_ENABLED", base.autoClose.enabled),
      intervalMs: integer("AUTO_CLOSE_INTERVAL_MS", base.autoClose.intervalMs, AUTO_CLOSE_INTERVAL_MIN_MS, AUTO_CLOSE_INTERVAL_MAX_MS),
    };
    return { logLevel, marketRules: { fundingMin, fundingMax, minLeadMs }, autoClose };
  };
  /**
   * A kill switch: "true" or "false". A key that is not set at all keeps `fallback`. A value that is anything else, an
   * empty one included, fails closed: it is reported and the switch is off (false), whatever `fallback` is, so a typo such
   * as `AUTO_CLOSE_ENABLED=flase` never leaves the feature running or switches it on.
   */
  const killSwitch = (name: string, fallback: boolean): boolean => {
    const raw = source[name];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    if (value === "true") return true;
    if (value === "false") return false;
    problems.push(`${name} must be true or false; ${value === "" ? "an empty value" : "this value"} switches it off (the kill switch fails closed)`);
    return false;
  };
  return { text, integer, choice, url, runtime };
}

/** The defaults of the runtime keys. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  logLevel: "info",
  marketRules: { fundingMin: 100, fundingMax: 100_000, minLeadMs: 5 * 60_000 },
  autoClose: { enabled: true, intervalMs: 15_000 },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const read = readerOf(env, problems);
  const { text, integer, url } = read;

  const appEnv = text("APP_ENV") ?? "production";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(appEnv)) problems.push("APP_ENV must be lowercase letters, digits and dashes");
  const isLocal = appEnv === "local";
  const required = (name: string, hint: string): string | undefined => {
    const value = text(name);
    if (value === undefined && !isLocal) problems.push(`${name} is required (${hint}); only APP_ENV=local may leave it out`);
    return value;
  };

  const runtime = read.runtime(DEFAULT_RUNTIME_SETTINGS);

  const databaseUrl = url("DATABASE_URL", ["postgres:", "postgresql:"], required("DATABASE_URL", "the connection string of the service's PostgreSQL database"));
  const natsUrl = url("NATS_URL", ["nats:", "tls:"], required("NATS_URL", "the NATS server"));

  const tradingUrl = url("TRADING_URL", ["http:", "https:"], required("TRADING_URL", "the base URL of trading, for the market funding call"));
  const trading: TradingConfig | null = tradingUrl === null ? null : { baseUrl: tradingUrl.replace(/\/+$/, "") };

  // The token for trading: KEYCLOAK_URL, KEYCLOAK_REALM and the client's secret belong together.
  let keycloak: KeycloakConfig | null = null;
  const keycloakUrl = required("KEYCLOAK_URL", "the Keycloak base URL, for the token markets sends to trading");
  if (keycloakUrl !== undefined) {
    const checkedUrl = url("KEYCLOAK_URL", ["http:", "https:"], keycloakUrl);
    const realm = text("KEYCLOAK_REALM");
    const clientId = text("MARKETS_CLIENT_ID") ?? "markets";
    const clientSecret = text("MARKETS_CLIENT_SECRET");
    if (!realm) problems.push("KEYCLOAK_REALM is required when KEYCLOAK_URL is set");
    if (!clientSecret) problems.push("MARKETS_CLIENT_SECRET is required when KEYCLOAK_URL is set");
    if (checkedUrl && realm && clientSecret) keycloak = { url: checkedUrl.replace(/\/+$/, ""), realm, clientId, clientSecret };
  } else if (isLocal && text("TRADING_URL") !== undefined) {
    problems.push("KEYCLOAK_URL is required when TRADING_URL is set: the funding call needs a service token");
  }

  const fakeFundingMode = read.choice("FAKE_FUNDING_MODE", FAKE_FUNDING_MODES, "funded");
  if (!isLocal && text("FAKE_FUNDING_MODE") !== undefined) problems.push("FAKE_FUNDING_MODE is only allowed with APP_ENV=local");

  const authText = (name: string, local: string, hint: string): string => required(name, hint) ?? local;
  const jwksUrl = url("AUTH_JWKS_URL", ["http:", "https:"], authText("AUTH_JWKS_URL", LOCAL_AUTH.jwksUrl, "the JWKS URL of the identity provider"));
  const audience = authText("AUTH_AUDIENCE", LOCAL_AUTH.audience, "the audience (aud) of the tokens");
  const auth: AuthConfig = {
    jwksUrl: jwksUrl ?? LOCAL_AUTH.jwksUrl,
    issuer: authText("AUTH_ISSUER", LOCAL_AUTH.issuer, "the issuer (iss) of the tokens"),
    audience,
    rolesClaim: text("AUTH_ROLES_CLAIM") ?? "realm_access.roles",
    tenantClaim: text("AUTH_TENANT_CLAIM") ?? "organization",
    internalAudience: text("INTERNAL_AUTH_AUDIENCE") ?? audience,
    internalClientClaim: text("INTERNAL_AUTH_CLIENT_CLAIM") ?? "azp",
    tenantsClientId: text("INTERNAL_AUTH_TENANTS_CLIENT_ID") ?? "tenants-markets",
  };

  const funding: FundingPolicyConfig = {
    timeoutMs: integer("FUNDING_TIMEOUT_MS", 3000, 100, 60_000),
    retries: integer("FUNDING_RETRIES", 2, 0, 10),
    circuitFailures: integer("FUNDING_CIRCUIT_FAILURES", 5, 1, 100),
    circuitHalfOpenMs: integer("FUNDING_CIRCUIT_HALF_OPEN_MS", 10_000, 1000, 600_000),
  };
  // A funding call must end inside the lease of its pending row (OPENING_LEASE_MS), or another instance claims the row
  // and sends a concurrent call with the same key while this one still runs.
  if (worstFundingCallMs(funding) + FUNDING_LEASE_MARGIN_MS > OPENING_LEASE_MS) {
    problems.push(
      `FUNDING_TIMEOUT_MS and FUNDING_RETRIES allow one funding call of ${worstFundingCallMs(funding)} ms, which does not fit in the ${OPENING_LEASE_MS} ms lease of an opening with a margin of ${FUNDING_LEASE_MARGIN_MS} ms`,
    );
  }

  const port = integer("PORT", 8080, 1, 65535);
  const metricsPort = integer("METRICS_PORT", 9464, 1, 65535);
  // The API port never serves /metrics (so the gateway can never route it): the two listeners need two ports.
  if (metricsPort === port) problems.push("METRICS_PORT must differ from PORT (the API port never serves /metrics)");

  const config: Config = {
    appEnv,
    isLocal,
    port,
    metricsPort,
    logLevel: runtime.logLevel,
    runtimeConfigFile: text("RUNTIME_CONFIG_FILE") ?? null,
    runtimeConfigPollMs: integer("RUNTIME_CONFIG_POLL_MS", 10_000, 1000, 3_600_000),
    databaseUrl,
    databasePoolMax: integer("DATABASE_POOL_MAX", 5, 1, 50),
    natsUrl,
    keycloak,
    trading,
    funding,
    fakeFundingMode,
    marketRules: runtime.marketRules,
    autoClose: runtime.autoClose,
    auth,
    outboxPollMs: integer("OUTBOX_POLL_MS", 300, 50, 60_000),
    streamMaxAgeDays: integer("STREAM_MAX_AGE_DAYS", DEFAULT_STREAM_MAX_AGE_DAYS, MIN_STREAM_MAX_AGE_DAYS, MAX_STREAM_MAX_AGE_DAYS),
    openingRetryIntervalMs: integer("OPENING_RETRY_INTERVAL_MS", 5000, 100, 600_000),
    // Nobody routes traffic to a local run, so it does not wait.
    shutdownDelayMs: integer("SHUTDOWN_DELAY_MS", isLocal ? 0 : 5000, 0, MAX_SHUTDOWN_DELAY_MS),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The token endpoint of the realm (OpenID Connect client credentials). */
export function keycloakTokenUrl(keycloak: KeycloakConfig): string {
  return `${keycloak.url}/realms/${encodeURIComponent(keycloak.realm)}/protocol/openid-connect/token`;
}

/** The startup values of the runtime keys. */
export function runtimeSettingsOf(config: Config): RuntimeSettings {
  return { logLevel: config.logLevel, marketRules: { ...config.marketRules }, autoClose: { ...config.autoClose } };
}

export interface RuntimeFileResult {
  settings: RuntimeSettings;
  /** Invalid values and unknown keys; the service logs them, and an invalid key keeps its startup value. */
  problems: string[];
  /** True when the file's AUTO_CLOSE_ENABLED is invalid or empty, so the automatic close is switched off (the kill switch fails closed). */
  autoCloseFailedClosed: boolean;
}

/** The runtime keys that the environment sets: they win over the runtime file (ADR-037). */
export function runtimeKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return RUNTIME_KEYS.filter((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Reads the runtime file: lines KEY=value, blank lines and lines starting with # are skipped, the last of repeated
 * keys counts. A key that is not in the file takes its startup value (defaults, then env), so deleting a line undoes
 * an override. A key in `setInEnv` keeps its environment value (ADR-037: env wins over the file) and is reported.
 * Never throws: a running service keeps working with what it has.
 */
export function parseRuntimeFile(content: string, startup: RuntimeSettings, setInEnv: readonly string[] = []): RuntimeFileResult {
  const problems: string[] = [];
  const values: Record<string, string> = {};
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) {
      problems.push(`Line ${index + 1}: ${key || "a line without KEY=value"} is not a runtime key (${RUNTIME_KEYS.join(", ")})`);
      continue;
    }
    values[key] = line.slice(separator + 1).trim();
  }
  for (const key of setInEnv) {
    if (key in values) {
      problems.push(`${key} is set in the environment, which wins over the runtime file (ADR-037); the file's value is ignored`);
      delete values[key];
    }
  }
  const settings = readerOf(values, problems).runtime(startup);
  // The kill switch fails closed (see killSwitch): any value but true or false, an empty one included, switches it off.
  const autoCloseValue = values["AUTO_CLOSE_ENABLED"];
  const autoCloseFailedClosed = autoCloseValue !== undefined && autoCloseValue !== "true" && autoCloseValue !== "false";
  return { settings, problems, autoCloseFailedClosed };
}
