-- ESL Annual Clock: core schema.
-- Standard PostgreSQL 15+ only. The only Supabase-specific dependency is the
-- `auth.uid()` function used by app.current_user_id(); see docs/azure-migration.md.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.global_role as enum ('user', 'super_admin');
create type public.clock_role as enum ('viewer', 'editor', 'admin');
create type public.activity_type as enum ('deadline', 'period', 'milestone', 'recurring_task');
create type public.activity_status as enum ('planned', 'in_progress', 'done', 'cancelled');
create type public.notification_status as enum ('pending', 'sent', 'failed', 'skipped');
create type public.delivery_mode as enum ('individual', 'digest');

-- ---------------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per person. id = identity-provider subject (Supabase auth user id today,
-- Entra object id later). Deliberately no FK to auth.users for portability.
create table public.profiles (
  id uuid primary key,
  email text not null unique,
  full_name text,
  locale text not null default 'en',
  timezone text not null default 'Europe/Helsinki',
  global_role public.global_role not null default 'user',
  -- General management: read access to every clock (see docs/authorization.md)
  all_clocks_viewer boolean not null default false,
  is_active boolean not null default true,
  weekly_digest boolean not null default false,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clocks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  color text not null default '#16A082' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  description text,
  default_reminder_offsets int[] not null default '{30,14,7,1}',
  escalation_config jsonb not null default
    '{"enabled": true, "offsets_days": [1, 7], "notify_admins": true, "notify_general_management": true}',
  default_send_time time not null default '08:00',
  teams_enabled boolean not null default false,
  is_general_management boolean not null default false,
  position int not null default 0,
  is_demo boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Server-only secrets (Teams webhook URL). RLS enabled with NO policies:
-- only the service role (server) can read or write.
create table public.clock_secrets (
  clock_id uuid primary key references public.clocks(id) on delete cascade,
  teams_webhook_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clock_members (
  id uuid primary key default gen_random_uuid(),
  clock_id uuid not null references public.clocks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.clock_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clock_id, user_id)
);
create index on public.clock_members (user_id);

-- Per-user, per-clock notification preferences (owned by the user, separate from
-- membership so users can edit them without being able to edit their role).
create table public.notification_prefs (
  user_id uuid not null references public.profiles(id) on delete cascade,
  clock_id uuid not null references public.clocks(id) on delete cascade,
  enabled boolean not null default true,
  channels text[] not null default '{email,in_app}',
  -- receive reminders for every activity in the clock, not only own/assigned
  subscribe_all boolean not null default false,
  delivery public.delivery_mode not null default 'individual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, clock_id)
);

create table public.rings (
  id uuid primary key default gen_random_uuid(),
  clock_id uuid not null references public.clocks(id) on delete cascade,
  name text not null,
  color text not null default '#39978F' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position int not null default 0,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, clock_id)
);
create index on public.rings (clock_id);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  clock_id uuid not null references public.clocks(id) on delete cascade,
  ring_id uuid not null,
  title text not null check (length(title) between 1 and 200),
  description text,
  type public.activity_type not null default 'deadline',
  start_date date not null,
  end_date date,
  all_day boolean not null default true,
  start_time time,
  end_time time,
  -- RRULE body without DTSTART, e.g. 'FREQ=YEARLY'. NULL = one-off.
  rrule text,
  owner_id uuid references public.profiles(id) on delete set null,
  status public.activity_status not null default 'planned',
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  predecessor_id uuid,
  -- set when a series is split ("edit all future occurrences")
  series_parent_id uuid references public.activities(id) on delete set null,
  -- NULL = use clock default_reminder_offsets. Days before the occurrence (0 = on the day).
  reminder_offsets int[],
  tags text[] not null default '{}',
  links jsonb not null default '[]',
  is_demo boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, clock_id),
  -- ring must belong to the same clock
  foreign key (ring_id, clock_id) references public.rings(id, clock_id),
  -- predecessor must belong to the same clock
  foreign key (predecessor_id, clock_id) references public.activities(id, clock_id),
  check (end_date is null or end_date >= start_date),
  check (predecessor_id is null or predecessor_id <> id)
);
create index on public.activities (clock_id) where deleted_at is null;
create index on public.activities (owner_id);

create table public.activity_assignees (
  activity_id uuid not null references public.activities(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (activity_id, user_id)
);
create index on public.activity_assignees (user_id);

-- Per-occurrence state for recurring (and one-off) activities.
create table public.activity_occurrences_state (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities(id) on delete cascade,
  occurrence_date date not null,
  status public.activity_status not null default 'planned',
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  snoozed_until date,
  note text,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, occurrence_date)
);

create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  clock_id uuid references public.clocks(id) on delete cascade,
  activity_id uuid references public.activities(id) on delete cascade,
  occurrence_date date,
  -- e.g. 'reminder:-14', 'escalation:+1', 'snooze:2026-03-01', 'digest:2026-W41', 'test:<uuid>'
  reminder_key text not null,
  recipient_id uuid references public.profiles(id) on delete cascade,
  channel text not null,
  status public.notification_status not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz,
  payload jsonb not null default '{}',
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotency: one send per occurrence + reminder + recipient + channel.
  constraint notification_log_idempotency unique nulls not distinct
    (activity_id, occurrence_date, reminder_key, recipient_id, channel)
);
create index on public.notification_log (status, next_attempt_at);
create index on public.notification_log (recipient_id);
create index on public.notification_log (clock_id, created_at desc);

create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  clock_id uuid references public.clocks(id) on delete cascade,
  activity_id uuid references public.activities(id) on delete cascade,
  occurrence_date date,
  kind text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.in_app_notifications (user_id, created_at desc);

create table public.ics_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  clock_id uuid references public.clocks(id) on delete cascade, -- NULL = combined feed
  token_hash text not null unique,
  label text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.ics_tokens (user_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  clock_id uuid, -- no FK: audit history outlives deleted clocks
  actor_id uuid references public.profiles(id) on delete set null,
  entity text not null,
  entity_id uuid,
  action text not null,
  diff jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.audit_log (clock_id, created_at desc);

-- Scheduler bookkeeping (server only).
create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  dry_run boolean not null default false,
  window_start timestamptz,
  window_end timestamptz,
  stats jsonb not null default '{}',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.job_runs (job, started_at desc);

-- Fixed-window rate limiter for public token endpoints (server only).
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

create or replace function public.rate_limit_hit(p_key text, p_window_seconds int, p_max int)
returns boolean language plpgsql as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c int;
begin
  insert into public.rate_limits as r (key, window_start, count) values (p_key, w, 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count into c;
  delete from public.rate_limits where window_start < now() - interval '1 day';
  return c <= p_max;
end $$;

-- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['profiles','clocks','clock_secrets','clock_members','notification_prefs','rings',
    'activities','activity_occurrences_state','notification_log','in_app_notifications','ics_tokens']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
  end loop;
end $$;
