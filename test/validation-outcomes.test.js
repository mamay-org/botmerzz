'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateOutcome, createOutcomeStore } = require('../src/validation-outcomes');

test('final validation requires both mandatory stages', () => {
  assert.equal(aggregateOutcome({deterministic:'PASSED',semantic:'PASSED'}),'PASSED');
  assert.equal(aggregateOutcome({deterministic:'FAILED',semantic:'NOT_RUN'}),'CONTEXTUAL_FAILED');
  assert.equal(aggregateOutcome({deterministic:'PASSED',semantic:'UNKNOWN'}),'UNKNOWN');
  assert.equal(aggregateOutcome({deterministic:'PASSED',semantic:'TECHNICAL_FAILED'}),'TECHNICAL_FAILED');
  assert.equal(aggregateOutcome({deterministic:'PASSED',semantic:'NOT_RUN'}),'INCOMPLETE');
  assert.equal(aggregateOutcome({deterministic:'UNKNOWN',semantic:'NOT_RUN'}),'UNKNOWN');
  assert.throws(() => aggregateOutcome({deterministic:'FAILED',semantic:'PASSED'}));
});

test('outcome persistence handles duplicate replay but rejects contradictory records', async () => {
  const prior = {attemptId:'a', slotId:'s', runId:'r', validationRunId:'v', ordinalInRun:1, outcome:'PASSED', deterministic:'PASSED', semantic:'PASSED', failureCodes:[], modelId:null, configVersion:null, guidelinesVersion:null, generatedAt:'2026-01-01T00:00:00.000Z', evaluatedAt:'2026-01-01T00:00:01.000Z'};
  const { outcomeFingerprint } = require('../src/validation-outcomes');
  const pool = {execute:async (sql) => sql.startsWith('INSERT') ? Promise.reject(Object.assign(new Error('duplicate'),{code:'ER_DUP_ENTRY'})) : [[{fingerprint:outcomeFingerprint(prior)}]]};
  const store = createOutcomeStore(pool);
  assert.equal((await store.record(prior)).status,'duplicate');
  await assert.rejects(store.record({...prior, outcome:'UNKNOWN', semantic:'UNKNOWN'}),{code:'OUTCOME_CONFLICT'});
});
