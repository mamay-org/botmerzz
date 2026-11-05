CREATE TABLE IF NOT EXISTS notification_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dedupe_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  message VARCHAR(1200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3),
  sent_at DATETIME(3),
  last_error_code VARCHAR(64),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX notification_queue (status, available_at),
  CHECK (status IN ('pending', 'sending', 'sent', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
