-- ESL Annual Clock — audit trail: who changed what, when, per clock.
-- Each trigger stores {"before": <row>, "after": <row>} (FOR JSON). The app derives changed
-- fields from it (app/(app)/clocks/actions.ts → getActivityHistory). Audit rows may only be
-- written in service context (RLS), so the trigger raises app_service for the insert and restores it.
-- NOTE: tables with triggers cannot be used with OUTPUT without INTO — the app never uses OUTPUT.

CREATE TRIGGER [$(SCHEMA)].trg_audit_clocks ON [$(SCHEMA)].clocks AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.id, d.id),
         @actor,
         N'clocks', COALESCE(i.id, d.id), CASE WHEN d.id IS NULL THEN N'insert' WHEN i.id IS NULL THEN N'delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.id = d.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.id = i.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_audit_clock_members ON [$(SCHEMA)].clock_members AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.clock_id, d.clock_id),
         @actor,
         N'clock_members', COALESCE(i.id, d.id), CASE WHEN d.id IS NULL THEN N'insert' WHEN i.id IS NULL THEN N'delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.id = d.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.id = i.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_audit_rings ON [$(SCHEMA)].rings AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.clock_id, d.clock_id),
         @actor,
         N'rings', COALESCE(i.id, d.id), CASE WHEN d.id IS NULL THEN N'insert' WHEN i.id IS NULL THEN N'delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.id = d.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.id = i.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_audit_activities ON [$(SCHEMA)].activities AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.clock_id, d.clock_id),
         COALESCE(@actor, i.updated_by, i.completed_by),
         N'activities', COALESCE(i.id, d.id), CASE WHEN d.id IS NULL THEN N'insert' WHEN i.id IS NULL THEN N'delete' WHEN i.deleted_at IS NOT NULL AND d.deleted_at IS NULL THEN N'soft_delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.id = d.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.id = i.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_audit_activity_assignees ON [$(SCHEMA)].activity_assignees AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.clock_id, d.clock_id),
         @actor,
         N'activity_assignees', COALESCE(i.activity_id, d.activity_id), CASE WHEN d.activity_id IS NULL THEN N'insert' WHEN i.activity_id IS NULL THEN N'delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.activity_id = d.activity_id AND z.user_id = d.user_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.activity_id = i.activity_id AND y.user_id = i.user_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.activity_id = d.activity_id AND i.user_id = d.user_id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO

CREATE TRIGGER [$(SCHEMA)].trg_audit_activity_occurrences_state ON [$(SCHEMA)].activity_occurrences_state AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM deleted) RETURN;
  DECLARE @svc sql_variant = SESSION_CONTEXT(N'app_service');
  DECLARE @actor uniqueidentifier = TRY_CAST(CAST(SESSION_CONTEXT(N'user_id') AS nvarchar(36)) AS uniqueidentifier);
  EXEC sp_set_session_context N'app_service', 1;
  INSERT INTO [$(SCHEMA)].audit_log (clock_id, actor_id, entity, entity_id, action, diff)
  SELECT COALESCE(i.clock_id, d.clock_id),
         COALESCE(@actor, i.updated_by, i.completed_by),
         N'activity_occurrences_state', COALESCE(i.activity_id, d.activity_id), CASE WHEN d.id IS NULL THEN N'insert' WHEN i.id IS NULL THEN N'delete' ELSE N'update' END,
         (SELECT JSON_QUERY((SELECT z.* FROM deleted z WHERE z.id = d.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [before],
                 JSON_QUERY((SELECT y.* FROM inserted y WHERE y.id = i.id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)) AS [after]
          FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM inserted i FULL OUTER JOIN deleted d ON i.id = d.id;
  EXEC sp_set_session_context N'app_service', @svc;
END
GO
