const mysql = require("mysql2/promise");

function createPool(config) {
  if (!config.db) throw new Error("Database configuration is required");
  const { host, port, user, password, database, connectionLimit = 5 } = config.db;
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 100) {
    throw new Error("Invalid database connection limit");
  }
  // Use execute(sql, values) for application data. Never interpolate user input.
  const pool = mysql.createPool({
    host, port, user, password, database, connectionLimit,
    waitForConnections: true,
    queueLimit: 20,
    maxIdle: connectionLimit,
    idleTimeout: 60000,
    connectTimeout: 10000,
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  // mysql2's timezone option controls client serialization, not server defaults.
  pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return pool;
}

async function endOptionalPoolBounded(pool, timeoutMs = 1000) {
  if (!pool || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return true;
  let timer;
  const close = Promise.resolve().then(() => pool.end()).then(() => true, () => true);
  const completed = await Promise.race([close, new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  clearTimeout(timer);
  if (completed) return true;

  // mysql2 3.24.6 Pool.end() calls _realEnd() on every connection and can wait
  // indefinitely for a stalled active query. Connection.destroy() aliases its
  // graceful close(), so signal a fatal connection error to settle command
  // callbacks, then destroy the underlying socket. Optional pools only use this.
  const connections = pool.pool?._allConnections;
  if (connections && Number.isInteger(connections.length)) {
    for (let i = connections.length - 1; i >= 0; i--) {
      const connection = connections.get(i);
      try {
        if (typeof connection?._handleFatalError === 'function') {
          connection._handleFatalError(Object.assign(new Error('OPTIONAL_POOL_SHUTDOWN'), { code: 'PROTOCOL_CONNECTION_LOST' }));
          connection.stream?.destroy();
        } else connection?.destroy?.();
      } catch { /* Continue releasing other optional connections. */ }
    }
  }
  return false;
}

module.exports = { createPool, endOptionalPoolBounded };
