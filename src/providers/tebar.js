const axios = require("axios");

const BASE_URL = "https://api.tebar.app/v1";
const POST_STATES = new Set(["draft", "scheduled", "publishing", "published", "partial", "failed", "canceled"]);
const TARGET_STATES = new Set(["pending", "publishing", "published", "failed", "canceled"]);
const ERROR_CODES = new Set(["account_expired", "account_not_found", "account_disconnected", "post_not_editable", "idempotency_conflict", "profile_not_found", "rate_limited", "permission_missing", "caption_too_long", "invalid_metric", "invalid_range"]);

function providerError(code, status = null, unknownOutcome = false) {
  return Object.assign(new Error(`Tebar request failed: ${code}`), {
    provider: "tebar", code, status, unknownOutcome,
    retryable: !unknownOutcome && (status === 429 || status >= 500),
  });
}

function normalizePost(data, mutation = false) {
  const providerPostId = typeof data?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.id) ? data.id : null;
  if (!providerPostId || typeof data.status !== "string"
    || (data.scheduled_at != null && typeof data.scheduled_at !== "string")
    || !Array.isArray(data.targets) || !data.targets.every((target) => target && !Array.isArray(target)
      && ["id", "account_id", "platform", "status"].every((key) => typeof target[key] === "string")
      && ["permalink", "error_code", "published_at"].every((key) => target[key] == null || typeof target[key] === "string"))) {
    const error = providerError("invalid_response", null, mutation);
    if (providerPostId) error.providerPostId = providerPostId;
    throw error;
  }
  return {
    id: data.id,
    status: POST_STATES.has(data.status) ? data.status : "unknown",
    scheduledAt: data.scheduled_at || null,
    targets: data.targets.map((target) => ({
      id: target.id,
      accountId: target.account_id,
      platform: target.platform,
      status: TARGET_STATES.has(target.status) ? target.status : "unknown",
      permalink: target.permalink || null,
      errorCode: target.error_code ? (ERROR_CODES.has(target.error_code) ? target.error_code : "provider_error") : null,
      publishedAt: target.published_at || null,
    })),
  };
}

function createTebarClient({ apiKey, profileId, http = axios }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw providerError("not_configured");
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (profileId) headers["Tebar-Profile"] = profileId;

  async function request(method, path, { data, params, idempotencyKey } = {}) {
    try {
      const response = await http.request({
        method, url: `${BASE_URL}${path}`, data, params,
        headers: { ...headers, ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
        timeout: 30000, maxRedirects: 0,
      });
      return response.data;
    } catch (error) {
      const status = Number.isInteger(error.response?.status) ? error.response.status : null;
      const rawCode = error.response?.data?.error?.code;
      const code = ERROR_CODES.has(rawCode) ? rawCode
        : status === 401 || status === 403 ? "unauthorized"
          : status === 429 ? "rate_limited" : status === 409 ? "conflict"
            : status ? "provider_error" : "network_error";
      throw providerError(code, status, method !== "GET" && (!status || status >= 500));
    }
  }

  async function listAccounts() {
    const result = await request("GET", "/accounts");
    if (!Array.isArray(result?.data)) throw providerError("invalid_response");
    return result.data.map((account) => ({
      id: account.id, profileId: account.profile_id, platform: account.platform,
      username: account.username || null, displayName: account.display_name || null,
      status: ["active", "expired", "revoked"].includes(account.status) ? account.status : "unknown",
      tokenExpiresAt: account.token_expires_at || null,
      planSuspended: account.plan_suspended === true,
    }));
  }

  async function publishNow(body, idempotencyKey) {
    if (!body || typeof body.content !== "string" || !Array.isArray(body.targets) || !body.targets.length
      || Object.hasOwn(body, "scheduled_at") || typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      throw providerError("invalid_request");
    }
    // The dispatcher persists this exact body and key before sending or replaying it.
    return normalizePost(await request("POST", "/posts", { data: body, idempotencyKey }), true);
  }

  async function getPost(id) {
    if (typeof id !== "string" || !id) throw providerError("invalid_request");
    return normalizePost(await request("GET", `/posts/${encodeURIComponent(id)}`));
  }

  async function listScheduledPosts({ accountId, cursor, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw providerError("invalid_request");
    const params = { status: "scheduled", limit };
    if (accountId) params.account_id = accountId;
    if (cursor) params.cursor = cursor;
    const result = await request("GET", "/posts", { params });
    if (!Array.isArray(result?.data)) throw providerError("invalid_response");
    return { data: result.data.map((post) => normalizePost(post)), nextCursor: result.next_cursor || null };
  }

  async function cancelPost(id) {
    if (typeof id !== "string" || !id) throw providerError("invalid_request");
    return normalizePost(await request("DELETE", `/posts/${encodeURIComponent(id)}`), true);
  }

  async function getInsights(accountId, { metrics, from, to, tz } = {}) {
    if (typeof accountId !== "string" || !accountId) throw providerError("invalid_request");
    const params = {};
    if (metrics) params.metrics = Array.isArray(metrics) ? metrics.join(",") : metrics;
    if (from) params.from = from;
    if (to) params.to = to;
    if (tz) params.tz = tz;
    return request("GET", `/accounts/${encodeURIComponent(accountId)}/insights`, { params });
  }

  return { listAccounts, publishNow, getPost, listScheduledPosts, cancelPost, getInsights };
}

module.exports = { createTebarClient };
