'use strict';

const axios = require('axios');
const { createTebarClient } = require('./providers/tebar');
const { validId, validModel } = require('./configuration');
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
function createConfigurationValidators({ config, http = axios, tebarFactory = createTebarClient, clock = () => Date.now() }) {
  if (!config) throw new TypeError('config is required');
  let modelCatalog = null;
  let modelCatalogExpiresAt = 0;
  let modelCatalogRequest = null;
  async function validateAccount({ profileId, accountId }) {
    if (!validId(profileId) || !validId(accountId)) throw failure('INVALID_ACCOUNT');
    if (!config.tebar?.apiKey) throw failure('TEBAR_NOT_CONFIGURED', 503);
    let accounts;
    try { accounts = await tebarFactory({ apiKey: config.tebar.apiKey, profileId, http }).listAccounts(); }
    catch (e) { throw failure(e.code === 'unauthorized' ? 'TEBAR_UNAUTHORIZED' : e.code === 'rate_limited' ? 'TEBAR_RATE_LIMITED' : 'TEBAR_UNAVAILABLE', 503); }
    const target = accounts.find(a => a.id === accountId && a.profileId === profileId);
    if (!target || target.platform !== 'threads' || target.status !== 'active' || target.planSuspended !== false) throw failure('ACCOUNT_NOT_AVAILABLE', 422);
    return { id: target.id, profileId: target.profileId, username: target.username, platform: target.platform, status: target.status };
  }
  function requireOpenRouter() {
    if (!config.openRouter?.apiKey) throw failure('OPENROUTER_NOT_CONFIGURED', 503);
    return { Authorization: `Bearer ${config.openRouter.apiKey}` };
  }
  async function request(path, { modelLookup = false } = {}) {
    try { return (await http.request({ method:'GET', url:`https://openrouter.ai/api/v1/${path}`, headers:requireOpenRouter(), timeout:15000, maxRedirects:0 })).data; }
    catch (e) {
      if (e.code === 'OPENROUTER_NOT_CONFIGURED') throw e;
      const status=e.response?.status;
      if (status === 404 && modelLookup) throw failure('MODEL_NOT_FOUND', 422);
      if (status === 429) throw failure('OPENROUTER_RATE_LIMITED', 503);
      if (status === 401 || status === 403) throw failure('OPENROUTER_UNAUTHORIZED', 503);
      throw failure('OPENROUTER_UNAVAILABLE', 503);
    }
  }
  function modelMetadata(item) {
    const [provider] = item.id.split('/');
    const inputModalities = item.architecture?.input_modalities;
    const outputModalities = item.architecture?.output_modalities;
    const parameters = item.supported_parameters;
    let status = 'AVAILABLE';
    let reason = null;
    if (!Array.isArray(inputModalities) || !Array.isArray(outputModalities) || !Array.isArray(parameters)) {
      status = 'UNVERIFIED'; reason = 'METADATA_INCOMPLETE';
    } else if (!inputModalities.includes('text') || !outputModalities.includes('text')) {
      status = 'INCOMPATIBLE'; reason = 'TEXT_MODALITY_UNSUPPORTED';
    // OpenRouter lists `max_tokens` for some models; its chat endpoint accepts
    // `max_completion_tokens` as the modern equivalent sent by our adapter.
    } else if (!parameters.includes('max_tokens') && !parameters.includes('max_completion_tokens')) {
      status = 'INCOMPATIBLE'; reason = 'COMPLETION_LIMIT_UNSUPPORTED';
    } else {
      const sampling = config.openRouter?.generatorSampling || {};
      if (sampling.temperature !== undefined && !parameters.includes('temperature')) {
        status = 'INCOMPATIBLE'; reason = 'TEMPERATURE_UNSUPPORTED';
      } else if (sampling.topP !== undefined && !parameters.includes('top_p')) {
        status = 'INCOMPATIBLE'; reason = 'TOP_P_UNSUPPORTED';
      }
    }
    return {
      id: item.id,
      name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id,
      provider: provider.slice(0, 100), status, reason,
    };
  }
  async function validateModel(model) {
    if (!validModel(model)) throw failure('INVALID_MODEL');
    const [author, slug]=model.split('/');
    const data=(await request(`model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`, { modelLookup:true }))?.data;
    if (!data || data.id !== model) throw failure('MODEL_NOT_FOUND',422);
    const result = modelMetadata(data);
    if (result.status === 'INCOMPATIBLE') throw failure('MODEL_INCOMPATIBLE',422);
    if (result.status === 'UNVERIFIED') throw failure('MODEL_METADATA_UNVERIFIED',503);
    return result;
  }
  async function listModels() {
    if (modelCatalog && clock() < modelCatalogExpiresAt) return modelCatalog.map(item => ({ ...item }));
    if (!modelCatalogRequest) modelCatalogRequest = (async () => {
      const data=(await request('models'))?.data;
      if (!Array.isArray(data)) throw failure('OPENROUTER_UNAVAILABLE',503);
      const models=data.filter(item => validModel(item?.id)).map(modelMetadata);
      modelCatalog = models;
      modelCatalogExpiresAt = clock() + MODEL_CATALOG_TTL_MS;
      return models;
    })();
    try { return (await modelCatalogRequest).map(item => ({ ...item })); }
    finally { modelCatalogRequest = null; }
  }
  return { validateAccount, validateModel, listModels };
}
module.exports = { createConfigurationValidators };
