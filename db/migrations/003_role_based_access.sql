-- =============================================================================
-- Role-based access control.
-- =============================================================================
-- Replaces the "one shared workspace, signed in means full access" model that
-- 001_init.sql inherited from the Supabase port. Four roles now live in
-- `users.role`:
--
--   owner   the first account ever created; full access, assigns any role
--   admin   sees and manages every member's data; assigns member/none only
--   member  creates and manages only the data sources they created
--   none    signed in but not activated yet — sees nothing (the new default)
--
-- Ownership is anchored on `data_sources.created_by`: sessions, messages,
-- workflows, templates, planning jobs, previews and tasks all hang off a data
-- source, so scoping that one column scopes everything below it. A data source
-- whose creator was deleted (`created_by` is null, per the on-delete-set-null
-- reference) stays visible to owner/admin only.
-- =============================================================================

-- New accounts start with no access and wait for an owner/admin to activate.
alter table users alter column role set default 'none';

-- Existing accounts: keep the owner, park everyone else in 'none' so access is
-- granted deliberately rather than inherited from the shared-workspace era.
update users set role = 'none' where role <> 'owner';

-- A database seeded before the owner logic existed can have no owner at all;
-- the earliest account takes it, matching what registerUser() would have done.
update users set role = 'owner'
where id = (select id from users order by created_at, id limit 1)
  and not exists (select 1 from users where role = 'owner');

alter table users
  add constraint users_role_check check (role in ('owner', 'admin', 'member', 'none'));

-- At most one owner: two 'owner' rows would collide on this partial index.
create unique index users_single_owner on users (role) where role = 'owner';

-- Every list page now filters by creator, so this is on the hot path.
create index idx_data_sources_created_by on data_sources (created_by, created_at desc);
