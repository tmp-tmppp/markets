-- Share links of markets (sharing a market by link). The links of all tenants are in one shared table: the public lookup
-- knows a token and nothing else, so it cannot say which tenant's schema to open. market_id has no foreign key because
-- the market is in the tenant's own schema (as in pending_openings).
--
-- The token is a secret of 32 random bytes; only its SHA-256 is stored (64 lower-case hex digits), so a copy of this table
-- holds no link that works. token_hash is unique: a lookup is one indexed equality on it.
-- Ids are UUIDv7 made by the service; timestamps come from the service clock.

CREATE TABLE shared.share_links (
    id         uuid        PRIMARY KEY,
    token_hash text        NOT NULL CONSTRAINT share_links_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    tenant_id  uuid        NOT NULL REFERENCES shared.tenant_registry (tenant_id),
    market_id  uuid        NOT NULL,
    -- members: members of the organization; profiles: the listed e-mail addresses; everyone: anybody with the link.
    type       text        NOT NULL CONSTRAINT share_links_type_values CHECK (type IN ('members', 'profiles', 'everyone')),
    -- Lower case; only a link of type profiles has addresses (1 to 50), the other types have none.
    emails     text[]      NOT NULL DEFAULT '{}',
    created_by text        NOT NULL CONSTRAINT share_links_created_by_length CHECK (char_length(created_by) BETWEEN 1 AND 255),
    created_at timestamptz NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT share_links_token_hash_key UNIQUE (token_hash),
    CONSTRAINT share_links_emails_match_type CHECK (
        (type = 'profiles' AND cardinality(emails) BETWEEN 1 AND 50) OR (type <> 'profiles' AND cardinality(emails) = 0)
    ),
    CONSTRAINT share_links_emails_lower_case CHECK (emails = lower(emails::text)::text[])
);

-- The list of a market's links, newest first (UUIDv7 ids grow with the creation time).
CREATE INDEX share_links_market_idx ON shared.share_links (tenant_id, market_id, id DESC);
