const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw] != null ? LEVELS[raw] : LEVELS.info;
}

function stamp() {
  const d = new Date();
  return d.toISOString();
}

function localStamp() {
  try {
    return new Date().toLocaleString("id-ID", { hour12: false });
  } catch (e) {
    return new Date().toString();
  }
}

function timeStamp() {
  try {
    return new Date().toLocaleTimeString("id-ID", { hour12: false });
  } catch (e) {
    return new Date().toISOString();
  }
}

function fmtValue(v, blockIndent) {
  // Multi-line strings (e.g. captions) rendered as an indented block
  if (typeof v === "string" && v.includes("\n")) {
    return "\n" + v.split("\n").map((l) => `${blockIndent}${l}`).join("\n");
  }
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function fmt(scope, level, msg, extra) {
  const head = `[${timeStamp()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra === undefined) return head;
  if (typeof extra === "string") return `${head} ${extra}`;
  try {
    const entries = Object.entries(extra).filter(
      (pair) => pair[1] !== undefined && pair[1] !== null
    );
    if (!entries.length) return head;
    const width = Math.max.apply(null, entries.map((pair) => pair[0].length));
    const lines = entries.map((pair) => {
      const pad = `  ${pair[0].padEnd(width)} : `;
      return `${pad}${fmtValue(pair[1], " ".repeat(pad.length))}`;
    });
    return [head].concat(lines).join("\n");
  } catch (e) {
    return `${head} ${String(extra)}`;
  }
}

function createLogger(scope = "app") {
  const log = (level, msg, extra) => {
    if (LEVELS[level] < currentLevel()) return;
    const line = fmt(scope, level, msg, extra);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  return {
    debug: (msg, extra) => log("debug", msg, extra),
    info: (msg, extra) => log("info", msg, extra),
    warn: (msg, extra) => log("warn", msg, extra),
    error: (msg, extra) => log("error", msg, extra),
    stamp,
    localStamp,
  };
}

function ms(msVal) {
  if (msVal < 1000) return `${msVal}ms`;
  const s = Math.round(msVal / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

module.exports = { createLogger, ms };
