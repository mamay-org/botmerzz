'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFullCaption } = require('../src/content-validation');
const errors = (text, prior, context = {}) => validateFullCaption(text, { ...context, recentCaptions: [prior] }).errors;

test('removes links and hashtags symmetrically before comparing text', () => {
  const prior = 'Jom main bersama!\nhttps://example.test/old#top\n#Lama';
  const current = 'Jom main bersama!\nhttps://example.test/new\n#Baru';
  assert.ok(errors(current, prior, { trackedLink: 'https://example.test/new', hashtags: ['#Baru'] }).includes('REPETITIVE_CAPTION'));
});

test('short identical captions are rejected, distinct short captions are accepted', () => {
  assert.ok(errors('Jom main!', 'Jom main?').includes('REPETITIVE_CAPTION'));
  assert.ok(!errors('Jom rehat!', 'Jom main?').includes('REPETITIVE_CAPTION'));
});

test('similar vocabulary with opposite order or different intent is not automatically rejected', () => {
  const first = 'Adakah pemain patut membeli akaun lama atau memilih akaun baru untuk bermain bersama kawan?';
  const different = 'Pemain memilih akaun baru supaya dapat bermain bersama kawan, bukan membeli akaun lama.';
  assert.ok(!errors(different, first).includes('REPETITIVE_CAPTION'));
});

test('different negation is not treated as lexical duplication', () => {
  const first = 'Korang patut membeli akaun lama untuk bermain bersama kawan pada waktu malam ini';
  const different = 'Korang tidak patut membeli akaun lama untuk bermain bersama kawan pada waktu malam ini';
  assert.ok(!errors(different, first).includes('REPETITIVE_CAPTION'));
});

test('long near-identical captions are flagged when the sequence is substantially the same', () => {
  const first = 'Setiap pemain punya cara berbeza untuk menikmati permainan bersama kawan pada malam minggu.';
  const second = 'Setiap pemain punya cara berbeza untuk menikmati permainan bersama kawan pada malam ini.';
  assert.ok(errors(second, first).includes('REPETITIVE_CAPTION'));
});

test('normalization cannot hide unapproved links or hashtags from security validation', () => {
  const output = errors('Jom main! https://evil.test #unknown', 'Jom main!', { hashtags: ['#approved'] });
  assert.ok(output.includes('UNAPPROVED_LINK'));
  assert.ok(output.includes('UNAPPROVED_HASHTAG'));
  assert.ok(output.includes('REPETITIVE_CAPTION'));
});
