CREATE TABLE IF NOT EXISTS generation_slot_claims (
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  claimed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX generation_slot_claimed_at (claimed_at),
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS generation_attempts (
  attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  state VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_id VARCHAR(128) NULL,
  config_version VARCHAR(64) NULL,
  learning_capture_expected BOOLEAN NOT NULL DEFAULT FALSE,
  deterministic_outcome VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'NOT_RUN',
  semantic_outcome VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'NOT_RUN',
  failure_codes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  validation_started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY generation_attempt_operation (slot_id, operation_id),
  UNIQUE KEY generation_attempt_ordinal (slot_id, ordinal),
  INDEX generation_attempt_state (state, created_at),
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT,
  CHECK (state IN ('reserved','generating','validating','passed','contextual_failed','technical_failed','unknown')),
  CHECK (deterministic_outcome IN ('NOT_RUN','IN_PROGRESS','PASSED','FAILED','UNKNOWN','TECHNICAL_FAILED')),
  CHECK (semantic_outcome IN ('NOT_RUN','IN_PROGRESS','PASSED','FAILED','UNKNOWN','TECHNICAL_FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
