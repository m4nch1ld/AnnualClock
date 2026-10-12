-- "Add to my Outlook": which user has put which activity (or one occurrence of it)
-- into their personal calendar, so the app can send updates and cancellations.
-- Written only by trusted server code; users can read their own rows.

create table public.calendar_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  -- 'series' = the whole activity (all occurrences); 'occurrence' = one occurrence of a recurring activity
  scope text not null check (scope in ('series', 'occurrence')),
  occurrence_date date,
  -- 'ics_invite' = iCalendar invitation by email (prototype); 'graph' = Microsoft Graph event (Azure/Entra)
  provider text not null default 'ics_invite' check (provider in ('ics_invite', 'graph')),
  -- iCalendar UID, stable for the life of the link (Outlook matches updates/cancellations on it)
  uid text not null unique,
  -- provider-side id (Graph event id)
  external_id text,
  -- iCalendar SEQUENCE: incremented on every update/cancel
  sequence int not null default 0,
  -- hash of the last event content sent, so unrelated changes do not trigger updates
  content_hash text,
  status text not null default 'active' check (status in ('active', 'removed')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'occurrence') = (occurrence_date is not null))
);

-- one active link per user + activity + occurrence (series links have occurrence_date null)
create unique index calendar_links_one_active
  on public.calendar_links (user_id, activity_id, coalesce(occurrence_date, '0001-01-01'::date))
  where status = 'active';
create index on public.calendar_links (activity_id) where status = 'active';
create index on public.calendar_links (status, last_error) where status = 'active' and last_error is not null;

create trigger set_updated_at before update on public.calendar_links
  for each row execute function app.set_updated_at();

alter table public.calendar_links enable row level security;
create policy calendar_links_select_own on public.calendar_links for select to authenticated
  using (user_id = app.current_user_id());
revoke insert, update, delete on public.calendar_links from authenticated;
revoke all on public.calendar_links from anon;
