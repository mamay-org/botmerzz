'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
function sourceBetween(start, end) {
  const startIndex = app.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker ${start}`);
  const endIndex = app.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing source marker ${end}`);
  return app.slice(startIndex, endIndex);
}

function fakeNode() {
  const attributes = {};
  const listeners = {};
  const classes = new Set();
  return {
    attributes, listeners, children: [], dataset: {}, hidden: false, disabled: false,
    className: '', textContent: '',
    classList: { add: (...values) => values.forEach((value) => classes.add(value)), contains: (value) => classes.has(value) },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    addEventListener(name, handler) { listeners[name] = handler; },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    focus() {}, scrollIntoView() {},
  };
}

function onboardingHarness() {
  const nodes = new Map();
  const context = {
    state: { onboardingComplete: null, onboardingExpanded: false },
    onboardingLabels: {},
    onboardingTargets: {},
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, fakeNode());
      return nodes.get(selector);
    },
    document: { createElement: () => fakeNode() },
    activateTab() {}, loadTabData() {},
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('  function setOnboardingLoadState(', '  function renderPosts(') + '\nthis.renderOnboarding = renderOnboarding; this.setOnboardingLoadState = setOnboardingLoadState;', context);
  return { context, nodes };
}

function onboardingItems(requiredCompleteKeys, optionalCompleteKeys = []) {
  const requiredKeys = ['brand', 'links', 'hashtags', 'thread', 'ai'];
  const optionalKeys = ['games', 'guardrails', 'facts'];
  return [
    ...requiredKeys.map((key) => ({ key, required: true, complete: requiredCompleteKeys.includes(key) })),
    ...optionalKeys.map((key) => ({ key, required: false, complete: optionalCompleteKeys.includes(key) })),
  ];
}

test('onboarding prioritizes incomplete required settings and does not count optional items', () => {
  const { context, nodes } = onboardingHarness();
  context.renderOnboarding(onboardingItems(['hashtags', 'thread', 'ai']));
  assert.equal(nodes.get('#onboarding-count').textContent, '2 wajib tersisa');
  assert.equal(nodes.get('#onboarding-incomplete').hidden, false);
  assert.equal(nodes.get('#onboarding-summary').hidden, true);
  assert.equal(nodes.get('#onboarding-details').hidden, false);
  assert.match(nodes.get('#onboarding-progress').textContent, /3 dari 5 konfigurasi wajib selesai/);
  assert.deepEqual(nodes.get('#onboarding-list').children.slice(0, 2).map((item) => item.children[0].textContent), ['brand', 'links']);
  assert.ok(nodes.get('#onboarding-list').children.some((item) => item.children[1].textContent === 'Opsional · Perlu diisi'));
});

test('complete required configuration becomes a compact success summary with collapsed details', () => {
  const { context, nodes } = onboardingHarness();
  context.onboardingLabels = { ...context.onboardingLabels, brand: 'Brand siap' };
  context.renderOnboarding(onboardingItems(['brand', 'links', 'hashtags', 'thread', 'ai']));
  assert.equal(nodes.get('#onboarding-count').textContent, 'Wajib lengkap');
  assert.equal(nodes.get('#onboarding-summary').hidden, false);
  assert.equal(nodes.get('#onboarding-details').hidden, true);
  assert.equal(nodes.get('#onboarding-details-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(nodes.get('#onboarding-details-toggle').hidden, false);
  assert.match(nodes.get('#onboarding-progress').textContent, /5 dari 5/);
  assert.match(nodes.get('#onboarding-announcement').textContent, /Konfigurasi wajib lengkap/);
  assert.equal(nodes.get('#onboarding-incomplete').hidden, true);
});

test('onboarding returns to its incomplete checklist when a required value becomes invalid', () => {
  const { context, nodes } = onboardingHarness();
  context.renderOnboarding(onboardingItems(['brand', 'links', 'hashtags', 'thread', 'ai']));
  assert.equal(nodes.get('#onboarding-summary').hidden, false);
  context.renderOnboarding(onboardingItems(['brand', 'links', 'hashtags', 'thread']));
  assert.equal(nodes.get('#onboarding-summary').hidden, true);
  assert.equal(nodes.get('#onboarding-incomplete').hidden, false);
  assert.equal(nodes.get('#onboarding-details').hidden, false);
  assert.equal(nodes.get('#onboarding-count').textContent, '1 wajib tersisa');
  assert.match(nodes.get('#onboarding-announcement').textContent, /kembali belum lengkap/);
});

test('missing onboarding payload fails closed instead of presenting success', () => {
  const { context, nodes } = onboardingHarness();
  context.renderOnboarding([]);
  assert.equal(nodes.get('#onboarding-error').hidden, false);
  assert.equal(nodes.get('#onboarding-summary').hidden, true);
  assert.equal(nodes.get('#onboarding-count').textContent, 'Status tidak tersedia');
});

test('retry failure remains in the onboarding alert without a duplicate global announcement', () => {
  const handler = sourceBetween("  $('#onboarding-retry').addEventListener('click'", "  $('.sidebar-nav').addEventListener('keydown'");
  assert.match(handler, /catch\(\(\)\s*=>\s*false\)/);
  assert.doesNotMatch(handler, /#global-error|notify\(/);
});

test('dashboard refresh ignores stale responses and exposes an error state on failure', async () => {
  const statuses = [];
  const rendered = [];
  const requests = [];
  const context = {
    state: { dashboardLoad: 0 },
    setOnboardingLoadState: (status) => statuses.push(status),
    api: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    render: (data) => rendered.push(data),
    hide() {},
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('  async function refresh()', '  function integrationVersion()') + '\nthis.refresh = refresh;', context);
  const stale = context.refresh();
  const latest = context.refresh();
  requests[1].resolve({ generation: 'latest' });
  await latest;
  requests[0].resolve({ generation: 'stale' });
  await stale;
  assert.deepEqual(rendered, [{ generation: 'latest' }]);
  const failed = context.refresh();
  requests[2].reject(new Error('offline'));
  await assert.rejects(failed, /offline/);
  assert.equal(statuses.at(-1), 'error');
});

test('configuration history keeps account and model entries on their matching pages', () => {
  const nodes = new Map();
  const context = {
    $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, fakeNode()); return nodes.get(selector); },
    document: { createElement: () => fakeNode() },
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween('  function renderIntegrationHistory(', '  function syncIntegrationControls()') + '\nthis.renderIntegrationHistory = renderIntegrationHistory;', context);
  const history = [
    { version: 1, action: 'bootstrap', status: 'ACTIVE', profileId: 'profile-1', accountId: 'account-1', model: 'vendor/model' },
    { version: 2, action: 'account_changed', status: 'ACTIVE', profileId: 'profile-2', accountId: 'account-2', model: 'vendor/model' },
    { version: 3, action: 'model_updated', status: 'ACTIVE', profileId: 'profile-2', accountId: 'account-2', model: 'vendor/new' },
    { version: 4, action: 'switch_blocked', status: 'BLOCKED_RECONCILIATION', profileId: 'profile-3', accountId: 'account-3', model: 'vendor/new' },
  ];
  context.renderIntegrationHistory(history, 'account');
  context.renderIntegrationHistory(history, 'model');
  const accountRows = nodes.get('#integration-account-history').children;
  const modelRows = nodes.get('#integration-model-history').children;
  assert.equal(accountRows.length, 3);
  assert.equal(modelRows.length, 2);
  assert.doesNotMatch(accountRows[0].children[1].textContent, /Model/);
  assert.doesNotMatch(modelRows[0].children[1].textContent, /Profile|Akun/);
});
