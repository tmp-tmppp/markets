-- The sharing policy of a market (sharing a market by link): who may make share links and of which types. It is chosen when
-- the market is created and has no update path, so it never changes. Markets that exist already get the default policy
-- of a market created without `sharing`: members share with members.

ALTER TABLE markets
    ADD COLUMN sharing_who        text   NOT NULL DEFAULT 'members' CONSTRAINT markets_sharing_who_values CHECK (sharing_who IN ('none', 'admins', 'members')),
    ADD COLUMN sharing_link_types text[] NOT NULL DEFAULT ARRAY['members']::text[]
        CONSTRAINT markets_sharing_link_types_values CHECK (sharing_link_types <@ ARRAY['members', 'profiles', 'everyone']::text[]);
