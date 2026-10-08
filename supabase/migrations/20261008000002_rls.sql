-- ESL Annual Clock: authorization (Row Level Security).
-- The rules are documented in docs/authorization.md. Every table has RLS enabled.
-- Roles: `authenticated` = signed-in user (JWT), `anon` = no access at all,
-- `service_role` = trusted server code (bypasses RLS; used by the scheduler and token endpoints).

-- ---------------------------------------------------------------------------
-- Identity hook. Supabase: auth.uid(). On Azure, redefine this one function to
-- read the user id from a session setting, e.g. current_setting('app.user_id').
-- ---------------------------------------------------------------------------
create or replace function app.current_user_id() returns uuid
language sql stable as $$ select auth.uid() $$;

-- ---------------------------------------------------------------------------
-- Helper predicates (SECURITY DEFINER so they can read membership without
-- recursing into RLS on the membership table itself).
-- ---------------------------------------------------------------------------
create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = app.current_user_id() and p.is_active)
$$;

create or replace function app.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = app.current_user_id() and p.is_active and p.global_role = 'super_admin')
$$;

create or replace function app.is_all_clocks_viewer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = app.current_user_id() and p.is_active and p.all_clocks_viewer)
$$;

create or replace function app.clock_role(p_clock_id uuid) returns public.clock_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.clock_members m
  join public.profiles p on p.id = m.user_id and p.is_active
  where m.clock_id = p_clock_id and m.user_id = app.current_user_id()
$$;

create or replace function app.can_read_clock(p_clock_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or app.is_all_clocks_viewer() or app.clock_role(p_clock_id) is not null
$$;

create or replace function app.can_edit_clock(p_clock_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or coalesce(app.clock_role(p_clock_id) in ('editor', 'admin'), false)
$$;

create or replace function app.is_clock_admin(p_clock_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super_admin() or coalesce(app.clock_role(p_clock_id) = 'admin', false)
$$;

create or replace function app.activity_clock(p_activity_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.clock_id from public.activities a where a.id = p_activity_id
$$;

grant usage on schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;

-- No anonymous access to anything; authenticated access is governed by policies.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.clocks enable row level security;
alter table public.clock_secrets enable row level security;
alter table public.clock_members enable row level security;
alter table public.notification_prefs enable row level security;
alter table public.rings enable row level security;
alter table public.activities enable row level security;
alter table public.activity_assignees enable row level security;
alter table public.activity_occurrences_state enable row level security;
alter table public.notification_log enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.ics_tokens enable row level security;
alter table public.audit_log enable row level security;
alter table public.job_runs enable row level security;
alter table public.rate_limits enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: internal directory readable by active users; users edit only
-- their own non-privileged columns. Privileged columns (global_role,
-- all_clocks_viewer, is_active) are changed by super-admin server code.
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (app.is_active_user());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = app.current_user_id()) with check (id = app.current_user_id());
revoke update on public.profiles from authenticated;
grant update (full_name, locale, timezone, weekly_digest) on public.profiles to authenticated;
revoke insert, delete on public.profiles from authenticated;

-- ---------------------------------------------------------------------------
-- clocks
-- ---------------------------------------------------------------------------
create policy clocks_select on public.clocks for select to authenticated
  using (app.can_read_clock(id));
create policy clocks_insert on public.clocks for insert to authenticated
  with check (app.is_super_admin());
create policy clocks_update on public.clocks for update to authenticated
  using (app.is_clock_admin(id)) with check (app.is_clock_admin(id));
create policy clocks_delete on public.clocks for delete to authenticated
  using (app.is_super_admin());
-- clock admins may not flip the general-management marker
revoke update on public.clocks from authenticated;
grant update (name, color, description, default_reminder_offsets, escalation_config,
  default_send_time, teams_enabled, position, archived_at) on public.clocks to authenticated;

-- clock_secrets: no policies => no access for authenticated users.

-- ---------------------------------------------------------------------------
-- clock_members: readable by anyone who can read the clock; only clock admins
-- (and super admins) manage membership.
-- ---------------------------------------------------------------------------
create policy members_select on public.clock_members for select to authenticated
  using (app.can_read_clock(clock_id));
create policy members_insert on public.clock_members for insert to authenticated
  with check (app.is_clock_admin(clock_id));
create policy members_update on public.clock_members for update to authenticated
  using (app.is_clock_admin(clock_id)) with check (app.is_clock_admin(clock_id));
create policy members_delete on public.clock_members for delete to authenticated
  using (app.is_clock_admin(clock_id));

-- ---------------------------------------------------------------------------
-- notification_prefs: own rows (for clocks the user can read); admins can see
-- their clock's prefs.
-- ---------------------------------------------------------------------------
create policy prefs_select on public.notification_prefs for select to authenticated
  using (user_id = app.current_user_id() or app.is_clock_admin(clock_id));
create policy prefs_insert on public.notification_prefs for insert to authenticated
  with check (user_id = app.current_user_id() and app.can_read_clock(clock_id));
create policy prefs_update on public.notification_prefs for update to authenticated
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id() and app.can_read_clock(clock_id));
create policy prefs_delete on public.notification_prefs for delete to authenticated
  using (user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- rings: read with clock; managed by clock admins.
-- ---------------------------------------------------------------------------
create policy rings_select on public.rings for select to authenticated
  using (app.can_read_clock(clock_id));
create policy rings_insert on public.rings for insert to authenticated
  with check (app.is_clock_admin(clock_id));
create policy rings_update on public.rings for update to authenticated
  using (app.is_clock_admin(clock_id)) with check (app.is_clock_admin(clock_id));
create policy rings_delete on public.rings for delete to authenticated
  using (app.is_clock_admin(clock_id));

-- ---------------------------------------------------------------------------
-- activities: read with clock (soft-deleted rows only for admins); write by
-- editors/admins. Hard delete only by super admin (app uses soft delete).
-- ---------------------------------------------------------------------------
create policy activities_select on public.activities for select to authenticated
  using (app.can_read_clock(clock_id) and (deleted_at is null or app.is_clock_admin(clock_id)));
create policy activities_insert on public.activities for insert to authenticated
  with check (app.can_edit_clock(clock_id));
create policy activities_update on public.activities for update to authenticated
  using (app.can_edit_clock(clock_id)) with check (app.can_edit_clock(clock_id));
create policy activities_delete on public.activities for delete to authenticated
  using (app.is_super_admin());

create policy assignees_select on public.activity_assignees for select to authenticated
  using (app.can_read_clock(app.activity_clock(activity_id)));
create policy assignees_insert on public.activity_assignees for insert to authenticated
  with check (app.can_edit_clock(app.activity_clock(activity_id)));
create policy assignees_delete on public.activity_assignees for delete to authenticated
  using (app.can_edit_clock(app.activity_clock(activity_id)));

create policy occ_select on public.activity_occurrences_state for select to authenticated
  using (app.can_read_clock(app.activity_clock(activity_id)));
create policy occ_insert on public.activity_occurrences_state for insert to authenticated
  with check (app.can_edit_clock(app.activity_clock(activity_id)));
create policy occ_update on public.activity_occurrences_state for update to authenticated
  using (app.can_edit_clock(app.activity_clock(activity_id)))
  with check (app.can_edit_clock(app.activity_clock(activity_id)));
create policy occ_delete on public.activity_occurrences_state for delete to authenticated
  using (app.can_edit_clock(app.activity_clock(activity_id)));

-- ---------------------------------------------------------------------------
-- notification_log: recipients see their own entries; clock admins see the
-- clock's log. Written only by the server.
-- ---------------------------------------------------------------------------
create policy nlog_select on public.notification_log for select to authenticated
  using (recipient_id = app.current_user_id() or (clock_id is not null and app.is_clock_admin(clock_id)));

-- in_app_notifications: own rows; users may only mark read.
create policy inapp_select on public.in_app_notifications for select to authenticated
  using (user_id = app.current_user_id());
create policy inapp_update on public.in_app_notifications for update to authenticated
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
revoke insert, update, delete on public.in_app_notifications from authenticated;
grant update (read_at) on public.in_app_notifications to authenticated;

-- ics_tokens: own rows. Users can create (for readable clocks) and revoke.
create policy ics_select on public.ics_tokens for select to authenticated
  using (user_id = app.current_user_id());
create policy ics_insert on public.ics_tokens for insert to authenticated
  with check (user_id = app.current_user_id() and (clock_id is null or app.can_read_clock(clock_id)));
create policy ics_update on public.ics_tokens for update to authenticated
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
revoke update, delete on public.ics_tokens from authenticated;
grant update (revoked_at, label) on public.ics_tokens to authenticated;

-- audit_log: editors/admins of the clock (and super admin / GM) can read.
-- Written only by triggers (SECURITY DEFINER) and server code.
create policy audit_select on public.audit_log for select to authenticated
  using (app.can_edit_clock(clock_id) or app.is_all_clocks_viewer());
revoke insert, update, delete on public.audit_log from authenticated;

-- job_runs: super admins can read.
create policy jobs_select on public.job_runs for select to authenticated
  using (app.is_super_admin());
revoke insert, update, delete on public.job_runs from authenticated;

-- rate_limits: no policies (server only).
