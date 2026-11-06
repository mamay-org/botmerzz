const { randomBytes, scrypt: scryptCallback, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(scryptCallback);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = 'scrypt$16384$8$1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

function safeError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw safeError('INVALID_PASSWORD');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${Buffer.from(key).toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const [kind, n, r, p, saltHex, keyHex, ...rest] = encoded.split('$');
  if (kind !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || rest.length || !/^[a-f0-9]{32}$/.test(saltHex || '') || !/^[a-f0-9]{128}$/.test(keyHex || '')) return false;
  try {
    const key = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
    return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
  } catch { return false; }
}

function createAuth({ repository, clock = () => new Date(), sessionHours = 12, maxFailures = 8, maxFailuresPerIp = 40, windowMs = 15 * 60 * 1000 }) {
  if (!repository) throw new TypeError('repository is required');
  const failures = new Map();
  const ipFailures = new Map();
  function pruneMap(map, nowMs) {
    for (const [key, item] of map) if (item.until <= nowMs) map.delete(key);
    while (map.size > 10000) map.delete(map.keys().next().value);
  }
  function pruneFailures(nowMs) { pruneMap(failures, nowMs); pruneMap(ipFailures, nowMs); }
  const keyFor = (email, ip) => `${String(ip || 'unknown').slice(0, 64)}:${String(email || '').toLowerCase().slice(0, 254)}`;
  return {
    async createAdmin({ email, password, actorId }) {
      if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) throw safeError('INVALID_EMAIL');
      const passwordHash = await hashPassword(password);
      try { return await repository.createAdmin({ email: email.trim().toLowerCase(), passwordHash, actorId }); }
      catch (error) { if (error.code === 'ADMIN_EXISTS' || error.code === 'ER_DUP_ENTRY') throw safeError('ADMIN_EXISTS', 409); throw error; }
    },
    async updateAdmin(id, changes, actorId) {
      const normalized = {};
      if (changes.email !== undefined) {
        if (typeof changes.email !== 'string' || changes.email.length > 254 || !EMAIL_RE.test(changes.email)) throw safeError('INVALID_EMAIL');
        normalized.email = changes.email.trim().toLowerCase();
      }
      if (changes.password !== undefined && changes.password !== '') normalized.passwordHash = await hashPassword(changes.password);
      if (changes.active !== undefined) {
        if (typeof changes.active !== 'boolean') throw safeError('INVALID_ADMIN_STATUS');
        normalized.active = changes.active;
      }
      if (!Object.keys(normalized).length) throw safeError('EMPTY_ADMIN_UPDATE');
      try { return await repository.updateAdmin(id, normalized, actorId); }
      catch (error) {
        if (error.code === 'ADMIN_EXISTS' || error.code === 'ER_DUP_ENTRY') throw safeError('ADMIN_EXISTS', 409);
        if (error.code === 'LAST_ADMIN') throw safeError('LAST_ADMIN', 409);
        throw error;
      }
    },
    async login({ email, password, ip }) {
      const now = clock();
      pruneFailures(now.getTime());
      const key = keyFor(email, ip);
      const ipKey = String(ip || 'unknown').slice(0, 64);
      const current = failures.get(key);
      const ipCurrent = ipFailures.get(ipKey);
      if ((current && current.count >= maxFailures) || (ipCurrent && ipCurrent.count >= maxFailuresPerIp)) throw safeError('LOGIN_RATE_LIMITED', 429);
      const admin = typeof email === 'string' ? await repository.getAdminByEmail(email.trim().toLowerCase()) : null;
      const valid = await verifyPassword(password, admin?.passwordHash || DUMMY_HASH);
      if (!admin || admin.active !== true || !valid) {
        const count = current && current.until > now.getTime() ? current.count + 1 : 1;
        failures.set(key, { count, until: now.getTime() + windowMs });
        const ipCount = ipCurrent && ipCurrent.until > now.getTime() ? ipCurrent.count + 1 : 1;
        ipFailures.set(ipKey, { count: ipCount, until: now.getTime() + windowMs });
        throw safeError('INVALID_CREDENTIALS', 401);
      }
      failures.delete(key);
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now.getTime() + sessionHours * 60 * 60 * 1000);
      await repository.createSession({ tokenHash: hashToken(token), adminId: admin.id, csrfToken, expiresAt });
      return { token, csrfToken, expiresAt, admin: { id: admin.id, email: admin.email } };
    },
    async authenticate(token) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
      return repository.getSession(hashToken(token), clock());
    },
    async logout(token) { if (typeof token === 'string') await repository.deleteSession(hashToken(token)); },
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, hashToken, safeError };
