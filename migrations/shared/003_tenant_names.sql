-- The organization's display name, kept from its TenantCreated event, for the public lookup of a share link (which shows
-- the name of the organization that shares a market). Null for a tenant registered before this column existed, and for
-- an event without a name; the lookup then shows no name.

ALTER TABLE shared.tenant_registry ADD COLUMN name text CONSTRAINT tenant_registry_name_length CHECK (char_length(name) BETWEEN 1 AND 200);
