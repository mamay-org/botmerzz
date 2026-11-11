const axios = require("axios");

function providerError(code, status = null) {
  return Object.assign(new Error(`OpenRouter request failed: ${code}`), {
    provider: "openrouter", code, status, unknownOutcome: false,
    retryable: status === null || status === 429 || status >= 500,
  });
}

function createOpenRouterClient({ apiKey, model, http = axios }) {
  if (typeof apiKey !== "string" || !apiKey.trim() || typeof model !== "string" || !model.trim()) {
    throw providerError("not_configured");
  }

  async function generate({ system, user, maxTokens = 400, temperature, topP, signal }) {
    if (typeof system !== "string" || typeof user !== "string" || !user.trim()
      || !Number.isInteger(maxTokens) || maxTokens < 1
      || (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2))
      || (topP !== undefined && (typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0 || topP > 1))
      || (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'))) throw providerError("invalid_request");
    let response;
    try {
      response = await http.request({
        method: "POST", url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        data: {
          model, messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_completion_tokens: maxTokens, stream: false,
          ...(temperature === undefined ? {} : { temperature }),
          ...(topP === undefined ? {} : { top_p: topP }),
        },
        ...(signal ? { signal } : {}),
        // Up to two generations and two reviews must fit the shutdown grace period.
        timeout: 40000, maxRedirects: 0,
      });
    } catch (error) {
      const status = Number.isInteger(error.response?.status) ? error.response.status : null;
      throw providerError(status === 429 ? "rate_limited"
        : status === 401 || status === 403 ? "unauthorized"
          : status ? "provider_error" : "network_error", status);
    }
    const choice = response.data?.choices?.[0];
    if (choice?.finish_reason === "length") throw providerError("invalid_response");
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw providerError("invalid_response");
    return content.trim();
  }

  return { generate };
}

module.exports = { createOpenRouterClient };
