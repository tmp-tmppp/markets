-- UC-15, the automatic close: every few seconds each instance asks every registered tenant schema whether an open market
-- has reached its close time. This partial index holds the open markets only, ordered by close time, so that question is
-- one index probe per tenant however many closed and resolved markets the tenant has, and the claim of the due markets
-- (FOR UPDATE SKIP LOCKED, earliest close time first) reads the front of the index.
CREATE INDEX markets_open_close_time_idx ON markets (close_time, id) WHERE status = 'open';
