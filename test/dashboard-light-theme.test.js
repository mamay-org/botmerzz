'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('login copy removes the welcome kicker while preserving split-screen branding', () => {
  assert.doesNotMatch(html, /WELCOME TO BOTMERZZ/);
  assert.match(html, /class="login-layout"/);
  assert.match(html, /class="login-brand-wordmark">BotMerzz/);
  assert.match(html, /AI-Powered Threads Automation/);
});

test('all dashboard areas use scoped light theme surfaces and the sidebar stays navy', () => {
  const tokens = ['--color-sidebar:#0c1538', '--color-page:#f6f8fc', '--color-surface:#fff', '--color-surface-secondary:#f1f5f9', '--color-text-primary:#14213d', '--color-text-secondary:#475569', '--color-text-muted:#5f6e83', '--color-border:#dce4ef', '--color-accent:#facc15'];
  for (const token of tokens) assert.ok(css.includes(token), `missing theme token ${token}`);
  assert.match(css, /:root\{color-scheme:light;/);
  assert.doesNotMatch(css, /body,body \*\{color:#fff!important\}/, 'dashboard text should not be forced white globally');
  for (const panel of ['dashboard', 'content', 'templates', 'schedule', 'facts', 'activity', 'ai', 'integrations', 'admins']) {
    assert.ok(html.includes(`id="tab-${panel}"`), `missing ${panel} dashboard page`);
  }
  assert.match(css, /#app-view \.dashboard-main,\s*#app-view \.dashboard-main \*/);
  assert.match(css, /#app-view \.dashboard-main \.metric,[\s\S]*?#app-view \.dashboard-main \.onboarding-summary\{[^}]*background:var\(--color-surface\)/);
  assert.match(css, /#app-view \.sidebar\{background:var\(--color-sidebar\)/);
  assert.match(css, /#app-view \.sidebar-nav \.tab\.active[^}]*color:#facc15!important/);
  assert.match(css, /#app-view \.dashboard-main \.template-dialog\{[^}]*background:var\(--color-surface\)/);
  assert.match(css, /#app-view \.dashboard-main \.toast\{[^}]*background:var\(--color-surface\)/);
  assert.match(css, /\.integration-summary\s*>\s*div/, 'integration summary cards should only target their direct wrappers');
  assert.match(css, /@media\(max-width:899px\)\{#app-view \.topbar\{background:var\(--color-page\)\}\}/);
  assert.match(css, /@media\(min-width:1280px\)\{#app-view \.dashboard-main \.metrics\{grid-template-columns:repeat\(5,minmax\(0,1fr\)\)\}\}/);
});

test('schedule interval fields stay numeric, bounded, and usable on narrow screens', () => {
  assert.match(html, /name="hours" type="number" inputmode="numeric" min="0" step="1"/);
  assert.match(html, /name="minutes" type="number" inputmode="numeric" min="0" max="59" step="1"/);
  assert.match(html, /Atur jeda waktu antara posting otomatis\. Minimal 1 menit\./);
  assert.match(css, /#schedule-form \.schedule-interval-fields\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);gap:12px;max-width:420px\}/);
  assert.match(css, /#schedule-form \.schedule-interval-fields label\{min-width:0\}/);
  assert.match(css, /body\{margin:0;min-width:320px\}/);
});

test('dashboard text, form boundaries, active state, and disabled action meet contrast thresholds', () => {
  assert.ok(contrastRatio('#14213d', '#f6f8fc') >= 4.5, 'primary text should meet WCAG AA on the page background');
  assert.ok(contrastRatio('#475569', '#f6f8fc') >= 4.5, 'secondary text should meet WCAG AA on the page background');
  assert.ok(contrastRatio('#5f6e83', '#f6f8fc') >= 4.5, 'muted text should meet WCAG AA on the page background');
  assert.ok(contrastRatio('#7b879a', '#ffffff') >= 3, 'form boundaries should remain distinguishable on white surfaces');
  assert.ok(contrastRatio('#facc15', '#17264d') >= 3, 'the active sidebar accent should remain visible on navy');
  assert.ok(contrastRatio('#ffffff', '#596fa5') >= 4.5, 'disabled primary action text should remain readable');
});
