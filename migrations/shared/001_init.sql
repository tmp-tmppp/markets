-- Shared schema of markets (plan sections 6.1 and 9): everything that no single tenant owns. The markets themselves are
-- in migrations/tenant and exist once per tenant schema (DM-01).
-- Ids are UUIDv7 made by the service; timestamps come from the service clock.
-- Constraints are the last guard (DM-10); foreign keys exist only inside this database (DM-02).
--
-- shared.schema_migrations (version, checksum, applied_at) is created by the migration runner itself, before the
-- first file runs, because it records which files ran; every tenant schema has its own copy of it.

CREATE SCHEMA IF NOT EXISTS shared;

-- The tenants this service has a schema for. A row is written in the same transaction that creates and migrates the
-- schema (the TenantCreated inbox), so a registered tenant always has its schema, and the startup migration applies
-- every tenant migration to every registered schema: schemas never drift apart.
CREATE TABLE shared.tenant_registry (
    tenant_id   uuid        PRIMARY KEY,
    schema_name text        NOT NULL CONSTRAINT tenant_registry_schema_format CHECK (schema_name ~ '^tenant_[0-9a-f]{32}$'),
    created_at  timestamptz NOT NULL,
    CONSTRAINT tenant_registry_schema_key UNIQUE (schema_name),
    -- The schema name is derived from the id and from nothing else.
    CONSTRAINT tenant_registry_schema_matches_id CHECK (schema_name = 'tenant_' || replace(tenant_id::text, '-', ''))
);

-- Transactional outbox (REL-01): written in the same transaction as the data change, published by the relay.
CREATE TABLE shared.outbox (
    id           uuid        PRIMARY KEY,
    aggregate_id text        NOT NULL,
    -- NATS subject, for example chance.markets.MarketOpened.<tenantId>.
    subject      text        NOT NULL,
    type         text        NOT NULL,
    -- The whole CloudEvent.
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL,
    published_at timestamptz,
    attempts     integer     NOT NULL DEFAULT 0,
    last_error   text
);

CREATE INDEX outbox_unpublished_idx ON shared.outbox (created_at) WHERE published_at IS NULL;

-- Inbox of consumed events (ADR-053, DM-06): the id of a processed event is stored in the same transaction as its
-- change, so a redelivered event changes nothing. One consumer per kind of event, because the same id never repeats
-- across kinds. The entries are purged after the retention of the stream plus a margin (INBOX_RETENTION_MS).
CREATE TABLE shared.inbox (
    consumer     text        NOT NULL CONSTRAINT inbox_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    event_id     text        NOT NULL CONSTRAINT inbox_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_idx ON shared.inbox (processed_at);

-- Markets in "opening" whose funding outcome is not settled yet (DM-19 saga). The row is written in the transaction that
-- moves the market from draft to opening and deleted in the transaction that settles it (open, or back to draft). The
-- retry worker claims due rows with FOR UPDATE SKIP LOCKED and leases them; the request that began the opening holds the
-- first lease itself. market_id has no foreign key: the market is in the tenant's own schema.
CREATE TABLE shared.pending_openings (
    tenant_id       uuid        NOT NULL REFERENCES shared.tenant_registry (tenant_id),
    market_id       uuid        NOT NULL,
    -- Of the request that began the opening: the MarketOpened event of a later retry carries them too.
    correlation_id  text        NOT NULL CONSTRAINT pending_openings_correlation_id_length CHECK (char_length(correlation_id) BETWEEN 1 AND 255),
    causation_id    text        NOT NULL CONSTRAINT pending_openings_causation_id_length CHECK (char_length(causation_id) BETWEEN 1 AND 255),
    -- Funding calls whose outcome stayed unknown.
    attempts        integer     NOT NULL DEFAULT 0 CONSTRAINT pending_openings_attempts_positive CHECK (attempts >= 0),
    -- Due when this time has passed; a claim does not move it, a reschedule does.
    next_attempt_at timestamptz NOT NULL,
    -- An instance works on the row until this time; null when nobody does.
    lease_until     timestamptz,
    last_error      text,
    created_at      timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, market_id)
);

CREATE INDEX pending_openings_due_idx ON shared.pending_openings (next_attempt_at);
