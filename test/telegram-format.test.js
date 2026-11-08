'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSlotNotice, formatDailyReport } = require('../src/telegram-format');
const slotId = '5472f3ef-497b-4dac-a27e-acaed539b00e';

test('report labels contain no emoji while published captions remain unchanged', () => {
  for (const status of ['published', 'failed', 'unknown']) {
    const text = formatSlotNotice({ status, slotId, caption: 'Teks biasa' });
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
    assert.match(text, /Technical Reference/);
  }
  assert.doesNotMatch(formatDailyReport({ date: '2026-11-08', affectedSlotIds: [slotId] }), /\p{Extended_Pictographic}/u);
  assert.ok(formatSlotNotice({ status: 'published', slotId, caption: 'Halo 😀' }).includes('Halo 😀'));
});

test('published notice keeps caption as plain text and the real reference at the bottom', () => {
  const text = formatSlotNotice({ status: 'published', slotId, brand: 'Kedai Merzz', time: '2026-11-08T02:00:00Z', pillar: 'topup', caption: '<b>Halo & selamat</b>', postUrl: 'https://www.threads.com/@shop/post/123', nextAt: '2026-11-08T03:00:00Z' });
  assert.match(text, /Berhasil diterbitkan/);
  assert.match(text, /10:00 GMT\+8/);
  assert.match(text, /<b>Halo & selamat<\/b>/);
  assert.match(text, /threads\.com/);
  assert.ok(text.endsWith(`Slot ID: ${slotId}`));
});
test('unknown status does not claim a definitive outcome or include unverified links', () => {
  const text = formatSlotNotice({ status: 'unknown', slotId, postUrl: 'https://example.com/fake' });
  assert.match(text, /Menunggu konfirmasi/);
  assert.doesNotMatch(text, /Berhasil diterbitkan|Gagal diterbitkan|example\.com/);
  assert.ok(text.endsWith(`Slot ID: ${slotId}`));
});
test('failed notification uses safe diagnostic descriptions and bounded reference', () => {
  const text = formatSlotNotice({ status: 'failed', slotId, diagnosticCode: 'content_validation_failed', caption: 'x'.repeat(3000) });
  assert.match(text, /tidak memenuhi aturan validasi/);
  assert.ok(text.length <= 1200);
  assert.ok(text.endsWith(`Slot ID: ${slotId}`));
});
test('daily success rate excludes unconfirmed outcomes and does not claim a next time while paused', () => {
  const text = formatDailyReport({ date: '2026-11-08', published: 4, failed: 1, unknown: 2, categories: { topup: 4 }, automationEnabled: false, nextAt: '2026-11-09T01:00:00Z', affectedSlotIds: [slotId] });
  assert.match(text, /Success Rate: 80%/);
  assert.match(text, /Belum pasti: 2/);
  assert.match(text, /Top-up: 4/);
  assert.doesNotMatch(text, /Posting Berikutnya/);
  assert.ok(text.endsWith(`Slot ID: ${slotId}`));
});
test('published caption preserves 500 emoji and pending does not promise automatic reconciliation', () => {
  const caption = '😀'.repeat(500);
  const text = formatSlotNotice({ status: 'published', slotId, caption });
  assert.ok(text.includes(caption));
  assert.ok(text.endsWith(`Slot ID: ${slotId}`));
  assert.match(formatSlotNotice({ status: 'unknown', slotId }), /Menunggu pemeriksaan status/);
});
