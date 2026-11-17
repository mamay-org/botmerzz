'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { complianceSummary, qualitySummary } = require('../src/learning-metrics');

test('compliance counts one first attempt per slot and excludes unknown or technical outcomes', () => {
  const result = complianceSummary([
    {slotId:'a', attempt:1, outcome:'pass'}, {slotId:'a', attempt:2, outcome:'fail'},
    {slotId:'b', attempt:1, outcome:'fail'}, {slotId:'c', attempt:1, outcome:'unknown'},
    {slotId:'d', attempt:1, outcome:'technical'}, {slotId:'e', attempt:2, outcome:'pass'},
    {slotId:'a', attempt:1, outcome:'pass'},
  ]);
  assert.deepEqual(result, {passed:1, eligible:2, unknown:1, technical:1, missingFirst:1, conflicts:0, rate:0.5});
});

test('conflicting first-attempt observations are excluded and empty denominator stays unavailable', () => {
  const result = complianceSummary([{slotId:'a',attempt:1,outcome:'pass'}, {slotId:'a',attempt:1,outcome:'fail'}]);
  assert.equal(result.conflicts, 1); assert.equal(result.eligible, 0); assert.equal(result.rate, null);
});

test('quality coverage counts distinct reviewed eligible captions, not reviews or missing ratings', () => {
  const result = qualitySummary(['a','b','c'], [
    {captionId:'a',reviewerId:'1',ratings:{hook:5,language:3}},
    {captionId:'a',reviewerId:'2',ratings:{hook:1}},
    {captionId:'b',reviewerId:'1',ratings:{}},
    {captionId:'outside',reviewerId:'1',ratings:{hook:5}},
  ]);
  assert.equal(result.eligibleCaptions, 3); assert.equal(result.reviewedCaptions, 1);
  assert.equal(result.coverage, 1/3); assert.deepEqual(result.dimensions.hook, {sum:6,count:2,average:3});
  assert.deepEqual(result.dimensions.language, {sum:3,count:1,average:3});
  assert.equal(result.dimensions.cta.average, null);
});

test('duplicate reviewer records and invalid ratings are not silently counted', () => {
  const result = qualitySummary(['a'], [
    {captionId:'a',reviewerId:'1',ratings:{hook:5}}, {captionId:'a',reviewerId:'1',ratings:{hook:1}},
    {captionId:'a',reviewerId:'2',ratings:{hook:0,cta:4}},
  ]);
  assert.equal(result.duplicateReviews, 1); assert.equal(result.invalidRatings, 1);
  assert.equal(result.dimensions.hook.count, 0); assert.equal(result.dimensions.cta.average, 4);
});

test('versioned compliance report discloses expected population and unknown coverage', () => {
  const { firstPassReport } = require('../src/learning-metrics');
  const records = [{slotId:'a',attemptId:'a1',canonical:true,attempt:1,outcome:'pass'}, {slotId:'b',attemptId:'b1',canonical:true,attempt:1,outcome:'fail'}, {slotId:'c',attemptId:'c1',canonical:true,attempt:1,outcome:'technical'}];
  const unknown = firstPassReport(records);
  assert.equal(unknown.definitionVersion, 'compliance-v1');
  assert.equal(unknown.coverage, null);
  assert.equal(unknown.interpretation, 'provisional');
  const complete = firstPassReport(records, ['a','b','c','d']);
  assert.equal(complete.expectedFirstAttempts, 4);
  assert.equal(complete.missingCanonical, 1);
  assert.equal(complete.coverage, 0.75);
  assert.equal(complete.interpretation, 'provisional');
  assert.equal(complete.passed, 1); assert.equal(complete.contextualFailed, 1);
});

test('compliance refuses to invent an expected population and excludes conflicting evidence', () => {
  const { firstPassReport } = require('../src/learning-metrics');
  const report = firstPassReport([{slotId:'a',attemptId:'a1',canonical:true,attempt:1,outcome:'pass'}, {slotId:'a',attemptId:'a1',canonical:true,attempt:1,outcome:'fail'}], ['a']);
  assert.equal(report.conflicts,1); assert.equal(report.rate,null);
  assert.equal(report.coverage,0); assert.equal(report.interpretation,'unavailable');
});

test('distinct first-attempt identities for one slot are conflicts even with identical outcomes', () => {
  const {firstPassReport}=require('../src/learning-metrics');
  const report=firstPassReport([{slotId:'s',attemptId:'one',canonical:true,attempt:1,outcome:'pass'},{slotId:'s',attemptId:'two',canonical:true,attempt:1,outcome:'pass'}],['s']);
  assert.equal(report.conflicts,1); assert.equal(report.rate,null); assert.equal(report.interpretation,'unavailable');
});
