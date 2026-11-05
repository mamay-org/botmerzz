CREATE TABLE IF NOT EXISTS admins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  singleton_key TINYINT NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  admin_id BIGINT UNSIGNED NOT NULL,
  csrf_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX sessions_expiry (expires_at),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  id TINYINT NOT NULL PRIMARY KEY CHECK (id = 1),
  settings_json JSON NOT NULL,
  knowledge_json JSON NOT NULL,
  automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO settings (id, settings_json, knowledge_json, automation_enabled)
VALUES (1, JSON_OBJECT(), JSON_OBJECT(), FALSE);

CREATE TABLE IF NOT EXISTS service_facts (
  service VARCHAR(32) NOT NULL PRIMARY KEY,
  summary_json JSON NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS slots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  scheduled_at DATETIME(3) NOT NULL UNIQUE,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  pillar VARCHAR(32),
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  request_payload JSON,
  provider_post_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin,
  provider_status VARCHAR(32),
  caption TEXT,
  fact_bearing BOOLEAN NOT NULL DEFAULT FALSE,
  fact_ids JSON,
  error_code VARCHAR(64),
  cancellation_status VARCHAR(32),
  claimed_at DATETIME(3),
  publish_started_at DATETIME(3),
  completed_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX slots_due (status, scheduled_at),
  INDEX slots_provider (provider_post_id),
  CHECK (status IN ('pending', 'generating', 'ready', 'publishing', 'published', 'partial', 'failed', 'unknown', 'canceled', 'skipped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
  event VARCHAR(64) NOT NULL,
  details_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX activity_created (created_at),
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT UNSIGNED,
  action VARCHAR(64) NOT NULL,
  details_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX audit_created (created_at),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_summaries (
  local_date DATE NOT NULL,
  timezone VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  details_json JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3),
  PRIMARY KEY (local_date, timezone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
