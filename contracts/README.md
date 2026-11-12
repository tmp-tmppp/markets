# Contracts of the markets service

The contracts are written first and the code follows them. Tests fail when the two differ.

| File | What it says |
|---|---|
| `openapi.yaml` | OpenAPI 3.1: every HTTP endpoint, the bearer JWT scheme, `application/problem+json` errors and their codes, cursor pagination, the opening answers 200, 202, 409, 502 and 503 |
| `asyncapi.yaml` | AsyncAPI 3.0: the three events the service publishes (MarketOpened, MarketClosed, MarketResolved) and the one it consumes (TenantCreated of the tenants service) |
| `outgoing/trading-market-funding.openapi.yaml` | What markets expects from trading's internal funding endpoint (`POST /v1/internal/market-funding` on trading's internal port 8081, `Idempotency-Key`, 200/201, 409 `insufficient_credits`; only a completed funding is stored under the key, refusals are not), for trading to implement |

## For the authors of consuming services

- **Where.** NATS JetStream, stream `MARKETS` (subjects `chance.markets.>`). One subject per event and
  tenant: `chance.markets.<Event>.<tenantId>`, for example `chance.markets.MarketOpened.<tenantId>`.
  Subscribe with a wildcard (`chance.markets.MarketOpened.*`) or to all of them (`chance.markets.>`).
- **Format.** CloudEvents 1.0 in structured JSON mode: the message body is the whole event
  (`specversion`, `id`, `source`, `type`, `subject`, `time`, `datacontenttype`, `data`) with the
  extension attributes `tenantid`, `correlationid` and `causationid`. The CloudEvents `subject` is
  `market/<marketId>`.
- **Types.** `si.chance.markets.MarketOpened.v1`, `si.chance.markets.MarketClosed.v1`,
  `si.chance.markets.MarketResolved.v1`.
- **Delivery is at least once.** Deduplicate by the event `id` (a UUIDv7, also sent in the NATS header
  `Nats-Msg-Id`): store it in the same transaction as your change and skip a repeat.
- **Version guard (DM-04).** Every event carries the market's `version` (1 at creation, +1 on every change).
  Update your copy of a market only `WHERE version < <the event's version>`; an older or repeated event then
  changes nothing.
- **Order.** The events of one market arrive in the order they happened: they are written to the outbox in
  the transaction of the change and published in that order to one stream. Do not depend on order between
  different markets or tenants.
- **Tenant.** Take the tenant from `tenantid`, never from the payload alone.
- **Ignore unknown fields.** New fields are added as optional ones. A breaking change gets a new type
  (`...MarketOpened.v2`) and is published next to the old one for a while.
- **No personal data (DM-14).** Events carry ids (`creatorId`, `closedBy`, `resolvedBy` are identity provider
  subjects). User names and e-mails are never in them.
- **Who closed a market (UC-15).** `MarketClosed.data.closedBy` is an identity provider subject, or the fixed text
  `system:auto-close` when the service closed the market itself because its `closeTime` had passed (every
  `AUTO_CLOSE_INTERVAL_MS`, so within about that time after the close time). The field is always a string and the
  event is an ordinary transition: `version` is the market's previous version + 1, so the version guard above works
  unchanged. Do not parse `closedBy` as a UUID.
- **Retention.** The stream keeps messages 30 days by default (`STREAM_MAX_AGE_DAYS` of the service, 1 to 365), so a service that starts later still sees the events of that time and never older ones.

## What markets consumes

TenantCreated of the tenants service (stream `TENANTS`), through the durable pull consumer `markets` (filter
`chance.tenants.TenantCreated.*`, explicit ack, deliver all). It is the first consumer in the system, and it sets
the convention for the others:

- One transaction stores the event id in the inbox (`shared.inbox`, one consumer name per kind of event), creates
  the tenant's schema if it is missing (`tenant_` and the 32 hex digits of the tenant id, the same rule as the
  payments service), applies every tenant migration and registers the tenant. The message is acknowledged only
  after the commit.
- A repeat of the same event id commits nothing new and is acknowledged.
- A transient failure (the database does not answer) is negatively acknowledged with a delay, so the event comes
  back.
- A malformed event or an unknown type is logged as a warning and acknowledged: a poison message never blocks
  the consumer.
- The tenant id comes from `tenantid` and must be a UUID; a `data.tenantId` that differs from it makes the event
  malformed.
- Until a tenant's TenantCreated is processed, its requests to markets answer `503` with `Retry-After` (code
  `tenant_not_ready`).
