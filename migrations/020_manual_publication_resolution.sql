SET @merzz_status_check = 'ADD CONSTRAINT slots_status_allowed CHECK (status IN (''pending'', ''generating'', ''ready'', ''publishing'', ''published'', ''partial'', ''failed'', ''unknown'', ''canceled'', ''skipped'', ''admin_closed_unknown''))';
SET @merzz_ddl = IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='slots' AND constraint_name='slots_status_allowed' AND constraint_type='CHECK') > 0, 'SELECT 1', CONCAT('ALTER TABLE slots ', IF((SELECT COUNT(*) FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='slots' AND constraint_name='slots_chk_1' AND constraint_type='CHECK') > 0, 'DROP CHECK slots_chk_1, ', ''), @merzz_status_check));
PREPARE merzz_migration_stmt FROM @merzz_ddl;
EXECUTE merzz_migration_stmt;
DEALLOCATE PREPARE merzz_migration_stmt;

CREATE TABLE IF NOT EXISTS publication_resolution_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(32) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  actor_email VARCHAR(254),
  previous_status VARCHAR(24) NOT NULL,
  new_status VARCHAR(24) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  evidence_summary VARCHAR(2000) NOT NULL,
  profile_id VARCHAR(128),
  account_id VARCHAR(128),
  provider_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX publication_resolution_slot (slot_id, created_at),
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT,
  CHECK (action IN ('close_unverified', 'link_provider_post')),
  CHECK (action='close_unverified' OR (profile_id IS NOT NULL AND account_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS automation_provider_holds (
  provider VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id VARCHAR(128),
  account_id VARCHAR(128),
  reason_code VARCHAR(64) NOT NULL,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cleared_at DATETIME(3),
  cleared_by BIGINT UNSIGNED,
  PRIMARY KEY (provider, scope_key),
  INDEX provider_holds_active (active, provider),
  CHECK (provider IN ('openrouter', 'tebar')),
  CHECK ((provider='openrouter' AND profile_id IS NULL AND account_id IS NULL) OR (provider='tebar' AND profile_id IS NOT NULL AND account_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
