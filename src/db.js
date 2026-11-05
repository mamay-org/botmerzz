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

module.exports = { createPool };
