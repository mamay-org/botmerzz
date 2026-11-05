const test = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const { createOpenRouterClient } = require("../src/providers/openrouter");

test("generation sends the configured model and prompts and returns only assistant content", async () => {
  const api = createOpenRouterClient({ apiKey: "sk-or-secret", model: "test/model", http: { request: async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(request.headers.Authorization, "Bearer sk-or-secret");
    assert.deepEqual(request.data, { model: "test/model", messages: [{ role: "system", content: "Bahasa Melayu" }, { role: "user", content: "Tulis kapsyen" }], max_completion_tokens: 120, stream: false });
    assert.equal(request.maxRedirects, 0);
    assert.ok(request.timeout > 0);
    return { data: { choices: [{ message: { content: "  Jom main!  ", reasoning: "private" } }] } };
  } } });
  assert.equal(await api.generate({ system: "Bahasa Melayu", user: "Tulis kapsyen", maxTokens: 120 }), "Jom main!");
});

test("empty or non-text AI responses fail safely instead of creating a fallback", async () => {
  for (const content of [null, "   ", [], { text: "wrong" }]) {
    const api = createOpenRouterClient({ apiKey: "key", model: "model", http: { request: async () => ({ data: { choices: [{ message: { content } }] } }) } });
    await assert.rejects(api.generate({ system: "system", user: "user" }), { code: "invalid_response" });
  }
});

test("OpenRouter transport failures discard request secrets and response bodies", async () => {
  let calls = 0;
  const api = createOpenRouterClient({ apiKey: "sk-or-secret", model: "model", http: { request: async () => {
    calls++;
    throw Object.assign(new Error("sk-or-secret"), { response: { status: 429, data: "private response" }, config: { headers: { Authorization: "secret" } } });
  } } });
  await assert.rejects(api.generate({ system: "system", user: "user" }), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, true);
    assert.doesNotMatch(inspect(error), /sk-or-secret|private response|Authorization/);
    return true;
  });
  assert.equal(calls, 1);
});
