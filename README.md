# markets

The prediction markets of **Chance**. Inside one tenant (an organization), a tenant admin creates a market (a yes/no
question with a close time, a starting price and a funding amount), opens it, closes it and finally resolves it with
the outcome; traders read the markets that are open, closed or resolved. Opening a market is funded by its creator's
credits, which this service takes from **trading** through an internal call (a saga: the call can be repeated safely
until its outcome is known). Every market belongs to exactly one tenant, and the tenant always comes from the token.

## API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml) (OpenAPI 3.1). Every endpoint except the health probes
needs a bearer token from the identity provider; errors are RFC 9457 problem details (`application/problem+json`)
with a stable `code`; every API answer carries `Cache-Control: private, no-store` and `X-Correlation-Id`.

| Method and path | Who | What |
|---|---|---|
| `GET /v1/markets?status=&limit=&cursor=` | trader, tenant admin | List the tenant's markets, newest first (cursor pagination). A trader sees open, closed and resolved ones only |
| `GET /v1/markets/{id}` | trader, tenant admin | One market; a draft or opening market is `404` for a trader |
| `POST /v1/markets` | tenant admin | Create a market in `draft` (`201` and `Location`) |
| `POST /v1/markets/{id}/open` | the market's creator | Fund and open it: `200` open, `202` opening (outcome unknown, finished in the background), `409`, `502` or `503` (see "Opening a market") |
| `POST /v1/markets/{id}/close` | tenant admin | `open` to `closed` |
| `POST /v1/markets/{id}/resolve` | tenant admin | `closed` to `resolved` with `{"outcome": "YES", "NO" or "INVALID"}`. `INVALID` (UC-16): the question cannot be answered; the market is resolved all the same (version + 1, MarketResolved with `outcome` `INVALID`) and trading refunds every stake and returns the rest of the funding to the creator |
| `POST /v1/markets/{id}/share-links` | trader, tenant admin (as the market's sharing policy allows) | Make a share link of type `members`, `profiles` (with `emails`) or `everyone`, optionally with `expiresAt`: `201` with the token (shown once) and the share URL path `/share#<token>` |
| `GET /v1/markets/{id}/share-links` | trader (own links), tenant admin (all) | The links of a market, newest first, cursor pagination, never with tokens |
| `DELETE /v1/markets/{id}/share-links/{linkId}` | the link's creator, tenant admin | Revoke a link (`204`, repeatable) |
| `POST /v1/shared-markets/lookup` | public (bearer token optional) | `{"token"}` in the body: the market summary, the organization and what the caller may do next; one `404` for an unknown, expired or revoked token; `403` with the organization's display name only when the link is not for the caller |
| `POST /v1/internal/share-links/admission` | the service tenants only | `{token, userEmail, emailVerified}`: `join`, `members_only` or `denied` for the caller; not routed by the gateway |
| `GET /health/startup`, `/health/ready`, `/health/live` | Kubernetes | Probes; readiness checks the database and answers `503` as soon as the process gets SIGTERM, liveness only the process |

Token contract v2: the token names exactly one organization (the tenant). The tenant role is that organization's group,
`/tenant-admin` or `/trader`, in `organization.<alias>.groups`; a token with both groups, another group or none has no
tenant role, and a realm role `trader` or `tenant-admin` counts for nothing. `platform-admin` stays a realm role. A
platform admin sees no tenant's data and gets `403` on every markets endpoint, as does a token without a tenant or
without a tenant role. A market of another tenant answers `404`, exactly like one that does not exist. A trader who asks
for `status=draft` or `status=opening` gets `403`.

Sharing: `POST /v1/markets` takes an optional `sharing` (`{"whoMayShare": "none" | "admins" | "members", "linkTypes":
[...]}` of `members`, `profiles`, `everyone`; default `members` and `["members"]`). It is stored with the market, returned
on every read and fixed for the life of the market (there is no update endpoint). Only open, closed and resolved markets
can be shared. A share link is 32 random bytes in base64url, shown once and stored as its SHA-256 only; the URL keeps it
after `#` (`/share#<token>`), the API takes it in a body, and no log line holds it. A `profiles` link lists 1 to 50
e-mail addresses (kept in lower case) that are compared with the verified e-mail of the signed-in caller. The audit log
records `ShareLinkCreated` and `ShareLinkRevoked` without a change of its own (they carry ids, never tokens or addresses).
The organization's display name for the lookup comes from `data.name` of TenantCreated; a tenant registered before this
service kept names shows none (`name: null`).

A market has a `question` (10 to 200 characters), a `description` (up to 2000), a `closeTime` (later than now plus
`MARKET_MIN_LEAD_MS`, at most 366 days ahead), a `startingPrice` (the YES price, 0.01 to 0.99, at most 2 decimals; NO
starts at 1 minus it) and a `fundingAmount` (a positive integer in the same unit as payments' amount, between
`MARKET_FUNDING_MIN` and `MARKET_FUNDING_MAX`). Its status goes `draft`, `opening`, `open`, `closed`, `resolved`, and
from `opening` back to `draft` when the funding is refused. Every change raises its `version` by one (DM-04); any other
change of status is `409 invalid_state`.

Status codes worth knowing:

- `401` means the token is wrong (expired, bad signature, wrong issuer or audience, unknown key id, malformed).
- `503` with `Retry-After` means the request cannot be served right now and may simply be repeated: the identity
  provider's signing keys cannot be fetched (`identity_provider_unavailable`), the caller's tenant is still being set up
  here (`tenant_not_ready`, see "Consuming TenantCreated"), or, when opening, trading cannot be called and nothing was
  sent (`trading_unavailable`).
- `400` also for an unknown field in a body and for a `cursor` this service did not issue.

## Events

Contract: [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) (AsyncAPI 3.0); notes for consumers:
[`contracts/README.md`](contracts/README.md).

| Event | When |
|---|---|
| `si.chance.markets.MarketOpened.v1` | A market became `open` (its funding succeeded) |
| `si.chance.markets.MarketClosed.v1` | A market was closed: by a tenant admin, or by the service when its close time passed (`closedBy` is then `system:auto-close`, see "Closing markets automatically") |
| `si.chance.markets.MarketResolved.v1` | A tenant admin resolved a market: `outcome` is `YES`, `NO` or `INVALID` (UC-16; consumers must accept all three) |
| `si.chance.markets.ShareLinkCreated.v1` | A member made a share link (the id of the link, its type and expiry; never the token or the addresses) |
| `si.chance.markets.ShareLinkRevoked.v1` | An active share link was revoked |

Events are CloudEvents 1.0 on NATS JetStream (stream `MARKETS`, subjects `chance.markets.<Event>.<tenantId>`). They
carry ids only, never names or e-mails (DM-14), and the market's `version`, so a consumer updates its copy only
`WHERE version < new`. They are written to an outbox table in the same transaction as the change and published by a
relay inside the service (transactional outbox), so a change is never stored without its event or published without
being stored. Only one instance publishes at a time (an advisory lock for the length of the claim), so the events of a
market keep their order with several replicas; published rows are deleted after the max age of the stream
(`STREAM_MAX_AGE_DAYS`, 30 days by default).

The service also **consumes** `TenantCreated` of the tenants service (see below).

## Opening a market (saga, DM-19)

Opening spans two services, so it is a saga whose every step can be repeated. Only the market's creator may open it
(their credits fund it).

1. **Claim.** One transaction moves the market from `draft` to `opening` (`UPDATE ... WHERE status = 'draft' AND version
   = expected`, so only one of several concurrent openers wins) and writes a row in `shared.pending_openings`.
2. **Fund.** Outside any transaction the service calls trading, `POST /v1/internal/market-funding` with
   `Idempotency-Key: <marketId>` and a bearer token that Keycloak issued to the client `markets` (client credentials,
   cached until shortly before it expires). The call has a timeout per attempt, retries with exponential backoff and
   jitter on network errors, timeouts and `5xx`, and a circuit breaker; one policy per process. Trading's side of the
   agreement: [`contracts/outgoing/trading-market-funding.openapi.yaml`](contracts/outgoing/trading-market-funding.openapi.yaml).
3. **Settle.** A second transaction applies the outcome:

   | Trading answered | The market | Answer to the caller |
   |---|---|---|
   | `200` or `201` (funded) | `opening` to `open`; `MarketOpened` in the outbox; pending row deleted | `200` |
   | `409` insufficient credits | back to `draft` | `409` with the problem `insufficient-credits` |
   | circuit open or no service token, nothing was sent | back to `draft` | `503` with `Retry-After` (`trading_unavailable`) |
   | another `4xx` (400, 401, 403, 404, 422) | back to `draft`, logged as an error | `502` with the problem `funding-rejected` |
   | timeout, network error, `5xx` after the retries | stays `opening` | `202`; the background worker goes on |

   The two "back to `draft`" rows for nothing sent and for `401`/`403` hold only for the request's own first call. On a
   retry, an earlier attempt may already have funded the market, so the market stays `opening` and the worker tries
   again; only a definite answer (funded, `409` insufficient credits, or another refusal) settles it.

4. **Retry worker.** Every `OPENING_RETRY_INTERVAL_MS` the service claims due rows of `shared.pending_openings` with
   `FOR UPDATE SKIP LOCKED` (a 60 second lease, up to 5 rows, so several instances never take the same one) and runs
   the same "finish opening" step with the same idempotency key. While the outcome stays unknown the row is tried again
   after 2 s, 4 s, 8 s ... up to 5 minutes; it never gives up (the idempotency key makes every repeat safe) and logs every
   attempt. Asking to open a market that is already `opening` answers `202` without a new call. Trading stores only a
   completed funding under the key, never a refusal, so a market that went back to `draft` (for example after
   `409` insufficient credits) is opened again with the same key once the creator has topped up.

## Closing markets automatically (UC-15)

A market closes by itself when its `closeTime` has passed (plan section 4 UC-15; section 12 lists it as a stretch goal,
solved here with an in-service scheduler instead of a serverless timer). A background worker, shaped like the
opening-retry worker, runs in every replica every `AUTO_CLOSE_INTERVAL_MS` (default 15 s):

1. **Which tenants.** It reads the registry of tenants (`shared.tenant_registry`, one query) and visits each tenant's
   schema. The registry is scanned instead of keeping a shared index of deadlines: the markets stay the only source of
   truth (nothing to keep in step, nothing to backfill), and a visit is one probe of the partial index
   `markets_open_close_time_idx` (tenant migration `003`, open markets only), so a tenant with nothing due costs one index
   lookup. The price is one probe per tenant and run; with thousands of tenants a shared table of deadlines would be the
   next step.
2. **Claiming.** For a tenant with a due market it claims one market at a time, in a transaction of its own:
   `WHERE status = 'open' AND close_time <= now ORDER BY close_time, id LIMIT 1 FOR UPDATE SKIP LOCKED`. Replicas that run
   at the same moment pass over each other's rows, so no market is closed twice. The update is also conditional on the
   status and version that were read, so a market an admin closes at the same instant is closed by exactly one of the two
   (the admin's request answers `409`).
3. **Closing.** The claimed market goes through the same step as `POST /v1/markets/{id}/close`: open -> closed, `version`
   + 1, `closedAt` now, and the `MarketClosed` event in the outbox, all in one transaction. `closedBy` is the fixed value
   `system:auto-close` (still a string; see `contracts/`). Only `open` markets are touched: `draft`, `opening`, `closed`
   and `resolved` ones never are, so nothing is closed twice and the event's version guard at the consumers is unchanged.
4. **Failures.** A market that fails rolls back alone, is logged at `error`, is left out of the rest of that run and is
   tried again at the next one. A tenant whose schema cannot be read is logged and the other tenants go on (it is logged
   again at every run until it is fixed). A run takes at most 50 markets of a tenant (closed or failed). A tenant whose
   whole batch of 50 was closed is continued at once, not after the interval; a run in which any market failed is not, so a
   failing market is tried once per interval and never in a loop without a pause.

A market therefore closes within about `AUTO_CLOSE_INTERVAL_MS` after its close time and shows `open` until then. The kill
switch `AUTO_CLOSE_ENABLED=false` (a runtime key) closes nothing; a value that is not `true` or `false` also switches it off
(see "Runtime configuration"). The switch and the interval are read at every run, so a change applies without a restart
(an interval change within 5 seconds). With several replicas the work is shared by the claim, not by a leader.

## Consuming TenantCreated

Markets is the first consumer of an event in the system, so it sets the convention. A durable pull consumer `markets`
on the stream `TENANTS` (filter `chance.tenants.TenantCreated.*`, explicit ack, deliver all, ack wait 30 seconds) is
created or updated whenever the service connects. For each event one transaction:

- stores the event id in `shared.inbox` (a repeat of an id commits nothing and is acknowledged),
- creates the tenant's schema `tenant_<32 hex digits of the tenant id>` if it is missing (the same naming rule as the
  payments service) and applies every tenant migration to it,
- registers the tenant in `shared.tenant_registry`.

The message is acknowledged only after the commit; a transient failure is negatively acknowledged with a delay; a
malformed event or an unknown type is logged as a warning and acknowledged, so one poison message never blocks the
consumer. The tenant id comes from the `tenantid` extension. Until a tenant's event has been processed, its requests
answer `503` with `Retry-After` (`tenant_not_ready`). Inbox rows are purged after the stream's max age (`STREAM_MAX_AGE_DAYS`) plus a day (DM-06).

At startup the migrator (under an advisory lock) applies the shared migrations and then brings every registered tenant
schema up to the latest tenant migration, so schemas never drift.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message when a required one is
missing or invalid, and never prints a value. In Kubernetes the non-secret ones come from the chart's ConfigMap and the
secret ones from the Secret `markets-env`. The rows marked **runtime** can also change while the service runs (see
"Runtime configuration"). The source of truth is [`src/config.ts`](src/config.ts); `APP_ENV=local` is the only mode
that may leave out the settings marked "required" below (it then uses in-memory replacements).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | `local` allows in-memory replacements for the database, NATS and trading (a fake funding client, so no service token is needed); tokens are still verified against `AUTH_JWKS_URL`, so a local identity provider or a key set of your own is needed; any other value needs every required setting |
| `PORT` | `8080` | no | HTTP port |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | **runtime.** `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `RUNTIME_CONFIG_FILE` | none | no | Path of the watched runtime file (the chart sets `/etc/markets/runtime/runtime.env`); without it no file is watched |
| `RUNTIME_CONFIG_POLL_MS` | `10000` | no | How often that file is read again (1000 to 3600000) |
| `DATABASE_URL` | required | **yes** | PostgreSQL connection string of the service's own database `markets` |
| `DATABASE_POOL_MAX` | `5` | no | Maximum database connections (1 to 50) |
| `NATS_URL` | required | no | NATS server (`nats://` or `tls://`) |
| `KEYCLOAK_URL` | required | no | Keycloak base URL, for the token markets sends to trading (in the cluster `http://identity:8080`) |
| `KEYCLOAK_REALM` | required with `KEYCLOAK_URL` | no | Realm name |
| `MARKETS_CLIENT_ID` | `markets` | no | The service-account client of this service |
| `MARKETS_CLIENT_SECRET` | required with `KEYCLOAK_URL` | **yes** | Its client secret |
| `AUTH_JWKS_URL` | required (local default) | no | Where the token signing keys are published |
| `AUTH_ISSUER` | required (local default) | no | Expected `iss` of the tokens |
| `AUTH_AUDIENCE` | required (local default) | no | Expected `aud` of the tokens |
| `AUTH_ROLES_CLAIM` | `realm_access.roles` | no | Claim path of the roles |
| `AUTH_TENANT_CLAIM` | `organization` | no | Claim of the tenant (the Keycloak organization alias is the tenant id); the tenant role is read from `<claim>.<alias>.groups` |
| `INTERNAL_AUTH_AUDIENCE` | `AUTH_AUDIENCE` | no | Expected `aud` of the service tokens of the internal endpoint (the client-credentials token of tenants) |
| `INTERNAL_AUTH_CLIENT_CLAIM` | `azp` | no | Claim that names the calling client in a service token |
| `INTERNAL_AUTH_TENANTS_CLIENT_ID` | `tenants-markets` | no | The client id that tenants uses for its calls to markets (a client of its own with the audience `chance` and no Admin API role, not the admin client `tenants`), the only caller of `POST /v1/internal/share-links/admission` (any other client, and every user's token, gets `403`) |
| `TRADING_URL` | required | no | Base URL of trading's internal funding endpoint (the chart builds it from `trading.host` and `trading.port`) |
| `FUNDING_TIMEOUT_MS` | `3000` | no | Timeout of one funding attempt (100 to 60000); with `FUNDING_RETRIES` the longest call must fit in the 60 s lease of a pending opening with a 5 s margin, or the service refuses to start |
| `FUNDING_RETRIES` | `2` | no | Retries after the first attempt, on network errors, timeouts, `408`, `429` and `5xx` (0 to 10) |
| `FUNDING_CIRCUIT_FAILURES` | `5` | no | Consecutive failures that open the circuit breaker (1 to 100) |
| `FUNDING_CIRCUIT_HALF_OPEN_MS` | `10000` | no | How long the circuit stays open before one call may try again (1000 to 600000) |
| `OPENING_RETRY_INTERVAL_MS` | `5000` | no | How often the retry worker looks for due openings (100 to 600000) |
| `OUTBOX_POLL_MS` | `300` | no | How often the relay looks for unpublished events (50 to 60000) |
| `STREAM_MAX_AGE_DAYS` | `30` | no | How long the `MARKETS` stream keeps its messages, in days (1 to 365). The relay deletes its published outbox rows after the same time and the inbox entries a day later, so every Chance service runs with the same value. The service brings an existing stream to this value at every start, so **lowering it deletes the older messages from the stream at the next start**. It is long on purpose, so that a service started later still sees the older events: lower it back (for example to 7) once every consumer is live |
| `MARKET_FUNDING_MIN` | `100` | no | **runtime.** Smallest funding amount of a market, in credits (1 to 1000000, not above the maximum); plan Q-10 is still open |
| `MARKET_FUNDING_MAX` | `100000` | no | **runtime.** Largest funding amount (1 to 1000000) |
| `MARKET_MIN_LEAD_MS` | `300000` | no | **runtime.** How far ahead of now a new market's close time must lie (0 to one week) |
| `AUTO_CLOSE_ENABLED` | `true` | no | **runtime.** The kill switch of the automatic close at the close time (UC-15, see "Closing markets automatically"): `false` closes nothing. It **fails closed**: any value but `true` or `false` (`flase`, an empty value) switches it off, and at startup the service refuses to start and names the key |
| `AUTO_CLOSE_INTERVAL_MS` | `15000` | no | **runtime.** The wait between two runs of the automatic close over the tenants (1000 to 3600000); a change applies within 5 seconds |
| `SHUTDOWN_DELAY_MS` | `5000` (`0` when `APP_ENV=local`) | no | Drain delay after SIGTERM, 0 to 15000 (see "Shutdown") |
| `FAKE_FUNDING_MODE` | `funded` | no | **Local only** (an error otherwise): what the fake funding client answers, `funded`, `insufficient` or `unknown` |

With `APP_ENV=local` the token settings default to a Keycloak on port 8081 (`AUTH_JWKS_URL`, `AUTH_ISSUER` and
`AUTH_AUDIENCE` as in `src/config.ts`); tokens are always verified. Setting `TRADING_URL` locally also needs
`KEYCLOAK_URL`, because the funding call needs a service token.

### Runtime configuration

Six keys (`LOG_LEVEL`, `MARKET_FUNDING_MIN`, `MARKET_FUNDING_MAX`, `MARKET_MIN_LEAD_MS`, `AUTO_CLOSE_ENABLED`, `AUTO_CLOSE_INTERVAL_MS`) can change without a restart
(ADR-037). The order is: defaults, then the watched file `RUNTIME_CONFIG_FILE`, then environment variables, so a key
set in the environment always wins and the file's value for it is ignored (and logged); the chart therefore sets these
keys only in the file. The file's lines are `KEY=value` (blank lines and lines starting with `#` are skipped). The service reads the file at start and then every
`RUNTIME_CONFIG_POLL_MS`; a key that is missing from the file keeps its startup value, so deleting a line undoes an
override. A missing, unreadable or invalid file never stops the service: it keeps what it has, and logs the problem. **The kill
switch `AUTO_CLOSE_ENABLED` fails closed instead:** a value that is not `true` or `false`, an empty one included
(`AUTO_CLOSE_ENABLED=flase`, `AUTO_CLOSE_ENABLED=`), switches the automatic close off, whatever was in force and also
after a restart that reads the same file, and the service logs it at `error`; a typo never leaves the feature running. A
misspelled key such as `AUTO_CLOSE_ENABLE=false` is an unknown key: it is logged at `warn` and ignored, so check the log
after editing the switch. A bad `AUTO_CLOSE_INTERVAL_MS` keeps the startup interval.

In the chart the six keys are the `runtime` block of the values. They are rendered into a second ConfigMap,
`<release>-runtime` (key `runtime.env`), which the Pods mount as the directory `/etc/markets/runtime` (never as a
`subPath`, which would not update). That ConfigMap is left out of the Deployment's checksum annotation on purpose: a
change reaches the running Pods within about a minute (the kubelet refreshes the mount, then the poll) and does not
restart them. The six keys therefore live only there, not in the environment ConfigMap, so a value never has two
sources. Everything else in `env` is read at start, and a change restarts the Pods.

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). The default is the same in every service, so
  services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own
  address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/markets/:id/share-links`), or `unmatched` for a request that matched no route
  (a 404, or the 400 and 414 of a URL Fastify cannot route: a malformed percent-encoding, a path parameter over the limit,
  counted by `recordFrameworkError` because those answers bypass the hooks), so a raw URL or an id never becomes a label
  value. A share-link token travels in the request body, never in a path, and no label ever holds it.
- **`tenant`** is the tenant id in the token the service verified, `none` when the request has no verified token (the
  probes, a service token of the internal admission endpoint, a refused token) or the token names no tenant (a platform
  admin). It is never read from a header or the body, and never a user id.
- **`markets_auto_close_total`** (counter, label `outcome`): what the automatic close of UC-15 did. `closed` counts the
  markets it closed at their close time, `market_failed` the markets whose close failed (they stay open and are tried
  again at the next run), `tenant_failed` the tenants whose markets could not be read in a run. The label has these three
  values only, each starting at 0.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Shutdown

On SIGTERM (Kubernetes) or SIGINT the service shuts down in two steps, so that a rolling deploy does not fail
requests that were already on their way:

1. **Drain.** `GET /health/ready` answers `503` (code `shutting_down`) from this moment. The service keeps serving
   requests and keeps its loops running for `SHUTDOWN_DELAY_MS` (default 5 seconds), the time the load balancer needs to
   take the pod out of rotation.
2. **Close**, in this order: the HTTP server (an opening in flight finishes its funding call) and then the metrics listener, the TenantCreated
   consumer, the opening-retry worker, the automatic-close worker, the outbox relay, the runtime-file watcher, NATS, the database pool. The loops
   stop before NATS and the pool close, because they use both; a row the retry worker had claimed but not finished
   comes back when its lease ends, and the automatic close finishes the market it is closing and no other (the rest of
   that tenant's batch stays open for the next run). It exits with `0`; if closing takes more than 10 seconds after the
   delay, it exits with `1`.

The chart keeps `terminationGracePeriodSeconds: 30`: the delay is limited to 15 seconds, so delay plus close always ends
before Kubernetes sends SIGKILL.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local npm start          # everything in memory, events only logged, a fake funding client
```

In local mode the memory store provisions a tenant the first time it sees it, so any token with a tenant claim works at
once, and `FAKE_FUNDING_MODE` (`funded` by default, `insufficient` or `unknown`) decides how opening ends without
trading. Tokens are always verified: point `AUTH_JWKS_URL`, `AUTH_ISSUER` and `AUTH_AUDIENCE` at the identity provider
(the realm of the `identity` repository) or at a key set of your own.

With a real database and NATS (Docker needed): `docker compose up -d`, then start with `DATABASE_URL` and `NATS_URL` as
shown at the top of [`compose.yaml`](compose.yaml). With a database a tenant is provisioned only by `TenantCreated`, so
run the tenants service against the same NATS and create a tenant there; until then requests answer `503
tenant_not_ready`. To run against a real trading service, set `TRADING_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM` and
`MARKETS_CLIENT_SECRET` as well.

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # unit, web and contract tests; npm test -- --coverage for the coverage report (80 % threshold)
npm run test:integration         # PostgreSQL 18 in a container (Testcontainers); needs Docker
```

The use cases run against in-memory adapters, the web tests send real signed JWTs, and the contract tests fail when a
route is missing from `contracts/openapi.yaml` (or the other way round), when a response does not match its documented
schema, when an event does not match `contracts/asyncapi.yaml`, or when the funding request does not match the outgoing
contract. The integration tests cover the migrations per tenant schema, the store, the outbox, the inbox, the claiming
of `shared.pending_openings` under concurrency and the database constraints.

The chart is checked the way the pipeline checks it: `helm lint helm -f helm/values-dev.yaml` (and the prod values),
and `helm template markets helm -f helm/values-prod.yaml | kubeconform -strict` (also with `--set networkPolicy.enabled=true`).

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | The market, its transitions and rules, the tenant schema naming, event builders; no I/O | nothing outside the domain |
| `src/usecases` | One class per use case, the ports (interfaces) | the domain |
| `src/adapters` | PostgreSQL store and migrator, the outbox relay, NATS publisher and TenantCreated consumer, the opening-retry worker, the automatic-close worker, the trading client and its token provider, the runtime-file watcher, the metrics module and the counter of the automatic close, in-memory versions for local runs and tests | use cases and domain |
| `src/web` | Fastify routes, token checks, problem details | use cases and domain |
| `src/main.ts` | Composition root: configuration, adapters, use cases, server | everything |
| `src/config.ts`, `src/shutdown.ts` | Typed configuration and the shutdown sequence (its steps are passed in, so it is tested with fake timers) | the logger port |
| `migrations/shared`, `migrations/tenant` | Versioned SQL: the shared schema (outbox, inbox, tenant registry, pending openings), and the tables of one tenant, applied to every tenant schema | |
| `contracts` | OpenAPI, AsyncAPI, and the funding endpoint markets expects from trading | |
| `helm` | Chart with dev and prod values, a watched runtime ConfigMap and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one.

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds the
image once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test and an
automatic rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml). The image holds `dist/`, the production dependencies and
the whole `migrations` tree, and runs as a non-root user on a read-only file system.

The chart (`helm`) creates a Deployment, a Service, the environment ConfigMap, the runtime ConfigMap, a `helm test`
smoke test and, when `networkPolicy.enabled` is set, a NetworkPolicy. The Secret `markets-env` (`DATABASE_URL`,
`MARKETS_CLIENT_SECRET`) is created by the pipeline from the organization secret `MARKETS_ENV` and is never part of the
chart. The NetworkPolicy admits only the API gateway to the HTTP port and the namespace `networkPolicy.metrics.namespace`
(default `monitoring`) to the metrics port, and lets the Pods reach only PostgreSQL (5432),
NATS (4222), the identity provider (8080), trading's internal port (`trading.port`) and DNS (53).

## What it needs

- **PostgreSQL 18**: the database `markets` and the login role `markets` on the shared server (DM-01, DM-10); one schema
  per tenant plus the schema `shared`.
- **NATS with JetStream**: the stream `MARKETS` (created by this service) and the stream `TENANTS` of the tenants service.
- **The identity provider**: the signing keys of the tokens and a client-credentials token for the client `markets`.
- **The tenants service**: its `TenantCreated` event creates a tenant's schema here.
- **Trading**: its internal endpoint `POST /v1/internal/market-funding`, called when a market opens.
- **The API gateway**, which routes the prefix `/v1/markets` (the health paths are not routed).

## Follow-ups

Recorded, not built here:

- **Keycloak client `markets`.** A service account (client credentials, an audience that trading accepts) in the
  identity provider's realm, and its secret in the organization secret `MARKETS_ENV` as `MARKETS_CLIENT_SECRET`.
- **Trading's funding endpoint.** `contracts/outgoing/trading-market-funding.openapi.yaml` is what markets expects;
  trading implements it (idempotent on `Idempotency-Key`, storing only a completed funding under the key; `409` with
  the code `insufficient_credits`) on its internal port 8081, which the chart's `trading.port` has to match.
- **Older `TenantCreated` events.** The `TENANTS` stream keeps messages for 30 days by default (the tenants service's `STREAM_MAX_AGE_DAYS`), so a service that starts later never
  sees older events; a tenant created before that needs another way to be provisioned.
- **Plan Q-10.** The bounds of a market's funding amount (`MARKET_FUNDING_MIN`, `MARKET_FUNDING_MAX`) are still open.
- **Chart.** `AUTH_ISSUER` is empty in `helm/values-prod.yaml`; the pipeline fills it in from the organization variable
  `PUBLIC_HOST` (`host-values` in `.github/workflows/ci-cd.yml`), and a deploy without it stops at start (INF-01). The NetworkPolicy is off by default: it needs a network policy engine in the cluster, and the labels in
  `networkPolicy.egress` must match the shared PostgreSQL, NATS, identity and trading Pods.
- **Delivery.** The repository secret `MARKETS_ENV` has to exist before the first deploy, and the Docker image is not
  built locally (the pull-request pipeline builds it).
