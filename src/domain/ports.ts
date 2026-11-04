// MarketRepository port (interface, async methods): add, get by id, list by status (paginated), save, all inside the caller's tenant schema.

// EventOutbox port (interface): store a domain event in the same transaction as the market change.

// MarketFunding port (interface): ask trading to fund a market from the creator's credits when it opens (idempotent by market id).
