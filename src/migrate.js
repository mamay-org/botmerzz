const { readdir, readFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const LOCK_NAME = "CONCAT('threads:migrations:', LEFT(SHA2(DATABASE(), 256), 32))";
const INDEX_018_ERROR = 'MIGRATION_018_INDEX_MISMATCH: slots_published_completed must be a visible non-unique BTREE on (status, completed_at, id), ascending and without prefixes; inspect and reconcile manually';

async function shouldCreateIndex018(connection, statement) {
  if (statement.replace(/\s+/g, ' ').trim().toLowerCase() !== 'create index slots_published_completed on slots (status, completed_at, id)') {
    throw new Error(INDEX_018_ERROR);
  }
  const [rows] = await connection.query(`SELECT COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE, INDEX_TYPE, COLLATION, SUB_PART, IS_VISIBLE, EXPRESSION
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='slots'
    AND INDEX_NAME='slots_published_completed' ORDER BY SEQ_IN_INDEX`);
  if (rows.length === 0) return true;
  const expected = ['status', 'completed_at', 'id'];
  const matches = rows.length === expected.length && rows.every((row, i) =>
    row.COLUMN_NAME === expected[i] && Number(row.SEQ_IN_INDEX) === i + 1 && Number(row.NON_UNIQUE) === 1 &&
    row.INDEX_TYPE === 'BTREE' && row.COLLATION === 'A' && row.SUB_PART === null &&
    row.IS_VISIBLE === 'YES' && row.EXPRESSION === null);
  if (!matches) throw new Error(INDEX_018_ERROR);
  return false;
}

async function runMigrations(pool, { migrationsDir = resolve(__dirname, "../migrations") } = {}) {
  let connection;
  let locked = false;
  try {
    connection = await pool.getConnection();
    const [[lock]] = await connection.query(`SELECT GET_LOCK(${LOCK_NAME}, 30) AS acquired`);
    if (Number(lock.acquired) !== 1) throw new Error("MIGRATION_LOCK_UNAVAILABLE");
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    const [rows] = await connection.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    const files = (await readdir(migrationsDir)).filter((file) => /^\d+_[a-zA-Z0-9_-]+\.sql$/.test(file)).sort();
    const completed = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(resolve(migrationsDir, file), "utf8");
      // Migrations contain plain semicolon-delimited SQL, without stored routines
      // or semicolons inside literals. MySQL DDL implicitly commits, so DDL must
      // be restartable; only record a migration after every statement succeeds.
      await connection.beginTransaction();
      try {
        for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
          if (file === '018_learning_quality_analytics_index.sql' && !(await shouldCreateIndex018(connection, statement))) continue;
          await connection.query(statement);
        }
        await connection.execute("INSERT INTO schema_migrations (version) VALUES (?)", [file]);
        await connection.commit();
        completed.push(file);
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      }
    }
    return completed;
  } catch (error) {
    const failure = new Error(error.message === "MIGRATION_LOCK_UNAVAILABLE" ? "MIGRATION_LOCK_UNAVAILABLE" : error.message === INDEX_018_ERROR ? INDEX_018_ERROR : "MIGRATION_FAILED");
    if (error.message === INDEX_018_ERROR) failure.code = 'MIGRATION_018_INDEX_MISMATCH';
    throw failure;
  } finally {
    if (connection) {
      let discard = false;
      if (locked) {
        try {
          const [[result]] = await connection.query(`SELECT RELEASE_LOCK(${LOCK_NAME}) AS released`);
          discard = Number(result.released) !== 1;
        } catch {
          discard = true;
        }
      }
      if (discard) connection.destroy();
      else connection.release();
    }
  }
}

if (require.main === module) {
  (async () => {
    let pool;
    try {
      const { loadEnv } = require("./config");
      const { createPool } = require("./db");
      pool = createPool(loadEnv());
      const applied = await runMigrations(pool);
      process.stdout.write(`Applied ${applied.length} migration(s).\n`);
    } catch (error) {
      process.stderr.write(error.message === INDEX_018_ERROR ? `${INDEX_018_ERROR}\n` : "Migration failed. Check database configuration and migration state.\n");
      process.exitCode = 1;
    } finally {
      if (pool) await pool.end();
    }
  })();
}

module.exports = { runMigrations };
