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
const { searchOpenRouterModels, modelValidationStatusFromError } = require('../public/app.js');

test('integration tab exposes linked accessible controls and mobile layout', () => {
  assert.match(html, /data-tab="integrations"[^>]*aria-controls="tab-integrations"/);
  assert.match(html, /id="tab-integrations"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-button-integrations"/);
  assert.match(html, /<label>Profile ID<input name="profileId"/);
  assert.match(html, /<label>Account ID<input name="accountId"/);
  const integrations = html.slice(html.indexOf('<section id="tab-integrations"'), html.indexOf('<section id="tab-ai"'));
  const ai = html.slice(html.indexOf('<section id="tab-ai"'), html.indexOf('<section id="tab-admins"'));
  assert.doesNotMatch(integrations, /integration-model-form|integration-model-catalog|Model OpenRouter/);
  assert.match(ai, /role="combobox"/);
  assert.match(ai, /name="model"/);
  assert.match(html, /id="integration-account-error"[^>]*role="alert"/);
  assert.match(css, /\.integration-summary\{display:grid;grid-template-columns:1fr/);
});

test('account validation and identity confirmation precede versioned activation', () => {
  const handler = section("$('#integration-account-form').addEventListener", "$('#integration-model-form').addEventListener");
  assert.ok(handler.indexOf("'/api/integrations/validate-account'") < handler.indexOf('confirmAction('));
  assert.ok(handler.indexOf('confirmAction(') < handler.indexOf("'/api/integrations/account'"));
  assert.match(handler, /account\.username/);
  assert.match(handler, /expectedVersion: version, confirmed: true/);
  assert.match(handler, /withPending\(/);
  assert.match(handler, /showFormError\(form, error/);
  assert.doesNotMatch(handler, /form\.reset\(/);
});

test('model catalog failure leaves a manual input and activation follows validation', () => {
  const handler = section("$('#integration-model-form').addEventListener", "$('#integration-model-catalog').addEventListener");
  const ai = html.slice(html.indexOf('<section id="tab-ai"'), html.indexOf('<section id="tab-admins"'));
  assert.ok(handler.indexOf("'/api/integrations/validate-model'") < handler.indexOf("'/api/integrations/model'"));
  assert.match(handler, /expectedVersion/);
  assert.match(handler, /activationAttempted/);
  assert.match(handler, /handleModelSaveFailure\(form, error\)/);
  assert.doesNotMatch(handler, /form\.reset\(/);
  assert.match(app, /UNVERIFIED · katalog tidak dapat dimuat/);
  assert.match(ai, /Opsi lanjutan: masukkan Model ID manual/);
});

test('a lost model activation response is reconciled without claiming the old model remains active', async () => {
  const vm = require('node:vm');
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '' }); return nodes.get(selector); };
  let reloads = 0;
  const validation = [];
  const notices = [];
  const state = { integrations: null, modelValidation: { model: 'vendor/new', version: 2, status: 'AVAILABLE' } };
  const context = {
    state,
    $: node,
    loadIntegrations: async () => { reloads++; state.integrations = { configuration: { model: 'vendor/new' } }; return true; },
    renderModelValidation: (...args) => validation.push(args),
    updateModelVerificationFailure() { throw Error('uncertain mutation must not be reported as a validation failure'); },
    showFormError() { throw Error('uncertain mutation must not become a definitive form error'); },
    notify: (...args) => notices.push(args),
    updateOpenRouterActions() {},
  };
  vm.createContext(context);
  vm.runInContext(section('  async function handleModelSaveFailure(', '  function showIntegrationOutcome(') + '\nthis.handleModelSaveFailure = handleModelSaveFailure;', context);
  await context.handleModelSaveFailure({}, new TypeError('connection closed after PUT'));
  assert.equal(reloads, 1);
  assert.equal(validation.at(-1)[0], 'UNVERIFIED');
  assert.match(validation.at(-1)[1], /Respons penyimpanan tidak dapat dipastikan/);
  assert.match(validation.at(-1)[1], /model aktif vendor\/new/);
  assert.doesNotMatch(validation.at(-1)[1], /sebelumnya tetap aktif/i);
  assert.match(node('#integration-model-error').textContent, /vendor\/new/);
  assert.deepEqual(notices[0], ['warning', validation.at(-1)[1]]);
  state.integrations = { configuration: { model: 'stale/old' } };
  context.loadIntegrations = async () => { reloads++; return false; };
  await context.handleModelSaveFailure({}, new TypeError('connection closed after PUT'));
  assert.match(validation.at(-1)[1], /status model aktif belum dapat dimuat/i);
  assert.doesNotMatch(validation.at(-1)[1], /stale\/old/);
});

test('OpenRouter selection exposes an accessible searchable listbox and explicit verification states', () => {
  const ai = html.slice(html.indexOf('<section id="tab-ai"'), html.indexOf('<section id="tab-admins"'));
  assert.match(ai, /role="combobox"/);
  assert.match(ai, /aria-autocomplete="list"/);
  assert.match(ai, /aria-controls="integration-model-options"/);
  assert.match(ai, /role="listbox"/);
  assert.match(ai, /id="integration-model-verify"/);
  assert.match(ai, /Opsi lanjutan/);
  assert.match(ai, /name="model"/);
  assert.match(app, /AVAILABLE: 'Tersedia/);
  assert.match(app, /INCOMPATIBLE: 'Tidak kompatibel/);
  assert.match(app, /NOT_FOUND: 'Tidak ditemukan/);
  assert.match(app, /UNVERIFIED: 'Belum dapat diverifikasi/);
  assert.match(css, /\.model-options\{position:absolute/);
});

test('OpenRouter search matches model name, namespace, and ID without provider requests', () => {
  const models = [
    { id: 'google/gemini-flash', name: 'Gemini Flash', provider: 'google' },
    { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic' },
  ];
  assert.deepEqual(searchOpenRouterModels(models, 'gemini').map((model) => model.id), ['google/gemini-flash']);
  assert.deepEqual(searchOpenRouterModels(models, 'ANTHROPIC').map((model) => model.id), ['anthropic/claude-sonnet']);
  assert.deepEqual(searchOpenRouterModels(models, 'claude-sonnet').map((model) => model.id), ['anthropic/claude-sonnet']);
  assert.equal(searchOpenRouterModels(models, 'missing').length, 0);
  assert.equal(modelValidationStatusFromError({ code: 'MODEL_NOT_FOUND' }), 'NOT_FOUND');
  assert.equal(modelValidationStatusFromError({ code: 'MODEL_INCOMPATIBLE' }), 'INCOMPATIBLE');
  assert.equal(modelValidationStatusFromError({ code: 'OPENROUTER_UNAVAILABLE' }), 'UNVERIFIED');
});

test('rollback validates component-specific history and requires confirmation with the observed version', () => {
  const history = section('function renderIntegrationHistory(', 'function syncIntegrationControls(');
  assert.match(history, /validate-account/);
  assert.match(history, /validate-model/);
  assert.match(history, /confirmAction/);
  assert.match(history, /expectedVersion, confirmed: true, component/);
  assert.match(history, /history\.filter/);
  assert.match(history, /component === 'account'/);
  assert.doesNotMatch(history, /for\s*\(const component of \['account', 'model'\]\)/);
  assert.match(history, /\['ACTIVE', 'NOT_CONFIGURED'\]\.includes\(item\.status\)/);
  assert.match(history, /button\.disabled = !restorable/);
  assert.match(history, /\.textContent/);
  assert.doesNotMatch(history, /innerHTML/);
  assert.match(app, /CONFIG_CONFLICT:.*isian Anda tetap tersimpan/);
});

test('integration refresh rejects stale responses, clears failed state and preserves edited drafts', async () => {
  const vm = require('node:vm');
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', hidden: false, disabled: false, dataset: {}, elements: {}, replaceChildren() {} });
    return nodes.get(selector);
  };
  node('#integration-account-form').elements = { profileId: { value: '' }, accountId: { value: '' } };
  node('#integration-model-form').elements = { model: { value: '' } };
  const requests = [];
  const state = { integrations: null, integrationVerification: null };
  const context = { state, $: node, api: (path) => path === '/api/dashboard' ? Promise.resolve({ automation: { enabled: true } }) : new Promise((resolve, reject) => requests.push({ resolve, reject })), renderIntegrationHistory() {}, renderModelValidation() {}, updateOpenRouterActions() {}, hide() {} };
  vm.createContext(context);
  const source = section('  function syncIntegrationControls()', "  $('#integration-account-form').addEventListener");
  vm.runInContext(source + '\nthis.loadIntegrations = loadIntegrations;', context);
  const config = (version, accountId) => ({ configuration: { version, profileId: 'profile', accountId, model: 'vendor/model', status: 'ACTIVE' }, history: [] });
  const older = context.loadIntegrations();
  const newer = context.loadIntegrations();
  requests[1].resolve(config(2, 'new')); await newer;
  requests[0].resolve(config(1, 'old')); await older;
  assert.equal(state.integrations.configuration.accountId, 'new');
  assert.equal(node('#ai-active-model').textContent, 'vendor/model');
  node('#integration-account-form').elements.accountId.value = 'draft';
  const fail = context.loadIntegrations(); requests[2].reject(new Error('offline'));
  await assert.rejects(fail, /offline/);
  assert.equal(state.integrations, null);
  assert.equal(node('button[type="submit"]').disabled, true);
  assert.match(node('#integration-active-account').textContent, /tidak tersedia/i);
  assert.equal(node('#integration-account-form').elements.accountId.value, 'draft');
  const recovery = context.loadIntegrations();
  const recovered = config(3, 'latest'); recovered.configuration.model = 'vendor/new';
  requests[3].resolve(recovered); await recovery;
  assert.equal(node('#integration-account-form').elements.accountId.value, 'draft');
  assert.equal(node('#integration-model-form').elements.model.value, 'vendor/new');
  assert.equal(node('button[type="submit"]').disabled, false);
  assert.match(node('#integration-provider-status').textContent, /Belum diverifikasi/);
});


test('mutation completion preserves reconciliation guidance and reports unavailable reload', async () => {
  const vm = require('node:vm');
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: '' }); return nodes.get(selector); };
  let reloadFails = true;
  const context = { state: { integrations: { configuration: {} } }, $: node, show: (selector, text) => { node(selector).hidden = false; node(selector).textContent = text; }, loadIntegrations: async () => { if (reloadFails) throw Error('offline'); return true; }, refresh: async () => { throw Error('offline'); }, showIntegrationOutcome: () => { node('#global-error').hidden = false; node('#global-error').textContent = 'Rekonsiliasi diperlukan.'; } };
  vm.createContext(context);
  vm.runInContext(section('  async function finishIntegrationMutation(', '  function renderIntegrationHistory(') + '\nthis.finishIntegrationMutation = finishIntegrationMutation;', context);
  await context.finishIntegrationMutation({}, 'ok', true);
  assert.match(node('#global-error').textContent, /diterima.*status terkini/i);
  reloadFails = false;
  await context.finishIntegrationMutation({}, 'ok', true);
  assert.match(node('#global-error').textContent, /Rekonsiliasi diperlukan/);
  assert.match(node('#global-error').textContent, /dashboard/);
});

test('late account validation cannot overwrite a newer configuration', async () => {
  const vm = require('node:vm');
  const nodes = new Map();
  let handler, rejectValidation;
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', addEventListener: (_, callback) => { handler = callback; } });
    return nodes.get(selector);
  };
  const state = { integrationLoad: 1, integrations: { configuration: { profileId: 'old', accountId: 'old' } } };
  const context = { state, $: node, api: () => new Promise((_, reject) => { rejectValidation = reject; }), withPending: (_, action) => action(), show() { throw Error('obsolete error displayed'); }, integrationError: () => 'error', loadIntegrations() { throw Error('obsolete validation applied'); } };
  vm.createContext(context);
  vm.runInContext(section("  $('#integration-check-active').addEventListener", "  $('#integration-reconcile').addEventListener"), context);
  const pending = handler({ currentTarget: {} });
  state.integrationLoad = 2;
  node('#integration-provider-status').textContent = 'Status baru';
  rejectValidation(new Error('offline'));
  await pending;
  assert.equal(node('#integration-provider-status').textContent, 'Status baru');
});

test('dashboard feedback uses accessible dismissible deduplicated toasts', () => {
  const vm = require('node:vm');
  const region = { children: [], append(toast) { this.children.push(toast); } };
  const makeNode = () => ({ attributes: {}, children: [], setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(_, callback) { this.close = callback; }, append(...nodes) { this.children.push(...nodes); }, remove() { this.removed = true; } });
  const context = { $: () => region, document: { createElement: makeNode }, Date, WeakMap, Map, setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(context);
  vm.runInContext(section('  const toastTimers = new WeakMap();', '  function confirmAction(') + '\nthis.notify = notify;', context);
  context.notify('success', 'Perubahan tersimpan.');
  context.notify('success', 'Perubahan tersimpan.');
  context.notify('error', 'Server tidak tersedia.');
  assert.equal(region.children.length, 2);
  assert.equal(region.children[0].attributes.role, 'status');
  assert.equal(region.children[1].attributes.role, 'alert');
  assert.equal(region.children[0].children[1].textContent, 'Perubahan tersimpan.');
  assert.equal(region.children[0].children[2].attributes['aria-label'], 'Tutup notifikasi');
  region.children[0].children[2].close();
  assert.equal(region.children[0].removed, true);
});

test('post-save refresh failure reports partial success instead of a failed save', async () => {
  const vm = require('node:vm');
  const messages = [];
  const context = { notify: (type, message) => messages.push({ type, message }) };
  vm.createContext(context);
  vm.runInContext(section('  async function refreshAfterMutation(', '  const hide ='), context);
  await context.refreshAfterMutation(async () => { throw Error('offline'); });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'info');
  assert.match(messages[0].message, /berhasil disimpan.*tampilan belum dapat diperbarui/i);
});

test('successful integration update with stale dashboard summary uses informational feedback', () => {
  const vm = require('node:vm');
  const messages = [];
  const nodes = new Map();
  const context = { $: selector => { if (!nodes.has(selector)) nodes.set(selector, { textContent: '', hidden: true }); return nodes.get(selector); }, notify: (type, message) => messages.push({ type, message }) };
  vm.createContext(context);
  vm.runInContext(section('  const show = (selector, text) => {', '  function confirmAction(') + '\nthis.show = show;', context);
  context.show('#global-error', 'Ringkasan dashboard belum dapat diperbarui.');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'info');
  assert.match(messages[0].message, /berhasil disimpan.*ringkasan dashboard belum dapat diperbarui/i);
});
