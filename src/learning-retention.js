'use strict';

// One invocation performs at most two bounded batches. The caller schedules it
// independently of publishing and can retry safely after interruption.
async function purgeExpiredEvidence({ pool, retentionDays, batchSize = 100, now = new Date() }) {
  if (!pool || typeof pool.getConnection !== 'function' || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('invalid retention configuration');
  }
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - retentionDays * 86400000);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [events] = await connection.execute(
      "SELECT event_id,candidate_id FROM learning_capture_events WHERE event_time < ? AND (evidence_status='available' OR evidence_fingerprint IS NOT NULL) ORDER BY event_time,event_id LIMIT ? FOR UPDATE",
      [cutoff, batchSize],
    );
    const candidateIds = events.map((row) => row.candidate_id).filter((id) => id != null);
    if (candidateIds.length) {
      await connection.execute(`UPDATE learning_candidates SET caption_excerpt='' WHERE id IN (${candidateIds.map(() => '?').join(',')})`, candidateIds);
    }
    if (events.length) {
      await connection.execute(`UPDATE learning_capture_events SET evidence_status='unavailable',evidence_reason='retention_expired',evidence_fingerprint=NULL WHERE event_id IN (${events.map(() => '?').join(',')})`, events.map((row) => row.event_id));
    }
    // Legacy validation excerpts created before event linkage are also ephemeral.
    const [legacy] = await connection.execute(
      "SELECT c.id FROM learning_candidates c WHERE c.source='validation' AND c.status IN ('pending','approved','rejected','false_positive') AND c.created_at < ? AND c.caption_excerpt <> '' AND NOT EXISTS (SELECT 1 FROM learning_capture_events e WHERE e.candidate_id=c.id) ORDER BY c.created_at,c.id LIMIT ? FOR UPDATE",
      [cutoff, batchSize],
    );
    if (legacy.length) {
      await connection.execute(`UPDATE learning_candidates SET caption_excerpt='' WHERE id IN (${legacy.map(() => '?').join(',')})`, legacy.map((row) => row.id));
    }
    await connection.commit();
    const [[eventBacklog]] = await connection.execute(
      "SELECT COUNT(*) AS count, MIN(event_time) AS oldest FROM learning_capture_events WHERE event_time < ? AND (evidence_status='available' OR evidence_fingerprint IS NOT NULL)",
      [cutoff],
    );
    const [[legacyBacklog]] = await connection.execute(
      "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM learning_candidates c WHERE c.source='validation' AND c.status IN ('pending','approved','rejected','false_positive') AND c.created_at < ? AND c.caption_excerpt <> '' AND NOT EXISTS (SELECT 1 FROM learning_capture_events e WHERE e.candidate_id=c.id)",
      [cutoff],
    );
    const oldest = [eventBacklog?.oldest, legacyBacklog?.oldest].filter(Boolean).map((value) => new Date(value).getTime());
    const oldestExpiredAgeMs = oldest.length ? Math.max(0, now.getTime() - Math.min(...oldest)) : 0;
    return {
      events: events.length,
      legacyCandidates: legacy.length,
      expiredEventBacklog: Number(eventBacklog?.count || 0),
      expiredLegacyBacklog: Number(legacyBacklog?.count || 0),
      oldestExpiredAgeMs,
      cleanupDurationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
module.exports = { purgeExpiredEvidence };
