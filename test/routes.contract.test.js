'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createServer } = require('../src/server');
const { validateSettings } = require('../src/policy');

function normalizePath(path) {
  return path
    .replace(/\$\{[^}]+\}/gu, ':param')
    .replace(/:[A-Za-z][A-Za-z0-9_]*/gu, ':param');
}

function createTestApp() {
  return createServer({
    config: { nodeEnv: 'test', baseUrl: 'http://127.0.0.1', tebar: {} },
    repository: {},
    auth: {},
  });
}

function request(server, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

test('frontend API calls resolve to registered Express paths and methods', () => {
  const app = createTestApp();
  const registered = new Set(app.router.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const path = normalizePath(layer.route.path);
    return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${path}`);
  }));
  const frontend = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const apiCall = /api\(\s*(['"`])([^'"`]*?)\1\s*(?:,\s*\{\s*method:\s*['"]([A-Z]+)['"])?/gu;
  const calls = [...frontend.matchAll(apiCall)].map((match) => ({
    method: match[3] || 'GET',
    path: normalizePath(match[2]),
  }));

  assert.ok(calls.length > 0, 'frontend should contain API calls');
  for (const call of calls) {
    assert.ok(registered.has(`${call.method} ${call.path}`), `missing Express route: ${call.method} ${call.path}`);
  }
});

test('server registers all endpoint contracts and preserves parser and fallback ordering', () => {
  const app = createTestApp();
  const layers = app.router.stack;
  const routes = new Set(layers.flatMap((layer) => {
    if (!layer.route) return [];
    return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`);
  }));
  const expected = [
    'GET /health/live',
    'GET /health/ready',
    'POST /webhooks/tebar',
    'GET /api/session',
    'POST /api/session/login',
    'POST /api/session/logout',
    'GET /api/admins',
    'POST /api/admins',
    'PATCH /api/admins/:id',
    'GET /api/templates',
    'POST /api/templates',
    'PATCH /api/templates/:id',
    'DELETE /api/templates/:id',
    'GET /api/dashboard',
    'PUT /api/settings',
    'PUT /api/knowledge',
    'PUT /api/facts/:service',
    'POST /api/automation/enable',
    'POST /api/automation/pause',
    'GET *path',
  ];
  for (const route of expected) assert.ok(routes.has(route), `missing registered route: ${route}`);

  const privateRouteExceptions = new Set(['GET /api/session', 'POST /api/session/login']);
  const privateApiRoutes = layers.flatMap((layer) => {
    if (!layer.route || typeof layer.route.path !== 'string' || !layer.route.path.startsWith('/api/')) return [];
    return Object.keys(layer.route.methods).map((method) => ({
      method: method.toUpperCase(),
      path: layer.route.path,
      middleware: layer.route.stack.map((handler) => handler.name),
    }));
  });
  for (const route of privateApiRoutes) {
    const key = `${route.method} ${route.path}`;
    if (privateRouteExceptions.has(key)) continue;
    assert.ok(route.middleware.includes('authenticated'), `${key} must require authentication`);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) {
      assert.ok(route.middleware.includes('mutation'), `${key} must enforce mutation origin and CSRF checks`);
    }
  }

  const webhookIndex = layers.findIndex((layer) => layer.route?.path === '/webhooks/tebar');
  const jsonParserIndex = layers.findIndex((layer) => layer.name === 'jsonParser');
  const webhook = layers[webhookIndex];
  assert.ok(webhookIndex >= 0 && webhookIndex < jsonParserIndex, 'raw webhook route must precede JSON parsing');
  assert.equal(webhook.route.stack[0].name, 'ipRateLimit', 'webhook must apply IP rate limiting first');
  assert.equal(webhook.route.stack[1].name, 'rawParser', 'webhook must parse the raw signed body after rate limiting');

  const lastApiRouteIndex = Math.max(...layers.map((layer, index) => layer.route?.path?.startsWith('/api/') ? index : -1));
  const staticIndex = layers.findIndex((layer) => layer.name === 'serveStatic');
  const apiNotFoundIndex = layers.findIndex((layer, index) => index > lastApiRouteIndex
    && index < staticIndex && !layer.route && layer.match('/api/not-found'));
  const spaFallbackIndex = layers.findIndex((layer) => layer.route?.path === '*path');
  assert.ok(apiNotFoundIndex > lastApiRouteIndex && apiNotFoundIndex < staticIndex, 'API 404 must precede static serving');
  assert.ok(staticIndex < spaFallbackIndex, 'SPA fallback must follow static serving');
});

test('valid near-maximum settings above the previous 64kb limit reach API authentication middleware', async (t) => {
  let authenticationCalls = 0;
  const config = { nodeEnv: 'test', baseUrl: 'http://127.0.0.1', tebar: {} };
  const auth = {
    authenticate: async (token) => {
      authenticationCalls += 1;
      assert.equal(token, 'session-token');
      return null;
    },
  };
  const server = http.createServer(createServer({ config, repository: {}, auth }));
  const listening = new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  server.listen(0, '127.0.0.1');
  await listening;
  t.after(() => closeServer(server));

  const settings = {
    schedule: { intervalHours: 1 },
    brand: {
      name: 'N'.repeat(120),
      voice: '漢'.repeat(500),
      audienceNotes: '漢'.repeat(7000),
      contentDirection: '漢'.repeat(7000),
    },
    gameWhitelist: Array.from({ length: 30 }, (_, index) => `漢${'漢'.repeat(96)}${String(index).padStart(2, '0')}`),
    hashtags: Array.from({ length: 30 }, (_, index) => `#${'漢'.repeat(97)}${String(index).padStart(2, '0')}`),
    guardrails: {
      approved: true,
      forbiddenClaims: Array.from({ length: 6 }, (_, index) => `${'漢'.repeat(497)}${String(index).padStart(2, '0')}`),
      approvedClaims: Array.from({ length: 14 }, (_, index) => `${'漢'.repeat(497)}${String(index).padStart(2, '0')}`),
    },
  };
  assert.equal(validateSettings(settings).valid, true);
  const body = JSON.stringify(settings);
  assert.ok(Buffer.byteLength(body) > 64 * 1024);
  const response = await request(server, '/api/settings', {
    method: 'PUT',
    headers: { cookie: 'merzz_admin=session-token' },
    body,
  });

  assert.equal(response.status, 401, response.body);
  assert.equal(authenticationCalls, 1);
});
