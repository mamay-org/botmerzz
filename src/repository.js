const { randomUUID, createHash } = require('node:crypto');
const { DateTime } = require('luxon');
const { isInActiveWindow, validateSettings } = require('./policy');

const json = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeId = (value) => String(value);
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
    return { ...settings, schedule: { ...(settings.schedule || {}), intervalHours: 1 }, brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {}, automationEnabled: Boolean(row.automation_enabled) };
  }
  async function getRuntimeState() {
    const [rows] = await pool.execute('SELECT settings_json, knowledge_json, automation_enabled FROM settings WHERE id=1');
    const row = rows[0] || {};
    const settings = json(row.settings_json);
    const knowledge = json(row.knowledge_json);
    const facts = await listFacts();
    const history = await listSlots(1000);
    const factRows = Object.entries(facts).map(([service, fact]) => ({ ...fact.summary, id: service, pillar: service === 'account' ? 'account' : 'topup', active: fact.active, updatedAt: fact.updatedAt }));
    return { settings: { ...settings, schedule: { ...(settings.schedule || {}), intervalHours: 1 }, brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {} }, knowledge, facts: factRows, history, automationEnabled: Boolean(row.automation_enabled), accountId: settings.targetAccountId || null, profileId: settings.profileId || null, onboardingComplete: settings.onboardingComplete === true };
  }
  async function saveSettings(settings, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const safeSettings = { ...settings }; delete safeSettings.automationEnabled;
      if (safeSettings.schedule && typeof safeSettings.schedule === 'object' && !Array.isArray(safeSettings.schedule)) safeSettings.schedule = { ...safeSettings.schedule, intervalHours: 1 };
      const [[existingRow]] = await connection.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      const existing = json(existingRow?.settings_json);
      for (const key of ['targetAccountId','profileId','onboardingComplete','nextSlotAt','automationSessionId']) if (safeSettings[key] === undefined && existing[key] !== undefined) safeSettings[key] = existing[key];
      if (JSON.stringify(existing.schedule || {}) !== JSON.stringify(safeSettings.schedule || {})) delete safeSettings.nextSlotAt;
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
  async function ensureDueSlot({scheduledAt,sessionId}) { if(sessionId===undefined){const [[state]]=await pool.execute('SELECT settings_json FROM settings WHERE id=1');sessionId=json(state?.settings_json).automationSessionId||null;}const id=randomUUID();await pool.execute("INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status) VALUES (?,?,?,'pending')",[id,scheduledAt,sessionId]);const [rows]=await pool.execute('SELECT * FROM slots WHERE scheduled_at=? AND automation_session_id <=> ?',[scheduledAt,sessionId]);return rows[0]||null; }
  async function claimDueSlot({ now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]] = await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const settings = json(state?.settings_json);
      const knowledge = json(state?.knowledge_json);
      const validated = validateSettings({ ...settings, brand: knowledge.brand || settings.brand, guardrails: knowledge.guardrails || settings.guardrails });
      const sessionId = settings.automationSessionId;
      if (!state?.automation_enabled || !sessionId || settings.onboardingComplete !== true || !settings.targetAccountId || !validated.valid) {
        await c.rollback();
        return null;
      }
      const [rows] = await c.execute("SELECT id,scheduled_at,status,request_payload,idempotency_key,caption,pillar,fact_bearing,fact_ids,automation_session_id FROM slots WHERE automation_session_id=? AND ((status='pending' AND scheduled_at<=?) OR (status='ready' AND scheduled_at<=? AND (claimed_at IS NULL OR claimed_at<DATE_SUB(?,INTERVAL 10 MINUTE)))) ORDER BY scheduled_at LIMIT 1 FOR UPDATE", [sessionId, now, now, now]);
      if (!rows.length) { await c.commit(); return null; }
      const slot = rows[0];
      const [[last]] = await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId, slot.id]);
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < 3600000) {
        // Keep this slot due until the publication-time cooldown elapses.
        await c.commit();
        return null;
      }
      const activationFirstPostAt = settings.activationFirstPostAt ? new Date(settings.activationFirstPostAt).getTime() : NaN;
      if (Number.isFinite(activationFirstPostAt) && activationFirstPostAt === new Date(slot.scheduled_at).getTime()) {
        delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(settings)]);
      }
      if (slot.status === 'pending') await c.execute("UPDATE slots SET status='generating',claimed_at=? WHERE id=? AND status='pending'", [now, slot.id]);
      else await c.execute("UPDATE slots SET claimed_at=? WHERE id=? AND status='ready'", [now, slot.id]);
      await c.commit();
      return { id: slot.id, automationSessionId: slot.automation_session_id, scheduledAt: slot.scheduled_at, status: slot.status, requestPayload: json(slot.request_payload), idempotencyKey: slot.idempotency_key, caption: slot.caption, pillar: slot.pillar, factBearing: Boolean(slot.fact_bearing), factIds: json(slot.fact_ids, []) };
    } catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async function ensureNextDueSlot({now=new Date(),timezone='Asia/Kuala_Lumpur',schedule}={}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[row]]=await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const settings=json(row?.settings_json);const knowledge=json(row?.knowledge_json);
      const sessionId=settings.automationSessionId;
      const savedSchedule=settings.schedule||schedule||{};
      const checked=validateSettings({...settings,schedule:savedSchedule,brand:knowledge.brand||settings.brand,guardrails:knowledge.guardrails||settings.guardrails});
      if(!row?.automation_enabled||!sessionId||settings.onboardingComplete!==true||!settings.targetAccountId||!checked.valid){await c.commit();return {slot:null,created:false,skippedCount:0};}
      const scheduleChanged=JSON.stringify(settings.schedule||{})!==JSON.stringify(checked.settings.schedule);
      settings.schedule=checked.settings.schedule;
      if(scheduleChanged)await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      const zone=savedSchedule.timezone||timezone;
      const interval=1;
      let activationFirstPostAt=typeof settings.activationFirstPostAt==='string'?DateTime.fromISO(settings.activationFirstPostAt,{zone:'utc'}):null;
      const current=DateTime.fromJSDate(now instanceof Date?now:new Date(now),{zone:'utc'});
      if(!current.isValid){await c.rollback();return {slot:null,created:false,skippedCount:0};}
      const [staleGenerations]=await c.execute("SELECT id FROM slots WHERE automation_session_id=? AND status='generating' AND claimed_at < DATE_SUB(?, INTERVAL 10 MINUTE) FOR UPDATE",[sessionId,current.toJSDate()]);
      for(const stale of staleGenerations){
        await c.execute("UPDATE slots SET status='failed',error_code='stale_generation',completed_at=? WHERE id=? AND automation_session_id=? AND status='generating'",[current.toJSDate(),stale.id,sessionId]);
        await c.execute("INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,'ai_generation_failed',?)",[stale.id,JSON.stringify({code:'generation_failed',reason:'stale_generation',attempts:0})]);
      }
      const failedSlotIds=staleGenerations.map((slot)=>slot.id);
      const [[lastPost]]=await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",[sessionId]);
      let skippedCount=0;
      const [[pendingSlot]]=await c.execute("SELECT id,scheduled_at,status,automation_session_id FROM slots WHERE automation_session_id=? AND status='pending' ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[sessionId]);
      if(pendingSlot){
        let pendingAt=DateTime.fromJSDate(new Date(pendingSlot.scheduled_at),{zone:'utc'});
        const isActivationFirstSlot=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===pendingAt.toMillis();
        if(lastPost?.last_post_at){
          const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
          const earliest=lastAt.plus({hours:interval});
          if(lastAt.isValid&&earliest>pendingAt){
            pendingAt=earliest;
            for(let i=0;i<100;i++){
              const scheduledAt=pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
              const [[conflict]]=await c.execute('SELECT id FROM slots WHERE automation_session_id=? AND scheduled_at=? AND id<>? LIMIT 1 FOR UPDATE',[sessionId,scheduledAt,pendingSlot.id]);
              if(!conflict)break;
              pendingAt=pendingAt.plus({hours:interval});
              if(i===99)throw Object.assign(new Error('SCHEDULE_SLOT_CONFLICT'),{code:'schedule_slot_conflict'});
            }
            await c.execute('UPDATE slots SET scheduled_at=? WHERE id=? AND automation_session_id=?',[pendingAt.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS'),pendingSlot.id,sessionId]);
          }
        }
        if(pendingAt>current){await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount,failedSlotIds,failedCount:failedSlotIds.length};}
        const active=isInActiveWindow(pendingAt.toJSDate(),{...checked.settings.schedule,timezone:zone});
        if(isActivationFirstSlot||(active&&isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone})&&current.toMillis()-pendingAt.toMillis()<=15*60*1000)){await c.commit();return {slot:{id:pendingSlot.id,automationSessionId:sessionId,scheduledAt:pendingAt.toJSDate(),status:'pending'},created:false,skippedCount:0,failedSlotIds,failedCount:failedSlotIds.length};}
        await c.execute("UPDATE slots SET status='skipped',error_code=?,completed_at=? WHERE id=? AND automation_session_id=?",[active?'missed_slot':'outside_active_window',current.toJSDate(),pendingSlot.id,sessionId]);skippedCount++;
        if(isActivationFirstSlot){delete settings.activationFirstPostAt;activationFirstPostAt=null;await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);}
      }
      let due=settings.nextSlotAt?DateTime.fromISO(settings.nextSlotAt,{zone:'utc'}):current.plus({hours:interval});
      if(!due.isValid)due=current.plus({hours:interval});
      let isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
      if(lastPost?.last_post_at){
        const lastAt=DateTime.fromJSDate(new Date(lastPost.last_post_at),{zone:'utc'});
        const earliest=lastAt.plus({hours:interval});
        if(lastAt.isValid&&earliest>due){due=earliest;isActivationFirstDue=false;}
      }
      for(let i=0;i<100;i++){
        isActivationFirstDue=activationFirstPostAt?.isValid&&activationFirstPostAt.toMillis()===due.toMillis();
        const scheduledAt=due.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
        const active=isInActiveWindow(due.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const lateBy=current.toMillis()-due.toMillis();
        const stale=lateBy>15*60*1000;
        const activeNow=isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const status=isActivationFirstDue||active&&(due>current||activeNow)&&!stale?'pending':'skipped';
        const [insert]=await c.execute('INSERT IGNORE INTO slots (id,scheduled_at,automation_session_id,status,error_code,completed_at) VALUES (?,?,?,?,?,?)',[randomUUID(),scheduledAt,sessionId,status,status==='skipped'?(active?'missed_slot':'outside_active_window'):null,status==='skipped'?current.toJSDate():null]);
        skippedCount+=status==='skipped'&&insert.affectedRows===1?1:0;
        const [[existing]]=await c.execute('SELECT id,status,scheduled_at FROM slots WHERE automation_session_id=? AND scheduled_at=?',[sessionId,scheduledAt]);
        due=due.plus({hours:interval});
        settings.nextSlotAt=due.toUTC().toISO();
        if(isActivationFirstDue&&status!=='pending')delete settings.activationFirstPostAt;
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
        if(status==='pending'){await c.commit();return {slot:{id:existing.id,automationSessionId:sessionId,scheduledAt:existing.scheduled_at,status:existing.status},created:insert.affectedRows===1,skippedCount,failedSlotIds,failedCount:failedSlotIds.length};}
      }
      if(settings.nextSlotAt) await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      await c.commit();
      return {slot:null,created:false,skippedCount,failedSlotIds,failedCount:failedSlotIds.length};
    } catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function savePreparedSlot(id,{requestPayload,idempotencyKey,caption,pillar,factBearing=false,factIds=[]}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[state]]=await c.query('SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE');
      const sessionId=json(state?.settings_json).automationSessionId;
      const [[slot]]=await c.execute('SELECT automation_session_id,status FROM slots WHERE id=? FOR UPDATE',[id]);
      if(!state?.automation_enabled||!sessionId||slot?.automation_session_id!==sessionId||slot?.status!=='generating') { await c.rollback(); return false; }
      const [updated]=await c.execute("UPDATE slots SET status='ready',request_payload=?,idempotency_key=?,caption=?,pillar=?,fact_bearing=?,fact_ids=? WHERE id=? AND automation_session_id=? AND status='generating'",[JSON.stringify(requestPayload),idempotencyKey,caption,pillar,Boolean(factBearing),JSON.stringify(factIds),id,sessionId]);
      await c.commit();
      return updated.affectedRows===1;
    } catch(error) { await c.rollback(); throw error; }
    finally { c.release(); }
  }
  async function startPublishing(id, { now }) {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[settings]] = await c.query('SELECT automation_enabled,settings_json FROM settings WHERE id=1 FOR UPDATE');
      const sessionId=json(settings?.settings_json).automationSessionId;
      const [[slot]] = await c.execute('SELECT scheduled_at,status,automation_session_id FROM slots WHERE id=? FOR UPDATE', [id]);
      if (!slot || slot.status !== 'ready' || !settings?.automation_enabled || !sessionId || slot.automation_session_id!==sessionId) { await c.rollback(); return false; }
      const [[last]] = await c.execute("SELECT completed_at AS last_post_at FROM slots WHERE automation_session_id=? AND status IN ('published','failed','partial') AND completed_at IS NOT NULL AND id<>? ORDER BY completed_at DESC LIMIT 1", [sessionId,id]);
      if (last && new Date(now).getTime() - new Date(last.last_post_at).getTime() < 3600000) {
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
  async function updateSlot(id,patch) { const allowed={status:'status',providerPostId:'provider_post_id',providerStatus:'provider_status',errorCode:'error_code',cancellationStatus:'cancellation_status',completedAt:'completed_at'};const keys=Object.keys(patch).filter(k=>allowed[k]);if(!keys.length)return;const sql=keys.map(k=>`${allowed[k]}=?`).join(',');await pool.execute(`UPDATE slots SET ${sql} WHERE id=?`,[...keys.map(k=>k==='completedAt'?normalizeCompletedAt(patch[k]):patch[k]),id]); }
  async function getUncertainSlots() { const [rows]=await pool.execute("SELECT id,automation_session_id,provider_post_id,request_payload,idempotency_key,status FROM slots WHERE status IN ('unknown','publishing') ORDER BY scheduled_at");return rows.map(r=>({...r,id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key})); }
  async function listUnsettledSlots() { const [rows]=await pool.execute("SELECT id,automation_session_id,provider_post_id,request_payload,idempotency_key,status FROM slots WHERE status IN ('unknown','publishing') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')) ORDER BY scheduled_at");return rows.map(r=>({id:r.id,automationSessionId:r.automation_session_id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,status:r.status})); }
  async function recordCancellation(providerPostId,{status,errorCode}={}) { await pool.execute('UPDATE slots SET cancellation_status=?,error_code=COALESCE(?,error_code),status=IF(?=\'canceled\',\'canceled\',status),completed_at=IF(?=\'canceled\',UTC_TIMESTAMP(3),completed_at) WHERE provider_post_id=?',[status,errorCode,status,status,providerPostId]);await appendActivity({event:'post_cancellation',details:{status,errorCode:errorCode||null}}); }
  async function getDailySummaryCounts(date,timezone) { const start=DateTime.fromISO(`${date}T00:00:00`,{zone:timezone});if(!start.isValid)return {published:0,failed:0,skipped:0};const from=start.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');const to=start.plus({days:1}).toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');const [rows]=await pool.execute('SELECT status,COUNT(*) count FROM slots WHERE scheduled_at>=? AND scheduled_at<? GROUP BY status',[from,to]);const result={published:0,failed:0,skipped:0};for(const row of rows){if(row.status==='published')result.published+=Number(row.count);else if(['failed','partial','unknown'].includes(row.status))result.failed+=Number(row.count);else if(row.status==='skipped')result.skipped+=Number(row.count);}return result; }
  async function reserveDailySummary(date,timezone) { const [insert]=await pool.execute("INSERT IGNORE INTO daily_summaries (local_date,timezone,status,created_at) VALUES (?,?,'sending',UTC_TIMESTAMP(3))",[date,timezone]);if(insert.affectedRows===1)return true;const [claim]=await pool.execute("UPDATE daily_summaries SET status='sending',created_at=UTC_TIMESTAMP(3) WHERE local_date=? AND timezone=? AND (status='failed' OR (status='sending' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 MINUTE)))",[date,timezone]);return claim.affectedRows===1; }
  async function completeDailySummary(date,timezone,status='sent') { await pool.execute('UPDATE daily_summaries SET status=?,sent_at=IF(?=\'sent\',UTC_TIMESTAMP(3),sent_at) WHERE local_date=? AND timezone=?',[status,status,date,timezone]); }
  async function recordWebhookEvent(eventId,payloadHash) { try{await pool.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]);return true;}catch(e){if(e.code==='ER_DUP_ENTRY')return false;throw e;} }
  async function applyWebhookEvent({eventId,payloadHash,type,profileId,data,accountId,notificationCode}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      try { await c.execute('INSERT INTO webhook_events (event_id,payload_hash) VALUES (?,?)',[eventId,payloadHash]); }
      catch(e) { if(e.code==='ER_DUP_ENTRY'){await c.rollback();return false;} throw e; }
      const [[settingsRow]]=await c.query('SELECT settings_json,automation_enabled FROM settings WHERE id=1');
      const configured=json(settingsRow?.settings_json);
      const eventType=String(type||'');
      const dataAccount=data.account_id||data.target?.account_id||data.account?.id;
      const postId=data.post_id||data.id;
      const webhookPublishedAt=(()=>{
        const targetMatches= data.target?.account_id===accountId
          && (!data.target?.platform||String(data.target.platform).toLowerCase()==='threads');
        const value=data.published_at||(targetMatches?data.target?.published_at:null);
        if(typeof value!=='string'&&!(value instanceof Date))return null;
        const parsed=new Date(value);
        return Number.isFinite(parsed.getTime())?parsed:null;
      })();
      let activeSessionCanceledPost=false;
      let staleTerminalCancellation=false;
      if(profileId===configured.profileId&&dataAccount===accountId&&accountId===configured.targetAccountId&&typeof postId==='string'&&eventType.startsWith('post.')) {
        const status=String(data.status||eventType.split('.').at(-1)).toLowerCase();
        const mapped={published:'published',failed:'failed',partial:'partial',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};
        const providerStatus=mapped[status]||'unknown';
        const [[slot]]=await c.execute('SELECT id,automation_session_id,status,provider_status FROM slots WHERE provider_post_id=? LIMIT 1 FOR UPDATE',[postId]);
        const terminalStatuses=['published','failed','partial','canceled','skipped'];
        const slotIsTerminal=terminalStatuses.includes(slot?.status);
        const delayedNonterminal=slotIsTerminal&&!['published','failed','partial','canceled'].includes(providerStatus);
        staleTerminalCancellation=slotIsTerminal&&providerStatus==='canceled';
        if(!delayedNonterminal&&!staleTerminalCancellation) {
          const activeSession=Boolean(settingsRow?.automation_enabled)&&slot?.automation_session_id===configured.automationSessionId;
          activeSessionCanceledPost=providerStatus==='canceled'&&activeSession;
          const slotStatus=activeSessionCanceledPost?'failed':providerStatus;
          const final=['published','failed','partial','canceled'].includes(slotStatus);
          const completedAt=providerStatus==='published'?webhookPublishedAt:null;
          await c.execute('UPDATE slots SET provider_status=?,status=?,error_code=IF(?,\'provider_error\',error_code),completed_at=IF(?,COALESCE(?,UTC_TIMESTAMP(3)),completed_at) WHERE provider_post_id=?',[providerStatus,slotStatus,activeSessionCanceledPost,final,completedAt,postId]);
        }
      }
      if(notificationCode&&profileId===configured.profileId&&accountId===configured.targetAccountId&&dataAccount===accountId) {
        let dedupeId=`tebar:${eventId}`;
        let message=`Kedai Merzz automation: ${notificationCode}. Semak status akaun dan log dashboard.`;
        if(notificationCode==='provider_error'&&String(data.status||eventType.split('.').at(-1)).toLowerCase()==='canceled'&&(!activeSessionCanceledPost||staleTerminalCancellation)) message=null;
        if(notificationCode==='post_published') {
          const [[slot]]=await c.execute("SELECT id FROM slots WHERE provider_post_id=? AND status='published' LIMIT 1",[postId]);
          if(slot) {
            dedupeId=`post_published:slot:${slot.id}`;
            message=`Kedai Merzz automation: post_published. Slot: ${String(slot.id).slice(0,36)}.`;
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
    if(!/^[a-f0-9]{64}$/.test(dedupeKey)||typeof message!=='string'||!message.trim()||message.length>1200)throw Object.assign(new Error('INVALID_NOTIFICATION'),{code:'INVALID_NOTIFICATION'});
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
  async function getDailySummary({localDate,timezone}) { const counts=await getDailySummaryCounts(localDate,timezone);return {published:counts.published||0,failed:counts.failed||0,skipped:counts.skipped||0}; }
  async function finishDailySummary({localDate,timezone,status}) { return completeDailySummary(localDate,timezone,status); }
  async function updateSlotFromProvider(providerPostId,status,details={}) { const [rows]=await pool.execute('SELECT id FROM slots WHERE provider_post_id=? LIMIT 1',[providerPostId]);if(!rows.length)return false;const map={published:'published',partial:'partial',failed:'failed',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};await updateSlot(rows[0].id,{providerStatus:status,...(map[status]?{status:map[status]}:{}),...(map[status]&&['published','partial','failed','canceled'].includes(map[status])?{completedAt:new Date()}: {})});return true; }
  return { healthCheck,getSettings,getRuntimeState,saveSettings,saveKnowledge,listFacts,saveFact,getAdminByEmail,listAdmins,listTemplates,getTemplate,createTemplate,updateTemplate,deleteTemplate,createAdmin,updateAdmin,createSession,getSession,deleteSession,deleteAdminSessions,listSlots,listActivity,listAudit,appendActivity,setAutomationEnabled,setProviderTarget,ensureDueSlot,ensureNextDueSlot,claimDueSlot,savePreparedSlot,startPublishing,isAutomationSessionActive,updateSlot,getUncertainSlots,listUnsettledSlots,recordCancellation,getDailySummaryCounts,reserveDailySummary,completeDailySummary,claimDailySummary,getDailySummary,finishDailySummary,recordWebhookEvent,applyWebhookEvent,updateSlotFromProvider,enqueueNotification,getNotificationStatus,claimNotifications,markNotificationSent,retryNotification };
}

module.exports={createRepository};
