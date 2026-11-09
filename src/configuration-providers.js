'use strict';

const axios = require('axios');
const { createTebarClient } = require('./providers/tebar');
const { validId, validModel } = require('./configuration');
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function createConfigurationValidators({ config, http = axios, tebarFactory = createTebarClient }) {
  if (!config) throw new TypeError('config is required');
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
  async function request(path) {
    try { return (await http.request({ method:'GET', url:`https://openrouter.ai/api/v1/${path}`, headers:requireOpenRouter(), timeout:15000, maxRedirects:0 })).data; }
    catch (e) {
      if (e.code === 'OPENROUTER_NOT_CONFIGURED') throw e;
      const status=e.response?.status;
      if (status === 404) throw failure('MODEL_NOT_FOUND', 422);
      if (status === 429) throw failure('OPENROUTER_RATE_LIMITED', 503);
      if (status === 401 || status === 403) throw failure('OPENROUTER_UNAUTHORIZED', 503);
      throw failure('OPENROUTER_UNAVAILABLE', 503);
    }
  }
  async function validateModel(model) {
    if (!validModel(model)) throw failure('INVALID_MODEL');
    const [author, slug]=model.split('/');
    const data=(await request(`model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`))?.data;
    if (!data || data.id !== model || !Array.isArray(data.architecture?.input_modalities) || !data.architecture.input_modalities.includes('text')
      || !Array.isArray(data.architecture?.output_modalities) || !data.architecture.output_modalities.includes('text')
      || !Array.isArray(data.supported_parameters)) throw failure('MODEL_INCOMPATIBLE',422);
    const parameters=data.supported_parameters;
    const sampling=config.openRouter.generatorSampling || {};
    if (!parameters.includes('max_tokens') && !parameters.includes('max_completion_tokens')) throw failure('MODEL_INCOMPATIBLE',422);
    if ((sampling.temperature !== undefined && !parameters.includes('temperature')) || (sampling.topP !== undefined && !parameters.includes('top_p'))) throw failure('MODEL_INCOMPATIBLE',422);
    return { id:data.id, name:typeof data.name === 'string' ? data.name.slice(0,200) : data.id };
  }
  async function listModels() {
    const data=(await request('models'))?.data;
    if (!Array.isArray(data)) throw failure('OPENROUTER_UNAVAILABLE',503);
    return data.filter(item=>validModel(item?.id) && item.architecture?.input_modalities?.includes('text') && item.architecture?.output_modalities?.includes('text'))
      .map(item=>({ id:item.id, name:typeof item.name === 'string' ? item.name.slice(0,200) : item.id })).slice(0,2000);
  }
  return { validateAccount, validateModel, listModels };
}
module.exports = { createConfigurationValidators };
