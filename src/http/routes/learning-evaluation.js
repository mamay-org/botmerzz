'use strict';
function registerLearningEvaluationRoutes(app, { services, authenticated, mutation }) {
  const shadowStartRateLimit = async (req,res,next) => {
    const store=services.learningShadowStore;
    if (typeof store?.consumeStartQuota !== 'function') return res.status(503).json({error:'SHADOW_EVALUATION_UNAVAILABLE'});
    try {
      const quota=await store.consumeStartQuota(req.admin.id);
      if (!quota.allowed) {
        res.set('Retry-After',String(quota.retryAfterSeconds));
        return res.status(429).json({error:'RATE_LIMITED'});
      }
      return next();
    } catch (error) { return next(error); }
  };
  const requireShadowEnabled = (_req,res,next) => services.learningFlags?.shadowEnabled === true
    ? next() : res.status(503).json({error:'SHADOW_EVALUATION_DISABLED'});
  const validateShadowRequest = (req,res,next) => {
    const {ruleIds,samples = 1} = req.body || {};
    if (!Array.isArray(ruleIds) || ruleIds.length < 1 || ruleIds.length > 5
      || ruleIds.some((id) => !(typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id)))
      || new Set(ruleIds).size !== ruleIds.length
      || !Number.isInteger(samples) || samples < 1 || samples > 3) return res.status(400).json({error:'INVALID_SHADOW_REQUEST'});
    if (typeof services.evaluateLearningShadow !== 'function') return res.status(503).json({error:'SHADOW_EVALUATION_UNAVAILABLE'});
    req.learningShadowRequest = {ruleIds,samples};
    return next();
  };
  app.get('/api/learning/metrics', authenticated, async (req, res, next) => {
    try {
      const analytics = services.learningAnalytics;
      if (!analytics) return res.status(503).json({error:'LEARNING_ANALYTICS_UNAVAILABLE'});
      const window = {from:req.query.from, to:req.query.to};
      const [compliance,quality,effectiveness] = await Promise.all([
        analytics.compliance(window), analytics.quality(window), analytics.effectiveness(window),
      ]);
      return res.json({compliance,quality,effectiveness});
    } catch (error) { return next(error); }
  });

  app.get('/api/learning/shadow-evaluations', authenticated, async (req, res, next) => {
    try {
      const store = services.learningShadowStore;
      if (!store) return res.status(503).json({error:'SHADOW_EVALUATION_UNAVAILABLE'});
      const beforeId = req.query.beforeId === undefined ? null : req.query.beforeId;
      if (beforeId !== null && (typeof beforeId !== 'string' || !/^[1-9]\d{0,19}$/.test(beforeId))) return res.status(400).json({error:'INVALID_CURSOR'});
      const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({error:'INVALID_LIMIT'});
      return res.json(await store.list({beforeId,limit}));
    } catch (error) { return next(error); }
  });

  app.get('/api/learning/shadow-evaluations/:id', authenticated, async (req, res, next) => {
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      const evaluation = await services.learningShadowStore?.get(req.params.id);
      return evaluation ? res.json({evaluation}) : res.status(404).json({error:'EVALUATION_NOT_FOUND'});
    } catch (error) { return next(error); }
  });

  app.get('/api/learning/shadow-evaluations/:id/reviews', authenticated, async (req, res, next) => {
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      const reviews = await services.learningShadowStore?.listReviews(req.params.id);
      if (!reviews) return res.status(503).json({error:'SHADOW_EVALUATION_UNAVAILABLE'});
      return res.json({reviews});
    } catch (error) { return next(error); }
  });

  app.post('/api/learning/shadow-evaluations', authenticated, mutation, requireShadowEnabled, validateShadowRequest, shadowStartRateLimit, async (req, res, next) => {
    try {
      const {ruleIds,samples} = req.learningShadowRequest;
      return res.status(201).json({evaluation:await services.evaluateLearningShadow({actorId:req.admin.id,ruleIds,samples})});
    } catch (error) { return next(error); }
  });

  app.post('/api/learning/shadow-evaluations/:id/reviews', authenticated, mutation, async (req, res, next) => {
    try {
      if (!/^[1-9]\d{0,19}$/.test(req.params.id)) return res.status(400).json({error:'INVALID_ID'});
      const review = await services.learningShadowStore?.recordReview(req.params.id,req.body,req.admin.id);
      return review ? res.status(201).json({review}) : res.status(503).json({error:'SHADOW_EVALUATION_UNAVAILABLE'});
    } catch (error) { return next(error); }
  });
}

module.exports = {registerLearningEvaluationRoutes};
