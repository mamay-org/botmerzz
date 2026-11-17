'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

test('learning UI exposes gated rule lifecycle, metrics, and isolated shadow evaluation controls', () => {
  for (const id of ['learning-capability-status','learning-candidate-filter','learning-candidate-dialog','learning-metrics','learning-shadow-form','learning-shadow-results']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const endpoint of [
    '/api/learning/capabilities', '/api/learning/metrics', 'activation-preview',
    '/activation`', '/deactivation`', '/revisions`', '/rollback`',
    '/api/learning/shadow-evaluations',
  ]) assert.ok(app.includes(endpoint), `UI is missing ${endpoint}`);
  assert.match(app, /learningActivationEnabled|activationEnabled/);
  assert.match(app, /shadowEnabled/);
  assert.match(app, /fetchLearningCandidates/);
  assert.match(app, /Beri rating/);
  assert.match(app, /showLearningCandidateDetails/);
});

test('learning UI explains active-rule capacity conflicts without exposing raw database details',()=>{
  assert.match(app,/batas maksimum 500 aturan aktif telah tercapai/);
  assert.match(app,/jumlah aturan aktif melebihi batas 500; pengambilan aturan dinonaktifkan/);
  assert.match(app,/error\.conflicts = Array\.isArray\(payload\.conflicts\)/);
  assert.match(app,/code === 'RULE_CONFLICT' && Array\.isArray\(error\.conflicts\)/);
});

test('Learning free-text fields disclose workspace-wide admin access and data minimization guidance',()=>{
  assert.match(html,/id="learning-text-data-guidance"[^>]*>Semua admin aktif dalam ruang kerja dapat membaca maklum balas dan teks aturan\. Jangan masukkan data peribadi, kata laluan, token akses, atau rahsia\./);
  assert.match(html,/<textarea name="explanation"[^>]*aria-describedby="learning-text-data-guidance"/);
  assert.match(app,/instruction\.setAttribute\('aria-describedby','learning-text-data-guidance'\)/);
  assert.match(app,/reason\.setAttribute\('aria-describedby','learning-text-data-guidance'\)/);
  assert.match(app,/explanation\.setAttribute\('aria-describedby','learning-text-data-guidance'\)/);
  assert.equal((app.match(/instruction\.setAttribute\('aria-describedby','learning-text-data-guidance'\)/gu)||[]).length,2);
  assert.equal((app.match(/reason\.setAttribute\('aria-describedby','learning-text-data-guidance'\)/gu)||[]).length,2);
  assert.equal((app.match(/instruction\.maxLength\s*=\s*500/gu)||[]).length,2);
  assert.equal((app.match(/reason\.maxLength\s*=\s*300/gu)||[]).length,2);
});

test('learning metric and shadow output rendering uses text nodes for untrusted content', () => {
  const section = app.slice(app.indexOf('  function learningNode('), app.indexOf("  $('#refresh-button')"));
  assert.match(section, /element\.textContent\s*=/);
  assert.doesNotMatch(section, /innerHTML|insertAdjacentHTML/);
});

test('compliance-v3 incomplete rates are visibly provisional and small samples remain unavailable', () => {
  assert.match(app,/function complianceSummary\(compliance\)/);
  assert.match(app,/Sementara ·/);
  assert.match(app,/complianceSummary\(compliance\)/);
  assert.match(app,/compliance\.status\s*===\s*['"]complete['"]/);
  assert.match(app,/compliance\.status\s*===\s*['"]incomplete['"]/);
});
