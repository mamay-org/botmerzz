const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function fakePool({ locked = true, failStatement, unlockFails = false } = {}) {
  const applied = new Set();
  const statements = [];
  const events = [];
  const connection = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("GET_LOCK")) return [[{ acquired: locked ? 1 : 0 }]];
      if (sql.includes("RELEASE_LOCK")) {
        events.push("unlock");
        if (unlockFails) throw new Error("connection failed");
        return [[{ released: 1 }]];
      }
      if (sql.startsWith("SELECT version")) return [[...applied].map((version) => ({ version }))];
      if (sql.includes('information_schema.STATISTICS')) return [[]];
      if (failStatement && sql.includes(failStatement)) throw new Error("database secret-value");
      return [{ affectedRows: 1 }];
    },
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith("INSERT INTO schema_migrations")) applied.add(params[0]);
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() { events.push("begin"); },
    async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); },
    release() { events.push("release"); },
    destroy() { events.push("destroy"); },
  };
  return { async getConnection() { return connection; }, applied, statements, events };
}

test("migrations run in order only once and track versions with bound parameters", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "threads-migrations-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "002_second.sql"), "CREATE TABLE IF NOT EXISTS second (id INT);");
  await fs.writeFile(path.join(dir, "001_first.sql"), "CREATE TABLE IF NOT EXISTS first (id INT);");
  const { runMigrations } = require("../src/migrate");
  const pool = fakePool();
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), ["001_first.sql", "002_second.sql"]);
  assert.deepEqual(await runMigrations(pool, { migrationsDir: dir }), []);
  assert.deepEqual([...pool.applied], ["001_first.sql", "002_second.sql"]);
  assert.equal(pool.statements.filter(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS first")).length, 1);
  assert.equal(pool.events.filter((event) => event === "unlock").length, 2);
  assert.equal(pool.events.filter((event) => event === "release").length, 2);
});

test("failed migration stays unapplied, rolls back, releases the lock and redacts errors", async () => {
  const pool = fakePool({ failStatement: "CREATE TABLE IF NOT EXISTS admins" });
  const { runMigrations } = require("../src/migrate");
  await assert.rejects(runMigrations(pool), (error) => {
    assert.match(error.message, /MIGRATION_FAILED/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
  assert.equal(pool.applied.size, 0);
  assert.deepEqual(pool.events, ["begin", "rollback", "unlock", "release"]);
});

test("failure to obtain the migration lock does not execute schema changes", async () => {
  const pool = fakePool({ locked: false });
  const { runMigrations } = require("../src/migrate");
  await assert.rejects(runMigrations(pool), /MIGRATION_LOCK_UNAVAILABLE/);
  assert.equal(pool.statements.some(({ sql }) => sql.includes("CREATE TABLE")), false);
  assert.deepEqual(pool.events, ["release"]);
});

test("pool is bounded, uses UTC, and disallows multiple SQL statements", async () => {
  const { createPool } = require("../src/db");
  const pool = createPool({ db: { host: "localhost", user: "test", password: "test-only", database: "test", port: 3306, connectionLimit: 4 } });
  try {
    assert.equal(pool.pool.config.connectionLimit, 4);
    assert.equal(pool.pool.config.queueLimit, 20);
    assert.equal(pool.pool.config.connectionConfig.timezone, "Z");
    assert.equal(pool.pool.config.connectionConfig.multipleStatements, false);
  } finally {
    await pool.end();
  }
});

test("new database sessions set server timestamps to UTC before application queries", async () => {
  const { createPool } = require("../src/db");
  const pool = createPool({ db: { host: "localhost", user: "test", password: "test-only", database: "test" } });
  const statements = [];
  try {
    pool.pool.emit("connection", {
      query(sql, callback) { statements.push(sql); callback(null); },
    });
    assert.deepEqual(statements, ["SET time_zone = '+00:00'"]);
  } finally {
    await pool.end();
  }
});

test("template migration stores shared structured templates with admin audit references", async () => {
  const sql = await fs.readFile(require.resolve('../migrations/004_templates.sql'),'utf8');
  assert.match(sql,/CREATE TABLE IF NOT EXISTS templates/);
  assert.match(sql,/data_json JSON NOT NULL/);
  assert.match(sql,/category IN \('brand','topup','account'\)/);
  assert.match(sql,/FOREIGN KEY \(created_by\) REFERENCES admins\(id\)/);
});

test("failed lock cleanup discards the connection instead of returning a held lock to the pool", async () => {
  const pool = fakePool({ unlockFails: true });
  await require("../src/migrate").runMigrations(pool);
  assert.equal(pool.events.at(-1), "destroy");
  assert.equal(pool.events.includes("release"), false);
});
