CREATE TABLE IF NOT EXISTS learning_shadow_start_limits (
  actor_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  window_started_at DATETIME(3) NOT NULL,
  request_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE CASCADE,
  CHECK (request_count <= 255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
