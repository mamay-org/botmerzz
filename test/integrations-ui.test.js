'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

test('integration tab exposes linked accessible controls and mobile layout', () => {
  assert.match(html, /data-tab="integrations"[^>]*aria-controls="tab-integrations"/);
  assert.match(html, /id="tab-integrations"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-button-integrations"/);
  assert.match(html, /<label>Profile ID<input name="profileId"/);
  assert.match(html, /<label>Account ID<input name="accountId"/);
  assert.match(html, /name="model" list="integration-model-list"/);
  assert.match(html, /id="integration-account-error"[^>]*role="alert"/);
  assert.match(css, /\.integration-summary\{display:grid;grid-template-columns:1fr/);
});

test('account validation and identity confirmation precede versioned activation', () => {
  const handler = section("$('#integration-account-form').addEventListener", "$('#integration-model-form').addEventListener");
  assert.ok(handler.indexOf("'/api/integrations/validate-account'") < handler.indexOf('window.confirm('));
  assert.ok(handler.indexOf('window.confirm(') < handler.indexOf("'/api/integrations/account'"));
  assert.match(handler, /account\.username/);
  assert.match(handler, /expectedVersion: version, confirmed: true/);
  assert.match(handler, /withPending\(/);
  assert.match(handler, /showFormError\(form, error/);
  assert.doesNotMatch(handler, /form\.reset\(/);
});

test('model catalog failure leaves a manual input and activation follows validation', () => {
  const handler = section("$('#integration-model-form').addEventListener", "$('#integration-model-catalog').addEventListener");
  assert.ok(handler.indexOf("'/api/integrations/validate-model'") < handler.indexOf("'/api/integrations/model'"));
  assert.match(handler, /expectedVersion/);
  assert.doesNotMatch(handler, /form\.reset\(/);
  assert.match(app, /Daftar model tidak tersedia; masukkan model ID secara manual/);
});

test('rollback validates changed destinations and requires confirmation with the observed version', () => {
  const history = section('function renderIntegrationHistory(', 'async function loadIntegrations(');
  assert.match(history, /validate-account/);
  assert.match(history, /validate-model/);
  assert.match(history, /window\.confirm/);
  assert.match(history, /expectedVersion, confirmed: true, component/);
  assert.match(history, /\['account', 'model'\]/);
  assert.match(history, /\['ACTIVE', 'NOT_CONFIGURED'\]\.includes\(item\.status\)/);
  assert.match(history, /button\.disabled = !restorable/);
  assert.match(history, /\.textContent/);
  assert.doesNotMatch(history, /innerHTML/);
  assert.match(app, /CONFIG_CONFLICT:.*isian Anda tetap tersimpan/);
});
