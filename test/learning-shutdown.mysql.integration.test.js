'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('optional-pool shutdown cancels an active stalled query on isolated MySQL', { skip: !enabled, timeout: 5000 }, async () => {
  const { loadEnv } = require('../src/config');
  const { createPool, endOptionalPoolBounded } = require('../src/db');
  const pool = createPool({ ...loadEnv(), db: { ...loadEnv().db, connectionLimit: 1 } });
  const connection = await pool.getConnection();
  const query = connection.execute('SELECT SLEEP(30)');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await endOptionalPoolBounded(pool, 25), false);
  await assert.rejects(query, { code: 'PROTOCOL_CONNECTION_LOST' });
});
