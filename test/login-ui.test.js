'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('login shows BotMerzz split-screen content while preserving authentication controls', () => {
  assert.match(html, /<section id="login-view" class="login-layout" aria-labelledby="login-title">/);
  assert.match(html, /class="login-brand-panel"[\s\S]*?BotMerzz[\s\S]*?AI-Powered Threads Automation/);
  assert.match(html, /WELCOME TO BOTMERZZ/);
  assert.match(html, /Otomasi konten Threads, lebih mudah dari satu dashboard\./);
  assert.match(html, /Kelola konten, jadwal publikasi, dan performa Threads secara praktis dengan bantuan AI\./);
  assert.match(html, /class="login-form-panel"[\s\S]*?Masuk ke akun[\s\S]*?Selamat datang kembali/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /<div class="login-field"><label for="login-email">Email administrator<\/label><input id="login-email" name="email" type="email" autocomplete="username" required/);
  assert.match(html, /<div class="login-field"><label for="login-password">Kata sandi<\/label><input id="login-password" name="password" type="password" autocomplete="current-password" required/);
  assert.match(html, /class="button primary login-submit" type="submit">Masuk<\/button>/);
  assert.match(html, /id="login-error" class="notice error" role="alert"/);
  assert.match(app, /function addPasswordToggle\(/);
  assert.match(app, /control\.labels\?\.\[0\] \|\| control\.closest\('label'\)/);
  assert.match(app, /fieldContainer\.append\(note\)/);
  assert.match(app, /function clearLoginFeedback\(\)\s*\{[\s\S]*?hide\('#login-error'\);[\s\S]*?toast\.remove\(\);[\s\S]*?\}/);
  assert.match(app, /function setAuthenticated\(authenticated\)\s*\{\s*clearLoginFeedback\(\);/);
  assert.match(app, /api\('\/api\/session\/login',\s*\{\s*method:\s*'POST'/);
  assert.match(app, /withPending\(button,[\s\S]*'Memeriksa…',\s*form\)/);
});

test('login layout adapts to narrow viewports with a visible WCAG-contrast submit button', () => {
  const loginRule = css.match(/#login-view\.login-layout\s*\{([^}]+)\}/)?.[1] || '';
  const brandRule = css.match(/\.login-brand-panel\s*\{([^}]+)\}/)?.[1] || '';
  const formRule = css.match(/\.login-form-panel\s*\{([^}]+)\}/)?.[1] || '';
  const buttonRule = css.match(/\.login-form-panel \.login-submit\s*\{([^}]+)\}/)?.[1] || '';
  const inputRule = css.match(/#login-view #login-form input\s*\{([^}]+)\}/)?.[1] || '';
  const inputHoverRule = css.match(/#login-view #login-form input:hover\s*\{([^}]+)\}/)?.[1] || '';
  const errorRule = css.match(/#login-view #login-error\s*\{([^}]+)\}/)?.[1] || '';
  const token = loginRule.match(/--login-blue\s*:\s*(#[\da-f]{6})/i)?.[1];
  const buttonText = buttonRule.match(/color\s*:\s*(#[\da-f]{6})/i)?.[1];
  const inputBorder = inputRule.match(/border\s*:\s*1px solid (#[\da-f]{6})/i)?.[1];
  const inputHoverBorder = inputHoverRule.match(/border-color\s*:\s*(#[\da-f]{6})/i)?.[1];
  const errorText = errorRule.match(/color\s*:\s*(#[\da-f]{6})/i)?.[1];
  const errorBackground = errorRule.match(/background\s*:\s*(#[\da-f]{6})/i)?.[1];
  const formWidthRule = css.match(/\.login-form-inner\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(loginRule, /min-height\s*:\s*100dvh/);
  assert.match(loginRule, /grid-template-columns\s*:\s*minmax\(320px,\s*2fr\)\s+minmax\(0,\s*3fr\)/);
  assert.match(brandRule, /background\s*:\s*var\(--login-navy\)/);
  assert.match(formRule, /background\s*:\s*var\(--login-paper\)/);
  assert.match(formWidthRule, /max-width\s*:\s*420px/);
  assert.match(buttonRule, /background\s*:\s*var\(--login-blue\)/);
  assert.match(buttonRule, /width\s*:\s*100%/);
  assert.ok(token && buttonText, 'the primary action should use explicit design tokens');
  assert.ok(contrastRatio(buttonText, token) >= 4.5, 'submit text should meet WCAG AA contrast for normal text');
  assert.ok(inputBorder && contrastRatio(inputBorder, '#ffffff') >= 3, 'input boundary should meet WCAG non-text contrast');
  assert.ok(inputHoverBorder && contrastRatio(inputHoverBorder, '#ffffff') >= 3, 'hovered input boundary should meet WCAG non-text contrast');
  assert.ok(errorText && errorBackground && contrastRatio(errorText, errorBackground) >= 4.5, 'login error text should meet WCAG AA contrast');
  assert.match(css, /@media\s*\(max-width:\s*820px\)\s*\{[^}]*\.login-layout\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.login-form-panel :focus-visible\s*\{/);
  assert.match(css, /\.login-highlights\s*\{[^}]*display:\s*none/s);
});
