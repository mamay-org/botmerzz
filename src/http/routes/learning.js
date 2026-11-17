'use strict';
const { createLearningStore } = require('../../learning');
function registerLearningRoutes(app, { services, authenticated, mutation }) {
  const store = () => {
    if (!services.pool) throw Object.assign(new Error('LEARNING_UNAVAILABLE'), { status: 503, code: 'LEARNING_UNAVAILABLE' });
    return createLearningStore(services.pool,{activationEnabled:services.learningFlags?.activationEnabled===true,
      retrievalEnabled:services.learningFlags?.retrievalEnabled===true,promptIntegrationEnabled:services.learningFlags?.promptIntegrationEnabled===true});
  };
  app.get('/api/learning/capabilities',authenticated,(_req,res)=>res.json({
    captureEnabled:services.learningFlags?.captureEnabled===true,
    activationEnabled:services.learningFlags?.activationEnabled===true,
    retrievalEnabled:services.learningFlags?.retrievalEnabled===true,
    promptIntegrationEnabled:services.learningFlags?.promptIntegrationEnabled===true,
    shadowEnabled:services.learningFlags?.shadowEnabled===true,
  }));
  app.get('/api/learning/candidates', authenticated, async (req, res, next) => {
    try {
      const status = req.query.status === undefined ? '' : req.query.status;
      if (typeof status !== 'string') return res.status(400).json({error:'INVALID_STATUS'});
      if (status && !['pending','approved','rejected','false_positive'].includes(status)) return res.status(400).json({error:'INVALID_STATUS'});
      const source = req.query.source === undefined ? '' : req.query.source;
      if (typeof source !== 'string' || (source && !['validation','feedback'].includes(source))) return res.status(400).json({error:'INVALID_SOURCE'});
      const search = req.query.q === undefined ? '' : req.query.q;
      if (typeof search !== 'string' || [...search].length > 80 || /[\u0000-\u001f\u007f]/u.test(search)) return res.status(400).json({error:'INVALID_SEARCH'});
      const beforeId = req.query.beforeId === undefined ? null : req.query.beforeId;
      if (beforeId !== null && (typeof beforeId !== 'string' || !/^[1-9]\d{0,19}$/.test(beforeId))) return res.status(400).json({error:'INVALID_CURSOR'});
      const candidates = await store().listCandidates(status, beforeId, search, source);
      return res.json({candidates, nextBeforeId:candidates.hasMore ? String(candidates.at(-1).id) : null});
    } catch (error) { return next(error); }
  });
  app.get('/api/learning/rules', authenticated, async (_req, res, next) => {
    try { return res.json({rules:await store().listRules()}); } catch (error) { return next(error); }
  });
  app.get('/api/learning/rules/:id/versions',authenticated,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({versions:await store().listRuleVersions(req.params.id)});
    } catch(error) { return next(error); }
  });
  app.get('/api/learning/rules/:id/history',authenticated,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({actions:await store().listRuleActions(req.params.id)});
    } catch(error) { return next(error); }
  });
  app.post('/api/learning/rules/:id/activation-preview',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({preview:await store().previewActivation(req.params.id,req.body)});
    } catch(error) { return next(error); }
  });
  app.get('/api/learning/reviews', authenticated, async (_req, res, next) => {
    try { return res.json({reviews:await store().listReviews()}); } catch (error) { return next(error); }
  });
  app.post('/api/learning/feedback', authenticated, mutation, async (req, res, next) => {
    try { return res.status(201).json({feedback:await store().feedback(req.body, req.admin.id)}); } catch (error) { return next(error); }
  });
  app.post('/api/learning/candidates/:id/decision', authenticated, mutation, async (req, res, next) => {
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({candidate:await store().decide(req.params.id, req.body, req.admin.id)});
    } catch (error) { return next(error); }
  });
  app.post('/api/learning/rules/:id/activation',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({rule:await store().activateRule(req.params.id,req.body,req.admin.id)});
    } catch(error) {
      if (error.code==='RULE_CONFLICT') return res.status(error.status||409).json({error:error.code,conflicts:error.conflicts||[]});
      return next(error);
    }
  });
  app.post('/api/learning/rules/:id/deactivation',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({rule:await store().deactivateRule(req.params.id,req.body,req.admin.id)});
    } catch(error) { return next(error); }
  });
  app.post('/api/learning/rules/:id/revisions',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.status(201).json({rule:await store().createRevision(req.params.id,req.body,req.admin.id)});
    } catch(error) { return next(error); }
  });
  app.post('/api/learning/rules/:id/versions/:version/decision',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id) || !/^[1-9]\d{0,9}$/.test(req.params.version)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({rule:await store().decideRuleVersion(req.params.id,Number(req.params.version),req.body,req.admin.id)});
    } catch(error) { return next(error); }
  });
  app.post('/api/learning/rules/:id/rollback',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({rule:await store().rollbackRule(req.params.id,req.body,req.admin.id)});
    } catch(error) {
      if (error.code==='RULE_CONFLICT') return res.status(error.status||409).json({error:error.code,conflicts:error.conflicts||[]});
      return next(error);
    }
  });
  app.post('/api/learning/rules/:id/supersession',authenticated,mutation,async(req,res,next)=>{
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      return res.json({rule:await store().supersedeRule(req.params.id,req.body,req.admin.id)});
    } catch(error) {
      if (error.code==='RULE_CONFLICT') return res.status(error.status||409).json({error:error.code,conflicts:error.conflicts||[]});
      return next(error);
    }
  });
}
module.exports = {registerLearningRoutes};
