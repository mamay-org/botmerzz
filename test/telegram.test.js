const test = require("node:test");
const assert = require("node:assert/strict");
const { inspect } = require("node:util");
const { createTelegramClient } = require("../src/providers/telegram");
const token = "123456:fake-telegram-token";

test("Telegram sends plain bounded text to the configured group with secrets redacted", async () => {
  const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.equal(request.data.chat_id, "-100123");
    assert.equal(request.data.parse_mode, undefined);
    assert.doesNotMatch(request.data.text, /fake-telegram-token|tb_live_private|sk-or-private|password123|abc-secret/);
    assert.match(request.data.text, /\[REDACTED\]/);
    assert.ok(request.data.text.length <= 4096);
    assert.equal(request.maxRedirects, 0);
    return { data: { ok: true, result: { message_id: 7, text: request.data.text, chat: { id: -100123 } } } };
  } } });
  assert.deepEqual(await api.send(`Error ${token} Bearer abc-secret tb_live_private sk-or-private password=password123 ${"x".repeat(5000)}`), { messageId: 7 });
});

test("Telegram API rejection and network uncertainty never expose token URL or body", async () => {
  for (const network of [false, true]) {
    let calls = 0;
    const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: async () => {
      calls++;
      if (network) throw Object.assign(new Error(`https://api.telegram.org/bot${token}/sendMessage`), { config: { url: token }, response: undefined });
      return { data: { ok: false, error_code: 429, description: token, parameters: { retry_after: 30 } } };
    } } });
    await assert.rejects(api.send("Failure"), (error) => {
      assert.equal(error.code, network ? "network_error" : "rate_limited");
      assert.equal(error.unknownOutcome, network);
      if (!network) assert.equal(error.retryAfter, 30);
      assert.doesNotMatch(inspect(error), /fake-telegram-token|api.telegram.org/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("empty notifications do not send an invalid Telegram request", async () => {
  const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: () => assert.fail("must not send") } });
  await assert.rejects(api.send("  "), { code: "invalid_request" });
});

test("quoted credential fields and Basic authorization are removed from notifications", async () => {
  const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: async (request) => {
    assert.doesNotMatch(request.data.text, /secret-value|encoded-credential|private-value/);
    return { data: { ok: true, result: { message_id: 8 } } };
  } } });
  await api.send('{"password":"secret-value", "api_key": "private-value", "Authorization": "Basic encoded-credential"}');
});

test("database URLs, connection strings, and URL userinfo are removed before sending", async () => {
  let sent;
  const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: async (request) => {
    sent = request.data.text;
    return { data: { ok: true, result: { message_id: 9 } } };
  } } });
  await api.send('Failure mysql://dbuser:mysqlpass@db.example/db postgres://pguser:pgpass@db.example/db postgresql://pguser2:pgpass2@db.example/db https://webuser:webpass@example.com/path connection_string="Server=db;User Id=sqluser;Pwd=sqlpass" DATABASE_URL="mysql://other:otherpass@host/db"');
  assert.doesNotMatch(sent, /dbuser|mysqlpass|pguser|pgpass|webuser|webpass|sqluser|sqlpass|otherpass/);
  assert.match(sent, /Failure/);
  assert.match(sent, /\[REDACTED\]/);
});

test("raw Error objects are rejected rather than stringified into Telegram messages", async () => {
  const api = createTelegramClient({ botToken: token, chatId: "-100123", http: { request: () => assert.fail("must not send") } });
  await assert.rejects(api.send(new Error("arbitrary private response")), { code: "invalid_request" });
});
