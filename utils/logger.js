const fs = require("fs");
const path = require("path");
const { inspect } = require("util");

let electronApp = null;

try {
  electronApp = require("electron").app;
} catch {
  electronApp = null;
}

const streams = new Map();
let logDirCache = null;
let appReady = false;
const IPC_POLICY = { level: "error", console: false };
const EVERYWHERE_POLICY = { console: false };
const clearedDirectories = new Set();
const ENV_LOG_DIR = process.env.LOGGER_DIR || "";
const SUPPRESS_CLEAR = process.env.LOGGER_SUPPRESS_CLEAR === "1";

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
const RARITY_LOG_DEDUP_WINDOW_MS = parsePositiveInt(
  process.env.RARITY_LOG_DEDUP_WINDOW_MS,
  15000
);
const logDedupState = new Map();

function parsePositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function resolveLevel(level) {
  const normalized = String(level || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized)
    ? normalized
    : "debug";
}

const GLOBAL_DEFAULT_CONFIG = {
  level: resolveLevel(process.env.LOGGER_LEVEL || "debug"),
  console: process.env.LOGGER_CONSOLE === "true",
  maxFileSize: parsePositiveInt(process.env.LOGGER_MAX_SIZE, 5 * 1024 * 1024),
  maxFiles: parsePositiveInt(process.env.LOGGER_MAX_FILES, 3),
};

if (GLOBAL_DEFAULT_CONFIG.maxFiles < 1) {
  GLOBAL_DEFAULT_CONFIG.maxFiles = 1;
}

if (electronApp) {
  const markReady = () => {
    if (appReady) return;
    appReady = true;
    logDirCache = null;
    for (const entry of streams.values()) {
      closeStream(entry.stream);
    }
    streams.clear();
  };

  try {
    if (typeof electronApp.isReady === "function" && electronApp.isReady()) {
      markReady();
    } else if (typeof electronApp.once === "function") {
      electronApp.once("ready", markReady);
    }
  } catch {}
}

function normalizeConfig(partial = {}) {
  const merged = { ...GLOBAL_DEFAULT_CONFIG };
  if (Object.prototype.hasOwnProperty.call(partial, "level")) {
    merged.level = resolveLevel(partial.level);
  }
  if (Object.prototype.hasOwnProperty.call(partial, "console")) {
    merged.console = Boolean(partial.console);
  }
  if (Object.prototype.hasOwnProperty.call(partial, "maxFileSize")) {
    merged.maxFileSize = parsePositiveInt(
      partial.maxFileSize,
      GLOBAL_DEFAULT_CONFIG.maxFileSize
    );
  }
  if (Object.prototype.hasOwnProperty.call(partial, "maxFiles")) {
    merged.maxFiles = parsePositiveInt(
      partial.maxFiles,
      GLOBAL_DEFAULT_CONFIG.maxFiles
    );
  }
  if (merged.maxFiles < 1) merged.maxFiles = 1;
  return merged;
}

function enforceLoggerPolicies(entry) {
  if (!entry) return;
  if (entry.safeName === "ipc" && appReady) {
    entry.config = normalizeConfig({ ...entry.config, ...IPC_POLICY });
  }
  if (appReady) {
    entry.config = normalizeConfig({ ...entry.config, ...EVERYWHERE_POLICY });
  }
}

function isStreamWritable(stream) {
  if (!stream) return false;
  if (stream.destroyed) return false;
  if (stream.closed === true) return false;
  if (stream.writable === false) return false;
  return true;
}

function closeStream(stream) {
  if (!stream) return;
  try {
    stream.end();
  } catch {}
}

function clearExistingLogs(dir) {
  if (!dir || clearedDirectories.has(dir)) return;
  if (SUPPRESS_CLEAR) {
    clearedDirectories.add(dir);
    return;
  }
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (!/\.log(\.\d+)?$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        fs.writeFileSync(file, "", { flag: "w" });
      } catch (err) {
        try {
          fs.unlinkSync(file);
        } catch {
          console.error(`[logger] Failed clearing "${file}": ${err.message}`);
        }
      }
    }
  } catch {}
  clearedDirectories.add(dir);
}

function getLogDirectory() {
  const fallbackDir = path.join(process.cwd(), "logs");
  if (ENV_LOG_DIR) {
    try {
      fs.mkdirSync(ENV_LOG_DIR, { recursive: true });
      clearExistingLogs(ENV_LOG_DIR);
      logDirCache = ENV_LOG_DIR;
      return logDirCache;
    } catch {}
  }
  if (logDirCache && fs.existsSync(logDirCache)) {
    return logDirCache;
  }
  try {
    if (electronApp) {
      const dir = path.join(electronApp.getPath("userData"), "logs");
      fs.mkdirSync(dir, { recursive: true });
      clearExistingLogs(dir);
      logDirCache = dir;
      return dir;
    }
  } catch {}
  try {
    fs.mkdirSync(fallbackDir, { recursive: true });
  } catch {}
  clearExistingLogs(fallbackDir);
  logDirCache = fallbackDir;
  return logDirCache;
}

function openStream(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
    });
  } catch (err) {
    console.error(
      `[logger] Failed to open log file "${filePath}": ${err.message}`
    );
    return null;
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function rotateLogs(basePath, maxFiles) {
  if (!basePath) return;
  for (let index = maxFiles - 1; index >= 0; index -= 1) {
    const source = index === 0 ? basePath : `${basePath}.${index}`;
    const destination = `${basePath}.${index + 1}`;
    try {
      if (fs.existsSync(source)) {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        fs.renameSync(source, destination);
      }
    } catch (err) {
      console.error(
        `[logger] Failed to rotate "${source}" -> "${destination}": ${err.message}`
      );
    }
  }
}

function ensureStream(loggerName, config) {
  const safeName = String(loggerName || "app")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/gi, "_");
  const dir = getLogDirectory();
  const filePath = path.join(dir, `${safeName}.log`);
  let entry = streams.get(safeName);

  if (entry && entry.filePath !== filePath) {
    closeStream(entry.stream);
    entry = null;
    streams.delete(safeName);
  }

  if (!entry) {
    entry = {
      loggerName: loggerName || "app",
      safeName,
      filePath,
      stream: null,
      size: 0,
      config: normalizeConfig(config),
    };
    streams.set(safeName, entry);
  } else {
    entry.filePath = filePath;
    entry.config = normalizeConfig({ ...entry.config, ...config });
  }

  enforceLoggerPolicies(entry);

  if (!isStreamWritable(entry.stream)) {
    entry.stream = openStream(filePath);
    entry.size = entry.stream ? getFileSize(filePath) : 0;
  }

  return entry;
}

function enrichMeta(message, meta) {
  let result = meta === undefined ? undefined : meta;
  if (message instanceof Error) {
    const errorPayload = {
      errorName: message.name,
      errorMessage: message.message,
    };
    if (message.stack) {
      errorPayload.errorStack = message.stack;
    }
    result = result ? { ...errorPayload, ...result } : errorPayload;
  }
  return result;
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val instanceof Error) {
          return {
            name: val.name,
            message: val.message,
            stack: val.stack,
          };
        }
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      }
    );
  } catch {
    return inspect(value, { depth: 4, breakLength: 120 });
  }
}

function serializeMeta(meta) {
  if (meta === undefined || meta === null) return "";
  if (typeof meta === "string") return meta;
  if (meta instanceof Error) {
    return safeJsonStringify({
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    });
  }
  try {
    return safeJsonStringify(meta);
  } catch {
    return String(meta);
  }
}

const CONSOLE_METHOD = {
  debug: typeof console.debug === "function" ? "debug" : "log",
  info: typeof console.info === "function" ? "info" : "log",
  warn: "warn",
  error: "error",
};

function formatMessage(message) {
  if (message instanceof Error) {
    return message.stack || `${message.name}: ${message.message}`;
  }
  if (typeof message === "string") return message;
  try {
    return safeJsonStringify(message);
  } catch {
    return String(message);
  }
}

function rotateIfNeeded(entry, bytes) {
  const { config } = entry;
  if (!config.maxFileSize) return;
  if (entry.size + bytes <= config.maxFileSize) return;

  closeStream(entry.stream);
  entry.stream = null;

  try {
    rotateLogs(entry.filePath, config.maxFiles);
  } catch {}

  entry.stream = openStream(entry.filePath);
  entry.size = entry.stream ? getFileSize(entry.filePath) : 0;
}

function shouldSkipDuplicateLog(loggerName, level, text, metaText, nowMs) {
  if (loggerName !== "rarity" || RARITY_LOG_DEDUP_WINDOW_MS <= 0) return false;
  const dedupKey = `${level}|${text}|${metaText || ""}`;
  let state = logDedupState.get(loggerName);
  if (!state) {
    state = new Map();
    logDedupState.set(loggerName, state);
  }
  const lastSeen = state.get(dedupKey);
  if (
    typeof lastSeen === "number" &&
    nowMs - lastSeen < RARITY_LOG_DEDUP_WINDOW_MS
  ) {
    return true;
  }
  state.set(dedupKey, nowMs);
  if (state.size > 500) {
    for (const [key, ts] of state) {
      if (nowMs - ts > RARITY_LOG_DEDUP_WINDOW_MS) state.delete(key);
    }
  }
  return false;
}

function write(loggerName, level, message, meta, config, clock = new Date()) {
  const localTimestamp = new Intl.DateTimeFormat("default", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  })
    .format(clock)
    .replace(/\u200e/g, "");
  const text = formatMessage(message);
  const enrichedMeta = enrichMeta(message, meta);
  const metaText =
    enrichedMeta !== undefined ? ` ${serializeMeta(enrichedMeta)}` : "";
  if (
    shouldSkipDuplicateLog(
      loggerName,
      level,
      text,
      metaText,
      clock instanceof Date ? clock.getTime() : Date.now()
    )
  ) {
    return;
  }
  const line = `[${localTimestamp}] [${level.toUpperCase()}] ${text}${metaText}\n`;

  const entry = ensureStream(loggerName, config);
  const { stream, filePath } = entry;
  const bytes = Buffer.byteLength(line, "utf8");
  rotateIfNeeded(entry, bytes);

  const targetStream = entry.stream;
  if (targetStream) {
    try {
      targetStream.write(line);
      entry.size += bytes;
    } catch (err) {
      console.error(
        `[logger] Failed writing to "${filePath}": ${err.message}`
      );
    }
  }

  if (config.console || !targetStream) {
    const method = CONSOLE_METHOD[level] || "log";
    try {
      console[method](line.trim());
    } catch {
      try {
        console.log(line.trim());
      } catch {}
    }
  }
}

function createLogger(name, options) {
  const loggerName = name || "app";
  let config = normalizeConfig(options);
  const log = (level, message, meta) => {
    if (appReady) {
      config = normalizeConfig({
        ...config,
        ...EVERYWHERE_POLICY,
        ...(loggerName === "ipc" ? IPC_POLICY : {}),
      });
    }
    const levelRank = LEVELS[level] ?? LEVELS.info;
    const threshold = LEVELS[config.level] ?? LEVELS.debug;
    if (levelRank < threshold) return;
    write(loggerName, level, message, meta, config);
  };
  return {
    log,
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    filePath() {
      return ensureStream(loggerName, config).filePath;
    },
    setLevel(nextLevel) {
      config = normalizeConfig({ ...config, level: nextLevel });
    },
    configure(next = {}) {
      config = normalizeConfig({ ...config, ...next });
    },
  };
}

process.on("exit", () => {
  for (const entry of streams.values()) {
    const stream = entry?.stream;
    closeStream(stream);
  }
});

module.exports = { createLogger };
