const test = require("node:test");
const assert = require("node:assert/strict");
const { loadEnv } = require("../src/config");

const database = { DB_HOST: "localhost", DB_USER: "test", DB_PASSWORD: "test-only", DB_NAME: "threads_test" };

test("database-backed runtime starts paused without provider credentials", () => {
  const config = loadEnv(database);
  assert.equal(config.automationEnabled, false);
  assert.equal(config.timezone, "Asia/Kuala_Lumpur");
  assert.equal(config.intervalHours, 6);
  assert.equal(config.schedulerEnabled, false);
  assert.equal(config.schedulerIntervalSeconds, 60);
  assert.equal(config.trustProxy, false);
  assert.equal(config.tebar.apiKey, undefined);
  assert.equal(config.openRouter.apiKey, undefined);
  assert.equal(config.telegram.botToken, undefined);
  assert.equal(config.db.database, "threads_test");
});

test("missing database settings are reported without leaking supplied values", () => {
  assert.throws(() => loadEnv({ DB_HOST: "private-host-value" }), (error) => {
    assert.match(error.message, /DB_USER/);
    assert.match(error.message, /DB_PASSWORD/);
    assert.match(error.message, /DB_NAME/);
    assert.doesNotMatch(error.message, /private-host-value/);
    return true;
  });
});

test("pure tools can explicitly opt out of database requirements", () => {
  const config = loadEnv({}, { requireDatabase: false });
  assert.equal(config.db, null);
  assert.equal(config.automationEnabled, false);
});

test("invalid timezone and interval fail without echoing input", () => {
  for (const value of ["5", "6hours", "6.5", "NaN", "0", "-6", ""]) {
    assert.throws(() => loadEnv({ ...database, POST_INTERVAL_HOURS: value }), /POST_INTERVAL_HOURS/);
  }
  assert.throws(() => loadEnv({ ...database, TIMEZONE: "secret-timezone" }), (error) => {
    assert.match(error.message, /TIMEZONE/);
    assert.doesNotMatch(error.message, /secret-timezone/);
    return true;
  });
});

test("production requires an explicit HTTPS origin", () => {
  for (const baseUrl of [undefined, "http://example.com", "https://user:secret@example.com", "https://example.com/path"]) {
    assert.throws(() => loadEnv({ ...database, NODE_ENV: "production", BASE_URL: baseUrl }), /BASE_URL/);
  }
  assert.equal(loadEnv({ ...database, NODE_ENV: "production", BASE_URL: "https://example.com" }).baseUrl, "https://example.com");
});

test("environment cannot enable automation at startup", () => {
  assert.equal(loadEnv({ ...database, AUTOMATION_ENABLED: "true" }).automationEnabled, false);
});

test("scheduler requires an explicit boolean and enforces a bounded polling interval", () => {
  assert.equal(loadEnv({ ...database, SCHEDULER_ENABLED: "true" }).schedulerEnabled, true);
  assert.equal(loadEnv({ ...database, SCHEDULER_ENABLED: "false", SCHEDULER_INTERVAL_SECONDS: "30" }).schedulerIntervalSeconds, 30);
  for (const extra of [{ SCHEDULER_ENABLED: "yes" }, { SCHEDULER_INTERVAL_SECONDS: "14" }, { SCHEDULER_INTERVAL_SECONDS: "3601" }]) {
    assert.throws(() => loadEnv({ ...database, ...extra }), /Invalid configuration/);
  }
});

test("proxy trust is explicit and boolean", () => {
  assert.equal(loadEnv({ ...database, TRUST_PROXY: "true" }).trustProxy, true);
  assert.throws(() => loadEnv({ ...database, TRUST_PROXY: "yes" }), /TRUST_PROXY/);
});

test("ports and connection pool limits must be bounded integers", () => {
  for (const extra of [{ PORT: "abc" }, { DB_PORT: "65536" }, { DB_POOL_SIZE: "0" }, { DB_POOL_SIZE: "101" }]) {
    assert.throws(() => loadEnv({ ...database, ...extra }), /Invalid configuration/);
  }
});

test("Node versions older than 20.6 are refused", () => {
  for (const nodeVersion of ["18.20.0", "20.5.9"]) {
    assert.throws(() => loadEnv(database, { nodeVersion }), /20\.6/);
  }
  assert.equal(loadEnv(database, { nodeVersion: "20.6.0" }).intervalHours, 6);
});
