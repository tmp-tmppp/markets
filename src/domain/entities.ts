// Market entity: id, tenantId, question, description, closeTime, startingPrice, fundingAmount, status, outcome, createdBy, timestamps.

// MarketStatus type: draft, open, closed, resolved.

// Outcome type: YES, NO.

// State machine: allowed transitions draft -> open -> closed -> resolved; any other transition throws a domain error.
