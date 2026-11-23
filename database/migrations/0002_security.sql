-- ESL Annual Clock — authorization with SQL Server Row-Level Security.
-- Rules: docs/authorization.md. Tests: tests/db/rls.test.ts (run against SQL Server in CI).
--
-- The app opens every transaction with lib/db → withUser()/withService(), which sets
-- SESSION_CONTEXT keys on the connection:
--   app_service  1 = trusted server code (scheduler, token endpoints, super-admin operations), else 0
--   user_id      the signed-in, ACTIVE user's profile id (NULL for inactive users / service)
--   user_flags   'S' super admin, 'G' General management (all_clocks_viewer)
--   clock_roles  JSON object {"<clock id, lowercase>": "v" | "e" | "a"} (viewer/editor/admin)
-- withUser() reads flags and roles from profiles/clock_members inside the same transaction.
-- Predicates below only compare row columns with this context (no table reads, no recursion).
-- Everything is denied when the context is not set.

CREATE FUNCTION [$(SCHEMA)].rls_ctx(@clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT
  CASE WHEN TRY_CAST(SESSION_CONTEXT(N'app_service') AS int) = 1 THEN 1 ELSE 0 END AS svc,
  CASE WHEN CAST(SESSION_CONTEXT(N'user_flags') AS nvarchar(10)) LIKE N'%S%' THEN 1 ELSE 0 END AS super_admin,
  CASE WHEN CAST(SESSION_CONTEXT(N'user_flags') AS nvarchar(10)) LIKE N'%G%' THEN 1 ELSE 0 END AS gm,
  TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier) AS uid,
  CASE WHEN @clock_id IS NULL THEN NULL
       ELSE JSON_VALUE(CAST(SESSION_CONTEXT(N'clock_roles') AS nvarchar(4000)),
                       N'$."' + LOWER(CONVERT(nvarchar(36), @clock_id)) + N'"') END AS role;
GO

-- generic helpers (argument = the row's key column; only used to bind the predicate to the table)
CREATE FUNCTION [$(SCHEMA)].rls_service(@x uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(NULL) c WHERE c.svc = 1;
GO
CREATE FUNCTION [$(SCHEMA)].rls_super(@x uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(NULL) c WHERE c.svc = 1 OR c.super_admin = 1;
GO
CREATE FUNCTION [$(SCHEMA)].rls_signed_in(@x uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(NULL) c WHERE c.svc = 1 OR c.uid IS NOT NULL;
GO
CREATE FUNCTION [$(SCHEMA)].rls_service_key(@k nvarchar(200))
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(NULL) c WHERE c.svc = 1;
GO
CREATE FUNCTION [$(SCHEMA)].rls_self(@user_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(NULL) c WHERE c.svc = 1 OR (c.uid IS NOT NULL AND c.uid = @user_id);
GO

-- clock-scoped
CREATE FUNCTION [$(SCHEMA)].rls_read_clock(@clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.super_admin = 1 OR c.gm = 1 OR c.role IS NOT NULL));
GO
CREATE FUNCTION [$(SCHEMA)].rls_edit_clock(@clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.super_admin = 1 OR c.role IN (N'e', N'a')));
GO
CREATE FUNCTION [$(SCHEMA)].rls_admin_clock(@clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.super_admin = 1 OR c.role = N'a'));
GO

-- table-specific
CREATE FUNCTION [$(SCHEMA)].rls_read_activity(@clock_id uniqueidentifier, @deleted_at datetimeoffset(3))
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1
   OR (c.uid IS NOT NULL AND (c.super_admin = 1 OR c.gm = 1 OR c.role IS NOT NULL)
       AND (@deleted_at IS NULL OR c.super_admin = 1 OR c.role = N'a'));
GO
CREATE FUNCTION [$(SCHEMA)].rls_prefs_read(@user_id uniqueidentifier, @clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.uid = @user_id OR c.super_admin = 1 OR c.role = N'a'));
GO
CREATE FUNCTION [$(SCHEMA)].rls_prefs_write(@user_id uniqueidentifier, @clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid = @user_id AND (c.super_admin = 1 OR c.gm = 1 OR c.role IS NOT NULL));
GO
CREATE FUNCTION [$(SCHEMA)].rls_nlog_read(@recipient_id uniqueidentifier, @clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.uid = @recipient_id OR (@clock_id IS NOT NULL AND (c.super_admin = 1 OR c.role = N'a'))));
GO
CREATE FUNCTION [$(SCHEMA)].rls_ics_write(@user_id uniqueidentifier, @clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid = @user_id AND (@clock_id IS NULL OR c.super_admin = 1 OR c.gm = 1 OR c.role IS NOT NULL));
GO
CREATE FUNCTION [$(SCHEMA)].rls_audit_read(@clock_id uniqueidentifier)
RETURNS TABLE WITH SCHEMABINDING AS RETURN
SELECT 1 AS ok FROM [$(SCHEMA)].rls_ctx(@clock_id) c
WHERE c.svc = 1 OR (c.uid IS NOT NULL AND (c.super_admin = 1 OR c.gm = 1 OR c.role IN (N'e', N'a')));
GO

CREATE SECURITY POLICY [$(SCHEMA)].rls_policy
  -- profiles: internal directory readable by signed-in users; users update only their own row
  -- (privileged columns guarded by trigger trg_profiles_guard)
  ADD FILTER PREDICATE [$(SCHEMA)].rls_signed_in(id) ON [$(SCHEMA)].profiles,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].profiles AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(id) ON [$(SCHEMA)].profiles BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(id) ON [$(SCHEMA)].profiles AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].profiles BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_clock(id) ON [$(SCHEMA)].clocks,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_super(id) ON [$(SCHEMA)].clocks AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(id) ON [$(SCHEMA)].clocks BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(id) ON [$(SCHEMA)].clocks AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_super(id) ON [$(SCHEMA)].clocks BEFORE DELETE,

  -- server-only secrets
  ADD FILTER PREDICATE [$(SCHEMA)].rls_service(clock_id) ON [$(SCHEMA)].clock_secrets,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(clock_id) ON [$(SCHEMA)].clock_secrets AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(clock_id) ON [$(SCHEMA)].clock_secrets AFTER UPDATE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_clock(clock_id) ON [$(SCHEMA)].clock_members,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].clock_members AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].clock_members BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].clock_members AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].clock_members BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_prefs_read(user_id, clock_id) ON [$(SCHEMA)].notification_prefs,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_prefs_write(user_id, clock_id) ON [$(SCHEMA)].notification_prefs AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].notification_prefs BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_prefs_write(user_id, clock_id) ON [$(SCHEMA)].notification_prefs AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].notification_prefs BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_clock(clock_id) ON [$(SCHEMA)].rings,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].rings AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].rings BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].rings AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_admin_clock(clock_id) ON [$(SCHEMA)].rings BEFORE DELETE,

  -- activities: read with clock (soft-deleted rows only for admins); write by editors/admins;
  -- hard delete only by super admin (the app soft-deletes)
  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_activity(clock_id, deleted_at) ON [$(SCHEMA)].activities,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activities AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activities BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activities AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_super(clock_id) ON [$(SCHEMA)].activities BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_clock(clock_id) ON [$(SCHEMA)].activity_assignees,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_assignees AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_assignees BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_assignees AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_assignees BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_read_clock(clock_id) ON [$(SCHEMA)].activity_occurrences_state,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_occurrences_state AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_occurrences_state BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_occurrences_state AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_edit_clock(clock_id) ON [$(SCHEMA)].activity_occurrences_state BEFORE DELETE,

  -- notifications: written by the server only
  ADD FILTER PREDICATE [$(SCHEMA)].rls_nlog_read(recipient_id, clock_id) ON [$(SCHEMA)].notification_log,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].notification_log AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].notification_log BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].notification_log BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].in_app_notifications,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].in_app_notifications AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].in_app_notifications BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].in_app_notifications AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].in_app_notifications BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].ics_tokens,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_ics_write(user_id, clock_id) ON [$(SCHEMA)].ics_tokens AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].ics_tokens BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].ics_tokens AFTER UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].ics_tokens BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_self(user_id) ON [$(SCHEMA)].calendar_links,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].calendar_links AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].calendar_links BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].calendar_links BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_audit_read(clock_id) ON [$(SCHEMA)].audit_log,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].audit_log AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].audit_log BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].audit_log BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_super(id) ON [$(SCHEMA)].job_runs,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].job_runs AFTER INSERT,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].job_runs BEFORE UPDATE,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service(id) ON [$(SCHEMA)].job_runs BEFORE DELETE,

  ADD FILTER PREDICATE [$(SCHEMA)].rls_service_key([key]) ON [$(SCHEMA)].rate_limits,
  ADD BLOCK PREDICATE [$(SCHEMA)].rls_service_key([key]) ON [$(SCHEMA)].rate_limits AFTER INSERT
WITH (STATE = ON, SCHEMABINDING = ON);
GO

-- ---------------------------------------------------------------------------
-- Column guards (SQL Server RLS is row-based; these replace Postgres column grants).
-- Error 50001 is mapped to "permission denied" by lib/db.
-- ---------------------------------------------------------------------------
CREATE TRIGGER [$(SCHEMA)].trg_profiles_guard ON [$(SCHEMA)].profiles AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF ISNULL(TRY_CAST(SESSION_CONTEXT(N'app_service') AS int), 0) = 1 RETURN;
  IF UPDATE(global_role) OR UPDATE(all_clocks_viewer) OR UPDATE(is_active) OR UPDATE(email)
     OR UPDATE(is_demo) OR UPDATE(external_id) OR UPDATE(id)
    THROW 50001, N'permission denied: privileged profile columns can only be changed by administrators', 1;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_clocks_guard ON [$(SCHEMA)].clocks AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF ISNULL(TRY_CAST(SESSION_CONTEXT(N'app_service') AS int), 0) = 1 RETURN;
  IF CAST(SESSION_CONTEXT(N'user_flags') AS nvarchar(10)) LIKE N'%S%' RETURN;
  IF UPDATE(is_general_management) OR UPDATE(is_demo) OR UPDATE(slug) OR UPDATE(id)
    THROW 50001, N'permission denied: only super admins can change this clock attribute', 1;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_inapp_guard ON [$(SCHEMA)].in_app_notifications AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF ISNULL(TRY_CAST(SESSION_CONTEXT(N'app_service') AS int), 0) = 1 RETURN;
  IF UPDATE(id) OR UPDATE(user_id) OR UPDATE(clock_id) OR UPDATE(activity_id) OR UPDATE(occurrence_date)
     OR UPDATE(kind) OR UPDATE(title) OR UPDATE(body) OR UPDATE(link) OR UPDATE(created_at)
    THROW 50001, N'permission denied: users can only mark notifications read', 1;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_ics_guard ON [$(SCHEMA)].ics_tokens AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF ISNULL(TRY_CAST(SESSION_CONTEXT(N'app_service') AS int), 0) = 1 RETURN;
  IF UPDATE(id) OR UPDATE(user_id) OR UPDATE(clock_id) OR UPDATE(token_hash) OR UPDATE(last_used_at) OR UPDATE(created_at)
    THROW 50001, N'permission denied: users can only rename or revoke their feeds', 1;
END
GO
