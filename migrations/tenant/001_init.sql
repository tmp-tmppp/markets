-- Tables of one tenant (plan sections 6.1 and 9). This file is applied once to every tenant schema, with the schema as
-- the only entry of the search path: the names below are therefore not qualified. A tenant schema holds nothing that
-- belongs to another tenant, so a forgotten tenant filter cannot reach another tenant's rows (DM-01).
-- Funding is credits, one positive integer (payments' amount unit, 1 credit); the YES price has two decimals.
-- Lengths are counted in code points (char_length), as the domain counts them. Constraints are the last guard (DM-10).

CREATE TABLE markets (
    id             uuid          PRIMARY KEY,
    tenant_id      uuid          NOT NULL,
    question       text          NOT NULL CONSTRAINT markets_question_length CHECK (char_length(question) BETWEEN 10 AND 200),
    description    text          NOT NULL DEFAULT '' CONSTRAINT markets_description_length CHECK (char_length(description) <= 2000),
    close_time     timestamptz   NOT NULL,
    -- Price of YES when the market opens; NO starts at 1 - starting_price.
    starting_price numeric(3, 2) NOT NULL CONSTRAINT markets_starting_price_range CHECK (starting_price BETWEEN 0.01 AND 0.99),
    funding_amount integer       NOT NULL CONSTRAINT markets_funding_amount_positive CHECK (funding_amount > 0),
    status         text          NOT NULL DEFAULT 'draft' CONSTRAINT markets_status_values CHECK (status IN ('draft', 'opening', 'open', 'closed', 'resolved')),
    outcome        text          CONSTRAINT markets_outcome_values CHECK (outcome IN ('YES', 'NO')),
    -- 1 at creation, +1 on every transition (DM-04): a consumer applies an event only when its version is newer.
    version        integer       NOT NULL DEFAULT 1 CONSTRAINT markets_version_positive CHECK (version >= 1),
    created_by     text          NOT NULL CONSTRAINT markets_created_by_length CHECK (char_length(created_by) BETWEEN 1 AND 255),
    created_at     timestamptz   NOT NULL,
    updated_at     timestamptz   NOT NULL,
    opened_at      timestamptz,
    closed_at      timestamptz,
    closed_by      text,
    resolved_at    timestamptz,
    resolved_by    text,
    -- The outcome exists exactly when the market is resolved.
    CONSTRAINT markets_outcome_iff_resolved CHECK ((outcome IS NOT NULL) = (status = 'resolved'))
);

-- The list by status, newest first (UUIDv7 ids grow with the creation time).
CREATE INDEX markets_status_id_idx ON markets (status, id DESC);
