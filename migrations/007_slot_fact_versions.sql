SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='fact_versions') = 0, 'ALTER TABLE slots ADD COLUMN fact_versions JSON NULL AFTER fact_ids', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='content_safety_hash') = 0, 'ALTER TABLE slots ADD COLUMN content_safety_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER fact_versions', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;
