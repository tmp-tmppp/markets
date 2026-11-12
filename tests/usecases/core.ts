import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { FakeFundingClient } from "../../src/adapters/memory/fake-funding-client.js";
import type { FakeFundingMode } from "../../src/config.js";
import type { Market, MarketRules } from "../../src/domain/market.js";
import { AdmitShareLink } from "../../src/usecases/admit-share-link.js";
import { CloseDueMarkets } from "../../src/usecases/close-due-markets.js";
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
import { ResolveMarket } from "../../src/usecases/resolve-market.js";
import { RetryOpening } from "../../src/usecases/retry-opening.js";
import { RevokeShareLink } from "../../src/usecases/revoke-share-link.js";
import type { Actor, FundingClient, MarketRulesSource, Store, TenantRepositories } from "../../src/usecases/ports.js";
import { RecordingLogger, SequentialIds, SequentialTokens, TENANT_A, TENANT_B, TestClock, actor, closeTimeIn } from "../support/fakes.js";

// Wiring of the use cases over the in-memory adapters, for the tests of this folder (the web tests have their own harness).

export const RULES: MarketRules = { fundingMin: 100, fundingMax: 100_000, minLeadMs: 5 * 60_000 };

/** The runtime rules as a mutable holder, so that a test can change them while the "service" runs. */
export class MutableRules implements MarketRulesSource {
  constructor(public rules: MarketRules = RULES) {}
  current(): MarketRules {
    return this.rules;
  }
}

export interface CoreOptions {
  fundingMode?: FakeFundingMode;
  /** Register TENANT_A and TENANT_B (the default); false leaves the store empty, like a service that got no TenantCreated yet. */
  provision?: boolean;
  /** A funding client of the test's own, in place of the fake. */
  funding?: FundingClient;
}

export async function createCore(options: CoreOptions = {}) {
  const store = new MemoryStore();
  const fake = new FakeFundingClient(options.fundingMode ?? "funded");
  const funding = options.funding ?? fake;
  const clock = new TestClock();
  const ids = new SequentialIds();
  const logger = new RecordingLogger();
  const rules = new MutableRules();
  if (options.provision !== false) {
    await store.repositories.tenants.provision(TENANT_A, clock.now());
    await store.repositories.tenants.provision(TENANT_B, clock.now());
  }
  const deps = { store, clock, ids, logger };
  const finishOpening = new FinishOpening({ ...deps, funding });
  const tokens = new SequentialTokens();
  const useCases = {
    createMarket: new CreateMarket(deps, rules),
    listMarkets: new ListMarkets(store),
    getMarket: new GetMarket(store),
    openMarket: new OpenMarket(deps, finishOpening),
    closeMarket: new CloseMarket(deps),
    closeDueMarkets: new CloseDueMarkets(deps),
    resolveMarket: new ResolveMarket(deps),
    createShareLink: new CreateShareLink({ ...deps, tokens }),
    listShareLinks: new ListShareLinks(store, clock),
    revokeShareLink: new RevokeShareLink(deps),
    lookupSharedMarket: new LookupSharedMarket(store, clock),
    admitShareLink: new AdmitShareLink(store, clock),
    finishOpening,
    retryOpening: new RetryOpening(finishOpening, logger),
    provisionTenant: new ProvisionTenant({ store, clock, logger }),
  };
  return { store, funding: fake, clock, ids, logger, rules, tokens, deps, useCases };
}

export type Core = Awaited<ReturnType<typeof createCore>>;

export const ADMIN = "admin-1";
export const OTHER_ADMIN = "admin-2";
export const TRADER = "trader-1";

/** A valid create request; fields can be overridden to test one rule at a time. */
export function createInput(core: Core, overrides: Partial<{ question: string; description: string; closeTime: string; startingPrice: number; fundingAmount: number }> = {}) {
  return {
    question: "Will the new bridge open before 2027?",
    closeTime: closeTimeIn(core.clock, 24),
    startingPrice: 0.4,
    fundingAmount: 500,
    ...overrides,
  };
}

export async function createDraft(core: Core, by: Actor = actor(ADMIN), overrides: Parameters<typeof createInput>[1] = {}): Promise<Market> {
  core.clock.tick();
  return core.useCases.createMarket.execute({ actor: by, ...createInput(core, overrides) });
}

/** A market that was funded and is open. */
export async function createOpenMarket(core: Core, by: Actor = actor(ADMIN)): Promise<Market> {
  const draft = await createDraft(core, by);
  const { market } = await core.useCases.openMarket.execute({ actor: by, marketId: draft.id });
  return market;
}

export async function createClosedMarket(core: Core, by: Actor = actor(ADMIN)): Promise<Market> {
  const open = await createOpenMarket(core, by);
  return core.useCases.closeMarket.execute({ actor: by, marketId: open.id });
}

export const tenantAdmin = (userId = ADMIN, tenantId = TENANT_A) => actor(userId, "tenant-admin", tenantId);
export const trader = (userId = TRADER, tenantId = TENANT_A) => actor(userId, "trader", tenantId);
export { TENANT_A, TENANT_B };

/** The store with the outbox of the given markets broken, as a database error on their rows would be. */
export function failingOutboxFor(store: Store, ...marketIds: string[]): Store {
  const broken = (repositories: TenantRepositories): TenantRepositories => ({
    ...repositories,
    outbox: { ...repositories.outbox, add: (message) => (marketIds.includes(message.aggregateId) ? Promise.reject(new Error("database error")) : repositories.outbox.add(message)) },
  });
  return {
    repositories: store.repositories,
    transaction: (work) => store.transaction(work),
    ping: () => store.ping(),
    async forTenant(tenantId) {
      const tenant = await store.forTenant(tenantId);
      if (!tenant) return null;
      return { tenantId: tenant.tenantId, repositories: tenant.repositories, transaction: (work) => tenant.transaction((repositories) => work(broken(repositories))) };
    },
  };
}

/**
 * A store that runs `beforeTransaction` before every tenant transaction starts: a competing request that commits
 * between a use case's read and its write, to test the version checks of the saga and of close and resolve.
 */
export function racing(store: Store, beforeTransaction: () => Promise<void>): Store {
  return {
    repositories: store.repositories,
    transaction: (work) => store.transaction(work),
    ping: () => store.ping(),
    async forTenant(tenantId) {
      const tenant = await store.forTenant(tenantId);
      if (!tenant) return null;
      return {
        tenantId: tenant.tenantId,
        repositories: tenant.repositories,
        transaction: async (work) => {
          await beforeTransaction();
          return tenant.transaction(work);
        },
      };
    },
  };
}
