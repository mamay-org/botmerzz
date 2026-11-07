'use strict';

const templateCategories = new Set(['brand', 'topup', 'account']);

function templateText(value, max, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) return null;
  return value.trim();
}

function templateList(value, { maxItems = 50, maxLength = 200 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems
    || !value.every((entry) => typeof entry === 'string' && entry.length <= maxLength)) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function normalizeTemplateData(category, data, whitelist) {
  if (!templateCategories.has(category) || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const schemas = {
    brand: ['brandName', 'voice', 'audienceNotes', 'contentDirection', 'hookVocabulary', 'gameWhitelist', 'trackedTopup', 'trackedAccount', 'forbiddenClaims', 'approvedClaims'],
    topup: ['game', 'denomination'],
    account: ['attributes'],
  };
  if (Object.keys(data).some((key) => !schemas[category].includes(key))) return null;
  const result = {};
  const addText = (key, max, required = false) => {
    if (data[key] === undefined) return true;
    const value = templateText(data[key], max, { required });
    if (value === null) return false;
    result[key] = value;
    return true;
  };

  if (category === 'brand') {
    const textLimits = [
      ['brandName', 120],
      ['voice', 500],
      ['audienceNotes', 7000],
      ['contentDirection', 7000],
      ['trackedTopup', 300],
      ['trackedAccount', 300],
    ];
    for (const [key, max] of textLimits) {
      if (!addText(key, max)) return null;
    }
    for (const key of ['trackedTopup', 'trackedAccount']) {
      if (!result[key]) continue;
      try {
        const url = new URL(result[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      } catch {
        return null;
      }
    }
    const listLimits = [
      ['gameWhitelist', { maxItems: 50, maxLength: 80 }],
      ['hookVocabulary', { maxItems: 100, maxLength: 500 }],
      ['forbiddenClaims', { maxItems: 40, maxLength: 200 }],
      ['approvedClaims', { maxItems: 40, maxLength: 200 }],
    ];
    for (const [key, options] of listLimits) {
      if (data[key] === undefined) continue;
      result[key] = templateList(data[key], options);
      if (!result[key]) return null;
    }
    if (result.gameWhitelist?.some((game) => !whitelist.includes(game))) return { error: 'GAME_NOT_WHITELISTED' };
  } else if (category === 'topup') {
    if (!addText('game', 80, true) || !addText('denomination', 120)) return null;
    if (!whitelist.includes(result.game)) return { error: 'GAME_NOT_WHITELISTED' };
  } else if (data.attributes !== undefined) {
    result.attributes = templateList(data.attributes, { maxItems: 20, maxLength: 100 });
    if (!result.attributes) return null;
  }

  return result;
}

function normalizeTemplateName(value) {
  return templateText(value, 80, { required: true });
}

function registerTemplateRoutes(app, { repository, authenticated, mutation }) {
  app.get('/api/templates', authenticated, async (_req, res, next) => {
    try { return res.json({ templates: await repository.listTemplates() }); } catch (error) { return next(error); }
  });

  app.post('/api/templates', authenticated, mutation, async (req, res, next) => {
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['name', 'category', 'data'].includes(key))) {
      return res.status(400).json({ error: 'INVALID_TEMPLATE' });
    }
    const name = normalizeTemplateName(body.name);
    const category = body.category;
    if (!name || !templateCategories.has(category)) return res.status(400).json({ error: 'INVALID_TEMPLATE' });
    try {
      const settings = await repository.getSettings();
      const data = normalizeTemplateData(category, body.data, settings.gameWhitelist || []);
      if (!data || data.error) return res.status(400).json({ error: data?.error || 'INVALID_TEMPLATE_DATA' });
      const template = await repository.createTemplate({ name, category, data, actorId: req.admin.id });
      return res.status(201).json({ template });
    } catch (error) {
      if (error.code === 'TEMPLATE_EXISTS') return res.status(409).json({ error: 'TEMPLATE_EXISTS' });
      return next(error);
    }
  });

  app.patch('/api/templates/:id', authenticated, mutation, async (req, res, next) => {
    const id = req.params.id;
    const body = req.body || {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['name', 'data'].includes(key)) || !Object.keys(body).length) {
      return res.status(400).json({ error: 'INVALID_TEMPLATE' });
    }
    try {
      const existing = await repository.getTemplate(id);
      if (!existing) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
      const name = body.name === undefined ? existing.name : normalizeTemplateName(body.name);
      if (!name) return res.status(400).json({ error: 'INVALID_TEMPLATE' });
      let data;
      if (body.data !== undefined) {
        const settings = await repository.getSettings();
        data = normalizeTemplateData(existing.category, body.data, settings.gameWhitelist || []);
        if (!data || data.error) return res.status(400).json({ error: data?.error || 'INVALID_TEMPLATE_DATA' });
      }
      const template = await repository.updateTemplate(id, { name, data, actorId: req.admin.id });
      if (!template) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
      return res.json({ template });
    } catch (error) {
      if (error.code === 'TEMPLATE_EXISTS') return res.status(409).json({ error: 'TEMPLATE_EXISTS' });
      return next(error);
    }
  });

  app.delete('/api/templates/:id', authenticated, mutation, async (req, res, next) => {
    const id = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'INVALID_TEMPLATE' });
    }
    try {
      if (!await repository.deleteTemplate(id, req.admin.id)) return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
      return res.json({ deleted: true });
    } catch (error) {
      return next(error);
    }
  });
}

module.exports = { registerTemplateRoutes, normalizeTemplateData, normalizeTemplateName };
