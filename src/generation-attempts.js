'use strict';

const { randomUUID } = require('node:crypto');

const TERMINAL = new Set(['passed', 'contextual_failed', 'technical_failed', 'unknown']);
const ALLOWED = Object.freeze({
  reserved: new Set(['generating', 'unknown']),
  generating: new Set(['validating', 'contextual_failed', 'technical_failed', 'unknown']),
  validating: new Set(['validating', 'passed', 'contextual_failed', 'technical_failed', 'unknown']),
});
const CONNECTION_ERRORS = new Set(['PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

function createGenerationAttemptStore(pool) {
  async function findByOperation(slotId, operationId) {
    const [rows] = await pool.execute(
      'SELECT attempt_id,slot_id,operation_id,ordinal,state,model_id,config_version,deterministic_outcome,semantic_outcome,failure_codes,created_at,started_at,validation_started_at,completed_at FROM generation_attempts WHERE slot_id=? AND operation_id=?',
      [slotId, operationId],
    );
    return rows[0] || null;
  }

  async function findById(attemptId) {
    const [rows] = await pool.execute(
      'SELECT attempt_id,slot_id,operation_id,ordinal,state,model_id,config_version,deterministic_outcome,semantic_outcome,failure_codes,created_at,started_at,validation_started_at,completed_at FROM generation_attempts WHERE attempt_id=?',
      [attemptId],
    );
    return rows[0] || null;
  }

  async function reserve({ slotId, operationId, modelId = null, configVersion = null, learningCaptureExpected = false }) {
    if (typeof slotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(slotId)
      || typeof operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(operationId)) {
      throw Object.assign(new Error('INVALID_ATTEMPT_RESERVATION'), { code: 'INVALID_ATTEMPT_RESERVATION' });
    }
    const attemptId = randomUUID();
    let lastError;
    for (let retry = 0; retry < 2; retry++) {
      const c = await pool.getConnection();
      let destroy = false;
      try {
        await c.beginTransaction();
        const [[slot]] = await c.execute('SELECT status FROM slots WHERE id=? FOR UPDATE', [slotId]);
        if (!slot || slot.status !== 'generating' || !operationId.startsWith(`${slotId}:gen:`)) {
          throw Object.assign(new Error('ATTEMPT_SLOT_NOT_GENERATING'), { code: 'ATTEMPT_SLOT_NOT_GENERATING' });
        }
        const [[existing]] = await c.execute(
          'SELECT attempt_id,slot_id,operation_id,ordinal,state,model_id,config_version,deterministic_outcome,semantic_outcome,failure_codes,created_at,started_at,validation_started_at,completed_at FROM generation_attempts WHERE slot_id=? AND operation_id=?',
          [slotId, operationId],
        );
        if (existing) {
          await c.commit();
          return existing;
        }
        const [[last]] = await c.execute('SELECT COALESCE(MAX(ordinal),0) AS last_ordinal FROM generation_attempts WHERE slot_id=?', [slotId]);
        const ordinal = Number(last.last_ordinal) + 1;
        await c.execute(
          "INSERT INTO generation_attempts (attempt_id,slot_id,operation_id,ordinal,state,model_id,config_version,learning_capture_expected,failure_codes) VALUES (?,?,?,?,'reserved',?,?,?,JSON_ARRAY())",
          [attemptId, slotId, operationId, ordinal, modelId, configVersion, Boolean(learningCaptureExpected)],
        );
        await c.commit();
        return { attempt_id: attemptId, slot_id: slotId, operation_id: operationId, ordinal, state: 'reserved', model_id: modelId, config_version: configVersion, learning_capture_expected: Boolean(learningCaptureExpected), deterministic_outcome: 'NOT_RUN', semantic_outcome: 'NOT_RUN' };
      } catch (error) {
        lastError = error;
        await c.rollback().catch(() => { destroy = true; });
        if (CONNECTION_ERRORS.has(error.code)) destroy = true;
      } finally {
        if (destroy) c.destroy(); else c.release();
      }
      // Resolve a lost commit acknowledgment from the authoritative table before retrying.
      let current;
      try { current = await findByOperation(slotId, operationId); } catch { throw lastError; }
      if (current) return current;
      if (retry === 1) throw lastError;
    }
    throw lastError;
  }

  async function transition(attemptId, nextState, { deterministic, semantic, failureCodes = [] } = {}) {
    if (!ALLOWED[nextState] && !TERMINAL.has(nextState)) {
      throw Object.assign(new Error('INVALID_ATTEMPT_STATE'), { code: 'INVALID_ATTEMPT_STATE' });
    }
    const codes = [...new Set(failureCodes)];
    if (codes.length > 20 || codes.some((code) => typeof code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(code))) {
      throw Object.assign(new Error('INVALID_ATTEMPT_FINDINGS'), { code: 'INVALID_ATTEMPT_FINDINGS' });
    }
    let lastError;
    for (let retry = 0; retry < 2; retry++) {
      const c = await pool.getConnection();
      let destroy = false;
      try {
        await c.beginTransaction();
        const [[row]] = await c.execute('SELECT state,deterministic_outcome,semantic_outcome,failure_codes FROM generation_attempts WHERE attempt_id=? FOR UPDATE', [attemptId]);
        if (!row) throw Object.assign(new Error('ATTEMPT_NOT_FOUND'), { code: 'ATTEMPT_NOT_FOUND' });
        if (TERMINAL.has(row.state)) {
          const same = row.state === nextState
            && (deterministic == null || row.deterministic_outcome === deterministic)
            && (semantic == null || row.semantic_outcome === semantic);
          if (same) { await c.commit(); return row; }
          throw Object.assign(new Error('ATTEMPT_TERMINAL_CONFLICT'), { code: 'ATTEMPT_TERMINAL_CONFLICT' });
        }
        if (row.state !== nextState && !ALLOWED[row.state]?.has(nextState)) {
          throw Object.assign(new Error('INVALID_ATTEMPT_TRANSITION'), { code: 'INVALID_ATTEMPT_TRANSITION' });
        }
        const mergedCodes = [...new Set([...(typeof row.failure_codes === 'string' ? JSON.parse(row.failure_codes) : row.failure_codes || []), ...codes])].sort();
        const det = deterministic ?? row.deterministic_outcome;
        const sem = semantic ?? row.semantic_outcome;
        if (row.deterministic_outcome !== 'NOT_RUN' && row.deterministic_outcome !== 'IN_PROGRESS' && deterministic && row.deterministic_outcome !== deterministic) {
          throw Object.assign(new Error('ATTEMPT_STAGE_CONFLICT'), { code: 'ATTEMPT_STAGE_CONFLICT' });
        }
        if (row.semantic_outcome !== 'NOT_RUN' && row.semantic_outcome !== 'IN_PROGRESS' && semantic && row.semantic_outcome !== semantic) {
          throw Object.assign(new Error('ATTEMPT_STAGE_CONFLICT'), { code: 'ATTEMPT_STAGE_CONFLICT' });
        }
        await c.execute(
          "UPDATE generation_attempts SET state=?,deterministic_outcome=?,semantic_outcome=?,failure_codes=?,started_at=IF(?='generating',COALESCE(started_at,UTC_TIMESTAMP(3)),started_at),validation_started_at=IF(?='validating',COALESCE(validation_started_at,UTC_TIMESTAMP(3)),validation_started_at),completed_at=IF(? IN ('passed','contextual_failed','technical_failed','unknown'),COALESCE(completed_at,UTC_TIMESTAMP(3)),completed_at) WHERE attempt_id=?",
          [nextState, det, sem, JSON.stringify(mergedCodes), nextState, nextState, nextState, attemptId],
        );
        await c.commit();
        return { ...row, state: nextState, deterministic_outcome: det, semantic_outcome: sem, failure_codes: mergedCodes };
      } catch (error) {
        lastError = error;
        await c.rollback().catch(() => { destroy = true; });
        if (CONNECTION_ERRORS.has(error.code)) destroy = true;
      } finally {
        if (destroy) c.destroy(); else c.release();
      }
      // A matching committed state proves success; a readable nonmatching state is safe to retry.
      let current;
      try { current = await findById(attemptId); } catch { throw lastError; }
      if (current?.state === nextState
        && (deterministic == null || current.deterministic_outcome === deterministic)
        && (semantic == null || current.semantic_outcome === semantic)) return current;
      if (current && TERMINAL.has(current.state)) throw Object.assign(new Error('ATTEMPT_TERMINAL_CONFLICT'), { code: 'ATTEMPT_TERMINAL_CONFLICT' });
      if (retry === 1) throw lastError;
    }
    throw lastError;
  }

  async function listBySlot(slotId) {
    const [rows] = await pool.execute('SELECT * FROM generation_attempts WHERE slot_id=? ORDER BY ordinal', [slotId]);
    return rows;
  }

  async function completenessReport() {
    const [firstRows] = await pool.execute(
      `SELECT
         COUNT(*) AS eligible_slots,
         SUM(a.attempt_id IS NOT NULL) AS first_attempts,
         SUM(a.state='passed') AS passed,
         SUM(a.state='contextual_failed') AS contextual_failed,
         SUM(a.state='technical_failed') AS technical_failed,
         SUM(a.state='unknown') AS unknown_outcomes,
         SUM(a.state IN ('reserved','generating','validating')) AS incomplete,
         SUM(a.attempt_id IS NULL) AS missing_attempt
       FROM generation_slot_claims p
       JOIN slots s ON s.id=p.slot_id
       LEFT JOIN generation_attempts a ON a.slot_id=s.id AND a.ordinal=1
       WHERE p.claimed_at IS NOT NULL`,
    );
    const [legacyRows] = await pool.execute(
      `SELECT COUNT(*) AS legacy_slots, SUM(COALESCE(o.observations,0)>0) AS partially_reconstructable
       FROM slots s JOIN schema_migrations m ON m.version='014_generation_attempts.sql'
       LEFT JOIN generation_slot_claims p ON p.slot_id=s.id
       LEFT JOIN (SELECT slot_id,COUNT(*) AS observations FROM validation_outcome_observations GROUP BY slot_id) o ON o.slot_id=s.id
       WHERE s.created_at<m.applied_at AND s.claimed_at IS NOT NULL AND p.slot_id IS NULL`,
    );
    const [telemetryRows] = await pool.execute(
      `SELECT COUNT(*) AS expected, SUM(o.attempt_id IS NOT NULL) AS captured
       FROM generation_attempts a
       LEFT JOIN validation_outcome_observations o ON o.attempt_id=a.attempt_id
       WHERE a.learning_capture_expected=TRUE`,
    );
    const row = firstRows[0] || {};
    const count = (value) => Number(value || 0);
    const eligibleSlots = count(row.eligible_slots);
    const passed = count(row.passed);
    const contextualFailed = count(row.contextual_failed);
    const technicalExclusions = count(row.technical_failed);
    const unknownOutcomes = count(row.unknown_outcomes);
    const incompleteAttempts = count(row.incomplete);
    const missingAttempts = count(row.missing_attempt);
    const evaluated = passed + contextualFailed;
    const firstPassDenominator = Math.max(0, eligibleSlots - technicalExclusions);
    const expectedTelemetry = count(telemetryRows[0]?.expected);
    const capturedTelemetry = count(telemetryRows[0]?.captured);
    const legacySlotCount = count(legacyRows[0]?.legacy_slots);
    const legacyPartial = count(legacyRows[0]?.partially_reconstructable);
    const interpretation = eligibleSlots === 0 ? 'unavailable'
      : missingAttempts || incompleteAttempts || unknownOutcomes ? 'incomplete' : 'complete';
    return {
      definitionVersion: 'compliance-v3',
      firstPass: {
        eligibleSlots,
        evaluatedFirstAttempts: evaluated,
        firstPassDenominator,
        firstPassSuccesses: passed,
        contextualFailures: contextualFailed,
        technicalExclusions,
        unknownOutcomes,
        incompleteAttempts,
        missingAttempts,
        legacyUnverifiableSlots: legacySlotCount - legacyPartial,
        legacy: { fullyReconstructable: 0, partiallyReconstructable: legacyPartial, unverifiable: legacySlotCount - legacyPartial },
        rate: firstPassDenominator ? passed / firstPassDenominator : null,
        interpretation,
      },
      learningCapture: {
        expectedAttempts: expectedTelemetry,
        attemptsWithOutcomeTelemetry: capturedTelemetry,
        missingOutcomeTelemetry: Math.max(0, expectedTelemetry - capturedTelemetry),
        outcomeTelemetryCoverage: expectedTelemetry ? capturedTelemetry / expectedTelemetry : null,
        candidateEventPopulationKnown: false,
      },
    };
  }

  return { reserve, transition, listBySlot, completenessReport };
}

module.exports = { createGenerationAttemptStore, TERMINAL };
