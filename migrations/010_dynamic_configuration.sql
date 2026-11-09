CREATE TABLE IF NOT EXISTS integration_config (
  id TINYINT NOT NULL PRIMARY KEY CHECK (id=1),
  version BIGINT UNSIGNED NOT NULL,
  profile_id VARCHAR(128) NULL,
  account_id VARCHAR(128) NULL,
  model VARCHAR(200) NULL,
  status VARCHAR(32) NOT NULL,
  pending_profile_id VARCHAR(128) NULL,
  pending_account_id VARCHAR(128) NULL,
  pending_model VARCHAR(200) NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CHECK (status IN ('NOT_CONFIGURED','ACTIVE','SWITCHING','BLOCKED_RECONCILIATION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS integration_config_history (
  version BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  profile_id VARCHAR(128) NULL,
  account_id VARCHAR(128) NULL,
  model VARCHAR(200) NULL,
  status VARCHAR(32) NOT NULL,
  action VARCHAR(40) NOT NULL,
  pending_profile_id VARCHAR(128) NULL,
  pending_account_id VARCHAR(128) NULL,
  actor_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='tebar_profile_id') = 0, 'ALTER TABLE slots ADD COLUMN tebar_profile_id VARCHAR(128) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='tebar_account_id') = 0, 'ALTER TABLE slots ADD COLUMN tebar_account_id VARCHAR(128) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='tebar_config_version') = 0, 'ALTER TABLE slots ADD COLUMN tebar_config_version BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='model_config_version') = 0, 'ALTER TABLE slots ADD COLUMN model_config_version BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='slots' AND column_name='openrouter_model') = 0, 'ALTER TABLE slots ADD COLUMN openrouter_model VARCHAR(200) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config' AND column_name='pending_model') = 0, 'ALTER TABLE integration_config ADD COLUMN pending_model VARCHAR(200) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config_history' AND column_name='pending_profile_id') = 0, 'ALTER TABLE integration_config_history ADD COLUMN pending_profile_id VARCHAR(128) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='integration_config_history' AND column_name='pending_account_id') = 0, 'ALTER TABLE integration_config_history ADD COLUMN pending_account_id VARCHAR(128) NULL', 'SELECT 1');
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;
