const test = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const { createTebarClient } = require("../src/providers/tebar");

const post = (status) => ({ id: "post-1", status, scheduled_at: null, targets: [] });
function client(request) {
  return createTebarClient({ apiKey: "tb_live_secret", profileId: "staging", http: { request } });
}

test("publish preserves the persisted body and idempotency key on replay", async () => {
  const requests = [];
  const api = client(async (request) => { requests.push(request); return { data: post("publishing") }; });
  const body = Object.freeze({ content: "Jom bermain!", targets: [{ account_id: "account-1" }] });
  assert.equal((await api.publishNow(body, "slot-key-1")).status, "publishing");
  await api.publishNow(body, "slot-key-1");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.tebar.app/v1/posts");
    assert.deepEqual(request.data, { content: "Jom bermain!", targets: [{ account_id: "account-1" }] });
    assert.equal(request.headers.Authorization, "Bearer tb_live_secret");
    assert.equal(request.headers["Tebar-Profile"], "staging");
    assert.equal(request.headers["Idempotency-Key"], "slot-key-1");
    assert.ok(request.timeout > 0);
    assert.equal(request.maxRedirects, 0);
  }
});

test("publish refuses a missing idempotency key or scheduled body before HTTP", async () => {
  const api = client(() => assert.fail("must not publish"));
  await assert.rejects(api.publishNow({ content: "Hi", targets: [] }), { code: "invalid_request" });
  await assert.rejects(api.publishNow({ scheduled_at: "2026-11-06T00:00:00Z" }, "key"), { code: "invalid_request" });
});

test("all documented post states survive normalization; unrecognized states stay unknown", async () => {
  for (const status of ["draft", "scheduled", "publishing", "published", "partial", "failed", "canceled", "future-state"]) {
    const api = client(async (request) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "https://api.tebar.app/v1/posts/post%2F1");
      return { data: { ...post(status), targets: [{ id: "target-1", account_id: "a1", platform: "threads", status: "failed", error_code: "account_expired", error_message: "Bearer tb_live_secret", raw: "secret" }] } };
    });
    const result = await api.getPost("post/1");
    assert.equal(result.status, status === "future-state" ? "unknown" : status);
    assert.equal(result.targets[0].accountId, "a1");
    assert.equal(result.targets[0].errorCode, "account_expired");
    assert.doesNotMatch(JSON.stringify(result), /secret|error_message|raw/);
  }
});

test("accounts expose connection status without upstream credential or error fields", async () => {
  const api = client(async (request) => {
    assert.equal(request.url, "https://api.tebar.app/v1/accounts");
    return { data: { data: [{ id: "a1", platform: "threads", username: "kedai", status: "expired", token_expires_at: "2026-11-01T00:00:00Z", plan_suspended: false, access_token: "secret", expired_reason: "secret" }] } };
  });
  const accounts = await api.listAccounts();
  assert.equal(accounts[0].status, "expired");
  assert.equal(accounts[0].tokenExpiresAt, "2026-11-01T00:00:00Z");
  assert.doesNotMatch(JSON.stringify(accounts), /secret/);
});

test("scheduled listing forwards documented filters and preserves pagination", async () => {
  const api = client(async (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://api.tebar.app/v1/posts");
    assert.deepEqual(request.params, { status: "scheduled", account_id: "a1", limit: 100, cursor: "page-2" });
    return { data: { data: [post("scheduled")], next_cursor: "page-3" } };
  });
  const page = await api.listScheduledPosts({ accountId: "a1", cursor: "page-2" });
  assert.equal(page.data[0].status, "scheduled");
  assert.equal(page.nextCursor, "page-3");
  await assert.rejects(api.listScheduledPosts({ limit: 101 }), { code: "invalid_request" });
});

test("cancellation uses DELETE and never converts publishing or conflicts into canceled", async () => {
  for (const status of ["canceled", "publishing", "published"]) {
    const api = client(async (request) => {
      assert.equal(request.method, "DELETE");
      assert.equal(request.url, "https://api.tebar.app/v1/posts/post-1");
      return { data: post(status) };
    });
    assert.equal((await api.cancelPost("post-1")).status, status);
  }
  const api = client(async () => { throw { response: { status: 409, data: { error: { code: "post_not_editable", message: "secret" } } } }; });
  await assert.rejects(api.cancelPost("post-1"), { code: "post_not_editable", status: 409 });
});

test("network and server failures leave publish outcome unknown without retry or leaked errors", async () => {
  for (const status of [undefined, 503, 401, 429]) {
    let calls = 0;
    const api = client(async () => { calls++; throw Object.assign(new Error("Bearer tb_live_secret"), { config: { headers: { Authorization: "tb_live_secret" } }, response: status ? { status, data: { error: { code: "tb_live_secret", message: "raw-secret" } } } : undefined }); });
    await assert.rejects(api.publishNow({ content: "Hi", targets: [{ account_id: "a1" }] }, "key"), (error) => {
      assert.equal(error.unknownOutcome, !status || status >= 500);
      assert.doesNotMatch(inspect(error), /tb_live_secret|raw-secret|Authorization/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("insights sends only documented query keys and preserves missing data", async () => {
  const api = client(async (request) => {
    assert.equal(request.url, "https://api.tebar.app/v1/accounts/a1/insights");
    assert.deepEqual(request.params, { metrics: "clicks,views", from: "2026-11-01", to: "2026-11-05", tz: "Asia/Kuala_Lumpur" });
    return { data: { metrics: { clicks: null }, missing_permission: true } };
  });
  assert.deepEqual(await api.getInsights("a1", { metrics: ["clicks", "views"], from: "2026-11-01", to: "2026-11-05", tz: "Asia/Kuala_Lumpur", apiKey: "ignored" }), { metrics: { clicks: null }, missing_permission: true });
});

test("malformed successful mutations remain unknown and retain a safe post ID for reconciliation", async () => {
  for (const method of ["POST", "DELETE"]) {
    for (const targets of [[null], "invalid", [{ id: "t1", account_id: { secret: "raw-secret" }, platform: "threads", status: "published" }]]) {
      let calls = 0;
      const api = client(async (request) => {
        calls++;
        assert.equal(request.method, method);
        return { data: { id: "post-1", status: "publishing", targets, error_message: "raw-secret" } };
      });
      const operation = method === "POST"
        ? api.publishNow({ content: "Hi", targets: [{ account_id: "a1" }] }, "key")
        : api.cancelPost("post-1");
      await assert.rejects(operation, (error) => {
        assert.equal(error.code, "invalid_response");
        assert.equal(error.unknownOutcome, true);
        assert.equal(error.retryable, false);
        assert.equal(error.providerPostId, "post-1");
        assert.doesNotMatch(inspect(error), /raw-secret|TypeError/);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("malformed status reads report safe invalid responses without claiming a mutation happened", async () => {
  const api = client(async () => ({ data: { id: "post-1", status: "published", targets: [null] } }));
  await assert.rejects(api.getPost("post-1"), { code: "invalid_response", unknownOutcome: false });
});
