"use strict";

const fs = require("fs");
const path = require("path");

const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");

const STORE_VERSION = 2;
const DEFAULT_SAVE_DELAY_MS = 500;

function normalizeAchievementCacheMetaPath(inputPath) {
  if (!inputPath) return "";
  let normalized = "";
  try {
    normalized = fs.realpathSync(String(inputPath));
  } catch {
    try {
      normalized = path.resolve(String(inputPath));
    } catch {
      normalized = String(inputPath);
    }
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildAchievementCacheMetaKey({
  configName = "",
  platform = "steam",
  filePath = "",
  appid = "",
} = {}) {
  const normalizedPath = normalizeAchievementCacheMetaPath(filePath);
  const safeName = sanitizeConfigName(configName || "") || String(appid || "");
  const normalizedPlatform = String(platform || "steam").trim().toLowerCase();
  if (!safeName || !normalizedPath) return "";
  return `${safeName}::${normalizedPlatform || "steam"}::${normalizedPath}`;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const mtimeMs = Number(entry.mtimeMs ?? entry.mtime ?? 0);
  const size = Number(entry.size ?? 0);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null;
  const normalized = { mtimeMs, size };
  const parserRevision = String(entry.parserRevision || "").trim();
  if (parserRevision) normalized.parserRevision = parserRevision;
  return normalized;
}

function createAchievementCacheMetaStore(options = {}) {
  const filePath = String(options.filePath || "").trim();
  const saveDelayMs = Math.max(
    0,
    Number(options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS) || 0,
  );
  const entries = new Map();
  let loaded = false;
  let dirty = false;
  let saveTimer = null;

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const files =
        raw && typeof raw === "object" && raw.files ? raw.files : raw;
      if (!files || typeof files !== "object" || Array.isArray(files)) return;
      for (const [key, value] of Object.entries(files)) {
        const normalized = normalizeEntry(value);
        if (normalized) entries.set(key, normalized);
      }
    } catch {}
  }

  function flushSync() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty || !filePath) return false;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeJsonAtomicSync(filePath, {
        version: STORE_VERSION,
        files: Object.fromEntries(entries),
      });
      return true;
    } catch {
      dirty = true;
      return false;
    }
  }

  function scheduleSave() {
    if (!filePath) return;
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushSync();
    }, saveDelayMs);
  }

  function get(key) {
    loadOnce();
    return entries.get(String(key || "")) || null;
  }

  function set(key, entry) {
    const normalizedKey = String(key || "");
    const normalizedEntry = normalizeEntry(entry);
    if (!normalizedKey || !normalizedEntry) return false;
    loadOnce();
    const previous = entries.get(normalizedKey);
    if (
      previous &&
      previous.mtimeMs === normalizedEntry.mtimeMs &&
      previous.size === normalizedEntry.size &&
      String(previous.parserRevision || "") ===
        String(normalizedEntry.parserRevision || "")
    ) {
      return false;
    }
    entries.set(normalizedKey, normalizedEntry);
    scheduleSave();
    return true;
  }

  function updateFromStat(key, stat, parserRevision = "") {
    if (!stat) return false;
    return set(key, {
      mtimeMs: Number(stat.mtimeMs ?? 0),
      size: Number(stat.size ?? 0),
      parserRevision,
    });
  }

  function updateFileSync(key, sourcePath, parserRevision = "") {
    try {
      return updateFromStat(key, fs.statSync(sourcePath), parserRevision);
    } catch {
      return false;
    }
  }

  function matchesStat(key, stat, parserRevision = "") {
    if (!stat) return false;
    const entry = get(key);
    if (!entry) return false;
    return (
      Number(stat.mtimeMs) === Number(entry.mtimeMs) &&
      Number(stat.size) === Number(entry.size) &&
      String(parserRevision || "") === String(entry.parserRevision || "")
    );
  }

  function matchesFileSync(key, sourcePath, parserRevision = "") {
    try {
      return matchesStat(key, fs.statSync(sourcePath), parserRevision);
    } catch {
      return false;
    }
  }

  async function matchesFile(key, sourcePath, parserRevision = "") {
    try {
      return matchesStat(
        key,
        await fs.promises.stat(sourcePath),
        parserRevision,
      );
    } catch {
      return false;
    }
  }

  function close() {
    flushSync();
  }

  return {
    filePath,
    loadOnce,
    get,
    set,
    updateFromStat,
    updateFileSync,
    matchesStat,
    matchesFileSync,
    matchesFile,
    flushSync,
    close,
  };
}

module.exports = {
  STORE_VERSION,
  buildAchievementCacheMetaKey,
  createAchievementCacheMetaStore,
  normalizeAchievementCacheMetaPath,
};
