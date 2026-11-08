CREATE TABLE IF NOT EXISTS login_attempts (
  scope VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_count INT UNSIGNED NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (scope, subject_hash),
  KEY login_attempts_expires_at (expires_at)
) ENGINE=InnoDB;
