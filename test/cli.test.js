'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { askHidden } = require('../src/cli');

test('hidden CLI input handles batched terminal data without echoing it', async () => {
  const input = new EventEmitter();
  let rawMode;
  let paused = false;
  input.setRawMode = (enabled) => { rawMode = enabled; };
  input.resume = () => {};
  input.pause = () => { paused = true; };
  const output = { writes: [], write(value) { this.writes.push(value); } };

  const result = askHidden('Admin password: ', { input, output });
  input.emit('data', Buffer.from('Secx\u007fret!2026\n'));

  assert.equal(await result, 'Secret!2026');
  assert.equal(rawMode, false);
  assert.equal(paused, true);
  assert.deepEqual(output.writes, ['Admin password: ', '\n']);
});
