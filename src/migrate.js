const { readdir, readFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const LOCK_NAME = "CONCAT('threads:migrations:', LEFT(SHA2(DATABASE(), 256), 32))";

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
    throw new Error(error.message === "MIGRATION_LOCK_UNAVAILABLE" ? "MIGRATION_LOCK_UNAVAILABLE" : "MIGRATION_FAILED");
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
    } catch {
      process.stderr.write("Migration failed. Check database configuration and migration state.\n");
      process.exitCode = 1;
    } finally {
      if (pool) await pool.end();
    }
  })();
}

module.exports = { runMigrations };
