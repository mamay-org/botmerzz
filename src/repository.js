const { randomUUID, createHash } = require('node:crypto');
const { formatSlotNotice } = require('./telegram-format');
const { contentSafetyHash, legacyContentSafetyHash } = require('./content-safety');
const { DateTime } = require('luxon');
const { isInActiveWindow, validateSettings, isFactFresh, normalizeScheduleInterval } = require('./policy');

const json = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeId = (value) => String(value);
function loginThrottleKeys(email, ip) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedIp = String(ip || 'unknown').slice(0, 64);
  const hash = (scope, value) => createHash('sha256').update(`${scope}\0${value}`).digest('hex');
  return [
    { scope: 'pair', subjectHash: hash('pair', `${normalizedIp}\0${normalizedEmail}`) },
    { scope: 'account', subjectHash: hash('account', normalizedEmail) },
    { scope: 'ip', subjectHash: hash('ip', normalizedIp) },
  ];
}
function validThrottleTime(now) {
  return now instanceof Date && Number.isFinite(now.getTime());
}
function normalizeCompletedAt(value) {
  if (value === null) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw Object.assign(new TypeError('completedAt must be a valid date'), { code: 'INVALID_COMPLETED_AT' });
    return value;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw Object.assign(new TypeError('completedAt must be an ISO timestamp, Date, or null'), { code: 'INVALID_COMPLETED_AT' });
  }
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw Object.assign(new TypeError('completedAt must be a valid ISO timestamp'), { code: 'INVALID_COMPLETED_AT' });
  return parsed.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
}

function createRepository(pool) {
  if (!pool || typeof pool.execute !== 'function') throw new TypeError('mysql pool is required');
  async function audit(connection, adminId, action, details = {}) {
    await connection.execute('INSERT INTO audit_logs (admin_id, action, details_json) VALUES (?, ?, ?)', [adminId || null, action, JSON.stringify(details)]);
  }
  async function getSettings() {
    const [rows] = await pool.execute('SELECT settings_json, knowledge_json, automation_enabled FROM settings WHERE id=1');
    const row = rows[0]; if (!row) return { automationEnabled: false };
    const settings = json(row.settings_json);
    const knowledge = json(row.knowledge_json);
    return { ...settings, schedule: normalizeScheduleInterval(settings.schedule || {}), brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {}, automationEnabled: Boolean(row.automation_enabled) };
  }
  async function getRuntimeState() {
    const [rows] = await pool.execute('SELECT settings_json, knowledge_json, automation_enabled FROM settings WHERE id=1');
    const row = rows[0] || {};
    const settings = json(row.settings_json);
    const knowledge = json(row.knowledge_json);
    const facts = await listFacts();
    const history = await listSlots(1000);
    const factRows = Object.entries(facts).map(([service, fact]) => ({ ...fact.summary, id: service, pillar: service === 'account' ? 'account' : 'topup', active: fact.active, updatedAt: fact.updatedAt }));
    return { settings: { ...settings, schedule: normalizeScheduleInterval(settings.schedule || {}), brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {} }, knowledge, facts: factRows, history, automationEnabled: Boolean(row.automation_enabled), accountId: settings.targetAccountId || null, profileId: settings.profileId || null, onboardingComplete: settings.onboardingComplete === true };
  }
  async function saveSettings(settings, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const safeSettings = { ...settings }; delete safeSettings.automationEnabled;
      if (safeSettings.schedule && typeof safeSettings.schedule === 'object' && !Array.isArray(safeSettings.schedule)) safeSettings.schedule = normalizeScheduleInterval(safeSettings.schedule);
      const [[existingRow]] = await connection.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      const existing = json(existingRow?.settings_json);
      for (const key of ['targetAccountId','profileId','integrationConfigInitialized','onboardingComplete','nextSlotAt','automationSessionId']) if (safeSettings[key] === undefined && existing[key] !== undefined) safeSettings[key] = existing[key];
      const scheduleKey = (schedule) => {
        const checked = validateSettings({ schedule: schedule || {} });
        return JSON.stringify(checked.valid ? checked.settings.schedule : normalizeScheduleInterval(schedule || {}));
      };
      if (scheduleKey(existing.schedule) !== scheduleKey(safeSettings.schedule)) delete safeSettings.nextSlotAt;
      const knowledge = { brand: safeSettings.brand || {}, guardrails: safeSettings.guardrails || {} };
      await connection.execute('UPDATE settings SET settings_json=?, knowledge_json=? WHERE id=1', [JSON.stringify(safeSettings), JSON.stringify(knowledge)]);
      await audit(connection, adminId, 'settings.updated', {});
      await connection.commit(); return { ...safeSettings, automationEnabled: (await getSettings()).automationEnabled };
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function saveKnowledge(knowledge, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[row]] = await connection.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      const settings = json(row.settings_json);
      settings.brand = knowledge.brand || settings.brand || {};
      settings.guardrails = knowledge.guardrails || settings.guardrails || {};
      await connection.execute('UPDATE settings SET settings_json=?, knowledge_json=? WHERE id=1', [JSON.stringify(settings), JSON.stringify(knowledge)]);
      await audit(connection, adminId, 'knowledge.updated', {}); await connection.commit(); return knowledge;
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function listFacts() {
    const [rows] = await pool.execute('SELECT service, summary_json, active, updated_at FROM service_facts ORDER BY service');
    return Object.fromEntries(rows.map((row) => [row.service, { summary: json(row.summary_json), active: Boolean(row.active), updatedAt: row.updated_at }]));
  }
  async function saveFact(service, fact, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('INSERT INTO service_facts (service,summary_json,active) VALUES (?,?,?) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json), active=VALUES(active), updated_at=UTC_TIMESTAMP(3)', [service, JSON.stringify(fact.summary), Boolean(fact.active)]);
      await audit(connection, adminId, 'fact.updated', { service }); await connection.commit();
      const facts = await listFacts(); return facts[service];
    } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async function getAdminByEmail(email) {
    const [rows] = await pool.execute('SELECT id,email,password_hash,active FROM admins WHERE email=? LIMIT 1', [email]);
    const row = rows[0]; return row && { id: row.id, email: row.email, passwordHash: row.password_hash, active: Boolean(row.active) };
  }
  async function getLoginAttemptCounts({ email, ip, now }) {
    if (!validThrottleTime(now)) throw Object.assign(new TypeError('now must be a valid date'), { code: 'INVALID_LOGIN_THROTTLE_TIME' });
    const keys = loginThrottleKeys(email, ip);
    const conditions = keys.map(() => '(scope=? AND subject_hash=?)').join(' OR ');
    const values = keys.flatMap(({ scope, subjectHash }) => [scope, subjectHash]);
    values.push(now);
    const [rows] = await pool.execute(`SELECT scope,attempt_count FROM login_attempts WHERE (${conditions}) AND expires_at>?`, values);
    const counts = { pair: 0, account: 0, ip: 0 };
    for (const row of rows) if (Object.hasOwn(counts, row.scope)) counts[row.scope] = Number(row.attempt_count);
    return counts;
  }
  async function reserveLoginAttempt({ email, ip, now, windowMs, limits }) {
    const scopes = ['pair', 'account', 'ip'];
    if (!validThrottleTime(now) || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000) {
      throw Object.assign(new TypeError('invalid login throttle window'), { code: 'INVALID_LOGIN_THROTTLE_WINDOW' });
    }
    if (!limits || scopes.some((scope) => !Number.isSafeInteger(limits[scope]) || limits[scope] < 1 || limits[scope] > 10_000)) {
      throw Object.assign(new TypeError('invalid login throttle limits'), { code: 'INVALID_LOGIN_THROTTLE_LIMITS' });
    }
    await pool.execute('DELETE FROM login_attempts WHERE expires_at<=? LIMIT 1000', [now]);
    const expiresAt = new Date(now.getTime() + windowMs);
    const keys = loginThrottleKeys(email, ip);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const { scope, subjectHash } of keys) {
        await connection.execute(
          'INSERT INTO login_attempts (scope,subject_hash,attempt_count,window_started_at,expires_at) VALUES (?,?,1,?,?) ON DUPLICATE KEY UPDATE attempt_count=IF(expires_at<=?,1,attempt_count+1),window_started_at=IF(expires_at<=?,?,window_started_at),expires_at=IF(expires_at<=?,?,expires_at)',
          [scope, subjectHash, now, expiresAt, now, now, now, now, expiresAt],
        );
      }
      const conditions = keys.map(() => '(scope=? AND subject_hash=?)').join(' OR ');
      const values = keys.flatMap(({ scope, subjectHash }) => [scope, subjectHash]);
      values.push(now);
      const [rows] = await connection.execute(
        `SELECT scope,subject_hash,attempt_count,window_started_at,expires_at FROM login_attempts WHERE (${conditions}) AND expires_at>? FOR UPDATE`,
        values,
      );
      const counts = { pair: 0, account: 0, ip: 0 };
      const reservations = [];
      const retryDelays = [];
      for (const row of rows) {
        if (!Object.hasOwn(counts, row.scope)) continue;
        counts[row.scope] = Number(row.attempt_count);
        reservations.push({ scope: row.scope, subjectHash: row.subject_hash, windowStartedAt: row.window_started_at });
        if (counts[row.scope] > limits[row.scope]) {
          const expiresAtMs = row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
          if (Number.isFinite(expiresAtMs)) retryDelays.push(Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000)));
        }
      }
      if (reservations.length !== scopes.length) throw Object.assign(new Error('LOGIN_THROTTLE_STORAGE_INCOMPLETE'), { code: 'LOGIN_THROTTLE_STORAGE_INCOMPLETE' });
      if (scopes.some((scope) => counts[scope] > limits[scope])) {
        await connection.rollback();
        return { allowed: false, counts, retryAfterSeconds: Math.max(1, ...retryDelays) };
      }
      await connection.commit();
      return { allowed: true, counts, reservation: { keys: reservations } };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async function releaseLoginReservation(reservation, now = new Date()) {
    const scopes = ['pair', 'account', 'ip'];
    if (!validThrottleTime(now) || !Array.isArray(reservation?.keys) || reservation.keys.length !== scopes.length
      || scopes.some((scope) => !reservation.keys.some((key) => key.scope === scope
        && /^[a-f0-9]{64}$/.test(key.subjectHash) && validThrottleTime(key.windowStartedAt)))) {
      throw Object.assign(new TypeError('invalid login reservation'), { code: 'INVALID_LOGIN_RESERVATION' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const { scope, subjectHash, windowStartedAt } of reservation.keys) {
        await connection.execute(
          'UPDATE login_attempts SET attempt_count=GREATEST(attempt_count-1,0) WHERE scope=? AND subject_hash=? AND window_started_at=? AND expires_at>?',
          [scope, subjectHash, windowStartedAt, now],
        );
        await connection.execute(
          'DELETE FROM login_attempts WHERE scope=? AND subject_hash=? AND window_started_at=? AND attempt_count=0',
          [scope, subjectHash, windowStartedAt],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }
  async function listAdmins() {
    const [rows] = await pool.execute('SELECT id,email,active,created_at FROM admins ORDER BY created_at,id');
    return rows.map((row) => ({ id: Number(row.id), email: row.email, active: Boolean(row.active), createdAt: row.created_at }));
  }
  function mapTemplate(row) {
    return { id: row.id, name: row.name, category: row.category, data: json(row.data_json), createdBy: row.created_by == null ? null : Number(row.created_by), updatedBy: row.updated_by == null ? null : Number(row.updated_by), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async function listTemplates() {
    const [rows] = await pool.execute('SELECT id,name,category,data_json,created_by,updated_by,created_at,updated_at FROM templates ORDER BY category,name');
    return rows.map(mapTemplate);
  }
  async function getTemplate(id) {
    const [rows] = await pool.execute('SELECT id,name,category,data_json,created_by,updated_by,created_at,updated_at FROM templates WHERE id=?', [id]);
    return rows[0] ? mapTemplate(rows[0]) : null;
  }
  async function createTemplate({ name, category, data, actorId }) {
    const id = randomUUID(); const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('INSERT INTO templates (id,name,category,data_json,created_by,updated_by) VALUES (?,?,?,?,?,?)', [id,name,category,JSON.stringify(data),actorId,actorId]);
      await audit(conn, actorId, 'template.created', { templateId:id, name, category });
      await conn.commit();
      return await getTemplate(id);
    } catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('TEMPLATE_EXISTS'), { code:'TEMPLATE_EXISTS' }); throw error; }
    finally { conn.release(); }
  }
  async function updateTemplate(id, { name, data, actorId }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[existing]] = await conn.execute('SELECT name,category,data_json FROM templates WHERE id=? FOR UPDATE', [id]);
      if (!existing) { await conn.rollback(); return null; }
      const nextName = name === undefined ? existing.name : name;
      const nextData = data === undefined ? json(existing.data_json) : data;
      await conn.execute('UPDATE templates SET name=?,data_json=?,updated_by=? WHERE id=?', [nextName,JSON.stringify(nextData),actorId,id]);
      await audit(conn, actorId, 'template.updated', { templateId:id, name:nextName, category:existing.category });
      await conn.commit();
      return await getTemplate(id);
    } catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('TEMPLATE_EXISTS'), { code:'TEMPLATE_EXISTS' }); throw error; }
    finally { conn.release(); }
  }
  async function deleteTemplate(id, actorId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[existing]] = await conn.execute('SELECT name,category FROM templates WHERE id=? FOR UPDATE', [id]);
      if (!existing) { await conn.rollback(); return false; }
      await conn.execute('DELETE FROM templates WHERE id=?', [id]);
      await audit(conn, actorId, 'template.deleted', { templateId:id, name:existing.name, category:existing.category });
      await conn.commit(); return true;
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  }
  async function createAdmin({ email, passwordHash, actorId }) {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); await conn.query('SELECT id FROM settings WHERE id=1 FOR UPDATE'); await conn.execute('INSERT INTO admins (email,password_hash,active) VALUES (?,?,TRUE)', [email,passwordHash]); const [rows] = await conn.execute('SELECT id,email,active,created_at FROM admins WHERE email=?', [email]); await audit(conn, actorId, 'admin.created', { targetAdminId: Number(rows[0].id), email }); await conn.commit(); return { ...rows[0], id: Number(rows[0].id), active: Boolean(rows[0].active), createdAt: rows[0].created_at }; }
    catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('ADMIN_EXISTS'), { code: 'ADMIN_EXISTS' }); throw error; } finally { conn.release(); }
  }
  async function updateAdmin(id, { email, passwordHash, active }, actorId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM settings WHERE id=1 FOR UPDATE');
      const [[target]] = await conn.execute('SELECT id,email,active FROM admins WHERE id=? FOR UPDATE', [id]);
      if (!target) { await conn.rollback(); return null; }
      if (active === false && Boolean(target.active)) {
        const [activeAdmins] = await conn.execute('SELECT id FROM admins WHERE active=TRUE FOR UPDATE');
        if (activeAdmins.length <= 1) throw Object.assign(new Error('LAST_ADMIN'), { code: 'LAST_ADMIN' });
      }
      const emailChanged = email !== undefined && email !== target.email;
      const passwordChanged = passwordHash !== undefined;
      const activeChanged = active !== undefined && Boolean(target.active) !== active;
      if (!emailChanged && !passwordChanged && !activeChanged) {
        await conn.rollback();
        return { id: Number(target.id), email: target.email, active: Boolean(target.active), credentialsChanged: false };
      }
      const fields = []; const values = [];
      if (emailChanged) { fields.push('email=?'); values.push(email); }
      if (passwordChanged) { fields.push('password_hash=?'); values.push(passwordHash); }
      if (activeChanged) { fields.push('active=?'); values.push(active); }
      values.push(id); await conn.execute(`UPDATE admins SET ${fields.join(',')} WHERE id=?`, values);
      if (emailChanged || passwordChanged || (active === false && activeChanged)) await conn.execute('DELETE FROM sessions WHERE admin_id=?', [id]);
      await audit(conn, actorId, active === false ? 'admin.deactivated' : active === true ? 'admin.reactivated' : 'admin.updated', { targetAdminId: Number(id), emailChanged, passwordReset: passwordChanged });
      const [[updated]] = await conn.execute('SELECT id,email,active,created_at FROM admins WHERE id=?', [id]);
      await conn.commit();
      return { id: Number(updated.id), email: updated.email, active: Boolean(updated.active), createdAt: updated.created_at, credentialsChanged: emailChanged || passwordChanged };
    } catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('ADMIN_EXISTS'), { code: 'ADMIN_EXISTS' }); throw error; }
    finally { conn.release(); }
  }
  async function createSession({ tokenHash, adminId, csrfToken, expiresAt }) { await pool.execute('INSERT INTO sessions (token_hash,admin_id,csrf_token,expires_at) VALUES (?,?,?,?)', [tokenHash,adminId,csrfToken,expiresAt]); }
  async function getSession(tokenHash, now = new Date()) {
    const [rows] = await pool.execute('SELECT s.csrf_token,s.expires_at,a.id,a.email FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=TRUE LIMIT 1', [tokenHash,now]);
    const row=rows[0]; return row ? { admin: { id: row.id,email:row.email }, csrfToken:row.csrf_token,expiresAt:row.expires_at } : null;
  }
  async function deleteSession(tokenHash) { await pool.execute('DELETE FROM sessions WHERE token_hash=?', [tokenHash]); }
  async function deleteAdminSessions(adminId) { await pool.execute('DELETE FROM sessions WHERE admin_id=?', [adminId]); }
  async function listSlots(limit=100) { const [rows]=await pool.execute('SELECT id,scheduled_at,status,pillar,provider_post_id,provider_status,caption,error_code,cancellation_status,fact_bearing,fact_ids,created_at,completed_at FROM slots ORDER BY scheduled_at DESC LIMIT ?', [Math.max(1,Math.min(1000,Number(limit)||100))]); return rows.map((r)=>({id:r.id,scheduledAt:r.scheduled_at,status:r.status,pillar:r.pillar,providerPostId:r.provider_post_id,providerStatus:r.provider_status,caption:r.caption,errorCode:r.error_code,cancellationStatus:r.cancellation_status,factBearing:Boolean(r.fact_bearing),factIds:json(r.fact_ids,[]),createdAt:r.created_at,completedAt:r.completed_at})); }
  async function listActivity(limit=100) { const [rows]=await pool.execute('SELECT event,details_json,created_at FROM activity_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.event,...json(r.details_json),createdAt:r.created_at})); }
  async function healthCheck() { await pool.query('SELECT 1'); return true; }
  async function listAudit(limit=100) { const [rows]=await pool.execute('SELECT action,details_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.action,...json(r.details_json),createdAt:r.created_at})); }
  async function appendActivity({event,slotId,details={}}) { await pool.execute('INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,?,?)', [slotId || null,event,JSON.stringify(details)]); }
  async function setAutomationEnabled(enabled, adminId) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[current]] = await c.query('SELECT settings_json,automation_enabled FROM settings WHERE id=1 FOR UPDATE');
      const settings = json(current?.settings_json);
      if (enabled) {
        const [[integration]] = await c.query('SELECT status,profile_id,account_id,model FROM integration_config WHERE id=1 FOR UPDATE');
        if (integration?.status !== 'ACTIVE' || !integration.profile_id || !integration.account_id || !integration.model
          || settings.profileId !== integration.profile_id || settings.targetAccountId !== integration.account_id) {
          throw Object.assign(new Error('INTEGRATION_NOT_READY'), { code: 'INTEGRATION_NOT_READY', status: 409 });
        }
        const [[unsettled]] = await c.query("SELECT id FROM slots WHERE status IN ('publishing','unknown') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')) LIMIT 1 FOR UPDATE");
        if (unsettled) throw Object.assign(new Error('RECONCILIATION_REQUIRED'), { code: 'RECONCILIATION_REQUIRED', status: 409 });
      }
      const changed = Boolean(current?.automation_enabled) !== enabled;
      let firstPostAt = settings.nextSlotAt || null;
      let immediate = false;
      if (enabled && changed) {
        const checked = validateSettings({ ...settings, schedule: settings.schedule || {} });
        if (!checked.valid) throw Object.assign(new Error('INVALID_SETTINGS'), { code: 'INVALID_SETTINGS' });
        const now = new Date();
        firstPostAt = now.toISOString();
        immediate = true;
        settings.schedule = checked.settings.schedule;
        settings.onboardingComplete = true;
        settings.automationSessionId = randomUUID();
        settings.nextSlotAt = firstPostAt;
        settings.activationFirstPostAt = firstPostAt;
        await c.execute("UPDATE slots SET status='canceled',error_code='automation_reactivated',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");
        await c.execute('UPDATE settings SET settings_json=?,automation_enabled=TRUE WHERE id=1', [JSON.stringify(settings)]);
      } else if (!enabled) {
        await c.execute("UPDATE slots SET status='canceled',error_code='automation_paused',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");
        delete settings.nextSlotAt;
        delete settings.activationFirstPostAt;
        delete settings.automationSessionId;
        firstPostAt = null;
        await c.execute('UPDATE settings SET settings_json=?,automation_enabled=FALSE WHERE id=1', [JSON.stringify(settings)]);
      }
      if (changed) await audit(c, adminId, enabled ? 'automation.enabled' : 'automation.paused', {});
      await c.commit();
      return { changed, firstPostAt, immediate, sessionId: enabled ? settings.automationSessionId : null };
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function setProviderTarget({accountId,profileId}) { const c=await pool.getConnection();try{await c.beginTransaction();const [[row]]=await c.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');const settings=json(row?.settings_json);const changed=(settings.targetAccountId||null)!==(accountId||null)||(settings.profileId||null)!==(profileId||null);settings.targetAccountId=accountId||null;settings.profileId=profileId||null;if(changed){settings.onboardingComplete=false;delete settings.nextSlotAt;delete settings.activationFirstPostAt;delete settings.automationSessionId;await c.execute("UPDATE slots SET status='canceled',error_code='account_reconfigured',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");}await c.execute('UPDATE settings SET settings_json=?,automation_enabled=IF(?,FALSE,automation_enabled) WHERE id=1',[JSON.stringify(settings),changed]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();} }
  async function ensureDueSlot({scheduledAt,sessionId}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]]=await c.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      const settings=json(state?.settings_json);
      const [[integration]]=await c.query('SELECT version,status,profile_id,account_id,model FROM integration_config WHERE id=1 FOR UPDATE');
      if(integration?.status!=='ACTIVE'||!integration.profile_id||!integration.account_id||!integration.model||settings.profileId!==integration.profile_id||settings.targetAccountId!==integration.account_id){await c.rollback();return null;}
      if(sessionId===undefined)sessionId=settings.automationSessionId||null;
      const id=randomUUID();
      await c.execute("INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,'pending',?,?,?)",[id,scheduledAt,sessionId,integration.profile_id,integration.account_id,integration.version]);
      const [rows]=await c.execute('SELECT * FROM slots WHERE scheduled_at=? AND automation_session_id <=> ?',[scheduledAt,sessionId]);
      await c.commit();return rows[0]||null;
    }catch(error){await c.rollback();throw error;}finally{c.release();}
  }
  async function claimDueSlot({ now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]] = await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const [[integration]] = await c.query('SELECT version,status,profile_id,account_id,model FROM integration_config WHERE id=1 FOR UPDATE');
      const settings = json(state?.settings_json);
      const knowledge = json(state?.knowledge_json);
      const validated = validateSettings({ ...settings, brand: knowledge.brand || settings.brand, guardrails: knowledge.guardrails || settings.guardrails });
      const sessionId = settings.automationSessionId;
      if (!state?.automation_enabled || !sessionId || settings.onboardingComplete !== true || !settings.targetAccountId || !validated.valid
        || integration?.status !== 'ACTIVE' || !integration.model || settings.profileId !== integration.profile_id || settings.targetAccountId !== integration.account_id) {
        await c.rollback();
        return null;
      }
      const [[inFlight]] = await c.execute("SELECT id FROM slots WHERE automation_session_id=? AND (status IN ('generating','publishing','unknown') OR (status='ready' AND claimed_at>=DATE_SUB(?,INTERVAL 10 MINUTE))) LIMIT 1 FOR UPDATE", [sessionId, now]);
      if (inFlight) { await c.commit(); return null; }
      const [rows] = await c.execute("SELECT id,scheduled_at,status,request_payload,idempotency_key,caption,pillar,fact_bearing,fact_ids,fact_versions,content_safety_hash,automation_session_id,tebar_profile_id,tebar_account_id,tebar_config_version,model_config_version,openrouter_model FROM slots WHERE automation_session_id=? AND ((status='pending' AND scheduled_at<=?) OR (status='ready' AND scheduled_at<=? AND (claimed_at IS NULL OR claimed_at<DATE_SUB(?,INTERVAL 10 MINUTE)))) ORDER BY scheduled_at LIMIT 1 FOR UPDATE", [sessionId, now, now, now]);
      if (!rows.length) { await c.commit(); return null; }
      const slot = rows[0];
      if (!slot.tebar_profile_id || !slot.tebar_account_id || slot.tebar_profile_id !== integration.profile_id || slot.tebar_account_id !== integration.account_id) {
        await c.execute("UPDATE slots SET status='canceled',error_code='target_snapshot_missing',completed_at=UTC_TIMESTAMP(3) WHERE id=? AND status IN ('pending','ready')", [slot.id]);
        await c.commit();
        return null;
      }
      const [[last]] = await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId, slot.id]);
      const cadenceMs = validated.settings.schedule.intervalMinutes * 60_000;
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < cadenceMs) {
        // Keep this slot due until the publication-time cooldown elapses.
        await c.commit();
        return null;
      }
      const activationFirstPostAt = settings.activationFirstPostAt ? new Date(settings.activationFirstPostAt).getTime() : NaN;
      if (Number.isFinite(activationFirstPostAt) && activationFirstPostAt === new Date(slot.scheduled_at).getTime()) {
        delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(settings)]);
      }
      if (slot.status === 'pending') await c.execute("UPDATE slots SET status='generating',claimed_at=?,openrouter_model=?,model_config_version=? WHERE id=? AND status='pending'", [now, integration.model, integration.version, slot.id]);
      else await c.execute("UPDATE slots SET claimed_at=? WHERE id=? AND status='ready'", [now, slot.id]);
      await c.commit();
      return { id: slot.id, automationSessionId: slot.automation_session_id, scheduledAt: slot.scheduled_at, status: slot.status, requestPayload: json(slot.request_payload), idempotencyKey: slot.idempotency_key, caption: slot.caption, pillar: slot.pillar, factBearing: Boolean(slot.fact_bearing), factIds: json(slot.fact_ids, []), factVersions: json(slot.fact_versions, []), contentSafetyHash: slot.content_safety_hash, profileId: slot.tebar_profile_id, accountId: slot.tebar_account_id, configVersion: slot.tebar_config_version, model: slot.status === 'pending' ? integration.model : slot.openrouter_model, modelVersion: slot.status === 'pending' ? integration.version : slot.model_config_version };
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function ensureNextDueSlot({now=new Date(),timezone='Asia/Kuala_Lumpur',schedule}={}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[row]]=await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const [[integration]]=await c.query('SELECT version,status,profile_id,account_id,model FROM integration_config WHERE id=1 FOR UPDATE');
      const settings=json(row?.settings_json);const knowledge=json(row?.knowledge_json);
      const sessionId=settings.automationSessionId;
      const savedSchedule=settings.schedule||schedule||{};
      const checked=validateSettings({...settings,schedule:savedSchedule,brand:knowledge.brand||settings.brand,guardrails:knowledge.guardrails||settings.guardrails});
      if(!row?.automation_enabled||!sessionId||settings.onboardingComplete!==true||!settings.targetAccountId||!checked.valid||integration?.status!=='ACTIVE'||!integration.model||settings.profileId!==integration.profile_id||settings.targetAccountId!==integration.account_id){await c.commit();return {slot:null,created:false,skippedCount:0};}
      const scheduleChanged=JSON.stringify(settings.schedule||{})!==JSON.stringify(checked.settings.schedule);
      settings.schedule=checked.settings.schedule;
      if(scheduleChanged)await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      const zone=savedSchedule.timezone||timezone;
      const intervalMinutes=checked.settings.schedule.intervalMinutes;
      const addInterval=(value)=>{
        const result=value.plus({minutes:intervalMinutes});
        if(!result.isValid)throw Object.assign(new Error('INVALID_SCHEDULE_TIMESTAMP'),{code:'invalid_schedule_timestamp'});
        return result;
      };
      let activationFirstPostAt=typeof settings.activationFirstPostAt==='string'?DateTime.fromISO(settings.activationFirstPostAt,{zone:'utc'}):null;
      const current=DateTime.fromJSDate(now instanceof Date?now:new Date(now),{zone:'utc'});
      if(!current.isValid){await c.rollback();return {slot:null,created:false,skippedCount:0};}
      const [staleGenerations]=await c.execute("SELECT id FROM slots WHERE automation_session_id=? AND status='generating' AND claimed_at < DATE_SUB(?, INTERVAL 10 MINUTE) FOR UPDATE",[sessionId,current.toJSDate()]);
      for(const stale of staleGenerations){
        await c.execute("UPDATE slots SET status='failed',error_code='stale_generation',completed_at=? WHERE id=? AND automation_session_id=? AND status='generating'",[current.toJSDate(),stale.id,sessionId]);
        await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'ai_generation_failed',?)",[stale.id,JSON.stringify({code:'generation_failed',reason:'stale_generation',attempts:0})]);
      }
      const failedSlotDetails=staleGenerations.map((slot)=>({id:slot.id,diagnosticCode:'stale_generation'}));
      const failedSlotIds=failedSlotDetails.map((slot)=>slot.id);
      const [[lastPost]]=await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",[sessionId]);
      let skippedCount=0;
      const [[pendingSlot]]=await c.execute("SELECT id,scheduled_at,status,automation_session_id FROM slots WHERE automation_session_id=? AND status='pending' ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[sessionId]);
      if(pendingSlot){
        let pendingAt=DateTime.fromJSDate(new Date(pendingSlot.scheduled_at),{zone:'utc'});
        const isActivationFirstSlot=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===pendingAt.toMillis();
        if(lastPost?.last_post_at){
          const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
          if(lastAt.isValid){
            const earliest=addInterval(lastAt);
            if(earliest>pendingAt){
              pendingAt=earliest;
              for(let i=0;i<100;i++){
                const scheduledAt=pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
                const [[conflict]]=await c.execute('SELECT id FROM slots WHERE automation_session_id=? AND scheduled_at=? AND id<>? LIMIT 1 FOR UPDATE',[sessionId,scheduledAt,pendingSlot.id]);
                if(!conflict)break;
                pendingAt=addInterval(pendingAt);
                if(i===99)throw Object.assign(new Error('SCHEDULE_SLOT_CONFLICT'),{code:'schedule_slot_conflict'});
              }
              await c.execute('UPDATE slots SET scheduled_at=? WHERE id=? AND automation_session_id=?',[pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS'),pendingSlot.id,sessionId]);
            }
          }
        }
        if(!settings.nextSlotAt){settings.nextSlotAt=addInterval(pendingAt).toUTC().toISO();await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);}
        if(pendingAt>current){
          await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};
        }
        const active=isInActiveWindow(pendingAt.toJSDate(),{...checked.settings.schedule,timezone:zone});
        if(isActivationFirstSlot||(active&&isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone})&&current.toMillis()-pendingAt.toMillis()<=15*60*1000)){await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount:0,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};}
        await c.execute("UPDATE slots SET status='skipped',error_code=?,completed_at=? WHERE id=? AND automation_session_id=?",[active?'missed_slot':'outside_active_window',current.toJSDate(),pendingSlot.id,sessionId]);skippedCount++;
        if(isActivationFirstSlot){delete settings.activationFirstPostAt;activationFirstPostAt=null;await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);}
      }
      let due=settings.nextSlotAt?DateTime.fromISO(settings.nextSlotAt,{zone:'utc'}):addInterval(current);
      if(!due.isValid)due=addInterval(current);
      let isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
      if(lastPost?.last_post_at){
        const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
        if(lastAt.isValid){const earliest=addInterval(lastAt);if(earliest>due){due=earliest;isActivationFirstDue=false;}}
      }
      for(let i=0;i<100;i++){
        isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
        const scheduledAt=due.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
        const active=isInActiveWindow(due.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const lateBy=current.toMillis()-due.toMillis();
        const stale=lateBy>15*60*1000;
        const activeNow=isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const status=isActivationFirstDue||active&&(due>current||activeNow)&&!stale?'pending':'skipped';
        const [insert]=await c.execute('INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status,error_code,completed_at,tebar_profile_id,tebar_account_id,tebar_config_version) VALUES (?,?,?,?,?,?,?,?,?)',[randomUUID(),scheduledAt,sessionId,status,status==='skipped'?(active?'missed_slot':'outside_active_window'):null,status==='skipped'?current.toJSDate():null,integration.profile_id,integration.account_id,integration.version]);
        skippedCount+=status==='skipped'&&insert.affectedRows===1?1:0;
        const [[existing]]=await c.execute('SELECT id,status,scheduled_at FROM slots WHERE automation_session_id=? AND scheduled_at=?',[sessionId,scheduledAt]);
        due=addInterval(due);
        settings.nextSlotAt=due.toUTC().toISO();
        if(isActivationFirstDue&&status!=='pending')delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
        if(status==='pending'){await c.commit();return {slot:{id:existing.id,automationSessionId:sessionId,scheduledAt:existing.scheduled_at,status:existing.status},created:insert.affectedRows===1,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};}
      }
      if(settings.nextSlotAt) await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      await c.commit();
      return {slot:null,created:false,skippedCount,failedSlotIds,failedSlotDetails,failedCount:failedSlotIds.length};
    } catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function savePreparedSlot(id,{requestPayload,idempotencyKey,caption,pillar,factBearing=false,factIds=[],factVersions=[],contentSafetyHash=null}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]]=await c.query('SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE');
      const sessionId=json(state?.settings_json).automationSessionId;
      const [[slot]]=await c.execute('SELECT automation_session_id,status FROM slots WHERE id=? FOR UPDATE',[id]);
      if(!state?.automation_enabled||!sessionId||slot?.automation_session_id!==sessionId||slot?.status!=='generating') { await c.rollback(); return false; }
      const [updated]=await c.execute("UPDATE slots SET status='ready',request_payload=?,idempotency_key=?,caption=?,pillar=?,fact_bearing=?,fact_ids=?,fact_versions=?,content_safety_hash=? WHERE id=? AND automation_session_id=? AND status='generating'",[JSON.stringify(requestPayload),idempotencyKey,caption,pillar,Boolean(factBearing),JSON.stringify(factIds),JSON.stringify(factVersions),contentSafetyHash,id,sessionId]);
      await c.commit();
      return updated.affectedRows===1;
    } catch(error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function startPublishing(id, { now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[settings]] = await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const [[integration]] = await c.query('SELECT status,profile_id,account_id FROM integration_config WHERE id=1 FOR UPDATE');
      const sessionId=json(settings?.settings_json).automationSessionId;
      const [[slot]] = await c.execute('SELECT scheduled_at,status,automation_session_id,fact_bearing,fact_ids,fact_versions,content_safety_hash,tebar_profile_id,tebar_account_id,request_payload FROM slots WHERE id=? FOR UPDATE', [id]);
      const payload = json(slot?.request_payload);
      if (!slot || slot.status !== 'ready' || !settings?.automation_enabled || !sessionId || slot.automation_session_id!==sessionId
        || integration?.status !== 'ACTIVE' || !slot.tebar_profile_id || !slot.tebar_account_id
        || slot.tebar_profile_id !== integration.profile_id || slot.tebar_account_id !== integration.account_id
        || payload?.targets?.length !== 1 || payload.targets[0]?.account_id !== slot.tebar_account_id) { await c.rollback(); return false; }
      const [[otherInFlight]] = await c.execute("SELECT id FROM slots WHERE automation_session_id=? AND id<>? AND (status IN ('generating','publishing','unknown') OR (status='ready' AND claimed_at>=DATE_SUB(?,INTERVAL 10 MINUTE))) LIMIT 1 FOR UPDATE", [sessionId, id, now]);
      if (otherInFlight) {
        await c.execute("UPDATE slots SET claimed_at=NULL WHERE id=? AND status='ready'", [id]);
        await c.commit();
        return 'in_flight';
      }
      const config = json(settings.settings_json);
      const knowledge = json(settings.knowledge_json);
      const currentHash = contentSafetyHash({ ...config, brand: knowledge.brand || config.brand, guardrails: knowledge.guardrails || config.guardrails });
      const previousHash = legacyContentSafetyHash({ ...config, brand: knowledge.brand || config.brand, guardrails: knowledge.guardrails || config.guardrails });
      if (!slot.content_safety_hash || !currentHash || ![currentHash, previousHash].includes(slot.content_safety_hash)) {
        await c.rollback(); return 'stale_facts';
      }
      const ids = json(slot.fact_ids, []);
      const versions = json(slot.fact_versions, []);
      if (!Array.isArray(ids) || !Array.isArray(versions)
        || (slot.fact_bearing && !ids.length)
        || new Set(ids.map(String)).size !== ids.length
        || new Set(versions.map((version) => String(version?.id))).size !== versions.length
        || ids.some((id) => !versions.some((version) => version?.id === id))
        || versions.some((version) => !version || !version.id || !version.updatedAt)) {
        await c.rollback(); return 'stale_facts';
      }
      for (const version of versions) {
        const [[fact]] = await c.execute('SELECT service,active,updated_at FROM service_facts WHERE service=? FOR UPDATE', [version.id]);
        const sourceTime = fact?.updated_at ? new Date(fact.updated_at).getTime() : NaN;
        const expectedTime = new Date(version.updatedAt).getTime();
        if (!fact || !isFactFresh({ active: Boolean(fact.active), updatedAt: fact.updated_at }, now)
          || !Number.isFinite(expectedTime) || sourceTime !== expectedTime) {
          await c.rollback(); return 'stale_facts';
        }
      }
      const [[last]] = await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId,id]);
      const checkedSettings = validateSettings({ ...config, brand: knowledge.brand || config.brand, guardrails: knowledge.guardrails || config.guardrails });
      if (!checkedSettings.valid) { await c.rollback(); return 'stale_facts'; }
      const cadenceMs = checkedSettings.settings.schedule.intervalMinutes * 60_000;
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < cadenceMs) {
        await c.execute("UPDATE slots SET claimed_at=NULL WHERE id=? AND status='ready'", [id]);
        await c.commit();
        return 'minimum_cadence';
      }
      await c.execute("UPDATE slots SET status='publishing',publish_started_at=? WHERE id=? AND automation_session_id=? AND status='ready'", [now, id,sessionId]);
      await c.commit();
      return true;
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function isAutomationSessionActive(sessionId) {
    if(!sessionId)return false;
    const [[state]]=await pool.execute('SELECT automation_enabled,settings_json FROM settings WHERE id=1');
    return Boolean(state?.automation_enabled)&&json(state?.settings_json).automationSessionId===sessionId;
  }
  async function suppressPendingNotices(connection,id,status) {
    if(!['published','failed','partial','canceled'].includes(status))return;
    const keys=['unknown_outcome',...(status==='published'?['provider_error','generation_failed','content_validation_failed']:[])].map(code=>createHash('sha256').update(`${code}:slot:${id}`).digest('hex'));
    for(const key of keys) await connection.execute("UPDATE notification_outbox SET status='failed',last_error_code='superseded' WHERE dedupe_key=? AND status='pending'",[key]);
  }
  async function updateSlot(id,patch) {
    const allowed={status:'status',providerPostId:'provider_post_id',providerStatus:'provider_status',errorCode:'error_code',cancellationStatus:'cancellation_status',completedAt:'completed_at'};
    const keys=Object.keys(patch).filter(k=>allowed[k]);if(!keys.length)return;
    const sql=keys.map(k=>`${allowed[k]}=?`).join(',');
    const values=[...keys.map(k=>k==='completedAt'?normalizeCompletedAt(patch[k]):patch[k]),id];
    const guarded=typeof patch.status==='string';
    const conflictGuard = guarded && patch.status !== 'published'
      ? " AND NOT (status='unknown' AND COALESCE(error_code,'')='provider_status_conflict')" : '';
    const where=guarded?` WHERE id=? AND (status NOT IN ('published','failed','partial','canceled','skipped') OR status=?)${conflictGuard}`:' WHERE id=?';
    if(guarded)values.push(patch.status);
    if(!['published','failed','partial','canceled'].includes(patch.status)){const [updated]=await pool.execute(`UPDATE slots SET ${sql}${where}`,values);return updated.affectedRows>0;}
    const c=await pool.getConnection();try{
      await c.beginTransaction();
      const [updated]=await c.execute(`UPDATE slots SET ${sql}${where}`,values);
      if(updated.affectedRows) await suppressPendingNotices(c,id,patch.status);
      else if(patch.status==='published') {
        // A publication conflicting with an earlier terminal result is not safe
        // to discard: require another provider reconciliation before reporting it.
        await c.execute("UPDATE slots SET status='unknown',provider_status='unknown',error_code='provider_status_conflict',completed_at=NULL WHERE id=? AND status IN ('failed','partial','canceled','skipped')",[id]);
      }
      await c.commit();
      return updated.affectedRows>0;
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function getUncertainSlots() { const [rows]=await pool.execute("SELECT id,automation_session_id,provider_post_id,request_payload,idempotency_key,status,tebar_profile_id,tebar_account_id FROM slots WHERE status IN ('unknown','publishing') ORDER BY scheduled_at");return rows.map(r=>({...r,id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,profileId:r.tebar_profile_id,accountId:r.tebar_account_id})); }
  async function listUnsettledSlots() { const [rows]=await pool.execute("SELECT id,automation_session_id,provider_post_id,provider_status,request_payload,idempotency_key,status,caption,pillar,scheduled_at,completed_at,tebar_profile_id,tebar_account_id FROM slots WHERE status IN ('unknown','publishing') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')) ORDER BY scheduled_at");return rows.map(r=>({id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,providerStatus:r.provider_status,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,status:r.status,caption:r.caption,pillar:r.pillar,scheduledAt:r.scheduled_at,completedAt:r.completed_at,profileId:r.tebar_profile_id,accountId:r.tebar_account_id})); }
  async function recordCancellation(providerPostId,{status,errorCode}={}) {
    const c=await pool.getConnection();let updated;
    try {
      await c.beginTransaction();
      const where="provider_post_id=? AND status NOT IN ('published','failed','partial','skipped') AND NOT (status='unknown' AND COALESCE(error_code,'')='provider_status_conflict')";
      const [slots]=await c.execute(`SELECT id FROM slots WHERE ${where} FOR UPDATE`,[providerPostId]);
      [updated]=await c.execute(`UPDATE slots SET cancellation_status=?,error_code=COALESCE(?,error_code),status=IF(?='canceled','canceled',status),provider_status=IF(?='canceled','canceled',provider_status),completed_at=IF(?='canceled',UTC_TIMESTAMP(3),completed_at) WHERE ${where}`,[status,errorCode??null,status,status,status,providerPostId]);
      if(status==='canceled') for(const slot of slots) await suppressPendingNotices(c,slot.id,status);
      await c.commit();
    } catch(e) { await c.rollback();throw e; } finally { c.release(); }
    await appendActivity({event:'post_cancellation',details:{status:updated.affectedRows?status:'unresolved',errorCode:errorCode||null}});return updated.affectedRows>0;
  }
  async function getDailySummaryCounts(date,timezone) {
    const start=DateTime.fromISO(`${date}T00:00:00`,{zone:timezone});
    if(!start.isValid) throw new Error('INVALID_SUMMARY_DATE');
    const from=start.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');const to=start.plus({days:1}).toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
    const [rows]=await pool.execute("SELECT id,status,pillar,error_code FROM slots WHERE COALESCE(completed_at,scheduled_at)>=? AND COALESCE(completed_at,scheduled_at)<?",[from,to]);
    const result={published:0,failed:0,unknown:0,skipped:0,categories:{},failures:{},affectedSlotIds:[]};
    for(const row of rows){
      if(row.status==='published'){result.published++;if(row.pillar)result.categories[row.pillar]=(result.categories[row.pillar]||0)+1;}
      else if(['failed','partial'].includes(row.status)){result.failed++;const code=row.error_code||'provider_error';result.failures[code]=(result.failures[code]||0)+1;result.affectedSlotIds.push(row.id);}
      else if(['unknown','publishing'].includes(row.status)){result.unknown++;result.affectedSlotIds.push(row.id);}
      else if(row.status==='skipped')result.skipped++;
    }
    result.failures=Object.entries(result.failures).map(([code,count])=>({code,count}));
    return result;
  }
  async function reserveDailySummary(date,timezone) { const [insert]=await pool.execute("INSERT IGNORE INTO daily_summaries (local_date,timezone,status,created_at) VALUES (?,?,'sending',UTC_TIMESTAMP(3))",[date,timezone]);if(insert.affectedRows===1)return true;const [claim]=await pool.execute("UPDATE daily_summaries SET status='sending',created_at=UTC_TIMESTAMP(3) WHERE local_date=? AND timezone=? AND (status='failed' OR (status='sending' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)))",[date,timezone]);return claim.affectedRows===1; }
  async function completeDailySummary(date,timezone,status='sent') { await pool.execute('UPDATE daily_summaries SET status=?,sent_at=IF(?=\'sent\',UTC_TIMESTAMP(3),sent_at) WHERE local_date=? AND timezone=?',[status,status,date,timezone]); }
  async function recordWebhookEvent(eventId,payloadHash) { try{await pool.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]);return true;}catch(e){if(e.code==='ER_DUP_ENTRY')return false;throw e;} }
  async function applyWebhookEvent({eventId,payloadHash,type,profileId,data,accountId,notificationCode}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      try { await c.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]); }
      catch(e) { if(e.code==='ER_DUP_ENTRY'){await c.rollback();return false;} throw e; }
      const [[settingsRow]]=await c.query('SELECT settings_json,knowledge_json,automation_enabled FROM settings WHERE id=1');
      const configured=json(settingsRow?.settings_json);
      const knowledge=json(settingsRow?.knowledge_json);
      const eventType=String(type||'');
      const dataAccount=data.account_id||data.target?.account_id||data.account?.id;
      const postId=data.post_id||data.id;
      const [[eventSlot]]=typeof postId==='string'&&eventType.startsWith('post.')
        ? await c.execute('SELECT id,automation_session_id,status,provider_status,tebar_profile_id,tebar_account_id FROM slots WHERE provider_post_id=? LIMIT 1 FOR UPDATE',[postId]) : [[]];
      const postMatches=Boolean(eventSlot?.tebar_profile_id && eventSlot?.tebar_account_id
        && eventSlot.tebar_profile_id===profileId && eventSlot.tebar_account_id===dataAccount);
      const expectedAccount=eventSlot?.tebar_account_id;
      const webhookPublishedAt=(()=>{
        const targetMatches= data.target?.account_id===expectedAccount
          && (!data.target?.platform||String(data.target.platform).toLowerCase()==='threads');
        const value=data.published_at||(targetMatches?data.target?.published_at:null);
        if(typeof value!=='string'&&!(value instanceof Date))return null;
        const parsed=new Date(value);
        return Number.isFinite(parsed.getTime())?parsed:null;
      })();
      let activeSessionCanceledPost=false;
      let staleTerminalCancellation=false;
      if(postMatches) {
        const status=String(data.status||eventType.split('.').at(-1)).toLowerCase();
        const mapped={published:'published',failed:'failed',partial:'partial',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};
        const providerStatus=mapped[status]||'unknown';
        const slot=eventSlot;
        const terminalStatuses=['published','failed','partial','canceled','skipped'];
        const slotIsTerminal=terminalStatuses.includes(slot?.status);
        const conflictingPublication=slotIsTerminal&&slot.status!=='published'&&providerStatus==='published';
        const delayedNonterminal=slotIsTerminal&&(!['published','failed','partial','canceled'].includes(providerStatus) || (slot.provider_status && providerStatus!==slot.provider_status));
        staleTerminalCancellation=slotIsTerminal&&providerStatus==='canceled';
        if(conflictingPublication) {
          await c.execute("UPDATE slots SET status='unknown',provider_status='unknown',error_code='provider_status_conflict',completed_at=NULL WHERE id=?",[slot.id]);
          await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'provider_status_conflict',?)",[slot.id,JSON.stringify({code:'unknown_outcome'})]);
        } else if(!delayedNonterminal&&!staleTerminalCancellation) {
          const activeSession=Boolean(settingsRow?.automation_enabled)&&slot?.automation_session_id===configured.automationSessionId;
          activeSessionCanceledPost=providerStatus==='canceled'&&activeSession;
          const slotStatus=activeSessionCanceledPost?'failed':providerStatus;
          const final=['published','failed','partial','canceled'].includes(slotStatus);
          const completedAt=providerStatus==='published'?webhookPublishedAt:null;
          await c.execute('UPDATE slots SET provider_status=?,status=?,error_code=IF(?,\'provider_error\',error_code),completed_at=IF(?,COALESCE(?,UTC_TIMESTAMP(3)),completed_at) WHERE provider_post_id=?',[providerStatus,slotStatus,activeSessionCanceledPost,final,completedAt,postId]);
          if(slot && final) await suppressPendingNotices(c,slot.id,slotStatus);
        }
      }
      if(notificationCode&&(eventType.startsWith('post.') ? postMatches : profileId===configured.profileId&&dataAccount===configured.targetAccountId)) {
        let dedupeId=`tebar:${eventId}`;
        let message=`Kedai Merzz automation: ${notificationCode}. Semak status akaun dan log dashboard.`;
        if(notificationCode==='provider_error'&&String(data.status||eventType.split('.').at(-1)).toLowerCase()==='canceled'&&(!activeSessionCanceledPost||staleTerminalCancellation)) message=null;
        if(eventType.startsWith('post.')) {
          const [[slot]]=await c.execute('SELECT id,status,caption,pillar,scheduled_at,completed_at,error_code FROM slots WHERE provider_post_id=? LIMIT 1',[postId]);
          const expectedStatus=notificationCode==='post_published'?'published':'failed';
          if(slot && (slot.status===expectedStatus || (expectedStatus==='failed' && slot.status==='partial')) && message) {
            dedupeId=`${notificationCode}:slot:${slot.id}`;
            message=formatSlotNotice({status:expectedStatus,slotId:slot.id,brand:knowledge.brand?.name||configured.brand?.name,
              time:slot.completed_at||slot.scheduled_at,timezone:configured.schedule?.timezone,pillar:slot.pillar,caption:slot.caption,
              reason:slot.error_code||'provider_error',nextAt:settingsRow?.automation_enabled?configured.nextSlotAt:null});
          } else message=null;
        }
        if(message) {
          const dedupeKey=createHash('sha256').update(dedupeId).digest('hex');
          await c.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)',[dedupeKey,message]);
        }
      }
      await c.commit();
      return true;
    } catch(e) { await c.rollback();throw e; }
    finally { c.release(); }
  }
  async function enqueueNotification({dedupeKey,message}) {
    if(!/^[a-f0-9]{64}$/.test(dedupeKey)||typeof message!=='string'||!message.trim()||message.length>4096)throw Object.assign(new Error('INVALID_NOTIFICATION'),{code:'INVALID_NOTIFICATION'});
    const [result]=await pool.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)',[dedupeKey,message]);
    return result.affectedRows===1;
  }
  async function getNotificationStatus(dedupeKey) { const [rows]=await pool.execute('SELECT status FROM notification_outbox WHERE dedupe_key=?',[dedupeKey]);return rows[0]?.status||null; }
  async function claimNotifications(limit=25) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      await c.execute("UPDATE notification_outbox SET status='failed',claimed_at=NULL,last_error_code='retry_limit' WHERE status='sending' AND attempts>=8 AND claimed_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)");
      const [rows]=await c.execute("SELECT id,message,attempts FROM notification_outbox WHERE attempts<8 AND ((status='pending' AND available_at<=UTC_TIMESTAMP(3)) OR (status='sending' AND claimed_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE))) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",[Math.max(1,Math.min(100,Number(limit)||25))]);
      for(const row of rows)await c.execute("UPDATE notification_outbox SET status='sending',attempts=attempts+1,claimed_at=UTC_TIMESTAMP(3) WHERE id=?",[row.id]);
      await c.commit();
      return rows.map(row=>({...row,attempts:Number(row.attempts)+1}));
    } catch(e) { await c.rollback();throw e; }
    finally { c.release(); }
  }
  async function markNotificationSent(id) { await pool.execute("UPDATE notification_outbox SET status='sent',sent_at=UTC_TIMESTAMP(3),claimed_at=NULL,last_error_code=NULL WHERE id=? AND status='sending'",[id]); }
  async function retryNotification(id,errorCode) { await pool.execute("UPDATE notification_outbox SET status=IF(attempts>=8,'failed','pending'),available_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL LEAST(3600,15*POW(2,GREATEST(attempts-1,0))) SECOND),claimed_at=NULL,last_error_code=? WHERE id=? AND status='sending'",[String(errorCode).slice(0,64),id]); }
  async function claimDailySummary({localDate,timezone}) { return reserveDailySummary(localDate,timezone); }
  async function getDailySummary({localDate,timezone}) { return getDailySummaryCounts(localDate,timezone); }
  async function finishDailySummary({localDate,timezone,status}) { return completeDailySummary(localDate,timezone,status); }
  async function updateSlotFromProvider(providerPostId,status,details={}) { const [rows]=await pool.execute('SELECT id FROM slots WHERE provider_post_id=? LIMIT 1',[providerPostId]);if(!rows.length)return false;const map={published:'published',partial:'partial',failed:'failed',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};await updateSlot(rows[0].id,{providerStatus:status,...(map[status]?{status:map[status]}:{}),...(map[status]&&['published','partial','failed','canceled'].includes(map[status])?{completedAt:new Date()}: {})});return true; }
  return { healthCheck,getSettings,getRuntimeState,saveSettings,saveKnowledge,listFacts,saveFact,getAdminByEmail,getLoginAttemptCounts,reserveLoginAttempt,releaseLoginReservation,listAdmins,listTemplates,getTemplate,createTemplate,updateTemplate,deleteTemplate,createAdmin,updateAdmin,createSession,getSession,deleteSession,deleteAdminSessions,listSlots,listActivity,listAudit,appendActivity,setAutomationEnabled,setProviderTarget,ensureDueSlot,ensureNextDueSlot,claimDueSlot,savePreparedSlot,startPublishing,isAutomationSessionActive,updateSlot,getUncertainSlots,listUnsettledSlots,recordCancellation,getDailySummaryCounts,reserveDailySummary,completeDailySummary,claimDailySummary,getDailySummary,finishDailySummary,recordWebhookEvent,applyWebhookEvent,updateSlotFromProvider,enqueueNotification,getNotificationStatus,claimNotifications,markNotificationSent,retryNotification };
}

module.exports={createRepository};
