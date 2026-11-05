const axios = require("axios");

function providerError(code, status = null, retryAfter = null) {
  return Object.assign(new Error(`Telegram request failed: ${code}`), {
    provider: "telegram", code, status,
    unknownOutcome: code === "network_error" || status >= 500,
    retryable: status === 429,
    retryAfter: Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : null,
  });
}

function createTelegramClient({ botToken, chatId, http = axios }) {
  if (typeof botToken !== "string" || !botToken.trim() || !chatId) throw providerError("not_configured");

  async function send(text) {
    if (typeof text !== "string" || !text.trim()) throw providerError("invalid_request");
    const safeText = text.split(botToken).join("[REDACTED]")
      .replace(/\b(?:mysql|mariadb|postgres(?:ql)?|mongodb(?:\+srv)?|redis|rediss|sqlserver):\/\/[^\s"'<>]+/gi, "[REDACTED]")
      .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/?#"'<>]*@/gi, "$1[REDACTED]@")
      .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, "$1 [REDACTED]")
      .replace(/\b(?:tb_live_|sk-or-|sk-)[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]+/g, "[REDACTED]")
      .replace(/\b(password|pwd|user\s+id|token|secret|api[_-]?key|connection[_-]?string|(?:database|db)[_-]?url|dsn)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
      .trim().slice(0, 4096);
    let response;
    try {
      response = await http.request({
        method: "POST", url: `https://api.telegram.org/bot${botToken}/sendMessage`,
        headers: { "Content-Type": "application/json" },
        data: { chat_id: chatId, text: safeText },
        timeout: 15000, maxRedirects: 0,
      });
    } catch (error) {
      const status = Number.isInteger(error.response?.status) ? error.response.status : null;
      throw providerError(status === 429 ? "rate_limited"
        : status === 401 || status === 403 ? "unauthorized"
          : status ? "provider_error" : "network_error", status, error.response?.data?.parameters?.retry_after);
    }
    if (response.data?.ok !== true) {
      const status = Number.isInteger(response.data?.error_code) ? response.data.error_code : null;
      throw providerError(status === 429 ? "rate_limited" : "provider_error", status, response.data?.parameters?.retry_after);
    }
    if (!Number.isInteger(response.data.result?.message_id)) throw providerError("invalid_response");
    return { messageId: response.data.result.message_id };
  }

  return { send };
}

module.exports = { createTelegramClient };
