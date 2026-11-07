'use strict';

const { timingSafeEqual } = require('node:crypto');

const COOKIE = 'merzz_admin';

function createHttpMiddleware({ config, auth }) {
  const cookies = (req) => {
    const result = {};
    for (const piece of (req.headers.cookie || '').split(';')) {
      const [key, value] = piece.trim().split(/=(.*)/s).slice(0, 2);
      if (!key || value === undefined) continue;
      try { result[key] = decodeURIComponent(value); } catch { /* Malformed cookies are treated as absent. */ }
    }
    return result;
  };

  const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.nodeEnv === 'production' ? '; Secure' : ''}`);
  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.nodeEnv === 'production' ? '; Secure' : ''}`);
  const sameOrigin = (req) => {
    const origin = req.get('origin');
    if (!origin) return config.nodeEnv !== 'production' && ['localhost', '127.0.0.1'].includes(req.hostname);
    try { return new URL(origin).origin === config.baseUrl; } catch { return false; }
  };

  async function session(req) {
    const token = cookies(req)[COOKIE];
    return token ? auth.authenticate(token) : null;
  }

  async function authenticated(req, res, next) {
    try {
      const found = await session(req);
      if (!found) return res.status(401).json({ error: 'AUTH_REQUIRED' });
      req.admin = found.admin;
      req.session = found;
      return next();
    } catch {
      return res.status(401).json({ error: 'AUTH_REQUIRED' });
    }
  }

  function mutation(req, res, next) {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    const token = req.get('x-csrf-token');
    if (!req.session || typeof token !== 'string' || token.length !== req.session.csrfToken.length
      || !timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrfToken))) {
      return res.status(403).json({ error: 'CSRF_REJECTED' });
    }
    return next();
  }

  return { cookies, setCookie, clearCookie, sameOrigin, session, authenticated, mutation };
}

module.exports = { createHttpMiddleware, COOKIE };
