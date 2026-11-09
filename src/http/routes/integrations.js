'use strict';

const { createIpRateLimiter } = require('../../rate-limit');
const { validId, validModel } = require('../../configuration');

function invalid() { return Object.assign(new Error('INVALID_REQUEST'), { code:'INVALID_REQUEST', status:400 }); }
function bodyWith(req, keys) {
  const body=req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || keys.some(key=>!Object.hasOwn(body,key))) throw invalid();
  return body;
}
function version(value) { if (!Number.isSafeInteger(value) || value<1) throw invalid(); return value; }
function requireServices(services) {
  if (!services.configuration || !services.configurationValidators) throw Object.assign(new Error('CONFIG_UNAVAILABLE'),{code:'CONFIG_UNAVAILABLE',status:503});
  return { store:services.configuration, validator:services.configurationValidators };
}
async function validate(store, actorId, kind, action) {
  try {
    const result = await action();
    await store.recordValidation({actorId,kind,outcome:'success'});
    return result;
  } catch (e) {
    try { await store.recordValidation({actorId,kind,outcome:'failed',code:e.code}); } catch { /* Fail closed and retain the original error. */ }
    throw e;
  }
}
function registerIntegrationRoutes(app, { services, authenticated, mutation }) {
  const limit=createIpRateLimiter({limit:30,windowMs:60_000});
  app.get('/api/integrations', authenticated, async (_req,res,next)=>{
    try { const {store}=requireServices(services); const [configuration,history]=await Promise.all([store.getActive(),store.history()]); return res.json({configuration,history}); } catch(e){return next(e);}
  });
  app.get('/api/integrations/models', authenticated, limit, async (_req,res,next)=>{
    try { const {validator}=requireServices(services); return res.json({models:await validator.listModels()}); } catch(e){return next(e);}
  });
  app.post('/api/integrations/validate-account', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['profileId','accountId']); if(!validId(body.profileId)||!validId(body.accountId))throw invalid(); const {store,validator}=requireServices(services); return res.json({account:await validate(store,req.admin.id,'account',()=>validator.validateAccount(body))}); } catch(e){return next(e);}
  });
  app.post('/api/integrations/validate-model', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['model']); if(!validModel(body.model))throw invalid(); const {store,validator}=requireServices(services); return res.json({model:await validate(store,req.admin.id,'model',()=>validator.validateModel(body.model))}); } catch(e){return next(e);}
  });
  app.put('/api/integrations/model', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['model','expectedVersion']); if(!validModel(body.model))throw invalid(); version(body.expectedVersion); const {store,validator}=requireServices(services); await validate(store,req.admin.id,'model',()=>validator.validateModel(body.model)); const configuration=await store.setModel({model:body.model,expectedVersion:body.expectedVersion,actorId:req.admin.id}); return res.json({configuration}); } catch(e){return next(e);}
  });
  app.put('/api/integrations/account', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['profileId','accountId','expectedVersion','confirmed']); if(!validId(body.profileId)||!validId(body.accountId)||body.confirmed!==true)throw invalid(); version(body.expectedVersion); const {store,validator}=requireServices(services); await validate(store,req.admin.id,'account',()=>validator.validateAccount(body)); const configuration=await store.switchAccount({...body,actorId:req.admin.id}); return res.json({configuration}); } catch(e){return next(e);}
  });
  app.post('/api/integrations/reconcile', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['expectedVersion']); version(body.expectedVersion); const {store,validator}=requireServices(services); const current=await store.getActive(); if(current.version!==body.expectedVersion)throw Object.assign(new Error('CONFIG_CONFLICT'),{code:'CONFIG_CONFLICT',status:409}); if(!current.pendingProfileId || !current.pendingAccountId)throw Object.assign(new Error('NO_SWITCH_PENDING'),{code:'NO_SWITCH_PENDING',status:409}); await validate(store,req.admin.id,'account',()=>validator.validateAccount({profileId:current.pendingProfileId,accountId:current.pendingAccountId})); if(services.reconcileSwitch)await services.reconcileSwitch(); const configuration=await store.resumeSwitch({expectedVersion:body.expectedVersion,actorId:req.admin.id}); return res.json({configuration}); } catch(e){return next(e);}
  });
  app.post('/api/integrations/rollback', authenticated, mutation, limit, async (req,res,next)=>{
    try { const body=bodyWith(req,['version','expectedVersion','confirmed','component']); version(body.version); version(body.expectedVersion); if(body.confirmed!==true || !['account','model'].includes(body.component))throw invalid(); const {store,validator}=requireServices(services); const [current,previous]=await Promise.all([store.getActive(),store.getHistoryVersion(body.version)]); if(current.version!==body.expectedVersion)throw Object.assign(new Error('CONFIG_CONFLICT'),{code:'CONFIG_CONFLICT',status:409}); let configuration; if(body.component==='account') { if(!previous.profileId || !previous.accountId)throw Object.assign(new Error('CONFIG_VERSION_NOT_RESTORABLE'),{code:'CONFIG_VERSION_NOT_RESTORABLE',status:409}); await validate(store,req.admin.id,'account',()=>validator.validateAccount({profileId:previous.profileId,accountId:previous.accountId})); configuration=await store.switchAccount({profileId:previous.profileId,accountId:previous.accountId,expectedVersion:body.expectedVersion,actorId:req.admin.id,action:'account_rollback'}); } else { if(!previous.model)throw Object.assign(new Error('CONFIG_VERSION_NOT_RESTORABLE'),{code:'CONFIG_VERSION_NOT_RESTORABLE',status:409}); await validate(store,req.admin.id,'model',()=>validator.validateModel(previous.model)); configuration=await store.setModel({model:previous.model,expectedVersion:body.expectedVersion,actorId:req.admin.id,action:'model_rollback'}); } return res.json({configuration}); } catch(e){return next(e);}
  });
}
module.exports = { registerIntegrationRoutes };
