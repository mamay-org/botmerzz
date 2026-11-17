CREATE TABLE IF NOT EXISTS learning_rule_versions (
  rule_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  instruction VARCHAR(1000) NOT NULL,
  scope VARCHAR(32) NOT NULL,
  product_category VARCHAR(32) NOT NULL,
  content_topic VARCHAR(48) NOT NULL,
  source_candidate_id BIGINT UNSIGNED NOT NULL,
  source_slot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (rule_id,version),
  INDEX learning_rule_version_source (source_candidate_id,created_at),
  INDEX learning_rule_version_scope (product_category,content_topic,created_at),
  FOREIGN KEY (rule_id) REFERENCES learning_rules(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_candidate_id) REFERENCES learning_candidates(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_slot_id) REFERENCES slots(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE RESTRICT,
  CHECK (version > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_rule_version_decisions (
  rule_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  decision VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL DEFAULT '',
  decided_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (rule_id,version),
  INDEX learning_rule_decisions_actor (actor_id,decided_at),
  FOREIGN KEY (rule_id,version) REFERENCES learning_rule_versions(rule_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE RESTRICT,
  CHECK (decision IN ('approved','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_rule_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(1000) NOT NULL DEFAULT '',
  details_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX learning_rule_actions_rule (rule_id,id),
  INDEX learning_rule_actions_time (action,created_at),
  INDEX learning_rule_actions_chronological (created_at,id),
  FOREIGN KEY (rule_id) REFERENCES learning_rules(id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_id,version) REFERENCES learning_rule_versions(rule_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_rule_active_versions (
  rule_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  version INT UNSIGNED NOT NULL,
  activated_by BIGINT UNSIGNED NOT NULL,
  activated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (rule_id,version) REFERENCES learning_rule_versions(rule_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (activated_by) REFERENCES admins(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_rule_supersessions (
  rule_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  replacement_rule_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX learning_rule_supersessions_replacement (replacement_rule_id,created_at),
  FOREIGN KEY (rule_id) REFERENCES learning_rules(id) ON DELETE RESTRICT,
  FOREIGN KEY (replacement_rule_id) REFERENCES learning_rules(id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_id,version) REFERENCES learning_rule_versions(rule_id,version) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE RESTRICT,
  CHECK (rule_id <> replacement_rule_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_rule_activation_lock (
  id TINYINT NOT NULL PRIMARY KEY,
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO learning_rule_activation_lock (id) VALUES (1);

-- Legacy rows contain only their current content. Snapshot that known content
-- as version 1, without inventing earlier history or assuming prior activation state.
INSERT IGNORE INTO learning_rule_versions
  (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,source_attempt_id,created_by,created_at)
SELECT r.id,1,r.instruction,r.scope,
  CASE WHEN r.scope IN ('account','topup') THEN r.scope WHEN r.scope='global' THEN 'all' ELSE 'invalid' END,
  'all',c.id,c.slot_id,
  (SELECT e.attempt_id FROM learning_capture_events e WHERE e.candidate_id=c.id ORDER BY e.event_time,e.event_id LIMIT 1),
  r.approved_by,r.approved_at
FROM learning_rules r
JOIN learning_candidates c ON c.id=r.candidate_id
WHERE c.status='approved';

INSERT IGNORE INTO learning_rule_version_decisions (rule_id,version,decision,actor_id,reason,decided_at)
SELECT r.id,1,'approved',r.approved_by,'Migrated from the existing approved rule record.',r.approved_at
FROM learning_rules r
JOIN learning_candidates c ON c.id=r.candidate_id
JOIN learning_rule_versions v ON v.rule_id=r.id AND v.version=1
WHERE c.status='approved';
