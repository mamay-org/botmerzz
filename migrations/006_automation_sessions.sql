SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='automation_session_id') = 0, 'ALTER TABLE slots ADD COLUMN automation_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER scheduled_at', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='slots' AND index_name='scheduled_at' AND non_unique=0) > 0, 'ALTER TABLE slots DROP INDEX scheduled_at', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='slots' AND index_name='slots_session_scheduled') = 0, 'ALTER TABLE slots ADD UNIQUE KEY slots_session_scheduled (automation_session_id, scheduled_at)', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='slots' AND index_name='slots_session_due') = 0, 'ALTER TABLE slots ADD INDEX slots_session_due (automation_session_id, status, scheduled_at)', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

UPDATE settings
SET settings_json=JSON_SET(COALESCE(settings_json, JSON_OBJECT()), '$.automationSessionId', UUID())
WHERE id=1 AND automation_enabled=TRUE
  AND JSON_EXTRACT(settings_json, '$.automationSessionId') IS NULL;

UPDATE slots s
JOIN settings st ON st.id=1
SET s.automation_session_id=JSON_UNQUOTE(JSON_EXTRACT(st.settings_json, '$.automationSessionId'))
WHERE st.automation_enabled=TRUE
  AND s.automation_session_id IS NULL;

UPDATE settings
SET settings_json=JSON_SET(COALESCE(settings_json, JSON_OBJECT()), '$.schedule.intervalHours', 1)
WHERE id=1;
