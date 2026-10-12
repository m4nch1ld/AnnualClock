-- Bootstrap for PostgreSQL that is NOT Supabase (Azure Database for PostgreSQL,
-- local Postgres, PGlite in tests). Run ONCE, as the admin/owner user, BEFORE
-- `npm run db:migrate`. Recreates the few Supabase built-ins the migrations use:
--   roles anon / authenticated / service_role, auth.uid(), and default grants.
-- The RLS test suite (tests/db/harness.ts) loads this exact file, so it is verified on every test run.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- The app connects as the admin user and switches to `authenticated` per transaction
-- (lib/db/index.ts → withUser), so it must be a member of that role.
grant authenticated to current_user;
grant anon to current_user;

create schema if not exists auth;
-- Identity hook used by app.current_user_id(). The app sets this setting per transaction.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants table privileges to these roles by default; RLS policies then decide.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
