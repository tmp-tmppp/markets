import type { OutgoingHttpHeaders } from "node:http";
import { Writable } from "node:stream";
import type { JWTVerifyGetKey } from "jose";
import { expect } from "vitest";
import { FakeFundingClient } from "../../src/adapters/memory/fake-funding-client.js";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { RuntimeSettingsHolder } from "../../src/adapters/runtime-config.js";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { FakeFundingMode } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";
import { AdmitShareLink } from "../../src/usecases/admit-share-link.js";
import { CloseMarket } from "../../src/usecases/close-market.js";
import { CreateMarket } from "../../src/usecases/create-market.js";
import { CreateShareLink } from "../../src/usecases/create-share-link.js";
import { FinishOpening } from "../../src/usecases/finish-opening.js";
import { GetMarket } from "../../src/usecases/get-market.js";
import { ListMarkets } from "../../src/usecases/list-markets.js";
import { ListShareLinks } from "../../src/usecases/list-share-links.js";
import { LookupSharedMarket } from "../../src/usecases/lookup-shared-market.js";
import { OpenMarket } from "../../src/usecases/open-market.js";
import { ProvisionTenant } from "../../src/usecases/provision-tenant.js";
import type { FundingClient } from "../../src/usecases/ports.js";
import { ResolveMarket } from "../../src/usecases/resolve-market.js";
import { RetryOpening } from "../../src/usecases/retry-opening.js";
import { RevokeShareLink } from "../../src/usecases/revoke-share-link.js";
import type {
  FinishOpeningUseCase,
  MarketUseCases,
  ProvisionTenantUseCase,
  RetryOpeningUseCase,
  ShareLinkUseCases,
} from "../../src/usecases/use-cases.js";
import { buildApp } from "../../src/web/app.js";
import type { WebDeps } from "../../src/web/app.js";
import { responseErrors } from "./contracts.js";
import { RecordingLogger, SequentialIds, SequentialTokens, TENANT_A, TENANT_B, TestClock, closeTimeIn } from "./fakes.js";
import { AUDIENCE, ISSUER, createTestKeys } from "./tokens.js";
import type { TokenOptions } from "./tokens.js";

export interface CoreOptions {
  fundingMode?: FakeFundingMode;
  /** The store registers an unknown tenant on its first use (APP_ENV=local); default false: it answers tenant_not_ready. */
  autoProvision?: boolean;
  /** A funding client of the test's own in place of the fake (the `funding` of the result is still the fake). */
  funding?: FundingClient;
}

/**
 * The use cases over the in-memory adapters. Nothing is provisioned yet: `provisionTenants(core)` registers TENANT_A and
 * TENANT_B through the same use case the TenantCreated consumer runs, so that the tests start like a service that has
 * processed two TenantCreated events. A test of the 503 tenant_not_ready uses a tenant that is not among them.
 */
export function createCore(options: CoreOptions = {}) {
  const logger = new RecordingLogger();
  const store = new MemoryStore({ autoProvision: options.autoProvision ?? false, logger });
  const funding = new FakeFundingClient(options.fundingMode ?? "funded");
  const clock = new TestClock();
  const ids = new SequentialIds();
  const rules = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
  const deps = { store, clock, ids, logger };
  const tokens = new SequentialTokens();
  const finishOpening: FinishOpeningUseCase = new FinishOpening({ ...deps, funding: options.funding ?? funding });
  const retryOpening: RetryOpeningUseCase = new RetryOpening(finishOpening, logger);
  const provisionTenant: ProvisionTenantUseCase = new ProvisionTenant({ store, clock, logger });
  const useCases: MarketUseCases &
    ShareLinkUseCases & {
      finishOpening: FinishOpeningUseCase;
      retryOpening: RetryOpeningUseCase;
      provisionTenant: ProvisionTenantUseCase;
    } = {
    createMarket: new CreateMarket(deps, rules),
    listMarkets: new ListMarkets(store),
    getMarket: new GetMarket(store),
    openMarket: new OpenMarket(deps, finishOpening),
    closeMarket: new CloseMarket(deps),
    resolveMarket: new ResolveMarket(deps),
    createShareLink: new CreateShareLink({ ...deps, tokens }),
    listShareLinks: new ListShareLinks(store, clock),
    revokeShareLink: new RevokeShareLink(deps),
    lookupSharedMarket: new LookupSharedMarket(store, clock),
    admitShareLink: new AdmitShareLink(store, clock),
    finishOpening,
    retryOpening,
    provisionTenant,
  };
  return { store, funding, clock, ids, logger, rules, tokens, useCases };
}

export type Core = ReturnType<typeof createCore>;

/** Registers the tenants as a TenantCreated event does (default TENANT_A and TENANT_B), one event id each. */
export async function provisionTenants(core: Core, tenantIds: readonly string[] = [TENANT_A, TENANT_B]): Promise<void> {
  for (const tenantId of tenantIds) {
    await core.useCases.provisionTenant.execute({
      eventId: `00000000-0000-7000-8000-${tenantId.slice(-12)}`,
      eventType: "si.chance.tenants.TenantCreated.v1",
      tenantId,
      correlationId: `provision-${tenantId.slice(-2)}`,
    });
  }
}

// One RSA key pair per test file: generating it is the slowest step of a harness, and the tests only need tokens that are
// really signed and really verified, not a new key each time.
let sharedKeys: ReturnType<typeof createTestKeys> | undefined;

/** The whole web application over the core above, with real JWT verification against a local key. */
export async function createHarness(options: CoreOptions & { provision?: boolean; metrics?: WebDeps["metrics"] } = {}) {
  const core = createCore(options);
  if (options.provision !== false) await provisionTenants(core);
  const keys = await (sharedKeys ??= createTestKeys());
  const logLines: string[] = [];
  // The key resolver can be made to fail like a JWKS download that does not work (see failKeys).
  let keyFailure: unknown = null;
  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (keyFailure !== null) throw keyFailure as Error;
    return await keys.getKey(header, token);
  };
  let draining = false;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString("utf8"));
      callback();
    },
  });
  const app = buildApp({
    logger: createLogger("info", sink),
    metrics: options.metrics,
    useCases: core.useCases,
    auth: { issuer: ISSUER, audience: AUDIENCE, getKey, rolesClaim: "realm_access.roles", tenantClaim: "organization" },
    internal: { issuer: ISSUER, audience: INTERNAL_AUDIENCE, getKey, clientClaim: "azp", tenantsClientId: TENANTS_CLIENT_ID },
    health: { ping: () => core.store.ping(), isDraining: () => draining },
  });
  await app.ready();

  const sign = (token?: TokenOptions): Promise<string> => keys.sign(token);
  /** Authorization header for a token with the given claims. */
  async function bearer(token?: TokenOptions) {
    return { authorization: `Bearer ${await sign(token)}` };
  }
  /** From now on the key resolver rejects with this error; null makes it work again. */
  const failKeys = (error: unknown): void => {
    keyFailure = error;
  };
  /** Pretends the process got SIGTERM and is in the drain delay (or is running again). */
  const setDraining = (value: boolean): void => {
    draining = value;
  };

  return { app, core, sign, bearer, keys, logLines, failKeys, setDraining };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Claims of the three kinds of caller; `organization` is the tenant alias as Keycloak sends it. */
export const asAdmin = (sub = "admin-1", tenant: string = TENANT_A): TokenOptions => ({ sub, roles: ["tenant-admin"], organization: [tenant] });
export const asTrader = (sub = "trader-1", tenant: string = TENANT_A): TokenOptions => ({ sub, roles: ["trader"], organization: [tenant] });
export const asPlatformAdmin = (sub = "platform-1"): TokenOptions => ({ sub, roles: ["platform-admin"] });

/** The audience of the service tokens of the internal surface (it differs from the users', as it may in a real realm). */
export const INTERNAL_AUDIENCE = "chance-internal-test";
export const TENANTS_CLIENT_ID = "tenants";
/** A client-credentials token of a service: no user claims, the audience of the internal surface and the client id in `azp`. */
export const asService = (client = TENANTS_CLIENT_ID): TokenOptions => ({ sub: `service-account-${client}`, azp: client, audience: INTERNAL_AUDIENCE });

export interface CallOptions {
  /** Claims of the bearer token; null sends no Authorization header. Default: a tenant admin of TENANT_A. */
  token?: TokenOptions | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Answer {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Record<string, any> | null;
}

/** One request through the application, as a client would send it. */
export async function call(h: Harness, method: "GET" | "POST" | "DELETE", url: string, options: CallOptions = {}): Promise<Answer> {
  const auth = options.token === null ? {} : await h.bearer(options.token ?? asAdmin());
  const response = await h.app.inject({
    method,
    url,
    headers: { ...auth, ...options.headers },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

/** Asserts that a real answer has the shape written in contracts/openapi.yaml (`path` as written there, for example "/v1/markets/{id}"). */
export function expectContract(path: string, method: string, answer: Answer): void {
  expect(responseErrors(path, method, answer.status, answer.body), `${method} ${path} -> ${answer.status}`).toEqual([]);
}

/** A valid create request; override one field to test one rule. */
export const validMarket = (h: Harness, overrides: Record<string, unknown> = {}) => ({
  question: "Will the new bridge open before 2027?",
  description: "Counts the first day the bridge is open to traffic.",
  closeTime: closeTimeIn(h.core.clock, 24),
  startingPrice: 0.4,
  fundingAmount: 500,
  ...overrides,
});

/** Creates a draft market through the API; the clock moves a millisecond first, so that ids and times grow. */
export async function draftMarket(h: Harness, token: TokenOptions = asAdmin(), overrides: Record<string, unknown> = {}): Promise<Record<string, any>> {
  h.core.clock.tick();
  const answer = await call(h, "POST", "/v1/markets", { token, body: validMarket(h, overrides) });
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
  return answer.body ?? {};
}

/** Creates a market and opens it (the fake funding client funds it unless the test queued another result). */
export async function openedMarket(h: Harness, token: TokenOptions = asAdmin()): Promise<Record<string, any>> {
  const draft = await draftMarket(h, token);
  const answer = await call(h, "POST", `/v1/markets/${draft["id"]}/open`, { token });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body ?? {};
}

/** A market that is closed. */
export async function closedMarket(h: Harness, token: TokenOptions = asAdmin()): Promise<Record<string, any>> {
  const open = await openedMarket(h, token);
  const answer = await call(h, "POST", `/v1/markets/${open["id"]}/close`, { token });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body ?? {};
}
