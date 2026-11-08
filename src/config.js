function loadEnv(env = process.env, { requireDatabase = true, nodeVersion = process.versions.node } = {}) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (!Number.isInteger(major) || major < 20 || (major === 20 && minor < 6)) {
    throw new Error("Node.js 20.6 or newer is required");
  }

  const errors = [];
  const integer = (key, fallback, min, max) => {
    const value = env[key] === undefined ? String(fallback) : env[key];
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      errors.push(key);
      return fallback;
    }
    return Number(value);
  };
  const optionalNumber = (key, max) => {
    const value = env[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > max) {
      errors.push(key);
      return undefined;
    }
    return Number(value);
  };
  const temperature = optionalNumber('OPENROUTER_GENERATOR_TEMPERATURE', 2);
  const topP = optionalNumber('OPENROUTER_GENERATOR_TOP_P', 1);
  const nodeEnv = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(nodeEnv)) errors.push("NODE_ENV");
  const port = integer("PORT", 3000, 1, 65535);
  if (env.TRUST_PROXY !== undefined && !["true", "false"].includes(env.TRUST_PROXY)) errors.push("TRUST_PROXY");
  const trustProxy = env.TRUST_PROXY === "true";
  if (env.SCHEDULER_ENABLED !== undefined && !["true", "false"].includes(env.SCHEDULER_ENABLED)) errors.push("SCHEDULER_ENABLED");
  const schedulerEnabled = env.SCHEDULER_ENABLED === "true";
  const schedulerIntervalSeconds = integer("SCHEDULER_INTERVAL_SECONDS", 60, 15, 3600);
  const timezone = env.TIMEZONE ?? "Asia/Kuala_Lumpur";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    errors.push("TIMEZONE");
  }
  const baseUrl = env.BASE_URL || (nodeEnv === "production" ? "" : `http://localhost:${port}`);
  try {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (nodeEnv === "production" && url.protocol !== "https:")) errors.push("BASE_URL");
  } catch {
    errors.push("BASE_URL");
  }

  let db = null;
  if (requireDatabase || ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"].some((key) => env[key])) {
    for (const key of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
      if (typeof env[key] !== "string" || !env[key].trim()) errors.push(key);
    }
    db = {
      host: env.DB_HOST,
      port: integer("DB_PORT", 3306, 1, 65535),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      connectionLimit: integer("DB_POOL_SIZE", 5, 1, 100),
    };
  }
  if (errors.length) throw new Error(`Invalid configuration: ${[...new Set(errors)].join(", ")}`);
  return {
    nodeEnv, port, baseUrl: new URL(baseUrl).origin, timezone,
    schedulerEnabled, schedulerIntervalSeconds, trustProxy,
    automationEnabled: false,
    db,
    tebar: {
      apiKey: env.TEBAR_API_KEY || undefined,
      profileId: env.TEBAR_PROFILE_ID || undefined,
      accountId: env.TEBAR_ACCOUNT_ID || undefined,
      webhookSecret: env.TEBAR_WEBHOOK_SECRET || undefined,
    },
    openRouter: {
      apiKey: env.OPENROUTER_API_KEY || undefined,
      model: env.OPENROUTER_MODEL || "google/gemini-3.8-flash",
      generatorSampling: { ...(temperature === undefined ? {} : { temperature }), ...(topP === undefined ? {} : { topP }) },
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || undefined,
      chatId: env.TELEGRAM_CHAT_ID || undefined,
    },
  };
}

module.exports = { loadEnv };
