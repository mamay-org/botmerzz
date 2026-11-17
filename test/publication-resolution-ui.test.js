'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const slotId = '5fe16cbd-0249-4bb3-9b67-b5ae1b1e0d30';
const otherId = 'feb84129-436f-4ccb-8976-dd3c613ff967';
const xss = '<img src=x onerror=alert(1)>';
const unknown = {
  id: slotId, caption: xss, status: 'unknown', providerStatus: 'unknown', providerPostId: null,
  profileId: 'original-profile', accountId: 'original-account', errorCode: 'network_error',
  scheduledAt: '2026-11-15T09:01:00.000Z', publishStartedAt: '2026-11-15T09:01:58.000Z', completedAt: null,
};

function fakeNode(tagName = 'div') {
  const attributes = {};
  const listeners = {};
  return {
    tagName, attributes, listeners, textContent: '', children: [], value: '', checked: false, hidden: false,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, listener) { listeners[name] = listener; },
    setAttribute(name, value) { attributes[name] = value; },
    focus() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    set innerHTML(_) { assert.fail('Publication data must be rendered as text'); },
  };
}

function harness() {
  const start = app.indexOf('  const publicationActions =');
  assert.notEqual(start, -1, 'publication resolution controls are missing');
  const end = app.indexOf('  function modelReasonText(', start);
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeNode());
    return nodes.get(selector);
  };
  const form = node('#publication-resolution-form');
  form.elements = Object.fromEntries(['providerPostId', 'reason', 'evidenceSummary', 'confirmed'].map((name) => [name, fakeNode('input')]));
  form.reset = () => Object.values(form.elements).forEach((input) => { input.value = ''; input.checked = false; });
  const searchForm = node('#publication-closed-search-form');
  searchForm.elements = { slotId: fakeNode('input') };
  const requests = [];
  const refreshes = [];
  const state = { csrf: 'csrf', integrationLoad: 1 };
  let uuid = 0;
  const context = {
    state, $: node, document: { createElement: fakeNode }, statusLabels: { unknown: 'Belum diketahui', publishing: 'Sedang diterbitkan' },
    crypto: { randomUUID: () => 'f3b4cc86-b48e-4e70-9656-10000000000' + (++uuid) },
    api: async (url, options = {}) => {
      requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
      if (context.respond) return context.respond(url, options);
      return { resolution: { requestId: requests.at(-1).body?.requestId, slotId } };
    },
    withPending: async (_button, run) => run(),
    loadIntegrations: async () => { refreshes.push('integrations'); return true; },
    refresh: async () => { refreshes.push('dashboard'); return true; },
    errorText: () => 'Permintaan gagal.',
  };
  vm.createContext(context);
  vm.runInContext(app.slice(start, end) + '\nthis.renderPublicationResolution = renderPublicationResolution; this.renderProviderHolds = renderProviderHolds;', context);
  const render = (slots, events = [], closedSlots = []) => context.renderPublicationResolution({ slots, closedSlots, events });
  const submit = () => form.listeners.submit({ preventDefault() {}, currentTarget: form });
  return { context, node, form, searchForm, render, submit, requests, refreshes };
}

function descendants(el) { return [el, ...el.children.flatMap(descendants)]; }
function button(card, label) { return descendants(card).find((el) => el.tagName === 'button' && label.test(el.textContent)); }
function validEvidence(form) {
  form.elements.reason.value = 'Pemeriksaan slot selesai';
  form.elements.evidenceSummary.value = 'Riwayat Tebar dan akun Threads asal diperiksa pada waktu percobaan.';
  form.elements.confirmed.checked = true;
}

test('lists all blockers, renders caption and evidence as text, and offers actions only for eligible rows', () => {
  const { node, render } = harness();
  render([unknown, { ...unknown, id: otherId, status: 'publishing' }, { ...unknown, id: 'linked', providerPostId: 'post-1' },
    { ...unknown, id: 'missing-target', profileId: null, resolutionEligible: true, resolutionTargetValid: false }], [{
    slotId, action: 'close_unverified', actorEmail: 'admin@example.test', previousStatus: 'unknown', newStatus: 'admin_closed_unknown',
    reason: 'Pemeriksaan selesai', evidenceSummary: xss, createdAt: unknown.publishStartedAt,
  }]);
  const cards = node('#publication-blockers').children;
  assert.equal(cards.length, 4);
  const fields = descendants(cards[0]).map((el) => el.textContent);
  assert.ok(fields.includes(xss));
  assert.ok(fields.includes('original-profile'));
  assert.ok(fields.includes('original-account'));
  assert.ok(fields.includes('network_error'));
  assert.ok(fields.some((value) => /17[.:]01[.:]58/.test(value) && /GMT\+8/.test(value)));
  assert.ok(button(cards[0], /Close as Unverified/));
  assert.ok(button(cards[0], /Kaitkan/));
  assert.ok(!button(cards[1], /Close as Unverified|Kaitkan/));
  assert.ok(!button(cards[2], /Close as Unverified|Kaitkan/));
  assert.ok(button(cards[3], /Close as Unverified/));
  assert.equal(button(cards[3], /Kaitkan/), undefined);
  assert.ok(descendants(cards[3]).some((el) => /target asal.*tidak cocok|target asal.*belum lengkap/i.test(el.textContent)));
  assert.ok(descendants(node('#publication-resolution-history')).some((el) => el.textContent.includes(xss)));
});

test('legacy unknown slots can be closed with evidence but cannot link a post without a verified original target', () => {
  const { node, render } = harness();
  const legacy = { ...unknown, profileId: null, accountId: null, resolutionEligible: true, resolutionTargetValid: false };
  render([legacy]);
  const card = node('#publication-blockers').children[0];
  assert.ok(button(card, /Close as Unverified/));
  assert.equal(button(card, /Kaitkan/), undefined);
  assert.ok(descendants(card).some(el => /target asal.*belum lengkap/i.test(el.textContent)));
});

test('close requires reason, evidence and delayed publication acknowledgement', async () => {
  const { node, form, render, submit, requests, refreshes } = harness();
  render([unknown]);
  button(node('#publication-blockers').children[0], /Close as Unverified/).listeners.click();
  assert.match(node('#publication-resolution-guidance').textContent, /masih mungkin.*muncul/i);
  assert.match(node('#publication-resolution-confirm-label').textContent, /terlambat/i);
  await submit();
  assert.equal(requests.length, 0);
  validEvidence(form);
  form.elements.confirmed.checked = false;
  await submit();
  assert.equal(requests.length, 0);
  form.elements.confirmed.checked = true;
  await submit();
  assert.deepEqual(requests, [{
    url: `/api/publication-resolution/${slotId}/close-unverified`, method: 'POST',
    body: { requestId: 'f3b4cc86-b48e-4e70-9656-100000000001', reason: 'Pemeriksaan slot selesai',
      evidenceSummary: 'Riwayat Tebar dan akun Threads asal diperiksa pada waktu percobaan.', confirmDelayedPublication: true },
  }]);
  assert.deepEqual(refreshes, ['integrations', 'dashboard']);
  assert.match(node('#publication-resolution-result').textContent, /ditutup tanpa verifikasi/i);
});

test('link requires the verified original target and retries a lost response with the same request ID', async () => {
  const { context, node, form, render, submit, requests, refreshes } = harness();
  render([unknown]);
  button(node('#publication-blockers').children[0], /Kaitkan/).listeners.click();
  assert.match(node('#publication-resolution-guidance').textContent, /profile dan akun Threads asal/i);
  validEvidence(form);
  await submit();
  assert.equal(requests.length, 0);
  form.elements.providerPostId.value = 'provider-post-1';
  context.respond = () => { throw new TypeError('fetch failed'); };
  await submit();
  assert.equal(node('#publication-resolution-dialog').open, true);
  assert.match(node('#publication-resolution-error').textContent, /belum dapat dipastikan/i);
  assert.deepEqual(refreshes, []);
  context.respond = () => ({}); // A truncated JSON body can look like an empty success.
  await submit();
  assert.equal(node('#publication-resolution-dialog').open, true);
  context.respond = null;
  await submit();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(requests[0].url, `/api/publication-resolution/${slotId}/link-provider-post`);
  assert.equal(requests[0].body.providerPostId, 'provider-post-1');
  assert.equal(requests[0].body.confirmOriginalTarget, true);
});

test('closed slots show a separate late-publication follow-up and link without replay', async () => {
  const { context, node, form, render, submit, requests, refreshes } = harness();
  const closed = { ...unknown, status: 'admin_closed_unknown', lateLinkEligible: true };
  const ineligible = { ...closed, id: otherId, lateLinkEligible: false };
  render([], [], [closed, ineligible]);
  const cards = node('#publication-closed-blockers').children;
  assert.equal(cards.length, 2);
  assert.equal(node('#publication-blockers').children.length, 0);
  assert.ok(button(cards[0], /tanpa mengirim ulang/i));
  assert.equal(button(cards[1], /Kaitkan/), undefined);
  assert.match(node('#publication-closed-blocker-count').textContent, /telah ditutup/);
  button(cards[0], /tanpa mengirim ulang/i).listeners.click();
  assert.match(node('#publication-resolution-guidance').textContent, /hanya melakukan pemeriksaan GET/i);
  assert.match(node('#publication-resolution-guidance').textContent, /tidak menerbitkan ulang/i);
  validEvidence(form);
  form.elements.providerPostId.value = 'late-post-1';
  await submit();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/publication-resolution/${slotId}/link-provider-post`);
  assert.deepEqual(requests[0].body, {
    requestId: 'f3b4cc86-b48e-4e70-9656-100000000001', reason: 'Pemeriksaan slot selesai',
    evidenceSummary: 'Riwayat Tebar dan akun Threads asal diperiksa pada waktu percobaan.',
    providerPostId: 'late-post-1', confirmOriginalTarget: true,
  });
  assert.deepEqual(refreshes, ['integrations', 'dashboard']);
  assert.match(node('#publication-resolution-result').textContent, /tanpa mengirim ulang/i);
  assert.doesNotMatch(node('#publication-resolution-result').textContent, /menerbitkan ulang/);
  assert.equal(context.state.publicationResolution, null);
});

test('linked unknown rows can retry read-only reconciliation until Tebar confirms a status', async () => {
  const { context, node, render, requests } = harness();
  const linked = { ...unknown, providerPostId: 'post-1' };
  render([linked]);
  let attempts = 0;
  context.respond = (url, options = {}) => {
    if (url.endsWith('/reconcile')) {
      assert.equal(options.method, 'POST');
      attempts++;
      return { reconciliation: attempts === 1 ? { status: 'unknown', pending: true } : { status: 'published', pending: false } };
    }
    return { slots: attempts === 1 ? [linked] : [], closedSlots: [], events: [] };
  };
  const card = () => node('#publication-blockers').children[0];
  assert.ok(button(card(), /Periksa ulang status Tebar/));
  assert.match(descendants(card()).map((el) => el.textContent).join(' '), /profile original-profile.*akun Threads asal original-account/i);
  await button(card(), /Periksa ulang status Tebar/).listeners.click();
  assert.match(node('#publication-resolution-result').textContent, /belum memastikan status/i);
  assert.ok(button(card(), /Periksa ulang status Tebar/), 'inconclusive status keeps retry available');
  await button(card(), /Periksa ulang status Tebar/).listeners.click();
  assert.equal(node('#publication-blockers').children.length, 0);
  assert.match(node('#publication-resolution-result').textContent, /Status slot: published/);
  assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
    [`/api/publication-resolution/${slotId}/reconcile`, 'POST'],
    ['/api/publication-resolution/slots', 'GET'],
    [`/api/publication-resolution/${slotId}/reconcile`, 'POST'],
    ['/api/publication-resolution/slots', 'GET'],
  ]);
  assert.ok(requests.filter(({ method }) => method === 'POST').every(({ body }) => body === undefined));
});

test('closed-slot exact search shows found and empty states and restores the recent list', async () => {
  const { context, node, searchForm, requests } = harness();
  const closed = { ...unknown, status: 'admin_closed_unknown', lateLinkEligible: true };
  context.respond = url => ({ slots: [], closedSlots: url.includes('slotId=') && url.includes(otherId) ? [] : [closed], events: [] });
  const submit = async () => searchForm.listeners.submit({ preventDefault() {}, currentTarget: searchForm, submitter: fakeNode('button') });
  searchForm.elements.slotId.value = 'invalid';
  await submit();
  assert.equal(requests.length, 0);
  assert.match(node('#publication-closed-search-error').textContent, /format UUID/);
  searchForm.elements.slotId.value = slotId;
  await submit();
  assert.equal(requests[0].url, `/api/publication-resolution/slots?slotId=${slotId}`);
  assert.equal(node('#publication-closed-blockers').children.length, 1);
  assert.match(node('#publication-closed-blocker-count').textContent, /Slot ID .* ditemukan/);
  searchForm.elements.slotId.value = otherId;
  await submit();
  assert.equal(node('#publication-closed-blockers').children.length, 0);
  assert.match(node('#publication-closed-blocker-count').textContent, /tidak ditemukan/);
  await node('#publication-closed-search-reset').listeners.click();
  assert.equal(searchForm.elements.slotId.value, '');
  assert.equal(requests.at(-1).url, '/api/publication-resolution/slots');
  assert.equal(node('#publication-closed-blockers').children.length, 1);
});

test('provider holds identify the affected scope and the relevant verification control', () => {
  const { context, node } = harness();
  context.renderProviderHolds([
    { provider: 'openrouter', scope: 'global', reasonCode: 'ai_unauthorized' },
    { provider: 'tebar', scope: 'account', reasonCode: 'permission_missing', profileId: 'profile', accountId: 'active-account' },
    { provider: 'tebar', scope: 'account', reasonCode: 'account_expired', profileId: 'old-profile', accountId: 'old-account' },
  ], { profileId: 'profile', accountId: 'active-account' });
  const summary = descendants(node('#integration-provider-holds')).map((el) => el.textContent).join(' ');
  assert.match(summary, /OpenRouter.*Verifikasi Model/);
  assert.match(summary, /Tebar.*active-account.*Periksa akun aktif/);
  assert.match(summary, /permission_missing/);
  const inactive = node('#integration-provider-holds').children.find((el) => el.textContent.includes('old-account'));
  assert.match(inactive.textContent, /sebelum menggunakannya/);
  assert.doesNotMatch(inactive.textContent, /Periksa akun aktif/);
});

test('resolution dialog has an accessible name, warning and mandatory confirmation', () => {
  assert.match(html, /<dialog id="publication-resolution-dialog"[^>]*aria-labelledby="publication-resolution-title"[^>]*aria-describedby="publication-resolution-guidance"/);
  assert.match(html, /<label class="check-row"[^>]*><input name="confirmed" type="checkbox" required><span id="publication-resolution-confirm-label"/);
});
