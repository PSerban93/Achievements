const fs = require("fs");
const os = require("os");
const path = require("path");

let electronApp = null;
try {
  electronApp = require("electron")?.app || null;
} catch {}

const DEFAULT_STEAM_DB_ASSET = path.join(__dirname, "..", "assets", "steamdb.json");
const DEFAULT_UPLAY_MAP_ASSET = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json",
);

const jsonArrayCache = new Map();

function resolveUserDataDir(explicitUserDataDir = "") {
  const explicit = String(explicitUserDataDir || "").trim();
  if (explicit) return path.resolve(explicit);

  const envUserData = String(process.env.ACH_USER_DATA_DIR || "").trim();
  if (envUserData) return path.resolve(envUserData);

  try {
    if (electronApp && typeof electronApp.getPath === "function") {
      const value = electronApp.getPath("userData");
      if (value) return path.resolve(value);
    }
  } catch {}

  const base =
    process.env.APPDATA ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".local", "share"));
  return path.join(base, "Achievements");
}

function loadJsonArrayCached(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = path.resolve(filePath);
    const cached = jsonArrayCache.get(cacheKey);
    if (
      cached &&
      cached.mtimeMs === Number(stat.mtimeMs || 0) &&
      cached.size === Number(stat.size || 0)
    ) {
      return cached.value;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const value = Array.isArray(parsed) ? parsed : [];
    jsonArrayCache.set(cacheKey, {
      mtimeMs: Number(stat.mtimeMs || 0),
      size: Number(stat.size || 0),
      value,
    });
    return value;
  } catch {
    return [];
  }
}

function loadPreferredJsonArray(runtimePath, assetPath) {
  const runtime = String(runtimePath || "").trim();
  if (runtime && fs.existsSync(runtime)) {
    return loadJsonArrayCached(runtime);
  }
  if (assetPath && fs.existsSync(assetPath)) {
    return loadJsonArrayCached(assetPath);
  }
  return [];
}

function resolveSteamDbRuntimePath(opts = {}) {
  const explicit = String(opts.runtimePath || "").trim();
  if (explicit) return path.resolve(explicit);
  const envPath = String(process.env.STEAM_DB_PATH || "").trim();
  if (envPath) return path.resolve(envPath);
  return path.join(resolveUserDataDir(opts.userDataDir), "steamdb.json");
}

function resolveUplayMapRuntimePath(opts = {}) {
  const explicit = String(opts.runtimePath || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveUserDataDir(opts.userDataDir), "uplay-steam.json");
}

function lookupSteamDbName(appid, opts = {}) {
  const id = String(appid || "").trim();
  if (!id) return null;
  const rows = loadPreferredJsonArray(
    resolveSteamDbRuntimePath(opts),
    DEFAULT_STEAM_DB_ASSET,
  );
  const row = rows.find((entry) => String(entry?.appid || "").trim() === id);
  const name = String(row?.name || "").trim();
  return name || null;
}

function lookupUplayMappingEntry(uplayId, opts = {}) {
  const id = String(uplayId || "").trim();
  if (!id) return null;
  const rows = loadPreferredJsonArray(
    resolveUplayMapRuntimePath(opts),
    DEFAULT_UPLAY_MAP_ASSET,
  );
  return rows.find((entry) => String(entry?.uplay_id || "").trim() === id) || null;
}

module.exports = {
  lookupSteamDbName,
  lookupUplayMappingEntry,
};
