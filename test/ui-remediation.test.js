'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withPending, parseRetryAfterSeconds, formatLoginWait } = require('../public/app.js');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

function contains(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

test('API errors preserve server field details and use Indonesian messages', () => {
  contains(app, /error\.fields\s*=\s*payload\.fields/, 'API errors should retain backend field details');
  contains(app, /error\.retryAfterSeconds\s*=\s*parseRetryAfterSeconds\(payload\.retryAfterSeconds/, 'API errors should retain the retry duration');
  contains(app, /code === 'LOGIN_RATE_LIMITED'\) return formatLoginWait/, 'login rate-limit errors should use the retry duration');
  contains(app, /INVALID_FACT_PRICE:\s*['"][^'"]*Harga[^'"]*['"]/, 'price validation should have a Bahasa Indonesia message');
  contains(app, /function showFormError\(/, 'form errors should have a field-level presenter');
  contains(app, /aria-invalid/, 'invalid fields should expose their state');
  contains(app, /aria-describedby/, 'field errors should be associated with controls');
  contains(app, /document\.addEventListener\('input'/, 'editing an invalid field should clear its stale error');
});

test('pending guard locks every form control, preserves captured credentials, and restores state after rejection', async () => {
  let resolveAction;
  let calls = 0;
  let requestBody;
  const attributes = new Map();
  const formAttributes = new Map();
  const field = { disabled: false, _value: 'admin@example.test', get value() { return this._value; }, set value(next) { if (!this.disabled) this._value = next; } };
  const password = { disabled: false, _value: 'correct horse battery staple', get value() { return this._value; }, set value(next) { if (!this.disabled) this._value = next; } };
  const alreadyDisabled = { disabled: true };
  const form = {
    elements: [],
    dataset: {},
    getAttribute(name) { return formAttributes.get(name) ?? null; },
    setAttribute(name, value) { formAttributes.set(name, value); },
    removeAttribute(name) { formAttributes.delete(name); },
  };
  const control = {
    dataset: {},
    disabled: false,
    textContent: 'Simpan',
    closest() { return form; },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
  };
  form.elements = [control, field, password, alreadyDisabled];
  const capturedPayload = { email: field.value, password: password.value };
  const first = withPending(control, () => {
    calls += 1;
    requestBody = capturedPayload;
    return new Promise((resolve, reject) => { resolveAction = { resolve, reject }; });
  }, 'Menyimpan…');
  assert.equal(control.disabled, true);
  assert.equal(field.disabled, true);
  assert.equal(password.disabled, true);
  assert.equal(alreadyDisabled.disabled, true);
  field.value = 'changed@example.test';
  password.value = 'changed password';
  assert.equal(field.value, 'admin@example.test');
  assert.equal(password.value, 'correct horse battery staple');
  assert.deepEqual(requestBody, { email: 'admin@example.test', password: 'correct horse battery staple' });
  assert.equal(control.textContent, 'Menyimpan…');
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(await withPending(control, async () => { calls += 1; }, 'Menyimpan…'), false);
  assert.equal(calls, 1);
  resolveAction.reject(new Error('request failed'));
  await assert.rejects(first, /request failed/);
  assert.equal(control.disabled, false);
  assert.equal(field.disabled, false);
  assert.equal(password.disabled, false);
  assert.equal(alreadyDisabled.disabled, true);
  assert.equal(control.textContent, 'Simpan');
  assert.equal(form.getAttribute('aria-busy'), null);
  field.value = 'updated@example.test';
  assert.equal(field.value, 'updated@example.test');
});

test('pending guard restores editable controls after a successful request', async () => {
  const form = { dataset: {}, elements: [], getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  const field = { disabled: false };
  const control = {
    dataset: {}, disabled: false, textContent: 'Simpan',
    closest: () => form, setAttribute() {}, removeAttribute() {},
  };
  form.elements = [control, field];
  let finish;
  const pending = withPending(control, () => new Promise((resolve) => { finish = resolve; }), 'Memproses…');
  assert.equal(field.disabled, true);
  finish('ok');
  assert.equal(await pending, 'ok');
  assert.equal(field.disabled, false);
  assert.equal(control.disabled, false);
});

test('login and admin-create request values are captured before form controls are locked', () => {
  const loginStart = app.indexOf("$('#login-form').addEventListener");
  const logoutStart = app.indexOf("$('#logout-button').addEventListener", loginStart);
  const loginHandler = app.slice(loginStart, logoutStart);
  assert.ok(loginHandler.indexOf('const loginPayload') >= 0);
  assert.ok(loginHandler.indexOf('const loginPayload') < loginHandler.indexOf('withPending('));
  assert.match(loginHandler, /JSON\.stringify\(loginPayload\)/);

  const adminStart = app.indexOf("$('#admin-create-form').addEventListener");
  const adminEnd = app.indexOf("$('#admin-list').addEventListener", adminStart);
  const adminHandler = app.slice(adminStart, adminEnd);
  assert.ok(adminHandler.indexOf('const adminPayload') >= 0);
  assert.ok(adminHandler.indexOf('const adminPayload') < adminHandler.indexOf('withPending('));
  assert.match(adminHandler, /JSON\.stringify\(adminPayload\)/);
});

test('login rate-limit feedback uses only a positive numeric retry duration', () => {
  assert.equal(parseRetryAfterSeconds(42, null), 42);
  assert.equal(parseRetryAfterSeconds('42', null), 42);
  assert.equal(parseRetryAfterSeconds(undefined, '75'), 75);
  assert.equal(parseRetryAfterSeconds(0, '75'), 75);
  assert.equal(parseRetryAfterSeconds(-1, null), null);
  assert.equal(parseRetryAfterSeconds('tomorrow', null), null);
  assert.equal(formatLoginWait(1), 'Terlalu banyak percobaan masuk. Coba lagi dalam 1 detik.');
  assert.equal(formatLoginWait(61), 'Terlalu banyak percobaan masuk. Coba lagi dalam 1 menit 1 detik.');
  assert.equal(formatLoginWait(null), 'Terlalu banyak percobaan masuk. Tunggu beberapa saat lalu coba lagi.');
});

test('all mutating form and automation handlers call the pending guard', () => {
  contains(app, /async function withPending\(/, 'pending guard must be implemented once');
  contains(app, /dataset\.pending/, 'pending requests should be tracked per form/control');
  contains(app, /aria-busy/, 'pending state should be announced to assistive technology');
  assert.ok((app.match(/withPending\(/g) || []).length >= 9);
});

test('mobile navigation exposes all destinations and active panel semantics', () => {
  for (const tab of ['dashboard', 'content', 'templates', 'schedule', 'facts', 'activity', 'ai', 'integrations', 'admins']) {
    contains(html, new RegExp(`data-tab="${tab}"[^>]*aria-controls="tab-${tab}"`), tab + ' tab should control its panel');
    contains(html, new RegExp(`id="tab-${tab}"[^>]*aria-labelledby="tab-button-${tab}"`), tab + ' panel should reference its tab');
  }
  contains(html, /<nav class="sidebar-nav" role="tablist" aria-orientation="vertical"/, 'all dashboard destinations should live in the sidebar tablist');
  contains(html, /id="sidebar-toggle"[^>]*aria-controls="dashboard-sidebar"[^>]*aria-expanded="false"/, 'mobile drawer should have an accessible toggle');
  contains(html, /id="sidebar-backdrop"[^>]*aria-label="Tutup navigasi"/, 'mobile drawer should expose a close backdrop');
  assert.doesNotMatch(html, /<nav class="tabs"/, 'duplicate horizontal control panel navigation should be removed');
  contains(css, /\.dashboard-layout\{[^}]*grid-template-columns:248px/s, 'desktop layout should reserve a left sidebar');
  contains(css, /@media\(max-width:899px\)\{\.sidebar:not\(\.is-open\)\{visibility:hidden\}/, 'mobile sidebar should remain closed until requested');
  contains(app, /event\.key === 'ArrowDown'/, 'vertical tablist should support down-arrow navigation');
  contains(app, /event\.key === 'ArrowUp'/, 'vertical tablist should support up-arrow navigation');
  contains(app, /event\.key === 'Home'/, 'tab list should support Home navigation');
  contains(app, /event\.key === 'Escape'/, 'mobile drawer should close with Escape');
  contains(app, /sidebar\.inert = !open/, 'closed mobile drawer should be removed from keyboard navigation');
  contains(app, /button:not\(\[disabled\]\):not\(\[tabindex="-1"\]\)/, 'mobile focus trap should follow the roving tab stop');
  contains(app, /focusWasInSidebar\s*=\s*sidebar\.contains\(document\.activeElement\)/, 'breakpoint changes should detect focus inside the sidebar');
  contains(app, /if\s*\(focusWasInSidebar\)\s*sidebarToggle\.focus\(\)/, 'breakpoint changes should restore focus from an inert sidebar');
  contains(app, /focusWasOnMobileControl[\s\S]*sidebarClose[\s\S]*sidebarBackdrop/, 'desktop breakpoint should restore focus from hidden drawer controls');
});

test('incomplete onboarding items point to a settings tab and focus target', () => {
  contains(app, /onboardingTargets\s*=\s*\{/, 'onboarding items should map to dashboard destinations');
  contains(app, /dataset\.onboardingTarget/, 'incomplete items should expose a direct action');
  contains(app, /activateTab\(target\.tab\)/, 'onboarding actions should open the relevant tab');
  contains(app, /focusTarget\?\.focus/, 'onboarding actions should focus the missing setting/status');
  contains(app, /thread:\s*\{\s*tab:\s*'integrations',\s*field:\s*'profileId'\s*\}/, 'Threads setup should navigate to its integration field');
  contains(app, /ai:\s*\{\s*tab:\s*'ai',\s*field:\s*'model'\s*\}/, 'AI setup should navigate to its model field');
});

test('authentication view changes move focus to the newly visible view', () => {
  contains(app, /function setAuthenticated\(authenticated\)\s*\{[^}]*\?\.focus\(/s, 'authentication changes should move keyboard focus');
  contains(html, /id="login-email"[^>]*name="email"/, 'logout should have a visible focus target');
  contains(html, /id="dashboard-title"[^>]*tabindex="-1"/, 'the dashboard heading should accept programmatic focus');
});

test('dashboard navigation exposes active state and uses the dark native color scheme', () => {
  contains(html, /<meta name="color-scheme" content="dark">/, 'native controls should use the dashboard dark theme');
  contains(app, /aria-selected/, 'active tab state should be announced');
  contains(app, /aria-hidden/, 'inactive tab panels should be hidden from assistive technology');
  contains(html, /aria-controls="tab-content"/, 'tab controls should be associated with their panels');
});

test('dashboard overview is its own initial page and settings stay page-specific', () => {
  contains(html, /id="tab-button-dashboard" data-tab="dashboard" role="tab" aria-controls="tab-dashboard" aria-selected="true" tabindex="0"/, 'Dashboard should be the initially selected sidebar page');
  const dashboardStart = html.indexOf('<section id="tab-dashboard"');
  const contentStart = html.indexOf('<section id="tab-content"');
  assert.ok(dashboardStart >= 0 && contentStart > dashboardStart);
  const dashboard = html.slice(dashboardStart, contentStart);
  contains(dashboard, /id="automation-button"/, 'automation controls should live on Dashboard');
  contains(dashboard, /class="metrics" aria-label="Ringkasan operasional"/, 'operational statistics should live on Dashboard');
  contains(dashboard, /id="onboarding-list"/, 'onboarding should live on Dashboard');
  assert.match(html, /id="tab-content"[^>]*aria-hidden="true"[^>]*hidden/);
  const integrations = html.slice(html.indexOf('<section id="tab-integrations"'), html.indexOf('<section id="tab-ai"'));
  const ai = html.slice(html.indexOf('<section id="tab-ai"'), html.indexOf('<section id="tab-admins"'));
  assert.doesNotMatch(integrations, /integration-model-form|integration-model-catalog|Model OpenRouter/);
  contains(integrations, /integration-account-form/, 'Tebar account configuration should remain under Integrations');
  contains(ai, /integration-model-form/, 'OpenRouter settings should live under AI');
  contains(ai, /integration-model-history/, 'model rollback history should stay with AI settings');
});
