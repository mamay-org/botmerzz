CREATE INDEX slots_published_completed
  ON slots (status, completed_at, id);
