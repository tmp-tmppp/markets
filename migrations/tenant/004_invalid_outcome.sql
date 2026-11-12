-- UC-16: a closed market can be resolved as INVALID (the question cannot be answered). The status stays "resolved" and
-- the outcome gains a third value; trading refunds the stakes on MarketResolved. Only the list of allowed values changes,
-- so the constraint keeps its name and the rows already stored (YES or NO) pass the new check.
ALTER TABLE markets DROP CONSTRAINT markets_outcome_values;
ALTER TABLE markets ADD CONSTRAINT markets_outcome_values CHECK (outcome IN ('YES', 'NO', 'INVALID'));
