'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const enabled = process.env.NODE_ENV === 'test' && process.env.DB_NAME === 'merzz_test' && ['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS === 'true';

test('learning persistence and reviewer concurrency on isolated MySQL', { skip: !enabled }, async (t) => {
  const { loadEnv } = require('../src/config');
  const { createPool } = require('../src/db');
  const { runMigrations } = require('../src/migrate');
  const { createLearningStore } = require('../src/learning');
  const pool = createPool(loadEnv());
  const slotId = randomUUID();
  const email = `learning-${randomUUID()}@example.test`;
  let adminId;
  try {
    await t.test('migrations are ordered, restartable and include learning schema', async () => {
      const applied = await runMigrations(pool);
      const [rows] = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
      const versions = rows.map((row) => row.version);
      assert.ok(versions.includes('011_learning_center.sql'));
      assert.ok(versions.includes('012_learning_events.sql'));
      assert.ok(versions.includes('014_generation_attempts.sql'));
      assert.ok(versions.includes('015_learning_lifecycle.sql'));
      assert.deepEqual(versions, [...versions].sort());
      assert.deepEqual(await runMigrations(pool), []);
      const [indexes] = await pool.query("SHOW INDEX FROM learning_candidates");
      assert.ok(indexes.some((item) => item.Column_name === 'event_key' && Number(item.Non_unique) === 0));
      const [attempts] = await pool.query("SHOW INDEX FROM generation_attempts");
      assert.ok(attempts.some((item) => item.Key_name === 'generation_attempt_ordinal' && Number(item.Non_unique) === 0));
      const [keys] = await pool.query("SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'learning_%' AND REFERENCED_TABLE_NAME IS NOT NULL");
      assert.ok(keys.some((item) => item.TABLE_NAME === 'learning_candidates' && item.REFERENCED_TABLE_NAME === 'slots'));
      assert.ok(Array.isArray(applied));
    });
    const [admin] = await pool.execute('INSERT INTO admins (email,password_hash) VALUES (?,?)', [email, 'not-a-real-password-hash']);
    adminId = admin.insertId;
    await pool.execute("INSERT INTO slots (id,scheduled_at,status,caption) VALUES (?,?,'published',?)", [slotId, new Date(Date.now() + Math.floor(Math.random()*1000000000)), 'Contoh caption untuk ulasan.']);
    let store = createLearningStore(pool);
    const candidateId = async (feedbackId) => {
      const [[row]] = await pool.execute('SELECT id FROM learning_candidates WHERE feedback_id=?', [feedbackId]);
      return row.id;
    };
    await t.test('feedback uniqueness, restart and version checks are durable', async () => {
      const saved = await store.feedback({ slotId, type:'positive', ratings:{hook:5}, explanation:'natural' }, adminId);
      await assert.rejects(store.feedback({ slotId, type:'positive', ratings:{hook:5} }, adminId), (e) => e.code === 'FEEDBACK_ALREADY_EXISTS');
      const id = await candidateId(saved.id);
      store = createLearningStore(pool);
      await assert.rejects(store.decide(id, {version:2, decision:'rejected'}, adminId), (e) => e.code === 'REVIEW_CONFLICT');
      const result = await store.decide(id, {version:1,decision:'rejected',reason:'not suitable'}, adminId);
      assert.equal(result.status, 'rejected');
      const [[row]] = await pool.execute('SELECT status,version FROM learning_candidates WHERE id=?', [id]);
      assert.equal(row.status, 'rejected');
      assert.equal(Number(row.version), 2);
      const [[review]] = await pool.execute('SELECT action,entity_version FROM learning_reviews WHERE candidate_id=?', [id]);
      assert.equal(review.action, 'rejected');
      assert.equal(Number(review.entity_version), 1);
    });
    await t.test('concurrent decisions have one winner and atomic history', async () => {
      const key = require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
      const [insert] = await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','test')", [slotId,key]);
      const id = insert.insertId;
      const requests = [
        store.decide(id,{version:1,decision:'approved',instruction:'Use a varied opening.',scope:'global'},adminId),
        store.decide(id,{version:1,decision:'false_positive',reason:'not a violation'},adminId),
      ];
      const outcomes = await Promise.allSettled(requests);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length,1);
      assert.equal(outcomes.filter((o) => o.status === 'rejected' && o.reason.code === 'REVIEW_CONFLICT').length,1);
      const [[candidate]] = await pool.execute('SELECT status,version FROM learning_candidates WHERE id=?', [id]);
      const [[reviews]] = await pool.execute('SELECT COUNT(*) AS n FROM learning_reviews WHERE candidate_id=?', [id]);
      const [[rules]] = await pool.execute('SELECT COUNT(*) AS n,COALESCE(SUM(active),0) AS active FROM learning_rules WHERE candidate_id=?', [id]);
      assert.equal(Number(candidate.version),2);
      assert.equal(Number(reviews.n),1);
      assert.equal(Number(rules.n),candidate.status === 'approved' ? 1 : 0);
      assert.equal(Number(rules.active),0);
    });
    await t.test('event replay and classifications preserve attempt evidence without duplicate candidates', async () => {
      const { sanitizeEvidence } = require('../src/learning-evidence');
      const event = {eventId:randomUUID(),slotId,attemptId:randomUUID(),validationRunId:randomUUID(),findingId:'FORBIDDEN_CLAIM',category:'FORBIDDEN_CLAIM',classificationStatus:'contextual',stage:'deterministic',eventTime:new Date().toISOString(),scope:'account',evidence:sanitizeEvidence('Hai pemain, hubungi hello@example.test untuk cerita ini.')};
      const results = await Promise.all([store.captureFailure(event),store.captureFailure(event)]);
      assert.equal(results.filter((item) => item.status === 'captured').length,1);
      assert.equal(results.filter((item) => item.status === 'deduplicated').length,1);
      await assert.rejects(store.captureFailure({...event,attemptId:randomUUID()}),{code:'EVENT_CONFLICT'});
      await store.captureFailure({...event,eventId:randomUUID(),attemptId:randomUUID(),classificationStatus:'unresolved',findingId:'SEMANTIC_UNKNOWN'});
      await store.captureFailure({...event,eventId:randomUUID(),attemptId:randomUUID(),classificationStatus:'technical',findingId:'TIMEOUT'});
      const [[counts]] = await pool.execute('SELECT COUNT(*) AS total,COUNT(candidate_id) AS candidates FROM learning_capture_events WHERE slot_id=?',[slotId]);
      assert.equal(Number(counts.total),3);
      assert.equal(Number(counts.candidates),1);
      const candidates = await store.listCandidates('pending');
      const found = candidates.find((item) => item.attemptId === event.attemptId);
      assert.ok(found);
      assert.equal(found.validationRunId,event.validationRunId);
      assert.equal(found.caption,null);
      assert.equal(found.evidenceStatus,'unavailable');
    });
    await t.test('identical rules on different candidates cannot both be approved concurrently', async () => {
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const key = require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
        const [insert] = await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','test')", [slotId,key]);
        ids.push(insert.insertId);
      }
      const body = {version:1,decision:'approved',instruction:'Avoid always using generic sales openings.',scope:'global'};
      const outcomes = await Promise.allSettled(ids.map((id) => store.decide(id,body,adminId)));
      assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length,1);
      assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'DUPLICATE_RULE').length,1, JSON.stringify(outcomes.map((item) => ({status:item.status,code:item.reason?.code}))));
      const [rows] = await pool.execute('SELECT status,version FROM learning_candidates WHERE id IN (?,?)',ids);
      assert.deepEqual(rows.map((row) => row.status).sort(),['approved','pending']);
    });
    await t.test('review insertion failure rolls back decision and rule', async () => {
      const key = require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
      const [insert] = await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','test')", [slotId,key]);
      const id = insert.insertId;
      const failingPool = { getConnection: async () => {
        const connection = await pool.getConnection();
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return (sql, values) => sql.startsWith('INSERT INTO learning_reviews')
            ? Promise.reject(new Error('injected failure')) : target.execute(sql, values);
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        } });
      } };
      await assert.rejects(createLearningStore(failingPool).decide(id,{version:1,decision:'approved',instruction:'Test rollback.',scope:'account'},adminId));
      const [[candidate]] = await pool.execute('SELECT status,version FROM learning_candidates WHERE id=?', [id]);
      const [[rules]] = await pool.execute('SELECT COUNT(*) AS n FROM learning_rules WHERE candidate_id=?', [id]);
      assert.equal(candidate.status,'pending');
      assert.equal(Number(candidate.version),1);
      assert.equal(Number(rules.n),0);
    });
    await t.test('candidate cursor pages more than 100 rows without gaps or duplicates', async () => {
      const keys = Array.from({length:105}, () => require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex'));
      for (const key of keys) await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','pagination')",[slotId,key]);
      const first = await store.listCandidates('pending');
      assert.equal(first.length,100);
      const second = await store.listCandidates('pending',String(first.at(-1).id));
      const all = [...first,...second];
      const idSet = new Set(all.map((item) => String(item.id)));
      assert.equal(idSet.size,all.length);
      assert.equal(all.filter((item) => item.category === 'pagination').length,105);
      assert.ok(all.every((item,index) => index === 0 || BigInt(all[index-1].id) > BigInt(item.id)));
    });
    await t.test('legacy active bits do not bypass version approval or explicit activation', async () => {
      const fixtures = [['approved',true],['approved',false],['pending',true],['rejected',true],['false_positive',true]];
      const ruleIds = [];
      for (const [status,active] of fixtures) {
        const key = require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
        const [candidate] = await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category,status) VALUES (?,?,'validation','retrieval',?)", [slotId,key,status]);
        const [rule] = await pool.execute('INSERT INTO learning_rules (candidate_id,rule_key,instruction,scope,active,approved_by) VALUES (?,?,?,?,?,?)', [candidate.insertId,key,`Rule ${status}`, 'account',active,adminId]);
        ruleIds.push(String(rule.insertId));
        if (status==='approved') {
          await pool.execute("INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,created_by) VALUES (?,1,?,'account','account','all',?,?,?)",[rule.insertId,`Rule ${status}`,candidate.insertId,slotId,adminId]);
          await pool.execute("INSERT INTO learning_rule_version_decisions (rule_id,version,decision,actor_id,reason) VALUES (?,1,'approved',?,'')",[rule.insertId,adminId]);
        }
      }
      const retrieve=createLearningStore(pool,{activationEnabled:true,retrievalEnabled:true});
      assert.deepEqual((await retrieve.listActiveRules({scope:'account'})),[]);
      await pool.execute('INSERT INTO learning_rule_active_versions (rule_id,version,activated_by) VALUES (?,1,?)',[ruleIds[0],adminId]);
      const activeIds = new Set((await retrieve.listActiveRules({scope:'account'})).map((rule) => String(rule.id)));
      assert.ok(activeIds.has(ruleIds[0]));
      for (const id of ruleIds.slice(1)) assert.equal(activeIds.has(id),false);
      await pool.execute('DELETE FROM learning_rule_active_versions WHERE rule_id=?',[ruleIds[0]]);
    });

    await t.test('rule revisions require independent approval and activation; rollback and supersession are audited',async()=>{
      const enabledStore=createLearningStore(pool,{activationEnabled:true,retrievalEnabled:true});
      const makeApprovedRule=async(instruction)=>{
        const key=require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
        const [candidate]=await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','lifecycle')",[slotId,key]);
        await enabledStore.decide(candidate.insertId,{version:1,decision:'approved',instruction,scope:'account',contentTopic:'community'},adminId);
        const [[rule]]=await pool.execute('SELECT id FROM learning_rules WHERE candidate_id=?',[candidate.insertId]);
        return {candidateId:candidate.insertId,ruleId:String(rule.id)};
      };
      const first=await makeApprovedRule('Gunakan pembukaan yang berbeza.');
      const [[initial]]=await pool.execute('SELECT active,version FROM learning_rules WHERE id=?',[first.ruleId]);
      assert.equal(Boolean(initial.active),false);
      assert.equal(Number(initial.version),1);
      const inactiveListing=(await enabledStore.listRules()).find((rule)=>String(rule.id)===first.ruleId);
      assert.equal(inactiveListing.active,false);
      assert.equal(inactiveListing.superseded,false);
      await enabledStore.activateRule(first.ruleId,{version:1,reason:'Semakan awal.'},adminId);
      const activatedListing=(await enabledStore.listRules()).find((rule)=>String(rule.id)===first.ruleId);
      assert.equal(activatedListing.active,true);
      assert.equal(activatedListing.superseded,false);
      const revised=await enabledStore.createRevision(first.ruleId,{expectedVersion:1,instruction:'Mulakan dengan pemerhatian ringkas.',scope:'account',productCategory:'account',contentTopic:'community',reason:'Kemas kini gaya.'},adminId);
      assert.equal(revised.approvalStatus,'pending');
      assert.equal(revised.activeVersion,1);
      await assert.rejects(enabledStore.activateRule(first.ruleId,{version:2},adminId),{code:'RULE_VERSION_NOT_APPROVED'});
      await enabledStore.decideRuleVersion(first.ruleId,2,{decision:'approved',reason:'Lulus semakan.'},adminId);
      const revisedListing=(await enabledStore.listRules()).find((rule)=>String(rule.id)===first.ruleId);
      assert.equal(revisedListing.activeVersion,1);
      assert.equal(revisedListing.approvalStatus,'approved');
      await enabledStore.activateRule(first.ruleId,{version:2},adminId);
      await enabledStore.rollbackRule(first.ruleId,{version:1,reason:'Pulihkan versi stabil.'},adminId);
      const versions=await enabledStore.listRuleVersions(first.ruleId);
      assert.deepEqual(versions.map(({version,decision})=>[version,decision]).sort((a,b)=>a[0]-b[0]),[[1,'approved'],[2,'approved']]);
      assert.equal(versions[0].source.candidateId,first.candidateId.toString());
      assert.equal(versions[0].source.slotId,slotId);
      await enabledStore.deactivateRule(first.ruleId,{version:1,reason:'Tamat ujian.'},adminId);

      const replacement=await makeApprovedRule('Pilih satu contoh yang relevan.');
      await enabledStore.activateRule(first.ruleId,{version:1},adminId);
      const superseded=await enabledStore.supersedeRule(first.ruleId,{version:1,replacementRuleId:replacement.ruleId,replacementVersion:1,reason:'Ganti dengan peraturan baharu.'},adminId);
      assert.equal(superseded.supersededBy,replacement.ruleId);
      const supersededListing=(await enabledStore.listRules()).find((rule)=>String(rule.id)===first.ruleId);
      assert.equal(supersededListing.superseded,true);
      const [[relation]]=await pool.execute('SELECT replacement_rule_id FROM learning_rule_supersessions WHERE rule_id=?',[first.ruleId]);
      assert.equal(String(relation.replacement_rule_id),replacement.ruleId);
      const actions=await enabledStore.listRuleActions(first.ruleId);
      assert.ok(actions.some(({action})=>action==='created'));
      assert.ok(actions.some(({action})=>action==='version_approved'));
      assert.ok(actions.some(({action})=>action==='rolled_back'));
      assert.ok(actions.some(({action})=>action==='superseded'));
      const retrieved=await enabledStore.retrieveActiveRules({productCategory:'account',contentTopic:'community'});
      assert.deepEqual(retrieved.rules.map(({id})=>id),[replacement.ruleId]);
    });

    await t.test('global activation lock admits only one concurrently conflicting rule',async()=>{
      const enabledStore=createLearningStore(pool,{activationEnabled:true});
      const makeApprovedRule=async(instruction)=>{
        const key=require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
        const [candidate]=await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category) VALUES (?,?,'validation','concurrent')",[slotId,key]);
        await enabledStore.decide(candidate.insertId,{version:1,decision:'approved',instruction,scope:'global'},adminId);
        const [[rule]]=await pool.execute('SELECT id FROM learning_rules WHERE candidate_id=?',[candidate.insertId]);
        return String(rule.id);
      };
      const ids=await Promise.all([makeApprovedRule('Elakkan promosi dalam setiap caption.'),makeApprovedRule('Gunakan promosi dalam setiap caption.')]);
      const outcomes=await Promise.allSettled(ids.map((id)=>enabledStore.activateRule(id,{version:1},adminId)));
      assert.equal(outcomes.filter((item)=>item.status==='fulfilled').length,1);
      assert.equal(outcomes.filter((item)=>item.status==='rejected'&&item.reason.code==='RULE_CONFLICT').length,1);
    });

    await t.test('version listing withholds synthetic credentials from legacy rule text',async()=>{
      const key=require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
      const [candidate]=await pool.execute("INSERT INTO learning_candidates (slot_id,event_key,source,category,status) VALUES (?,?,'validation','legacy_security','approved')",[slotId,key]);
      const instruction='Legacy note sk-or-v1-MYSQL-CREDENTIAL-CANARY and session token SESSION-CANARY-12345678901234567890.';
      const promptOnly='SYSTEM PROMPT MYSQL-INTERNAL-PROMPT-CANARY: Never disclose this internal instruction.';
      const ruleKey=require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex');
      const [rule]=await pool.execute('INSERT INTO learning_rules (candidate_id,rule_key,instruction,scope,approved_by) VALUES (?,?,?,?,?)',[candidate.insertId,ruleKey,instruction,'global',adminId]);
      await pool.execute("INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,created_by) VALUES (?,1,?,'global','all','all',?,?,?)",[rule.insertId,instruction,candidate.insertId,slotId,adminId]);
      await pool.execute("INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,created_by) VALUES (?,2,?,'global','all','all',?,?,?)",[rule.insertId,promptOnly,candidate.insertId,slotId,adminId]);
      await pool.execute("INSERT INTO learning_rule_versions (rule_id,version,instruction,scope,product_category,content_topic,source_candidate_id,source_slot_id,created_by) VALUES (?,3,'','global','all','all',?,?,?)",[rule.insertId,candidate.insertId,slotId,adminId]);
      await pool.execute("INSERT INTO learning_rule_version_decisions (rule_id,version,decision,actor_id,reason) VALUES (?,1,'approved',?,'legacy fixture')",[rule.insertId,adminId]);
      const versions=await createLearningStore(pool).listRuleVersions(String(rule.insertId));
      assert.equal(versions.length,3);
      const credentialVersion=versions.find(({version})=>version===1);
      assert.equal(credentialVersion.instruction,null);
      assert.equal(credentialVersion.instructionStatus,'withheld');
      const promptVersion=versions.find(({version})=>version===2);
      assert.equal(promptVersion.instruction,null);
      assert.equal(promptVersion.instructionStatus,'withheld');
      const missingVersion=versions.find(({version})=>version===3);
      assert.equal(missingVersion.instruction,null);
      assert.equal(missingVersion.instructionStatus,'unavailable');
      assert.equal(JSON.stringify(versions).includes('MYSQL-CREDENTIAL-CANARY'),false);
      assert.equal(JSON.stringify(versions).includes('SESSION-CANARY-12345678901234567890'),false);
      assert.equal(JSON.stringify(versions).includes('MYSQL-INTERNAL-PROMPT-CANARY'),false);
    });
  } finally {
    if (adminId) {
      await pool.execute('DELETE FROM learning_rule_actions WHERE rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?)',[slotId]);
      await pool.execute('DELETE FROM learning_rule_supersessions WHERE rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?) OR replacement_rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?)',[slotId,slotId]);
      await pool.execute('DELETE FROM learning_rule_active_versions WHERE rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?)',[slotId]);
      await pool.execute('DELETE FROM learning_rule_version_decisions WHERE rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?)',[slotId]);
      await pool.execute('DELETE FROM learning_rule_versions WHERE rule_id IN (SELECT r.id FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?)',[slotId]);
      await pool.execute('DELETE FROM learning_capture_events WHERE slot_id=?',[slotId]);
      await pool.execute('DELETE r FROM learning_reviews r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?',[slotId]);
      await pool.execute('DELETE r FROM learning_rules r JOIN learning_candidates c ON c.id=r.candidate_id WHERE c.slot_id=?',[slotId]);
      await pool.execute('DELETE FROM learning_candidates WHERE slot_id=?',[slotId]);
      await pool.execute('DELETE FROM learning_feedback WHERE slot_id=?',[slotId]);
      await pool.execute('DELETE FROM slots WHERE id=?',[slotId]);
      await pool.execute('DELETE FROM admins WHERE id=?',[adminId]);
    }
    await pool.end();
  }
});
