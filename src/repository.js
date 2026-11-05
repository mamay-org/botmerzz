const { randomUUID, createHash } = require('node:crypto');
const { DateTime } = require('luxon');
const { isInActiveWindow, validateSettings } = require('./policy');

const json = (value, fallback = {}) => {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const safeId = (value) => String(value);

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
    return { ...settings, brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {}, automationEnabled: Boolean(row.automation_enabled) };
  }
  async function getRuntimeState() {
    const [rows] = await pool.execute('SELECT settings_json, knowledge_json, automation_enabled FROM settings WHERE id=1');
    const row = rows[0] || {};
    const settings = json(row.settings_json);
    const knowledge = json(row.knowledge_json);
    const facts = await listFacts();
    const history = await listSlots(1000);
    const factRows = Object.entries(facts).map(([service, fact]) => ({ ...fact.summary, id: service, pillar: service === 'account' ? 'account' : 'topup', active: fact.active, updatedAt: fact.updatedAt }));
    return { settings: { ...settings, brand: knowledge.brand || settings.brand || {}, guardrails: knowledge.guardrails || settings.guardrails || {} }, knowledge, facts: factRows, history, automationEnabled: Boolean(row.automation_enabled), accountId: settings.targetAccountId || null, profileId: settings.profileId || null, onboardingComplete: settings.onboardingComplete === true };
  }
  async function saveSettings(settings, adminId) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const safeSettings = { ...settings }; delete safeSettings.automationEnabled;
      const [[existingRow]] = await connection.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      const existing = json(existingRow?.settings_json);
      for (const key of ['targetAccountId','profileId','onboardingComplete','nextSlotAt']) if (safeSettings[key] === undefined && existing[key] !== undefined) safeSettings[key] = existing[key];
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
  async function createAdmin({ email, passwordHash, actorId }) {
    const conn = await pool.getConnection();
    try { await conn.beginTransaction(); await conn.execute('INSERT INTO admins (email,password_hash,active) VALUES (?,?,TRUE)', [email,passwordHash]); const [rows] = await conn.execute('SELECT id,email,active,created_at FROM admins WHERE email=?', [email]); await audit(conn, actorId, 'admin.created', { targetAdminId: Number(rows[0].id), email }); await conn.commit(); return { ...rows[0], id: Number(rows[0].id), active: Boolean(rows[0].active), createdAt: rows[0].created_at }; }
    catch (error) { await conn.rollback(); if (error.code === 'ER_DUP_ENTRY') throw Object.assign(new Error('ADMIN_EXISTS'), { code: 'ADMIN_EXISTS' }); throw error; } finally { conn.release(); }
  }
  async function updateAdmin(id, { email, passwordHash, active }, actorId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('SELECT id FROM settings WHERE id=1 FOR UPDATE');
      const [[target]] = await conn.execute('SELECT id,email,active FROM admins WHERE id=? FOR UPDATE', [id]);
      if (!target) { await conn.rollback(); return null; }
      if (active === false && target.active) {
        const [[count]] = await conn.query('SELECT COUNT(*) AS total FROM admins WHERE active=TRUE');
        if (Number(count.total) <= 1) throw Object.assign(new Error('LAST_ADMIN'), { code: 'LAST_ADMIN' });
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
    const row=rows[0]; return row && { admin: { id: row.id,email:row.email }, csrfToken:row.csrf_token,expiresAt:row.expires_at };
  }
  async function deleteSession(tokenHash) { await pool.execute('DELETE FROM sessions WHERE token_hash=?', [tokenHash]); }
  async function deleteAdminSessions(adminId) { await pool.execute('DELETE FROM sessions WHERE admin_id=?', [adminId]); }
  async function listSlots(limit=100) { const [rows]=await pool.execute('SELECT id,scheduled_at,status,pillar,provider_post_id,provider_status,caption,error_code,cancellation_status,fact_bearing,fact_ids,created_at,completed_at FROM slots ORDER BY scheduled_at DESC LIMIT ?', [Math.max(1,Math.min(1000,Number(limit)||100))]); return rows.map((r)=>({id:r.id,scheduledAt:r.scheduled_at,status:r.status,pillar:r.pillar,providerPostId:r.provider_post_id,providerStatus:r.provider_status,caption:r.caption,errorCode:r.error_code,cancellationStatus:r.cancellation_status,factBearing:Boolean(r.fact_bearing),factIds:json(r.fact_ids,[]),createdAt:r.created_at,completedAt:r.completed_at})); }
  async function listActivity(limit=100) { const [rows]=await pool.execute('SELECT event,details_json,created_at FROM activity_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.event,...json(r.details_json),createdAt:r.created_at})); }
  async function healthCheck() { await pool.query('SELECT 1'); return true; }
  async function listAudit(limit=100) { const [rows]=await pool.execute('SELECT action,details_json,created_at FROM audit_logs ORDER BY id DESC LIMIT ?', [Math.max(1,Math.min(500,Number(limit)||100))]); return rows.map((r)=>({event:r.action,...json(r.details_json),createdAt:r.created_at})); }
  async function appendActivity({event,slotId,details={}}) { await pool.execute('INSERT INTO activity_logs (slot_id,event,details_json) VALUES (?,?,?)', [slotId || null,event,JSON.stringify(details)]); }
  async function setAutomationEnabled(enabled, adminId) { const c=await pool.getConnection(); try { await c.beginTransaction(); if (enabled) await c.execute("UPDATE settings SET automation_enabled=TRUE, settings_json=JSON_SET(settings_json,'$.onboardingComplete',TRUE) WHERE id=1"); else await c.execute('UPDATE settings SET automation_enabled=FALSE WHERE id=1'); await audit(c,adminId,enabled?'automation.enabled':'automation.paused',{}); await c.commit(); } catch(e) { await c.rollback(); throw e; } finally { c.release(); } }
  async function setProviderTarget({accountId,profileId}) { const c=await pool.getConnection();try{await c.beginTransaction();const [[row]]=await c.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');const settings=json(row?.settings_json);const changed=(settings.targetAccountId||null)!==(accountId||null)||(settings.profileId||null)!==(profileId||null);settings.targetAccountId=accountId||null;settings.profileId=profileId||null;if(changed)settings.onboardingComplete=false;await c.execute('UPDATE settings SET settings_json=?,automation_enabled=IF(?,FALSE,automation_enabled) WHERE id=1',[JSON.stringify(settings),changed]);await c.commit();}catch(e){await c.rollback();throw e;}finally{c.release();} }
  async function ensureDueSlot({scheduledAt}) { const id=randomUUID(); await pool.execute("INSERT IGNORE INTO slots (id,scheduled_at,status) VALUES (?,?,'pending')",[id,scheduledAt]); const [rows]=await pool.execute('SELECT * FROM slots WHERE scheduled_at=?',[scheduledAt]); return rows[0] || null; }
  async function claimDueSlot({now,minimumIntervalHours=6}) { const c=await pool.getConnection(); try { await c.beginTransaction(); const [[state]]=await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');const settings=json(state?.settings_json);const knowledge=json(state?.knowledge_json);const validated=validateSettings({...settings,brand:knowledge.brand||settings.brand,guardrails:knowledge.guardrails||settings.guardrails});if(!state?.automation_enabled||settings.onboardingComplete!==true||!settings.targetAccountId||!validated.valid){await c.rollback();return null;} const [rows]=await c.execute("SELECT id,scheduled_at,status,request_payload,idempotency_key,caption,pillar,fact_bearing,fact_ids FROM slots WHERE ((status='pending' AND scheduled_at<=?) OR (status='ready' AND scheduled_at<=? AND (claimed_at IS NULL OR claimed_at<DATE_SUB(?,INTERVAL 10 MINUTE)))) ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[now,now,now]); if(!rows.length){await c.commit();return null;} const slot=rows[0]; const [[last]]=await c.execute("SELECT scheduled_at FROM slots WHERE status IN ('published','publishing','unknown','partial') AND scheduled_at<? AND id<>? ORDER BY scheduled_at DESC LIMIT 1",[slot.scheduled_at,slot.id]); if(last && new Date(slot.scheduled_at)-new Date(last.scheduled_at)<minimumIntervalHours*3600000){await c.execute("UPDATE slots SET status='skipped',error_code='MINIMUM_CADENCE',completed_at=UTC_TIMESTAMP(3) WHERE id=?",[slot.id]); await c.commit();return null;} if(slot.status==='pending') await c.execute("UPDATE slots SET status='generating',claimed_at=? WHERE id=? AND status='pending'",[now,slot.id]);else await c.execute('UPDATE slots SET claimed_at=? WHERE id=? AND status=\'ready\'',[now,slot.id]); await c.commit();return {id:slot.id,scheduledAt:slot.scheduled_at,status:slot.status,requestPayload:json(slot.request_payload),idempotencyKey:slot.idempotency_key,caption:slot.caption,pillar:slot.pillar,factBearing:Boolean(slot.fact_bearing),factIds:json(slot.fact_ids,[])}; } catch(e){await c.rollback();throw e;}finally{c.release();} }
  async function ensureNextDueSlot({now=new Date(),timezone='Asia/Kuala_Lumpur',schedule}={}) {
    const c=await pool.getConnection();
    try {
      await c.beginTransaction();
      const [[row]]=await c.query('SELECT automation_enabled,settings_json,knowledge_json FROM settings WHERE id=1 FOR UPDATE');
      const settings=json(row?.settings_json);const knowledge=json(row?.knowledge_json);
      const savedSchedule=settings.schedule||schedule||{};
      const checked=validateSettings({...settings,schedule:savedSchedule,brand:knowledge.brand||settings.brand,guardrails:knowledge.guardrails||settings.guardrails});
      if(!row?.automation_enabled||settings.onboardingComplete!==true||!settings.targetAccountId||!checked.valid){await c.commit();return {slot:null,created:false,skippedCount:0};}
      const zone=savedSchedule.timezone||timezone;
      const interval=checked.settings.schedule.intervalHours;
      const current=DateTime.fromJSDate(now instanceof Date?now:new Date(now),{zone:'utc'});
      if(!current.isValid){await c.rollback();return {slot:null,created:false,skippedCount:0};}
      await c.execute("UPDATE slots SET status='skipped',error_code='stale_generation',completed_at=UTC_TIMESTAMP(3) WHERE status='generating' AND claimed_at < DATE_SUB(?, INTERVAL 10 MINUTE)",[current.toJSDate()]);
      let skippedCount=0;
      const [[duePending]]=await c.execute("SELECT id,scheduled_at,status FROM slots WHERE status='pending' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[current.toJSDate()]);
      if(duePending){
        const active=isInActiveWindow(new Date(duePending.scheduled_at),{...checked.settings.schedule,timezone:zone});
        if(active&&isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone})&&current.toMillis()-new Date(duePending.scheduled_at).getTime()<=15*60*1000){await c.commit();return {slot:{id:duePending.id,scheduledAt:duePending.scheduled_at,status:'pending'},created:false,skippedCount:0};}
        await c.execute("UPDATE slots SET status='skipped',error_code=?,completed_at=UTC_TIMESTAMP(3) WHERE id=?",[active?'missed_slot':'outside_active_window',duePending.id]);skippedCount++;
      }
      const [[futurePending]]=await c.execute("SELECT id,scheduled_at,status FROM slots WHERE status='pending' AND scheduled_at>? ORDER BY scheduled_at LIMIT 1 FOR UPDATE",[current.toJSDate()]);
      if(futurePending){await c.commit();return {slot:{id:futurePending.id,scheduledAt:futurePending.scheduled_at,status:'pending'},created:false,skippedCount};}
      let due=settings.nextSlotAt?DateTime.fromISO(settings.nextSlotAt,{zone:'utc'}):current.plus({hours:interval});
      if(!due.isValid)due=current.plus({hours:interval});
      for(let i=0;i<100;i++){
        const scheduledAt=due.toUTC().toFormat('yyyy-LL-dd HH:mm:ss.SSS');
        const active=isInActiveWindow(due.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const lateBy=current.toMillis()-due.toMillis();
        const stale=lateBy>15*60*1000;
        const activeNow=isInActiveWindow(current.toJSDate(),{...checked.settings.schedule,timezone:zone});
        const status=active&&(due>current||activeNow)&&!stale?'pending':'skipped';
        const [insert]=await c.execute('INSERT IGNORE INTO slots (id,scheduled_at,status,error_code,completed_at) VALUES (?,?,?,?,?)',[randomUUID(),scheduledAt,status,status==='skipped'?(active?'missed_slot':'outside_active_window'):null,status==='skipped'?new Date():null]);
        skippedCount+=status==='skipped'&&insert.affectedRows===1?1:0;
        const [[existing]]=await c.execute('SELECT id,status,scheduled_at FROM slots WHERE scheduled_at=?',[scheduledAt]);
        due=due.plus({hours:interval});
        settings.nextSlotAt=due.toUTC().toISO();
        await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
        if(status==='pending'){await c.commit();return {slot:{id:existing.id,scheduledAt:existing.scheduled_at,status:existing.status},created:insert.affectedRows===1,skippedCount};}
      }
      if(settings.nextSlotAt) await c.execute('UPDATE settings SET settings_json=? WHERE id=1',[JSON.stringify(settings)]);
      await c.commit();
      return {slot:null,created:false,skippedCount};
    } catch(e){await c.rollback();throw e;}finally{c.release();}
  }
  async function savePreparedSlot(id,{requestPayload,idempotencyKey,caption,pillar,factBearing=false,factIds=[]}) { await pool.execute("UPDATE slots SET status='ready',request_payload=?,idempotency_key=?,caption=?,pillar=?,fact_bearing=?,fact_ids=? WHERE id=? AND status='generating'",[JSON.stringify(requestPayload),idempotencyKey,caption,pillar,Boolean(factBearing),JSON.stringify(factIds),id]); }
  async function startPublishing(id,{now,minimumIntervalHours=6}) { const c=await pool.getConnection();try{await c.beginTransaction();const [[set]]=await c.query('SELECT automation_enabled FROM settings WHERE id=1 FOR UPDATE');const [[s]]=await c.execute('SELECT scheduled_at,status FROM slots WHERE id=? FOR UPDATE',[id]);if(!s||s.status!=='ready'||!set?.automation_enabled){await c.rollback();return false;}const [[last]]=await c.execute("SELECT scheduled_at FROM slots WHERE status IN ('published','publishing','unknown') AND scheduled_at<? AND id<>? ORDER BY scheduled_at DESC LIMIT 1",[s.scheduled_at,id]);if(last&&new Date(s.scheduled_at)-new Date(last.scheduled_at)<minimumIntervalHours*3600000){await c.execute("UPDATE slots SET status='skipped',error_code='MINIMUM_CADENCE' WHERE id=?",[id]);await c.commit();return false;}await c.execute("UPDATE slots SET status='publishing',publish_started_at=? WHERE id=?",[now,id]);await c.commit();return true;}catch(e){await c.rollback();throw e;}finally{c.release();} }
  async function updateSlot(id,patch) { const allowed={status:'status',providerPostId:'provider_post_id',providerStatus:'provider_status',errorCode:'error_code',cancellationStatus:'cancellation_status',completedAt:'completed_at'};const keys=Object.keys(patch).filter(k=>allowed[k]);if(!keys.length)return;const sql=keys.map(k=>`${allowed[k]}=?`).join(',');await pool.execute(`UPDATE slots SET ${sql} WHERE id=?`,[...keys.map(k=>patch[k]),id]); }
  async function getUncertainSlots() { const [rows]=await pool.execute("SELECT id,provider_post_id,request_payload,idempotency_key,status FROM slots WHERE status IN ('unknown','publishing') ORDER BY scheduled_at");return rows.map(r=>({...r,id:r.id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key})); }
  async function listUnsettledSlots() { const [rows]=await pool.execute("SELECT id,provider_post_id,request_payload,idempotency_key,status FROM slots WHERE status IN ('unknown','publishing') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft')) ORDER BY scheduled_at");return rows.map(r=>({id:r.id,providerPostId:r.provider_post_id,requestPayload:json(r.request_payload),idempotencyKey:r.idempotency_key,status:r.status})); }
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
      const [[settingsRow]]=await c.query('SELECT settings_json FROM settings WHERE id=1');
      const configured=json(settingsRow?.settings_json);
      const eventType=String(type||'');
      const dataAccount=data.account_id||data.target?.account_id||data.account?.id;
      const postId=data.post_id||data.id;
      if(profileId===configured.profileId&&dataAccount===accountId&&accountId===configured.targetAccountId&&typeof postId==='string'&&eventType.startsWith('post.')) {
        const status=String(data.status||eventType.split('.').at(-1));
        const mapped={published:'published',failed:'failed',partial:'partial',canceled:'canceled',scheduled:'publishing',publishing:'publishing'};
        const providerStatus=mapped[status]||'unknown';
        const final=['published','failed','partial','canceled'].includes(providerStatus);
        await c.execute('UPDATE slots SET provider_status=?,status=?,completed_at=IF(?,UTC_TIMESTAMP(3),completed_at) WHERE provider_post_id=?',[providerStatus,providerStatus,final,postId]);
      }
      if(notificationCode&&profileId===configured.profileId&&accountId===configured.targetAccountId&&dataAccount===accountId) {
        const message=`Kedai Merzz automation: ${notificationCode}. Semak status akaun dan log dashboard.`;
        const dedupeKey=createHash('sha256').update(`tebar:${eventId}`).digest('hex');
        await c.execute('INSERT IGNORE INTO notification_outbox (dedupe_key,message) VALUES (?,?)',[dedupeKey,message]);
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
  return { healthCheck,getSettings,getRuntimeState,saveSettings,saveKnowledge,listFacts,saveFact,getAdminByEmail,listAdmins,createAdmin,updateAdmin,createSession,getSession,deleteSession,deleteAdminSessions,listSlots,listActivity,listAudit,appendActivity,setAutomationEnabled,setProviderTarget,ensureDueSlot,ensureNextDueSlot,claimDueSlot,savePreparedSlot,startPublishing,updateSlot,getUncertainSlots,listUnsettledSlots,recordCancellation,getDailySummaryCounts,reserveDailySummary,completeDailySummary,claimDailySummary,getDailySummary,finishDailySummary,recordWebhookEvent,applyWebhookEvent,updateSlotFromProvider,enqueueNotification,getNotificationStatus,claimNotifications,markNotificationSent,retryNotification };
}

module.exports={createRepository};
