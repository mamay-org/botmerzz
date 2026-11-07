'use strict';

const { COOKIE } = require('../middleware');

function registerSessionAdminRoutes(app, { repository, auth, middleware }) {
  const { cookies, setCookie, clearCookie, sameOrigin, authenticated, mutation } = middleware;

  app.get('/api/session', async (req, res) => {
    const found = await middleware.session(req);
    return res.json(found ? { authenticated: true, csrfToken: found.csrfToken, admin: found.admin } : { authenticated: false });
  });

  app.post('/api/session/login', async (req, res, next) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    try {
      const result = await auth.login({ email: req.body?.email, password: req.body?.password, ip: req.ip });
      setCookie(res, result.token, Math.max(0, Math.floor((new Date(result.expiresAt) - Date.now()) / 1000)));
      return res.json({ authenticated: true, csrfToken: result.csrfToken, admin: result.admin });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/session/logout', authenticated, mutation, async (req, res) => {
    await auth.logout(cookies(req)[COOKIE]);
    clearCookie(res);
    return res.json({ ok: true });
  });

  app.get('/api/admins', authenticated, async (_req, res, next) => {
    try { return res.json({ admins: await repository.listAdmins() }); } catch (error) { return next(error); }
  });

  app.post('/api/admins', authenticated, mutation, async (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some((key) => !['email', 'password'].includes(key))) {
      return res.status(400).json({ error: 'INVALID_ADMIN' });
    }
    try {
      const admin = await auth.createAdmin({ email: req.body?.email, password: req.body?.password, actorId: req.admin.id });
      return res.status(201).json({ admin: { id: Number(admin.id), email: admin.email, active: true, createdAt: admin.createdAt || null } });
    } catch (error) {
      return next(error);
    }
  });

  app.patch('/api/admins/:id', authenticated, mutation, async (req, res, next) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['email', 'password', 'active'].includes(key))) {
      return res.status(400).json({ error: 'INVALID_ADMIN' });
    }
    try {
      if (id === Number(req.admin.id) && body.active === false) return res.status(409).json({ error: 'CANNOT_DEACTIVATE_SELF' });
      const admin = await auth.updateAdmin(id, body, req.admin.id);
      if (!admin) return res.status(404).json({ error: 'ADMIN_NOT_FOUND' });
      const sessionRevoked = id === Number(req.admin.id) && admin.credentialsChanged === true;
      const { credentialsChanged, ...safeAdmin } = admin;
      if (sessionRevoked) {
        clearCookie(res);
        return res.json({ admin: safeAdmin, sessionRevoked: true });
      }
      return res.json({ admin: safeAdmin, sessionRevoked: false });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerSessionAdminRoutes };
