import { createRemoteJWKSet } from "jose";
import type pg from "pg";
import { FakeFundingClient } from "./adapters/memory/fake-funding-client.js";
import { MemoryEventPublisher } from "./adapters/memory/memory-publisher.js";
import { MemoryStore } from "./adapters/memory/memory-store.js";
import { AutoCloseWorker } from "./adapters/auto-close/worker.js";
import { MeteredCloseDueMarkets, createAutoCloseCounter } from "./adapters/metrics/auto-close-metrics.js";
import { createMetrics, startMetricsServer } from "./adapters/metrics/metrics.js";
import { NatsEventPublisher } from "./adapters/nats/nats-event-publisher.js";
import { TenantCreatedConsumer } from "./adapters/nats/tenant-created-consumer.js";
import { OpeningRetryWorker } from "./adapters/opening-retry/worker.js";
import { OutboxRelay } from "./adapters/outbox/relay.js";
import { streamMaxAgeMs } from "./adapters/retention.js";
import { runMigrations } from "./adapters/postgres/migrate.js";
import { PostgresStore, createPool } from "./adapters/postgres/postgres-store.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "./adapters/runtime-config.js";
import { randomIds, randomShareTokens, systemClock } from "./adapters/system.js";
import { ClientCredentialsTokenProvider } from "./adapters/trading/token-provider.js";
import { TradingFundingClient } from "./adapters/trading/trading-funding-client.js";
import { ConfigError, keycloakTokenUrl, loadConfig, runtimeKeysInEnv, runtimeSettingsOf, worstFundingCallMs } from "./config.js";
import { createLogger } from "./logger.js";
import { createShutdown, registerShutdownSignals } from "./shutdown.js";
import { AdmitShareLink } from "./usecases/admit-share-link.js";
import { CloseDueMarkets } from "./usecases/close-due-markets.js";
import { CloseMarket } from "./usecases/close-market.js";
import { CreateMarket } from "./usecases/create-market.js";
import { CreateShareLink } from "./usecases/create-share-link.js";
import { FinishOpening } from "./usecases/finish-opening.js";
import { GetMarket } from "./usecases/get-market.js";
import { ListMarkets } from "./usecases/list-markets.js";
import { ListShareLinks } from "./usecases/list-share-links.js";
import { LookupSharedMarket } from "./usecases/lookup-shared-market.js";
import { OpenMarket } from "./usecases/open-market.js";
import type { EventPublisher, FundingClient, Store } from "./usecases/ports.js";
import { ProvisionTenant } from "./usecases/provision-tenant.js";
import { ResolveMarket } from "./usecases/resolve-market.js";
import { RetryOpening } from "./usecases/retry-opening.js";
import { RevokeShareLink } from "./usecases/revoke-share-link.js";
import { buildApp } from "./web/app.js";
import { tenantOfRequest } from "./web/auth.js";

// Composition root: configuration -> adapters -> use cases -> web application. Nothing else wires things together.

const MIGRATION_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const logger = createLogger(config.logLevel);
  logger.info({ appEnv: config.appEnv }, "Starting markets");

  // Runtime settings (ADR-037): the use cases read the market rules from the holder on every request; the watcher
  // replaces them, and the log level, when the mounted file changes. Without a file the startup values stay.
  const rules = new RuntimeSettingsHolder(runtimeSettingsOf(config));
  const runtimeConfig = config.runtimeConfigFile
    ? new RuntimeConfigWatcher({
        file: config.runtimeConfigFile,
        pollMs: config.runtimeConfigPollMs,
        startup: runtimeSettingsOf(config),
        setInEnv: runtimeKeysInEnv(process.env),
        logger,
        onChange: (settings) => {
          rules.set(settings);
          logger.level = settings.logLevel;
        },
      })
    : null;

  // Adapters. Without a setting, only APP_ENV=local falls back to memory; loadConfig has refused anything else.
  let store: Store;
  let pool: pg.Pool | null = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.databasePoolMax, logger);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runMigrations(pool, logger);
        break;
      } catch (error) {
        if (attempt >= MIGRATION_ATTEMPTS) throw error;
        logger.warn({ attempt, err: error }, "The database is not ready for migrations, trying again");
        await sleep(3000);
      }
    }
    store = new PostgresStore(pool, logger);
  } else {
    logger.warn({}, "DATABASE_URL is not set: keeping all data in memory (APP_ENV=local)");
    // A tenant is registered on its first request, because no TenantCreated arrives without a database and a broker.
    store = new MemoryStore({ autoProvision: true, logger });
  }

  let publisher: EventPublisher;
  let nats: NatsEventPublisher | null = null;
  // One max age for the stream and for the relay's purge of published rows, so that the two always agree.
  const streamMaxAge = streamMaxAgeMs(config.streamMaxAgeDays);
  if (config.natsUrl) {
    nats = new NatsEventPublisher(config.natsUrl, logger, streamMaxAge);
    publisher = nats;
    // The service starts without the broker; events wait in the outbox until it answers.
    nats.ready().catch((error: unknown) => logger.warn({ err: error }, "NATS is not reachable yet; events wait in the outbox"));
  } else {
    logger.warn({}, "NATS_URL is not set: events are only logged (APP_ENV=local)");
    publisher = new MemoryEventPublisher(logger);
  }

  // One funding client per process: its circuit breaker is shared by the requests and by the opening-retry worker.
  let funding: FundingClient;
  if (config.trading) {
    if (!config.keycloak) throw new Error("TRADING_URL is set without KEYCLOAK_URL: loadConfig should have refused this");
    const tokens = new ClientCredentialsTokenProvider({
      tokenUrl: keycloakTokenUrl(config.keycloak),
      clientId: config.keycloak.clientId,
      clientSecret: config.keycloak.clientSecret,
    });
    funding = new TradingFundingClient({ baseUrl: config.trading.baseUrl, tokens, policy: config.funding, logger });
  } else {
    logger.warn({ mode: config.fakeFundingMode }, "TRADING_URL is not set: using a fake funding client (APP_ENV=local)");
    funding = new FakeFundingClient(config.fakeFundingMode);
  }

  // Use cases. OpenMarket and the retry worker share one FinishOpening, so a request and the worker settle an opening
  // the same way (DM-19).
  const deps = { store, clock: systemClock, ids: randomIds, logger };
  const finishOpening = new FinishOpening({ ...deps, funding });
  const retryOpening = new RetryOpening(finishOpening, logger);
  const useCases = {
    createMarket: new CreateMarket(deps, rules),
    listMarkets: new ListMarkets(store),
    getMarket: new GetMarket(store),
    openMarket: new OpenMarket(deps, finishOpening),
    closeMarket: new CloseMarket(deps),
    resolveMarket: new ResolveMarket(deps),
    createShareLink: new CreateShareLink({ ...deps, tokens: randomShareTokens }),
    listShareLinks: new ListShareLinks(store, systemClock),
    revokeShareLink: new RevokeShareLink(deps),
    lookupSharedMarket: new LookupSharedMarket(store, systemClock),
    admitShareLink: new AdmitShareLink(store, systemClock),
  };
  const provisionTenant = new ProvisionTenant({ store, clock: systemClock, logger });

  // True from the first SIGTERM on; the readiness probe reads it.
  let shuttingDown = false;

  // Request metrics; the tenant label is the tenant of the verified token (request.auth is set only after the check).
  // The automatic close adds its own counter to the same registry.
  const metrics = createMetrics({ tenantOf: tenantOfRequest });
  const autoCloseCounter = createAutoCloseCounter(metrics.registry);

  const app = buildApp({
    logger,
    metrics,
    useCases,
    auth: {
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      getKey: createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 }),
      rolesClaim: config.auth.rolesClaim,
      tenantClaim: config.auth.tenantClaim,
    },
    // The internal surface: the same key set, its own audience, and the one client (tenants) that may call it.
    internal: {
      issuer: config.auth.issuer,
      audience: config.auth.internalAudience,
      getKey: createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: 3000 }),
      clientClaim: config.auth.internalClientClaim,
      tenantsClientId: config.auth.tenantsClientId,
    },
    health: { ping: () => store.ping(), isDraining: () => shuttingDown },
  });

  // Background loops: the relay publishes the outbox, the worker finishes the openings whose funding call had no
  // answer (DM-19), the consumer registers the tenants that tenants announces (only with a broker).
  const relay = new OutboxRelay({ store, publisher, clock: systemClock, logger, pollMs: config.outboxPollMs, streamMaxAgeMs: streamMaxAge });
  const openingRetry = new OpeningRetryWorker({
    store,
    retry: retryOpening,
    clock: systemClock,
    logger,
    intervalMs: config.openingRetryIntervalMs,
    // A row is started only when one whole funding call still ends inside the lease (loadConfig keeps a margin).
    worstCallMs: worstFundingCallMs(config.funding),
  });
  // UC-15: closes the markets whose close time has passed, through the same step as the admin's close. Its switch and
  // interval are runtime keys, read from the holder at every run.
  const autoClose = new AutoCloseWorker({
    store,
    close: new MeteredCloseDueMarkets(new CloseDueMarkets(deps), autoCloseCounter),
    logger,
    settings: () => rules.autoClose(),
  });
  const consumer = config.natsUrl ? new TenantCreatedConsumer({ url: config.natsUrl, provision: provisionTenant, logger }) : null;

  // The first read of the runtime file comes before the first request, so the startup log level and rules are the file's.
  await runtimeConfig?.start();
  // GET /metrics has a listener of its own: the API port never serves it, so the gateway can never route it.
  const metricsServer = await startMetricsServer(metrics.registry, { port: config.metricsPort });
  logger.info({ port: metricsServer.port }, "Serving metrics");
  await app.listen({ host: "0.0.0.0", port: config.port });
  relay.start();
  openingRetry.start();
  autoClose.start();
  consumer?.start();

  // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from a terminal): src/shutdown.ts has the order and the timing.
  const shutdown = createShutdown(
    {
      drain: () => {
        shuttingDown = true;
      },
      closeServer: async () => {
        await app.close();
        await metricsServer.close();
      },
      stopConsumer: async () => {
        await consumer?.stop();
      },
      stopOpeningRetry: () => openingRetry.stop(),
      stopAutoClose: () => autoClose.stop(),
      stopRelay: () => relay.stop(),
      stopRuntimeConfig: async () => {
        await runtimeConfig?.stop();
      },
      closeEvents: async () => {
        await nats?.close();
      },
      closeDatabase: async () => {
        await pool?.end();
      },
    },
    { logger, delayMs: config.shutdownDelayMs, exit: (code) => process.exit(code) },
  );
  registerShutdownSignals(shutdown);
}

main().catch((error: unknown) => {
  console.error("markets failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
