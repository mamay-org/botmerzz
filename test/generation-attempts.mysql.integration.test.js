'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('attempt reservation is slot-ordered, replay-safe, terminally consistent, and survives worker kill on isolated MySQL', { skip: !enabled }, async (t) => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createGenerationAttemptStore } = require('../src/generation-attempts');
  const pool = createPool(loadEnv());
  const slotId = randomUUID();
  const technicalSlotId = randomUUID();
  const operation1 = `${slotId}:gen:1`;
  const operation2 = `${slotId}:gen:2`;
  try {
    await runMigrations(pool);
    const store = createGenerationAttemptStore(pool);
    const before = await store.completenessReport();
    assert.equal(before.definitionVersion, 'compliance-v3');
    assert.equal(before.firstPass.firstPassDenominator, before.firstPass.eligibleSlots - before.firstPass.technicalExclusions);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,claimed_at) VALUES (?,UTC_TIMESTAMP(3),'generating',UTC_TIMESTAMP(3))", [slotId]);
    await pool.execute('INSERT INTO generation_slot_claims (slot_id,claimed_at) VALUES (?,UTC_TIMESTAMP(3))', [slotId]);
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,claimed_at) VALUES (?,UTC_TIMESTAMP(3),'generating',UTC_TIMESTAMP(3))", [technicalSlotId]);
    await pool.execute('INSERT INTO generation_slot_claims (slot_id,claimed_at) VALUES (?,UTC_TIMESTAMP(3))', [technicalSlotId]);
    await assert.rejects(pool.execute('DELETE FROM slots WHERE id=?', [slotId]), { code: 'ER_ROW_IS_REFERENCED_2' });
    const [[retainedClaim]] = await pool.execute('SELECT COUNT(*) AS count FROM generation_slot_claims WHERE slot_id=?', [slotId]);
    assert.equal(Number(retainedClaim.count), 1, 'a failed attempt reservation must not erase its eligible-slot denominator');
    const concurrent = await Promise.all([
      store.reserve({ slotId, operationId: operation1, modelId: 'test/model', configVersion: '9', learningCaptureExpected: true }),
      store.reserve({ slotId, operationId: operation1, modelId: 'test/model', configVersion: '9', learningCaptureExpected: true }),
    ]);
    assert.equal(concurrent[0].attempt_id, concurrent[1].attempt_id);
    assert.equal(Number(concurrent[0].ordinal), 1);
    const second = await store.reserve({ slotId, operationId: operation2, learningCaptureExpected: true });
    assert.equal(Number(second.ordinal), 2);
    const technicalAttempt = await store.reserve({ slotId: technicalSlotId, operationId: `${technicalSlotId}:gen:1` });
    await store.transition(technicalAttempt.attempt_id, 'generating');
    await store.transition(technicalAttempt.attempt_id, 'technical_failed', { deterministic: 'TECHNICAL_FAILED' });

    await store.transition(concurrent[0].attempt_id, 'generating');
    await store.transition(concurrent[0].attempt_id, 'validating', { deterministic: 'IN_PROGRESS' });
    await store.transition(concurrent[0].attempt_id, 'validating', { deterministic: 'PASSED', semantic: 'IN_PROGRESS' });
    await store.transition(concurrent[0].attempt_id, 'passed', { deterministic: 'PASSED', semantic: 'PASSED' });
    await assert.rejects(store.transition(concurrent[0].attempt_id, 'unknown', { deterministic: 'PASSED', semantic: 'UNKNOWN' }), { code: 'ATTEMPT_TERMINAL_CONFLICT' });

    const { createOutcomeStore } = require('../src/validation-outcomes');
    await createOutcomeStore(pool).record({
      attemptId: concurrent[0].attempt_id, slotId, runId: operation1, validationRunId: randomUUID(), ordinalInRun: 1,
      outcome: 'PASSED', deterministic: 'PASSED', semantic: 'PASSED', failureCodes: [],
      modelId: 'test/model', configVersion: '9', guidelinesVersion: null,
      generatedAt: new Date().toISOString(), evaluatedAt: new Date().toISOString(),
    });

    // Simulate commit acknowledgment loss: the real MySQL commit completes, then
    // the client wrapper throws. The store must query the authoritative row.
    const lostAckPool = Object.create(pool);
    lostAckPool.getConnection = async () => {
      const connection = await pool.getConnection();
      return new Proxy(connection, { get(target, key) {
        if (key === 'commit') return async () => { await target.commit(); throw Object.assign(new Error('simulated lost acknowledgment'), { code: 'ECONNRESET' }); };
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      } });
    };
    const lostAckStore = createGenerationAttemptStore(lostAckPool);
    const operation3 = `${slotId}:gen:3`;
    const afterLostAck = await lostAckStore.reserve({ slotId, operationId: operation3 });
    assert.equal(Number(afterLostAck.ordinal), 3);
    assert.equal((await store.reserve({ slotId, operationId: operation3 })).attempt_id, afterLostAck.attempt_id);

    // Kill a real Node worker after its reservation has committed, then observe
    // the durable incomplete row from the parent process.
    const childScript = `
      const { createPool } = require('./src/db');
      const { loadEnv } = require('./src/config');
      const { createGenerationAttemptStore } = require('./src/generation-attempts');
      const pool = createPool(loadEnv());
      createGenerationAttemptStore(pool).reserve({slotId:${JSON.stringify(slotId)},operationId:${JSON.stringify(`${slotId}:gen:4`)}})
        .then((row) => { process.stdout.write(JSON.stringify(row)+'\\n'); setInterval(()=>{},1000); })
        .catch((error) => { process.stderr.write(error.code||error.message); process.exit(2); });
    `;
    const child = spawn(process.execPath, ['-e', childScript], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const childRow = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`worker reservation timeout: ${stderr}`)), 10000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const line = stdout.split('\n')[0];
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => { if (code && !stdout) { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${stderr}`)); } });
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const recovered = await store.reserve({ slotId, operationId: `${slotId}:gen:4` });
    assert.equal(recovered.attempt_id, childRow.attempt_id);
    await store.transition(recovered.attempt_id, 'unknown', { failureCodes: ['WORKER_INTERRUPTED'] });
    const rows = await store.listBySlot(slotId);
    assert.deepEqual(rows.map((row) => Number(row.ordinal)), [1, 2, 3, 4]);
    assert.equal(rows[3].state, 'unknown');
    const after = await store.completenessReport();
    assert.equal(after.definitionVersion, 'compliance-v3');
    assert.equal(after.firstPass.firstPassDenominator, after.firstPass.eligibleSlots - after.firstPass.technicalExclusions);
    assert.equal(after.firstPass.rate, after.firstPass.firstPassDenominator ? after.firstPass.firstPassSuccesses / after.firstPass.firstPassDenominator : null);
    assert.equal(after.firstPass.evaluatedFirstAttempts, after.firstPass.firstPassSuccesses + after.firstPass.contextualFailures);
    assert.equal(after.firstPass.evaluatedFirstAttempts, before.firstPass.evaluatedFirstAttempts + 1);
    assert.equal(after.firstPass.eligibleSlots, before.firstPass.eligibleSlots + 2);
    assert.equal(after.firstPass.firstPassSuccesses, before.firstPass.firstPassSuccesses + 1);
    assert.equal(after.firstPass.technicalExclusions, before.firstPass.technicalExclusions + 1);
    assert.equal(after.firstPass.firstPassDenominator, before.firstPass.firstPassDenominator + 1);
    assert.equal(after.learningCapture.expectedAttempts, before.learningCapture.expectedAttempts + 2);
    assert.equal(after.learningCapture.attemptsWithOutcomeTelemetry, before.learningCapture.attemptsWithOutcomeTelemetry + 1);
    assert.equal(after.learningCapture.missingOutcomeTelemetry, before.learningCapture.missingOutcomeTelemetry + 1);
    assert.equal(after.learningCapture.candidateEventPopulationKnown, false);

    const legacyReadyId = randomUUID();
    await pool.execute(
      "INSERT INTO slots (id,scheduled_at,status,claimed_at,created_at) SELECT ?,UTC_TIMESTAMP(3),'ready',UTC_TIMESTAMP(3),DATE_SUB(applied_at,INTERVAL 1 SECOND) FROM schema_migrations WHERE version='014_generation_attempts.sql'",
      [legacyReadyId],
    );
    const withLegacyReady = await store.completenessReport();
    assert.equal(withLegacyReady.firstPass.eligibleSlots, after.firstPass.eligibleSlots);
    assert.equal(withLegacyReady.firstPass.legacyUnverifiableSlots, after.firstPass.legacyUnverifiableSlots + 1);
    await pool.execute('DELETE FROM slots WHERE id=?', [legacyReadyId]);
  } finally {
    await pool.execute('DELETE FROM validation_outcome_observations WHERE slot_id=?', [slotId]);
    await pool.execute('DELETE FROM generation_attempts WHERE slot_id=?', [slotId]);
    await pool.execute('DELETE FROM generation_attempts WHERE slot_id=?', [technicalSlotId]);
    await pool.execute('DELETE FROM generation_slot_claims WHERE slot_id=?', [slotId]);
    await pool.execute('DELETE FROM generation_slot_claims WHERE slot_id=?', [technicalSlotId]);
    await pool.execute('DELETE FROM slots WHERE id=?', [slotId]);
    await pool.execute('DELETE FROM slots WHERE id=?', [technicalSlotId]);
    await pool.end();
  }
});
