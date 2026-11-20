-- ESL Annual Clock — schema (Azure SQL Database / SQL Server 2022+).
-- Every object lives in the app's own schema $(SCHEMA) (replaced by the migration runner),
-- so the app can share one database with other applications.
--
-- Conventions
--  * ids: uniqueidentifier; all-day dates: date; instants: datetimeoffset(3)
--  * lists / objects (tags, reminder offsets, links, configs, payloads): JSON in nvarchar(max) with ISJSON checks
--  * enums: nvarchar + CHECK
--  * foreign keys: NO ACTION (SQL Server rejects multiple cascade paths; the app soft-deletes)
--  * activity child tables carry clock_id (composite FK to activities) so row-level security
--    predicates never have to read another table

-- The schema itself is created by the migration runner (scripts/migrate.ts).

CREATE TABLE [$(SCHEMA)].profiles (
  id uniqueidentifier NOT NULL CONSTRAINT pk_profiles PRIMARY KEY,
  email nvarchar(320) NOT NULL CONSTRAINT uq_profiles_email UNIQUE,
  full_name nvarchar(200) NULL,
  locale nvarchar(10) NOT NULL CONSTRAINT df_profiles_locale DEFAULT N'en',
  timezone nvarchar(64) NOT NULL CONSTRAINT df_profiles_tz DEFAULT N'Europe/Helsinki',
  global_role nvarchar(20) NOT NULL CONSTRAINT df_profiles_role DEFAULT N'user'
    CONSTRAINT ck_profiles_role CHECK (global_role IN (N'user', N'super_admin')),
  -- General management: read access to every clock (docs/authorization.md)
  all_clocks_viewer bit NOT NULL CONSTRAINT df_profiles_gm DEFAULT 0,
  is_active bit NOT NULL CONSTRAINT df_profiles_active DEFAULT 1,
  weekly_digest bit NOT NULL CONSTRAINT df_profiles_digest DEFAULT 0,
  is_demo bit NOT NULL CONSTRAINT df_profiles_demo DEFAULT 0,
  -- identity-provider subject (Entra object id); internal id stays the key
  external_id nvarchar(100) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_profiles_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_profiles_u DEFAULT sysdatetimeoffset()
);
CREATE UNIQUE INDEX ux_profiles_external_id ON [$(SCHEMA)].profiles (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE [$(SCHEMA)].clocks (
  id uniqueidentifier NOT NULL CONSTRAINT pk_clocks PRIMARY KEY CONSTRAINT df_clocks_id DEFAULT newid(),
  name nvarchar(80) NOT NULL,
  slug nvarchar(60) NOT NULL CONSTRAINT uq_clocks_slug UNIQUE
    CONSTRAINT ck_clocks_slug CHECK (slug COLLATE Latin1_General_BIN2 NOT LIKE N'%[^a-z0-9-]%' AND len(slug) > 0),
  color nchar(7) NOT NULL CONSTRAINT df_clocks_color DEFAULT N'#16A082'
    CONSTRAINT ck_clocks_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  description nvarchar(500) NULL,
  default_reminder_offsets nvarchar(400) NOT NULL CONSTRAINT df_clocks_rem DEFAULT N'[30,14,7,1]'
    CONSTRAINT ck_clocks_rem CHECK (isjson(default_reminder_offsets) = 1),
  escalation_config nvarchar(1000) NOT NULL
    CONSTRAINT df_clocks_esc DEFAULT N'{"enabled":true,"offsets_days":[1,7],"notify_admins":true,"notify_general_management":true}'
    CONSTRAINT ck_clocks_esc CHECK (isjson(escalation_config) = 1),
  default_send_time time(0) NOT NULL CONSTRAINT df_clocks_send DEFAULT '08:00',
  teams_enabled bit NOT NULL CONSTRAINT df_clocks_teams DEFAULT 0,
  is_general_management bit NOT NULL CONSTRAINT df_clocks_gm DEFAULT 0,
  position int NOT NULL CONSTRAINT df_clocks_pos DEFAULT 0,
  is_demo bit NOT NULL CONSTRAINT df_clocks_demo DEFAULT 0,
  archived_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_clocks_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_clocks_u DEFAULT sysdatetimeoffset()
);

-- Server-only secrets (Teams webhook URL): readable only in service context (RLS).
CREATE TABLE [$(SCHEMA)].clock_secrets (
  clock_id uniqueidentifier NOT NULL CONSTRAINT pk_clock_secrets PRIMARY KEY
    CONSTRAINT fk_secrets_clock REFERENCES [$(SCHEMA)].clocks (id),
  teams_webhook_url nvarchar(2000) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_secrets_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_secrets_u DEFAULT sysdatetimeoffset()
);

CREATE TABLE [$(SCHEMA)].clock_members (
  id uniqueidentifier NOT NULL CONSTRAINT pk_clock_members PRIMARY KEY CONSTRAINT df_members_id DEFAULT newid(),
  clock_id uniqueidentifier NOT NULL CONSTRAINT fk_members_clock REFERENCES [$(SCHEMA)].clocks (id),
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_members_user REFERENCES [$(SCHEMA)].profiles (id),
  role nvarchar(10) NOT NULL CONSTRAINT df_members_role DEFAULT N'viewer'
    CONSTRAINT ck_members_role CHECK (role IN (N'viewer', N'editor', N'admin')),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_members_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_members_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_members UNIQUE (clock_id, user_id)
);
CREATE INDEX ix_members_user ON [$(SCHEMA)].clock_members (user_id);

CREATE TABLE [$(SCHEMA)].notification_prefs (
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_prefs_user REFERENCES [$(SCHEMA)].profiles (id),
  clock_id uniqueidentifier NOT NULL CONSTRAINT fk_prefs_clock REFERENCES [$(SCHEMA)].clocks (id),
  enabled bit NOT NULL CONSTRAINT df_prefs_enabled DEFAULT 1,
  channels nvarchar(200) NOT NULL CONSTRAINT df_prefs_channels DEFAULT N'["email","in_app"]'
    CONSTRAINT ck_prefs_channels CHECK (isjson(channels) = 1),
  subscribe_all bit NOT NULL CONSTRAINT df_prefs_sub DEFAULT 0,
  delivery nvarchar(12) NOT NULL CONSTRAINT df_prefs_delivery DEFAULT N'individual'
    CONSTRAINT ck_prefs_delivery CHECK (delivery IN (N'individual', N'digest')),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_prefs_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_prefs_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT pk_prefs PRIMARY KEY (user_id, clock_id)
);

CREATE TABLE [$(SCHEMA)].rings (
  id uniqueidentifier NOT NULL CONSTRAINT pk_rings PRIMARY KEY CONSTRAINT df_rings_id DEFAULT newid(),
  clock_id uniqueidentifier NOT NULL CONSTRAINT fk_rings_clock REFERENCES [$(SCHEMA)].clocks (id),
  name nvarchar(60) NOT NULL,
  color nchar(7) NOT NULL CONSTRAINT df_rings_color DEFAULT N'#39978F'
    CONSTRAINT ck_rings_color CHECK (color LIKE N'#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  position int NOT NULL CONSTRAINT df_rings_pos DEFAULT 0,
  hidden bit NOT NULL CONSTRAINT df_rings_hidden DEFAULT 0,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_rings_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_rings_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_rings_id_clock UNIQUE (id, clock_id)
);
CREATE INDEX ix_rings_clock ON [$(SCHEMA)].rings (clock_id);

CREATE TABLE [$(SCHEMA)].activities (
  id uniqueidentifier NOT NULL CONSTRAINT pk_activities PRIMARY KEY CONSTRAINT df_act_id DEFAULT newid(),
  clock_id uniqueidentifier NOT NULL CONSTRAINT fk_act_clock REFERENCES [$(SCHEMA)].clocks (id),
  ring_id uniqueidentifier NOT NULL,
  title nvarchar(200) NOT NULL CONSTRAINT ck_act_title CHECK (len(title) >= 1),
  description nvarchar(max) NULL,
  type nvarchar(20) NOT NULL CONSTRAINT df_act_type DEFAULT N'deadline'
    CONSTRAINT ck_act_type CHECK (type IN (N'deadline', N'period', N'milestone', N'recurring_task')),
  start_date date NOT NULL,
  end_date date NULL,
  all_day bit NOT NULL CONSTRAINT df_act_allday DEFAULT 1,
  start_time time(0) NULL,
  end_time time(0) NULL,
  -- RRULE body without DTSTART, e.g. 'FREQ=YEARLY'. NULL = one-off.
  rrule nvarchar(500) NULL,
  owner_id uniqueidentifier NULL CONSTRAINT fk_act_owner REFERENCES [$(SCHEMA)].profiles (id),
  status nvarchar(20) NOT NULL CONSTRAINT df_act_status DEFAULT N'planned'
    CONSTRAINT ck_act_status CHECK (status IN (N'planned', N'in_progress', N'done', N'cancelled')),
  completed_at datetimeoffset(3) NULL,
  completed_by uniqueidentifier NULL CONSTRAINT fk_act_completed_by REFERENCES [$(SCHEMA)].profiles (id),
  predecessor_id uniqueidentifier NULL,
  series_parent_id uniqueidentifier NULL,
  -- NULL = clock default. JSON array of days before (0 = on the day).
  reminder_offsets nvarchar(400) NULL CONSTRAINT ck_act_rem CHECK (reminder_offsets IS NULL OR isjson(reminder_offsets) = 1),
  tags nvarchar(2000) NOT NULL CONSTRAINT df_act_tags DEFAULT N'[]' CONSTRAINT ck_act_tags CHECK (isjson(tags) = 1),
  links nvarchar(max) NOT NULL CONSTRAINT df_act_links DEFAULT N'[]' CONSTRAINT ck_act_links CHECK (isjson(links) = 1),
  is_demo bit NOT NULL CONSTRAINT df_act_demo DEFAULT 0,
  created_by uniqueidentifier NULL CONSTRAINT fk_act_created_by REFERENCES [$(SCHEMA)].profiles (id),
  updated_by uniqueidentifier NULL CONSTRAINT fk_act_updated_by REFERENCES [$(SCHEMA)].profiles (id),
  deleted_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_act_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_act_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_act_id_clock UNIQUE (id, clock_id),
  -- ring must belong to the same clock
  CONSTRAINT fk_act_ring FOREIGN KEY (ring_id, clock_id) REFERENCES [$(SCHEMA)].rings (id, clock_id),
  CONSTRAINT ck_act_dates CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT ck_act_pred_self CHECK (predecessor_id IS NULL OR predecessor_id <> id)
);
-- predecessor must belong to the same clock
ALTER TABLE [$(SCHEMA)].activities ADD CONSTRAINT fk_act_pred
  FOREIGN KEY (predecessor_id, clock_id) REFERENCES [$(SCHEMA)].activities (id, clock_id);
ALTER TABLE [$(SCHEMA)].activities ADD CONSTRAINT fk_act_series_parent
  FOREIGN KEY (series_parent_id) REFERENCES [$(SCHEMA)].activities (id);
CREATE INDEX ix_act_clock ON [$(SCHEMA)].activities (clock_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_act_owner ON [$(SCHEMA)].activities (owner_id);

CREATE TABLE [$(SCHEMA)].activity_assignees (
  activity_id uniqueidentifier NOT NULL,
  clock_id uniqueidentifier NOT NULL,
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_assignees_user REFERENCES [$(SCHEMA)].profiles (id),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_assignees_c DEFAULT sysdatetimeoffset(),
  CONSTRAINT pk_assignees PRIMARY KEY (activity_id, user_id),
  CONSTRAINT fk_assignees_activity FOREIGN KEY (activity_id, clock_id) REFERENCES [$(SCHEMA)].activities (id, clock_id)
);
CREATE INDEX ix_assignees_user ON [$(SCHEMA)].activity_assignees (user_id);

-- Per-occurrence state for recurring (and one-off) activities.
CREATE TABLE [$(SCHEMA)].activity_occurrences_state (
  id uniqueidentifier NOT NULL CONSTRAINT pk_occ PRIMARY KEY CONSTRAINT df_occ_id DEFAULT newid(),
  activity_id uniqueidentifier NOT NULL,
  clock_id uniqueidentifier NOT NULL,
  occurrence_date date NOT NULL,
  status nvarchar(20) NOT NULL CONSTRAINT df_occ_status DEFAULT N'planned'
    CONSTRAINT ck_occ_status CHECK (status IN (N'planned', N'in_progress', N'done', N'cancelled')),
  completed_at datetimeoffset(3) NULL,
  completed_by uniqueidentifier NULL CONSTRAINT fk_occ_completed_by REFERENCES [$(SCHEMA)].profiles (id),
  snoozed_until date NULL,
  note nvarchar(2000) NULL,
  updated_by uniqueidentifier NULL CONSTRAINT fk_occ_updated_by REFERENCES [$(SCHEMA)].profiles (id),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_occ_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_occ_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT uq_occ UNIQUE (activity_id, occurrence_date),
  CONSTRAINT fk_occ_activity FOREIGN KEY (activity_id, clock_id) REFERENCES [$(SCHEMA)].activities (id, clock_id)
);

CREATE TABLE [$(SCHEMA)].notification_log (
  id uniqueidentifier NOT NULL CONSTRAINT pk_nlog PRIMARY KEY CONSTRAINT df_nlog_id DEFAULT newid(),
  clock_id uniqueidentifier NULL CONSTRAINT fk_nlog_clock REFERENCES [$(SCHEMA)].clocks (id),
  activity_id uniqueidentifier NULL CONSTRAINT fk_nlog_activity REFERENCES [$(SCHEMA)].activities (id),
  occurrence_date date NULL,
  -- e.g. 'reminder:-14', 'escalation:+1', 'snooze:2026-03-01', 'digest:2026-W41', 'test:<uuid>'
  reminder_key nvarchar(100) NOT NULL,
  recipient_id uniqueidentifier NULL CONSTRAINT fk_nlog_recipient REFERENCES [$(SCHEMA)].profiles (id),
  channel nvarchar(20) NOT NULL,
  status nvarchar(10) NOT NULL CONSTRAINT df_nlog_status DEFAULT N'pending'
    CONSTRAINT ck_nlog_status CHECK (status IN (N'pending', N'sent', N'failed', N'skipped')),
  attempts int NOT NULL CONSTRAINT df_nlog_attempts DEFAULT 0,
  next_attempt_at datetimeoffset(3) NULL,
  payload nvarchar(max) NOT NULL CONSTRAINT df_nlog_payload DEFAULT N'{}' CONSTRAINT ck_nlog_payload CHECK (isjson(payload) = 1),
  error nvarchar(2000) NULL,
  sent_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_nlog_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_nlog_u DEFAULT sysdatetimeoffset()
);
-- Idempotency: one send per occurrence + reminder + recipient + channel.
-- SQL Server unique indexes treat NULLs as equal, i.e. "NULLS NOT DISTINCT" (needed for clock-level channels).
CREATE UNIQUE INDEX ux_nlog_idempotency ON [$(SCHEMA)].notification_log (activity_id, occurrence_date, reminder_key, recipient_id, channel);
CREATE INDEX ix_nlog_retry ON [$(SCHEMA)].notification_log (status, next_attempt_at);
CREATE INDEX ix_nlog_recipient ON [$(SCHEMA)].notification_log (recipient_id);
CREATE INDEX ix_nlog_clock ON [$(SCHEMA)].notification_log (clock_id, created_at DESC);

CREATE TABLE [$(SCHEMA)].in_app_notifications (
  id uniqueidentifier NOT NULL CONSTRAINT pk_inapp PRIMARY KEY CONSTRAINT df_inapp_id DEFAULT newid(),
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_inapp_user REFERENCES [$(SCHEMA)].profiles (id),
  clock_id uniqueidentifier NULL CONSTRAINT fk_inapp_clock REFERENCES [$(SCHEMA)].clocks (id),
  activity_id uniqueidentifier NULL CONSTRAINT fk_inapp_activity REFERENCES [$(SCHEMA)].activities (id),
  occurrence_date date NULL,
  kind nvarchar(20) NOT NULL,
  title nvarchar(300) NOT NULL,
  body nvarchar(1000) NULL,
  link nvarchar(1000) NULL,
  read_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_inapp_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_inapp_u DEFAULT sysdatetimeoffset()
);
CREATE INDEX ix_inapp_user ON [$(SCHEMA)].in_app_notifications (user_id, created_at DESC);

CREATE TABLE [$(SCHEMA)].ics_tokens (
  id uniqueidentifier NOT NULL CONSTRAINT pk_ics PRIMARY KEY CONSTRAINT df_ics_id DEFAULT newid(),
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_ics_user REFERENCES [$(SCHEMA)].profiles (id),
  clock_id uniqueidentifier NULL CONSTRAINT fk_ics_clock REFERENCES [$(SCHEMA)].clocks (id), -- NULL = combined feed
  token_hash nchar(64) NOT NULL CONSTRAINT uq_ics_hash UNIQUE,
  label nvarchar(100) NULL,
  last_used_at datetimeoffset(3) NULL,
  revoked_at datetimeoffset(3) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_ics_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_ics_u DEFAULT sysdatetimeoffset()
);
CREATE INDEX ix_ics_user ON [$(SCHEMA)].ics_tokens (user_id);

-- "Add to my Outlook" links (docs/calendar.md)
CREATE TABLE [$(SCHEMA)].calendar_links (
  id uniqueidentifier NOT NULL CONSTRAINT pk_callinks PRIMARY KEY CONSTRAINT df_callinks_id DEFAULT newid(),
  user_id uniqueidentifier NOT NULL CONSTRAINT fk_callinks_user REFERENCES [$(SCHEMA)].profiles (id),
  activity_id uniqueidentifier NOT NULL CONSTRAINT fk_callinks_activity REFERENCES [$(SCHEMA)].activities (id),
  scope nvarchar(12) NOT NULL CONSTRAINT ck_callinks_scope CHECK (scope IN (N'series', N'occurrence')),
  occurrence_date date NULL,
  provider nvarchar(12) NOT NULL CONSTRAINT df_callinks_provider DEFAULT N'ics_invite'
    CONSTRAINT ck_callinks_provider CHECK (provider IN (N'ics_invite', N'graph')),
  uid nvarchar(200) NOT NULL CONSTRAINT uq_callinks_uid UNIQUE,
  external_id nvarchar(400) NULL,
  sequence int NOT NULL CONSTRAINT df_callinks_seq DEFAULT 0,
  content_hash nvarchar(64) NULL,
  status nvarchar(10) NOT NULL CONSTRAINT df_callinks_status DEFAULT N'active'
    CONSTRAINT ck_callinks_status CHECK (status IN (N'active', N'removed')),
  last_synced_at datetimeoffset(3) NULL,
  last_error nvarchar(1000) NULL,
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_callinks_c DEFAULT sysdatetimeoffset(),
  updated_at datetimeoffset(3) NOT NULL CONSTRAINT df_callinks_u DEFAULT sysdatetimeoffset(),
  CONSTRAINT ck_callinks_occ CHECK ((scope = N'occurrence' AND occurrence_date IS NOT NULL) OR (scope = N'series' AND occurrence_date IS NULL))
);
-- one active link per user + activity + occurrence (NULL occurrence_date = series; NULLs compare equal)
CREATE UNIQUE INDEX ux_callinks_active ON [$(SCHEMA)].calendar_links (user_id, activity_id, occurrence_date) WHERE status = N'active';
CREATE INDEX ix_callinks_activity ON [$(SCHEMA)].calendar_links (activity_id) WHERE status = N'active';

CREATE TABLE [$(SCHEMA)].audit_log (
  id bigint IDENTITY(1, 1) NOT NULL CONSTRAINT pk_audit PRIMARY KEY,
  clock_id uniqueidentifier NULL, -- no FK: audit history outlives deleted clocks
  actor_id uniqueidentifier NULL,
  entity nvarchar(64) NOT NULL,
  entity_id uniqueidentifier NULL,
  action nvarchar(20) NOT NULL,
  -- {"before": {...} | null, "after": {...} | null}
  diff nvarchar(max) NOT NULL CONSTRAINT df_audit_diff DEFAULT N'{}' CONSTRAINT ck_audit_diff CHECK (isjson(diff) = 1),
  created_at datetimeoffset(3) NOT NULL CONSTRAINT df_audit_c DEFAULT sysdatetimeoffset()
);
CREATE INDEX ix_audit_clock ON [$(SCHEMA)].audit_log (clock_id, created_at DESC);
CREATE INDEX ix_audit_entity ON [$(SCHEMA)].audit_log (entity_id, created_at DESC);

CREATE TABLE [$(SCHEMA)].job_runs (
  id uniqueidentifier NOT NULL CONSTRAINT pk_jobs PRIMARY KEY CONSTRAINT df_jobs_id DEFAULT newid(),
  job nvarchar(64) NOT NULL,
  status nvarchar(10) NOT NULL CONSTRAINT df_jobs_status DEFAULT N'running'
    CONSTRAINT ck_jobs_status CHECK (status IN (N'running', N'success', N'failed')),
  dry_run bit NOT NULL CONSTRAINT df_jobs_dry DEFAULT 0,
  window_start datetimeoffset(3) NULL,
  window_end datetimeoffset(3) NULL,
  stats nvarchar(max) NOT NULL CONSTRAINT df_jobs_stats DEFAULT N'{}' CONSTRAINT ck_jobs_stats CHECK (isjson(stats) = 1),
  error nvarchar(2000) NULL,
  started_at datetimeoffset(3) NOT NULL CONSTRAINT df_jobs_started DEFAULT sysdatetimeoffset(),
  finished_at datetimeoffset(3) NULL
);
CREATE INDEX ix_jobs_job ON [$(SCHEMA)].job_runs (job, started_at DESC);

-- Fixed-window rate limiter for public token endpoints (service only).
CREATE TABLE [$(SCHEMA)].rate_limits (
  [key] nvarchar(200) NOT NULL,
  window_start datetimeoffset(0) NOT NULL,
  [count] int NOT NULL CONSTRAINT df_rl_count DEFAULT 0,
  CONSTRAINT pk_rate_limits PRIMARY KEY ([key], window_start)
);
