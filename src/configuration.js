'use strict';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,98}$/;
const STATUSES = new Set(['NOT_CONFIGURED', 'ACTIVE', 'SWITCHING', 'BLOCKED_RECONCILIATION']);
function error(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function validId(value) { return typeof value === 'string' && ID.test(value); }
function validModel(value) { return typeof value === 'string' && value.length <= 200 && MODEL.test(value); }
function snapshot(row) {
  if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1 || !STATUSES.has(row.status)) throw error('CONFIG_UNAVAILABLE', 503);
  const profileId = row.profile_id || null;
  const accountId = row.account_id || null;
  const model = row.model || null;
  if ((profileId || accountId) && (!validId(profileId) || !validId(accountId))) throw error('CONFIG_UNAVAILABLE', 503);
  if (model && !validModel(model)) throw error('CONFIG_UNAVAILABLE', 503);
  if (row.status === 'ACTIVE' && (!profileId || !accountId || !model)) throw error('CONFIG_UNAVAILABLE', 503);
  const pendingProfileId = row.pending_profile_id || null;
  const pendingAccountId = row.pending_account_id || null;
  const pendingModel = row.pending_model || null;
  if (['SWITCHING', 'BLOCKED_RECONCILIATION'].includes(row.status)
    && (!validId(pendingProfileId) || !validId(pendingAccountId) || (pendingModel && !validModel(pendingModel)))) throw error('CONFIG_UNAVAILABLE', 503);
  return Object.freeze({ version: Number(row.version), profileId, accountId, model, status: row.status, pendingProfileId, pendingAccountId, pendingModel });
}
function parseSettings(row) {
  try { return typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json || {}; }
  catch { throw error('CONFIG_UNAVAILABLE', 503); }
}
function activeStatus(profileId, accountId, model) { return profileId && accountId && model ? 'ACTIVE' : 'NOT_CONFIGURED'; }
function checkVersion(value, row) {
  if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_VERSION');
  if (value !== Number(row.version)) throw error('CONFIG_CONFLICT', 409);
}

function createConfigurationService({ pool, config }) {
  if (!pool || !config) throw new TypeError('pool and config are required');
  async function locked(work) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[settingsRow]] = await connection.query('SELECT settings_json FROM settings WHERE id=1 FOR UPDATE');
      if (!settingsRow) throw error('CONFIG_UNAVAILABLE', 503);
      const [[configRow]] = await connection.query('SELECT * FROM integration_config WHERE id=1 FOR UPDATE');
      const result = await work(connection, settingsRow, configRow);
      await connection.commit();
      return result;
    } catch (e) { await connection.rollback().catch(() => {}); throw e; }
    finally { connection.release(); }
  }
  async function record(c, row, action, actorId) {
    await c.execute('INSERT INTO integration_config_history (version,profile_id,account_id,model,status,action,actor_id,pending_profile_id,pending_account_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [row.version, row.profileId, row.accountId, row.model, row.status, action, actorId || null, row.pendingProfileId || null, row.pendingAccountId || null]);
    if (actorId) await c.execute('INSERT INTO audit_logs (admin_id,action,details_json) VALUES (?,?,?)', [actorId, `integration.${action}`, JSON.stringify({ version: row.version, status: row.status })]);
  }
  async function bootstrap() {
    return locked(async (c, settingsRow, configRow) => {
      if (configRow) return snapshot(configRow);
      const settings = parseSettings(settingsRow);
      const [[historyRow]] = await c.query('SELECT COUNT(*) AS count FROM integration_config_history');
      if (settings.integrationConfigInitialized === true || Number(historyRow.count) > 0) throw error('CONFIG_UNAVAILABLE',503);
      const storedPair = validId(settings.profileId) && validId(settings.targetAccountId);
      const envPair = validId(config.tebar?.profileId) && validId(config.tebar?.accountId);
      const profileId = storedPair ? settings.profileId : envPair ? config.tebar.profileId : null;
      const accountId = storedPair ? settings.targetAccountId : envPair ? config.tebar.accountId : null;
      const model = validModel(config.openRouter?.model) ? config.openRouter.model : null;
      const status = activeStatus(profileId, accountId, model);
      await c.execute('INSERT INTO integration_config (id,version,profile_id,account_id,model,status) VALUES (1,1,?,?,?,?)', [profileId, accountId, model, status]);
      const initial = { version: 1, profileId, accountId, model, status };
      settings.profileId = profileId; settings.targetAccountId = accountId; settings.integrationConfigInitialized = true;
      if (status !== 'ACTIVE') { settings.onboardingComplete = false; delete settings.automationSessionId; delete settings.nextSlotAt; }
      await c.execute('UPDATE settings SET settings_json=?,automation_enabled=IF(?=\'ACTIVE\',automation_enabled,FALSE) WHERE id=1', [JSON.stringify(settings), status]);
      await record(c, initial, 'bootstrap', null);
      return snapshot({ version: 1, profile_id: profileId, account_id: accountId, model, status });
    });
  }
  async function getActive() {
    const [[row]] = await pool.execute('SELECT * FROM integration_config WHERE id=1');
    return snapshot(row);
  }
  async function history() {
    const [rows] = await pool.execute('SELECT h.version,h.profile_id,h.account_id,h.model,h.status,h.action,h.actor_id,h.pending_profile_id,h.pending_account_id,h.created_at,a.email AS actor_email FROM integration_config_history h LEFT JOIN admins a ON a.id=h.actor_id ORDER BY h.version DESC LIMIT 100');
    return rows.map(r => ({ version: Number(r.version), profileId: r.profile_id, accountId: r.account_id, model: r.model, status: r.status, action: r.action, actorId: r.actor_id == null ? null : Number(r.actor_id), actorEmail:r.actor_email || null, pendingProfileId:r.pending_profile_id || null, pendingAccountId:r.pending_account_id || null, createdAt: r.created_at }));
  }
  async function getHistoryVersion(version) {
    if (!Number.isSafeInteger(version) || version < 1) throw error('INVALID_VERSION');
    const [[row]] = await pool.execute('SELECT version,profile_id,account_id,model,status FROM integration_config_history WHERE version=?', [version]);
    if (!row) throw error('CONFIG_VERSION_NOT_FOUND', 404);
    if (!['ACTIVE','NOT_CONFIGURED'].includes(row.status)) throw error('CONFIG_VERSION_NOT_RESTORABLE',409);
    return snapshot(row);
  }
  async function recordValidation({ actorId, kind, outcome, code }) {
    if (!actorId || !['account','model'].includes(kind) || !['success','failed'].includes(outcome)) throw error('INVALID_REQUEST');
    const safeCode = typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
    await pool.execute('INSERT INTO audit_logs (admin_id,action,details_json) VALUES (?,?,?)', [actorId, 'integration.validation', JSON.stringify({kind,outcome,code:safeCode})]);
  }
  async function setModel({ model, expectedVersion, actorId, action = 'model_updated' }) {
    if (!validModel(model)) throw error('INVALID_MODEL');
    return locked(async (c, _settings, row) => {
      const current = snapshot(row); checkVersion(expectedVersion, row);
      if (['SWITCHING','BLOCKED_RECONCILIATION'].includes(current.status)) throw error('CONFIG_SWITCH_IN_PROGRESS', 409);
      const status = activeStatus(current.profileId, current.accountId, model); const version = current.version + 1;
      await c.execute('UPDATE integration_config SET version=?,model=?,status=?,updated_by=? WHERE id=1', [version, model, status, actorId || null]);
      const next = { ...current, version, model, status }; await record(c, next, action, actorId); return Object.freeze(next);
    });
  }
  async function switchAccount({ profileId, accountId, expectedVersion, actorId, action = 'account_changed' }) {
    if (!validId(profileId) || !validId(accountId)) throw error('INVALID_ACCOUNT');
    return locked(async (c, settingsRow, row) => {
      const current = snapshot(row); checkVersion(expectedVersion, row);
      if (['SWITCHING','BLOCKED_RECONCILIATION'].includes(current.status)) throw error('CONFIG_SWITCH_IN_PROGRESS', 409);
      const settings = parseSettings(settingsRow); const nextModel = current.model;
      settings.onboardingComplete = false; delete settings.nextSlotAt; delete settings.activationFirstPostAt; delete settings.automationSessionId;
      await c.execute('UPDATE settings SET settings_json=?,automation_enabled=FALSE WHERE id=1', [JSON.stringify(settings)]);
      await c.execute("UPDATE slots SET status='canceled',error_code='account_reconfigured',completed_at=UTC_TIMESTAMP(3) WHERE status IN ('pending','generating','ready')");
      const [[unsettled]] = await c.execute("SELECT COUNT(*) AS count FROM slots WHERE status IN ('publishing','unknown') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft'))");
      const blocked = Number(unsettled.count) > 0; const version = current.version + 1;
      if (blocked) {
        await c.execute("UPDATE integration_config SET version=?,status='BLOCKED_RECONCILIATION',pending_profile_id=?,pending_account_id=?,pending_model=?,updated_by=? WHERE id=1", [version,profileId,accountId,nextModel,actorId || null]);
        const next = { ...current, version, status: 'BLOCKED_RECONCILIATION', pendingProfileId: profileId, pendingAccountId: accountId, pendingModel: nextModel };
        await record(c,next,'switch_blocked',actorId); return Object.freeze(next);
      }
      settings.profileId=profileId; settings.targetAccountId=accountId;
      await c.execute('UPDATE settings SET settings_json=? WHERE id=1', [JSON.stringify(settings)]);
      const status=activeStatus(profileId,accountId,nextModel);
      await c.execute('UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,status=?,pending_profile_id=NULL,pending_account_id=NULL,pending_model=NULL,updated_by=? WHERE id=1', [version,profileId,accountId,nextModel,status,actorId || null]);
      const next={version,profileId,accountId,model:nextModel,status,pendingProfileId:null,pendingAccountId:null,pendingModel:null}; await record(c,next,action,actorId); return Object.freeze(next);
    });
  }
  async function resumeSwitch({ expectedVersion, actorId }) {
    return locked(async (c, settingsRow, row) => {
      const current=snapshot(row); checkVersion(expectedVersion,row);
      if (!['SWITCHING','BLOCKED_RECONCILIATION'].includes(current.status)) throw error('NO_SWITCH_PENDING',409);
      const [[unsettled]]=await c.execute("SELECT COUNT(*) AS count FROM slots WHERE status IN ('publishing','unknown') OR (provider_post_id IS NOT NULL AND provider_status IN ('scheduled','draft'))");
      if (Number(unsettled.count)>0) return current;
      const settings=parseSettings(settingsRow); settings.profileId=current.pendingProfileId; settings.targetAccountId=current.pendingAccountId; settings.onboardingComplete=false;
      delete settings.nextSlotAt; delete settings.activationFirstPostAt; delete settings.automationSessionId;
      await c.execute('UPDATE settings SET settings_json=?,automation_enabled=FALSE WHERE id=1',[JSON.stringify(settings)]);
      const version=current.version+1; const status=activeStatus(current.pendingProfileId,current.pendingAccountId,current.pendingModel);
      await c.execute('UPDATE integration_config SET version=?,profile_id=?,account_id=?,model=?,status=?,pending_profile_id=NULL,pending_account_id=NULL,pending_model=NULL,updated_by=? WHERE id=1',[version,current.pendingProfileId,current.pendingAccountId,current.pendingModel,status,actorId || null]);
      const next={version,profileId:current.pendingProfileId,accountId:current.pendingAccountId,model:current.pendingModel,status,pendingProfileId:null,pendingAccountId:null,pendingModel:null}; await record(c,next,'switch_activated',actorId); return Object.freeze(next);
    });
  }
  return { bootstrap, getActive, history, getHistoryVersion, recordValidation, setModel, switchAccount, resumeSwitch };
}
module.exports = { createConfigurationService, validId, validModel, snapshot };
