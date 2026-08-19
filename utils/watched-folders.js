// utils/watched-folders.js
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const chokidar = require("chokidar");
const { createLogger } = require("./logger");
const {
  readJsonWithBackupSync,
  writeJsonAtomicSync,
} = require("./atomic-json-store");
const { normalizePlatform } = require("./config-platform-migrator");
const {
  buildBlacklistConfigKey,
  normalizeAppIdValue,
  normalizeBlacklistConfigKey,
} = require("./blacklist-identity");
const { parseGpdFile, buildSnapshotFromGpd } = require("./xenia-gpd");
const {
  generateConfigFromGpd,
  updateSchemaFromGpd,
} = require("./xenia-config-generator");
const {
  parseTrophySetDir,
  buildSnapshotFromTrophy,
} = require("./rpcs3-trophy");
const {
  generateConfigFromTrophyDir,
  updateSchemaFromTrophy,
} = require("./rpcs3-config-generator");
const {
  generateConfigFromPs4Dir,
  updateSchemaFromPs4,
  buildSnapshotFromPs4,
  buildSnapshotFromPs4ProgressFile,
} = require("./shadps4-config-generator");
const { generateConfigFromAppcacheBin } = require("./steam-appcache-generator");
const {
  parseKVBinary: parseSteamKv,
  extractUserStats,
  buildSnapshotFromAppcache,
  normalizeAppcacheSchemaEntries,
  enrichSchemaEntriesFromAppcacheSchemaFile,
  pickPreferredUserBin,
  parseUserBinName,
} = require("./steam-appcache");
const { steamId64ToAccountId } = require("./steam-local-users");
const { parsePs4TrophySetDir } = require("./shadps4-trophy");
const { sanitizeConfigName } = require("./config-name");
const {
  clearLumaPlayReadCache,
  readLumaPlayAchievementsSnapshot,
  scanLumaPlayRegistryEntries,
  startLumaPlayRegistryEventWatcher,
} = require("./lumaplay-registry");
const {
  GAMEPLAY_DB_NAME,
  listGogOfficialGameplayEntries,
  resolveGogGalaxyProductByClientId,
  resolveGogOfficialGameplayDbForConfig,
} = require("./gog-galaxy-local");
const { normalizeProcessNameValue } = require("./process-name-utils");
const {
  buildUbisoftOfficialSnapshot,
  listUbisoftOfficialSpoolEntries,
  readUbisoftSpoolFile,
  resolveUbisoftOfficialSpoolFileForConfig,
  resolveUbisoftSpoolRoots,
} = require("./ubisoft-connect-local");
const {
  EA_VERBOSE_LOG_NAME,
  listEaOfficialAchievementSets,
  resolveEaOfficialLogsRoots,
  resolveEaOfficialVerboseLogForConfig,
} = require("./ea-desktop-local");
const {
  createConfigDeletionGuard,
} = require("./config-deletion-guard");
const {
  findMostSpecificContainingRoot,
  normalizeAbsolutePath,
  validateAppIdDirectoryTarget,
} = require("./config-deletion-paths");
const {
  MARKERPATCH_APP_ID,
  detectMarkerPatchRoot,
  ensureMarkerPatchConfig,
  getMarkerPatchGamePath,
  getMarkerPatchStateFile,
  isMarkerPatchConfig,
  normalizePathForComparison: normalizeMarkerPatchPath,
  readMarkerPatchSnapshot,
} = require("./markerpatch");
const {
  MADNESSPATCH_APP_ID,
  detectMadnessPatchRoot,
  ensureMadnessPatchConfig,
  getMadnessPatchCandidateRoots,
  getMadnessPatchCheckpointRoot,
  getMadnessPatchGamePath,
  isMadnessPatchConfig,
  listMadnessPatchStateFiles,
  normalizePathForComparison: normalizeMadnessPatchPath,
  readMadnessPatchSnapshot,
} = require("./madnesspatch");
const { createAdaptivePathWatcher } = require("./adaptive-path-watcher");
const GAMEPLAY_DB_WAL_NAME = `${GAMEPLAY_DB_NAME}-wal`;
const GAMEPLAY_DB_SHM_NAME = `${GAMEPLAY_DB_NAME}-shm`;

const watcherLogger = createLogger("watcher");
function getInvalidAutoAppIdReason(name) {
  const value = String(name || "").trim();
  if (!value) return "empty";
  if (!/^[0-9a-fA-F]+$/.test(value)) return "";
  if (value.length === 1) return "single-character-id";
  if (/^0+$/.test(value)) return "zero-only-id";
  if (/^0{4,}/.test(value)) return "leading-zero-padding";
  return "";
}

function isIgnoredAutoAppId(name) {
  return !!getInvalidAutoAppIdReason(name);
}

function isAppIdName(name) {
  const value = String(name || "").trim();
  return /^[0-9a-fA-F]+$/.test(value) && !isIgnoredAutoAppId(value);
}
const STRICT_ROOT_PROFILES = [
  {
    key: "steam-codex",
    suffix: ["steam", "codex"],
  },
  {
    key: "steam-rld",
    suffix: ["steam", "rld!"],
  },
  {
    key: "empress",
    suffix: ["empress"],
  },
  {
    key: "goldberg-steam",
    suffix: ["goldberg steamemu saves"],
  },
  {
    key: "gse",
    suffix: ["gse saves"],
  },
  {
    key: "goldberg-uplay",
    suffix: ["goldberg uplayemu saves"],
  },
  {
    key: "anadius-lsx",
    suffix: ["anadius", "lsx emu", "achievement_watcher"],
  },
];
function splitPathLower(inputPath) {
  return String(inputPath || "")
    .replace(/[\\/]+/g, path.sep)
    .toLowerCase()
    .split(path.sep)
    .filter(Boolean);
}
function isShadPs4RuntimePath(inputPath) {
  return splitPathLower(inputPath).includes("shadps4");
}
function matchesPathSuffix(pathParts, suffixParts) {
  if (!Array.isArray(pathParts) || !Array.isArray(suffixParts)) return false;
  if (!suffixParts.length || pathParts.length < suffixParts.length)
    return false;
  const offset = pathParts.length - suffixParts.length;
  for (let i = 0; i < suffixParts.length; i += 1) {
    if (pathParts[offset + i] !== suffixParts[i]) return false;
  }
  return true;
}
function getStrictRootProfile(rootPath) {
  const parts = splitPathLower(rootPath);
  for (const profile of STRICT_ROOT_PROFILES) {
    if (matchesPathSuffix(parts, profile.suffix)) {
      return profile;
    }
  }
  return null;
}
function getRelativeSegmentsFromRoot(rootPath, targetPath) {
  if (!rootPath || !targetPath) return [];
  let rel = "";
  try {
    rel = path.relative(rootPath, targetPath);
  } catch {
    return [];
  }
  if (!rel || rel === ".") return [];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  return rel.split(/[\\/]+/).filter(Boolean);
}
function parseStrictRootAppId(rootPath, targetPath) {
  const segments = getRelativeSegmentsFromRoot(rootPath, targetPath);
  if (!segments.length) return null;
  const first = segments[0];
  return isAppIdName(first) ? first : null;
}
function isPathInsideRoot(rootPath, targetPath) {
  if (!rootPath || !targetPath) return false;
  let rel = "";
  try {
    rel = path.relative(rootPath, targetPath);
  } catch {
    return false;
  }
  if (!rel || rel === ".") return true;
  return (
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}
function shouldIgnoreDiscoveredId(id) {
  const value = String(id || "").trim();
  if (!value) return false;
  // SteamID64 (user id), not a game appid
  if (/^7656\d{13}$/.test(value)) return true;
  // Numeric IDs longer than 11 digits are unlikely to be game appids
  if (/^\d{12,}$/.test(value)) return true;
  // Short hex with letters (e.g. 0F74F) is likely noise
  if (value.length < 6 && /[a-f]/i.test(value)) return true;
  return false;
}
async function discoverImmediateAppIdsUnder(
  root,
  yieldIfNeeded,
  shouldSkipPath = null,
) {
  const out = new Map();
  if (typeof shouldSkipPath === "function" && shouldSkipPath(root)) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const candidatePath = path.join(root, ent.name);
    if (
      typeof shouldSkipPath === "function" &&
      shouldSkipPath(candidatePath)
    ) {
      continue;
    }
    if (!isAppIdName(ent.name)) continue;
    if (shouldIgnoreDiscoveredId(ent.name)) continue;
    out.set(ent.name, candidatePath);
    if (yieldIfNeeded) await yieldIfNeeded();
  }
  return out;
}
function isRpcs3TempFolderName(name) {
  const value = String(name || "").toLowerCase();
  return /(?:\$|\uFF04)temp(?:\$|\uFF04)/.test(value);
}
const {
  loadAchievementsFromSaveFile,
  getSafeLocalizedText,
} = require("./achievement-data");

function coercePath(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (input.path && typeof input.path === "string") return input.path;
  if (input.filePath && typeof input.filePath === "string")
    return input.filePath;
  if (Array.isArray(input.filePaths) && input.filePaths[0])
    return input.filePaths[0];
  try {
    return String(input);
  } catch {
    return "";
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function waitForFileExists(fp, tries = 50, delay = 60) {
  return new Promise((resolve) => {
    const tick = (n) => {
      try {
        if (fs.existsSync(fp)) return resolve(true);
      } catch {}
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), delay);
    };
    tick(tries);
  });
}

function resolveXeniaImageId(parsedGpd, achKey) {
  if (!parsedGpd?.achievements?.length) return null;
  const id = Number(achKey);
  if (!Number.isFinite(id)) return null;
  const hit = parsedGpd.achievements.find((a) => a.achievementId === id);
  return hit ? hit.imageId : null;
}

async function waitForXeniaAchievementIcon(
  meta,
  achKey,
  imageId,
  parsedGpd,
  resolveGpdPath,
) {
  if (!meta?.config_path) return false;
  if (imageId === undefined || imageId === null) return false;
  const iconPath = path.join(meta.config_path, "img", `${imageId}.png`);
  if (fs.existsSync(iconPath)) return true;

  const gpdPath =
    typeof resolveGpdPath === "function" ? resolveGpdPath(meta) : "";
  if (!gpdPath || !fs.existsSync(gpdPath)) return false;

  watcherLogger.info("xenia:notify:wait-icon", {
    appid: String(meta?.appid || ""),
    config: meta?.name || null,
    achievement: String(achKey),
    imageId: String(imageId),
    iconPath,
  });

  const maxAttempts = 120;
  const delayMs = 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let parsed = null;
    if (attempt === 0 && parsedGpd) {
      parsed = parsedGpd;
    } else {
      try {
        parsed = parseGpdFile(gpdPath);
      } catch {
        parsed = null;
      }
    }
    if (parsed) {
      try {
        updateSchemaFromGpd(meta.config_path, parsed);
      } catch {}
    }
    if (fs.existsSync(iconPath)) {
      watcherLogger.info("xenia:notify:icon-ready", {
        appid: String(meta?.appid || ""),
        config: meta?.name || null,
        achievement: String(achKey),
        imageId: String(imageId),
        attempt: attempt + 1,
      });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  watcherLogger.warn("xenia:notify:icon-timeout", {
    appid: String(meta?.appid || ""),
    config: meta?.name || null,
    achievement: String(achKey),
    imageId: String(imageId),
    iconPath,
  });
  return false;
}

const DEFAULT_WATCH_ROOTS = (() => {
  const spec = [
    ["PUBLIC", ["Documents", "Steam", "CODEX"]],
    ["PUBLIC", ["Documents", "Steam", "RUNE"]],
    ["PUBLIC", ["Documents", "OnlineFix"]],
    ["PUBLIC", ["Documents", "EMPRESS"]],
    ["APPDATA", ["Goldberg SteamEmu Saves"]],
    ["APPDATA", ["Goldberg UplayEmu Saves"]],
    ["APPDATA", ["GSE Saves"]],
    ["APPDATA", ["EMPRESS"]],
    ["LOCALAPPDATA", ["anadius", "LSX emu", "achievement_watcher"]],
    ["APPDATA", ["Steam", "CODEX"]],
    ["APPDATA", ["SmartSteamEmu"]],
    ["LOCALAPPDATA", ["SKIDROW"]],
  ];

  return spec
    .map(([envKey, segments]) => {
      const base = process.env[envKey];
      if (!base) return null;
      try {
        return path.join(base, ...segments);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
})();
const DEFAULT_WATCH_SET = new Set(
  DEFAULT_WATCH_ROOTS.map((p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  }),
);
const DEFAULT_BLOCKED_ROOTS = (() => {
  if (process.platform !== "win32") return [];
  const systemIgnores = [
    "System Volume Information",
    "$Recycle.Bin",
    "$RECYCLE.BIN",
    "Recovery",
    "MSOCache",
  ];
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
  const programFiles = process.env.ProgramFiles || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
  const systemDrive = process.env.SystemDrive || "C:";
  const systemPaths = systemIgnores.map((name) => path.join(systemDrive, name));
  return [systemRoot, programFiles, programFilesX86, ...systemPaths].filter(
    Boolean,
  );
})();
const DEFAULT_BLOCKED_SET = new Set(
  DEFAULT_BLOCKED_ROOTS.map((p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }),
);

module.exports = function makeWatchedFolders({
  app,
  ipcMain,
  BrowserWindow,
  preferencesPath,
  updatePreferences,
  configsDir,
  generateGameConfigs,
  generateConfigForAppId = null,
  generateConfigsForAppIds = null,
  notifyWarn = (m) => console.warn(m),
  onEarned = null,
  onProgress = null,
  onSeedCache = null, // ( { appid, configName, snapshot } ) => void
  onAutoSelect = null, // (configName) => void
  isConfigActive = null,
  getCachedSnapshot = null,
  requestDashboardRefresh = null,
  onPlatinumComplete = null,
}) {
  // --- state ---
  const folderWatchers = new Map();
  const knownAppIds = new Set();
  const existingConfigIds = new Set();
  const activeRoots = new Set();
  const configIndex = new Map(); // appid -> Array<meta>
  const ps4NpCommIndex = new Map(); // npcommid -> Array<meta>
  const configPlatformPresence = new Map(); // appid -> Set(platform)
  const configSavePathIndex = new Map(); // appid -> Set(path)
  const pendingSavePathIndex = new Map(); // appid -> Set(path)
  const configDeletionGuard = createConfigDeletionGuard();
  const pausedDeletionRootWatchers = new Map(); // deletion token id -> roots
  const pendingObservedGenerations = new Set(); // appid+platform+normalizedSavePath keys
  const recentObservedGenerationTs = new Map(); // appid+platform+normalizedSavePath -> ts
  const recentObservedGenerationVariantTs = new Map(); // appid+platform -> ts
  const appidSaveWatchers = new Map(); // appid -> Map(configName, watcher)
  const pendingInitialNotify = new Set(); // config names needing one-shot notify after seed
  const missingRoots = new Set(); // watched folders missing on disk
  const pendingSteamOfficial = new Map(); // appid -> { statsDir, firstSeen }
  let missingRootTimer = null;
  let blockedFoldersCache = null;
  const persistPreferences =
    typeof updatePreferences === "function" ? updatePreferences : null;
  const justUnblocked = new Set(); // legacy/global AppID-wide unblock suppression
  const justUnblockedConfigs = new Set(); // exact config names recently unblocked
  const platinumNotified = new Set();
  const platinumNotifiedByApp = new Set();
  const tenokeIds = new Set();
  const persistedTenoke = new Set();
  const seededInitialConfigs = new Set();
  const initialNotifyPromotedConfigs = new Set();
  const tenokeRelinkedConfigs = new Set();
  const pendingAutoSelect = new Set();
  const autoSelectTimers = new Map();
  const suppressAutoSelect = new Set(); // appids temporarily blocked from auto-select (e.g., just unblocked)
  const suppressAutoSelectByConfig = new Set(); // config names temporarily blocked
  const lastAutoSelectTs = new Map(); // config name -> ts of last emit (throttle)
  const autoSelectEmitted = new Set(); // configs that already emitted auto-select to avoid duplicate emits
  const deferredSeedQueue = []; // config names queued for deferred initial seed
  const deferredSeedByConfig = new Map(); // configName -> task
  const deferredSeedPendingConfigs = new Set(); // config names waiting for deferred seed
  const deferredSeedActiveConfigs = new Set(); // config names currently seeding
  const steamOfficialSeedOnlyLogged = new Set(); // stats dirs logged once for root-only mode
  const strictRootSeedOnlyLogged = new Set(); // strict roots logged once for root-only mode
  const RECENT_OBSERVED_GENERATION_TTL_MS = 8000;
  let deferredSeedPumpTimer = null;
  let deferredSeedPumpRunning = false;
  let deferredSeedOverlayGateDone = false;
  let deferredSeedOverlayHiddenSeenAt = 0;
  let deferredSeedOverlayWaitStartedAt = 0;
  let deferredSeedOverlayWaitWarned = false;

  function resetPlatinumState(options = {}) {
    const rawConfigName = String(options?.configName || "").trim();
    const configName = rawConfigName ? sanitizeConfigName(rawConfigName) : "";
    const appid = String(options?.appid || "").trim();
    const removedConfig = configName
      ? platinumNotified.delete(configName)
      : false;
    const removedApp = appid ? platinumNotifiedByApp.delete(appid) : false;
    watcherLogger.info("platinum-state:reset", {
      config: configName || null,
      appid: appid || null,
      removedConfig,
      removedApp,
    });
    return { removedConfig, removedApp };
  }

  const cacheMetaPath = (() => {
    try {
      if (app && typeof app.getPath === "function") {
        const dir = app.getPath("userData");
        if (dir) return path.join(dir, "ach_cache_meta.json");
      }
    } catch {}
    if (preferencesPath) {
      try {
        return path.join(path.dirname(preferencesPath), "ach_cache_meta.json");
      } catch {}
    }
    if (configsDir) {
      try {
        return path.join(path.dirname(configsDir), "ach_cache_meta.json");
      } catch {}
    }
    return "";
  })();
  const cacheMeta = new Map(); // key -> { mtimeMs, size }
  let cacheMetaLoaded = false;
  let cacheMetaDirty = false;
  let cacheMetaSaveTimer = null;

  function loadCacheMetaOnce() {
    if (cacheMetaLoaded) return;
    cacheMetaLoaded = true;
    if (!cacheMetaPath || !fs.existsSync(cacheMetaPath)) return;
    try {
      const raw = fs.readFileSync(cacheMetaPath, "utf8");
      const parsed = JSON.parse(raw);
      const files =
        parsed && typeof parsed === "object" && parsed.files
          ? parsed.files
          : parsed;
      if (!files || typeof files !== "object") return;
      for (const [key, entry] of Object.entries(files)) {
        if (!entry || typeof entry !== "object") continue;
        const mtimeMs = Number(entry.mtimeMs ?? entry.mtime ?? 0);
        const size = Number(entry.size ?? 0);
        if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) continue;
        cacheMeta.set(key, { mtimeMs, size });
      }
    } catch {}
  }

  function scheduleCacheMetaSave() {
    if (!cacheMetaPath) return;
    cacheMetaDirty = true;
    if (cacheMetaSaveTimer) clearTimeout(cacheMetaSaveTimer);
    cacheMetaSaveTimer = setTimeout(async () => {
      if (!cacheMetaDirty) return;
      cacheMetaDirty = false;
      try {
        const payload = {
          version: 1,
          files: Object.fromEntries(cacheMeta),
        };
        writeJsonAtomicSync(cacheMetaPath, payload);
      } catch {}
    }, 500);
  }

  function cancelAutoSelectForMeta(meta) {
    if (!meta?.name) return;
    pendingAutoSelect.delete(meta.name);
    autoSelectEmitted.delete(meta.name);
    suppressAutoSelectByConfig.add(meta.name);
    const timer = autoSelectTimers.get(meta.name);
    if (timer) {
      clearTimeout(timer);
      autoSelectTimers.delete(meta.name);
    }
  }

  function cancelAutoSelectForApp(appid, platform = null) {
    const normalizedPlatform = platform ? normalizePlatform(platform) : null;
    const metas = getConfigMetas(appid);
    for (const meta of metas) {
      if (
        normalizedPlatform &&
        normalizePlatform(meta?.platform) !== normalizedPlatform
      ) {
        continue;
      }
      cancelAutoSelectForMeta(meta);
    }
  }

  function isRecentlyUnblocked(appid, meta = null) {
    return (
      justUnblocked.has(String(appid || "")) ||
      (!!meta?.name && justUnblockedConfigs.has(meta.name))
    );
  }

  function isAutoSelectSuppressedForMeta(appid, meta = null) {
    return (
      suppressAutoSelect.has(String(appid || "")) ||
      (!!meta?.name && suppressAutoSelectByConfig.has(meta.name))
    );
  }

  function releaseUnblockSuppression(appid, meta = null) {
    const appidKey = String(appid || "");
    if (appidKey) {
      suppressAutoSelect.delete(appidKey);
      justUnblocked.delete(appidKey);
    }
    if (meta?.name) {
      suppressAutoSelectByConfig.delete(meta.name);
      justUnblockedConfigs.delete(meta.name);
    }
  }

  function getConfigMetas(appid) {
    const rawKey = String(appid || "");
    const direct = configIndex.get(rawKey);
    if (Array.isArray(direct)) return direct;
    const normalizedKey = normalizeAppIdValue(rawKey);
    if (!normalizedKey) return [];
    const matches = [];
    for (const [indexedAppId, metas] of configIndex.entries()) {
      if (normalizeAppIdValue(indexedAppId) !== normalizedKey) continue;
      if (Array.isArray(metas)) matches.push(...metas);
    }
    return matches;
  }

  function getPs4ConfigMetasByNpCommId(npcommid) {
    const key = String(npcommid || "")
      .trim()
      .toLowerCase();
    if (!key) return [];
    const list = ps4NpCommIndex.get(key);
    return Array.isArray(list) ? list : [];
  }

  function getPrimaryConfigMeta(appid) {
    const metas = getConfigMetas(appid);
    return metas.length ? metas[0] : null;
  }

  function getMetaNormalizedSavePath(meta) {
    if (!meta) return "";
    return (
      String(meta?.normalizedSavePath || "") ||
      normalizeObservedPath(
        meta?.save_path || meta?.config_path || "",
        String(meta?.appid || ""),
      )
    );
  }

  function findConfigMetaForGeneration(
    appid,
    platform = null,
    normalizedSavePath = "",
  ) {
    const metas = getConfigMetas(appid);
    if (!metas.length) return null;
    const desiredPlatform = normalizePlatform(platform) || null;
    const normalizedPath = String(normalizedSavePath || "");
    let candidates = desiredPlatform
      ? metas.filter(
          (meta) =>
            (normalizePlatform(meta?.platform) || "steam") === desiredPlatform,
        )
      : metas.slice();
    if (!candidates.length && !desiredPlatform) candidates = metas.slice();
    if (normalizedPath) {
      const exact = candidates.find(
        (meta) => getMetaNormalizedSavePath(meta) === normalizedPath,
      );
      if (exact) return exact;
    }
    return candidates[0] || null;
  }

  function buildInitialSeedCandidatesForMeta(meta, rootDir = "") {
    const id = String(meta?.appid || "").trim();
    const normalizedRootDir = String(rootDir || "");
    return Array.from(
      new Set(
        [
          ...getSaveWatchTargets(meta),
          meta?.gog_gameplay_db ||
            path.join(meta?.save_path || "", GAMEPLAY_DB_NAME),
          normalizedRootDir
            ? path.join(normalizedRootDir, "achievements.json")
            : null,
          meta?.save_path
            ? path.join(meta.save_path, "achievements.json")
            : null,
          meta?.save_path
            ? path.join(meta.save_path, id, "achievements.json")
            : null,
          meta?.save_path
            ? path.join(
                meta.save_path,
                "steam_settings",
                id,
                "achievements.json",
              )
            : null,
          meta?.save_path
            ? path.join(meta.save_path, "remote", id, "achievements.json")
            : null,
          normalizedRootDir
            ? path.join(normalizedRootDir, "achievements.ini")
            : null,
          normalizedRootDir ? path.join(normalizedRootDir, "stats.ini") : null,
          normalizedRootDir
            ? path.join(normalizedRootDir, "Stats", "achievements.ini")
            : null,
          normalizedRootDir
            ? path.join(normalizedRootDir, "Stats", "stats.ini")
            : null,
          normalizedRootDir ? path.join(normalizedRootDir, "stats.bin") : null,
          meta?.save_path
            ? path.join(meta.save_path, "achievements.ini")
            : null,
          meta?.save_path ? path.join(meta.save_path, "stats.ini") : null,
          meta?.save_path
            ? path.join(meta.save_path, "Stats", "achievements.ini")
            : null,
          meta?.save_path
            ? path.join(meta.save_path, "Stats", "stats.ini")
            : null,
          meta?.save_path ? path.join(meta.save_path, "stats.bin") : null,
        ].filter(Boolean),
      ),
    );
  }

  function promoteInitialNotifyForMeta(appid, meta, candidates, context = {}) {
    if (!meta?.name) return false;
    if (bootMode) return false;
    const existingCandidates = (
      Array.isArray(candidates) ? candidates : []
    ).filter((candidate) => candidate && fs.existsSync(candidate));
    if (!existingCandidates.length) return false;
    if (initialNotifyPromotedConfigs.has(meta.name)) return false;
    initialNotifyPromotedConfigs.add(meta.name);
    watcherLogger.info("seed:promote-initial-notify", {
      appid: String(appid || meta?.appid || ""),
      config: meta.name,
      reason: context.reason || "post-create",
      rootPath: context.rootPath || meta?.save_path || null,
      platform: normalizePlatform(meta?.platform) || null,
    });
    runInitialSeedForMeta(
      String(appid || meta?.appid || ""),
      meta,
      existingCandidates,
      {
        suppressInitialNotify: false,
      },
    );
    return true;
  }

  function seedLumaPlaySnapshot(appid, meta, initialFlag = true, opts = {}) {
    const id = String(appid || meta?.appid || "");
    const configName = meta?.name || id;
    const bootLikeSeed = bootMode || opts.bornInBoot === true;
    const suppressInitialNotify =
      opts.suppressInitialNotify === true || bootLikeSeed;
    const snapKey = makeSnapshotKey(meta, id);

    let cached = null;
    if (typeof getCachedSnapshot === "function") {
      try {
        cached = getCachedSnapshot(configName, meta?.platform || null, {
          savePath: meta?.save_path || null,
          appid: id,
        });
      } catch {}
    }
    const cachedSnapshot =
      cached && typeof cached === "object" && !Array.isArray(cached)
        ? cached
        : null;
    const lastKnownSnapshot =
      lastSnapshot.get(snapKey) &&
      typeof lastSnapshot.get(snapKey) === "object" &&
      !Array.isArray(lastSnapshot.get(snapKey))
        ? lastSnapshot.get(snapKey)
        : null;
    const baselineSnapshot = cachedSnapshot || lastKnownSnapshot || null;
    const previousSnapshot = baselineSnapshot || {};

    const parsed = readLumaPlayAchievementsSnapshot({
      appid: String(meta?.appid || id || ""),
      configPath: meta?.config_path || "",
      preferredUser: meta?.lumaplay_user || "",
      preferredKeyPath: meta?.lumaplay_key_path || meta?.lumaplayKeyPath || "",
      previousSnapshot,
      readCache: opts.lumaPlayReadCache || null,
    });

    const parsedSnapshot =
      parsed?.snapshot &&
      typeof parsed.snapshot === "object" &&
      !Array.isArray(parsed.snapshot)
        ? parsed.snapshot
        : {};
    const baselineCount = Object.keys(baselineSnapshot || {}).length;
    const parsedCount = Object.keys(parsedSnapshot).length;
    const useBaselineSnapshot =
      baselineSnapshot &&
      (parsed?.found !== true || (parsedCount === 0 && baselineCount > 0));
    const snapshot = useBaselineSnapshot
      ? baselineSnapshot
      : parsed?.found === true
        ? parsedSnapshot
        : null;

    if (snapshot && typeof snapshot === "object") {
      lastSnapshot.set(snapKey, snapshot);
    } else if (baselineSnapshot) {
      lastSnapshot.set(snapKey, baselineSnapshot);
    }

    if (parsed?.user && parsed.user !== meta?.lumaplay_user) {
      meta.lumaplay_user = parsed.user;
    }
    if (parsed?.keyPath && parsed.keyPath !== meta?.lumaplay_key_path) {
      meta.lumaplay_key_path = parsed.keyPath;
    }

    if (initialFlag) {
      seededInitialConfigs.add(configName);
    }

    if (snapshot && typeof onSeedCache === "function") {
      try {
        const hasSnapshotEntries = Object.keys(snapshot || {}).length > 0;
        const skipBootSeed =
          useBaselineSnapshot ||
          !hasSnapshotEntries ||
          isBootSnapshotIdentical(meta, id, snapshot, {
            bootLike: bootLikeSeed,
          });
        if (!skipBootSeed) {
          onSeedCache({
            appid: id,
            configName,
            platform: meta?.platform || null,
            savePath: meta?.save_path || null,
            snapshot,
          });
        } else {
          watcherLogger.info("seed:cache-skip-identical", {
            appid: id,
            config: configName,
            file:
              parsed?.keyPath ||
              meta?.lumaplay_key_path ||
              meta?.save_path ||
              null,
            bootMode,
          });
        }
      } catch {}
    }

    if (initialFlag && !suppressInitialNotify) {
      pendingInitialNotify.add(configName);
      watcherLogger.info("seed:pending-notify-set", {
        appid: id,
        config: configName,
        file:
          parsed?.keyPath || meta?.lumaplay_key_path || meta?.save_path || null,
        bootMode,
      });
    } else if (initialFlag) {
      watcherLogger.info("seed:pending-notify-skip", {
        appid: id,
        config: configName,
        file:
          parsed?.keyPath || meta?.lumaplay_key_path || meta?.save_path || null,
        bootMode,
      });
    }

    return !!snapshot;
  }

  async function autoSelectConfig(meta) {
    if (bootMode) {
      watcherLogger.info("auto-select:skip-boot", {
        config: meta?.name,
        appid: meta?.appid || null,
      });
      return;
    }
    const name = meta?.name;
    if (!name) return;
    const appidKey =
      normalizeAppIdValue(meta?.appid) || String(meta?.appid || "");
    if (appidKey && configDeletionGuard.isSuppressed(appidKey)) {
      watcherLogger.info("auto-select:skip-config-deleting", {
        config: name,
        appid: appidKey,
      });
      return;
    }
    if (appidKey && suppressAutoSelect.has(appidKey)) {
      watcherLogger.info("auto-select:skip-suppressed-app", {
        config: name,
        appid: appidKey,
      });
      return;
    }
    if (suppressAutoSelectByConfig.has(name)) {
      watcherLogger.info("auto-select:skip-suppressed-config", {
        config: name,
      });
      return;
    }
    if (autoSelectEmitted.has(name)) {
      watcherLogger.info("auto-select:skip-already-emitted", { config: name });
      return;
    }
    const now = Date.now();
    const last = lastAutoSelectTs.get(name) || 0;
    if (now - last < 1200) return; // throttle duplicate emits
    if (isConfigActive?.(name)) {
      pendingAutoSelect.delete(name);
      autoSelectEmitted.delete(name);
      watcherLogger.info("auto-select:skip-active", { config: name });
      return;
    }
    const cfgPath =
      configsDir && name ? path.join(configsDir, `${name}.json`) : null;
    if (cfgPath) await waitForFileExists(cfgPath);
    if (!cfgPath || !fs.existsSync(cfgPath)) {
      watcherLogger.warn("auto-select:config-missing", {
        config: name,
        cfgPath,
      });
      return;
    }
    watcherLogger.info("auto-select:emit", { config: name, cfgPath });
    lastAutoSelectTs.set(name, Date.now());
    pendingAutoSelect.add(name);
    autoSelectEmitted.add(name);
    try {
      broadcastAll("auto-select-config", name);
    } catch {}
    try {
      if (typeof onAutoSelect === "function") onAutoSelect(name);
    } catch {}
    // Allow re-emit later if UI did not pick it up yet
    setTimeout(() => {
      if (pendingAutoSelect.has(name) && !isConfigActive?.(name)) {
        autoSelectEmitted.delete(name);
        pendingAutoSelect.delete(name);
      }
    }, 1400);
  }

  function enqueueAutoSelect(meta) {
    if (!meta || !meta.name) return;
    const name = meta.name;
    if (autoSelectTimers.has(name)) {
      watcherLogger.info("auto-select:enqueue-skip-timer", { config: name });
      return;
    }
    const appidKey =
      normalizeAppIdValue(meta.appid) || String(meta.appid || "");
    if (appidKey && configDeletionGuard.isSuppressed(appidKey)) {
      watcherLogger.info("auto-select:enqueue-skip-config-deleting", {
        config: name,
        appid: appidKey,
      });
      return;
    }
    if (appidKey && suppressAutoSelect.has(appidKey)) {
      watcherLogger.info("auto-select:enqueue-skip-suppressed-app", {
        config: name,
        appid: appidKey,
      });
      return;
    }
    if (suppressAutoSelectByConfig.has(name)) {
      watcherLogger.info("auto-select:enqueue-skip-suppressed-config", {
        config: name,
      });
      return;
    }
    if (autoSelectEmitted.has(name)) {
      watcherLogger.info("auto-select:enqueue-skip-already-emitted", {
        config: name,
      });
      return;
    }
    if (pendingAutoSelect.has(name)) {
      watcherLogger.info("auto-select:enqueue-skip-pending", { config: name });
      return;
    }
    pendingAutoSelect.add(name);

    const maxAttempts = 6;
    const delayMs = 400;
    let attempts = 0;

    const attempt = async () => {
      if (bootMode) return;
      if (isConfigActive?.(name)) {
        pendingAutoSelect.delete(name);
        autoSelectEmitted.delete(name);
        autoSelectTimers.delete(name);
        return;
      }
      const cfgPath =
        configsDir && name ? path.join(configsDir, `${name}.json`) : null;
      const schemaPath = resolveAchievementsSchemaPath(meta);
      const ready =
        cfgPath &&
        fs.existsSync(cfgPath) &&
        schemaPath &&
        fs.existsSync(schemaPath);
      watcherLogger.info("auto-select:attempt", {
        config: name,
        appid: String(meta.appid || ""),
        attempt: attempts + 1,
        ready,
        cfgPath,
        cfgExists: cfgPath ? fs.existsSync(cfgPath) : false,
        schemaPath,
        schemaExists: schemaPath ? fs.existsSync(schemaPath) : false,
      });
      if (ready) {
        await autoSelectConfig(meta);
      }
      attempts += 1;
      if (isConfigActive?.(name)) {
        pendingAutoSelect.delete(name);
        autoSelectEmitted.delete(name);
        autoSelectTimers.delete(name);
        return;
      }
      if (attempts < maxAttempts) {
        const t = setTimeout(attempt, delayMs);
        autoSelectTimers.set(name, t);
      } else {
        autoSelectTimers.delete(name);
        autoSelectEmitted.delete(name);
        pendingAutoSelect.delete(name);
        watcherLogger.info("auto-select:give-up", {
          config: name,
          appid: String(meta.appid || ""),
        });
      }
    };

    const t = setTimeout(attempt, 0);
    autoSelectTimers.set(name, t);
  }

  function normalizePathForMetaMatch(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return path.normalize(raw).toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  }

  function scoreMetaForPath(meta, filePath) {
    const normalizedFilePath = normalizePathForMetaMatch(filePath);
    if (!meta || !normalizedFilePath) return 0;
    let bestScore = 0;

    const updateBest = (candidatePath, exactScore, parentScore) => {
      const normalizedCandidate = normalizePathForMetaMatch(candidatePath);
      if (!normalizedCandidate) return;
      if (normalizedFilePath === normalizedCandidate) {
        bestScore = Math.max(
          bestScore,
          exactScore + normalizedCandidate.length,
        );
        return;
      }
      if (normalizedFilePath.startsWith(`${normalizedCandidate}${path.sep}`)) {
        bestScore = Math.max(
          bestScore,
          parentScore + normalizedCandidate.length,
        );
      }
    };

    for (const target of getSaveWatchTargets(meta)) {
      updateBest(target, 100000, 80000);
    }
    updateBest(meta?.save_path || "", 70000, 60000);
    updateBest(meta?.config_path || "", 50000, 40000);

    return bestScore;
  }

  function pickMetaForPath(appid, filePath) {
    const metas = getConfigMetas(appid);
    if (!metas.length) return null;
    if (!filePath) return metas[0];

    let bestMeta = null;
    let bestScore = 0;
    for (const meta of metas) {
      const score = scoreMetaForPath(meta, filePath);
      if (score > bestScore) {
        bestScore = score;
        bestMeta = meta;
      }
    }
    return bestMeta || metas[0];
  }

  function pickExistingSeedTargetForMeta(meta, candidates) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    if (!list.length) return "";
    const isXenia = isXeniaMeta(meta);
    const appid = String(meta?.appid || "").trim();

    let bestTarget = "";
    let bestScore = 0;
    for (const candidate of list) {
      let stat = null;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stat?.isFile?.()) continue;
      if (isXenia && !isExpectedXeniaGpdFile(meta, appid, candidate)) {
        continue;
      }

      const score = scoreMetaForPath(meta, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestTarget = candidate;
      }
    }

    return bestScore > 0 ? bestTarget : "";
  }

  function ensureWatcherBucket(appid) {
    const key = String(appid);
    if (!appidSaveWatchers.has(key)) {
      appidSaveWatchers.set(key, new Map());
    }
    return appidSaveWatchers.get(key);
  }

  function markPlatformVariant(appid, platform) {
    const key = String(appid);
    if (!configPlatformPresence.has(key)) {
      configPlatformPresence.set(key, new Set());
    }
    const normalized = normalizePlatform(platform) || "steam";
    configPlatformPresence.get(key).add(normalized);
  }

  function hasPlatformVariant(appid, platform) {
    const set = configPlatformPresence.get(String(appid));
    if (!set) return false;
    const normalized = normalizePlatform(platform) || "steam";
    return set.has(normalized);
  }

  function determineAlternatePlatform(appid) {
    const id = String(appid || "").trim();
    if (!id) return null;

    // If we already have a Uplay config but we just discovered a classic
    // Steam-style save path, generate the Steam variant too.
    if (hasPlatformVariant(id, "uplay") && !hasPlatformVariant(id, "steam")) {
      return "steam";
    }

    // If we already have a Steam official config but we just discovered a new
    // (non-official) save path, generate the classic Steam variant too.
    if (
      hasPlatformVariant(id, "steam-official") &&
      !hasPlatformVariant(id, "steam")
    ) {
      return "steam";
    }

    return null;
  }

  function normalizeObservedGenerationPath(dir) {
    if (!dir) return "";
    return normalizePrefPath(dir)
      .replace(/[\\/]+/g, path.sep)
      .toLowerCase();
  }

  function buildObservedGenerationKey(appid, platform, normalizedSavePath) {
    const id = String(appid || "").trim();
    const normalizedPath = normalizeObservedGenerationPath(normalizedSavePath);
    if (!id || !normalizedPath) return "";
    const normalizedPlatform = normalizePlatform(platform) || "auto";
    return `${id}::${normalizedPlatform}::${normalizedPath}`;
  }

  function buildObservedGenerationVariantKey(appid, platform) {
    const id = String(appid || "").trim();
    if (!id) return "";
    const normalizedPlatform = normalizePlatform(platform) || "auto";
    return `${id}::${normalizedPlatform}`;
  }

  function pruneRecentObservedGeneration(now = Date.now()) {
    for (const [key, ts] of recentObservedGenerationTs.entries()) {
      if (now - Number(ts || 0) >= RECENT_OBSERVED_GENERATION_TTL_MS) {
        recentObservedGenerationTs.delete(key);
      }
    }
    for (const [key, ts] of recentObservedGenerationVariantTs.entries()) {
      if (now - Number(ts || 0) >= RECENT_OBSERVED_GENERATION_TTL_MS) {
        recentObservedGenerationVariantTs.delete(key);
      }
    }
  }

  function isObservedGenerationPending(appid, platform, normalizedSavePath) {
    const key = buildObservedGenerationKey(appid, platform, normalizedSavePath);
    return key ? pendingObservedGenerations.has(key) : false;
  }

  function wasObservedGenerationRecent(appid, platform, normalizedSavePath) {
    const key = buildObservedGenerationKey(appid, platform, normalizedSavePath);
    if (!key) return false;
    const now = Date.now();
    pruneRecentObservedGeneration(now);
    const ts = Number(recentObservedGenerationTs.get(key) || 0);
    return ts > 0 && now - ts < RECENT_OBSERVED_GENERATION_TTL_MS;
  }

  function wasObservedGenerationVariantRecent(appid, platform) {
    const key = buildObservedGenerationVariantKey(appid, platform);
    if (!key) return false;
    const now = Date.now();
    pruneRecentObservedGeneration(now);
    const ts = Number(recentObservedGenerationVariantTs.get(key) || 0);
    return ts > 0 && now - ts < RECENT_OBSERVED_GENERATION_TTL_MS;
  }

  function markObservedGenerationPending(appid, platform, normalizedSavePath) {
    const key = buildObservedGenerationKey(appid, platform, normalizedSavePath);
    if (key) pendingObservedGenerations.add(key);
  }

  function clearObservedGenerationPending(appid, platform, normalizedSavePath) {
    const key = buildObservedGenerationKey(appid, platform, normalizedSavePath);
    if (key) pendingObservedGenerations.delete(key);
  }

  function markObservedGenerationRecent(appid, platform, normalizedSavePath) {
    const key = buildObservedGenerationKey(appid, platform, normalizedSavePath);
    if (!key) return;
    recentObservedGenerationTs.set(key, Date.now());
    pruneRecentObservedGeneration();
  }

  function markObservedGenerationVariantRecent(appid, platform) {
    const key = buildObservedGenerationVariantKey(appid, platform);
    if (!key) return;
    recentObservedGenerationVariantTs.set(key, Date.now());
    pruneRecentObservedGeneration();
  }

  const rescanInProgress = { value: false };
  const normalize = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  function getStrictRootEventModeInfo(meta) {
    if (!meta?.save_path) return null;
    if (
      isSteamOfficialMeta(meta) ||
      isUbisoftOfficialMeta(meta) ||
      isXeniaMeta(meta) ||
      isRpcs3Meta(meta) ||
      isPs4Meta(meta)
    ) {
      return null;
    }
    const appid = String(meta?.appid || "")
      .trim()
      .toLowerCase();
    if (!appid) return null;
    let savePath = "";
    try {
      savePath = normalize(meta.save_path);
    } catch {
      savePath = "";
    }
    if (!savePath) return null;
    const roots = getWatchedFolders();
    let best = null;
    for (const rootPath of roots) {
      const root = normalizeRoot(coercePath(rootPath));
      const profile = getStrictRootProfile(root);
      if (!profile) continue;
      if (!isPathInsideRoot(root, savePath)) continue;
      if (!best || root.length > best.root.length) {
        best = { root, profile };
      }
    }
    if (!best) return null;
    const strictAppId = parseStrictRootAppId(best.root, savePath);
    if (strictAppId && strictAppId.toLowerCase() !== appid) {
      return null;
    }
    return best;
  }

  const BOOT_GEN_CONCURRENCY = 5;
  const BOOT_GEN_SLICE_MS = 50;
  const BOOT_SCAN_CONCURRENCY = 20;
  const BOOT_SCAN_SLICE_MS = 50;
  const BOOT_INDEX_CONCURRENCY = 20;
  const BOOT_INDEX_SLICE_MS = 15;
  const BOOT_ATTACH_BATCH = 10;
  const BOOT_ATTACH_DELAY_MS = 250;
  const BOOT_ATTACH_SLICE_MS = 5;
  const BOOT_ATTACH_ITEM_DELAY_MS = 250;
  const STRICT_ROOT_ATTACH_ITEM_DELAY_MS = 150;
  const ROOT_WATCH_START_ITEM_DELAY_MS = 150;
  const ROOT_WATCH_START_BATCH = 2;
  const STRICT_ROOT_WATCH_DEPTH = 3;
  const ROOT_WATCH_SETTLE_DELAY_MS = 250;
  const BOOT_PHASE_SETTLE_DELAY_MS = 200;
  const RESCAN_PHASE_SETTLE_DELAY_MS = 150;
  const BOOT_WATCH_FOLDER_DELAY_MS = 250;
  const BOOT_STRICT_SCAN_STAGGER_BASE_MS = 250;
  const BOOT_STRICT_SCAN_STAGGER_STEP_MS = 50;
  const BOOT_STRICT_SCAN_STAGGER_SLOTS = 4; // 100..250ms
  const DEFERRED_SEED_ITEM_DELAY_MS = 30;
  const BOOT_DEFERRED_SEED_AFTER_OVERLAY_HIDE_DELAY_MS = 1500;
  const BOOT_DEFERRED_SEED_OVERLAY_POLL_MS = 250;
  const BOOT_DEFERRED_SEED_OVERLAY_WAIT_MAX_MS = 20000;
  const BOOT_SCAN_AFTER_OVERLAY_HIDE_DELAY_MS = 500;
  const BOOT_SCAN_OVERLAY_WAIT_POLL_MS = 200;
  const BOOT_SCAN_OVERLAY_WAIT_MAX_MS = 15000;
  const LUMAPLAY_EVENT_WATCH_RESTART_MS = Math.max(
    500,
    Number(process.env.LUMAPLAY_EVENT_WATCH_RESTART_MS) || 1500,
  );
  const LUMAPLAY_DISCOVERY_DEBOUNCE_MS = Math.max(
    150,
    Number(process.env.LUMAPLAY_DISCOVERY_DEBOUNCE_MS) || 350,
  );
  const AUTOCONFIG_ONBOARDING_VERSION = 1;
  const AUTOCONFIG_ONBOARDING_COMPLETED_PREF_KEY =
    "autoConfigOnboardingCompleted";
  const AUTOCONFIG_ONBOARDING_VERSION_PREF_KEY = "autoConfigOnboardingVersion";
  const AUTOCONFIG_ONBOARDING_COMPLETED_AT_PREF_KEY =
    "autoConfigOnboardingCompletedAt";
  const AUTOCONFIG_ONBOARDING_DISCOVERY_MAX_DEPTH = 5;
  const AUTOCONFIG_ONBOARDING_DISCOVERY_MAX_DIRS = 500;
  const AUTOCONFIG_ONBOARDING_DISCOVERY_CACHE_MS = 15000;
  const AUTOCONFIG_ONBOARDING_ATTENTION_INTERVAL_MS = Math.max(
    5000,
    Number(process.env.AUTOCONFIG_ONBOARDING_ATTENTION_INTERVAL_MS) || 20000,
  );
  let bootMode = true;
  let bootCompleteEmitted = false;
  let lumaPlayDiscoveryRunning = false;
  let lumaPlayDiscoveryPending = false;
  let lumaPlayDiscoveryWatcher = null;
  let lumaPlayDiscoveryTimer = null;
  let lumaPlayDiscoveryScheduledOptions = null;
  let bootOnboardingRequired = false;
  let bootOnboardingGateOpen = true;
  let bootOnboardingGatePromise = Promise.resolve();
  let bootOnboardingGateResolve = null;
  let bootOnboardingStartedAt = 0;
  let bootOnboardingDecisionAt = 0;
  let bootOnboardingShowSent = false;
  let bootOnboardingAttentionTimer = null;
  let bootOnboardingDiscoveryCache = {
    at: 0,
    candidates: [],
  };
  let bootOnboardingDirtyRoots = new Set();
  let bootOnboardingDirtyRescanRunning = false;

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      aKeys.sort();
      bKeys.sort();
      for (let i = 0; i < aKeys.length; i += 1) {
        if (aKeys[i] !== bKeys[i]) return false;
      }
      for (const key of aKeys) {
        if (!deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }

  function normalizeSnapshotForBootCompare(snapshot, platform) {
    const normalizedPlatform = normalizePlatform(platform);
    if (normalizedPlatform !== "rpcs3") return snapshot;
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    const normalized = {};
    for (const [key, entry] of Object.entries(snapshot)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        normalized[key] = entry;
        continue;
      }
      const { earned_time, ...rest } = entry;
      normalized[key] = rest;
    }
    return normalized;
  }

  function isBootSnapshotIdentical(meta, appid, snapshot, options = {}) {
    const bootLike = options.bootLike === true || bootMode;
    if (!bootLike) return false;
    if (!snapshot || typeof snapshot !== "object") return false;
    if (typeof getCachedSnapshot !== "function") return false;
    let cached = null;
    try {
      cached = getCachedSnapshot(meta?.name || appid, meta?.platform || null, {
        savePath: options?.savePath || meta?.save_path || null,
        filePath: options?.filePath || "",
        shadps4UserId: options?.shadps4UserId || "",
        appid,
      });
    } catch {}
    if (!cached || typeof cached !== "object") return false;
    const platform = meta?.platform || null;
    const normalizedSnapshot = normalizeSnapshotForBootCompare(
      snapshot,
      platform,
    );
    const normalizedCached = normalizeSnapshotForBootCompare(cached, platform);
    return deepEqual(normalizedSnapshot, normalizedCached);
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function createTimeSlicer(sliceMs = 0) {
    const slice = Math.max(0, Number(sliceMs) || 0);
    let last = Date.now();
    return async () => {
      if (!slice) return;
      const now = Date.now();
      if (now - last < slice) return;
      last = now;
      await sleep(0);
    };
  }

  async function runWithConcurrency(items, limit, worker) {
    if (!Array.isArray(items) || items.length === 0) return;
    const max = Math.max(1, Number(limit) || 1);
    let running = 0;
    let idx = 0;
    return new Promise((resolve) => {
      const next = () => {
        while (running < max && idx < items.length) {
          const item = items[idx++];
          running++;
          Promise.resolve()
            .then(() => worker(item))
            .catch(() => {})
            .finally(() => {
              running--;
              if (running === 0 && idx >= items.length) {
                resolve();
                return;
              }
              setTimeout(next, 0);
            });
        }
        if (running === 0 && idx >= items.length) resolve();
      };
      next();
    });
  }

  async function generateIdsThrottled(tasks, opts = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return new Set();
    }
    let running = 0;
    let idx = 0;
    const generated = new Set();
    const onTaskProgress =
      typeof opts.onTaskProgress === "function" ? opts.onTaskProgress : null;
    const onTaskSettled =
      typeof opts.onTaskSettled === "function" ? opts.onTaskSettled : null;

    return new Promise((resolve) => {
      const next = async () => {
        while (running < BOOT_GEN_CONCURRENCY && idx < tasks.length) {
          const taskIndex = idx;
          const task = tasks[idx++];
          running++;
          (async () => {
            let generationResult = null;
            try {
              generationResult = await generateOneAppId(
                task.appid,
                task.appDir || null,
                {
                  forcePlatform: task.forcePlatform,
                  normalizedSavePath: task.normalizedPath || "",
                  skipPostIndex: true,
                  allowExistingVariant: task.allowExistingVariant === true,
                  __savePathOverride: task.__savePathOverride || null,
                  __gogName: task.__gogName || null,
                  __gogLaunchMetadata: task.__gogLaunchMetadata || null,
                  __gogClientId: task.__gogClientId || null,
                  __gogUserId: task.__gogUserId || null,
                  __gogGameplayDbPath: task.__gogGameplayDbPath || null,
                  __ubisoftUserId: task.__ubisoftUserId || null,
                  __ubisoftSpoolFile: task.__ubisoftSpoolFile || null,
                  __eaAchievementSet: task.__eaAchievementSet || null,
                  __eaLogFile: task.__eaLogFile || null,
                  __eaGameName: task.__eaGameName || null,
                  __emu: task.__emu || null,
                  onGenerationProgress: onTaskProgress
                    ? (progress) => onTaskProgress(task, taskIndex, progress)
                    : null,
                },
              );
              if (generationResult?.created === true) {
                generated.add(String(task.appid));
              }
            } catch {
            } finally {
              try {
                if (onTaskSettled) {
                  onTaskSettled(task, taskIndex, generationResult);
                }
              } catch {}
              running--;
              setTimeout(next, BOOT_GEN_SLICE_MS);
            }
          })();
        }
        if (running === 0 && idx >= tasks.length) resolve(generated);
      };
      next();
    });
  }

  function isBootBatchableGenerationTask(task = {}) {
    const appid = String(task?.appid || "").trim();
    if (!/^[0-9a-fA-F]+$/.test(appid)) return false;
    const platform = normalizePlatform(task?.forcePlatform) || "steam";
    if (platform.endsWith("-official")) return false;
    if (task.__emu) return false;
    if (
      task.__gogClientId ||
      task.__gogUserId ||
      task.__gogGameplayDbPath ||
      task.__ubisoftUserId ||
      task.__ubisoftSpoolFile ||
      task.__eaAchievementSet ||
      task.__eaLogFile ||
      task.__eaGameName
    ) {
      return false;
    }
    return true;
  }

  function createGenerationBatchReporter(tasks, meta = {}) {
    const list = Array.isArray(tasks) ? tasks : [];
    const total = list.length;
    const id = `generation-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scope = total > 1 ? "batch" : "single";
    const deferStartUntilVisible = meta?.deferStartUntilVisible === true;
    const usePhaseOnlyDetails = meta?.usePhaseOnlyDetails === true;
    const states = list.map((task, index) => ({
      index,
      appid: String(task?.appid || ""),
      itemName: String(
        task?.__eaGameName || task?.__gogName || task?.appid || "",
      ).trim(),
      percent: 0,
      phase: "preparing",
      detail: "",
      finalState: null,
    }));
    let lastIndex = 0;
    let progressOverrideCurrent = 0;
    let progressOverrideTotal = 0;
    let progressOverridePercent = 0;
    let progressOverrideAppId = "";
    let progressOverrideItemName = "";
    let progressOverridePhase = "";
    let progressOverrideDetail = "";

    const clampPercent = (value, fallback = 0) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      if (n <= 0) return 0;
      if (n >= 100) return 100;
      return Math.round(n);
    };

    const currentState = () => {
      const active = states.find(
        (entry) => entry.percent > 0 && entry.percent < 100,
      ) ||
        states[lastIndex] ||
        states[0] || {
          appid: "",
          itemName: "",
          phase: "preparing",
          detail: "",
        };
      const completed = states.filter((entry) => entry.percent >= 100).length;
      const current =
        progressOverrideCurrent > 0
          ? Math.min(
              progressOverrideTotal > 0 ? progressOverrideTotal : total,
              progressOverrideCurrent,
            )
          : total > 0
            ? Math.min(total, completed + (completed < total ? 1 : 0))
            : 0;
      const resolvedTotal =
        progressOverrideTotal > 0 ? progressOverrideTotal : total;
      const computedPercent =
        total > 0
          ? Math.round(
              states.reduce(
                (sum, entry) => sum + clampPercent(entry.percent, 0),
                0,
              ) / total,
            )
          : 0;
      const percent =
        progressOverridePercent > 0
          ? Math.max(computedPercent, progressOverridePercent)
          : computedPercent;
      return {
        current,
        total: resolvedTotal,
        percent,
        appid: progressOverrideAppId || active.appid || "",
        itemName:
          progressOverrideItemName ||
          active.itemName ||
          active.appid ||
          "",
        phase: progressOverridePhase || active.phase || "preparing",
        detail: usePhaseOnlyDetails
          ? progressOverrideDetail || active.detail || ""
          : progressOverrideDetail ||
            active.detail ||
            String(meta?.defaultDetail || "Preparing config generation"),
      };
    };

    const emit = (channel, payload = {}) => {
      try {
        broadcastAll(channel, {
          id,
          kind: "config-generate",
          scope,
          ...payload,
        });
      } catch {}
    };

    let started = false;

    const emitStart = (state = currentState(), overrides = {}) => {
      if (started) return;
      started = true;
      emit("generation:progress:start", {
        status: "running",
        current: state.current,
        total: state.total,
        percent: state.percent,
        appid: state.appid,
        itemName: String(meta?.rootLabel || state.itemName || ""),
        phase: String(overrides.phase || state.phase || "preparing"),
        detail:
          usePhaseOnlyDetails
            ? String(overrides.detail || state.detail || "")
            : String(
                overrides.detail ||
                  state.detail ||
                  meta?.defaultDetail ||
                  "Preparing config generation",
              ) || "",
      });
    };

    const shouldRevealProgress = (progress = {}, state = null) => {
      if (!deferStartUntilVisible) return true;
      const phase = String(progress?.phase || state?.phase || "").toLowerCase();
      const status = String(progress?.status || "").toLowerCase();
      const detail = String(
        progress?.detail || state?.detail || "",
      ).toLowerCase();
      if (status === "failed" || phase === "failed") return true;
      if (
        phase === "schemaparse" ||
        phase === "generatingschema" ||
        phase === "fetchsteamapi" ||
        phase === "fetchsteamdb" ||
        phase === "fetchepic" ||
        phase === "finalizing"
      ) {
        return true;
      }
      if (
        detail.includes("schema") ||
        detail.includes("steamdb") ||
        detail.includes("epic achievements") ||
        detail.includes("finalizing")
      ) {
        return true;
      }
      if (detail === "config created" || detail === "config updated")
        return true;
      if (detail === "waiting for schema generation") return true;
      if (phase === "skipped" || detail === "config generation skipped")
        return false;
      return false;
    };

    return {
      start() {
        if (deferStartUntilVisible) return;
        const state = currentState();
        emitStart(state, {
          phase: "preparing",
          detail: String(meta?.defaultDetail || "Preparing config generation"),
        });
      },
      updateTask(task, taskIndex, progress = {}) {
        const state = states[taskIndex];
        if (!state) return;
        lastIndex = taskIndex;
        state.appid = String(
          progress?.appid || task?.appid || state.appid || "",
        );
        state.itemName = String(
          progress?.itemName ||
            progress?.name ||
            state.itemName ||
            state.appid ||
            "",
        ).trim();
        state.phase = String(progress?.phase || state.phase || "");
        state.detail = String(progress?.detail || state.detail || "");
        state.percent = clampPercent(progress?.percent, state.percent || 0);
        if (
          Number.isFinite(Number(progress?.current)) &&
          Number(progress.current) > 0
        ) {
          progressOverrideCurrent = Number(progress.current);
        }
        if (
          Number.isFinite(Number(progress?.total)) &&
          Number(progress.total) > 0
        ) {
          progressOverrideTotal = Number(progress.total);
        }
        if (
          Number.isFinite(Number(progress?.percent)) &&
          Number(progress.percent) > 0
        ) {
          progressOverridePercent = clampPercent(progress.percent, 0);
        }
        progressOverrideAppId = String(progress?.appid || state.appid || "");
        progressOverrideItemName = String(
          progress?.itemName || progress?.name || state.itemName || "",
        ).trim();
        progressOverridePhase = String(progress?.phase || state.phase || "");
        progressOverrideDetail = String(progress?.detail || state.detail || "");
        const summary = currentState();
        if (!started) {
          if (!shouldRevealProgress(progress, state)) return;
          emitStart(summary);
        }
        emit("generation:progress:update", {
          status: "running",
          current: summary.current,
          total: summary.total,
          percent: summary.percent,
          appid: state.appid,
          itemName: state.itemName || state.appid || "",
          phase: state.phase || summary.phase,
          detail: state.detail || summary.detail,
        });
      },
      settleTask(task, taskIndex, result = null) {
        const state = states[taskIndex];
        if (!state) return;
        lastIndex = taskIndex;
        state.appid = String(task?.appid || state.appid || "");
        state.itemName = String(
          state.itemName ||
            task?.__eaGameName ||
            task?.__gogName ||
            state.appid,
        ).trim();
        state.percent = 100;
        if (progressOverrideCurrent > 0) {
          progressOverrideCurrent = Math.max(
            progressOverrideCurrent,
            taskIndex + 1,
          );
        }
        progressOverridePercent = Math.max(
          progressOverridePercent,
          clampPercent(state.percent, 0),
        );
        progressOverrideAppId = state.appid || progressOverrideAppId;
        progressOverrideItemName = state.itemName || progressOverrideItemName;
        progressOverridePhase = state.phase || progressOverridePhase;
        progressOverrideDetail = state.detail || progressOverrideDetail;
        if (
          result?.created === true ||
          result?.schemaUpdated === true ||
          result?.configUpdated === true
        ) {
          state.phase = "completed";
          state.detail =
            usePhaseOnlyDetails
              ? ""
              : result?.created === true
                ? "Config created"
                : "Config updated";
          state.finalState = "completed";
        } else if (result?.pendingSchema === true) {
          state.phase = "skipped";
          state.detail = "Waiting for schema generation";
          state.finalState = "skipped";
        } else if (result && result.reason) {
          state.phase = result.reason === "blacklisted" ? "skipped" : "skipped";
          state.detail = "Config generation skipped";
          state.finalState = "skipped";
        } else {
          state.phase = "failed";
          state.detail = "Config generation failed";
          state.finalState = "failed";
        }
        const summary = currentState();
        if (!started) {
          if (!shouldRevealProgress(state, state)) return;
          emitStart(summary);
        }
        emit("generation:progress:update", {
          status: "running",
          current: summary.current,
          total: summary.total,
          percent: summary.percent,
          appid: state.appid,
          itemName: state.itemName || state.appid || "",
          phase: state.phase,
          detail: state.detail,
        });
      },
      finish(status = "success", detail = "") {
        if (!started) {
          if (status === "failed") {
            emitStart(currentState(), {
              phase: "failed",
              detail: String(detail || "Config generation failed"),
            });
          } else {
            return;
          }
        }
        const summary = currentState();
        const completedCount = states.filter(
          (entry) => entry.finalState === "completed",
        ).length;
        const failedCount = states.filter(
          (entry) => entry.finalState === "failed",
        ).length;
        const skippedCount = states.filter(
          (entry) => entry.finalState === "skipped",
        ).length;
        let finalStatus = status === "failed" ? "failed" : "success";
        let finalPhase = finalStatus === "failed" ? "failed" : "completed";
        let finalDetail =
          finalStatus === "failed"
            ? "Config generation failed"
            : "Config generation completed";
        let shouldOverrideDetail = false;
        if (finalStatus !== "failed" && completedCount === 0) {
          if (failedCount > 0) {
            finalStatus = "failed";
            finalPhase = "failed";
            finalDetail = "Config generation failed";
            shouldOverrideDetail = true;
          } else if (skippedCount > 0) {
            finalPhase = "skipped";
            finalDetail = "Config generation skipped";
            shouldOverrideDetail = true;
          }
        }
        const outputDetail = shouldOverrideDetail
          ? finalDetail
          : String(detail || finalDetail);
        emit("generation:progress:end", {
          status: finalStatus,
          current: summary.total,
          total: summary.total,
          percent: finalStatus === "failed" ? summary.percent : 100,
          appid: summary.appid,
          itemName:
            String(
              meta?.rootLabel ||
                summary.itemName ||
                meta?.fallbackItemName ||
                "",
            ).trim() || "",
          phase: finalPhase,
          detail:
            usePhaseOnlyDetails
              ? String(detail || "")
              : outputDetail || "",
        });
      },
    };
  }

  async function attachSaveWatchersBatched(
    ids,
    options = {},
    batchSize = BOOT_ATTACH_BATCH,
  ) {
    const list = Array.isArray(ids)
      ? ids
      : ids instanceof Set
        ? Array.from(ids)
        : [];
    if (!list.length) return;
    const size = Math.max(1, Number(batchSize) || 1);
    const yieldIfNeeded = createTimeSlicer(BOOT_ATTACH_SLICE_MS);
    const itemDelayMs =
      (bootMode || options.forceBatchAttach) && BOOT_ATTACH_ITEM_DELAY_MS > 0
        ? BOOT_ATTACH_ITEM_DELAY_MS
        : 0;
    const batchDelayMs = Math.max(
      0,
      Number(options.batchDelayMs ?? BOOT_ATTACH_DELAY_MS) || 0,
    );
    const attachOptions = { ...options };
    if (bootMode && attachOptions.deferInitialSeed == null) {
      attachOptions.deferInitialSeed = true;
    }
    let count = 0;
    for (const id of list) {
      attachSaveWatcherForAppId(id, attachOptions);
      count += 1;
      if (yieldIfNeeded) await yieldIfNeeded();
      if (itemDelayMs) {
        await sleep(itemDelayMs);
      }
      if (count % size === 0 && !itemDelayMs && batchDelayMs) {
        await sleep(batchDelayMs);
      }
    }
  }

  async function startFolderWatchersBatched(folders, options = {}) {
    const list = Array.isArray(folders)
      ? folders
      : folders instanceof Set
        ? Array.from(folders)
        : [];
    if (!list.length) return;
    const { onError, forceBatchAttach, batchDelayMs, ...startOpts } =
      options || {};
    const yieldIfNeeded = createTimeSlicer(BOOT_ATTACH_SLICE_MS);
    const throttleRootStarts =
      bootMode || rescanInProgress.value || forceBatchAttach;
    const itemDelayMs =
      throttleRootStarts && ROOT_WATCH_START_ITEM_DELAY_MS > 0
        ? ROOT_WATCH_START_ITEM_DELAY_MS
        : 0;
    const delayMs = Math.max(
      0,
      Number(batchDelayMs ?? BOOT_ATTACH_DELAY_MS) || 0,
    );
    const rootBatchSize =
      throttleRootStarts && ROOT_WATCH_START_BATCH > 0
        ? ROOT_WATCH_START_BATCH
        : BOOT_ATTACH_BATCH;
    const rootBatchDelayMs = throttleRootStarts
      ? Math.max(ROOT_WATCH_SETTLE_DELAY_MS, delayMs)
      : delayMs;
    let count = 0;
    for (const dir of list) {
      if (yieldIfNeeded) await yieldIfNeeded();
      if (itemDelayMs) {
        await sleep(itemDelayMs);
      } else {
        await sleep(0);
      }
      try {
        startFolderWatcher(dir, startOpts);
      } catch (err) {
        if (typeof onError === "function") onError(err, dir);
      }
      count += 1;
      if (count % rootBatchSize === 0 && rootBatchDelayMs > 0) {
        await sleep(rootBatchDelayMs);
      }
    }
  }

  // --- prefs helpers ---
  function readPrefsSafe() {
    const result = readJsonWithBackupSync(preferencesPath, {
      backup: true,
      fallback: {},
    });
    return result.value && typeof result.value === "object" ? result.value : {};
  }
  function getPreferredSteamOfficialAccountId(sourcePrefs = null) {
    const prefs =
      sourcePrefs && typeof sourcePrefs === "object"
        ? sourcePrefs
        : readPrefsSafe();
    return steamId64ToAccountId(prefs?.steamOfficialSteamId || "");
  }
  function pickConfiguredSteamOfficialUserBin(
    statsDir,
    appid,
    sourcePrefs = null,
  ) {
    return pickPreferredUserBin(
      statsDir,
      appid,
      getPreferredSteamOfficialAccountId(sourcePrefs),
    );
  }
  const LUMAPLAY_WATCHER_PREF_KEY = "lumaPlayWatcherEnabled";
  function isLumaPlayWatcherEnabled() {
    try {
      const prefs = readPrefsSafe();
      return prefs?.[LUMAPLAY_WATCHER_PREF_KEY] === true;
    } catch {
      return false;
    }
  }

  function persistPreferencesPatch(patch = {}) {
    try {
      if (persistPreferences) {
        const next = persistPreferences(patch || {});
        return next && typeof next === "object" ? next : readPrefsSafe();
      }
      const current = readPrefsSafe();
      const merged = { ...current, ...(patch || {}) };
      writeJsonAtomicSync(preferencesPath, merged, { backup: true });
      return merged;
    } catch {
      return readPrefsSafe();
    }
  }

  function readAutoConfigOnboardingState(sourcePrefs = null) {
    const prefs =
      sourcePrefs && typeof sourcePrefs === "object"
        ? sourcePrefs
        : readPrefsSafe();
    const completed =
      prefs?.[AUTOCONFIG_ONBOARDING_COMPLETED_PREF_KEY] === true;
    const storedVersion = Number(
      prefs?.[AUTOCONFIG_ONBOARDING_VERSION_PREF_KEY] || 0,
    );
    const required =
      !completed || storedVersion !== AUTOCONFIG_ONBOARDING_VERSION;
    return {
      required,
      completed,
      version: storedVersion,
      targetVersion: AUTOCONFIG_ONBOARDING_VERSION,
      completedAt:
        Number(prefs?.[AUTOCONFIG_ONBOARDING_COMPLETED_AT_PREF_KEY] || 0) || 0,
    };
  }

  function saveAutoConfigOnboardingCompletion() {
    const now = Date.now();
    const next = persistPreferencesPatch({
      [AUTOCONFIG_ONBOARDING_COMPLETED_PREF_KEY]: true,
      [AUTOCONFIG_ONBOARDING_VERSION_PREF_KEY]: AUTOCONFIG_ONBOARDING_VERSION,
      [AUTOCONFIG_ONBOARDING_COMPLETED_AT_PREF_KEY]: now,
    });
    bootOnboardingDecisionAt = now;
    return readAutoConfigOnboardingState(next);
  }

  function emitBootOnboardingError(stage, error, extra = {}) {
    const message =
      (error && (error.message || String(error))) || "boot onboarding error";
    watcherLogger.warn("boot:onboarding:error", {
      stage,
      message,
      ...extra,
    });
    try {
      broadcastAll("boot:onboarding:error", {
        stage: String(stage || "unknown"),
        message,
        ...extra,
      });
    } catch {}
  }

  function emitBootOnboardingAttention(extra = {}) {
    if (bootOnboardingGateOpen) return;
    const waitedMs =
      bootOnboardingStartedAt > 0
        ? Math.max(0, Date.now() - bootOnboardingStartedAt)
        : 0;
    watcherLogger.info("boot:onboarding:attention", {
      waitedMs,
      ...extra,
    });
    try {
      broadcastAll("boot:onboarding:attention", {
        waitedMs,
        startedAt: bootOnboardingStartedAt || 0,
        ...extra,
      });
    } catch {}
  }

  function stopBootOnboardingAttentionLoop() {
    if (!bootOnboardingAttentionTimer) return;
    clearInterval(bootOnboardingAttentionTimer);
    bootOnboardingAttentionTimer = null;
  }

  function startBootOnboardingAttentionLoop() {
    if (bootOnboardingAttentionTimer) return;
    emitBootOnboardingAttention({ immediate: true });
    bootOnboardingAttentionTimer = setInterval(() => {
      if (bootOnboardingGateOpen) {
        stopBootOnboardingAttentionLoop();
        return;
      }
      emitBootOnboardingAttention({ reminder: true });
    }, AUTOCONFIG_ONBOARDING_ATTENTION_INTERVAL_MS);
  }

  function markBootOnboardingDirtyRoot(rootPath, source = "unknown") {
    if (!rootPath || bootOnboardingGateOpen) return;
    let normalized = "";
    try {
      normalized = normalizeRoot(rootPath);
    } catch {
      normalized = "";
    }
    if (!normalized) return;
    const before = bootOnboardingDirtyRoots.size;
    bootOnboardingDirtyRoots.add(normalized);
    if (bootOnboardingDirtyRoots.size !== before) {
      watcherLogger.info("boot:onboarding:dirty-root", {
        root: normalized,
        source,
      });
    }
  }

  async function flushBootOnboardingDirtyRoots(options = {}) {
    if (!bootOnboardingGateOpen) {
      return {
        ok: false,
        blocked: true,
        pending: bootOnboardingDirtyRoots.size,
      };
    }
    if (bootOnboardingDirtyRescanRunning) {
      return {
        ok: true,
        running: true,
        pending: bootOnboardingDirtyRoots.size,
      };
    }
    const roots = Array.from(bootOnboardingDirtyRoots).filter(Boolean);
    if (!roots.length) {
      return { ok: true, scannedRoots: 0 };
    }
    bootOnboardingDirtyRoots = new Set();
    bootOnboardingDirtyRescanRunning = true;
    const reason = String(options?.reason || "gate-open");
    let scannedRoots = 0;
    watcherLogger.info("boot:onboarding:dirty-rescan-start", {
      roots: roots.length,
      reason,
    });
    try {
      for (const root of roots) {
        if (!root) continue;
        try {
          if (!fs.existsSync(root)) continue;
        } catch {
          continue;
        }
        try {
          await scanRootOnce(root, { suppressInitialNotify: true });
          scannedRoots += 1;
        } catch (err) {
          watcherLogger.warn("boot:onboarding:dirty-root-scan-failed", {
            root,
            error: err?.message || String(err),
          });
        }
      }
      try {
        await rebuildSaveWatchers({ suppressInitialNotify: true });
      } catch {}
      try {
        emitDashboardRefresh();
      } catch {}
      watcherLogger.info("boot:onboarding:dirty-rescan-complete", {
        roots: roots.length,
        scannedRoots,
        reason,
      });
      return {
        ok: true,
        scannedRoots,
      };
    } finally {
      bootOnboardingDirtyRescanRunning = false;
      if (bootOnboardingDirtyRoots.size && bootOnboardingGateOpen) {
        setTimeout(() => {
          flushBootOnboardingDirtyRoots({ reason: "post-rescan-drain" }).catch(
            () => {},
          );
        }, 0);
      }
    }
  }

  function normalizeOnboardingCandidateRoots(discovered = []) {
    return new Set(
      (Array.isArray(discovered) ? discovered : [])
        .map((entry) => normalizePrefPath(entry?.path))
        .filter(Boolean),
    );
  }

  function normalizeOnboardingSelection(selectedPaths = [], candidateRoots) {
    const candidates =
      candidateRoots instanceof Set ? candidateRoots : new Set();
    return new Set(
      (Array.isArray(selectedPaths) ? selectedPaths : [])
        .map((entry) => normalizePrefPath(entry))
        .filter((entry) => candidates.has(entry)),
    );
  }

  async function applyBootOnboardingDecision(options = {}) {
    const {
      discovered = [],
      selectedPaths = [],
      reason = "apply-selection",
      muteAllDefaultRoots = false,
    } = options || {};
    const candidateRoots = normalizeOnboardingCandidateRoots(discovered);
    if (muteAllDefaultRoots) {
      for (const root of DEFAULT_WATCH_ROOTS) {
        const normalized = normalizePrefPath(root);
        if (normalized) candidateRoots.add(normalized);
      }
    }
    const selectedSet = normalizeOnboardingSelection(
      selectedPaths,
      candidateRoots,
    );
    const blocked = getBlockedFoldersSet();
    for (const root of candidateRoots) {
      if (selectedSet.has(root)) blocked.delete(root);
      else blocked.add(root);
    }
    saveBlockedFolders([...blocked]);
    const watcherState = await syncFolderWatchersWithCurrentPrefs();
    const savedState = saveAutoConfigOnboardingCompletion();
    bootOnboardingRequired = false;
    openBootOnboardingGate({ reason });
    const response = {
      ok: true,
      selectedCount: selectedSet.size,
      mutedCount: Math.max(0, candidateRoots.size - selectedSet.size),
      restartedWatchers: watcherState.running,
      required: savedState.required,
      completed: savedState.completed,
      reason,
    };
    try {
      broadcastAll("boot:onboarding:done", response);
    } catch {}
    return response;
  }

  function closeBootOnboardingGate() {
    if (!bootOnboardingGateOpen) return;
    bootOnboardingGateOpen = false;
    bootOnboardingStartedAt = Date.now();
    bootOnboardingDirtyRoots = new Set();
    bootOnboardingGatePromise = new Promise((resolve) => {
      bootOnboardingGateResolve = resolve;
    });
    try {
      global.bootOnboardingGateOpen = false;
      global.bootOnboardingRequired = true;
      global.bootOnboardingStartedAt = bootOnboardingStartedAt;
      global.bootOnboardingDecisionAt = 0;
    } catch {}
    startBootOnboardingAttentionLoop();
  }

  function openBootOnboardingGate(meta = {}) {
    stopBootOnboardingAttentionLoop();
    if (!bootOnboardingGateOpen) {
      bootOnboardingGateOpen = true;
      bootOnboardingDecisionAt = Date.now();
      const resolver = bootOnboardingGateResolve;
      bootOnboardingGateResolve = null;
      if (typeof resolver === "function") {
        try {
          resolver();
        } catch {}
      }
      bootOnboardingGatePromise = Promise.resolve();
      watcherLogger.info("boot:onboarding:gate-open", {
        decisionMs:
          bootOnboardingStartedAt > 0
            ? Math.max(0, bootOnboardingDecisionAt - bootOnboardingStartedAt)
            : 0,
        reason: meta?.reason || "completed",
      });
    }
    flushBootOnboardingDirtyRoots({
      reason: meta?.reason || "gate-open",
    }).catch(() => {});
    try {
      global.bootOnboardingGateOpen = true;
      global.bootOnboardingRequired = false;
      global.bootOnboardingDecisionAt = bootOnboardingDecisionAt || Date.now();
    } catch {}
  }

  async function waitForBootOnboardingGateOpen() {
    if (bootOnboardingGateOpen) return;
    watcherLogger.info("boot:onboarding:gate-wait", {
      startedAt: bootOnboardingStartedAt || Date.now(),
    });
    try {
      await bootOnboardingGatePromise;
    } catch {}
  }

  function isBootOnboardingPending() {
    return bootOnboardingGateOpen === false;
  }

  async function forceBootOnboardingSkipAll(reason = "manual-skip-all") {
    if (!isBootOnboardingPending()) {
      return {
        ok: true,
        alreadyOpen: true,
        required: bootOnboardingRequired,
        completed: bootOnboardingRequired !== true,
        reason: "already-open",
      };
    }
    try {
      const discovered = await discoverOnboardingFolders({ force: true });
      return await applyBootOnboardingDecision({
        discovered,
        selectedPaths: [],
        reason: String(reason || "manual-skip-all"),
        muteAllDefaultRoots: true,
      });
    } catch (err) {
      emitBootOnboardingError("force-skip-all", err, {
        recoverable: true,
        reason: String(reason || "manual-skip-all"),
      });
      return {
        ok: false,
        mutedCount: 0,
        restartedWatchers: folderWatchers.size,
        reason: String(reason || "manual-skip-all"),
        error: err?.message || String(err),
      };
    }
  }

  const ONBOARDING_SIGNAL_RULES = [
    { id: "achievements-json", weight: 8 },
    { id: "achievements-ini", weight: 6 },
    { id: "stats-bin", weight: 6 },
    { id: "user-stats-ini", weight: 6 },
    { id: "xenia-gpd", weight: 5 },
    { id: "rpcs3-trophy", weight: 5 },
    { id: "ps4-trophy", weight: 5 },
    { id: "steam-official-bin", weight: 7 },
    { id: "tenoke-ini", weight: 4 },
    { id: "gog-info", weight: 4 },
  ];
  const ONBOARDING_SIGNAL_WEIGHT_MAP = new Map(
    ONBOARDING_SIGNAL_RULES.map((rule) => [rule.id, rule.weight]),
  );

  function getOnboardingSignalIds(fileName) {
    const base = String(fileName || "").toLowerCase();
    const out = [];
    if (base === "achievements.json") out.push("achievements-json");
    if (base === "achievements.ini") out.push("achievements-ini");
    if (base === "stats.ini") out.push("online-fix-stats-ini");
    if (base === "stats.bin") out.push("stats-bin");
    if (base === "user_stats.ini") out.push("user-stats-ini");
    if (base.endsWith(".gpd")) out.push("xenia-gpd");
    if (base === "tropusr.dat" || base === "tropconf.sfm") {
      out.push("rpcs3-trophy");
    }
    if (base === "trop.xml") out.push("ps4-trophy");
    if (/^usergamestatsschema_\d+\.bin$/i.test(base)) {
      out.push("steam-official-bin");
    }
    if (base === "tenoke.ini") out.push("tenoke-ini");
    if (base.endsWith(".info")) out.push("gog-info");
    return out;
  }

  function shouldSkipOnboardingScanDir(name) {
    const value = String(name || "").toLowerCase();
    if (!value) return true;
    if (value === "." || value === "..") return true;
    if (value === "$recycle.bin") return true;
    if (value === "system volume information") return true;
    if (value === "windows") return true;
    if (value === "program files" || value === "program files (x86)")
      return true;
    return false;
  }

  function buildOnboardingCandidate(entry, signalsMap) {
    const sortedSignals = Array.from(signalsMap.entries())
      .sort((a, b) => {
        const aw = ONBOARDING_SIGNAL_WEIGHT_MAP.get(a[0]) || 0;
        const bw = ONBOARDING_SIGNAL_WEIGHT_MAP.get(b[0]) || 0;
        if (bw !== aw) return bw - aw;
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .map(([id]) => id);
    const score = sortedSignals.reduce(
      (sum, id) => sum + (ONBOARDING_SIGNAL_WEIGHT_MAP.get(id) || 0),
      0,
    );
    return {
      path: entry.path,
      exists: entry.exists !== false,
      source: entry.isDefault ? "default" : "user",
      blocked: entry.blocked === true,
      signals: sortedSignals,
      score,
      recommended: score >= 6,
    };
  }

  async function scanFolderSignalsForOnboarding(rootPath) {
    const seenSignals = new Map();
    const blockedFolders = getBlockedFoldersSet();
    if (isPathBlocked(rootPath, blockedFolders)) return seenSignals;
    const queue = [{ dir: rootPath, depth: 0 }];
    let scannedDirs = 0;
    while (queue.length) {
      const current = queue.shift();
      if (!current?.dir) continue;
      scannedDirs += 1;
      if (scannedDirs > AUTOCONFIG_ONBOARDING_DISCOVERY_MAX_DIRS) break;
      let entries = [];
      try {
        entries = await fsp.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent) continue;
        if (ent.isFile()) {
          const ids = getOnboardingSignalIds(ent.name);
          if (ids.length) {
            for (const id of ids) {
              seenSignals.set(id, (seenSignals.get(id) || 0) + 1);
            }
            if (seenSignals.size >= 3 && current.depth <= 2) {
              continue;
            }
          }
          continue;
        }
        if (!ent.isDirectory()) continue;
        if (current.depth >= AUTOCONFIG_ONBOARDING_DISCOVERY_MAX_DEPTH)
          continue;
        if (shouldSkipOnboardingScanDir(ent.name)) continue;
        const candidatePath = path.join(current.dir, ent.name);
        if (isPathBlocked(candidatePath, blockedFolders)) continue;
        queue.push({
          dir: candidatePath,
          depth: current.depth + 1,
        });
      }
    }
    return seenSignals;
  }

  async function discoverOnboardingFolders(options = {}) {
    const force = options.force === true;
    const now = Date.now();
    if (
      !force &&
      bootOnboardingDiscoveryCache.at > 0 &&
      now - bootOnboardingDiscoveryCache.at <
        AUTOCONFIG_ONBOARDING_DISCOVERY_CACHE_MS
    ) {
      return bootOnboardingDiscoveryCache.candidates;
    }
    const entries = collectWatchedFolderEntries().filter(
      (entry) => entry?.path && entry.exists !== false,
    );
    const candidates = [];
    for (const entry of entries) {
      const signals = await scanFolderSignalsForOnboarding(entry.path);
      candidates.push(buildOnboardingCandidate(entry, signals));
    }
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.path || "").localeCompare(String(b.path || ""));
    });
    bootOnboardingDiscoveryCache = {
      at: Date.now(),
      candidates,
    };
    return candidates;
  }

  function collectWatchedFolderEntries() {
    const prefs = readPrefsSafe();
    const userFolders = Array.isArray(prefs.watchedFolders)
      ? prefs.watchedFolders
      : [];
    const userBlockedFolders = Array.isArray(prefs.blockedWatchedFolders)
      ? prefs.blockedWatchedFolders
      : [];
    const blocked = getBlockedFoldersSet();

    const seen = new Map();
    [
      ...DEFAULT_WATCH_ROOTS,
      ...userFolders,
      ...userBlockedFolders
        .map(normalizePrefPath)
        .filter((dir) => dir && !DEFAULT_BLOCKED_SET.has(dir)),
    ]
      .filter(Boolean)
      .forEach((dir) => {
        const real = normalizePrefPath(dir);
        if (!real || seen.has(real)) return;
        const exists = (() => {
          try {
            return fs.existsSync(real);
          } catch {
            return false;
          }
        })();
        seen.set(real, {
          path: real,
          blocked: isPathBlocked(real, blocked),
          exists,
          isDefault: DEFAULT_WATCH_SET.has(real),
        });
      });
    return Array.from(seen.values());
  }

  function updateMissingRoots(entries) {
    missingRoots.clear();
    for (const entry of entries || []) {
      if (!entry?.path || entry.blocked || entry.exists) continue;
      missingRoots.add(entry.path);
    }
    if (missingRoots.size) startMissingRootPoller();
    else stopMissingRootPoller();
  }

  function getWatchedFolders(options = {}) {
    const { includeMeta = false } = options;
    const collect = collectWatchedFolderEntries();
    updateMissingRoots(collect);

    if (includeMeta) return collect;
    return collect
      .filter((entry) => entry.exists && !entry.blocked)
      .map((entry) => entry.path);
  }

  function saveWatchedFolders(list) {
    try {
      const norm = (p) => {
        try {
          p = fs.realpathSync(p);
        } catch {}
        return p;
      };
      const uniq = Array.from(new Set((list || []).filter(Boolean).map(norm)));
      if (persistPreferences) {
        const prefs = persistPreferences({ watchedFolders: uniq });
        const stored = Array.isArray(prefs?.watchedFolders)
          ? prefs.watchedFolders
          : uniq;
        return stored;
      }
      const cur = readPrefsSafe();
      writeJsonAtomicSync(
        preferencesPath,
        { ...cur, watchedFolders: uniq },
        { backup: true },
      );
      return uniq;
    } catch (e) {
      console.error("[folders] persist failed:", e.message);
      return list || [];
    }
  }

  function getUserWatchedFoldersRaw() {
    const prefs = readPrefsSafe();
    return Array.isArray(prefs.watchedFolders) ? prefs.watchedFolders : [];
  }

  function replaceWatchedFolder(oldPath, newPath) {
    const oldNorm = normalizePrefPath(oldPath);
    const newNorm = normalizePrefPath(newPath);
    if (!oldNorm || !newNorm) return false;
    const current = getUserWatchedFoldersRaw().map(normalizePrefPath);
    if (!current.includes(oldNorm)) return false;
    const next = Array.from(
      new Set(
        current.map((p) => (p === oldNorm ? newNorm : p)).filter(Boolean),
      ),
    );
    try {
      if (persistPreferences) {
        persistPreferences({ watchedFolders: next });
      } else {
        const prefs = readPrefsSafe();
        writeJsonAtomicSync(
          preferencesPath,
          { ...prefs, watchedFolders: next },
          { backup: true },
        );
      }
      stopFolderWatcher(oldNorm);
      startFolderWatcher(newNorm, { initialScan: false });
      return true;
    } catch {
      return false;
    }
  }

  const BLACKLIST_PREF_KEY = "blacklistedAppIds";
  const BLACKLIST_CONFIG_PREF_KEY = "blacklistedConfigKeys";

  function getBlacklistedAppIdsSet() {
    try {
      const prefs = readPrefsSafe();
      const arr = Array.isArray(prefs[BLACKLIST_PREF_KEY])
        ? prefs[BLACKLIST_PREF_KEY]
        : [];
      return new Set(arr.map(normalizeAppIdValue).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  function getBlacklistState() {
    try {
      const prefs = readPrefsSafe();
      const appIds = Array.isArray(prefs[BLACKLIST_PREF_KEY])
        ? prefs[BLACKLIST_PREF_KEY]
        : [];
      const configKeys = Array.isArray(prefs[BLACKLIST_CONFIG_PREF_KEY])
        ? prefs[BLACKLIST_CONFIG_PREF_KEY]
        : [];
      return {
        appIds: new Set(appIds.map(normalizeAppIdValue).filter(Boolean)),
        configKeys: new Set(
          configKeys.map(normalizeBlacklistConfigKey).filter(Boolean),
        ),
      };
    } catch {
      return { appIds: new Set(), configKeys: new Set() };
    }
  }

  function isAppIdBlacklisted(appid, platform = null, currentState = null) {
    const normalized = normalizeAppIdValue(appid);
    if (!normalized) return false;
    const state = currentState || getBlacklistState();
    if (state?.appIds?.has(normalized)) return true;
    if (!String(platform || "").trim()) return false;
    const configKey = buildBlacklistConfigKey(normalized, platform);
    return configKey ? state?.configKeys?.has(configKey) === true : false;
  }

  const normalizePrefPath = (p) => {
    if (!p) return "";
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(String(p));
    }
  };

  function stopMissingRootPoller() {
    if (!missingRootTimer) return;
    clearInterval(missingRootTimer);
    missingRootTimer = null;
  }

  function startMissingRootPoller() {
    if (missingRootTimer) return;
    missingRootTimer = setInterval(() => {
      try {
        pollMissingRoots();
      } catch {}
    }, 4000);
  }

  function markMissingRoot(root) {
    const normalized = normalizePrefPath(root);
    if (!normalized) return;
    const blocked = getBlockedFoldersSet();
    if (isPathBlocked(normalized, blocked)) return;
    missingRoots.add(normalized);
    startMissingRootPoller();
  }

  function pollMissingRoots() {
    const entries = collectWatchedFolderEntries();
    const nextMissing = new Set();
    const newlyAvailable = [];

    for (const entry of entries) {
      if (!entry?.path || entry.blocked) continue;
      if (!entry.exists) {
        nextMissing.add(entry.path);
      } else if (missingRoots.has(entry.path)) {
        newlyAvailable.push(entry.path);
      }
    }

    missingRoots.clear();
    for (const p of nextMissing) missingRoots.add(p);

    if (!missingRoots.size) stopMissingRootPoller();

    for (const root of newlyAvailable) {
      try {
        startFolderWatcher(root, { initialScan: false });
      } catch {}
      try {
        scanRootOnce(root, { suppressInitialNotify: true });
      } catch {}
    }
  }

  function escapeRegex(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const normalizeObservedPath = (p, appid = "") => {
    if (!p || typeof p !== "string") return "";
    let resolved = "";
    try {
      resolved = fs.realpathSync(p);
    } catch {
      try {
        resolved = path.resolve(p);
      } catch {
        resolved = "";
      }
    }
    if (!resolved) return "";
    const unify = resolved.replace(/[\\/]+/g, path.sep);
    const sepPattern = "(?:\\\\|\\/)";
    const suffixes = [];
    const escapedId = escapeRegex(appid);
    if (appid) {
      suffixes.push(
        new RegExp(`${sepPattern}remote${sepPattern}${escapedId}$`, "i"),
      );
      suffixes.push(
        new RegExp(
          `${sepPattern}steam_settings${sepPattern}${escapedId}$`,
          "i",
        ),
      );
      suffixes.push(new RegExp(`${sepPattern}${escapedId}$`, "i"));
    }
    suffixes.push(new RegExp(`${sepPattern}remote$`, "i"));
    suffixes.push(new RegExp(`${sepPattern}steam_settings$`, "i"));
    let trimmed = unify;
    for (const rx of suffixes) {
      if (rx.test(trimmed)) {
        trimmed = trimmed.replace(rx, "");
        break;
      }
    }
    return trimmed.replace(new RegExp(`${sepPattern}$`), "");
  };

  function normalizeEmuValue(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isXeniaMeta(meta) {
    return normalizePlatform(meta?.platform) === "xenia";
  }

  function getExpectedXeniaGpdBaseName(meta, appid) {
    const id = String(meta?.appid || appid || "").trim().toLowerCase();
    return id ? `${id}.gpd` : "";
  }

  function isExpectedXeniaGpdFile(meta, appid, filePath) {
    if (!filePath) return false;
    const base = path.basename(filePath).toLowerCase();
    if (!base.endsWith(".gpd")) return false;
    const expected = getExpectedXeniaGpdBaseName(meta, appid);
    return expected ? base === expected : true;
  }

  function isRpcs3Meta(meta) {
    return normalizePlatform(meta?.platform) === "rpcs3";
  }
  function isSteamOfficialMeta(meta) {
    return normalizePlatform(meta?.platform) === "steam-official";
  }

  function isGogOfficialMeta(meta) {
    return normalizePlatform(meta?.platform) === "gog-official";
  }

  function isUbisoftOfficialMeta(meta) {
    return normalizePlatform(meta?.platform) === "ubisoft-official";
  }

  function isEaOfficialMeta(meta) {
    return normalizePlatform(meta?.platform) === "ea-official";
  }

  function isPs4Meta(meta) {
    return normalizePlatform(meta?.platform) === "shadps4";
  }

  function isLumaPlayMeta(meta) {
    return (
      normalizePlatform(meta?.platform) === "uplay" &&
      normalizeEmuValue(meta?.emu) === "lumaplay"
    );
  }

  function resolveGogGalaxyApplicationsRoots(rootPath) {
    const out = [];
    const seen = new Set();
    const push = (candidate) => {
      if (!candidate) return;
      let resolved = "";
      try {
        resolved = fs.realpathSync(candidate);
      } catch {
        try {
          resolved = path.resolve(candidate);
        } catch {
          resolved = "";
        }
      }
      if (!resolved) return;
      const key = resolved.toLowerCase();
      if (seen.has(key)) return;
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return;
        }
      } catch {
        return;
      }
      seen.add(key);
      out.push(resolved);
    };

    let cursor = "";
    try {
      cursor = fs.realpathSync(rootPath);
    } catch {
      try {
        cursor = path.resolve(String(rootPath || ""));
      } catch {
        cursor = "";
      }
    }
    while (cursor) {
      const base = path.basename(cursor).toLowerCase();
      const parent = path.dirname(cursor);
      const parentBase = path.basename(parent).toLowerCase();
      const grandParent = path.dirname(parent);
      const grandParentBase = path.basename(grandParent).toLowerCase();

      if (
        base === "applications" &&
        parentBase === "galaxy" &&
        grandParentBase === "gog.com"
      ) {
        push(cursor);
      }
      if (base === "galaxy" && parentBase === "gog.com") {
        push(path.join(cursor, "Applications"));
      }

      if (!parent || parent === cursor) break;
      cursor = parent;
    }

    return out;
  }

  function resolveGogOfficialApplicationsEvent(rootPath, targetPath) {
    if (!targetPath) return null;
    const applicationsRoots = resolveGogGalaxyApplicationsRoots(rootPath);
    if (!applicationsRoots.length) return null;

    let resolvedTarget = "";
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      try {
        resolvedTarget = path.resolve(String(targetPath || ""));
      } catch {
        resolvedTarget = "";
      }
    }
    if (!resolvedTarget) return null;

    for (const applicationsRoot of applicationsRoots) {
      let relative = "";
      try {
        relative = path.relative(applicationsRoot, resolvedTarget);
      } catch {
        relative = "";
      }
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      return {
        applicationsRoot,
        targetPath: resolvedTarget,
        relativeSegments: relative.split(/[\\/]+/).filter(Boolean),
      };
    }

    return null;
  }

  function resolveUbisoftOfficialSpoolEvent(rootPath, targetPath) {
    if (!targetPath) return null;
    const spoolRoots = resolveUbisoftSpoolRoots(rootPath);
    if (!spoolRoots.length) return null;

    let resolvedTarget = "";
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      try {
        resolvedTarget = path.resolve(String(targetPath || ""));
      } catch {
        resolvedTarget = "";
      }
    }
    if (!resolvedTarget) return null;

    for (const spoolRoot of spoolRoots) {
      let relative = "";
      try {
        relative = path.relative(spoolRoot, resolvedTarget);
      } catch {
        relative = "";
      }
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      return {
        spoolRoot,
        targetPath: resolvedTarget,
        relativeSegments: relative.split(/[\\/]+/).filter(Boolean),
      };
    }

    return null;
  }

  function resolveEaOfficialLogsEvent(rootPath, targetPath) {
    if (!targetPath) return null;
    const logsRoots = resolveEaOfficialLogsRoots(rootPath);
    if (!logsRoots.length) return null;

    let resolvedTarget = "";
    try {
      resolvedTarget = fs.realpathSync(targetPath);
    } catch {
      try {
        resolvedTarget = path.resolve(String(targetPath || ""));
      } catch {
        resolvedTarget = "";
      }
    }
    if (!resolvedTarget) return null;

    for (const logsRoot of logsRoots) {
      let relative = "";
      try {
        relative = path.relative(logsRoot, resolvedTarget);
      } catch {
        relative = "";
      }
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      return {
        logsRoot,
        targetPath: resolvedTarget,
        relativeSegments: relative.split(/[\\/]+/).filter(Boolean),
      };
    }

    return null;
  }

  async function handleEaOfficialRootFileEvent(rootPath, filePath) {
    const event = resolveEaOfficialLogsEvent(rootPath, filePath);
    if (!event) return false;

    const baseName = path.basename(event.targetPath).toLowerCase();
    if (baseName !== EA_VERBOSE_LOG_NAME.toLowerCase()) {
      return true;
    }

    let entries = [];
    try {
      entries = listEaOfficialAchievementSets(event.logsRoot);
    } catch (err) {
      watcherLogger.warn("ea-official:live-scan-failed", {
        root: event.logsRoot,
        file: event.targetPath,
        error: err?.message || String(err),
      });
      return true;
    }

    const missingEntry = entries.find((entry) => {
      const appid = String(entry?.appid || "").trim();
      return appid && !hasPlatformVariant(appid, "ea-official");
    });
    if (!missingEntry) return true;

    watcherLogger.info("ea-official:live-discovery", {
      root: event.logsRoot,
      appid: missingEntry.appid,
      achievementSet: missingEntry.achievementSet || null,
      gameName: missingEntry.gameName || null,
      logFilePath: missingEntry.logFilePath || event.targetPath,
    });

    try {
      await scanRootOnce(event.logsRoot, {
        suppressInitialNotify: true,
        promoteInitialNotifyAppIds: [missingEntry.appid],
      });
    } catch (err) {
      watcherLogger.warn("ea-official:live-discovery-failed", {
        root: event.logsRoot,
        appid: missingEntry.appid,
        error: err?.message || String(err),
      });
    }

    return true;
  }

  async function handleUbisoftOfficialRootFileEvent(rootPath, filePath) {
    const event = resolveUbisoftOfficialSpoolEvent(rootPath, filePath);
    if (!event) return false;

    const baseName = path.basename(event.targetPath).toLowerCase();
    if (!baseName.endsWith(".spool")) {
      return true;
    }

    const rel = event.relativeSegments;
    if (rel.length !== 2 || !/^\d+\.spool$/i.test(String(rel[1] || ""))) {
      return true;
    }

    const appid = String(path.basename(baseName, ".spool") || "").trim();
    if (!appid || hasPlatformVariant(appid, "ubisoft-official")) {
      return true;
    }

    watcherLogger.info("ubisoft-official:live-discovery", {
      root: event.spoolRoot,
      appid,
      userId: rel[0] || null,
      spoolFilePath: event.targetPath,
    });

    try {
      await scanRootOnce(event.spoolRoot, {
        suppressInitialNotify: true,
        promoteInitialNotifyAppIds: [appid],
      });
    } catch (err) {
      watcherLogger.warn("ubisoft-official:live-discovery-failed", {
        root: event.spoolRoot,
        appid,
        error: err?.message || String(err),
      });
    }

    return true;
  }

  function handleUbisoftOfficialRootDirEvent(rootPath, dirPath, scheduleScan) {
    const event = resolveUbisoftOfficialSpoolEvent(rootPath, dirPath);
    if (!event) return false;

    const rel = event.relativeSegments;
    const userId =
      rel.length && /^[0-9a-f-]+$/i.test(String(rel[0] || ""))
        ? String(rel[0] || "")
        : "";
    const shouldSchedule = !rel.length || (rel.length === 1 && !!userId);

    watcherLogger.info("ubisoft-official:root-dir-discovered", {
      root: event.spoolRoot,
      userId: userId || null,
      relativePath: rel.join(path.sep),
      scheduled: shouldSchedule,
    });

    if (shouldSchedule && typeof scheduleScan === "function") {
      scheduleScan();
    }
    return true;
  }

  async function handleGogOfficialRootFileEvent(rootPath, filePath) {
    const event = resolveGogOfficialApplicationsEvent(rootPath, filePath);
    if (!event) return false;

    const baseName = path.basename(event.targetPath).toLowerCase();
    if (baseName !== GAMEPLAY_DB_NAME) {
      return true;
    }

    const rel = event.relativeSegments;
    if (
      rel.length !== 4 ||
      String(rel[1] || "").toLowerCase() !== "gameplay" ||
      String(rel[3] || "").toLowerCase() !== GAMEPLAY_DB_NAME
    ) {
      return true;
    }

    let gameplayEntries = [];
    try {
      gameplayEntries = listGogOfficialGameplayEntries(event.applicationsRoot);
    } catch (err) {
      watcherLogger.warn("gog-official:live-scan-failed", {
        root: event.applicationsRoot,
        file: event.targetPath,
        error: err?.message || String(err),
      });
      return true;
    }

    const normalizedTarget = path.normalize(event.targetPath).toLowerCase();
    const matchedEntry = gameplayEntries.find((entry) => {
      const candidate = String(entry?.gameplayDbPath || "").trim();
      return (
        candidate &&
        path.normalize(candidate).toLowerCase() === normalizedTarget
      );
    });
    if (!matchedEntry) {
      return true;
    }

    const productId = String(matchedEntry.productId || "").trim();
    if (!productId || hasPlatformVariant(productId, "gog-official")) {
      return true;
    }

    watcherLogger.info("gog-official:live-discovery", {
      root: event.applicationsRoot,
      productId,
      clientId: matchedEntry.clientId || null,
      userId: matchedEntry.userId || null,
      gameplayDbPath: matchedEntry.gameplayDbPath || event.targetPath,
    });

    try {
      await scanRootOnce(event.applicationsRoot, {
        suppressInitialNotify: true,
        promoteInitialNotifyAppIds: [productId],
      });
    } catch (err) {
      watcherLogger.warn("gog-official:live-discovery-failed", {
        root: event.applicationsRoot,
        productId,
        error: err?.message || String(err),
      });
    }

    return true;
  }

  function handleGogOfficialRootDirEvent(rootPath, dirPath, scheduleScan) {
    const event = resolveGogOfficialApplicationsEvent(rootPath, dirPath);
    if (!event) return false;

    const rel = event.relativeSegments;
    const clientId =
      rel.length && /^[0-9]+$/.test(String(rel[0] || "")) ? String(rel[0]) : "";
    if (!clientId) {
      return true;
    }

    const product = resolveGogGalaxyProductByClientId(clientId);
    const productId = String(product?.productId || "").trim();
    const hasOfficialVariant =
      productId && hasPlatformVariant(productId, "gog-official");
    const secondSegment = String(rel[1] || "").toLowerCase();
    const shouldSchedule =
      !hasOfficialVariant &&
      (rel.length === 1 ||
        secondSegment === "gameplay" ||
        secondSegment === "storage");

    watcherLogger.info("gog-official:root-dir-discovered", {
      root: event.applicationsRoot,
      clientId,
      productId: productId || null,
      title: product?.title || null,
      relativePath: rel.join(path.sep),
      hasOfficialVariant,
      scheduled: shouldSchedule,
    });

    if (shouldSchedule && typeof scheduleScan === "function") {
      scheduleScan();
    }
    return true;
  }

  function parseSteamOfficialBinInfo(filePath) {
    if (!filePath) return null;
    const base = path.basename(filePath);
    const schemaMatch = base.match(/^UserGameStatsSchema_(\d+)\.bin$/i);
    if (schemaMatch) {
      const appid = schemaMatch[1];
      return {
        appid,
        kind: "schema",
        statsDir: path.dirname(filePath),
        schemaBinPath: filePath,
        userBinPath: null,
      };
    }
    const userMatch = base.match(/^UserGameStats_(\d+)_(\d+)\.bin$/i);
    if (userMatch) {
      const accountId = userMatch[1];
      const appid = userMatch[2];
      return {
        appid,
        accountId,
        kind: "user",
        statsDir: path.dirname(filePath),
        schemaBinPath: path.join(
          path.dirname(filePath),
          `UserGameStatsSchema_${appid}.bin`,
        ),
        userBinPath: filePath,
      };
    }
    return null;
  }

  function getSteamOfficialMetaByAppId(appid) {
    const metas = getConfigMetas(appid);
    return metas.find((meta) => isSteamOfficialMeta(meta)) || null;
  }

  function hasSteamOfficialSchema(appid) {
    const meta = getSteamOfficialMetaByAppId(appid);
    if (meta) {
      const schemaPath = resolveAchievementsSchemaPath(meta);
      if (schemaPath && fs.existsSync(schemaPath)) return true;
    }
    const fallback = path.join(
      configsDir,
      "schema",
      "steam-official",
      String(appid),
      "achievements.json",
    );
    return fs.existsSync(fallback);
  }

  function shouldSkipSteamOfficialGeneration(appid) {
    const meta = getSteamOfficialMetaByAppId(appid);
    return !!meta && hasSteamOfficialSchema(appid);
  }

  function resolveGpdPathForMeta(meta) {
    if (!meta) return "";
    const direct = typeof meta.gpd_path === "string" ? meta.gpd_path : "";
    const expectedBase = getExpectedXeniaGpdBaseName(meta);
    if (
      direct &&
      fs.existsSync(direct) &&
      (!expectedBase || path.basename(direct).toLowerCase() === expectedBase)
    ) {
      return direct;
    }
    const base = meta.save_path || "";
    const appid = String(meta.appid || "").trim();
    if (base && appid) {
      const candidate = path.join(base, `${appid}.gpd`);
      if (fs.existsSync(candidate)) return candidate;
      try {
        const files = fs.readdirSync(base);
        const found = files.find(
          (f) => f.toLowerCase() === `${appid.toLowerCase()}.gpd`,
        );
        if (found) return path.join(base, found);
      } catch {}
    }
    if (base && !appid) {
      try {
        const files = fs.readdirSync(base);
        const found = files.find((f) => f.toLowerCase().endsWith(".gpd"));
        if (found) return path.join(base, found);
      } catch {}
    }
    return base && appid ? path.join(base, `${appid}.gpd`) : "";
  }

  function resolveRpcs3TrophyDirForMeta(meta) {
    if (!meta) return "";
    const direct =
      typeof meta.trophy_path === "string"
        ? meta.trophy_path
        : typeof meta.trophy_dir === "string"
          ? meta.trophy_dir
          : "";
    if (direct && fs.existsSync(direct)) return direct;
    const base = meta.save_path || "";
    if (base && fs.existsSync(base)) return base;
    return direct || base || "";
  }

  function resolvePs4TrophyDirForMeta(meta) {
    if (!meta) return "";
    const npcommid = String(meta.shadps4_npcommid || "").trim();
    if (npcommid) {
      const modernRoot = resolveShadPs4RootForMeta(meta);
      const modernSchema = modernRoot
        ? path.join(modernRoot, "trophy", npcommid)
        : "";
      if (modernSchema && fs.existsSync(modernSchema)) return modernSchema;
    }
    const schemaPath =
      typeof meta.shadps4_schema_path === "string"
        ? meta.shadps4_schema_path
        : "";
    if (schemaPath && fs.existsSync(schemaPath)) return schemaPath;
    const direct =
      typeof meta.trophy_path === "string"
        ? meta.trophy_path
        : typeof meta.save_path === "string"
          ? meta.save_path
          : "";
    if (direct) {
      try {
        const stat = fs.statSync(direct);
        if (stat.isFile()) return schemaPath || "";
      } catch {}
    }
    if (direct && fs.existsSync(direct)) return direct;
    return direct || "";
  }

  function resolveShadPs4RootForMeta(meta) {
    const candidates = [
      meta?.shadps4_schema_path,
      meta?.trophy_path,
      meta?.shadps4_progress_path,
      meta?.save_path,
      meta?.config_path,
    ].filter(Boolean);
    const envRoot =
      process.env.APPDATA && path.join(process.env.APPDATA, "shadPS4");
    if (envRoot) candidates.push(envRoot);

    for (const candidate of candidates) {
      const raw = String(candidate || "");
      if (!raw) continue;
      const parts = raw.split(/[\\/]+/);
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i]?.toLowerCase() !== "shadps4") continue;
        const root = parts.slice(0, i + 1).join(path.sep);
        if (root && fs.existsSync(root)) return root;
      }
      if (path.basename(raw).toLowerCase() === "user" && fs.existsSync(raw)) {
        return raw;
      }
    }
    return "";
  }

  function getPs4NpCommIdFromProgressPath(filePath) {
    const base = path.basename(String(filePath || ""));
    const match = base.match(/^(NP[A-Z0-9_]+)\.xml$/i);
    return match ? match[1] : "";
  }

  function isPs4ProgressXmlPath(filePath) {
    const npcommid = getPs4NpCommIdFromProgressPath(filePath);
    if (!npcommid) return false;
    const parts = String(filePath || "").split(/[\\/]+/);
    const len = parts.length;
    return (
      len >= 4 &&
      parts[len - 2]?.toLowerCase() === "trophy" &&
      Boolean(parts[len - 3]) &&
      parts[len - 4]?.toLowerCase() === "home"
    );
  }

  function getPs4UserIdFromProgressPath(filePath) {
    if (!isPs4ProgressXmlPath(filePath)) return "";
    const parts = String(filePath || "").split(/[\\/]+/);
    return String(parts[parts.length - 3] || "").trim();
  }

  function getPs4ProgressFileMtimeMs(progressPath) {
    try {
      return fs.statSync(progressPath).mtimeMs || 0;
    } catch {
      return 0;
    }
  }

  function collectPs4ProgressFiles(root, npcommid, preferredUser = "") {
    const normalizedNpCommId = String(npcommid || "").trim();
    if (!root || !normalizedNpCommId) return [];
    const homeDir = path.join(root, "home");
    const seen = new Set();
    const out = [];
    const addCandidate = (userId, progressPath) => {
      if (!userId || !progressPath || !fs.existsSync(progressPath)) return;
      const key = path.normalize(progressPath).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        userId: String(userId),
        progressPath,
        mtimeMs: getPs4ProgressFileMtimeMs(progressPath),
        preferred: Boolean(
          preferredUser && String(userId) === String(preferredUser),
        ),
      });
    };
    if (preferredUser) {
      addCandidate(
        preferredUser,
        path.join(
          homeDir,
          preferredUser,
          "trophy",
          `${normalizedNpCommId}.xml`,
        ),
      );
    }
    try {
      for (const ent of fs.readdirSync(homeDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name) continue;
        addCandidate(
          ent.name,
          path.join(homeDir, ent.name, "trophy", `${normalizedNpCommId}.xml`),
        );
      }
    } catch {}
    out.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      return String(a.userId).localeCompare(String(b.userId), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
    return out;
  }

  function selectPs4ProgressFile(
    root,
    npcommid,
    preferredUser = "",
    direct = "",
  ) {
    const candidates = collectPs4ProgressFiles(root, npcommid, preferredUser);
    if (direct && fs.existsSync(direct)) {
      const directUser = getPs4UserIdFromProgressPath(direct) || preferredUser;
      const directKey = path.normalize(direct).toLowerCase();
      if (
        !candidates.some(
          (candidate) =>
            path.normalize(candidate.progressPath).toLowerCase() === directKey,
        )
      ) {
        candidates.push({
          userId: directUser,
          progressPath: direct,
          mtimeMs: getPs4ProgressFileMtimeMs(direct),
          preferred: Boolean(
            preferredUser && String(directUser) === String(preferredUser),
          ),
        });
      }
      candidates.sort((a, b) => {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
        return String(a.userId).localeCompare(String(b.userId), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    }
    return candidates[0] || null;
  }

  function resolvePs4ProgressPathForMeta(meta) {
    if (!meta) return "";
    const direct =
      typeof meta.shadps4_progress_path === "string" &&
      meta.shadps4_progress_path
        ? meta.shadps4_progress_path
        : typeof meta.save_path === "string" && meta.save_path
          ? meta.save_path
          : "";
    const npcommid = String(meta.shadps4_npcommid || "").trim();
    const schemaDir = resolvePs4TrophyDirForMeta(meta);
    if (!npcommid) {
      if (direct) {
        try {
          const stat = fs.statSync(direct);
          if (stat.isFile()) return direct;
        } catch {}
      }
      return "";
    }
    const root =
      resolveShadPs4RootForMeta(meta) ||
      (schemaDir ? path.dirname(path.dirname(schemaDir)) : "");
    if (!root) {
      if (direct) {
        try {
          const stat = fs.statSync(direct);
          if (stat.isFile()) return direct;
        } catch {}
      }
      return "";
    }
    const preferredUser = String(meta.shadps4_user_id || "").trim();
    const selected = selectPs4ProgressFile(
      root,
      npcommid,
      preferredUser,
      direct,
    );
    return selected?.progressPath || "";
  }

  function resolveTropusrPathForMeta(meta) {
    const trophyDir = resolveRpcs3TrophyDirForMeta(meta);
    if (!trophyDir) return "";
    const direct = path.join(trophyDir, "TROPUSR.DAT");
    if (fs.existsSync(direct)) return direct;
    try {
      const files = fs.readdirSync(trophyDir);
      const found = files.find((f) => f.toLowerCase() === "tropusr.dat");
      if (found) return path.join(trophyDir, found);
    } catch {}
    return direct;
  }

  async function handleSteamOfficialBinEvent(info, options = {}) {
    if (!info?.appid) return null;
    const appid = String(info.appid);
    const statsDir = info.statsDir || "";
    if (isAppIdBlacklisted(appid, "steam-official")) {
      pendingSteamOfficial.delete(appid);
      watcherLogger.info("steam-official:skip-blacklisted", {
        appid,
        source: "file-event",
      });
      return { skipped: true, appid, reason: "blacklisted" };
    }
    const preferredAccountId = getPreferredSteamOfficialAccountId();
    if (
      preferredAccountId &&
      info?.kind === "user" &&
      String(info?.accountId || "") !== preferredAccountId
    ) {
      watcherLogger.info("steam-official:skip-nonselected-account", {
        appid,
        accountId: info?.accountId || null,
        preferredAccountId,
      });
      return { skipped: true, appid };
    }
    if (shouldSkipSteamOfficialGeneration(appid)) {
      pendingSteamOfficial.delete(appid);
      watcherLogger.info("steam-official:skip-existing", { appid });
      return { skipped: true, appid };
    }

    const schemaBinPath = info.schemaBinPath || "";
    if (!schemaBinPath || !fs.existsSync(schemaBinPath)) {
      if (!pendingSteamOfficial.has(appid)) {
        pendingSteamOfficial.set(appid, {
          statsDir,
          firstSeen: Date.now(),
        });
        watcherLogger.info("steam-official:pending-schema", {
          appid,
          statsDir,
        });
      }
      return { pending: true, appid };
    }

    const progressTask = { appid, forcePlatform: "steam-official" };
    const externalProgress =
      typeof options?.onGenerationProgress === "function"
        ? options.onGenerationProgress
        : null;
    const progressReporter = externalProgress
      ? null
      : createGenerationBatchReporter([progressTask], {
          fallbackItemName: appid,
          deferStartUntilVisible: true,
          usePhaseOnlyDetails: true,
        });
    const onGenerationProgress = (progress = {}) => {
      if (externalProgress) {
        externalProgress(progress);
        return;
      }
      progressReporter?.updateTask(progressTask, 0, progress);
    };

    let result = null;
    try {
      result = await generateConfigFromAppcacheBin(
        statsDir,
        schemaBinPath,
        configsDir,
        {
          preferredAccountId,
          onGenerationProgress,
          shouldSkipAppId: (candidateAppId) =>
            isAppIdBlacklisted(candidateAppId, "steam-official"),
        },
      );
    } catch (err) {
      progressReporter?.finish(
        "failed",
        err?.message || "",
      );
      throw err;
    }
    if (!result) return null;
    if (result.skipped) {
      progressReporter?.updateTask(progressTask, 0, {
        appid,
        itemName: appid,
        phase: "skipped",
        detail: result.reason || "blacklisted",
      });
      progressReporter?.finish("success", "");
      pendingSteamOfficial.delete(appid);
      return result;
    }
    if (
      progressReporter &&
      (result.created || result.schemaUpdated || result.configUpdated)
    ) {
      progressReporter.settleTask(progressTask, 0, result);
      progressReporter.finish("success", "");
    }
    pendingSteamOfficial.delete(appid);
    await indexExistingConfigsSync();
    knownAppIds.add(appid);
    attachSaveWatcherForAppId(appid, { suppressInitialNotify: false });
    broadcastAll("configs:changed");
    broadcastAll("refresh-achievements-table");
    return result;
  }

  async function discoverGpdFilesUnder(
    root,
    maxDepth = 4,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const results = [];
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase().endsWith(".gpd")) {
          results.push(full);
        } else if (ent.isDirectory()) {
          await walk(full, depth + 1);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    return results;
  }

  async function discoverRpcs3TrophyDirsUnder(
    root,
    maxDepth = 4,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const results = [];
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      const baseName = path.basename(dir || "").toLowerCase();
      if (isRpcs3TempFolderName(baseName)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let hasConf = false;
      let hasUsr = false;
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const name = ent.name.toLowerCase();
        if (name === "tropconf.sfm") hasConf = true;
        if (name === "tropusr.dat") hasUsr = true;
        if (yieldIfNeeded) await yieldIfNeeded();
      }
      if (hasConf && hasUsr) {
        results.push(dir);
        return;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          await walk(path.join(dir, ent.name), depth + 1);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    return results;
  }

  async function discoverPs4TrophyDirsUnder(
    root,
    maxDepth = 4,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const results = [];
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let hasTrop = false;
      let hasIcons = false;
      let hasXml = false;
      for (const ent of entries) {
        const name = ent.name.toLowerCase();
        const entryPath = path.join(dir, ent.name);
        if (
          typeof shouldSkipPath === "function" &&
          shouldSkipPath(entryPath)
        ) {
          continue;
        }
        if (ent.isDirectory() && name === "trophyfiles") {
          const t0 = path.join(dir, ent.name, "trophy00");
          const xml = path.join(t0, "Xml", "TROP.XML");
          if (fs.existsSync(xml)) {
            results.push(path.join(t0));
            return;
          }
        }
        if (ent.isFile() && name === "trop.xml") {
          hasTrop = true;
        } else if (ent.isDirectory() && name === "xml") {
          hasXml = true;
        } else if (ent.isDirectory() && name === "icons") {
          hasIcons = true;
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
      if (hasTrop && hasXml) {
        results.push(dir);
        return;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          await walk(path.join(dir, ent.name), depth + 1);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    return results;
  }

  function getLegacyPs4AppIdFromTrophyDir(trophyDir) {
    const parts = String(trophyDir || "").split(/[\\/]+/);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^CUSA\d+$/i.test(parts[i] || "")) return parts[i];
    }
    return "";
  }

  function readPs4NpCommIdFromTrophyDir(trophyDir) {
    const xmlDir = path.join(trophyDir || "", "Xml");
    const candidates = [
      path.join(xmlDir, "TROP.XML"),
      path.join(xmlDir, "TROP_01.XML"),
      path.join(xmlDir, "TROPCONF.XML"),
    ];
    for (const candidate of candidates) {
      const npcommid = readSimpleXmlTag(candidate, "npcommid");
      if (npcommid) return npcommid;
    }
    return "";
  }

  function readPs4TitleFromSchemaDir(schemaDir) {
    const xmlPath = path.join(schemaDir || "", "Xml", "TROP.XML");
    if (!xmlPath || !fs.existsSync(xmlPath)) return { title: "", npcommid: "" };
    try {
      const parsed = parsePs4TrophySetDir(schemaDir);
      return {
        title: parsed?.title || "",
        npcommid: parsed?.npcommid || path.basename(schemaDir || ""),
      };
    } catch {
      return { title: "", npcommid: path.basename(schemaDir || "") };
    }
  }

  function buildShadPs4LogNpCommMap(root) {
    const map = new Map();
    const logPath = path.join(root || "", "log", "shad_log.txt");
    if (!logPath || !fs.existsSync(logPath)) return map;
    let raw = "";
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch {
      return map;
    }
    let current = null;
    for (const line of raw.split(/\r?\n/)) {
      const gameMatch = line.match(/Game id:\s*(CUSA\d+)\s+Title:\s*(.+)$/i);
      if (gameMatch) {
        current = {
          appid: gameMatch[1],
          title: String(gameMatch[2] || "").trim(),
        };
        continue;
      }
      const npMatch = line.match(
        /Successfully extracted .* for (NP[A-Z0-9_]+)/i,
      );
      if (npMatch && current) {
        map.set(npMatch[1].toLowerCase(), { ...current, npcommid: npMatch[1] });
      }
    }
    return map;
  }

  function normalizeShadPs4TitleKey(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[®™©]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function buildShadPs4LogTitleMap(root) {
    const map = new Map();
    const logPath = path.join(root || "", "log", "shad_log.txt");
    if (!logPath || !fs.existsSync(logPath)) return map;
    let raw = "";
    try {
      raw = fs.readFileSync(logPath, "utf8");
    } catch {
      return map;
    }
    for (const line of raw.split(/\r?\n/)) {
      const gameMatch = line.match(/Game id:\s*(CUSA\d+)\s+Title:\s*(.+)$/i);
      if (!gameMatch) continue;
      const title = String(gameMatch[2] || "").trim();
      const key = normalizeShadPs4TitleKey(title);
      if (!key) continue;
      map.set(key, {
        appid: gameMatch[1],
        title,
      });
    }
    return map;
  }

  function readSimpleXmlTag(filePath, tagName) {
    if (!filePath || !fs.existsSync(filePath)) return "";
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const match = raw.match(
        new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"),
      );
      return match ? String(match[1] || "").trim() : "";
    } catch {
      return "";
    }
  }

  function buildShadPs4LegacyNpCommMap(root) {
    const map = new Map();
    const gameData = path.join(root || "", "game_data");
    if (!gameData || !fs.existsSync(gameData)) return map;
    let games = [];
    try {
      games = fs.readdirSync(gameData, { withFileTypes: true });
    } catch {
      return map;
    }
    for (const game of games) {
      if (!game.isDirectory() || !/^CUSA\d+$/i.test(game.name)) continue;
      const trophyFiles = path.join(gameData, game.name, "TrophyFiles");
      let trophyDirs = [];
      try {
        trophyDirs = fs
          .readdirSync(trophyFiles, { withFileTypes: true })
          .filter((ent) => ent.isDirectory())
          .map((ent) => path.join(trophyFiles, ent.name));
      } catch {
        trophyDirs = [];
      }
      for (const trophyDir of trophyDirs) {
        const xmlDir = path.join(trophyDir, "Xml");
        const candidates = [
          path.join(xmlDir, "TROP.XML"),
          path.join(xmlDir, "TROPCONF.XML"),
        ];
        const xmlPath = candidates.find((candidate) =>
          fs.existsSync(candidate),
        );
        if (!xmlPath) continue;
        const npcommid = readSimpleXmlTag(xmlPath, "npcommid");
        if (!npcommid) continue;
        map.set(npcommid.toLowerCase(), {
          appid: game.name,
          title: readSimpleXmlTag(xmlPath, "title-name"),
          npcommid,
        });
      }
    }
    return map;
  }

  async function discoverModernPs4TrophySetsUnder(root, yieldIfNeeded) {
    const results = [];
    const schemaRoot = path.join(root || "", "trophy");
    if (!schemaRoot || !fs.existsSync(schemaRoot)) return results;
    const legacyMap = buildShadPs4LegacyNpCommMap(root);
    const logMap = buildShadPs4LogNpCommMap(root);
    const logTitleMap = buildShadPs4LogTitleMap(root);
    let entries = [];
    try {
      entries = await fsp.readdir(schemaRoot, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !/^NP[A-Z0-9_]+$/i.test(ent.name)) continue;
      const npcommid = ent.name;
      const schemaDir = path.join(schemaRoot, ent.name);
      const xmlPath = path.join(schemaDir, "Xml", "TROP.XML");
      if (!fs.existsSync(xmlPath)) continue;
      const schemaInfo = readPs4TitleFromSchemaDir(schemaDir);
      const mapped =
        logMap.get(npcommid.toLowerCase()) ||
        legacyMap.get(npcommid.toLowerCase()) ||
        logTitleMap.get(normalizeShadPs4TitleKey(schemaInfo.title)) ||
        null;
      const progressFiles = collectPs4ProgressFiles(root, npcommid);
      results.push({
        npcommid,
        appid: mapped?.appid || npcommid,
        title: schemaInfo.title || mapped?.title || npcommid,
        schemaDir,
        progressFiles,
      });
      if (yieldIfNeeded) await yieldIfNeeded();
    }
    return results;
  }

  function recordExistingSavePath(appid, dir) {
    if (!dir) return;
    const key = String(appid);
    if (!configSavePathIndex.has(key)) configSavePathIndex.set(key, new Set());
    configSavePathIndex.get(key).add(dir);
  }

  function markPendingSavePath(appid, dir) {
    if (!dir) return;
    const key = String(appid);
    if (!pendingSavePathIndex.has(key))
      pendingSavePathIndex.set(key, new Set());
    pendingSavePathIndex.get(key).add(dir);
  }

  function clearPendingSavePath(appid, dir) {
    if (!dir) return;
    const key = String(appid);
    if (!pendingSavePathIndex.has(key)) return;
    const bucket = pendingSavePathIndex.get(key);
    bucket.delete(dir);
    if (bucket.size === 0) pendingSavePathIndex.delete(key);
  }

  function clearPendingForTasks(tasks) {
    if (!Array.isArray(tasks)) return;
    for (const task of tasks) {
      if (task?.normalizedPath) {
        clearPendingSavePath(task.appid, task.normalizedPath);
      }
    }
  }

  function getBlockedFoldersSet() {
    if (blockedFoldersCache instanceof Set) {
      return new Set(blockedFoldersCache);
    }
    const prefs = readPrefsSafe();
    const blockedArr = Array.isArray(prefs.blockedWatchedFolders)
      ? prefs.blockedWatchedFolders
      : [];
    const blocked = new Set(DEFAULT_BLOCKED_SET);
    blockedArr
      .map((dir) => {
        try {
          return fs.realpathSync(dir);
        } catch {
          return dir;
        }
      })
      .filter(Boolean)
      .forEach((dir) => blocked.add(dir));
    blockedFoldersCache = new Set(blocked);
    return new Set(blockedFoldersCache);
  }

  function isNormalizedPathBlocked(candidate, blockedFolders = null) {
    if (!candidate) return false;
    const blocked =
      blockedFolders instanceof Set ? blockedFolders : getBlockedFoldersSet();
    for (const blockedRoot of blocked) {
      if (DEFAULT_BLOCKED_SET.has(blockedRoot)) {
        try {
          if (!path.relative(blockedRoot, candidate)) return true;
        } catch {}
        continue;
      }
      if (isPathInsideRoot(blockedRoot, candidate)) return true;
    }
    return false;
  }

  function isPathBlocked(candidatePath, blockedFolders = null) {
    return isNormalizedPathBlocked(
      normalizePrefPath(candidatePath),
      blockedFolders,
    );
  }

  function saveBlockedFolders(list) {
    const uniq = Array.from(
      new Set((list || []).filter(Boolean).map(normalizePrefPath)),
    );
    try {
      if (persistPreferences) {
        persistPreferences({ blockedWatchedFolders: uniq });
        blockedFoldersCache = null;
        return getBlockedFoldersSet();
      }
      const prefs = readPrefsSafe();
      writeJsonAtomicSync(
        preferencesPath,
        { ...prefs, blockedWatchedFolders: uniq },
        { backup: true },
      );
      blockedFoldersCache = null;
      return getBlockedFoldersSet();
    } catch (err) {
      watcherLogger.error("folders:block-save-failed", {
        error: err?.message || String(err),
      });
      return new Set(uniq);
    }
  }

  // --- helpers ---
  function broadcastAll(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      } catch {}
    }
  }

  const BOOT_WATCHER_PROGRESS_ID = "boot-watchers";
  let bootWatcherProgressStarted = false;
  let bootWatcherProgressLastEmitAt = 0;

  function clampBootProgressPercent(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n <= 0) return 0;
    if (n >= 100) return 100;
    return Math.round(n);
  }

  function getBootProgressPercent(current, total, fallback = 0) {
    const c = Number(current);
    const t = Number(total);
    if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) {
      return clampBootProgressPercent(fallback, 0);
    }
    return clampBootProgressPercent((Math.max(0, c) / t) * 100, fallback);
  }

  function getBootProgressItemName(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      return path.basename(text) || text;
    } catch {
      return text;
    }
  }

  function broadcastBootWatcherProgress(channel, patch = {}) {
    const status =
      patch.status ||
      (channel === "generation:progress:end" ? "success" : "running");
    broadcastAll(channel, {
      id: BOOT_WATCHER_PROGRESS_ID,
      kind: "boot-background",
      scope: "boot",
      status,
      phase: "waitingForUi",
      itemName: "",
      current: 0,
      total: 0,
      percent: 0,
      ...patch,
    });
  }

  function startBootWatcherProgress(patch = {}) {
    bootWatcherProgressStarted = true;
    bootWatcherProgressLastEmitAt = Date.now();
    broadcastBootWatcherProgress("generation:progress:start", patch);
  }

  function updateBootWatcherProgress(patch = {}, options = {}) {
    const now = Date.now();
    if (!bootWatcherProgressStarted) {
      startBootWatcherProgress(patch);
      return;
    }
    if (options.force !== true && now - bootWatcherProgressLastEmitAt < 500) {
      return;
    }
    bootWatcherProgressLastEmitAt = now;
    broadcastBootWatcherProgress("generation:progress:update", patch);
  }

  function finishBootWatcherProgress(status = "success", patch = {}) {
    if (!bootWatcherProgressStarted) {
      startBootWatcherProgress(patch);
    }
    broadcastBootWatcherProgress("generation:progress:end", {
      ...patch,
      status,
    });
    bootWatcherProgressStarted = false;
  }

  function waitForMainWindowReady(timeoutMs = 4000) {
    return new Promise((resolve) => {
      let win = global.mainWindow;
      if (!win || win.isDestroyed?.()) {
        try {
          win =
            BrowserWindow.getAllWindows().find((w) => {
              try {
                const url = w?.webContents?.getURL?.() || "";
                return url.includes("index.html");
              } catch {
                return false;
              }
            }) || BrowserWindow.getAllWindows()[0];
        } catch {
          win = null;
        }
      }
      if (!win || win.isDestroyed?.()) return resolve(false);
      try {
        if (!win.webContents.isLoading()) return resolve(true);
      } catch {
        return resolve(false);
      }

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve(true);
      };
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        try {
          win.webContents.removeListener("did-finish-load", finish);
        } catch {}
        clearTimeout(timeout);
      };
      try {
        win.webContents.once("did-finish-load", finish);
      } catch {
        cleanup();
        resolve(false);
      }
    });
  }

  function makeDebounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const debounceConfigsChanged = makeDebounce(() => {
    try {
      broadcastAll("configs:changed");
    } catch {}
  }, 2600);

  const debounceRefreshAchievementsTable = makeDebounce(() => {
    try {
      broadcastAll("refresh-achievements-table");
    } catch {}
  }, 2600);

  function emitDashboardRefresh() {
    if (typeof requestDashboardRefresh === "function") {
      requestDashboardRefresh();
      return;
    }
    try {
      broadcastAll("dashboard:refresh");
    } catch {}
  }

  function pauseDashboardPoll(state = true) {
    try {
      broadcastAll("dashboard:poll-pause", state === true);
    } catch {}
  }

  let bootIndexingPromise = null;
  async function indexExistingConfigsSync(options = {}) {
    const forceAsync = options?.forceAsync === true;
    const commitIndex = (next) => {
      existingConfigIds.clear();
      configIndex.clear();
      ps4NpCommIndex.clear();
      configPlatformPresence.clear();
      configSavePathIndex.clear();
      tenokeIds.clear();
      persistedTenoke.clear();
      seededInitialConfigs.clear();

      for (const id of next.existingConfigIds) existingConfigIds.add(id);
      for (const [appid, metas] of next.configIndex.entries()) {
        configIndex.set(appid, metas);
      }
      for (const [npcommid, metas] of next.ps4NpCommIndex.entries()) {
        ps4NpCommIndex.set(npcommid, metas);
      }
      for (const [appid, set] of next.configPlatformPresence.entries()) {
        configPlatformPresence.set(appid, set);
      }
      for (const [appid, set] of next.configSavePathIndex.entries()) {
        configSavePathIndex.set(appid, set);
      }
      for (const id of next.tenokeIds) tenokeIds.add(id);
      for (const id of next.persistedTenoke) persistedTenoke.add(id);
    };

    const addFromConfigFile = (next, fileName, data) => {
      const appid = String(
        data?.appid || data?.appId || data?.steamAppId || "",
      ).trim();
      const platform = normalizePlatform(data?.platform) || "steam";
      const isValidId =
        appid &&
        (platform === "rpcs3" ||
          platform === "shadps4" ||
          /^[0-9a-fA-F]+$/.test(appid) ||
          /^CUSA\d+/i.test(appid));
      if (!isValidId) return;

      next.existingConfigIds.add(appid);
      const normalizedSavePath = normalizeObservedPath(
        data?.save_path || data?.config_path || "",
        appid,
      );
      const meta = {
        // Always use the config filename as the stable key (matches UI + avoids Windows-illegal chars).
        name: path.basename(fileName, ".json"),
        appid,
        platform,
        emu: normalizeEmuValue(data?.emu),
        save_path: data?.save_path || null,
        config_path: data?.config_path || null,
        game_path:
          typeof data?.game_path === "string" ? data.game_path : "",
        markerpatch_game_path:
          typeof data?.markerpatch_game_path === "string"
            ? data.markerpatch_game_path
            : "",
        markerpatch_state_file:
          typeof data?.markerpatch_state_file === "string"
            ? data.markerpatch_state_file
            : "",
        madnesspatch_game_path:
          typeof data?.madnesspatch_game_path === "string"
            ? data.madnesspatch_game_path
            : "",
        madnesspatch_checkpoint_root:
          typeof data?.madnesspatch_checkpoint_root === "string"
            ? data.madnesspatch_checkpoint_root
            : "",
        achievement_source:
          data?.achievement_source && typeof data.achievement_source === "object"
            ? data.achievement_source
            : null,
        native_platinum: data?.native_platinum === true,
        trophy_path:
          typeof data?.trophy_path === "string" ? data.trophy_path : "",
        shadps4_npcommid:
          typeof data?.shadps4_npcommid === "string"
            ? data.shadps4_npcommid
            : typeof data?.npcommid === "string"
              ? data.npcommid
              : "",
        shadps4_schema_path:
          typeof data?.shadps4_schema_path === "string"
            ? data.shadps4_schema_path
            : "",
        shadps4_progress_path:
          typeof data?.shadps4_progress_path === "string"
            ? data.shadps4_progress_path
            : "",
        shadps4_user_id:
          typeof data?.shadps4_user_id === "string" ? data.shadps4_user_id : "",
        lumaplay_user:
          typeof data?.lumaplay_user === "string"
            ? data.lumaplay_user
            : typeof data?.lumaplayUser === "string"
              ? data.lumaplayUser
              : "",
        gog_client_id:
          typeof data?.gog_client_id === "string"
            ? data.gog_client_id
            : typeof data?.gogClientId === "string"
              ? data.gogClientId
              : "",
        gog_user_id:
          typeof data?.gog_user_id === "string"
            ? data.gog_user_id
            : typeof data?.gogUserId === "string"
              ? data.gogUserId
              : "",
        gog_gameplay_db:
          typeof data?.gog_gameplay_db === "string"
            ? data.gog_gameplay_db
            : typeof data?.gogGameplayDb === "string"
              ? data.gogGameplayDb
              : "",
        ubisoft_user_id:
          typeof data?.ubisoft_user_id === "string"
            ? data.ubisoft_user_id
            : typeof data?.ubisoftUserId === "string"
              ? data.ubisoftUserId
              : "",
        ubisoft_spool_file:
          typeof data?.ubisoft_spool_file === "string"
            ? data.ubisoft_spool_file
            : typeof data?.ubisoftSpoolFile === "string"
              ? data.ubisoftSpoolFile
              : "",
        ubisoft_achievements_archive:
          typeof data?.ubisoft_achievements_archive === "string"
            ? data.ubisoft_achievements_archive
            : typeof data?.ubisoftAchievementsArchive === "string"
              ? data.ubisoftAchievementsArchive
              : "",
        normalizedSavePath,
        platinum: data?.platinum === true,
        __tenoke: data?.emu === "tenoke" || false,
      };
      if (meta.__tenoke) {
        next.tenokeIds.add(appid);
        next.persistedTenoke.add(appid);
        if (data?.tenokeLinked) {
          tenokeRelinkedConfigs.add(meta.name);
        }
      }
      if (!next.configIndex.has(appid)) next.configIndex.set(appid, []);
      next.configIndex.get(appid).push(meta);
      if (platform === "shadps4" && meta.shadps4_npcommid) {
        const npKey = String(meta.shadps4_npcommid).trim().toLowerCase();
        if (!next.ps4NpCommIndex.has(npKey)) {
          next.ps4NpCommIndex.set(npKey, []);
        }
        next.ps4NpCommIndex.get(npKey).push(meta);
      }

      const key = String(appid);
      if (!next.configPlatformPresence.has(key)) {
        next.configPlatformPresence.set(key, new Set());
      }
      next.configPlatformPresence.get(key).add(platform);

      const recordPath = (p) => {
        if (!p) return;
        if (!next.configSavePathIndex.has(key)) {
          next.configSavePathIndex.set(key, new Set());
        }
        next.configSavePathIndex.get(key).add(p);
      };
      if (normalizedSavePath) recordPath(normalizedSavePath);
      const normalizedConfigPath = normalizeObservedPath(
        data?.config_path || "",
        appid,
      );
      if (normalizedConfigPath) recordPath(normalizedConfigPath);
    };

    if (!bootMode && !forceAsync) {
      const next = {
        existingConfigIds: new Set(),
        configIndex: new Map(),
        ps4NpCommIndex: new Map(),
        configPlatformPresence: new Map(),
        configSavePathIndex: new Map(),
        tenokeIds: new Set(),
        persistedTenoke: new Set(),
      };
      try {
        const files = fs.readdirSync(configsDir);
        for (const f of files.slice(0, 5000)) {
          if (!f.toLowerCase().endsWith(".json")) continue;
          try {
            const p = path.join(configsDir, f);
            const raw = fs.readFileSync(p, "utf8");
            const data = JSON.parse(raw);
            addFromConfigFile(next, f, data);
          } catch {
            /* ignore */
          }
        }
      } catch {
        return;
      }
      commitIndex(next);
      return;
    }

    if (bootIndexingPromise) {
      await bootIndexingPromise;
      return;
    }

    bootIndexingPromise = (async () => {
      const next = {
        existingConfigIds: new Set(),
        configIndex: new Map(),
        ps4NpCommIndex: new Map(),
        configPlatformPresence: new Map(),
        configSavePathIndex: new Map(),
        tenokeIds: new Set(),
        persistedTenoke: new Set(),
      };

      let files = [];
      try {
        files = await fsp.readdir(configsDir);
      } catch {
        return;
      }
      const yieldIfNeeded = createTimeSlicer(BOOT_INDEX_SLICE_MS);
      await runWithConcurrency(
        files.slice(0, 5000),
        BOOT_INDEX_CONCURRENCY,
        async (f) => {
          if (!String(f).toLowerCase().endsWith(".json")) return;
          try {
            const p = path.join(configsDir, f);
            const raw = await fsp.readFile(p, "utf8");
            const data = JSON.parse(raw);
            addFromConfigFile(next, f, data);
          } catch {
            /* ignore */
          } finally {
            if (yieldIfNeeded) await yieldIfNeeded();
          }
        },
      );

      commitIndex(next);
    })();

    try {
      await bootIndexingPromise;
    } finally {
      bootIndexingPromise = null;
    }
  }

  // Snapshot cache keyed by config name + platform (+ account for steam-official)
  const lastSnapshot = new Map();

  function resolveSteamOfficialSnapshotAccountId(meta, appid, options = {}) {
    const platform = normalizePlatform(meta?.platform) || "steam";
    if (platform !== "steam-official") return "";
    const opts = options && typeof options === "object" ? options : {};
    const parsed = parseUserBinName(opts.userBinPath || opts.filePath || "");
    if (parsed?.accountId) return String(parsed.accountId || "").trim();
    const preferredAccountId = getPreferredSteamOfficialAccountId(
      opts.preferences || null,
    );
    if (preferredAccountId) return preferredAccountId;
    const statsDir = String(opts.statsDir || meta?.save_path || "").trim();
    const targetAppId = String(opts.appid || appid || meta?.appid || "").trim();
    if (!statsDir || !targetAppId) return "";
    const userBin = pickConfiguredSteamOfficialUserBin(
      statsDir,
      targetAppId,
      opts.preferences || null,
    );
    const resolved = parseUserBinName(userBin || "");
    return resolved?.accountId ? String(resolved.accountId || "").trim() : "";
  }

  function makeSnapshotKey(meta, appid, options = {}) {
    const name = sanitizeConfigName(meta?.name || "") || String(appid || "");
    const platform = normalizePlatform(meta?.platform) || "steam";
    const parts = [name, platform];
    const steamOfficialAccountId = resolveSteamOfficialSnapshotAccountId(
      meta,
      appid,
      options,
    );
    if (steamOfficialAccountId) {
      parts.push(`acct:${steamOfficialAccountId}`);
    }
    if (platform === "shadps4") {
      const shadPs4UserId =
        getPs4UserIdFromProgressPath(options?.filePath || "") ||
        getPs4UserIdFromProgressPath(options?.savePath || "") ||
        getPs4UserIdFromProgressPath(options?.progressPath || "") ||
        String(
          options?.shadps4UserId ||
            options?.shadps4_user_id ||
            meta?.shadps4_user_id ||
            "",
        ).trim();
      if (shadPs4UserId) parts.push(`user:${shadPs4UserId}`);
    }
    if (platform === "madnesspatch") {
      const stateFile = String(options?.filePath || "").trim();
      if (stateFile) {
        const profileName = path.basename(path.dirname(stateFile));
        if (profileName) parts.push(`profile:${profileName.toLowerCase()}`);
      }
    }
    return parts.join("::");
  }

  function getCacheMetaKey(meta, appid, filePath) {
    if (!filePath) return "";
    const snapKey = makeSnapshotKey(meta, appid, { filePath });
    const normPath = normalizePrefPath(filePath);
    if (!snapKey || !normPath) return "";
    const baseName = path.basename(filePath).toLowerCase();
    const parentName = path.basename(path.dirname(filePath)).toLowerCase();
    const parserRevision =
      parentName === "stats" &&
      (baseName === "achievements.ini" || baseName === "stats.ini")
        ? "::online-fix-parser:2"
        : "";
    return `${snapKey}::${normPath}${parserRevision}`;
  }

  function readFileStatSyncSafe(fp) {
    try {
      return fs.statSync(fp);
    } catch {
      return null;
    }
  }

  async function readFileStatSafe(fp) {
    try {
      return await fsp.stat(fp);
    } catch {
      return null;
    }
  }

  function updateCacheMetaEntry(metaKey, stat) {
    if (!metaKey || !stat) return;
    const mtimeMs = Number(stat.mtimeMs ?? 0);
    const size = Number(stat.size ?? 0);
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return;
    loadCacheMetaOnce();
    cacheMeta.set(metaKey, { mtimeMs, size });
    scheduleCacheMetaSave();
  }

  function readJsonSafe(fp) {
    try {
      return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      return null;
    }
  }

  function resolveAchievementsSchemaPath(meta) {
    if (!meta?.config_path) return null;
    const p1 = path.join(meta.config_path, "achievements.json");
    if (fs.existsSync(p1)) return p1;
    const pSteamSettings = path.join(
      meta.config_path,
      "steam_settings",
      "achievements.json",
    );
    if (fs.existsSync(pSteamSettings)) return pSteamSettings;
    if (meta?.appid != null) {
      const p2 = path.join(
        meta.config_path,
        String(meta.appid),
        "achievements.json",
      );
      if (fs.existsSync(p2)) return p2;
    }
    return null;
  }

  function schemaPayloadLooksValid(payload) {
    return Array.isArray(payload) || Array.isArray(payload?.achievements);
  }

  function configMetaHasValidSchema(meta) {
    const schemaPath = resolveAchievementsSchemaPath(meta);
    if (!schemaPath || !fs.existsSync(schemaPath)) return false;
    return schemaPayloadLooksValid(readJsonSafe(schemaPath));
  }

  function findExistingSchemaMetaForGeneration(
    appid,
    platform = null,
    normalizedSavePath = "",
  ) {
    const preferred = findConfigMetaForGeneration(
      appid,
      platform,
      normalizedSavePath,
    );
    if (preferred && configMetaHasValidSchema(preferred)) return preferred;
    const metas = getConfigMetas(appid);
    if (!metas.length) return null;
    const desiredPlatform = normalizePlatform(platform) || null;
    const normalizedPath = String(normalizedSavePath || "");
    let candidates = desiredPlatform
      ? metas.filter(
          (meta) => normalizePlatform(meta?.platform) === desiredPlatform,
        )
      : metas.slice();
    if (!candidates.length && !desiredPlatform) candidates = metas.slice();
    if (normalizedPath) {
      const pathMatch = candidates.find(
        (meta) => getMetaNormalizedSavePath(meta) === normalizedPath,
      );
      if (pathMatch && configMetaHasValidSchema(pathMatch)) return pathMatch;
    }
    return candidates.find((meta) => configMetaHasValidSchema(meta)) || null;
  }

  function getConfigEntry(meta, key) {
    const schemaPath = resolveAchievementsSchemaPath(meta);
    if (!schemaPath) return null;
    const arr = readJsonSafe(schemaPath);
    if (!Array.isArray(arr)) return null;
    return arr.find((item) => item?.name === key) || null;
  }

  function getSaveWatchTargets(meta) {
    const out = new Set();
    if (isLumaPlayMeta(meta)) return [];

    if (isMarkerPatchConfig(meta)) {
      const stateFile = getMarkerPatchStateFile(meta);
      return stateFile ? [stateFile] : [];
    }
    if (isMadnessPatchConfig(meta)) {
      const checkpointRoot = getMadnessPatchCheckpointRoot(meta);
      return checkpointRoot ? [checkpointRoot] : [];
    }
    if (!meta?.save_path) return [];

    if (isXeniaMeta(meta)) {
      out.add(meta.save_path);
      const gpdPath = resolveGpdPathForMeta(meta);
      if (gpdPath) out.add(gpdPath);
      return Array.from(out);
    }

    if (isRpcs3Meta(meta)) {
      const trophyDir = resolveRpcs3TrophyDirForMeta(meta);
      if (trophyDir) out.add(trophyDir);
      const usrPath = resolveTropusrPathForMeta(meta);
      if (usrPath) out.add(usrPath);
      return Array.from(out);
    }
    if (isSteamOfficialMeta(meta)) {
      if (meta.save_path && meta.appid) {
        out.add(
          path.join(meta.save_path, `UserGameStatsSchema_${meta.appid}.bin`),
        );
        const latestUserBin = pickConfiguredSteamOfficialUserBin(
          meta.save_path,
          meta.appid,
        );
        if (latestUserBin) out.add(latestUserBin);
      }
      return Array.from(out);
    }

    if (isGogOfficialMeta(meta)) {
      const resolved = resolveGogOfficialGameplayDbForConfig(meta);
      const gameplayDir = resolved?.gameplayDir || meta.save_path || "";
      const gameplayDbPath =
        resolved?.gameplayDbPath ||
        meta.gog_gameplay_db ||
        (gameplayDir ? path.join(gameplayDir, GAMEPLAY_DB_NAME) : "");
      if (gameplayDir) out.add(gameplayDir);
      if (gameplayDbPath) out.add(gameplayDbPath);
      return Array.from(out);
    }

    if (isUbisoftOfficialMeta(meta)) {
      const resolved = resolveUbisoftOfficialSpoolFileForConfig(meta);
      const spoolDir = resolved?.spoolDir || meta.save_path || "";
      const spoolFilePath =
        resolved?.spoolFilePath ||
        meta.ubisoft_spool_file ||
        (spoolDir && meta.appid
          ? path.join(spoolDir, `${meta.appid}.spool`)
          : "");
      if (spoolDir) out.add(spoolDir);
      if (spoolFilePath) out.add(spoolFilePath);
      return Array.from(out);
    }

    if (isEaOfficialMeta(meta)) {
      const resolved = resolveEaOfficialVerboseLogForConfig(meta);
      const logsRoot = resolved?.logsRoot || meta.save_path || "";
      const logFilePath =
        resolved?.logFilePath ||
        meta.ea_log_file ||
        (logsRoot ? path.join(logsRoot, EA_VERBOSE_LOG_NAME) : "");
      if (logsRoot) out.add(logsRoot);
      if (logFilePath) out.add(logFilePath);
      return Array.from(out);
    }

    if (isPs4Meta(meta)) {
      const trophyDir = resolvePs4TrophyDirForMeta(meta);
      const progressPath = resolvePs4ProgressPathForMeta(meta);
      const root = resolveShadPs4RootForMeta(meta);
      const npcommid = String(meta?.shadps4_npcommid || "").trim();
      if (root && npcommid) {
        for (const entry of collectPs4ProgressFiles(
          root,
          npcommid,
          String(meta?.shadps4_user_id || "").trim(),
        )) {
          if (entry?.progressPath) out.add(entry.progressPath);
        }
      }
      if (progressPath) {
        out.add(progressPath);
      }
      if (trophyDir) {
        out.add(path.join(trophyDir, "Xml", "TROP.XML"));
      }
      return Array.from(out);
    }

    out.add(meta.save_path);

    // JSON
    out.add(path.join(meta.save_path, "achievements.json"));
    out.add(path.join(meta.save_path, String(meta.appid), "achievements.json"));
    out.add(
      path.join(
        meta.save_path,
        "steam_settings",
        String(meta.appid),
        "achievements.json",
      ),
    );
    out.add(
      path.join(
        meta.save_path,
        "remote",
        String(meta.appid),
        "achievements.json",
      ),
    );
    // INI
    out.add(path.join(meta.save_path, "achievements.ini"));
    out.add(path.join(meta.save_path, "stats.ini"));
    out.add(path.join(meta.save_path, "SteamData", "user_stats.ini"));
    out.add(path.join(meta.save_path, "user_stats.ini"));
    out.add(
      path.join(
        meta.save_path,
        String(meta.appid),
        "SteamData",
        "user_stats.ini",
      ),
    );
    out.add(path.join(meta.save_path, "Stats", "achievements.ini"));
    out.add(path.join(meta.save_path, "Stats", "stats.ini"));
    out.add(path.join(meta.save_path, String(meta.appid), "achievements.ini"));
    // UniverseLAN nested ini
    out.add(path.join(meta.save_path, "UniverseLANData", "Achievements.ini"));
    // BIN
    out.add(path.join(meta.save_path, "stats.bin"));
    out.add(path.join(meta.save_path, String(meta.appid), "stats.bin"));

    // Tenoke deep glob (only if appid marked)
    if (tenokeIds.has(String(meta.appid || ""))) {
      out.add(path.join(meta.save_path, "**", "SteamData", "user_stats.ini"));
      out.add(path.join(meta.save_path, "**", "user_stats.ini"));
    }

    return Array.from(out);
  }

  function isExpectedMadnessPatchStateFile(meta, filePath) {
    const checkpointRoot = getMadnessPatchCheckpointRoot(meta);
    if (!checkpointRoot || !filePath) return false;
    const relative = path.relative(checkpointRoot, filePath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    const segments = relative.split(path.sep).filter(Boolean);
    return (
      segments.length === 2 &&
      segments[1].toLowerCase() === "achievements.txt"
    );
  }

  const evalDebounce = new Map(); // appid -> timeout
  const fileHitCooldown = new Map();
  const bootDashDebounce = { t: null, pending: false };

  async function evaluateFile(appid, meta, filePath, opts = {}) {
    const {
      initial = false,
      retry = false,
      forceEmptyPrev = false,
      isAddEvent = false,
      lumaPlayReadCache = null,
      preserveUnblockAutoSelectSuppression = false,
      seedOnly = false,
    } = opts || {};
    const isLumaPlay = isLumaPlayMeta(meta);
    if (!filePath && !isLumaPlay) return;
    const base = isLumaPlay ? "" : path.basename(filePath).toLowerCase();
    const isXenia = isXeniaMeta(meta);
    const isRpcs3 = isRpcs3Meta(meta);
    const isPs4 = isPs4Meta(meta);
    const isPs4ProgressXml = isPs4 && isPs4ProgressXmlPath(filePath);
    const isSteamOfficial = isSteamOfficialMeta(meta);
    const isGogOfficial = isGogOfficialMeta(meta);
    const isUbisoftOfficial = isUbisoftOfficialMeta(meta);
    const isEaOfficial = isEaOfficialMeta(meta);
    const isMarkerPatch = isMarkerPatchConfig(meta);
    const isMadnessPatch = isMadnessPatchConfig(meta);
    if (isLumaPlay) {
      // Registry-backed source; no file suffix checks.
    } else if (isXenia) {
      if (!isExpectedXeniaGpdFile(meta, appid, filePath)) return;
    } else if (isRpcs3) {
      if (base !== "tropusr.dat") return;
    } else if (isPs4) {
      if (base !== "trop.xml" && !isPs4ProgressXml) return;
    } else if (isGogOfficial) {
      if (base !== GAMEPLAY_DB_NAME) return;
    } else if (isUbisoftOfficial) {
      if (!base.endsWith(".spool")) return;
      const appidStr = String(meta?.appid || appid || "").toLowerCase();
      if (appidStr && base !== `${appidStr}.spool`) return;
    } else if (isEaOfficial) {
      if (base !== EA_VERBOSE_LOG_NAME.toLowerCase()) return;
    } else if (isSteamOfficial) {
      if (!base.endsWith(".bin") || !base.startsWith("usergamestats_")) return;
      const appidStr = String(meta?.appid || appid || "").toLowerCase();
      if (appidStr && !base.endsWith(`_${appidStr}.bin`)) return;
    } else if (isMarkerPatch) {
      const expectedStateFile = getMarkerPatchStateFile(meta);
      if (
        base !== "settings.txt" ||
        !expectedStateFile ||
        normalizePrefPath(filePath).toLowerCase() !==
          normalizePrefPath(expectedStateFile).toLowerCase()
      ) {
        return;
      }
    } else if (isMadnessPatch) {
      if (
        base !== "achievements.txt" ||
        !isExpectedMadnessPatchStateFile(meta, filePath)
      ) {
        return;
      }
    } else {
      if (
        base === "stats.ini" &&
        path.basename(path.dirname(filePath)).toLowerCase() !== "stats"
      ) {
        return;
      }
      if (
        ![
          "achievements.json",
          "achievements.ini",
          "stats.ini",
          "stats.bin",
          "user_stats.ini",
        ].includes(base)
      )
        return;
    }

    const now = Date.now();
    const hitKey = isLumaPlay
      ? `lumaplay:${String(appid || "")}:${String(meta?.name || "")}`
      : filePath;
    const last = fileHitCooldown.get(hitKey) || 0;
    if (now - last < 200) return;
    fileHitCooldown.set(hitKey, now);

    const key = String(appid);
    clearTimeout(evalDebounce.get(key));
    await new Promise((r) => {
      const t = setTimeout(r, 120);
      evalDebounce.set(key, t);
    });

    const cfgPath = path.join(configsDir, `${meta.name}.json`);
    await waitForFileExists(cfgPath);

    const snapKey = makeSnapshotKey(meta, appid, { filePath });
    const metaKey = isLumaPlay ? "" : getCacheMetaKey(meta, appid, filePath);
    let effectiveSnapshotSavePath = meta?.save_path || null;
    let fileStat = null;
    if (!isLumaPlay && bootMode && !forceEmptyPrev) {
      loadCacheMetaOnce();
      const cachedMeta = metaKey ? cacheMeta.get(metaKey) : null;
      if (cachedMeta && typeof cachedMeta === "object") {
        fileStat = await readFileStatSafe(filePath);
        const mtimeMs = Number(cachedMeta.mtimeMs ?? 0);
        const size = Number(cachedMeta.size ?? 0);
        if (
          fileStat &&
          Number.isFinite(mtimeMs) &&
          Number.isFinite(size) &&
          fileStat.mtimeMs === mtimeMs &&
          fileStat.size === size
        ) {
          if (!lastSnapshot.has(snapKey)) {
            try {
              const cached =
                typeof getCachedSnapshot === "function"
                  ? getCachedSnapshot(
                      meta?.name || appid,
                      meta?.platform || null,
                      {
                        savePath: filePath || meta?.save_path || null,
                        filePath,
                        shadps4UserId: getPs4UserIdFromProgressPath(filePath),
                        appid,
                      },
                    )
                  : null;
              if (cached && typeof cached === "object") {
                lastSnapshot.set(snapKey, cached);
              }
            } catch {}
          }
          if (lastSnapshot.has(snapKey)) return false;
        }
      }
    }
    let shouldSeed =
      seedOnly === true ||
      (typeof onSeedCache === "function" && !lastSnapshot.has(snapKey));
    // Tenoke: if the file appears after boot (add event), do not seed it so notifications can still fire
    if (
      shouldSeed &&
      seedOnly !== true &&
      meta.__tenoke &&
      isAddEvent &&
      !bootMode
    ) {
      shouldSeed = false;
    }
    const isActiveConfig = !!isConfigActive?.(meta.name);

    const prev = forceEmptyPrev ? {} : lastSnapshot.get(snapKey) || {};
    let cur = null;
    let parseOk = true;
    let parsedGpd = null;
    let parsedTrophy = null;
    let parsedSteam = null;
    if (isLumaPlay) {
      const parsed = readLumaPlayAchievementsSnapshot({
        appid: String(meta?.appid || appid || ""),
        configPath: meta?.config_path || "",
        preferredUser: meta?.lumaplay_user || "",
        preferredKeyPath:
          meta?.lumaplay_key_path || meta?.lumaplayKeyPath || "",
        previousSnapshot: prev,
        readCache: lumaPlayReadCache,
      });
      if (parsed?.found) {
        const parsedSnapshot =
          parsed?.snapshot &&
          typeof parsed.snapshot === "object" &&
          !Array.isArray(parsed.snapshot)
            ? parsed.snapshot
            : {};
        if (
          Object.keys(parsedSnapshot).length === 0 &&
          Object.keys(prev || {}).length > 0
        ) {
          cur = { ...prev };
        } else {
          cur = parsedSnapshot;
        }
        if (parsed.user && parsed.user !== meta?.lumaplay_user) {
          meta.lumaplay_user = parsed.user;
          try {
            const cfgPath = path.join(configsDir, `${meta.name}.json`);
            if (cfgPath && fs.existsSync(cfgPath)) {
              const raw = fs.readFileSync(cfgPath, "utf8");
              const data = JSON.parse(raw);
              if (data.lumaplay_user !== parsed.user) {
                data.lumaplay_user = parsed.user;
                fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
              }
            }
          } catch {}
        }
      } else {
        parseOk = false;
        cur = { ...prev };
      }
    } else if (isXenia) {
      try {
        parsedGpd = parseGpdFile(filePath);
        parsedGpd.appid = String(meta?.appid || appid || "");
        cur = buildSnapshotFromGpd(parsedGpd);
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isRpcs3) {
      const trophyDir =
        resolveRpcs3TrophyDirForMeta(meta) || path.dirname(filePath);
      try {
        parsedTrophy = parseTrophySetDir(trophyDir);
        parsedTrophy.appid = String(meta?.appid || appid || "");
        cur = buildSnapshotFromTrophy(parsedTrophy);
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isSteamOfficial) {
      try {
        const schemaPath = resolveAchievementsSchemaPath(meta);
        const schemaArr =
          schemaPath && fs.existsSync(schemaPath)
            ? readJsonSafe(schemaPath)
            : null;
        const statsDir = meta.save_path || path.dirname(filePath);
        let entries = normalizeAppcacheSchemaEntries(schemaArr);
        const schemaBin =
          statsDir && (meta.appid || appid)
            ? path.join(
                statsDir,
                `UserGameStatsSchema_${meta.appid || appid}.bin`,
              )
            : "";
        entries = enrichSchemaEntriesFromAppcacheSchemaFile(
          entries,
          schemaBin,
        );
        let userBin = filePath;
        const base = path.basename(userBin || "").toLowerCase();
        if (!base.startsWith("usergamestats_") || !base.endsWith(".bin")) {
          userBin = pickConfiguredSteamOfficialUserBin(
            statsDir,
            meta.appid || appid,
          );
        }
        if (entries.length && userBin && fs.existsSync(userBin)) {
          const kv = parseSteamKv(fs.readFileSync(userBin));
          const userStats = extractUserStats(kv.data);
          parsedSteam = userStats;
          cur = buildSnapshotFromAppcache(entries, userStats);
        } else {
          cur = prev;
        }
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isPs4) {
      const progressPath =
        (isPs4ProgressXml ? filePath : "") ||
        resolvePs4ProgressPathForMeta(meta);
      effectiveSnapshotSavePath = progressPath || meta?.save_path || null;
      const trophyDir =
        resolvePs4TrophyDirForMeta(meta) || path.dirname(filePath);
      try {
        if (progressPath && fs.existsSync(progressPath)) {
          cur = buildSnapshotFromPs4ProgressFile(progressPath, prev);
        } else {
          const parsedPs4 = parsePs4TrophySetDir(trophyDir);
          parsedPs4.appid = String(meta?.appid || appid || "");
          cur = buildSnapshotFromPs4(parsedPs4, prev);
        }
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isUbisoftOfficial) {
      try {
        const parsed = readUbisoftSpoolFile(filePath);
        cur = buildUbisoftOfficialSnapshot(parsed?.records || []);
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isEaOfficial) {
      try {
        cur = loadAchievementsFromSaveFile(path.dirname(filePath), prev, {
          configMeta: meta,
          fullSchemaPath: resolveAchievementsSchemaPath(meta),
        });
      } catch {
        parseOk = false;
        cur = prev;
      }
    } else if (isMarkerPatch) {
      const parsed = readMarkerPatchSnapshot(filePath, prev);
      if (parsed.valid) {
        cur = parsed.snapshot;
      } else {
        parseOk = false;
        cur = prev;
      }
    } else if (isMadnessPatch) {
      effectiveSnapshotSavePath = filePath;
      const parsed = readMadnessPatchSnapshot(filePath, prev);
      if (parsed.valid) {
        cur = parsed.snapshot;
      } else {
        parseOk = false;
        cur = prev;
      }
    } else {
      cur = loadAchievementsFromSaveFile(path.dirname(filePath), prev, {
        configMeta: meta,
        fullSchemaPath: resolveAchievementsSchemaPath(meta),
      });
    }
    const updateMetaFromStat = async () => {
      if (!parseOk || !metaKey) return;
      if (!fileStat) fileStat = await readFileStatSafe(filePath);
      if (fileStat) updateCacheMetaEntry(metaKey, fileStat);
    };
    if (!cur) return false;
    if (cur === prev) {
      await updateMetaFromStat();
      return retry ? false : "__retry__";
    }
    lastSnapshot.set(snapKey, cur);
    await updateMetaFromStat();

    if (parsedGpd && meta?.config_path) {
      try {
        updateSchemaFromGpd(meta.config_path, parsedGpd);
      } catch {}
    }
    if (parsedTrophy && meta?.config_path) {
      try {
        updateSchemaFromTrophy(meta.config_path, parsedTrophy);
      } catch {}
    }
    if (isPs4 && meta?.config_path) {
      try {
        const parsedPs4 = parsePs4TrophySetDir(
          resolvePs4TrophyDirForMeta(meta) || path.dirname(filePath),
        );
        updateSchemaFromPs4(meta.config_path, parsedPs4);
      } catch {}
    }

    if (!preserveUnblockAutoSelectSuppression) {
      // Drop only this config's suppression after a real post-unblock change.
      releaseUnblockSuppression(appid, meta);
    }

    const isFirstSeed =
      initial && !forceEmptyPrev && Object.keys(prev || {}).length === 0;
    if (isFirstSeed && bootMode) {
      if (typeof onSeedCache === "function") {
        try {
          onSeedCache({
            appid: String(appid),
            configName: meta.name,
            platform: meta?.platform || null,
            savePath: effectiveSnapshotSavePath,
            snapshot: cur,
          });
        } catch {}
      }
      return false;
    }

    // Platinum check (schema-aware)
    const schemaPath = resolveAchievementsSchemaPath(meta);
    const schemaArr =
      schemaPath && fs.existsSync(schemaPath) ? readJsonSafe(schemaPath) : null;
    const schemaNames = Array.isArray(schemaArr)
      ? schemaArr
          .map((a) => (a && a.name ? String(a.name) : null))
          .filter(Boolean)
      : [];
    const hasSchema = schemaNames.length > 0;

    const isEarnedByName = (name) => {
      if (!name) return false;
      if (cur?.[name]?.earned) return true;
      if (/^ach_/i.test(name)) {
        const alt = name.replace(/^ach_/i, "");
        return !!cur?.[alt]?.earned;
      }
      const withPrefix = `ach_${name}`;
      return !!cur?.[withPrefix]?.earned;
    };

    let earnedCount = 0;
    let total = 0;
    if (hasSchema) {
      total = schemaNames.length;
      earnedCount = schemaNames.filter(isEarnedByName).length;
    }
    const isFull = hasSchema && total > 0 && earnedCount === total;

    const platinumKey = String(appid);
    const alreadyPlatinum =
      meta.platinum === true ||
      platinumNotified.has(meta.name) ||
      platinumNotifiedByApp.has(platinumKey);
    const completedPlatinumThisPass = isFull && !alreadyPlatinum;
    if (isFull && !alreadyPlatinum) {
      // persist flag once
      const cfgFile =
        configsDir && meta?.name
          ? path.join(configsDir, `${meta.name}.json`)
          : null;
      if (cfgFile && fs.existsSync(cfgFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
          data.platinum = true;
          fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2));
          meta.platinum = true;
        } catch {}
      } else {
        meta.platinum = true;
      }

      platinumNotified.add(meta.name);
      platinumNotifiedByApp.add(platinumKey);
      if (meta?.native_platinum !== true) {
        try {
          onPlatinumComplete?.({
            appid: String(appid),
            configName: meta.name,
            snapshot: cur,
            savePath: meta.save_path || null,
            configPath: meta.config_path || null,
            isActive: isActiveConfig,
          });
        } catch {}
      } else {
        watcherLogger.info("platinum:native-achievement", {
          appid: String(appid),
          config: meta?.name || null,
        });
      }
    }

    if (pendingAutoSelect.has(meta.name) && isConfigActive?.(meta.name)) {
      pendingAutoSelect.delete(meta.name);
      autoSelectEmitted.delete(meta.name);
    }
    const prevWasEmpty = Object.keys(prev || {}).length === 0;
    const localPatchWatcherOwnsNotifications = isMarkerPatch || isMadnessPatch;
    if (
      !initial &&
      isActiveConfig &&
      !localPatchWatcherOwnsNotifications &&
      !forceEmptyPrev &&
      !prevWasEmpty
    ) {
      return false;
    }
    if (shouldSeed) {
      try {
        onSeedCache({
          appid: String(appid),
          configName: meta.name,
          platform: meta?.platform || null,
          savePath: effectiveSnapshotSavePath,
          snapshot: cur,
        });
      } catch {}
      bootDashDebounce.pending = true;
      clearTimeout(bootDashDebounce.t);
      bootDashDebounce.t = setTimeout(() => {
        if (bootDashDebounce.pending) {
          bootDashDebounce.pending = false;
          try {
            emitDashboardRefresh();
          } catch {}
        }
      }, 150);
      return false;
    }

    watcherLogger.info("initial-notify:eval-snapshot", {
      appid: String(appid),
      config: meta.name,
      entries: Object.keys(cur || {}).length,
      earned: Object.values(cur || {}).filter((x) => x?.earned).length,
      initial,
      retry,
    });

    const lang = readPrefsSafe().language || "english";
    let touched = false;
    for (const [achKey, nowVal] of Object.entries(cur)) {
      const oldVal = prev[achKey];
      const becameEarned = nowVal.earned && (!oldVal || !oldVal.earned);
      const nowProgress = Number(nowVal?.progress);
      const nowMax = Number(nowVal?.max_progress);
      const oldProgress = Number(oldVal?.progress);
      const oldMax = Number(oldVal?.max_progress);
      const hasProgressValues =
        Number.isFinite(nowProgress) && Number.isFinite(nowMax) && nowMax > 0;
      const hasOldProgressValues =
        Number.isFinite(oldProgress) && Number.isFinite(oldMax) && oldMax > 0;
      const progressChanged =
        !nowVal.earned &&
        hasProgressValues &&
        (hasOldProgressValues
          ? nowProgress !== oldProgress || nowMax !== oldMax
          : nowProgress > 0);
      if (initial) {
        watcherLogger.info("initial-notify:entry-check", {
          appid: String(appid),
          config: meta.name,
          key: achKey,
          nowEarned: nowVal?.earned,
          oldEarned: oldVal?.earned,
          nowProgress: nowVal?.progress,
          oldProgress: oldVal?.progress,
          becameEarned,
          progressChanged,
          active: isActiveConfig,
        });
      }
      if (!becameEarned && !progressChanged) continue;
      if (
        becameEarned &&
        (isRpcs3 || isLumaPlay || isMarkerPatch || isMadnessPatch)
      ) {
        if (!nowVal.earned_time) nowVal.earned_time = Date.now();
      }
      if (
        !initial &&
        isActiveConfig &&
        !localPatchWatcherOwnsNotifications &&
        !forceEmptyPrev &&
        !prevWasEmpty
      )
        continue;
      touched = true;
      const cfgEntry = getConfigEntry(meta, achKey);
      const trophyType = String(
        cfgEntry?.trophyType || cfgEntry?.trophy_type || "",
      )
        .trim()
        .toLowerCase();
      if (
        becameEarned &&
        completedPlatinumThisPass &&
        (isRpcs3 || isPs4) &&
        (trophyType === "platinum" || trophyType === "p")
      ) {
        watcherLogger.info("earned-skip:platinum-trophy-completion-duplicate", {
          appid: String(appid),
          config: meta?.name || null,
          achievement: achKey,
        });
        continue;
      }
      if (!initial && isActiveConfig && !localPatchWatcherOwnsNotifications) {
        continue;
      }
      if (becameEarned && onEarned) {
        watcherLogger.info("earned-detected", {
          appid: String(appid),
          config: meta?.name || null,
          achievement: achKey,
        });
        if (isXenia) {
          let imageId =
            cfgEntry?.imageId !== undefined && cfgEntry?.imageId !== null
              ? cfgEntry.imageId
              : resolveXeniaImageId(parsedGpd, achKey);
          if (imageId === undefined || imageId === null) {
            watcherLogger.warn("xenia:notify:no-image-id", {
              appid: String(meta?.appid || appid || ""),
              config: meta?.name || null,
              achievement: String(achKey),
            });
            continue;
          }
          const ready = await waitForXeniaAchievementIcon(
            meta,
            achKey,
            imageId,
            parsedGpd,
            resolveGpdPathForMeta,
          );
          if (!ready) continue;
        }
        onEarned({
          name: String(cfgEntry?.name || achKey),
          displayName: cfgEntry
            ? getSafeLocalizedText(cfgEntry.displayName, lang)
            : achKey,
          description: cfgEntry
            ? getSafeLocalizedText(cfgEntry.description, lang)
            : "",
          icon: cfgEntry?.icon || "",
          icon_gray: cfgEntry?.icon_gray || cfgEntry?.icongray || "",
          appid: String(meta?.appid || appid || ""),
          platform: meta?.platform || "",
          config_path: meta.config_path || null,
          configName: meta?.name || null,
          rarityPct: cfgEntry?.rarityPct,
          raritySource: cfgEntry?.raritySource,
          trophyType: cfgEntry?.trophyType || cfgEntry?.trophy_type,
          preset: null,
          position: null,
          sound: null,
          skipScreenshot: false,
          isTest: false,
        });
      }

      if (
        progressChanged &&
        onProgress &&
        !(
          isConfigActive?.(meta.name) &&
          !localPatchWatcherOwnsNotifications &&
          !forceEmptyPrev &&
          !prevWasEmpty
        )
      ) {
        watcherLogger.info("progress-detected", {
          appid: String(appid),
          config: meta?.name || null,
          achievement: achKey,
          progress: nowVal.progress || 0,
          max: nowVal.max_progress || 0,
        });
        onProgress({
          displayName: cfgEntry
            ? getSafeLocalizedText(cfgEntry.displayName, lang)
            : achKey,
          icon: cfgEntry?.icon || "",
          progress: nowVal.progress || 0,
          max_progress: nowVal.max_progress || 0,
          config_path: meta.config_path || null,
          configName: meta?.name || null,
        });
      }
    }
    // avoid double persistence on the initial boot/read (already done in seedInitialSnapshot)
    if (touched && !initial && typeof onSeedCache === "function") {
      try {
        onSeedCache({
          appid: String(appid),
          configName: meta.name,
          platform: meta?.platform || null,
          savePath: effectiveSnapshotSavePath,
          snapshot: cur,
        });
      } catch {}
    }
    return touched;
  }

  function getActiveLumaPlayWatcherEntries() {
    const entries = [];
    for (const bucket of appidSaveWatchers.values()) {
      if (!(bucket instanceof Map)) continue;
      for (const watcher of bucket.values()) {
        if (!watcher?.isLumaPlayEventWatcher) continue;
        if (watcher.closed) continue;
        if (!watcher.meta || !watcher.appid) continue;
        entries.push(watcher);
      }
    }
    return entries;
  }

  function mergeLumaPlayDiscoveryOptions(previous = {}, next = {}) {
    return {
      autoRebuild:
        previous?.autoRebuild !== false || next?.autoRebuild !== false,
    };
  }

  function clearLumaPlayDiscoveryTimer() {
    if (lumaPlayDiscoveryTimer) {
      clearTimeout(lumaPlayDiscoveryTimer);
      lumaPlayDiscoveryTimer = null;
    }
  }

  function scheduleLumaPlayDiscoveryTick(
    options = {},
    delayMs = LUMAPLAY_DISCOVERY_DEBOUNCE_MS,
  ) {
    if (process.platform !== "win32") return;
    lumaPlayDiscoveryScheduledOptions = mergeLumaPlayDiscoveryOptions(
      lumaPlayDiscoveryScheduledOptions || {},
      options || {},
    );
    if (bootMode || rescanInProgress.value || lumaPlayDiscoveryRunning) {
      lumaPlayDiscoveryPending = true;
      return;
    }
    clearLumaPlayDiscoveryTimer();
    lumaPlayDiscoveryTimer = setTimeout(
      () => {
        lumaPlayDiscoveryTimer = null;
        const scheduledOptions = lumaPlayDiscoveryScheduledOptions || {};
        lumaPlayDiscoveryScheduledOptions = null;
        runLumaPlayDiscoveryTick(scheduledOptions).catch(() => {});
      },
      Math.max(0, Number(delayMs) || 0),
    );
  }

  async function evaluateLumaPlayWatcherEntry(
    entry,
    { initial = false, retry = false, lumaPlayReadCache = null } = {},
  ) {
    if (!entry || entry.closed) return;
    if (entry.running) {
      entry.pending = true;
      return;
    }
    entry.running = true;
    try {
      const result = await evaluateFile(entry.appid, entry.meta, "", {
        initial,
        retry,
        forceEmptyPrev: false,
        isAddEvent: false,
        lumaPlayReadCache,
      });
      if (result === "__retry__") {
        if (!entry.retryTimer && !entry.closed) {
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            evaluateLumaPlayWatcherEntry(entry, {
              initial,
              retry: true,
            }).catch(() => {});
          }, 250);
        }
        return;
      }
      if (result) {
        try {
          broadcastAll("refresh-achievements-table");
          broadcastAll("achievements:file-updated", {
            appid: String(entry.appid),
            configName: entry.meta?.name || null,
          });
        } catch {}
        if (
          !bootMode &&
          !isRecentlyUnblocked(entry.appid, entry.meta) &&
          !isAutoSelectSuppressedForMeta(entry.appid, entry.meta)
        ) {
          setTimeout(() => enqueueAutoSelect(entry.meta), 0);
        }
      } else if (initial) {
        try {
          broadcastAll("refresh-achievements-table");
        } catch {}
      }
    } catch {
    } finally {
      entry.running = false;
      if (entry.pending && !entry.closed) {
        entry.pending = false;
        setTimeout(() => {
          evaluateLumaPlayWatcherEntry(entry).catch(() => {});
        }, 0);
      }
    }
  }

  async function runLumaPlayDiscoveryTick(options = {}) {
    if (process.platform !== "win32") return;
    if (!isLumaPlayWatcherEnabled()) {
      lumaPlayDiscoveryPending = false;
      stopLumaPlayDiscoveryPolling();
      return;
    }
    if (bootMode || rescanInProgress.value) {
      lumaPlayDiscoveryPending = true;
      return;
    }
    if (lumaPlayDiscoveryRunning) {
      lumaPlayDiscoveryPending = true;
      return;
    }
    lumaPlayDiscoveryRunning = true;
    try {
      do {
        lumaPlayDiscoveryPending = false;
        clearLumaPlayReadCache();
        const lumaPlayReadCache = new Map();
        await scanLumaPlayRegistryOnce({
          suppressInitialNotify: true,
          autoRebuild: options.autoRebuild !== false,
          lumaPlayReadCache,
        });
        const entries = getActiveLumaPlayWatcherEntries();
        for (const entry of entries) {
          await evaluateLumaPlayWatcherEntry(entry, {
            initial: false,
            retry: false,
            lumaPlayReadCache,
          });
        }
      } while (
        lumaPlayDiscoveryPending &&
        !bootMode &&
        !rescanInProgress.value
      );
    } catch (err) {
      watcherLogger.warn("lumaplay:realtime-event-failed", {
        error: err?.message || String(err),
      });
    } finally {
      lumaPlayDiscoveryRunning = false;
      if (lumaPlayDiscoveryPending && !bootMode && !rescanInProgress.value) {
        scheduleLumaPlayDiscoveryTick(options);
      }
    }
  }

  function runInitialSeedForMeta(id, meta, candidates, options = {}) {
    const suppressInitialNotify = options.suppressInitialNotify === true;
    const bornInBoot = options.bornInBoot === true;
    const xeniaTargetBeforeSeed = isXeniaMeta(meta)
      ? pickExistingSeedTargetForMeta(meta, candidates)
      : "";
    let xeniaCachedBeforeSeed = null;
    if (xeniaTargetBeforeSeed && typeof getCachedSnapshot === "function") {
      try {
        const cached = getCachedSnapshot(
          meta?.name || id,
          meta?.platform || null,
          {
            appid: id,
            filePath: xeniaTargetBeforeSeed,
            savePath: xeniaTargetBeforeSeed || meta?.save_path || null,
          },
        );
        if (cached && typeof cached === "object" && !Array.isArray(cached)) {
          xeniaCachedBeforeSeed = cached;
        }
      } catch {}
    }
    seedInitialSnapshot(id, meta, candidates, true, {
      suppressInitialNotify,
      bornInBoot,
    });
    if (pendingInitialNotify.has(meta.name)) {
      const existingTarget =
        xeniaTargetBeforeSeed || pickExistingSeedTargetForMeta(meta, candidates);
      pendingInitialNotify.delete(meta.name);
      if (existingTarget) {
        const preferredMeta = pickMetaForPath(id, existingTarget) || meta;
        const fromUnblock = isRecentlyUnblocked(id, preferredMeta);
        setTimeout(() => {
          (async () => {
            watcherLogger.info("initial-notify:attempt", {
              appid: id,
              config: preferredMeta.name,
              target: existingTarget,
            });
            const doEval = async (retryFlag = false) => {
              const isXeniaInitialNotify = isXeniaMeta(preferredMeta);
              if (isXeniaInitialNotify && xeniaCachedBeforeSeed) {
                lastSnapshot.set(
                  makeSnapshotKey(preferredMeta, id, {
                    filePath: existingTarget,
                    savePath: existingTarget,
                  }),
                  xeniaCachedBeforeSeed,
                );
              }
              const evalOpts = {
                initial: true,
                retry: retryFlag,
                forceEmptyPrev: fromUnblock
                  ? false
                  : isXeniaInitialNotify
                    ? !xeniaCachedBeforeSeed
                    : true,
                preserveUnblockAutoSelectSuppression: fromUnblock,
              };
              const result = await evaluateFile(
                id,
                preferredMeta,
                existingTarget,
                evalOpts,
              );
              watcherLogger.info("initial-notify:result", {
                appid: id,
                config: preferredMeta.name,
                result,
                retry: retryFlag,
                fromUnblock,
              });
              if (result === "__retry__") {
                await sleep(1000);
                return await doEval(true);
              }
              return result;
            };

            const evalResult = await doEval();

            if (fromUnblock) {
              watcherLogger.info("auto-select:skip-unblock-reseed", {
                appid: id,
                config: preferredMeta.name,
              });
              return;
            }

            if (
              evalResult === true &&
              !bootMode &&
              !isConfigActive?.(preferredMeta.name) &&
              !pendingAutoSelect.has(preferredMeta.name) &&
              !isAutoSelectSuppressedForMeta(id, preferredMeta)
            ) {
              enqueueAutoSelect(preferredMeta);
            }
          })();
        });
      } else {
        watcherLogger.info("initial-notify:no-target", {
          appid: id,
          config: meta.name,
          candidates: candidates.length,
        });
      }
    }
  }

  function getDeferredSeedOverlayGateDelayMs() {
    if (deferredSeedOverlayGateDone) return 0;
    const now = Date.now();

    if (global.bootOverlayHidden === true) {
      if (!deferredSeedOverlayHiddenSeenAt) {
        deferredSeedOverlayHiddenSeenAt = now;
      }
      const elapsedSinceOverlayHidden = now - deferredSeedOverlayHiddenSeenAt;
      const remainingMs =
        BOOT_DEFERRED_SEED_AFTER_OVERLAY_HIDE_DELAY_MS -
        elapsedSinceOverlayHidden;
      if (remainingMs <= 0) {
        deferredSeedOverlayGateDone = true;
        watcherLogger.info("deferred-seed:overlay-gate-open", {
          reason: "overlay-hidden",
          delayMs: BOOT_DEFERRED_SEED_AFTER_OVERLAY_HIDE_DELAY_MS,
        });
        return 0;
      }
      return remainingMs;
    }

    if (!deferredSeedOverlayWaitStartedAt) {
      deferredSeedOverlayWaitStartedAt = now;
    }
    const waitedMs = now - deferredSeedOverlayWaitStartedAt;
    if (waitedMs >= BOOT_DEFERRED_SEED_OVERLAY_WAIT_MAX_MS) {
      deferredSeedOverlayGateDone = true;
      if (!deferredSeedOverlayWaitWarned) {
        deferredSeedOverlayWaitWarned = true;
        watcherLogger.warn("deferred-seed:overlay-gate-timeout", {
          waitedMs,
          maxMs: BOOT_DEFERRED_SEED_OVERLAY_WAIT_MAX_MS,
        });
      }
      return 0;
    }
    return BOOT_DEFERRED_SEED_OVERLAY_POLL_MS;
  }

  function scheduleDeferredSeedPumpAfterOverlayGate() {
    const gateDelayMs = getDeferredSeedOverlayGateDelayMs();
    scheduleDeferredSeedPump(gateDelayMs > 0 ? gateDelayMs : 0);
  }

  function scheduleDeferredSeedPump(delayMs = 0) {
    if (deferredSeedPumpTimer) return;
    deferredSeedPumpTimer = setTimeout(
      () => {
        deferredSeedPumpTimer = null;
        pumpDeferredSeedQueue().catch(() => {});
      },
      Math.max(0, Number(delayMs) || 0),
    );
  }

  function queueDeferredSeed(task) {
    const bornInBoot = task?.bornInBoot === true;
    const configName = String(task?.meta?.name || "");
    if (!configName) {
      runInitialSeedForMeta(task?.id, task?.meta, task?.candidates || [], {
        suppressInitialNotify: task?.suppressInitialNotify === true,
        bornInBoot,
      });
      return;
    }
    if (
      deferredSeedByConfig.has(configName) ||
      deferredSeedPendingConfigs.has(configName) ||
      deferredSeedActiveConfigs.has(configName)
    ) {
      return;
    }
    deferredSeedByConfig.set(configName, {
      ...task,
      bornInBoot,
    });
    deferredSeedQueue.push(configName);
    deferredSeedPendingConfigs.add(configName);
    scheduleDeferredSeedPump(bootMode ? 200 : 0);
  }

  function flushDeferredSeedForConfig(configName) {
    const key = String(configName || "");
    if (!key) return false;
    if (deferredSeedActiveConfigs.has(key)) return "__active__";
    const task = deferredSeedByConfig.get(key);
    if (!task) {
      deferredSeedPendingConfigs.delete(key);
      return false;
    }
    deferredSeedByConfig.delete(key);
    try {
      runInitialSeedForMeta(task.id, task.meta, task.candidates || [], {
        suppressInitialNotify: task.suppressInitialNotify === true,
        bornInBoot: task.bornInBoot === true,
      });
    } finally {
      deferredSeedPendingConfigs.delete(key);
    }
    return true;
  }

  async function pumpDeferredSeedQueue() {
    if (deferredSeedPumpRunning) return;
    if (!deferredSeedQueue.length) return;
    if (bootMode && global.bootUiReady !== true) {
      scheduleDeferredSeedPump(250);
      return;
    }
    const gateDelayMs = getDeferredSeedOverlayGateDelayMs();
    if (gateDelayMs > 0) {
      scheduleDeferredSeedPump(gateDelayMs);
      return;
    }
    deferredSeedPumpRunning = true;
    const yieldIfNeeded = createTimeSlicer(BOOT_ATTACH_SLICE_MS);
    try {
      while (deferredSeedQueue.length) {
        const configName = deferredSeedQueue.shift();
        if (!configName) continue;
        const task = deferredSeedByConfig.get(configName);
        if (!task) continue;
        if (deferredSeedActiveConfigs.has(configName)) continue;
        deferredSeedByConfig.delete(configName);
        deferredSeedActiveConfigs.add(configName);
        try {
          runInitialSeedForMeta(task.id, task.meta, task.candidates || [], {
            suppressInitialNotify: task.suppressInitialNotify === true,
            bornInBoot: task.bornInBoot === true,
          });
        } finally {
          deferredSeedPendingConfigs.delete(configName);
          deferredSeedActiveConfigs.delete(configName);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
        if (DEFERRED_SEED_ITEM_DELAY_MS > 0) {
          await sleep(DEFERRED_SEED_ITEM_DELAY_MS);
        }
      }
    } finally {
      deferredSeedPumpRunning = false;
      if (deferredSeedQueue.length) scheduleDeferredSeedPump(100);
    }
  }

  function attachSaveWatcherForAppId(appid, options = {}) {
    const suppressInitialNotify = options.suppressInitialNotify === true;
    const deferInitialSeed = options.deferInitialSeed === true;
    const deferLumaPlayPolling = options.deferLumaPlayPolling === true;
    appid = String(appid);
    const metas = getConfigMetas(appid);
    if (!metas.length) return;
    metas.forEach((meta) =>
      attachWatcherForMeta(meta, {
        suppressInitialNotify,
        deferInitialSeed,
        deferLumaPlayPolling,
      }),
    );
  }

  function attachWatcherForMeta(meta, options = {}) {
    const suppressInitialNotify = options.suppressInitialNotify === true;
    const deferInitialSeed = options.deferInitialSeed === true;
    const deferLumaPlayPolling = options.deferLumaPlayPolling === true;
    const isLumaPlay = isLumaPlayMeta(meta);
    const isMarkerPatch = isMarkerPatchConfig(meta);
    const isMadnessPatch = isMadnessPatchConfig(meta);
    if (
      !meta?.save_path &&
      !isLumaPlay &&
      !isMarkerPatch &&
      !isMadnessPatch
    )
      return;
    const appid = String(meta.appid);
    const bucket = ensureWatcherBucket(appid);
    if (bucket.has(meta.name)) return;

    if (isMarkerPatch || isMadnessPatch) {
      const targetPath = isMarkerPatch
        ? getMarkerPatchStateFile(meta)
        : getMadnessPatchCheckpointRoot(meta);
      if (!targetPath) return;
      let operation = Promise.resolve();
      const enqueueOperation = (task) => {
        operation = operation.then(task, task).catch((error) => {
          watcherLogger.warn("local-patch:evaluate-failed", {
            appid,
            config: meta?.name || null,
            platform: meta?.platform || null,
            error: error?.message || String(error),
          });
        });
        return operation;
      };
      const evaluateLocalPatchFile = async (
        filePath,
        initial,
        useCachedBaseline = false,
      ) => {
        if (!filePath || !fs.existsSync(filePath)) return false;
        if (initial && useCachedBaseline && typeof getCachedSnapshot === "function") {
          const snapKey = makeSnapshotKey(meta, appid, { filePath });
          if (!lastSnapshot.has(snapKey)) {
            try {
              const cached = getCachedSnapshot(
                meta?.name || appid,
                meta?.platform || null,
                { savePath: filePath, filePath, appid },
              );
              if (
                cached &&
                typeof cached === "object" &&
                !Array.isArray(cached)
              ) {
                lastSnapshot.set(snapKey, cached);
              }
            } catch {}
          }
        }
        let result = await evaluateFile(appid, meta, filePath, {
          initial: initial === true,
          retry: false,
          isAddEvent: initial === true,
          seedOnly: initial === true,
        });
        if (result === "__retry__") {
          await sleep(350);
          result = await evaluateFile(appid, meta, filePath, {
            initial: initial === true,
            retry: true,
            isAddEvent: initial === true,
            seedOnly: initial === true,
          });
        }
        broadcastAll("refresh-achievements-table");
        emitDashboardRefresh();
        if (result === true) {
          broadcastAll("achievements:file-updated", {
            appid,
            configName: meta?.name || null,
          });
          if (
            !bootMode &&
            !isRecentlyUnblocked(appid, meta) &&
            !isAutoSelectSuppressedForMeta(appid, meta)
          ) {
            setTimeout(() => enqueueAutoSelect(meta), 0);
          }
        }
        return result;
      };

      const adaptiveWatcher = createAdaptivePathWatcher({
        targetPath,
        targetType: isMadnessPatch ? "directory" : "file",
        pollIntervalMs: 1000,
        watcherOptions: {
          awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
          depth: isMadnessPatch ? 2 : undefined,
        },
        onAvailable: () => {
          enqueueOperation(async () => {
            if (isMarkerPatch) {
              await evaluateLocalPatchFile(targetPath, true, true);
              watcherLogger.info("markerpatch:state-available", {
                appid,
                config: meta?.name || null,
                stateFile: targetPath,
              });
              return;
            }
            const states = listMadnessPatchStateFiles(targetPath).reverse();
            for (let index = 0; index < states.length; index += 1) {
              await evaluateLocalPatchFile(
                states[index].filePath,
                true,
                index === states.length - 1,
              );
            }
            watcherLogger.info("madnesspatch:checkpoint-available", {
              appid,
              config: meta?.name || null,
              checkpointRoot: targetPath,
              profiles: states.length,
            });
          });
        },
        onUnavailable: (_missingPath, state) => {
          watcherLogger.info("local-patch:state-unavailable", {
            appid,
            config: meta?.name || null,
            platform: meta?.platform || null,
            targetPath,
            reason: state?.reason || "missing",
          });
        },
        onEvent: (event, filePath) => {
          if (event !== "add" && event !== "change") return;
          if (isMarkerPatch) {
            if (
              normalizePrefPath(filePath).toLowerCase() !==
              normalizePrefPath(targetPath).toLowerCase()
            ) {
              return;
            }
          } else if (!isExpectedMadnessPatchStateFile(meta, filePath)) {
            return;
          }
          enqueueOperation(() =>
            evaluateLocalPatchFile(filePath, event === "add"),
          );
        },
        onError: (error, state) => {
          watcherLogger.warn("local-patch:adaptive-watch-error", {
            appid,
            config: meta?.name || null,
            platform: meta?.platform || null,
            targetPath,
            phase: state?.phase || null,
            error: error?.message || String(error),
          });
        },
      });
      bucket.set(meta.name, adaptiveWatcher);
      watcherLogger.info("watch-save-local-patch", {
        appid,
        config: meta?.name || null,
        platform: meta?.platform || null,
        targetPath,
        targetType: isMadnessPatch ? "directory" : "file",
        adaptive: true,
      });
      return;
    }

    if (isLumaPlay) {
      if (!isLumaPlayWatcherEnabled()) return;
      const entry = {
        appid: String(appid),
        meta,
        closed: false,
        running: false,
        pending: false,
        retryTimer: null,
        isLumaPlayEventWatcher: true,
        close: async () => {
          entry.closed = true;
          if (entry.retryTimer) {
            clearTimeout(entry.retryTimer);
            entry.retryTimer = null;
          }
        },
      };
      bucket.set(meta.name, entry);
      const shouldSuppressInitialSeed =
        suppressInitialNotify || bootMode || deferInitialSeed;
      if (shouldSuppressInitialSeed) {
        seedInitialSnapshot(appid, meta, [], true, {
          suppressInitialNotify: true,
          bornInBoot: bootMode,
        });
      } else {
        evaluateLumaPlayWatcherEntry(entry, {
          initial: false,
          retry: false,
        }).catch(() => {});
      }
      watcherLogger.info("watch-lumaplay", {
        appid,
        config: meta?.name || null,
        mode: "event",
      });
      if (!deferLumaPlayPolling) {
        startLumaPlayDiscoveryPolling();
      }
      return;
    }

    if (isSteamOfficialMeta(meta)) {
      const statsDir = meta.save_path || "";
      const statsNorm = normalizePrefPath(statsDir).toLowerCase();
      if (statsNorm && !steamOfficialSeedOnlyLogged.has(statsNorm)) {
        steamOfficialSeedOnlyLogged.add(statsNorm);
        watcherLogger.info("watch-save-steam-official-root", {
          savePath: statsDir,
          mode: "root-folder-events",
        });
      }

      const placeholder = {
        close: async () => {},
      };
      bucket.set(meta.name, placeholder);

      const id = String(appid);
      const candidates = [];
      const schemaBin =
        statsDir && meta.appid
          ? path.join(statsDir, `UserGameStatsSchema_${meta.appid}.bin`)
          : "";
      if (schemaBin) candidates.push(schemaBin);
      const userBin = statsDir
        ? pickConfiguredSteamOfficialUserBin(statsDir, meta.appid || id)
        : "";
      if (userBin) candidates.unshift(userBin);

      const shouldSuppressInitialSeed =
        suppressInitialNotify || bootMode || deferInitialSeed;
      if (deferInitialSeed) {
        queueDeferredSeed({
          id,
          meta,
          candidates,
          suppressInitialNotify: shouldSuppressInitialSeed,
          bornInBoot: bootMode,
        });
      } else {
        runInitialSeedForMeta(id, meta, candidates, {
          suppressInitialNotify: shouldSuppressInitialSeed,
        });
      }
      return;
    }

    let targets = getSaveWatchTargets(meta);
    let hasExistingTarget = targets.some((t) => t && fs.existsSync(t));

    const startedInBoot = bootMode;
    let tenokeRelinked = false;

    // Tenoke: search deeper for user_stats.ini if not already present at save_path
    const searchTenokeStats = async () => {
      const names = new Set([
        "user_stats.ini",
        path.join("SteamData", "user_stats.ini"),
      ]);
      const maxDepth = 6;
      const stack = [{ dir: meta.save_path, depth: 0 }];

      // If current save_path already has user_stats.ini, reuse it
      try {
        const direct = [
          path.join(meta.save_path, "user_stats.ini"),
          path.join(meta.save_path, "SteamData", "user_stats.ini"),
        ];
        for (const candidate of direct) {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        /* ignore */
      }

      while (stack.length) {
        const { dir, depth } = stack.pop();
        if (depth > maxDepth) continue;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isFile() && names.has(ent.name.toLowerCase())) {
            return full;
          }
          if (ent.isDirectory()) {
            stack.push({ dir: full, depth: depth + 1 });
          }
        }
      }
      return null;
    };

    if (meta.__tenoke === true || tenokeIds.has(String(meta.appid || ""))) {
      const found = searchTenokeStats();
      if (found && typeof found.then === "function") {
        found
          .then(async (fp) => {
            if (!fp) return;
            const dir = path.dirname(fp);
            const prevSave = meta.save_path || "";
            // If save_path already matches and watcher is linked, skip relink
            const alreadyLinked =
              prevSave &&
              path.normalize(prevSave) === path.normalize(dir) &&
              tenokeRelinkedConfigs.has(meta.name);
            if (alreadyLinked) return;
            try {
              const cfgPath = path.join(configsDir, `${meta.name}.json`);
              const raw = fs.readFileSync(cfgPath, "utf8");
              const data = JSON.parse(raw);
              data.save_path = dir;
              data.tenokeLinked = true;
              fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
              meta.save_path = dir;
              meta.__tenoke = true;
              targets = getSaveWatchTargets(meta);
              if (prevSave && prevSave !== dir) {
                replaceWatchedFolder(prevSave, dir);
              }
              // Trigger one evaluation when we discover the file
              if (!startedInBoot) {
                try {
                  const evalResult = await evaluateFile(appid, meta, fp, {
                    initial: false,
                    retry: false,
                    forceEmptyPrev: true,
                  });
                  if (
                    !bootMode &&
                    evalResult &&
                    !isRecentlyUnblocked(appid, meta)
                  ) {
                    const tenokeReady =
                      meta.__tenoke !== true ||
                      tenokeRelinkedConfigs.has(meta.name);
                    if (tenokeReady) enqueueAutoSelect(meta);
                  }
                } catch {}
              }
              // Re-arm watcher on the updated path once
              if (!tenokeRelinked && !tenokeRelinkedConfigs.has(meta.name)) {
                tenokeRelinked = true;
                tenokeRelinkedConfigs.add(meta.name);
                const existingWatcher = bucket.get(meta.name);
                if (existingWatcher) {
                  try {
                    existingWatcher.close();
                  } catch {}
                  bucket.delete(meta.name);
                }
                attachWatcherForMeta(meta, {
                  suppressInitialNotify: true,
                  deferInitialSeed,
                });
                return;
              }
            } catch {}
          })
          .catch(() => {});
      }
    }

    const locateAndPersistSavePath = () => {
      const isXenia = isXeniaMeta(meta);
      const expectedXeniaGpd = isXenia
        ? getExpectedXeniaGpdBaseName(meta, appid)
        : "";
      const names = [
        "achievements.ini",
        "achievements.json",
        "stats.ini",
        "stats.bin",
        "user_stats.ini",
      ];
      const targetLc = names.map((n) => n.toLowerCase());
      const stack = [{ dir: meta.save_path, depth: 0 }];
      const maxDepth = 6;
      while (stack.length) {
        const { dir, depth } = stack.pop();
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const ent of entries) {
            if (
              ent.isFile() &&
              ((isXenia &&
                ent.name.toLowerCase().endsWith(".gpd") &&
                (!expectedXeniaGpd ||
                  ent.name.toLowerCase() === expectedXeniaGpd)) ||
                (!isXenia &&
                  targetLc.includes(ent.name.toLowerCase()) &&
                  (ent.name.toLowerCase() !== "stats.ini" ||
                    path.basename(dir).toLowerCase() === "stats")))
            ) {
              return path.join(dir, ent.name);
            }
          }
          if (depth < maxDepth) {
            for (const ent of entries) {
              if (ent.isDirectory()) {
                stack.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
              }
            }
          }
        } catch {
          /* ignore branch */
        }
      }
      return null;
    };

    if (!hasExistingTarget && !isMarkerPatchConfig(meta)) {
      const found = locateAndPersistSavePath();
      if (found) {
        const newSavePath = path.dirname(found);
        meta.save_path = newSavePath;
        try {
          const cfgPath = path.join(configsDir, `${meta.name}.json`);
          const raw = fs.readFileSync(cfgPath, "utf8");
          const data = JSON.parse(raw);
          data.save_path = newSavePath;
          fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
          watcherLogger.info("save-path:updated", {
            config: meta.name,
            appid,
            save_path: newSavePath,
            file: found,
          });
        } catch {}
        targets = getSaveWatchTargets(meta);
        hasExistingTarget = targets.some((t) => t && fs.existsSync(t));
      }
    }

    const strictRootInfo = getStrictRootEventModeInfo(meta);
    if (strictRootInfo) {
      const strictKey = `${strictRootInfo.profile.key}:${normalizePrefPath(
        strictRootInfo.root,
      ).toLowerCase()}`;
      if (strictKey && !strictRootSeedOnlyLogged.has(strictKey)) {
        strictRootSeedOnlyLogged.add(strictKey);
        watcherLogger.info("watch-save-strict-root", {
          root: strictRootInfo.root,
          profile: strictRootInfo.profile.key,
          mode: "root-folder-events",
        });
      }
      bucket.set(meta.name, {
        close: async () => {},
      });
    } else {
      watcherLogger.info("watch-save", {
        appid,
        savePath: meta.save_path,
      });

      const watcherOptions = {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
        depth: 6,
        ignorePermissionErrors: true,
      };
      if (isRpcs3Meta(meta)) {
        watcherOptions.usePolling = true;
        watcherOptions.interval = 1000;
        watcherOptions.binaryInterval = 1000;
      }
      const watcher = chokidar.watch(targets, watcherOptions);

      const onHit = async (ev, filePath, retryFlag = false) => {
        if (!filePath) return;
        const configName = String(meta?.name || "");
        if (deferredSeedPendingConfigs.has(configName)) {
          const flushed = flushDeferredSeedForConfig(configName);
          if (flushed === "__active__") {
            setTimeout(() => onHit(ev, filePath, retryFlag), 180);
            return;
          }
        }
        let resolvedPath = filePath;
        if (isRpcs3Meta(meta)) {
          const trophyDir = resolveRpcs3TrophyDirForMeta(meta);
          if (trophyDir) {
            const normFile = path.normalize(filePath).toLowerCase();
            const normDir = path.normalize(trophyDir).toLowerCase();
            if (normFile === normDir) {
              const usrPath = resolveTropusrPathForMeta(meta);
              if (usrPath) resolvedPath = usrPath;
            } else if (!normFile.startsWith(normDir + path.sep)) {
              return;
            }
          }
        } else if (isXeniaMeta(meta)) {
          if (!isExpectedXeniaGpdFile(meta, appid, filePath)) return;
        } else if (isGogOfficialMeta(meta)) {
          const normFile = path.normalize(filePath).toLowerCase();
          const resolved = resolveGogOfficialGameplayDbForConfig(meta);
          const expectedDbPathRaw =
            resolved?.gameplayDbPath ||
            meta?.gog_gameplay_db ||
            path.join(meta?.save_path || "", GAMEPLAY_DB_NAME);
          const expectedDbPath = path
            .normalize(expectedDbPathRaw)
            .toLowerCase();
          const expectedDirRaw =
            resolved?.gameplayDir ||
            meta?.save_path ||
            path.dirname(expectedDbPathRaw);
          const expectedDir = path.normalize(expectedDirRaw).toLowerCase();
          const baseName = path.basename(normFile);
          const isGameplayTrigger =
            baseName === GAMEPLAY_DB_NAME ||
            baseName === GAMEPLAY_DB_WAL_NAME ||
            baseName === GAMEPLAY_DB_SHM_NAME;

          if (expectedDbPath && normFile === expectedDbPath) {
            resolvedPath = expectedDbPathRaw;
          } else {
            if (!isGameplayTrigger) return;
            if (
              expectedDir &&
              normFile !== expectedDbPath &&
              !normFile.startsWith(expectedDir + path.sep)
            ) {
              return;
            }
            resolvedPath = expectedDbPathRaw;
          }
        } else if (isUbisoftOfficialMeta(meta)) {
          const normFile = path.normalize(filePath).toLowerCase();
          const resolved = resolveUbisoftOfficialSpoolFileForConfig(meta);
          const expectedSpoolFileRaw =
            resolved?.spoolFilePath ||
            meta?.ubisoft_spool_file ||
            path.join(meta?.save_path || "", `${meta?.appid || appid}.spool`);
          const expectedSpoolFile = path
            .normalize(expectedSpoolFileRaw)
            .toLowerCase();
          const expectedDirRaw =
            resolved?.spoolDir ||
            meta?.save_path ||
            path.dirname(expectedSpoolFileRaw);
          const expectedDir = path.normalize(expectedDirRaw).toLowerCase();
          const baseName = path.basename(normFile);
          const isSpoolTrigger = /\.spool$/i.test(baseName);

          if (expectedSpoolFile && normFile === expectedSpoolFile) {
            resolvedPath = expectedSpoolFileRaw;
          } else {
            if (!isSpoolTrigger) return;
            if (
              expectedDir &&
              normFile !== expectedSpoolFile &&
              !normFile.startsWith(expectedDir + path.sep)
            ) {
              return;
            }
            if (
              meta?.appid &&
              baseName !== `${String(meta.appid).toLowerCase()}.spool`
            ) {
              return;
            }
            resolvedPath = expectedSpoolFileRaw;
          }
        } else if (isPs4Meta(meta)) {
          const normFile = path.normalize(filePath).toLowerCase();
          const progressPath = resolvePs4ProgressPathForMeta(meta);
          const trophyDir = resolvePs4TrophyDirForMeta(meta);
          const expectedProgress = progressPath
            ? path.normalize(progressPath).toLowerCase()
            : "";
          const expectedSchemaRaw = trophyDir
            ? path.join(trophyDir, "Xml", "TROP.XML")
            : "";
          const expectedSchema = expectedSchemaRaw
            ? path.normalize(expectedSchemaRaw).toLowerCase()
            : "";
          if (expectedProgress && normFile === expectedProgress) {
            resolvedPath = progressPath;
          } else if (expectedSchema && normFile === expectedSchema) {
            resolvedPath = expectedSchemaRaw;
          } else if (isPs4ProgressXmlPath(filePath)) {
            const npcommid = getPs4NpCommIdFromProgressPath(filePath);
            if (
              !npcommid ||
              String(meta?.shadps4_npcommid || "").toLowerCase() !==
                npcommid.toLowerCase()
            ) {
              return;
            }
            resolvedPath = filePath;
          } else {
            return;
          }
        } else if (isMarkerPatchConfig(meta)) {
          const expectedStateFile = getMarkerPatchStateFile(meta);
          if (
            !expectedStateFile ||
            normalizePrefPath(filePath).toLowerCase() !==
              normalizePrefPath(expectedStateFile).toLowerCase()
          ) {
            return;
          }
          resolvedPath = expectedStateFile;
        } else {
          const parts = filePath.split(path.sep).map((p) => p.toLowerCase());
          const detected = [...parts]
            .reverse()
            .find((p) => /^[0-9a-fA-F]+$/.test(p));
          if (detected && detected !== appid.toLowerCase()) return;
        }
        const initial = ev === "add" && bootMode;
        const isTenoke = meta.__tenoke === true || tenokeIds.has(String(appid));

        // If Tenoke and file just appeared, update save_path to the file's directory
        if (isTenoke && ev === "add") {
          const dir = path.dirname(filePath);
          const prevSave = meta.save_path || "";
          try {
            const cfgPath = path.join(configsDir, `${meta.name}.json`);
            if (fs.existsSync(cfgPath)) {
              const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
              if (data.save_path !== dir) {
                data.save_path = dir;
                data.tenokeLinked = true;
                fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
                meta.save_path = dir;
                targets = getSaveWatchTargets(meta);
                if (prevSave && prevSave !== dir) {
                  replaceWatchedFolder(prevSave, dir);
                }
                tenokeRelinkedConfigs.add(meta.name);
                const existingWatcher = bucket.get(meta.name);
                if (existingWatcher) {
                  try {
                    existingWatcher.close();
                  } catch {}
                  bucket.delete(meta.name);
                }
                // When SteamData appears post-boot, allow initial notify/auto-select
                const suppress = false; // post-boot relink should emit notifications/auto-select
                attachWatcherForMeta(meta, {
                  suppressInitialNotify: suppress,
                  deferInitialSeed,
                });
                return;
              }
            }
          } catch {}
        }

        let result = false;
        try {
          result = await evaluateFile(appid, meta, resolvedPath, {
            initial,
            retry: retryFlag,
            forceEmptyPrev: isTenoke && ev === "add",
            isAddEvent: ev === "add",
          });
        } catch {}

        if (result === "__retry__") {
          setTimeout(() => {
            onHit(ev, filePath, true);
          }, 220);
          return;
        }

        try {
          broadcastAll("refresh-achievements-table");
          if (result) {
            broadcastAll("achievements:file-updated", {
              appid: String(appid),
              configName: meta?.name || null,
            });
            const tenokeReady =
              meta.__tenoke !== true || tenokeRelinkedConfigs.has(meta.name);
            // Auto-select only after notifications are processed
            if (
              !bootMode &&
              tenokeReady &&
              !isRecentlyUnblocked(appid, meta) &&
              !isAutoSelectSuppressedForMeta(appid, meta)
            ) {
              // defer to next tick to allow notifications to emit before activation
              setTimeout(() => enqueueAutoSelect(meta), 0);
            } else {
              watcherLogger.info("auto-select:skip-conditions", {
                config: meta?.name || null,
                appid: String(appid),
                bootMode,
                tenokeReady,
                justUnblocked: isRecentlyUnblocked(appid, meta),
                suppressAutoSelect: isAutoSelectSuppressedForMeta(appid, meta),
              });
            }
          }
        } catch {}
      };

      watcher
        .on("add", (fp) => onHit("add", fp))
        .on("change", (fp) => onHit("change", fp))
        .on("error", (err) =>
          notifyWarn(`save watcher [${appid}] error: ${err.message}`),
        );

      bucket.set(meta.name, watcher);
    }

    const id = String(appid);
    const baseDir = meta.save_path || "";
    const parentDir = path.dirname(baseDir);

    const candidatesRaw = [
      // JSON
      path.join(baseDir, "achievements.json"),
      path.join(baseDir, id, "achievements.json"),
      path.join(baseDir, "steam_settings", id, "achievements.json"),
      path.join(baseDir, "remote", id, "achievements.json"),

      // INI (clasic)
      path.join(baseDir, "achievements.ini"),
      path.join(baseDir, "stats.ini"),
      path.join(baseDir, id, "achievements.ini"),
      path.join(baseDir, "Stats", "achievements.ini"),
      path.join(baseDir, "Stats", "stats.ini"),
      path.join(baseDir, id, "Stats", "achievements.ini"),
      path.join(baseDir, id, "Stats", "stats.ini"),
      // UniverseLAN nested location
      path.join(baseDir, "UniverseLANData", "Achievements.ini"),

      // Tenoke user_stats
      path.join(baseDir, "SteamData", "user_stats.ini"),
      path.join(baseDir, "user_stats.ini"),
      path.join(baseDir, id, "SteamData", "user_stats.ini"),
      path.join(baseDir, "steam_settings", id, "SteamData", "user_stats.ini"),
      path.join(baseDir, "remote", id, "SteamData", "user_stats.ini"),

      // BIN
      path.join(baseDir, "stats.bin"),
      path.join(baseDir, id, "stats.bin"),
      path.join(baseDir, "steam_settings", id, "stats.bin"),

      // when save_path is <appid>
      path.join(parentDir, id, "achievements.json"),
      path.join(parentDir, id, "achievements.ini"),
      path.join(parentDir, id, "Stats", "achievements.ini"),
      path.join(parentDir, id, "Stats", "stats.ini"),
      path.join(parentDir, id, "SteamData", "user_stats.ini"),
      path.join(parentDir, id, "user_stats.ini"),
      path.join(parentDir, id, "stats.bin"),
    ].filter(Boolean);

    const candidates = [];
    const seenCandidates = new Set();
    for (const c of candidatesRaw) {
      const key = path.normalize(c);
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);
      candidates.push(c);
    }
    if (isXeniaMeta(meta)) {
      const gpdPath = resolveGpdPathForMeta(meta);
      if (gpdPath) {
        const key = path.normalize(gpdPath);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(gpdPath);
        }
      }
    } else if (isRpcs3Meta(meta)) {
      const usrPath = resolveTropusrPathForMeta(meta);
      const trophyDir = resolveRpcs3TrophyDirForMeta(meta);
      for (const p of [usrPath, trophyDir]) {
        if (!p) continue;
        const key = path.normalize(p);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(p);
        }
      }
    } else if (isSteamOfficialMeta(meta)) {
      const statsDir = meta.save_path || "";
      const userBin = statsDir
        ? pickConfiguredSteamOfficialUserBin(statsDir, meta.appid || id)
        : "";
      if (userBin) {
        const key = path.normalize(userBin);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(userBin);
        }
      }
    } else if (isUbisoftOfficialMeta(meta)) {
      const resolved = resolveUbisoftOfficialSpoolFileForConfig(meta);
      const spoolFilePath =
        resolved?.spoolFilePath ||
        meta?.ubisoft_spool_file ||
        (baseDir && id ? path.join(baseDir, `${id}.spool`) : "");
      for (const p of [spoolFilePath, baseDir]) {
        if (!p) continue;
        const key = path.normalize(p);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(p);
        }
      }
    } else if (isPs4Meta(meta)) {
      const trophyDir = resolvePs4TrophyDirForMeta(meta);
      const progressPath = resolvePs4ProgressPathForMeta(meta);
      if (progressPath) {
        const key = path.normalize(progressPath);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(progressPath);
        }
      }
      const xmlMain = trophyDir ? path.join(trophyDir, "Xml", "TROP.XML") : "";
      for (const p of [xmlMain, trophyDir]) {
        if (!p) continue;
        const key = path.normalize(p);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(p);
        }
      }
    } else if (isMarkerPatchConfig(meta)) {
      const stateFile = getMarkerPatchStateFile(meta);
      if (stateFile) {
        const key = path.normalize(stateFile);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(stateFile);
        }
      }
    }
    if (isRpcs3Meta(meta)) {
      const usrPath = resolveTropusrPathForMeta(meta);
      if (usrPath) {
        const key = path.normalize(usrPath);
        if (!seenCandidates.has(key)) {
          seenCandidates.add(key);
          candidates.unshift(usrPath);
        }
      }
    }

    const shouldSuppressInitialSeed =
      suppressInitialNotify || bootMode || deferInitialSeed;
    if (deferInitialSeed) {
      queueDeferredSeed({
        id,
        meta,
        candidates,
        suppressInitialNotify: shouldSuppressInitialSeed,
        bornInBoot: bootMode,
      });
    } else {
      runInitialSeedForMeta(id, meta, candidates, {
        suppressInitialNotify: shouldSuppressInitialSeed,
      });
    }
  }

  async function rebuildSaveWatchers(options = {}) {
    const suppressInitialNotify = options.suppressInitialNotify === true;
    const fromBlacklist =
      options.fromBlacklist === true || options.appIdsFromBlacklist;
    const deferInitialSeed =
      options.deferInitialSeed === true ||
      (bootMode && options.deferInitialSeed !== false);
    const deferLumaPlayPolling = options.deferLumaPlayPolling === true;
    const forceBatchAttach = options.forceBatchAttach === true;
    const batchDelayMs = Math.max(0, Number(options.batchDelayMs) || 0);
    const yieldIfNeeded = createTimeSlicer(BOOT_ATTACH_SLICE_MS);
    const itemDelayMs =
      (bootMode || forceBatchAttach) && BOOT_ATTACH_ITEM_DELAY_MS > 0
        ? BOOT_ATTACH_ITEM_DELAY_MS
        : 0;
    const roots = getWatchedFolders().map(normalize);
    const blacklistState = getBlacklistState();
    const blockedFolders = getBlockedFoldersSet();
    const allowed = new Map(); // appid -> Set(configName)

    for (const [appid, metas] of configIndex.entries()) {
      const id = String(appid);
      for (const meta of metas || []) {
        if (isAppIdBlacklisted(id, meta?.platform || null, blacklistState)) {
          continue;
        }
        if (isLumaPlayMeta(meta)) {
          if (!isLumaPlayWatcherEnabled()) continue;
          if (!allowed.has(id)) allowed.set(id, new Set());
          allowed.get(id).add(meta.name);
          continue;
        }
        const savePath = meta?.save_path ? normalize(meta.save_path) : null;
        const markerPatchConfig = isMarkerPatchConfig(meta);
        const madnessPatchConfig = isMadnessPatchConfig(meta);
        const localPatchConfig = markerPatchConfig || madnessPatchConfig;
        const localPatchGamePath = markerPatchConfig
          ? getMarkerPatchGamePath(meta)
          : madnessPatchConfig
            ? getMadnessPatchGamePath(meta)
            : "";
        if (
          markerPatchConfig &&
          !detectMarkerPatchRoot(localPatchGamePath).detected
        ) {
          continue;
        }
        if (
          madnessPatchConfig &&
          !detectMadnessPatchRoot(localPatchGamePath).detected
        ) {
          continue;
        }
        const eligibilityPath = localPatchConfig
          ? normalize(localPatchGamePath)
          : savePath;
        if (!eligibilityPath) continue;
        if (isPathBlocked(eligibilityPath, blockedFolders)) continue;
        if (
          localPatchConfig &&
          savePath &&
          isPathBlocked(savePath, blockedFolders)
        ) {
          continue;
        }
        const inside = roots.some((root) => {
          const rel = path.relative(root, eligibilityPath);
          if (!rel) return true; // same directory
          return !rel.startsWith("..") && !path.isAbsolute(rel); // inside subdir
        });
        if (!inside) continue;
        if (!allowed.has(id)) allowed.set(id, new Set());
        allowed.get(id).add(meta.name);
      }
    }

    for (const [appid, bucket] of appidSaveWatchers.entries()) {
      if (!(bucket instanceof Map)) continue;
      for (const [configName, watcher] of bucket.entries()) {
        const keep = allowed.has(appid) && allowed.get(appid).has(configName);
        if (keep) continue;
        watcherLogger.info("unwatch-save", {
          appid,
          config: configName,
          reason: "rebuild-save-watchers",
        });
        try {
          watcher.close();
        } catch {}
        bucket.delete(configName);
      }
      if (bucket.size === 0) {
        appidSaveWatchers.delete(appid);
      }
    }

    const metasToAttach = [];
    for (const [appid, names] of allowed.entries()) {
      for (const name of names) {
        const bucket = appidSaveWatchers.get(appid);
        if (bucket && bucket.has(name)) continue;
        const meta =
          getConfigMetas(appid).find((entry) => entry.name === name) || null;
        if (meta) metasToAttach.push(meta);
      }
    }
    if (metasToAttach.length) {
      if (
        (bootMode || forceBatchAttach) &&
        metasToAttach.length > BOOT_ATTACH_BATCH
      ) {
        let count = 0;
        for (const meta of metasToAttach) {
          attachWatcherForMeta(meta, {
            suppressInitialNotify,
            deferInitialSeed,
            deferLumaPlayPolling,
          });
          count += 1;
          if (yieldIfNeeded) await yieldIfNeeded();
          const perMetaDelayMs = getStrictRootEventModeInfo(meta)
            ? STRICT_ROOT_ATTACH_ITEM_DELAY_MS
            : itemDelayMs;
          if (perMetaDelayMs > 0) {
            await sleep(perMetaDelayMs);
          }
          if (count % BOOT_ATTACH_BATCH === 0 && perMetaDelayMs === 0) {
            await sleep(batchDelayMs || BOOT_ATTACH_DELAY_MS);
          }
        }
      } else {
        for (const meta of metasToAttach) {
          attachWatcherForMeta(meta, {
            suppressInitialNotify,
            deferInitialSeed,
            deferLumaPlayPolling,
          });
          if (yieldIfNeeded) await yieldIfNeeded();
          const perMetaDelayMs = getStrictRootEventModeInfo(meta)
            ? STRICT_ROOT_ATTACH_ITEM_DELAY_MS
            : itemDelayMs;
          if (perMetaDelayMs > 0) {
            await sleep(perMetaDelayMs);
          }
        }
      }
    }
    if (getActiveLumaPlayWatcherEntries().length > 0) {
      if (!deferLumaPlayPolling) {
        startLumaPlayDiscoveryPolling();
      }
    } else {
      stopLumaPlayDiscoveryPolling();
    }
  }

  async function closeSaveWatchersForConfigDeletion(appid, configName) {
    const appidKey = normalizeAppIdValue(appid) || String(appid || "").trim();
    const safeConfigName = String(configName || "").trim();
    const closeTasks = [];

    for (const [bucketAppId, bucket] of appidSaveWatchers.entries()) {
      if (!(bucket instanceof Map)) continue;
      if (
        appidKey &&
        String(bucketAppId).toLowerCase() !== appidKey.toLowerCase()
      ) {
        continue;
      }
      for (const [watchedConfigName, watcher] of bucket.entries()) {
        if (
          !appidKey &&
          safeConfigName &&
          watchedConfigName !== safeConfigName
        ) {
          continue;
        }
        watcherLogger.info("config-delete:unwatch-save", {
          appid: String(bucketAppId),
          config: watchedConfigName,
        });
        bucket.delete(watchedConfigName);
        try {
          closeTasks.push(Promise.resolve(watcher?.close?.()));
        } catch {}
      }
      if (bucket.size === 0) appidSaveWatchers.delete(bucketAppId);
    }

    if (closeTasks.length > 0) {
      await Promise.allSettled(closeTasks);
    }
    return closeTasks.length;
  }

  function pathsEqualForDeletion(left, right) {
    const normalizedLeft = normalizeAbsolutePath(left);
    const normalizedRight = normalizeAbsolutePath(right);
    if (!normalizedLeft || !normalizedRight) return false;
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  function buildConfigDeletionRootPlan(appid, rawTargets) {
    const activeWatcherRoots = Array.from(folderWatchers.keys());
    const configuredFolderPaths = getWatchedFolders();
    const configuredRoots = [
      ...configuredFolderPaths,
      ...configuredFolderPaths.map(normalizeRoot),
    ];
    const deleteTargets = [];
    const rootsToPause = new Set();

    for (const rawTarget of Array.isArray(rawTargets) ? rawTargets : []) {
      const target = validateAppIdDirectoryTarget(rawTarget, appid);
      if (!target) {
        watcherLogger.warn("config-delete:target-rejected", {
          appid,
          deleteTarget: rawTarget || null,
          reason: "not-absolute-appid-directory",
        });
        continue;
      }
      const equalsConfiguredRoot = configuredRoots.some((root) =>
        pathsEqualForDeletion(root, target),
      );
      const equalsActiveRoot = activeWatcherRoots.some((root) =>
        pathsEqualForDeletion(root, target),
      );
      if (equalsConfiguredRoot || equalsActiveRoot) {
        watcherLogger.warn("config-delete:target-rejected", {
          appid,
          deleteTarget: target,
          reason: "target-is-watched-root",
        });
        continue;
      }

      deleteTargets.push(target);
      let targetIsDirectory = false;
      try {
        targetIsDirectory =
          fs.existsSync(target) && fs.statSync(target).isDirectory();
      } catch {
        targetIsDirectory = false;
      }
      if (!targetIsDirectory) continue;
      const match = findMostSpecificContainingRoot(target, activeWatcherRoots);
      if (!match) {
        watcherLogger.info("config-delete:target-no-active-root", {
          appid,
          deleteTarget: target,
        });
        continue;
      }
      rootsToPause.add(match.root);
      watcherLogger.info("config-delete:target-validated", {
        appid,
        watchedRoot: match.root,
        deleteTarget: match.target,
      });
    }

    return {
      deleteTargets: Array.from(new Set(deleteTargets)),
      rootsToPause: Array.from(rootsToPause),
    };
  }

  async function pauseFolderWatcherForConfigDeletion(rootPath) {
    let matchedKey = null;
    let entry = null;
    for (const [key, value] of folderWatchers.entries()) {
      if (!pathsEqualForDeletion(key, rootPath)) continue;
      matchedKey = key;
      entry = value;
      break;
    }
    if (!entry || !matchedKey) return false;

    folderWatchers.delete(matchedKey);
    entry.stopped = true;
    entry.rescanQueued = false;
    clearTimeout(entry.debounce);
    try {
      entry.resolveReady?.(false);
    } catch {}
    entry.resolveReady = null;
    await entry.watcher.close();
    watcherLogger.info("config-delete:root-watcher-paused", {
      watchedRoot: matchedKey,
    });
    return true;
  }

  async function resumeConfigDeletionRootWatchers(token, timeoutMs) {
    const pausedRoots = pausedDeletionRootWatchers.get(token?.id) || [];
    pausedDeletionRootWatchers.delete(token?.id);
    if (pausedRoots.length === 0) return [];

    const allowedRoots = getWatchedFolders().map(normalizeRoot);
    const failures = [];
    for (const root of pausedRoots) {
      try {
        const stillAllowed = allowedRoots.some((allowedRoot) =>
          pathsEqualForDeletion(allowedRoot, root),
        );
        if (!stillAllowed) {
          watcherLogger.info("config-delete:root-watcher-restart-skip", {
            appid: String(token?.appid || ""),
            watchedRoot: root,
            reason: "root-no-longer-configured",
          });
          continue;
        }

        const readyPromise = startFolderWatcher(root, { initialScan: false });
        let ready = false;
        let readyTimeout = null;
        try {
          ready = await Promise.race([
            Promise.resolve(readyPromise),
            new Promise((resolve) => {
              readyTimeout = setTimeout(
                () => resolve(false),
                Math.min(Math.max(1000, timeoutMs || 10000), 10000),
              );
            }),
          ]);
        } finally {
          if (readyTimeout) clearTimeout(readyTimeout);
        }
        watcherLogger.info("config-delete:root-watcher-restarted", {
          appid: String(token?.appid || ""),
          watchedRoot: root,
          initialScan: false,
          ready: ready === true,
        });
      } catch (error) {
        failures.push({
          root,
          error: error?.message || String(error),
        });
        watcherLogger.warn("config-delete:root-watcher-restart-failed", {
          appid: String(token?.appid || ""),
          watchedRoot: root,
          error: error?.message || String(error),
        });
      }
    }
    return failures;
  }

  async function beginConfigDeletion(options = {}) {
    const appid =
      normalizeAppIdValue(options?.appid) ||
      String(options?.appid || "").trim();
    const configName = String(options?.configName || "").trim();
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || 60000);
    const guardToken = await configDeletionGuard.begin(appid, { timeoutMs });
    const deletionPlan = buildConfigDeletionRootPlan(
      appid,
      options?.deleteTargets,
    );
    const token = Object.freeze({
      ...guardToken,
      deleteTargets: Object.freeze([...deletionPlan.deleteTargets]),
    });
    let closedWatchers = 0;
    const pausedRoots = [];
    pausedDeletionRootWatchers.set(token.id, pausedRoots);
    try {
      closedWatchers = await closeSaveWatchersForConfigDeletion(
        appid,
        configName,
      );
      pendingSavePathIndex.delete(appid);
      pendingSavePathIndex.delete(token.appid);
      for (const root of deletionPlan.rootsToPause) {
        try {
          if (await pauseFolderWatcherForConfigDeletion(root)) {
            pausedRoots.push(root);
          }
        } catch (error) {
          pausedRoots.push(root);
          throw error;
        }
      }
    } catch (error) {
      try {
        await resumeConfigDeletionRootWatchers(token, timeoutMs);
      } catch (resumeError) {
        watcherLogger.warn("config-delete:root-watcher-rollback-failed", {
          appid,
          error: resumeError?.message || String(resumeError),
        });
      } finally {
        await configDeletionGuard.end(guardToken, {
          settleMs: 0,
          timeoutMs,
        });
      }
      throw error;
    }
    watcherLogger.info("config-delete:guard-started", {
      appid,
      config: configName || null,
      closedWatchers,
      pausedRootWatchers: pausedRoots.length,
      deleteTargets: token.deleteTargets.length,
      timeoutMs,
    });
    watcherLogger.info("config-delete:generation-idle", {
      appid,
      config: configName || null,
    });
    return token;
  }

  async function endConfigDeletion(token, options = {}) {
    const settleMs = Math.max(0, Number(options?.settleMs) || 800);
    const timeoutMs = Math.max(1000, Number(options?.timeoutMs) || 60000);
    let restartError = null;
    let restartFailures = [];
    try {
      restartFailures = await resumeConfigDeletionRootWatchers(
        token,
        timeoutMs,
      );
    } catch (error) {
      restartError = error;
      watcherLogger.warn("config-delete:root-watcher-restart-failed", {
        appid: String(token?.appid || ""),
        error: error?.message || String(error),
      });
    }
    const released = await configDeletionGuard.end(token, {
      settleMs,
      timeoutMs,
    });
    watcherLogger.info("config-delete:guard-ended", {
      appid: String(token?.appid || ""),
      settleMs,
      released,
      rootWatcherRestartError: restartError?.message || null,
      rootWatcherRestartFailures: restartFailures.length,
    });
    return released;
  }

  async function discoverAppIdsUnder(
    root,
    maxDepth = 3,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const out = new Map(); // appid -> abs path
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const next = path.join(dir, ent.name);
        if (typeof shouldSkipPath === "function" && shouldSkipPath(next)) {
          continue;
        }
        if (/^[0-9a-fA-F]+$/.test(ent.name)) out.set(ent.name, next);
        await walk(next, depth + 1);
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    return out;
  }

  function resolveNemirtingasBaseInfo(inputRoot) {
    if (!inputRoot) return null;
    const normalized = String(inputRoot).replace(/[\\/]+/g, path.sep);
    const lower = normalized.toLowerCase();
    const parts = lower.split(path.sep);
    const idx = parts.lastIndexOf("nemirtingasepicemu");
    if (idx === -1) return null;
    const rawParts = normalized.split(path.sep);
    const base = rawParts.slice(0, idx + 1).join(path.sep);
    const sub = rawParts.slice(idx + 1);
    return { base, sub };
  }

  async function discoverNemirtingasEpicAppIds(root, shouldSkipPath = null) {
    const info = resolveNemirtingasBaseInfo(root);
    if (!info) return null;
    const { base, sub } = info;
    const out = new Map();

    const scanUserDir = async (userDir) => {
      if (typeof shouldSkipPath === "function" && shouldSkipPath(userDir)) {
        return;
      }
      let entries;
      try {
        entries = await fsp.readdir(userDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (!isAppIdName(ent.name)) continue;
        const candidatePath = path.join(userDir, ent.name);
        if (
          typeof shouldSkipPath === "function" &&
          shouldSkipPath(candidatePath)
        ) {
          continue;
        }
        out.set(ent.name, candidatePath);
      }
    };

    if (sub.length === 0) {
      // Root selected at NemirtingasEpicEmu (container). Scan each user ID dir.
      let entries;
      try {
        entries = await fsp.readdir(base, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        await scanUserDir(path.join(base, ent.name));
      }
      return out;
    }

    // Root selected under NemirtingasEpicEmu (user ID or deeper).
    const userDir = path.join(base, sub[0]);
    await scanUserDir(userDir);
    return out;
  }

  async function findGogInfoAppId(
    root,
    maxDepth = 3,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const pattern = /^goggame-(\d+)\.info$/i;
    const found = [];
    const normalizeGogTaskPath = (value) =>
      typeof value === "string" ? value.trim() : "";
    const pickGogInfoLaunchMetadata = (parsed, baseDir) => {
      const tasks = Array.isArray(parsed?.playTasks) ? parsed.playTasks : [];
      const ranked = tasks
        .map((task, index) => {
          const taskPath = normalizeGogTaskPath(task?.path);
          if (!taskPath || !/\.exe$/i.test(taskPath)) return null;
          let score = 100;
          if (task?.isPrimary === true) score += 50;
          if (String(task?.category || "").toLowerCase() === "game") score += 25;
          if (String(task?.type || "").toLowerCase() === "filetask") score += 10;
          return { task, index, score };
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || left.index - right.index);
      const selected = ranked[0]?.task || null;
      const taskPath = normalizeGogTaskPath(selected?.path);
      if (!taskPath) return null;
      const executable = path.isAbsolute(taskPath)
        ? taskPath
        : path.join(baseDir, taskPath);
      const processName = normalizeProcessNameValue(
        path.win32.basename(taskPath.replace(/\//g, "\\")),
      );
      return {
        executable,
        arguments: "",
        process_name: processName,
      };
    };
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && pattern.test(ent.name)) {
          found.push(full);
        }
        if (ent.isDirectory()) {
          await walk(full, depth + 1);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    const entries = [];
    for (const file of found) {
      try {
        const m = path.basename(file).match(pattern);
        const fromName = m && m[1] ? m[1] : "";
        const raw = await fsp.readFile(file, "utf8");
        let fromJson = "";
        let rootFromJson = "";
        let parsedName = "";
        let launchMetadata = null;
        try {
          const parsed = JSON.parse(raw);
          const val =
            parsed?.gameId ??
            parsed?.gameID ??
            parsed?.game_id ??
            parsed?.GameId ??
            parsed?.GameID ??
            parsed?.GameID;
          const rootVal =
            parsed?.rootGameId ??
            parsed?.rootgameid ??
            parsed?.root_game_id ??
            parsed?.RootGameId ??
            parsed?.RootGameID ??
            parsed?.Rootgameid;
          if (val != null) fromJson = String(val).trim();
          if (rootVal != null) rootFromJson = String(rootVal).trim();
          if (parsed?.name && typeof parsed.name === "string") {
            parsedName = parsed.name.trim();
          }
          launchMetadata = pickGogInfoLaunchMetadata(parsed, path.dirname(file));
        } catch {
          /* ignore json parse */
        }
        const gameId = /^[0-9a-fA-F]+$/.test(fromJson) ? fromJson : fromName;
        const rootGameId = /^[0-9a-fA-F]+$/.test(rootFromJson)
          ? rootFromJson
          : "";
        if (gameId && /^[0-9a-fA-F]+$/.test(gameId)) {
          entries.push({
            gameId,
            rootGameId: rootGameId || gameId,
            name: parsedName,
            file,
            launchMetadata,
          });
        }
      } catch {
        /* ignore file */
      }
    }
    if (!entries.length) return null;
    // prefer entries where rootGameId is defined and matches itself (base game), else any rootGameId, else first
    const baseEntry =
      entries.find((e) => e.rootGameId === e.gameId) ||
      entries.find((e) => !!e.rootGameId) ||
      entries[0];
    return {
      appid: baseEntry.rootGameId || baseEntry.gameId,
      baseDir: path.dirname(baseEntry.file),
      name: baseEntry.name || null,
      launchMetadata: baseEntry.launchMetadata || null,
    };
  }

  async function findUniverseLanAppId(
    root,
    maxDepth = 3,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    const iniName = "UniverseLAN.ini";
    const found = [];
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === iniName.toLowerCase()) {
          found.push(full);
        }
        if (ent.isDirectory()) {
          await walk(full, depth + 1);
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
    }
    await walk(root, 0);
    for (const file of found) {
      try {
        const buf = await fsp.readFile(file);
        const tryParse = (str) => {
          try {
            const parsed = require("ini").parse(str);
            const val = String(parsed?.GameSettings?.AppID || "").trim();
            return /^\d+$/.test(val) ? val : "";
          } catch {
            return "";
          }
        };
        let appid = tryParse(buf.toString("utf8"));
        if (!appid) {
          appid = tryParse(buf.toString("utf16le"));
        }
        if (!appid) {
          const fallbackUtf8 = buf.toString("utf8");
          const mUtf8 =
            fallbackUtf8.match(/^\s*appid\s*=\s*(\d+)\s*$/im) || null;
          if (mUtf8 && mUtf8[1]) appid = mUtf8[1];
        }
        if (!appid) {
          const fallbackLe = buf.toString("utf16le");
          const mLe = fallbackLe.match(/^\s*appid\s*=\s*(\d+)\s*$/im) || null;
          if (mLe && mLe[1]) appid = mLe[1];
        }
        if (appid) return { appid, baseDir: path.dirname(file) };
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  function normalizeRoot(inputRoot) {
    let root = inputRoot;
    try {
      root = fs.realpathSync(inputRoot);
    } catch {
      /* keep original */
    }
    if (isAppIdName(path.basename(root))) root = path.dirname(root);
    return root;
  }

  async function rebuildKnownAppIds(options = {}) {
    const forceAsyncIndex = options?.forceAsyncIndex === true;
    const forceAsyncRootScan = options?.forceAsyncRootScan === true;
    knownAppIds.clear();
    await indexExistingConfigsSync(
      forceAsyncIndex ? { forceAsync: true } : undefined,
    );
    const blacklistState = getBlacklistState();
    const blockedFolders = getBlockedFoldersSet();
    try {
      const roots = getWatchedFolders().map(normalizeRoot);
      for (const r of roots) {
        if (forceAsyncRootScan) {
          try {
            const entries = await fsp.readdir(r, { withFileTypes: true });
            for (const ent of entries) {
              const candidatePath = path.join(r, ent.name);
              if (
                ent.isDirectory() &&
                /^\d+$/.test(ent.name) &&
                !isPathBlocked(candidatePath, blockedFolders) &&
                !isAppIdBlacklisted(ent.name, null, blacklistState)
              ) {
                knownAppIds.add(ent.name);
              }
            }
          } catch {
            /* ignore root */
          }
          continue;
        }
        try {
          const entries = fs.readdirSync(r, { withFileTypes: true });
          for (const ent of entries) {
            const candidatePath = path.join(r, ent.name);
            if (
              ent.isDirectory() &&
              /^\d+$/.test(ent.name) &&
              !isPathBlocked(candidatePath, blockedFolders) &&
              !isAppIdBlacklisted(ent.name, null, blacklistState)
            ) {
              knownAppIds.add(ent.name);
            }
          }
        } catch {
          /* ignore root */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // --- Tenoke helpers ---
  async function findTenokeAppId(
    root,
    maxDepth = 6,
    yieldIfNeeded,
    shouldSkipPath = null,
  ) {
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return null;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) {
        return null;
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && ent.name.toLowerCase() === "tenoke.ini") {
          try {
            const raw = await fsp.readFile(full, "utf8");
            const m = raw.match(/^\s*id\s*=\s*(\d+)/im);
            if (m && m[1]) {
              return { appid: m[1], baseDir: path.dirname(full) };
            }
          } catch {}
        }
        if (ent.isDirectory()) {
          const found = await walk(full, depth + 1);
          if (found) return found;
        }
        if (yieldIfNeeded) await yieldIfNeeded();
      }
      return null;
    }
    return await walk(root, 0);
  }

  const inflightAppIds = new Set();
  async function generateOneAppId(appid, appDir, opts = {}) {
    appid = String(appid);
    const desiredPlatform = normalizePlatform(opts.forcePlatform) || null;
    if (configDeletionGuard.isSuppressed(appid)) {
      watcherLogger.info("watcher:generate-skip-config-deleting", {
        appid,
        platform: desiredPlatform || null,
        path: appDir || null,
      });
      return { created: false, reason: "config-deleting" };
    }
    const invalidAutoAppIdReason = getInvalidAutoAppIdReason(appid);
    if (invalidAutoAppIdReason) {
      watcherLogger.info("watcher:generate-skipped-invalid-appid", {
        appid,
        platform: desiredPlatform || null,
        path: appDir || null,
        reason: invalidAutoAppIdReason,
      });
      return { created: false, reason: "invalid-appid" };
    }
    const externalProgressHandler =
      typeof opts.onGenerationProgress === "function"
        ? opts.onGenerationProgress
        : null;
    if (isAppIdBlacklisted(appid, desiredPlatform)) {
      return { created: false, reason: "blacklisted" };
    }
    const skipPostIndex = opts.skipPostIndex === true;
    const allowExistingVariant = opts.allowExistingVariant === true;
    const inflightKey = `${appid}:${desiredPlatform || "auto"}`;
    if (!desiredPlatform && existingConfigIds.has(appid)) {
      return { created: false, reason: "existing-auto" };
    }
    if (
      desiredPlatform &&
      hasPlatformVariant(appid, desiredPlatform) &&
      !allowExistingVariant
    ) {
      return { created: false, reason: "existing-variant" };
    }
    if (inflightAppIds.has(inflightKey)) {
      return { created: false, reason: "inflight" };
    }
    if (wasObservedGenerationVariantRecent(appid, desiredPlatform)) {
      return { created: false, reason: "recent-app-platform" };
    }
    const normalizedSavePath =
      opts.normalizedSavePath ||
      normalizeObservedPath(appDir || "", appid) ||
      "";
    if (
      isObservedGenerationPending(appid, desiredPlatform, normalizedSavePath)
    ) {
      return { created: false, reason: "pending-save-path" };
    }
    if (
      wasObservedGenerationRecent(appid, desiredPlatform, normalizedSavePath)
    ) {
      return { created: false, reason: "recent-save-path" };
    }
    const finishGenerationActivity =
      configDeletionGuard.tryStartGeneration(appid);
    if (!finishGenerationActivity) {
      watcherLogger.info("watcher:generate-skip-config-deleting", {
        appid,
        platform: desiredPlatform || null,
        path: appDir || null,
      });
      return { created: false, reason: "config-deleting" };
    }
    markObservedGenerationPending(appid, desiredPlatform, normalizedSavePath);
    inflightAppIds.add(inflightKey);
    try {
      if (typeof generateConfigForAppId === "function") {
        if (desiredPlatform) {
          watcherLogger.info("watcher:generate-forced-platform", {
            appid,
            platform: desiredPlatform,
          });
        }
        const genOptions = {
          appDir,
          onSeedCache,
          forcePlatform: desiredPlatform || undefined,
        };
        if (opts.__gogName) {
          genOptions.preferredName = opts.__gogName;
        }
        if (opts.__gogLaunchMetadata) {
          genOptions.launchMetadata = opts.__gogLaunchMetadata;
        }
        if (opts.__savePathOverride) {
          genOptions.savePathOverride = opts.__savePathOverride;
        }
        if (opts.__gogClientId) {
          genOptions.gogClientId = opts.__gogClientId;
        }
        if (opts.__gogUserId) {
          genOptions.gogUserId = opts.__gogUserId;
        }
        if (opts.__gogGameplayDbPath) {
          genOptions.gogGameplayDbPath = opts.__gogGameplayDbPath;
        }
        if (opts.__ubisoftUserId) {
          genOptions.ubisoftUserId = opts.__ubisoftUserId;
        }
        if (opts.__ubisoftSpoolFile) {
          genOptions.ubisoftSpoolFile = opts.__ubisoftSpoolFile;
        }
        if (opts.__eaAchievementSet) {
          genOptions.eaAchievementSet = opts.__eaAchievementSet;
        }
        if (opts.__eaLogFile) {
          genOptions.eaLogFile = opts.__eaLogFile;
        }
        if (opts.__eaGameName) {
          genOptions.preferredName = opts.__eaGameName;
        }
        if (opts.__emu) {
          genOptions.emu = opts.__emu;
        }
        if (opts.__lumaplayUser) {
          genOptions.lumaplayUser = opts.__lumaplayUser;
        }
        const singleGenerationId = `generation-single-${appid}-${Date.now()}`;
        const singleGenerationItem =
          String(
            opts.__eaGameName ||
              opts.__gogName ||
              genOptions.preferredName ||
              appid,
          ).trim() || String(appid);
        const shouldRevealSingleGeneration = (progress = {}) => {
          const phase = String(progress?.phase || "").toLowerCase();
          const status = String(progress?.status || "").toLowerCase();
          const detail = String(progress?.detail || "").toLowerCase();
          if (status === "failed" || phase === "failed") return true;
          if (
            phase === "schemaparse" ||
            phase === "generatingschema" ||
            phase === "fetchsteamapi" ||
            phase === "fetchsteamdb" ||
            phase === "fetchepic" ||
            phase === "finalizing" ||
            phase === "completed"
          ) {
            return true;
          }
          if (
            detail.includes("schema") ||
            detail.includes("steamdb") ||
            detail.includes("epic achievements") ||
            detail.includes("finalizing")
          ) {
            return true;
          }
          if (detail === "config created" || detail === "config updated") {
            return true;
          }
          if (detail === "waiting for schema generation") return true;
          if (phase === "skipped" || detail === "config generation skipped") {
            return false;
          }
          return false;
        };
        let singleGenerationStarted = false;
        const emitSingleGeneration = (phaseType, payload = {}) => {
          const nextPayload = {
            id: singleGenerationId,
            kind: "config-generate",
            scope: "single",
            appid: String(payload.appid || appid),
            itemName: String(payload.itemName || singleGenerationItem),
            ...payload,
          };
          if (externalProgressHandler) {
            try {
              externalProgressHandler({
                ...nextPayload,
                event: phaseType,
              });
            } catch {}
            return;
          }
          if (phaseType === "start") {
            if (singleGenerationStarted) return;
            singleGenerationStarted = true;
          } else if (phaseType === "update") {
            if (!singleGenerationStarted) {
              if (!shouldRevealSingleGeneration(nextPayload)) return;
              try {
                broadcastAll("generation:progress:start", {
                  ...nextPayload,
                  status: "running",
                });
              } catch {}
              singleGenerationStarted = true;
            }
          } else if (phaseType === "end") {
            if (!singleGenerationStarted) {
              if (!shouldRevealSingleGeneration(nextPayload)) return;
              try {
                broadcastAll("generation:progress:start", {
                  ...nextPayload,
                  status: "running",
                });
              } catch {}
              singleGenerationStarted = true;
            }
          }
          const channel =
            phaseType === "start"
              ? "generation:progress:start"
              : phaseType === "end"
                ? "generation:progress:end"
                : "generation:progress:update";
          try {
            broadcastAll(channel, nextPayload);
          } catch {}
        };
        genOptions.onGenerationProgress = (progress = {}) => {
          emitSingleGeneration("update", progress);
        };
        let result = null;
        try {
          result = await generateConfigForAppId(appid, configsDir, genOptions);
        } catch (err) {
          emitSingleGeneration("end", {
            status: "failed",
            phase: "failed",
            detail: err?.message || "Config generation failed",
          });
          throw err;
        }
        if (!result || result.skipped) {
          emitSingleGeneration("end", {
            status: "success",
            phase: "skipped",
            detail:
              result?.pendingSchema === true
                ? "Waiting for schema generation"
                : "Config generation skipped",
            percent: 100,
          });
          watcherLogger.info("watcher:generate-skipped", {
            appid,
            platform: desiredPlatform || null,
            pendingSchema: result?.pendingSchema === true,
          });
          return {
            created: false,
            reason:
              result?.pendingSchema === true ? "pending-schema" : "skipped",
          };
        }
        existingConfigIds.add(appid);
        knownAppIds.add(appid);
        if (normalizedSavePath) {
          recordExistingSavePath(appid, normalizedSavePath);
        }
        // Ensure emu flag persisted when requested
        if (opts.__emu || opts.__lumaplayUser || opts.__lumaplayKeyPath) {
          try {
            const cfgFile =
              (result && result.filePath) ||
              (result && result.name
                ? path.join(configsDir, `${result.name}.json`)
                : null);
            const fallback = path.join(
              configsDir,
              `${sanitizeConfigName(appid)}.json`,
            );
            const target =
              cfgFile && fs.existsSync(cfgFile) ? cfgFile : fallback;
            if (target && fs.existsSync(target)) {
              const data = JSON.parse(fs.readFileSync(target, "utf8"));
              if (opts.__emu && data.emu !== opts.__emu) {
                data.emu = opts.__emu;
              }
              if (
                opts.__lumaplayUser &&
                data.lumaplay_user !== opts.__lumaplayUser
              ) {
                data.lumaplay_user = opts.__lumaplayUser;
              }
              if (
                opts.__lumaplayKeyPath &&
                data.lumaplay_key_path !== opts.__lumaplayKeyPath
              ) {
                data.lumaplay_key_path = opts.__lumaplayKeyPath;
              }
              fs.writeFileSync(target, JSON.stringify(data, null, 2));
              if (opts.__emu === "tenoke") {
                tenokeIds.add(String(appid));
              }
            }
          } catch {}
        }
        if (!skipPostIndex) {
          await indexExistingConfigsSync();
        }
        if (normalizedSavePath) {
          markObservedGenerationRecent(
            appid,
            desiredPlatform,
            normalizedSavePath,
          );
        }
        markObservedGenerationVariantRecent(appid, desiredPlatform);
        if (opts.__emu === "tenoke") {
          try {
            attachSaveWatcherForAppId(appid, { suppressInitialNotify: true });
          } catch {}
        }
        emitSingleGeneration("end", {
          status: "success",
          phase: "completed",
          detail: "Config created",
          percent: 100,
          itemName: result?.name || singleGenerationItem,
        });
        return { created: true, reason: "created" };
      }
      return { created: false, reason: "missing-generator" };
    } finally {
      inflightAppIds.delete(inflightKey);
      finishGenerationActivity();
      clearObservedGenerationPending(
        appid,
        desiredPlatform,
        normalizedSavePath,
      );
      if (normalizedSavePath) {
        clearPendingSavePath(appid, normalizedSavePath);
      }
      if (opts.__emu || opts.__lumaplayUser || opts.__lumaplayKeyPath) {
        try {
          const metas = getConfigMetas(appid);
          for (const meta of metas || []) {
            const cfgFile = path.join(configsDir, `${meta.name}.json`);
            if (!fs.existsSync(cfgFile)) continue;
            const data = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
            let changed = false;
            if (opts.__emu && data.emu !== opts.__emu) {
              data.emu = opts.__emu;
              changed = true;
            }
            if (
              opts.__lumaplayUser &&
              data.lumaplay_user !== opts.__lumaplayUser
            ) {
              data.lumaplay_user = opts.__lumaplayUser;
              changed = true;
            }
            if (
              opts.__lumaplayKeyPath &&
              data.lumaplay_key_path !== opts.__lumaplayKeyPath
            ) {
              data.lumaplay_key_path = opts.__lumaplayKeyPath;
              changed = true;
            }
            if (changed) {
              fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2));
            }
          }
        } catch {}
      }
    }
  }

  async function scanLumaPlayRegistryOnce(options = {}) {
    if (process.platform !== "win32") {
      return { scanned: 0, created: 0, updated: 0 };
    }
    if (!isLumaPlayWatcherEnabled()) {
      return { scanned: 0, created: 0, updated: 0 };
    }
    clearLumaPlayReadCache();
    const suppressInitialNotify = options.suppressInitialNotify === true;
    const autoRebuild = options.autoRebuild !== false;
    const lumaPlayReadCache =
      options.lumaPlayReadCache &&
      typeof options.lumaPlayReadCache.get === "function" &&
      typeof options.lumaPlayReadCache.set === "function"
        ? options.lumaPlayReadCache
        : null;
    let discovered = [];
    try {
      discovered = scanLumaPlayRegistryEntries({
        cache: lumaPlayReadCache,
      });
    } catch (err) {
      watcherLogger.warn("lumaplay:scan-failed", {
        error: err?.message || String(err),
      });
      return { scanned: 0, created: 0, updated: 0 };
    }
    if (!Array.isArray(discovered) || discovered.length === 0) {
      return { scanned: 0, created: 0, updated: 0 };
    }

    const blacklistState = getBlacklistState();
    const createdIds = new Set();
    const updatedIds = new Set();
    const lumaGenerationTasks = [];
    const lumaGenerationTaskIndex = new Map();

    const buildLumaTaskKey = (row = {}) =>
      [
        String(row?.appid || "").trim(),
        String(row?.user || "").trim(),
        String(row?.keyPath || "")
          .trim()
          .toLowerCase(),
      ].join("::");

    const markConfigAsLumaPlay = (meta, user, keyPath) => {
      if (!meta?.name) return false;
      const cfgPath = path.join(configsDir, `${meta.name}.json`);
      if (!fs.existsSync(cfgPath)) return false;
      try {
        const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        let changed = false;
        if (normalizeEmuValue(data?.emu) !== "lumaplay") {
          data.emu = "lumaplay";
          changed = true;
        }
        if (user && data.lumaplay_user !== user) {
          data.lumaplay_user = user;
          changed = true;
        }
        if (keyPath && data.lumaplay_key_path !== keyPath) {
          data.lumaplay_key_path = keyPath;
          changed = true;
        }
        if (!changed) return false;
        fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
        meta.emu = "lumaplay";
        meta.lumaplay_user = user || data.lumaplay_user || "";
        return true;
      } catch {
        return false;
      }
    };

    for (const row of discovered) {
      const appid = String(row?.appid || "").trim();
      if (!appid || !/^[0-9a-fA-F]+$/.test(appid)) continue;
      if (isAppIdBlacklisted(appid, "uplay", blacklistState)) continue;
      const metas = getConfigMetas(appid);
      const hasLumaPlay = metas.some((meta) => isLumaPlayMeta(meta));
      if (hasLumaPlay) continue;
      const task = {
        appid,
        user: String(row?.user || "").trim(),
        keyPath: String(row?.keyPath || "").trim(),
        __taskIndex: lumaGenerationTasks.length,
      };
      lumaGenerationTaskIndex.set(buildLumaTaskKey(task), task);
      lumaGenerationTasks.push(task);
    }
    const lumaBatchProgress =
      lumaGenerationTasks.length > 0
        ? createGenerationBatchReporter(lumaGenerationTasks, {
            rootLabel: "LumaPlay",
            fallbackItemName: "LumaPlay",
            defaultDetail: "Preparing config generation",
          })
        : null;
    lumaBatchProgress?.start();

    for (const row of discovered) {
      const appid = String(row?.appid || "").trim();
      const user = String(row?.user || "").trim();
      const keyPath = String(row?.keyPath || "").trim();
      if (!appid || !/^[0-9a-fA-F]+$/.test(appid)) continue;
      if (isAppIdBlacklisted(appid, "uplay", blacklistState)) continue;

      knownAppIds.add(appid);
      const metas = getConfigMetas(appid);
      const hasLumaPlay = metas.some((meta) => isLumaPlayMeta(meta));
      if (hasLumaPlay) {
        for (const meta of metas) {
          if (!isLumaPlayMeta(meta)) continue;
          if (
            isAppIdBlacklisted(appid, meta?.platform || "uplay", blacklistState)
          ) {
            continue;
          }
          if (markConfigAsLumaPlay(meta, user, keyPath)) {
            updatedIds.add(appid);
          }
        }
        continue;
      }

      const task = lumaGenerationTaskIndex.get(buildLumaTaskKey(row)) || null;
      const taskIndex = Number.isInteger(task?.__taskIndex)
        ? task.__taskIndex
        : -1;
      const generationResult = await generateOneAppId(appid, null, {
        forcePlatform: "uplay",
        __emu: "lumaplay",
        __lumaplayUser: user,
        __lumaplayKeyPath: keyPath,
        onGenerationProgress: task
          ? (progress) => {
              lumaBatchProgress?.updateTask(task, taskIndex, progress);
            }
          : undefined,
      });
      if (task) {
        lumaBatchProgress?.settleTask(task, taskIndex, generationResult);
      }
      if (generationResult?.created === true) {
        createdIds.add(appid);
        continue;
      }

      const candidate = metas.find(
        (meta) => normalizePlatform(meta?.platform) === "uplay",
      );
      if (candidate) {
        const hasUsableSavePath =
          isNonEmptyString(candidate?.save_path) &&
          fs.existsSync(candidate.save_path);
        if (
          !hasUsableSavePath &&
          markConfigAsLumaPlay(candidate, user, keyPath)
        ) {
          updatedIds.add(appid);
        }
      }
    }

    lumaBatchProgress?.finish("success", "Config generation completed");

    if (createdIds.size || updatedIds.size) {
      await indexExistingConfigsSync();
      if (autoRebuild) {
        await rebuildSaveWatchers({ suppressInitialNotify });
      }
      broadcastAll("configs:changed");
      broadcastAll("refresh-achievements-table");
      emitDashboardRefresh();
    }

    const created = createdIds.size;
    const updated = updatedIds.size;
    if (created || updated) {
      watcherLogger.info("lumaplay:scan-applied", {
        scanned: discovered.length,
        created,
        updated,
      });
    }
    return {
      scanned: discovered.length,
      created,
      updated,
    };
  }

  function startLumaPlayDiscoveryPolling() {
    if (process.platform !== "win32") return;
    if (!isLumaPlayWatcherEnabled()) {
      stopLumaPlayDiscoveryPolling();
      return;
    }
    if (lumaPlayDiscoveryWatcher) return;
    lumaPlayDiscoveryWatcher = startLumaPlayRegistryEventWatcher({
      restartDelayMs: LUMAPLAY_EVENT_WATCH_RESTART_MS,
      onReady: () => {
        watcherLogger.info("lumaplay:realtime-event-start", {
          mode: "registry-event",
          restartDelayMs: LUMAPLAY_EVENT_WATCH_RESTART_MS,
        });
        clearLumaPlayReadCache();
        scheduleLumaPlayDiscoveryTick({ autoRebuild: true }, 0);
      },
      onChange: () => {
        clearLumaPlayReadCache();
        scheduleLumaPlayDiscoveryTick({ autoRebuild: true });
      },
      onWarn: (error) => {
        watcherLogger.warn("lumaplay:realtime-event-warning", {
          error: String(error || ""),
        });
      },
      onLifecycle: (lifecycle = {}) => {
        const state = String(lifecycle?.state || "");
        if (state === "ready" || state === "spawned") return;
        const details = {
          state,
          pid: Number(lifecycle?.pid) || 0,
          restartCount: Number(lifecycle?.restartCount) || 0,
          consecutiveFailures: Number(lifecycle?.consecutiveFailures) || 0,
          circuitOpenUntil: Number(lifecycle?.circuitOpenUntil) || 0,
          reason: String(lifecycle?.reason || ""),
        };
        if (
          state === "exited" ||
          state === "failed" ||
          state === "circuit-open" ||
          state === "force-stopping"
        ) {
          watcherLogger.warn("lumaplay:realtime-event-lifecycle", details);
        } else {
          watcherLogger.info("lumaplay:realtime-event-lifecycle", details);
        }
      },
    });
  }

  function stopLumaPlayDiscoveryPolling() {
    if (lumaPlayDiscoveryWatcher) {
      lumaPlayDiscoveryWatcher.stop();
      lumaPlayDiscoveryWatcher = null;
    }
    clearLumaPlayDiscoveryTimer();
    lumaPlayDiscoveryScheduledOptions = null;
    clearLumaPlayReadCache();
    lumaPlayDiscoveryRunning = false;
    lumaPlayDiscoveryPending = false;
    watcherLogger.info("lumaplay:realtime-event-stop");
  }

  function seedInitialSnapshot(
    appid,
    meta,
    candidates,
    initialFlag = true,
    opts = {},
  ) {
    appid = String(appid);
    const configName = meta?.name || appid;
    let seeded = false;
    const bootLikeSeed = bootMode || opts.bornInBoot === true;
    const suppressInitialNotify =
      opts.suppressInitialNotify === true || bootLikeSeed;
    const fromUnblock =
      opts.fromBlacklist === true ||
      (Array.isArray(opts.appIdsFromBlacklist) &&
        opts.appIdsFromBlacklist.includes(appid)) ||
      isRecentlyUnblocked(appid, meta);

    // If coming from un-blacklist, preload snapshot from cache to avoid replaying notifications
    const snapKey = makeSnapshotKey(meta, appid);
    if (fromUnblock && !lastSnapshot.has(snapKey)) {
      try {
        const cached =
          typeof getCachedSnapshot === "function"
            ? getCachedSnapshot(meta?.name || appid, meta?.platform || null, {
                savePath: meta?.save_path || null,
                appid,
              })
            : null;
        if (cached && typeof cached === "object") {
          lastSnapshot.set(snapKey, cached);
          watcherLogger.info("unblock:seed-from-cache", {
            appid,
            config: meta?.name || appid,
            entries: Object.keys(cached || {}).length,
          });
        }
      } catch {}
    }

    if (isLumaPlayMeta(meta)) {
      const seeded = seedLumaPlaySnapshot(appid, meta, initialFlag, opts);
      if (
        !seeded &&
        typeof getCachedSnapshot === "function" &&
        !lastSnapshot.has(snapKey)
      ) {
        const cached = getCachedSnapshot(
          meta?.name || appid,
          meta?.platform || null,
          {
            savePath: meta?.save_path || null,
            appid,
          },
        );
        if (cached && typeof cached === "object") {
          lastSnapshot.set(snapKey, cached);
        }
      }
      return;
    }

    const orderedCandidates = isPs4Meta(meta)
      ? [
          ...candidates.filter((fp) => isPs4ProgressXmlPath(fp)),
          ...candidates.filter((fp) => !isPs4ProgressXmlPath(fp)),
        ]
      : candidates;
    const hasPs4ProgressCandidate =
      isPs4Meta(meta) &&
      orderedCandidates.some((fp) => isPs4ProgressXmlPath(fp));

    for (const fp of orderedCandidates) {
      if (!fp || !fs.existsSync(fp)) continue;
      if (isXeniaMeta(meta) && !isExpectedXeniaGpdFile(meta, appid, fp)) {
        continue;
      }
      try {
        const cacheSavePathForFp =
          isPs4Meta(meta) && isPs4ProgressXmlPath(fp)
            ? fp
            : meta?.save_path || null;
        const snapKey = makeSnapshotKey(meta, appid, {
          filePath: fp,
          savePath: cacheSavePathForFp,
        });
        let snapshot = null;
        let metaPath = fp;
        if (isPs4Meta(meta)) {
          try {
            const s = fs.statSync(fp);
            if (s.isDirectory()) {
              metaPath = path.join(fp, "Xml", "TROP.XML");
            }
          } catch {}
        } else if (isRpcs3Meta(meta)) {
          try {
            const s = fs.statSync(fp);
            if (s.isDirectory()) {
              metaPath = resolveTropusrPathForMeta(meta) || fp;
            }
          } catch {}
        } else if (isGogOfficialMeta(meta)) {
          const targetDb =
            path.basename(fp).toLowerCase() === GAMEPLAY_DB_NAME
              ? fp
              : path.join(fp, GAMEPLAY_DB_NAME);
          if (!fs.existsSync(targetDb)) continue;
          metaPath = targetDb;
        } else if (isUbisoftOfficialMeta(meta)) {
          const targetSpool =
            /\.spool$/i.test(path.basename(fp)) &&
            !fs.statSync(fp).isDirectory()
              ? fp
              : path.join(fp, `${appid}.spool`);
          if (!fs.existsSync(targetSpool)) continue;
          metaPath = targetSpool;
        } else if (isEaOfficialMeta(meta)) {
          const targetLog =
            path.basename(fp).toLowerCase() ===
            EA_VERBOSE_LOG_NAME.toLowerCase()
              ? fp
              : path.join(fp, EA_VERBOSE_LOG_NAME);
          if (!fs.existsSync(targetLog)) continue;
          metaPath = targetLog;
        }
        if (
          isPs4Meta(meta) &&
          hasPs4ProgressCandidate &&
          !isPs4ProgressXmlPath(fp)
        ) {
          const stat = readFileStatSyncSafe(metaPath);
          if (stat) {
            updateCacheMetaEntry(getCacheMetaKey(meta, appid, metaPath), stat);
          }
          continue;
        }
        if (bootLikeSeed) {
          loadCacheMetaOnce();
          const metaKey = getCacheMetaKey(meta, appid, metaPath);
          const cachedMeta = metaKey ? cacheMeta.get(metaKey) : null;
          if (cachedMeta && typeof cachedMeta === "object") {
            const stat = readFileStatSyncSafe(metaPath);
            const mtimeMs = Number(cachedMeta.mtimeMs ?? 0);
            const size = Number(cachedMeta.size ?? 0);
            if (
              stat &&
              Number.isFinite(mtimeMs) &&
              Number.isFinite(size) &&
              stat.mtimeMs === mtimeMs &&
              stat.size === size
            ) {
              if (!lastSnapshot.has(snapKey)) {
                try {
                  const cached =
                    typeof getCachedSnapshot === "function"
                      ? getCachedSnapshot(
                          meta?.name || appid,
                          meta?.platform || null,
                          {
                            savePath: cacheSavePathForFp,
                            appid,
                          },
                        )
                      : null;
                  if (cached && typeof cached === "object") {
                    lastSnapshot.set(snapKey, cached);
                  }
                } catch {}
              }
              if (lastSnapshot.has(snapKey)) {
                const configName = meta?.name || appid;
                if (initialFlag) {
                  seededInitialConfigs.add(configName);
                }
                seeded = true;
                break;
              }
            }
          }
        }
        if (isXeniaMeta(meta) && fp.toLowerCase().endsWith(".gpd")) {
          const parsed = parseGpdFile(fp);
          snapshot = buildSnapshotFromGpd(parsed);
        } else if (isRpcs3Meta(meta)) {
          let trophyDir = "";
          try {
            const stat = fs.statSync(fp);
            trophyDir = stat.isDirectory() ? fp : path.dirname(fp);
          } catch {
            trophyDir = path.dirname(fp);
          }
          if (trophyDir) {
            const parsed = parseTrophySetDir(trophyDir);
            snapshot = buildSnapshotFromTrophy(parsed);
          }
        } else if (isSteamOfficialMeta(meta)) {
          try {
            const schemaPath = resolveAchievementsSchemaPath(meta);
            const schemaArr =
              schemaPath && fs.existsSync(schemaPath)
                ? readJsonSafe(schemaPath)
                : null;
            const statsDir = meta.save_path || path.dirname(fp);
            let entries = normalizeAppcacheSchemaEntries(schemaArr);
            const schemaBin =
              statsDir && (meta.appid || appid)
                ? path.join(
                    statsDir,
                    `UserGameStatsSchema_${meta.appid || appid}.bin`,
                  )
                : "";
            entries = enrichSchemaEntriesFromAppcacheSchemaFile(
              entries,
              schemaBin,
            );
            let userBin = fp;
            const base = path.basename(userBin || "").toLowerCase();
            if (!base.startsWith("usergamestats_") || !base.endsWith(".bin")) {
              userBin = pickConfiguredSteamOfficialUserBin(
                statsDir,
                meta.appid || appid,
              );
            }
            if (entries.length && userBin && fs.existsSync(userBin)) {
              const kv = parseSteamKv(fs.readFileSync(userBin));
              const userStats = extractUserStats(kv.data);
              snapshot = buildSnapshotFromAppcache(entries, userStats);
            }
          } catch {}
        } else if (isGogOfficialMeta(meta)) {
          snapshot = loadAchievementsFromSaveFile(
            path.dirname(metaPath),
            lastSnapshot.get(snapKey) || {},
            {
              configMeta: meta,
              fullSchemaPath: resolveAchievementsSchemaPath(meta),
            },
          );
        } else if (isUbisoftOfficialMeta(meta)) {
          snapshot = loadAchievementsFromSaveFile(
            path.dirname(metaPath),
            lastSnapshot.get(snapKey) || {},
            {
              configMeta: meta,
              fullSchemaPath: resolveAchievementsSchemaPath(meta),
            },
          );
        } else if (isEaOfficialMeta(meta)) {
          snapshot = loadAchievementsFromSaveFile(
            path.dirname(metaPath),
            lastSnapshot.get(snapKey) || {},
            {
              configMeta: meta,
              fullSchemaPath: resolveAchievementsSchemaPath(meta),
            },
          );
        } else if (isMarkerPatchConfig(meta)) {
          const parsed = readMarkerPatchSnapshot(
            metaPath,
            lastSnapshot.get(snapKey) || {},
          );
          snapshot = parsed.valid ? parsed.snapshot : null;
        } else if (isPs4Meta(meta)) {
          let trophyDir = meta?.save_path || "";
          try {
            const stat = fs.statSync(fp);
            if (stat.isDirectory()) {
              trophyDir = fp;
            } else if (isPs4ProgressXmlPath(fp)) {
              trophyDir = resolvePs4TrophyDirForMeta(meta);
            } else {
              // TROP.XML lives under <trophyDir>/Xml
              trophyDir = path.dirname(path.dirname(fp));
            }
          } catch {
            trophyDir = meta?.save_path || path.dirname(path.dirname(fp));
          }
          if (trophyDir) {
            try {
              if (isPs4ProgressXmlPath(fp)) {
                snapshot = buildSnapshotFromPs4ProgressFile(
                  fp,
                  lastSnapshot.get(snapKey) || {},
                );
              } else {
                const parsed = parsePs4TrophySetDir(trophyDir);
                parsed.appid = String(meta?.appid || parsed.appid || "");
                snapshot = buildSnapshotFromPs4(
                  parsed,
                  lastSnapshot.get(snapKey) || {},
                );
              }
            } catch (err) {
              watcherLogger.warn("ps4:seed:parse-failed", {
                appid,
                config: meta?.name || appid,
                file: fp,
                trophyDir,
                error: err?.message || String(err),
              });
            }
          }
        } else {
          snapshot = loadAchievementsFromSaveFile(
            path.dirname(fp),
            lastSnapshot.get(snapKey) || {},
            {
              configMeta: meta,
              fullSchemaPath: resolveAchievementsSchemaPath(meta),
            },
          );
        }
        if (!snapshot) continue;

        const metaKey = getCacheMetaKey(meta, appid, metaPath);
        const stat = readFileStatSyncSafe(metaPath);
        if (stat) updateCacheMetaEntry(metaKey, stat);

        lastSnapshot.set(snapKey, snapshot);
        const configName = meta?.name || appid;
        if (typeof onSeedCache === "function") {
          try {
            const skipBootSeed = isBootSnapshotIdentical(
              meta,
              appid,
              snapshot,
              { bootLike: bootLikeSeed, savePath: cacheSavePathForFp },
            );
            if (!skipBootSeed) {
              onSeedCache({
                appid,
                configName,
                platform: meta?.platform || null,
                savePath: cacheSavePathForFp,
                snapshot,
              });
            } else {
              watcherLogger.info("seed:cache-skip-identical", {
                appid,
                config: configName,
                file: metaPath || fp,
                bootMode,
              });
            }
          } catch {}
        }
        if (initialFlag && !suppressInitialNotify) {
          pendingInitialNotify.add(configName);
          seededInitialConfigs.add(configName);
          watcherLogger.info("seed:pending-notify-set", {
            appid,
            config: configName,
            file: metaPath || fp,
            bootMode,
          });
        } else if (initialFlag) {
          seededInitialConfigs.add(configName);
          watcherLogger.info("seed:pending-notify-skip", {
            appid,
            config: configName,
            file: metaPath || fp,
            bootMode,
          });
        }
        seeded = true;
        break;
      } catch {}
    }

    if (!seeded && typeof getCachedSnapshot === "function") {
      const snapKey = makeSnapshotKey(meta, appid);
      const cached = getCachedSnapshot(
        meta?.name || appid,
        meta?.platform || null,
        {
          savePath: meta?.save_path || null,
          appid,
        },
      );
      if (cached && typeof cached === "object") {
        lastSnapshot.set(snapKey, cached);
      }
    }
  }

  function findMarkerPatchMetaForRoot(rootPath) {
    const rootKey = normalizeMarkerPatchPath(rootPath);
    if (!rootKey) return null;
    for (const metas of configIndex.values()) {
      for (const meta of metas || []) {
        if (!isMarkerPatchConfig(meta)) continue;
        if (normalizeMarkerPatchPath(getMarkerPatchGamePath(meta)) === rootKey) {
          return meta;
        }
      }
    }
    return null;
  }

  function stopMarkerPatchSaveWatcher(meta, reason) {
    if (!meta?.name || !meta?.appid) return false;
    const bucket = appidSaveWatchers.get(String(meta.appid));
    const watcher = bucket instanceof Map ? bucket.get(meta.name) : null;
    if (!watcher) return false;
    try {
      watcher.close();
    } catch {}
    bucket.delete(meta.name);
    if (bucket.size === 0) appidSaveWatchers.delete(String(meta.appid));
    watcherLogger.info("markerpatch:unwatch-state", {
      config: meta.name,
      appid: String(meta.appid),
      reason: String(reason || "unavailable"),
    });
    return true;
  }

  function findMadnessPatchMetaForRoot(rootPath, detection = null) {
    const rootKeys = new Set();
    const addRootKey = (candidate) => {
      const key = normalizeMadnessPatchPath(candidate);
      if (key) rootKeys.add(key);
    };
    addRootKey(rootPath);
    addRootKey(detection?.root);
    try {
      for (const candidate of getMadnessPatchCandidateRoots(rootPath)) {
        addRootKey(candidate);
      }
    } catch {}
    if (!rootKeys.size) return null;
    for (const metas of configIndex.values()) {
      for (const meta of metas || []) {
        if (!isMadnessPatchConfig(meta)) continue;
        if (rootKeys.has(normalizeMadnessPatchPath(getMadnessPatchGamePath(meta)))) {
          return meta;
        }
      }
    }
    return null;
  }

  function stopMadnessPatchSaveWatcher(meta, reason) {
    if (!meta?.name || !meta?.appid) return false;
    const bucket = appidSaveWatchers.get(String(meta.appid));
    const watcher = bucket instanceof Map ? bucket.get(meta.name) : null;
    if (!watcher) return false;
    Promise.resolve(watcher.close()).catch(() => {});
    bucket.delete(meta.name);
    if (bucket.size === 0) appidSaveWatchers.delete(String(meta.appid));
    watcherLogger.info("madnesspatch:unwatch-state", {
      config: meta.name,
      appid: String(meta.appid),
      reason: String(reason || "unavailable"),
    });
    return true;
  }

  function detectLocalPatchRootState(rootPath) {
    const madnessPatchDetection = detectMadnessPatchRoot(rootPath);
    const markerPatchDetection = detectMarkerPatchRoot(rootPath);
    const type = madnessPatchDetection.detected
      ? "madnesspatch"
      : markerPatchDetection.detected
        ? "markerpatch"
        : "";
    return {
      type,
      active: !!type,
      madnessPatchDetection,
      markerPatchDetection,
    };
  }

  function isLocalPatchSignatureEvent(rootPath, eventPath) {
    if (!rootPath || !eventPath) return false;
    let relative = "";
    try {
      relative = path.relative(rootPath, eventPath);
    } catch {
      return false;
    }
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    const normalized = relative.split(/[\\/]+/).join("/").toLowerCase();
    const markerSignatures = new Set([
      "deadspace2.exe",
      "markerpatch.ini",
      "achievements",
      "achievements/img",
      "achievements/txt",
    ]);
    if (markerSignatures.has(normalized)) return true;

    const madnessCandidatePrefixes = [
      "",
      "binaries/win32",
      "alice2/binaries/win32",
      "game/alice2/binaries/win32",
    ];
    const madnessSignatures = [
      "alicemadnessreturns.exe",
      "madnesspatch.ini",
      "dinput8.dll",
      "achievements",
      "achievements/img",
      "achievements/txt",
    ];
    return madnessCandidatePrefixes.some((prefix) =>
      madnessSignatures.some(
        (signature) => normalized === (prefix ? `${prefix}/${signature}` : signature),
      ),
    );
  }

  async function handleMadnessPatchRoot(rootPath, opts = {}) {
    const detection =
      opts.madnessPatchDetection || detectMadnessPatchRoot(rootPath);
    const existingMeta = findMadnessPatchMetaForRoot(rootPath, detection);
    if (!detection.detected) {
      if (!existingMeta) return { handled: false };
      if (stopMadnessPatchSaveWatcher(existingMeta, "signature-missing")) {
        watcherLogger.warn("madnesspatch:signature-missing", {
          root: normalizePrefPath(rootPath),
          config: existingMeta.name,
          signals: detection.signals || null,
        });
      }
      return {
        handled: false,
        staleLocalPatch: true,
        available: false,
        configName: existingMeta.name,
      };
    }

    const blacklistState = getBlacklistState();
    if (
      isAppIdBlacklisted(
        MADNESSPATCH_APP_ID,
        "madnesspatch",
        blacklistState,
      )
    ) {
      if (existingMeta) {
        stopMadnessPatchSaveWatcher(existingMeta, "blacklisted");
      }
      watcherLogger.info("madnesspatch:skip-blacklisted", {
        root: detection.root,
        appid: MADNESSPATCH_APP_ID,
      });
      return { handled: true, blacklisted: true };
    }

    if (configDeletionGuard.isSuppressed(MADNESSPATCH_APP_ID)) {
      watcherLogger.info("madnesspatch:skip-config-deleting", {
        root: detection.root,
        appid: MADNESSPATCH_APP_ID,
      });
      return { handled: true, configDeleting: true };
    }
    const finishGeneration =
      configDeletionGuard.tryStartGeneration(MADNESSPATCH_APP_ID);
    if (!finishGeneration) return { handled: true, configDeleting: true };

    try {
      const documentsPath = (() => {
        try {
          return app?.getPath?.("documents") || "";
        } catch {
          return "";
        }
      })();
      const prefs = readPrefsSafe();
      const schemaLanguages = Array.isArray(prefs?.schemaLanguages)
        ? prefs.schemaLanguages.length
          ? prefs.schemaLanguages
          : ["english"]
        : undefined;
      const result = ensureMadnessPatchConfig({
        rootPath: detection.root,
        configsDir,
        documentsPath,
        userProfile: process.env.USERPROFILE || "",
        schemaLanguages,
      });
      await indexExistingConfigsSync();
      knownAppIds.add(MADNESSPATCH_APP_ID);
      const meta = findMadnessPatchMetaForRoot(detection.root, detection);
      if (meta) {
        attachWatcherForMeta(meta, {
          suppressInitialNotify: opts.suppressInitialNotify !== false,
          deferInitialSeed: rescanInProgress.value,
        });
      }
      if (result.created || result.updated || result.schemaUpdated) {
        broadcastAll("configs:changed");
        broadcastAll("refresh-achievements-table");
        emitDashboardRefresh();
      }
      const stateFiles = listMadnessPatchStateFiles(result.checkpointRoot);
      watcherLogger.info("madnesspatch:scan-complete", {
        root: detection.root,
        config: result.name,
        checkpointRoot: result.checkpointRoot || null,
        checkpointRootExists:
          !!result.checkpointRoot && fs.existsSync(result.checkpointRoot),
        profiles: stateFiles.length,
        created: result.created,
        updated: result.updated,
        schemaUpdated: result.schemaUpdated,
        unchanged: result.unchanged,
      });
      return { handled: true, available: true, ...result };
    } catch (error) {
      watcherLogger.error("madnesspatch:scan-failed", {
        root: detection.root || normalizePrefPath(rootPath),
        error: error?.message || String(error),
      });
      notifyWarn(
        `MadnessPatch scan failed for "${detection.root || rootPath}": ${
          error?.message || String(error)
        }`,
      );
      return { handled: true, available: false, error };
    } finally {
      finishGeneration();
    }
  }

  async function handleMarkerPatchRoot(rootPath, opts = {}) {
    const detection = opts.markerPatchDetection || detectMarkerPatchRoot(rootPath);
    const existingMeta = findMarkerPatchMetaForRoot(rootPath);
    if (!detection.detected) {
      if (!existingMeta) return { handled: false };
      if (stopMarkerPatchSaveWatcher(existingMeta, "signature-missing")) {
        watcherLogger.warn("markerpatch:signature-missing", {
          root: normalizePrefPath(rootPath),
          config: existingMeta.name,
          signals: detection.signals || null,
        });
      }
      return {
        handled: false,
        staleLocalPatch: true,
        available: false,
        configName: existingMeta.name,
      };
    }

    const blacklistState = getBlacklistState();
    if (
      isAppIdBlacklisted(
        MARKERPATCH_APP_ID,
        "markerpatch",
        blacklistState,
      )
    ) {
      if (existingMeta) stopMarkerPatchSaveWatcher(existingMeta, "blacklisted");
      watcherLogger.info("markerpatch:skip-blacklisted", {
        root: detection.root,
        appid: MARKERPATCH_APP_ID,
      });
      return { handled: true, blacklisted: true };
    }

    if (configDeletionGuard.isSuppressed(MARKERPATCH_APP_ID)) {
      watcherLogger.info("markerpatch:skip-config-deleting", {
        root: detection.root,
        appid: MARKERPATCH_APP_ID,
      });
      return { handled: true, configDeleting: true };
    }
    const finishGeneration =
      configDeletionGuard.tryStartGeneration(MARKERPATCH_APP_ID);
    if (!finishGeneration) {
      return { handled: true, configDeleting: true };
    }

    try {
      const appData = (() => {
        try {
          return app?.getPath?.("appData") || "";
        } catch {
          return "";
        }
      })();
      const markerPrefs = readPrefsSafe();
      const schemaLanguages = Array.isArray(markerPrefs?.schemaLanguages)
        ? markerPrefs.schemaLanguages.length
          ? markerPrefs.schemaLanguages
          : ["english"]
        : undefined;
      const result = ensureMarkerPatchConfig({
        rootPath: detection.root,
        configsDir,
        localAppData: process.env.LOCALAPPDATA || "",
        appData,
        schemaLanguages,
      });
      await indexExistingConfigsSync();
      knownAppIds.add(MARKERPATCH_APP_ID);
      const meta = findMarkerPatchMetaForRoot(detection.root);
      if (meta) {
        attachWatcherForMeta(meta, {
          suppressInitialNotify: opts.suppressInitialNotify !== false,
          deferInitialSeed: rescanInProgress.value,
        });
      }

      if (result.created || result.updated || result.schemaUpdated) {
        broadcastAll("configs:changed");
        broadcastAll("refresh-achievements-table");
        emitDashboardRefresh();
      }
      watcherLogger.info("markerpatch:scan-complete", {
        root: detection.root,
        config: result.name,
        stateFile: result.stateFile || null,
        stateFileExists: !!result.stateFile && fs.existsSync(result.stateFile),
        created: result.created,
        updated: result.updated,
        schemaUpdated: result.schemaUpdated,
        unchanged: result.unchanged,
      });
      return { handled: true, available: true, ...result };
    } catch (error) {
      watcherLogger.error("markerpatch:scan-failed", {
        root: detection.root || normalizePrefPath(rootPath),
        error: error?.message || String(error),
      });
      notifyWarn(
        `MarkerPatch scan failed for "${detection.root || rootPath}": ${
          error?.message || String(error)
        }`,
      );
      return { handled: true, available: false, error };
    } finally {
      finishGeneration();
    }
  }

  async function scanRootOnce(rootPath, opts = {}) {
    const suppressInitialNotify = opts.suppressInitialNotify === true;
    const promoteSingleGeneratedInitialNotify =
      opts.promoteSingleGeneratedInitialNotify === true;
    const promoteInitialNotifyAppIds = new Set(
      (Array.isArray(opts.promoteInitialNotifyAppIds)
        ? opts.promoteInitialNotifyAppIds
        : [opts.promoteInitialNotifyAppIds]
      )
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    let rootBatchProgress = null;
    try {
      if (!rootPath || !fs.existsSync(rootPath)) return;
      const blockedFolders = getBlockedFoldersSet();
      if (isPathBlocked(rootPath, blockedFolders)) return;
      const localPatchState =
        opts.localPatchState || detectLocalPatchRootState(rootPath);
      const watchedRootState = folderWatchers.get(normalizeRoot(rootPath));
      if (watchedRootState) watchedRootState.localPatchState = localPatchState;
      const madnessPatchResult = await handleMadnessPatchRoot(rootPath, {
        ...opts,
        madnessPatchDetection: localPatchState.madnessPatchDetection,
      });
      if (madnessPatchResult.handled) return madnessPatchResult;
      const markerPatchResult = await handleMarkerPatchRoot(rootPath, {
        ...opts,
        markerPatchDetection: localPatchState.markerPatchDetection,
      });
      if (markerPatchResult.handled) return markerPatchResult;
      const scanScopeRoot = opts.scanScopeRoot
        ? normalizePrefPath(opts.scanScopeRoot)
        : null;
      const excludedScanRoots = new Set(
        (Array.isArray(opts.excludedScanRoots) ? opts.excludedScanRoots : [])
          .map(normalizePrefPath)
          .filter(
            (candidate) =>
              candidate &&
              (!scanScopeRoot || !isPathInsideRoot(candidate, scanScopeRoot)),
          ),
      );
      const shouldSkipPath = (candidatePath) => {
        const candidate = normalizePrefPath(candidatePath);
        if (!candidate) return true;
        if (isNormalizedPathBlocked(candidate, blockedFolders)) return true;
        if (
          scanScopeRoot &&
          !isPathInsideRoot(scanScopeRoot, candidate) &&
          !isPathInsideRoot(candidate, scanScopeRoot)
        ) {
          return true;
        }
        for (const excludedRoot of excludedScanRoots) {
          if (isPathInsideRoot(excludedRoot, candidate)) return true;
        }
        return false;
      };
      const base = path.basename(rootPath);
      const scanBase = isAppIdName(base) ? path.dirname(rootPath) : rootPath;

      const blacklistState = getBlacklistState();
      const yieldIfNeeded = createTimeSlicer(BOOT_SCAN_SLICE_MS);
      const strictRootProfile = getStrictRootProfile(scanBase);
      const isShadPs4ScanRoot = isShadPs4RuntimePath(scanBase);
      const attachSeedOptions = rescanInProgress.value
        ? { deferInitialSeed: true }
        : {};

      const generationTasks = [];
      const brandNewIds = [];
      const xeniaAppIds = new Set();
      let gogInfoFound = null;
      let discoveredMap = null;
      let discovered = [];
      let tenokeFound = null;
      let nemirtingasEpicDiscovery = false;

      if (!strictRootProfile) {
        const gpdFiles = await discoverGpdFilesUnder(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        );
        if (gpdFiles.length) {
          const schemaRoot = path.join(configsDir, "schema");
          const xeniaTasks = gpdFiles.map((gpdPath, taskIndex) => ({
            gpdPath,
            appid: path.basename(gpdPath, path.extname(gpdPath)),
            __taskIndex: taskIndex,
          }));
          const xeniaBatchProgress = createGenerationBatchReporter(xeniaTasks, {
            rootLabel: path.basename(rootPath || scanBase || "") || "",
            fallbackItemName: "Xenia",
            defaultDetail: "Parsing Xenia achievements",
            deferStartUntilVisible: bootMode === true,
          });
          xeniaBatchProgress.start();
          const handleGpd = async (task, taskIndex) => {
            const resolvedTaskIndex = Number.isInteger(taskIndex)
              ? taskIndex
              : Number.isInteger(task?.__taskIndex)
                ? task.__taskIndex
                : -1;
            const gpdPath = task?.gpdPath || "";
            const appid = String(
              task?.appid || path.basename(gpdPath, path.extname(gpdPath)),
            ).trim();
            if (
              !appid ||
              isAppIdBlacklisted(appid, "xenia", blacklistState) ||
              xeniaAppIds.has(appid)
            ) {
              xeniaBatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "skipped",
                detail: "Config generation skipped",
                percent: 100,
              });
              return;
            }
            try {
              xeniaBatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: bootMode ? "preparing" : "generatingSchema",
                detail: bootMode
                  ? "Checking Xenia achievements"
                  : "Parsing Xenia achievements",
                percent: bootMode ? 5 : 15,
              });
              const result = generateConfigFromGpd(gpdPath, configsDir, {
                schemaRoot,
                bootMode,
              });
              if (!result || result.skipped) {
                xeniaBatchProgress.updateTask(task, resolvedTaskIndex, {
                  appid,
                  itemName: result?.name || appid,
                  phase: "skipped",
                  detail: "Config generation skipped",
                  percent: 100,
                });
                return;
              }
              if (
                (result.created || result.schemaUpdated) &&
                bootMode &&
                typeof onSeedCache === "function"
              ) {
                const snapshot = result.snapshot;
                if (snapshot && Object.keys(snapshot).length) {
                  try {
                    onSeedCache({
                      appid: String(result.appid),
                      configName: result.name || String(result.appid),
                      platform: result.platform || "xenia",
                      savePath: result.save_path || null,
                      snapshot,
                    });
                  } catch {}
                }
              }
              xeniaAppIds.add(String(result.appid));
              knownAppIds.add(String(result.appid));
              const xeniaChanged =
                result?.created === true ||
                result?.schemaUpdated === true ||
                result?.configUpdated === true;
              xeniaBatchProgress.updateTask(task, resolvedTaskIndex, {
                appid: String(result.appid || appid),
                itemName: result?.name || result?.displayName || appid,
                phase: xeniaChanged ? "completed" : "skipped",
                detail:
                  result?.created === true
                    ? "Config created"
                    : xeniaChanged
                      ? "Config updated"
                      : "Config generation skipped",
                percent: 100,
              });
            } catch (err) {
              xeniaBatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "failed",
                detail: err?.message || "Config generation failed",
                percent: 100,
              });
              notifyWarn(`Xenia GPD parse failed "${gpdPath}": ${err.message}`);
            }
          };
          if (bootMode) {
            await runWithConcurrency(
              xeniaTasks,
              BOOT_SCAN_CONCURRENCY,
              handleGpd,
            );
          } else {
            for (
              let taskIndex = 0;
              taskIndex < xeniaTasks.length;
              taskIndex += 1
            ) {
              await handleGpd(xeniaTasks[taskIndex], taskIndex);
            }
          }
          if (xeniaAppIds.size) {
            await indexExistingConfigsSync();
            if (bootMode) {
              await attachSaveWatchersBatched(xeniaAppIds, {
                suppressInitialNotify,
                ...attachSeedOptions,
              });
            } else {
              await attachSaveWatchersBatched(xeniaAppIds, {
                suppressInitialNotify,
                batchDelayMs: BOOT_ATTACH_DELAY_MS,
                ...attachSeedOptions,
              });
            }
            broadcastAll("configs:changed");
            broadcastAll("refresh-achievements-table");
          }
          xeniaBatchProgress.finish("success", "Config generation completed");
          // GPD roots are handled by Xenia flow only (avoid auto-config conflicts).
          return;
        }

        const trophyDirs = await discoverRpcs3TrophyDirsUnder(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        );
        if (trophyDirs.length) {
          const schemaRoot = path.join(configsDir, "schema");
          const rpcs3AppIds = new Set();
          let rpcs3Changed = false;
          const rpcs3Tasks = trophyDirs.map((trophyDir, taskIndex) => ({
            trophyDir,
            appid: path.basename(trophyDir),
            __taskIndex: taskIndex,
          }));
          const rpcs3BatchProgress = createGenerationBatchReporter(rpcs3Tasks, {
            rootLabel: path.basename(rootPath || scanBase || "") || "",
            fallbackItemName: "RPCS3",
            defaultDetail: "Parsing RPCS3 trophies",
            deferStartUntilVisible: bootMode === true,
          });
          rpcs3BatchProgress.start();
          const handleTrophyDir = async (task, taskIndex) => {
            const resolvedTaskIndex = Number.isInteger(taskIndex)
              ? taskIndex
              : Number.isInteger(task?.__taskIndex)
                ? task.__taskIndex
                : -1;
            const trophyDir = task?.trophyDir || "";
            const appid = String(
              task?.appid || path.basename(trophyDir),
            ).trim();
            if (
              !appid ||
              isAppIdBlacklisted(appid, "rpcs3", blacklistState) ||
              rpcs3AppIds.has(appid)
            ) {
              rpcs3BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "skipped",
                detail: "Config generation skipped",
                percent: 100,
              });
              return;
            }
            try {
              rpcs3BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: bootMode ? "preparing" : "generatingSchema",
                detail: bootMode
                  ? "Checking RPCS3 trophies"
                  : "Parsing RPCS3 trophies",
                percent: bootMode ? 5 : 15,
              });
              const result = await generateConfigFromTrophyDir(
                trophyDir,
                configsDir,
                {
                  schemaRoot,
                  bootMode,
                },
              );
              if (!result || result.skipped) {
                rpcs3BatchProgress.updateTask(task, resolvedTaskIndex, {
                  appid,
                  itemName: result?.name || appid,
                  phase: "skipped",
                  detail: "Config generation skipped",
                  percent: 100,
                });
                return;
              }
              const rpcs3ResultChanged =
                result?.created === true ||
                result?.schemaUpdated === true ||
                result?.configUpdated === true;
              if (rpcs3ResultChanged) rpcs3Changed = true;
              if (
                (result.created || result.schemaUpdated) &&
                bootMode &&
                typeof onSeedCache === "function"
              ) {
                const snapshot = result.snapshot;
                if (snapshot && Object.keys(snapshot).length) {
                  try {
                    onSeedCache({
                      appid: String(result.appid),
                      configName: result.name || String(result.appid),
                      platform: result.platform || null,
                      savePath: result.save_path || null,
                      snapshot,
                    });
                  } catch {}
                }
              }
              rpcs3AppIds.add(String(result.appid));
              knownAppIds.add(String(result.appid));
              rpcs3BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid: String(result.appid || appid),
                itemName: result?.name || result?.displayName || appid,
                phase: rpcs3ResultChanged ? "completed" : "skipped",
                detail:
                  result?.created === true
                    ? "Config created"
                    : rpcs3ResultChanged
                      ? "Config updated"
                      : "Config generation skipped",
                percent: 100,
              });
            } catch (err) {
              rpcs3BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "failed",
                detail: err?.message || "Config generation failed",
                percent: 100,
              });
              notifyWarn(
                `RPCS3 trophy parse failed "${trophyDir}": ${err.message}`,
              );
            }
          };
          if (bootMode) {
            await runWithConcurrency(
              rpcs3Tasks,
              BOOT_SCAN_CONCURRENCY,
              handleTrophyDir,
            );
          } else {
            for (
              let taskIndex = 0;
              taskIndex < rpcs3Tasks.length;
              taskIndex += 1
            ) {
              await handleTrophyDir(rpcs3Tasks[taskIndex], taskIndex);
            }
          }
          if (rpcs3AppIds.size) {
            await indexExistingConfigsSync();
            if (bootMode) {
              await attachSaveWatchersBatched(rpcs3AppIds, {
                suppressInitialNotify,
                ...attachSeedOptions,
              });
            } else {
              await attachSaveWatchersBatched(rpcs3AppIds, {
                suppressInitialNotify,
                batchDelayMs: BOOT_ATTACH_DELAY_MS,
                ...attachSeedOptions,
              });
            }
            if (rpcs3Changed) {
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          }
          rpcs3BatchProgress.finish("success", "Config generation completed");
          // Trophy roots are handled by RPCS3 flow only (avoid auto-config conflicts).
          return;
        }

        const modernPs4ProcessedAppIds = new Set();
        const modernPs4ProcessedNpCommIds = new Set();
        const modernPs4Sets = await discoverModernPs4TrophySetsUnder(
          scanBase,
          yieldIfNeeded,
        );
        if (modernPs4Sets.length) {
          const schemaRoot = path.join(configsDir, "schema");
          const ps4AppIds = new Set();
          let ps4Changed = false;
          const ps4Tasks = modernPs4Sets.map((entry, taskIndex) => ({
            ...entry,
            __taskIndex: taskIndex,
          }));
          const ps4BatchProgress = createGenerationBatchReporter(ps4Tasks, {
            rootLabel: path.basename(rootPath || scanBase || "") || "",
            fallbackItemName: "PS4",
            defaultDetail: "Parsing shadPS4 trophies",
            deferStartUntilVisible: bootMode === true,
          });
          ps4BatchProgress.start();
          const handleModernPs4Set = async (task, taskIndex) => {
            const resolvedTaskIndex = Number.isInteger(taskIndex)
              ? taskIndex
              : Number.isInteger(task?.__taskIndex)
                ? task.__taskIndex
                : -1;
            const npcommid = String(task?.npcommid || "").trim();
            const appid = String(task?.appid || npcommid).trim();
            const progress =
              Array.isArray(task?.progressFiles) && task.progressFiles.length
                ? task.progressFiles[0]
                : null;
            if (
              !npcommid ||
              !appid ||
              isAppIdBlacklisted(appid, "shadps4", blacklistState) ||
              ps4AppIds.has(appid)
            ) {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: task?.title || appid || npcommid,
                phase: "skipped",
                detail: "Config generation skipped",
                percent: 100,
              });
              return;
            }
            try {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: task?.title || appid,
                phase: bootMode ? "preparing" : "generatingSchema",
                detail: bootMode
                  ? "Checking shadPS4 trophies"
                  : "Parsing shadPS4 trophies",
                percent: bootMode ? 5 : 15,
              });
              const result = await generateConfigFromPs4Dir(
                task.schemaDir,
                configsDir,
                {
                  schemaRoot,
                  appid,
                  npcommid,
                  progressPath: progress?.progressPath || "",
                  userId: progress?.userId || "",
                  bootMode,
                },
              );
              if (!result || result.skipped) {
                ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                  appid,
                  itemName: task?.title || appid,
                  phase: "skipped",
                  detail: "Config generation skipped",
                  percent: 100,
                });
                return;
              }
              const ps4ResultChanged =
                result?.created === true ||
                result?.schemaUpdated === true ||
                result?.configUpdated === true;
              if (ps4ResultChanged) ps4Changed = true;
              if (bootMode && typeof onSeedCache === "function") {
                const progressFiles = Array.isArray(task?.progressFiles)
                  ? task.progressFiles
                  : [];
                const seededProgressPaths = new Set();
                for (const progressFile of progressFiles) {
                  const progressPath = progressFile?.progressPath || "";
                  if (!progressPath || !fs.existsSync(progressPath)) continue;
                  const key = path.normalize(progressPath).toLowerCase();
                  if (seededProgressPaths.has(key)) continue;
                  seededProgressPaths.add(key);
                  try {
                    const snapshot = buildSnapshotFromPs4ProgressFile(
                      progressPath,
                      {},
                    );
                    if (snapshot && Object.keys(snapshot).length) {
                      onSeedCache({
                        appid: String(result.appid),
                        configName: result.name || String(result.appid),
                        platform: result.platform || null,
                        savePath: progressPath,
                        snapshot,
                      });
                    }
                  } catch {}
                }
                if (!seededProgressPaths.size) {
                  const snapshot = result.snapshot;
                  if (snapshot && Object.keys(snapshot).length) {
                    try {
                      onSeedCache({
                        appid: String(result.appid),
                        configName: result.name || String(result.appid),
                        platform: result.platform || null,
                        savePath: result.save_path || null,
                        snapshot,
                      });
                    } catch {}
                  }
                }
              }
              ps4AppIds.add(String(result.appid));
              modernPs4ProcessedAppIds.add(String(result.appid));
              if (npcommid) {
                modernPs4ProcessedNpCommIds.add(npcommid.toLowerCase());
              }
              knownAppIds.add(String(result.appid));
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid: String(result.appid || appid),
                itemName:
                  result?.name || result?.displayName || task?.title || appid,
                phase: ps4ResultChanged ? "completed" : "skipped",
                detail:
                  result?.created === true
                    ? "Config created"
                    : ps4ResultChanged
                      ? "Config updated"
                      : "Config generation skipped",
                percent: 100,
              });
            } catch (err) {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: task?.title || appid || npcommid,
                phase: "failed",
                detail: err?.message || "Config generation failed",
                percent: 100,
              });
              notifyWarn(
                `PS4 trophy parse failed "${task?.schemaDir || npcommid}": ${err.message}`,
              );
            }
          };
          if (bootMode) {
            await runWithConcurrency(
              ps4Tasks,
              BOOT_SCAN_CONCURRENCY,
              handleModernPs4Set,
            );
          } else {
            for (
              let taskIndex = 0;
              taskIndex < ps4Tasks.length;
              taskIndex += 1
            ) {
              await handleModernPs4Set(ps4Tasks[taskIndex], taskIndex);
            }
          }
          if (ps4AppIds.size) {
            await indexExistingConfigsSync();
            if (bootMode) {
              await attachSaveWatchersBatched(ps4AppIds, {
                suppressInitialNotify,
                ...attachSeedOptions,
              });
            } else {
              await attachSaveWatchersBatched(ps4AppIds, {
                suppressInitialNotify,
                batchDelayMs: BOOT_ATTACH_DELAY_MS,
                ...attachSeedOptions,
              });
            }
            if (ps4Changed) {
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          }
          ps4BatchProgress.finish("success", "Config generation completed");
        }

        const ps4Dirs = await discoverPs4TrophyDirsUnder(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        );
        if (ps4Dirs.length) {
          const schemaRoot = path.join(configsDir, "schema");
          const ps4AppIds = new Set();
          let ps4Changed = false;
          const ps4Tasks = ps4Dirs.map((trophyDir, taskIndex) => ({
            trophyDir,
            appid:
              getLegacyPs4AppIdFromTrophyDir(trophyDir) ||
              path.basename(path.dirname(path.dirname(trophyDir))),
            npcommid: readPs4NpCommIdFromTrophyDir(trophyDir),
            __taskIndex: taskIndex,
          }));
          const ps4BatchProgress = createGenerationBatchReporter(ps4Tasks, {
            rootLabel: path.basename(rootPath || scanBase || "") || "",
            fallbackItemName: "PS4",
            defaultDetail: "Parsing PS4 trophies",
            deferStartUntilVisible: bootMode === true,
          });
          ps4BatchProgress.start();
          const handlePs4Dir = async (task, taskIndex) => {
            const resolvedTaskIndex = Number.isInteger(taskIndex)
              ? taskIndex
              : Number.isInteger(task?.__taskIndex)
                ? task.__taskIndex
                : -1;
            const trophyDir = task?.trophyDir || "";
            const appid = String(
              task?.appid ||
                getLegacyPs4AppIdFromTrophyDir(trophyDir) ||
                path.basename(path.dirname(path.dirname(trophyDir))),
            ).trim();
            const npcommid = String(task?.npcommid || "").trim();
            if (
              !appid ||
              isAppIdBlacklisted(appid, "shadps4", blacklistState) ||
              ps4AppIds.has(appid) ||
              modernPs4ProcessedAppIds.has(appid) ||
              (npcommid &&
                modernPs4ProcessedNpCommIds.has(npcommid.toLowerCase()))
            ) {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "skipped",
                detail: "Config generation skipped",
                percent: 100,
              });
              return;
            }
            try {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: bootMode ? "preparing" : "generatingSchema",
                detail: bootMode
                  ? "Checking PS4 trophies"
                  : "Parsing PS4 trophies",
                percent: bootMode ? 5 : 15,
              });
              const result = await generateConfigFromPs4Dir(
                trophyDir,
                configsDir,
                {
                  schemaRoot,
                  appid,
                  npcommid,
                  bootMode,
                },
              );
              if (!result || result.skipped) {
                ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                  appid,
                  itemName: result?.name || appid,
                  phase: "skipped",
                  detail: "Config generation skipped",
                  percent: 100,
                });
                return;
              }
              const ps4ResultChanged =
                result?.created === true ||
                result?.schemaUpdated === true ||
                result?.configUpdated === true;
              if (ps4ResultChanged) ps4Changed = true;
              if (
                (result.created || result.schemaUpdated) &&
                bootMode &&
                typeof onSeedCache === "function"
              ) {
                const snapshot = result.snapshot;
                if (snapshot && Object.keys(snapshot).length) {
                  try {
                    onSeedCache({
                      appid: String(result.appid),
                      configName: result.name || String(result.appid),
                      platform: result.platform || null,
                      savePath: result.save_path || null,
                      snapshot,
                    });
                  } catch {}
                }
              }
              ps4AppIds.add(String(result.appid));
              knownAppIds.add(String(result.appid));
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid: String(result.appid || appid),
                itemName: result?.name || result?.displayName || appid,
                phase: ps4ResultChanged ? "completed" : "skipped",
                detail:
                  result?.created === true
                    ? "Config created"
                    : ps4ResultChanged
                      ? "Config updated"
                      : "Config generation skipped",
                percent: 100,
              });
            } catch (err) {
              ps4BatchProgress.updateTask(task, resolvedTaskIndex, {
                appid,
                itemName: appid,
                phase: "failed",
                detail: err?.message || "Config generation failed",
                percent: 100,
              });
              notifyWarn(
                `PS4 trophy parse failed "${trophyDir}": ${err.message}`,
              );
            }
          };
          if (bootMode) {
            await runWithConcurrency(
              ps4Tasks,
              BOOT_SCAN_CONCURRENCY,
              handlePs4Dir,
            );
          } else {
            for (
              let taskIndex = 0;
              taskIndex < ps4Tasks.length;
              taskIndex += 1
            ) {
              await handlePs4Dir(ps4Tasks[taskIndex], taskIndex);
            }
          }
          if (ps4AppIds.size) {
            await indexExistingConfigsSync();
            if (bootMode) {
              await attachSaveWatchersBatched(ps4AppIds, {
                suppressInitialNotify,
                ...attachSeedOptions,
              });
            } else {
              await attachSaveWatchersBatched(ps4AppIds, {
                suppressInitialNotify,
                batchDelayMs: BOOT_ATTACH_DELAY_MS,
                ...attachSeedOptions,
              });
            }
            if (ps4Changed) {
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          }
          ps4BatchProgress.finish("success", "Config generation completed");
          return;
        }

        if (isShadPs4ScanRoot) {
          // shadPS4 roots contain numeric user folders under home/<userId>.
          // Do not let the generic Steam/GOG numeric fallback treat them as app IDs.
          return;
        }

        // Steam official appcache (UserGameStatsSchema_*.bin)
        try {
          const normScanBase = String(scanBase)
            .replace(/[\\/]+/g, path.sep)
            .toLowerCase();
          const steamStatsSuffix = `${path.sep}steam${path.sep}appcache${path.sep}stats`;
          const steamRootSuffix = `${path.sep}steam`;
          const isSteamStatsRoot = normScanBase.endsWith(steamStatsSuffix);
          const isSteamRoot = normScanBase.endsWith(steamRootSuffix);
          const isSteamCacheRoot =
            isSteamRoot ||
            normScanBase.includes(
              `${path.sep}steam${path.sep}appcache${path.sep}`,
            );
          const steamStatsRoot = isSteamStatsRoot
            ? scanBase
            : isSteamRoot
              ? path.join(scanBase, "appcache", "stats")
              : null;

          if (
            isSteamCacheRoot &&
            (!steamStatsRoot || !fs.existsSync(steamStatsRoot))
          ) {
            // Only accept Steam official schema bins from appcache/stats
            return;
          }

          const steamScanBase = steamStatsRoot || scanBase;
          const entries = await fsp.readdir(steamScanBase);
          const schemaBins = entries.filter(
            (f) =>
              /^UserGameStatsSchema_\d+\.bin$/i.test(f) &&
              !shouldSkipPath(path.join(steamScanBase, f)),
          );
          if (schemaBins.length) {
            const steamIds = new Set();
            let steamChanged = false;
            let steamBatchFailed = false;
            const steamTasks = schemaBins.map((bin, index) => {
              const schemaBinPath = path.join(steamScanBase, bin);
              const schemaInfo = parseSteamOfficialBinInfo(schemaBinPath);
              return {
                index,
                bin,
                appid: schemaInfo?.appid ? String(schemaInfo.appid) : "",
                forcePlatform: "steam-official",
                schemaBinPath,
                schemaInfo,
              };
            });
            const steamBatchProgress = createGenerationBatchReporter(
              steamTasks,
              {
                rootLabel: path.basename(steamScanBase || "") || "",
                fallbackItemName: path.basename(steamScanBase || "") || "",
                deferStartUntilVisible: true,
                usePhaseOnlyDetails: true,
              },
            );
            const handleSchemaBin = async (task) => {
              const schemaBinPath = task.schemaBinPath;
              const schemaInfo = task.schemaInfo;
              const appidFromBin = schemaInfo?.appid
                ? String(schemaInfo.appid)
                : "";
              if (
                appidFromBin &&
                isAppIdBlacklisted(
                  appidFromBin,
                  "steam-official",
                  blacklistState,
                )
              ) {
                pendingSteamOfficial.delete(appidFromBin);
                watcherLogger.info("steam-official:skip-blacklisted", {
                  appid: appidFromBin,
                  source: "root-scan",
                });
                steamBatchProgress.updateTask(task, task.index, {
                  appid: appidFromBin,
                  itemName: appidFromBin,
                  phase: "skipped",
                  detail: "blacklisted",
                });
                return;
              }
              if (
                bootMode &&
                appidFromBin &&
                shouldSkipSteamOfficialGeneration(appidFromBin)
              ) {
                steamIds.add(appidFromBin);
                knownAppIds.add(appidFromBin);
                return;
              }
              let result = null;
              try {
                result = await generateConfigFromAppcacheBin(
                  steamScanBase,
                  schemaBinPath,
                  configsDir,
                  {
                    preferredAccountId: getPreferredSteamOfficialAccountId(),
                    shouldSkipAppId: (candidateAppId) =>
                      isAppIdBlacklisted(
                        candidateAppId,
                        "steam-official",
                      ),
                    onGenerationProgress: (progress = {}) => {
                      steamBatchProgress.updateTask(
                        task,
                        task.index,
                        progress,
                      );
                    },
                  },
                );
              } catch (err) {
                steamBatchFailed = true;
                steamBatchProgress.finish(
                  "failed",
                  err?.message || "",
                );
                throw err;
              }
              if (!result) return;
              if (result.skipped) {
                steamBatchProgress.updateTask(task, task.index, {
                  appid: appidFromBin || result.appid || "",
                  itemName: appidFromBin || result.appid || task.bin,
                  phase: "skipped",
                  detail: result.reason || "blacklisted",
                });
                return;
              }
              const resultAppId = String(result.appid);
              if (
                isAppIdBlacklisted(
                  resultAppId,
                  "steam-official",
                  blacklistState,
                )
              ) {
                return;
              }
              if (
                result.created ||
                result.schemaUpdated ||
                result.configUpdated
              ) {
                steamBatchProgress.settleTask(task, task.index, result);
              }
              steamIds.add(resultAppId);
              knownAppIds.add(resultAppId);
              if (
                result.created ||
                result.schemaUpdated ||
                result.configUpdated
              ) {
                steamChanged = true;
              }
              if (
                bootMode &&
                (result.created || result.schemaUpdated) &&
                typeof onSeedCache === "function"
              ) {
                const snapshot = result.snapshot;
                if (snapshot && Object.keys(snapshot).length) {
                  try {
                    onSeedCache({
                      appid: resultAppId,
                      configName: result.name || resultAppId,
                      platform: result.platform || null,
                      savePath: result.save_path || null,
                      snapshot,
                    });
                  } catch {}
                }
              }
            };
            if (bootMode) {
              await runWithConcurrency(
                steamTasks,
                BOOT_SCAN_CONCURRENCY,
                handleSchemaBin,
              );
            } else {
              for (const task of steamTasks) {
                await handleSchemaBin(task);
              }
            }
            if (!steamBatchFailed) {
              steamBatchProgress.finish(
                "success",
                "",
              );
            }
            if (steamIds.size) {
              await indexExistingConfigsSync();
              if (bootMode) {
                await attachSaveWatchersBatched(steamIds, {
                  suppressInitialNotify,
                  ...attachSeedOptions,
                });
              } else {
                await attachSaveWatchersBatched(steamIds, {
                  suppressInitialNotify,
                  batchDelayMs: BOOT_ATTACH_DELAY_MS,
                  ...attachSeedOptions,
                });
              }
              if (steamChanged) {
                broadcastAll("configs:changed");
                broadcastAll("refresh-achievements-table");
              }
            }
            // handled; avoid falling into generic numeric scan to prevent double-generate
            return;
          }
        } catch {}

        const eaLogsRoots = resolveEaOfficialLogsRoots(scanBase);
        if (eaLogsRoots.length) {
          let achievementSets = [];
          const seenAchievementSets = new Set();
          for (const logsRoot of eaLogsRoots) {
            try {
              const entries = listEaOfficialAchievementSets(logsRoot);
              for (const entry of entries) {
                const key = `${String(entry?.appid || "")}:${String(
                  entry?.achievementSet || "",
                )}`.toLowerCase();
                if (!key || seenAchievementSets.has(key)) continue;
                seenAchievementSets.add(key);
                achievementSets.push(entry);
              }
            } catch (err) {
              watcherLogger.warn("ea-official:scan-failed", {
                root: logsRoot,
                error: err?.message || String(err),
              });
            }
          }

          const entriesByAppId = new Map();
          for (const entry of achievementSets) {
            const productId = String(entry?.appid || "").trim();
            if (
              !productId ||
              isAppIdBlacklisted(productId, "ea-official", blacklistState)
            ) {
              continue;
            }
            const existingOfficial =
              getConfigMetas(productId).find((meta) =>
                isEaOfficialMeta(meta),
              ) || null;
            const current =
              existingOfficial &&
              String(existingOfficial.ea_achievement_set || "").trim() ===
                String(entry.achievementSet || "").trim();
            const previous = entriesByAppId.get(productId);
            if (
              !previous ||
              current ||
              Number(entry.order || 0) > Number(previous.order || 0)
            ) {
              entriesByAppId.set(productId, entry);
            }
          }

          for (const entry of entriesByAppId.values()) {
            const productId = String(entry.appid || "").trim();
            const logsRoot =
              entry.logsRoot || path.dirname(entry.logFilePath || "");
            const normalizedPath = normalizeObservedPath(logsRoot, productId);
            const pendingSet = pendingSavePathIndex.get(productId);
            const knownPaths = configSavePathIndex.get(productId);
            const alreadyTracked =
              normalizedPath &&
              ((knownPaths && knownPaths.has(normalizedPath)) ||
                (pendingSet && pendingSet.has(normalizedPath)));
            const hasOfficialVariant = hasPlatformVariant(
              productId,
              "ea-official",
            );
            knownAppIds.add(productId);
            if (alreadyTracked && hasOfficialVariant) continue;

            generationTasks.push({
              appid: productId,
              forcePlatform: "ea-official",
              appDir: logsRoot,
              normalizedPath,
              allowExistingVariant: hasOfficialVariant,
              __savePathOverride: logsRoot,
              __eaAchievementSet: entry.achievementSet || null,
              __eaLogFile: entry.logFilePath || null,
              __eaGameName: entry.gameName || null,
            });
            if (normalizedPath) markPendingSavePath(productId, normalizedPath);
          }

          if (generationTasks.length === 0) {
            return;
          }
        }

        const ubisoftSpoolRoots = resolveUbisoftSpoolRoots(scanBase);
        if (!eaLogsRoots.length && ubisoftSpoolRoots.length) {
          let spoolEntries = [];
          const seenSpoolFiles = new Set();
          for (const spoolRoot of ubisoftSpoolRoots) {
            try {
              const entries = listUbisoftOfficialSpoolEntries(spoolRoot);
              for (const entry of entries) {
                const key = String(entry?.spoolFilePath || "").toLowerCase();
                if (!key || seenSpoolFiles.has(key)) continue;
                seenSpoolFiles.add(key);
                spoolEntries.push(entry);
              }
            } catch (err) {
              watcherLogger.warn("ubisoft-official:scan-failed", {
                root: spoolRoot,
                error: err?.message || String(err),
              });
            }
          }

          const entriesByAppId = new Map();
          for (const entry of spoolEntries) {
            const productId = String(entry?.appid || "").trim();
            if (
              !productId ||
              isAppIdBlacklisted(productId, "ubisoft-official", blacklistState)
            ) {
              continue;
            }
            const existingOfficial =
              getConfigMetas(productId).find((meta) =>
                isUbisoftOfficialMeta(meta),
              ) || null;
            const current =
              existingOfficial &&
              existingOfficial.ubisoft_user_id === entry.userId;
            if (!entriesByAppId.has(productId) || current) {
              entriesByAppId.set(productId, entry);
            }
          }

          for (const entry of entriesByAppId.values()) {
            const productId = String(entry.appid || "").trim();
            const normalizedPath = normalizeObservedPath(
              entry.spoolDir,
              productId,
            );
            const pendingSet = pendingSavePathIndex.get(productId);
            const knownPaths = configSavePathIndex.get(productId);
            const alreadyTracked =
              normalizedPath &&
              ((knownPaths && knownPaths.has(normalizedPath)) ||
                (pendingSet && pendingSet.has(normalizedPath)));
            const hasOfficialVariant = hasPlatformVariant(
              productId,
              "ubisoft-official",
            );
            knownAppIds.add(productId);
            if (alreadyTracked && hasOfficialVariant) continue;

            generationTasks.push({
              appid: productId,
              forcePlatform: "ubisoft-official",
              appDir: entry.spoolDir,
              normalizedPath,
              allowExistingVariant: hasOfficialVariant,
              __savePathOverride: entry.spoolDir,
              __ubisoftUserId: entry.userId || null,
              __ubisoftSpoolFile: entry.spoolFilePath || null,
            });
            if (normalizedPath) markPendingSavePath(productId, normalizedPath);
          }

          if (generationTasks.length === 0) {
            return;
          }
        }

        if (!eaLogsRoots.length && !ubisoftSpoolRoots.length) {
          const gogGalaxyApplicationRoots =
            resolveGogGalaxyApplicationsRoots(scanBase);
          if (gogGalaxyApplicationRoots.length) {
            let gameplayEntries = [];
            const seenGameplayDb = new Set();
            for (const applicationsRoot of gogGalaxyApplicationRoots) {
              try {
                const entries =
                  listGogOfficialGameplayEntries(applicationsRoot);
                for (const entry of entries) {
                  const key = String(entry?.gameplayDbPath || "").toLowerCase();
                  if (!key || seenGameplayDb.has(key)) continue;
                  seenGameplayDb.add(key);
                  gameplayEntries.push(entry);
                }
              } catch (err) {
                watcherLogger.warn("gog-official:scan-failed", {
                  root: applicationsRoot,
                  error: err?.message || String(err),
                });
              }
            }

            const entriesByProduct = new Map();
            for (const entry of gameplayEntries) {
              const productId = String(entry?.productId || "").trim();
              if (
                !productId ||
                isAppIdBlacklisted(productId, "gog-official", blacklistState)
              ) {
                continue;
              }
              const existingOfficial =
                getConfigMetas(productId).find((meta) =>
                  isGogOfficialMeta(meta),
                ) || null;
              const current =
                existingOfficial &&
                existingOfficial.gog_client_id === entry.clientId &&
                existingOfficial.gog_user_id === entry.userId;
              if (!entriesByProduct.has(productId) || current) {
                entriesByProduct.set(productId, entry);
              }
            }

            for (const entry of entriesByProduct.values()) {
              const productId = String(entry.productId || "").trim();
              const normalizedPath = normalizeObservedPath(
                entry.gameplayDir,
                productId,
              );
              const pendingSet = pendingSavePathIndex.get(productId);
              const knownPaths = configSavePathIndex.get(productId);
              const alreadyTracked =
                normalizedPath &&
                ((knownPaths && knownPaths.has(normalizedPath)) ||
                  (pendingSet && pendingSet.has(normalizedPath)));
              const hasOfficialVariant = hasPlatformVariant(
                productId,
                "gog-official",
              );
              knownAppIds.add(productId);
              if (alreadyTracked && hasOfficialVariant) continue;

              generationTasks.push({
                appid: productId,
                forcePlatform: "gog-official",
                appDir: path.dirname(entry.gameplayDir),
                normalizedPath,
                allowExistingVariant: hasOfficialVariant,
                __savePathOverride: entry.gameplayDir,
                __gogName: entry.title || null,
                __gogClientId: entry.clientId || null,
                __gogUserId: entry.userId || null,
                __gogGameplayDbPath: entry.gameplayDbPath || null,
              });
              if (normalizedPath)
                markPendingSavePath(productId, normalizedPath);
            }

            if (generationTasks.length === 0) {
              return;
            }
          } else {
            // Prefer GOG .info detection: if found, ignore other numeric folders under this root
            gogInfoFound = await findGogInfoAppId(
              scanBase,
              6,
              yieldIfNeeded,
              shouldSkipPath,
            ).catch(() => null);
            if (gogInfoFound) {
              const gogId = String(gogInfoFound.appid || "").trim();
              if (gogId && !isAppIdBlacklisted(gogId, "gog", blacklistState)) {
                const shippingDir = await findShippingExeDir(
                  scanBase,
                  6,
                  shouldSkipPath,
                );
                const saveRoot =
                  shippingDir || gogInfoFound.baseDir || scanBase;
                const normalizedPath = normalizeObservedPath(saveRoot, gogId);
                generationTasks.push({
                  appid: gogId,
                  forcePlatform: "gog",
                  appDir: gogInfoFound.baseDir || scanBase,
                  normalizedPath,
                  __savePathOverride: saveRoot,
                  __gogName: gogInfoFound.name || null,
                  __gogLaunchMetadata: gogInfoFound.launchMetadata || null,
                });
                if (normalizedPath) markPendingSavePath(gogId, normalizedPath);
              }
            }

            // If no GOG .info, fall back to numeric discovery (with Epic container handling)
            const epicDiscoveredMap =
              !gogInfoFound &&
              (await discoverNemirtingasEpicAppIds(rootPath, shouldSkipPath));
            const shouldFallbackEpic =
              epicDiscoveredMap instanceof Map && epicDiscoveredMap.size === 0;
            nemirtingasEpicDiscovery =
              epicDiscoveredMap instanceof Map && epicDiscoveredMap.size > 0;
            discoveredMap =
              epicDiscoveredMap !== null && !shouldFallbackEpic
                ? epicDiscoveredMap
                : !gogInfoFound
                  ? await discoverAppIdsUnder(
                      scanBase,
                      6,
                      yieldIfNeeded,
                      shouldSkipPath,
                    )
                  : null;
            discovered = discoveredMap
              ? Array.from(discoveredMap.keys()).map((id) => String(id))
              : [];
          }
        }
      } else {
        discoveredMap = await discoverImmediateAppIdsUnder(
          scanBase,
          yieldIfNeeded,
          shouldSkipPath,
        );
        discovered = Array.from(discoveredMap.keys()).map((id) => String(id));
        watcherLogger.info("scan-root:strict-mode", {
          root: scanBase,
          profile: strictRootProfile.key,
          discovered: discovered.length,
        });
      }

      if (gogInfoFound && generationTasks.length === 0) {
        // GOG detected but blacklisted or invalid ID; skip further processing
        return;
      }

      for (const id of discovered) {
        try {
          if (shouldIgnoreDiscoveredId(id)) continue;
          const appDir = discoveredMap.get(id) || null;
          if (appDir && shouldSkipPath(appDir)) continue;
          const normalizedDir = normalizeObservedPath(appDir, id);
          const pendingSet = pendingSavePathIndex.get(id);
          const knownPaths = configSavePathIndex.get(id);
          const alreadyTracked =
            normalizedDir &&
            ((knownPaths && knownPaths.has(normalizedDir)) ||
              (pendingSet && pendingSet.has(normalizedDir)));

          if (!existingConfigIds.has(id)) {
            const discoveredPlatform = nemirtingasEpicDiscovery
              ? "epic"
              : null;
            const autoInflightKey = `${String(id)}:${discoveredPlatform || "auto"}`;
            if (
              inflightAppIds.has(autoInflightKey) ||
              wasObservedGenerationVariantRecent(id, discoveredPlatform)
            ) {
              continue;
            }
            if (
              isAppIdBlacklisted(id, discoveredPlatform, blacklistState)
            ) {
              continue;
            }
            if (alreadyTracked) continue;
            brandNewIds.push(id);
            generationTasks.push({
              appid: id,
              forcePlatform: discoveredPlatform,
              appDir,
              normalizedPath: normalizedDir,
            });
            if (normalizedDir) markPendingSavePath(id, normalizedDir);
            continue;
          }

          const targetPlatform = nemirtingasEpicDiscovery
            ? "epic"
            : determineAlternatePlatform(id);
          if (!normalizedDir || alreadyTracked || !targetPlatform) continue;
          if (isAppIdBlacklisted(id, targetPlatform, blacklistState)) continue;
          const targetInflightKey = `${String(id)}:${targetPlatform || "auto"}`;
          if (
            inflightAppIds.has(targetInflightKey) ||
            wasObservedGenerationVariantRecent(id, targetPlatform)
          ) {
            continue;
          }
          watcherLogger.info("watcher:force-platform-new-path", {
            appid: id,
            target: targetPlatform,
            path: normalizedDir,
          });
          generationTasks.push({
            appid: id,
            forcePlatform: targetPlatform,
            appDir,
            normalizedPath: normalizedDir,
          });
          markPendingSavePath(id, normalizedDir);
        } finally {
          if (yieldIfNeeded) await yieldIfNeeded();
        }
      }

      // Tenoke/GOG info/UniverseLAN fallback: if nothing to generate, try to discover deeper
      tenokeFound = null;
      if (!strictRootProfile && generationTasks.length === 0) {
        tenokeFound = await findTenokeAppId(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        ).catch(() => null);
        const gogInfoFound = await findGogInfoAppId(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        ).catch(() => null);
        const universeFound = await findUniverseLanAppId(
          scanBase,
          6,
          yieldIfNeeded,
          shouldSkipPath,
        ).catch(() => null);
        if (!tenokeFound && !gogInfoFound && !universeFound) {
          for (const id of discovered) {
            if (!isAppIdBlacklisted(id, null, blacklistState)) {
              knownAppIds.add(id);
            }
            if (yieldIfNeeded) await yieldIfNeeded();
          }
          return;
        }
        if (tenokeFound) {
          const tenokeId = String(tenokeFound.appid || "").trim();
          if (tenokeId && !isAppIdBlacklisted(tenokeId, null, blacklistState)) {
            const shippingDir = await findShippingExeDir(
              scanBase,
              6,
              shouldSkipPath,
            );
            const saveRoot = shippingDir || tenokeFound.baseDir || scanBase;
            tenokeIds.add(tenokeId);
            const normalizedRoot = normalizeObservedPath(saveRoot, tenokeId);
            generationTasks.push({
              appid: tenokeId,
              forcePlatform: null,
              appDir: tenokeFound.baseDir || scanBase,
              normalizedPath: normalizedRoot,
              __tenoke: true,
              __savePathOverride: saveRoot,
              __emu: "tenoke",
            });
            markPendingSavePath(
              tenokeId,
              normalizeObservedPath(saveRoot, tenokeId),
            );
          }
        }
        if (gogInfoFound) {
          const gogId = String(gogInfoFound.appid || "").trim();
          if (gogId && !isAppIdBlacklisted(gogId, "gog", blacklistState)) {
            const shippingDir = await findShippingExeDir(
              scanBase,
              6,
              shouldSkipPath,
            );
            const saveRoot = shippingDir || gogInfoFound.baseDir || scanBase;
            generationTasks.push({
              appid: gogId,
              forcePlatform: "gog",
              appDir: gogInfoFound.baseDir || scanBase,
              normalizedPath: normalizeObservedPath(saveRoot, gogId),
              __savePathOverride: saveRoot,
              __gogName: gogInfoFound.name || null,
              __gogLaunchMetadata: gogInfoFound.launchMetadata || null,
            });
            markPendingSavePath(gogId, normalizeObservedPath(saveRoot, gogId));
          }
        } else if (universeFound) {
          const uniId = String(universeFound.appid || "").trim();
          if (uniId && !isAppIdBlacklisted(uniId, "gog", blacklistState)) {
            const shippingDir = await findShippingExeDir(
              scanBase,
              6,
              shouldSkipPath,
            );
            const saveRoot = shippingDir || universeFound.baseDir || scanBase;
            generationTasks.push({
              appid: uniId,
              forcePlatform: "gog",
              appDir: universeFound.baseDir || scanBase,
              normalizedPath: normalizeObservedPath(saveRoot, uniId),
              __savePathOverride: saveRoot,
            });
            markPendingSavePath(uniId, normalizeObservedPath(saveRoot, uniId));
          }
        }
      }

      for (let index = generationTasks.length - 1; index >= 0; index -= 1) {
        const task = generationTasks[index];
        const taskPath =
          task?.normalizedPath ||
          task?.__savePathOverride ||
          task?.appDir ||
          null;
        if (!taskPath || !shouldSkipPath(taskPath)) continue;
        watcherLogger.info("watcher:scan-skip-blocked-path", {
          appid: String(task?.appid || ""),
          platform: task?.forcePlatform || null,
          path: taskPath,
        });
        if (task?.normalizedPath) {
          clearPendingSavePath(task.appid, task.normalizedPath);
        }
        generationTasks.splice(index, 1);
      }

      if (typeof generateConfigForAppId === "function") {
        for (let index = generationTasks.length - 1; index >= 0; index -= 1) {
          const task = generationTasks[index];
          if (!configDeletionGuard.isSuppressed(task?.appid)) continue;
          watcherLogger.info("watcher:scan-skip-config-deleting", {
            appid: String(task?.appid || ""),
            platform: task?.forcePlatform || null,
            root: rootPath,
          });
          if (task?.normalizedPath) {
            clearPendingSavePath(task.appid, task.normalizedPath);
          }
          generationTasks.splice(index, 1);
        }
        let generatedIds = new Set();
        const createdGenerationTasks = [];
        const batchProgress =
          generationTasks.length > 0
            ? createGenerationBatchReporter(generationTasks, {
                rootLabel: path.basename(rootPath || "") || "",
                fallbackItemName: path.basename(rootPath || "") || "",
                defaultDetail: "Preparing config generation",
              })
            : null;
        rootBatchProgress = batchProgress;
        pauseDashboardPoll(true);
        batchProgress?.start();

        if (bootMode) {
          generatedIds = new Set();
          const batchableTasks =
            typeof generateConfigsForAppIds === "function"
              ? generationTasks.filter(isBootBatchableGenerationTask)
              : [];
          const singleTasks =
            batchableTasks.length > 0
              ? generationTasks.filter(
                  (task) => !isBootBatchableGenerationTask(task),
                )
              : generationTasks;
          if (batchableTasks.length > 0) {
            try {
              const finishBatchGenerationActivities = batchableTasks
                .map((task) =>
                  configDeletionGuard.tryStartGeneration(task.appid),
                )
                .filter(Boolean);
              let batchResult;
              try {
                batchResult = await generateConfigsForAppIds(
                  batchableTasks,
                  configsDir,
                  {
                    onSeedCache,
                    onTaskProgress: (task, taskIndex, progress) => {
                      batchProgress?.updateTask(task, taskIndex, progress);
                    },
                    onTaskSettled: (task, taskIndex, result) => {
                      batchProgress?.settleTask(task, taskIndex, result);
                    },
                  },
                );
              } finally {
                for (const finishActivity of finishBatchGenerationActivities) {
                  finishActivity();
                }
              }
              for (const id of batchResult?.generated || []) {
                generatedIds.add(String(id));
              }
            } catch (err) {
              watcherLogger.warn("watcher:generate-batch-failed", {
                error: err?.message || String(err),
                count: batchableTasks.length,
              });
              const fallbackIds = await generateIdsThrottled(batchableTasks, {
                onTaskProgress: (task, taskIndex, progress) => {
                  batchProgress?.updateTask(task, taskIndex, progress);
                },
                onTaskSettled: (task, taskIndex, result) => {
                  batchProgress?.settleTask(task, taskIndex, result);
                },
              });
              for (const id of fallbackIds) {
                generatedIds.add(String(id));
              }
            }
          }
          const singleGeneratedIds = await generateIdsThrottled(singleTasks, {
            onTaskProgress: (task, taskIndex, progress) => {
              batchProgress?.updateTask(task, taskIndex, progress);
            },
            onTaskSettled: (task, taskIndex, result) => {
              batchProgress?.settleTask(task, taskIndex, result);
            },
          });
          for (const id of singleGeneratedIds) {
            generatedIds.add(String(id));
          }
        } else {
          generatedIds = new Set();
          for (
            let taskIndex = 0;
            taskIndex < generationTasks.length;
            taskIndex += 1
          ) {
            const task = generationTasks[taskIndex];
            const generationResult = await generateOneAppId(
              task.appid,
              task.appDir || null,
              {
                forcePlatform: task.forcePlatform,
                normalizedSavePath: task.normalizedPath || "",
                skipPostIndex: true,
                allowExistingVariant: task.allowExistingVariant === true,
                __savePathOverride: task.__savePathOverride || null,
                __gogClientId: task.__gogClientId || null,
                __gogUserId: task.__gogUserId || null,
                __gogGameplayDbPath: task.__gogGameplayDbPath || null,
                __ubisoftUserId: task.__ubisoftUserId || null,
                __ubisoftSpoolFile: task.__ubisoftSpoolFile || null,
                __eaAchievementSet: task.__eaAchievementSet || null,
                __eaLogFile: task.__eaLogFile || null,
                __eaGameName: task.__eaGameName || null,
                __emu: task.__emu || null,
                onGenerationProgress: (progress) => {
                  batchProgress?.updateTask(task, taskIndex, progress);
                },
              },
            );
            batchProgress?.settleTask(task, taskIndex, generationResult);
            if (generationResult?.created === true) {
              generatedIds.add(String(task.appid));
              createdGenerationTasks.push(task);
            }
          }
        }

        const createdAny = generatedIds.size > 0;
        if (createdAny) {
          await indexExistingConfigsSync();

          const createdTaskInfoByMetaName = new Map();
          for (const task of createdGenerationTasks) {
            const createdMeta = findConfigMetaForGeneration(
              String(task.appid || ""),
              task.forcePlatform,
              task.normalizedPath || "",
            );
            if (!createdMeta?.name) continue;
            const taskRootDir =
              task.appDir ||
              discoveredMap?.get(String(task.appid || "")) ||
              tenokeFound?.baseDir ||
              rootPath;
            createdTaskInfoByMetaName.set(createdMeta.name, {
              id: String(task.appid || ""),
              rootDir: taskRootDir,
              candidates: buildInitialSeedCandidatesForMeta(
                createdMeta,
                taskRootDir,
              ),
            });
          }
          const singleGeneratedPromotionName =
            !bootMode &&
            promoteSingleGeneratedInitialNotify &&
            createdTaskInfoByMetaName.size === 1
              ? Array.from(createdTaskInfoByMetaName.keys())[0]
              : null;

          if (bootMode) {
            await attachSaveWatchersBatched(generatedIds, {
              suppressInitialNotify,
              ...attachSeedOptions,
            });
          } else {
            await attachSaveWatchersBatched(generatedIds, {
              suppressInitialNotify,
              batchDelayMs: BOOT_ATTACH_DELAY_MS,
              ...attachSeedOptions,
            });
          }
          for (const id of generatedIds) {
            const metas = getConfigMetas(id);
            for (const m of metas) {
              const createdTaskInfo =
                createdTaskInfoByMetaName.get(m.name) || null;
              const rootDir =
                createdTaskInfo?.rootDir ||
                discoveredMap?.get(id) ||
                tenokeFound?.baseDir ||
                rootPath;
              const maybe =
                createdTaskInfo?.candidates ||
                buildInitialSeedCandidatesForMeta(m, rootDir);
              const shouldPromoteInitialNotify =
                !bootMode &&
                ((promoteInitialNotifyAppIds.has(String(id)) &&
                  createdTaskInfoByMetaName.size > 0 &&
                  !!createdTaskInfo) ||
                  singleGeneratedPromotionName === m.name);
              const canPromoteInitialNotify =
                shouldPromoteInitialNotify &&
                !initialNotifyPromotedConfigs.has(m.name) &&
                maybe.some(
                  (candidate) => candidate && fs.existsSync(candidate),
                );
              const bucket = appidSaveWatchers.get(id);
              const alreadySeeded = bucket && bucket.has(m.name);
              const seededBefore = seededInitialConfigs.has(m.name);
              if (alreadySeeded || seededBefore) {
                try {
                  broadcastAll("config:schema-ready", {
                    appid: id,
                    configName: m.name,
                    filePath: path.join(configsDir, `${m.name}.json`),
                  });
                  // auto-select will be triggered after notifications/evaluations
                } catch {}
                if (canPromoteInitialNotify) {
                  promoteInitialNotifyForMeta(id, m, maybe, {
                    reason: "scan-root-generated",
                    rootPath,
                  });
                }
                continue;
              }
              try {
                broadcastAll("config:schema-ready", {
                  appid: id,
                  configName: m.name,
                  filePath: path.join(configsDir, `${m.name}.json`),
                });
                // auto-select will be triggered after notifications/evaluations
              } catch {}
              if (canPromoteInitialNotify) {
                promoteInitialNotifyForMeta(id, m, maybe, {
                  reason: "scan-root-generated",
                  rootPath,
                });
              } else {
                seedInitialSnapshot(id, m, maybe, true, {
                  suppressInitialNotify,
                });
              }
            }
          }

          // emit UI refresh after seeding to avoid racing the notification
          broadcastAll("configs:changed");
          broadcastAll("refresh-achievements-table");
        }
        batchProgress?.finish("success", "Config generation completed");
        rootBatchProgress = null;
        clearPendingForTasks(generationTasks);
        pauseDashboardPoll(false);
      } else {
        if (bootMode) {
          notifyWarn(
            "generateConfigForAppId missing - skip heavy generateGameConfigs() at boot",
          );
        } else {
          if (brandNewIds.length === 0) {
            clearPendingForTasks(generationTasks);
            return;
          }
          pauseDashboardPoll(true);
          await generateGameConfigs(scanBase, configsDir, { onSeedCache });
          await indexExistingConfigsSync();
          await rebuildSaveWatchers();
          for (const id of discovered) knownAppIds.add(id);
          broadcastAll("refresh-achievements-table");
          clearPendingForTasks(generationTasks);
          pauseDashboardPoll(false);
        }
      }
    } catch (e) {
      rootBatchProgress?.finish(
        "failed",
        e?.message || "Config generation failed",
      );
      notifyWarn(`Scan failed for "${rootPath}": ${e.message}`);
    }
  }

  // ——— WATCHER ———
  function startFolderWatcher(inputRoot, opts = {}) {
    const { initialScan = true } = opts;
    const root = normalizeRoot(coercePath(inputRoot));
    if (folderWatchers.has(root)) {
      return folderWatchers.get(root)?.readyPromise || Promise.resolve(true);
    }
    if (!fs.existsSync(root)) {
      markMissingRoot(root);
      return Promise.resolve(false);
    }
    if (isPathBlocked(root)) {
      watcherLogger.info("watch-folder:skip-blocked", { root });
      return Promise.resolve(false);
    }
    const strictRootProfile = getStrictRootProfile(root);
    const initialLocalPatchState = detectLocalPatchRootState(root);
    const markerPatchOwnedRoot = initialLocalPatchState.type === "markerpatch";
    const madnessPatchOwnedRoot = initialLocalPatchState.type === "madnesspatch";

    const watcher = chokidar.watch(root, {
      persistent: true,
      ignoreInitial: true,
      ignored: (candidatePath) =>
        candidatePath !== root && isPathBlocked(candidatePath),
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      depth: madnessPatchOwnedRoot
        ? 7
        : markerPatchOwnedRoot
          ? 2
          : strictRootProfile
            ? STRICT_ROOT_WATCH_DEPTH
            : 6,
      ignorePermissionErrors: true,
    });
    let resolveReady = null;
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const state = {
      watcher,
      debounce: null,
      readyPromise,
      resolveReady,
      localPatchState: initialLocalPatchState,
      rescanQueued: false,
      stopped: false,
    };
    folderWatchers.set(root, state);
    watcherLogger.info("watch-folder", { root, initialScan });

    const schedule = () => {
      if (state.stopped) return;
      clearTimeout(state.debounce);
      state.debounce = setTimeout(async () => {
        if (state.stopped) return;
        if (!bootOnboardingGateOpen) {
          markBootOnboardingDirtyRoot(root, "debounced-scan");
          return;
        }
        if (activeRoots.has(root)) {
          state.rescanQueued = true;
          return;
        }
        activeRoots.add(root);
        try {
          if (!fs.existsSync(root)) {
            markMissingRoot(root);
            stopFolderWatcher(root);
            return;
          }
          await scanRootOnce(root, { localPatchState: state.localPatchState });
        } catch (e) {
          notifyWarn(`Watch rescan failed for "${root}": ${e.message}`);
        } finally {
          activeRoots.delete(root);
          if (state.rescanQueued && !state.stopped) {
            state.rescanQueued = false;
            schedule();
          }
        }
      }, 300);
    };

    const routeLocalPatchEvent = (eventPath) => {
      const signatureEvent = isLocalPatchSignatureEvent(root, eventPath);
      const previous = state.localPatchState;
      if (signatureEvent) {
        state.localPatchState = detectLocalPatchRootState(root);
        if (
          previous?.type !== state.localPatchState.type ||
          previous?.active !== state.localPatchState.active
        ) {
          watcherLogger.info("local-patch:root-state-changed", {
            root,
            previousType: previous?.type || null,
            currentType: state.localPatchState.type || null,
            active: state.localPatchState.active,
          });
        }
      }
      if (signatureEvent || state.localPatchState.active) schedule();
      return state.localPatchState.active;
    };

    const getPendingAlternatePlatformForEvent = (appid, eventPath, meta) => {
      if (!appid || !eventPath || !meta) return null;
      const alternatePlatform = determineAlternatePlatform(appid);
      if (!alternatePlatform) return null;
      const currentPlatform = normalizePlatform(meta?.platform) || null;
      if (currentPlatform && currentPlatform === alternatePlatform) {
        return null;
      }
      const currentPathScore = scoreMetaForPath(meta, eventPath);
      if (currentPathScore > 0) {
        return null;
      }
      return alternatePlatform;
    };

    const handleModernPs4FileEvent = async (filePath) => {
      const base = path.basename(filePath || "").toLowerCase();
      const parts = String(filePath || "").split(/[\\/]+/);
      let npcommid = "";
      let schemaDir = "";
      let progressPath = "";
      let userId = "";

      if (isPs4ProgressXmlPath(filePath)) {
        npcommid = getPs4NpCommIdFromProgressPath(filePath);
        progressPath = filePath;
        userId = getPs4UserIdFromProgressPath(filePath) || "";
        schemaDir = path.join(root, "trophy", npcommid);
      } else if (base === "trop.xml") {
        const xmlDir = path
          .basename(path.dirname(filePath) || "")
          .toLowerCase();
        const candidateSchemaDir = path.dirname(path.dirname(filePath));
        const candidateNpCommId = path.basename(candidateSchemaDir || "");
        const candidateRoot = path.dirname(path.dirname(candidateSchemaDir));
        if (
          xmlDir === "xml" &&
          /^NP[A-Z0-9_]+$/i.test(candidateNpCommId) &&
          path.basename(candidateRoot || "").toLowerCase() === "shadps4"
        ) {
          npcommid = candidateNpCommId;
          schemaDir = candidateSchemaDir;
        } else if (
          xmlDir === "xml" &&
          /^NP[A-Z0-9_]+$/i.test(candidateNpCommId) &&
          path
            .basename(path.dirname(candidateSchemaDir) || "")
            .toLowerCase() === "trophy"
        ) {
          npcommid = candidateNpCommId;
          schemaDir = candidateSchemaDir;
        }
      }

      if (!npcommid || !schemaDir || !fs.existsSync(schemaDir)) return false;
      const blacklistState = getBlacklistState();
      const mapped =
        buildShadPs4LogNpCommMap(root).get(npcommid.toLowerCase()) ||
        buildShadPs4LegacyNpCommMap(root).get(npcommid.toLowerCase()) ||
        buildShadPs4LogTitleMap(root).get(
          normalizeShadPs4TitleKey(readPs4TitleFromSchemaDir(schemaDir).title),
        );
      const appid = String(mapped?.appid || npcommid).trim();
      if (!appid || isAppIdBlacklisted(appid, "shadps4", blacklistState)) {
        return true;
      }
      if (!progressPath) {
        const discovered = await discoverModernPs4TrophySetsUnder(root);
        const match = discovered.find(
          (entry) =>
            String(entry?.npcommid || "").toLowerCase() ===
            npcommid.toLowerCase(),
        );
        const progress =
          Array.isArray(match?.progressFiles) && match.progressFiles.length
            ? match.progressFiles[0]
            : null;
        progressPath = progress?.progressPath || "";
        userId = progress?.userId || "";
      }

      try {
        const result = await generateConfigFromPs4Dir(schemaDir, configsDir, {
          schemaRoot: path.join(configsDir, "schema"),
          appid,
          npcommid,
          progressPath,
          userId,
        });
        if (!result || result.skipped) return true;
        await indexExistingConfigsSync();
        let meta = pickMetaForPath(result.appid, progressPath || filePath);
        if (!meta) {
          const metas = getPs4ConfigMetasByNpCommId(npcommid);
          meta = metas.length ? metas[0] : null;
        }
        if (meta) {
          attachSaveWatcherForAppId(String(meta.appid), {
            suppressInitialNotify: false,
          });
          if (result.created || result.schemaUpdated || result.configUpdated) {
            broadcastAll("configs:changed");
            broadcastAll("refresh-achievements-table");
          }
          if (
            progressPath &&
            path.normalize(progressPath) === path.normalize(filePath)
          ) {
            const progressSnapKey = makeSnapshotKey(meta, String(meta.appid), {
              filePath: progressPath,
              savePath: progressPath,
            });
            const cachedForUser =
              typeof getCachedSnapshot === "function"
                ? getCachedSnapshot(
                    meta?.name || result.appid,
                    meta?.platform || null,
                    {
                      appid: String(result.appid || meta.appid || ""),
                      savePath: progressPath,
                      filePath: progressPath,
                      shadps4UserId: userId,
                    },
                  )
                : null;
            if (
              !lastSnapshot.has(progressSnapKey) &&
              (!cachedForUser ||
                typeof cachedForUser !== "object" ||
                Array.isArray(cachedForUser))
            ) {
              try {
                const snapshot = buildSnapshotFromPs4ProgressFile(
                  progressPath,
                  {},
                );
                lastSnapshot.set(progressSnapKey, snapshot);
                if (typeof onSeedCache === "function") {
                  onSeedCache({
                    appid: String(result.appid || meta.appid || ""),
                    configName:
                      meta.name || result.name || String(result.appid),
                    platform: meta?.platform || "shadps4",
                    savePath: progressPath,
                    snapshot,
                  });
                }
                broadcastAll("achievements:file-updated", {
                  appid: String(meta.appid),
                  configName: meta?.name || null,
                });
                return true;
              } catch {}
            } else if (
              !lastSnapshot.has(progressSnapKey) &&
              cachedForUser &&
              typeof cachedForUser === "object" &&
              !Array.isArray(cachedForUser)
            ) {
              lastSnapshot.set(progressSnapKey, cachedForUser);
            }
            const evalResult = await evaluateFile(
              String(meta.appid),
              meta,
              filePath,
              {
                initial: false,
              },
            );
            if (evalResult) {
              broadcastAll("achievements:file-updated", {
                appid: String(meta.appid),
                configName: meta?.name || null,
              });
              if (
                !bootMode &&
                !isRecentlyUnblocked(meta.appid, meta) &&
                !isAutoSelectSuppressedForMeta(meta.appid, meta)
              ) {
                setTimeout(() => enqueueAutoSelect(meta), 0);
              }
            }
          }
        }
      } catch (err) {
        notifyWarn(`PS4 trophy parse failed "${schemaDir}": ${err.message}`);
      }
      return true;
    };

    if (initialScan && !rescanInProgress.value) {
      // optional: schedule();
    }

    watcher
      .on("ready", () => {
        try {
          state.resolveReady?.(true);
        } catch {}
        state.resolveReady = null;
        if (
          !rescanInProgress.value &&
          initialScan &&
          typeof generateConfigForAppId !== "function"
        ) {
          schedule();
        }
      })

      .on("add", async (filePath) => {
        if (rescanInProgress.value) return;
        if (isPathBlocked(filePath)) return;
        if (!bootOnboardingGateOpen) {
          markBootOnboardingDirtyRoot(root, "watch:add");
          return;
        }
        if (routeLocalPatchEvent(filePath)) return;
        if (await handleUbisoftOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleEaOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleGogOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleModernPs4FileEvent(filePath)) {
          return;
        }
        if (isShadPs4RuntimePath(root) || isShadPs4RuntimePath(filePath)) {
          return;
        }
        const steamInfo = parseSteamOfficialBinInfo(filePath);
        const preferredSteamOfficialAccountId =
          getPreferredSteamOfficialAccountId();
        if (
          steamInfo?.kind === "user" &&
          preferredSteamOfficialAccountId &&
          String(steamInfo.accountId || "") !== preferredSteamOfficialAccountId
        ) {
          return;
        }
        const isSteamSchemaBin = !!steamInfo && steamInfo.kind === "schema";
        const isSteamUserBin = !!steamInfo && steamInfo.kind === "user";
        const base = path.basename(filePath).toLowerCase();
        const isGpd = base.endsWith(".gpd");
        const isTropusr = base === "tropusr.dat";
        const isTropconf = base === "tropconf.sfm";
        const isRpcs3File = isTropusr || isTropconf;
        const isPs4Xml = base === "trop.xml";
        if (
          !isGpd &&
          !isRpcs3File &&
          !isPs4Xml &&
          !isSteamSchemaBin &&
          !isSteamUserBin &&
          !(
            base === "stats.ini" &&
            path.basename(path.dirname(filePath)).toLowerCase() === "stats"
          ) &&
          ![
            "achievements.json",
            "achievements.ini",
            "stats.bin",
            "user_stats.ini",
          ].includes(base)
        )
          return;

        const parts = filePath.split(path.sep);
        const strictAppId = strictRootProfile
          ? parseStrictRootAppId(root, filePath)
          : null;
        let appid = null;
        if (isSteamSchemaBin || isSteamUserBin) {
          appid = steamInfo?.appid || null;
        } else if (isGpd) {
          appid = path.basename(filePath, path.extname(filePath));
        } else if (isRpcs3File) {
          appid = path.basename(path.dirname(filePath));
        } else if (isPs4Xml) {
          // PS4: appid is CUSA folder name, parent of TrophyFiles/trophy00
          for (let i = parts.length - 1; i >= 1; i--) {
            if (/^cusa[0-9]+$/i.test(parts[i])) {
              appid = parts[i];
              break;
            }
          }
        } else if (strictRootProfile) {
          appid = strictAppId;
        } else {
          for (let i = parts.length - 1; i >= 0; i--) {
            if (/^[0-9a-fA-F]+$/.test(parts[i])) {
              appid = parts[i];
              break;
            }
          }
        }
        if (!appid) return;

        if (isSteamSchemaBin || isSteamUserBin) {
          try {
            await handleSteamOfficialBinEvent(steamInfo);
          } catch (err) {
            notifyWarn(
              `Steam official parse failed "${filePath}": ${err.message}`,
            );
          }
        }

        let meta = pickMetaForPath(appid, filePath);
        if (!meta && isGpd) {
          try {
            const result = generateConfigFromGpd(filePath, configsDir, {
              schemaRoot: path.join(configsDir, "schema"),
              bootMode,
            });
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(`Xenia GPD parse failed "${filePath}": ${err.message}`);
          }
        }
        if (!meta && isPs4Xml) {
          const trophyDir = path.dirname(path.dirname(path.dirname(filePath))); // .../TrophyFiles/trophy00/Xml/file
          try {
            const result = await generateConfigFromPs4Dir(
              trophyDir,
              configsDir,
              {
                schemaRoot: path.join(configsDir, "schema"),
                bootMode,
              },
            );
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(
              `PS4 trophy parse failed "${trophyDir}": ${err.message}`,
            );
          }
        }
        if (!meta && isRpcs3File) {
          const trophyDir = path.dirname(filePath);
          const baseName = path.basename(trophyDir || "").toLowerCase();
          if (isRpcs3TempFolderName(baseName)) return;
          const confPath = path.join(trophyDir, "TROPCONF.SFM");
          const usrPath = path.join(trophyDir, "TROPUSR.DAT");
          if (!fs.existsSync(confPath) || !fs.existsSync(usrPath)) {
            return;
          }
          try {
            const result = await generateConfigFromTrophyDir(
              trophyDir,
              configsDir,
              {
                schemaRoot: path.join(configsDir, "schema"),
                bootMode,
              },
            );
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(
              `RPCS3 trophy parse failed "${trophyDir}": ${err.message}`,
            );
          }
        }
        if (!meta) {
          await indexExistingConfigsSync();
          meta = pickMetaForPath(appid, filePath);
        }
        if (!meta) return;

        const pendingAlternatePlatform = getPendingAlternatePlatformForEvent(
          appid,
          filePath,
          meta,
        );
        if (pendingAlternatePlatform) {
          watcherLogger.info("strict-root:defer-existing-meta", {
            appid: String(appid),
            config: meta?.name || null,
            platform: normalizePlatform(meta?.platform) || null,
            pendingPlatform: pendingAlternatePlatform,
            filePath,
          });
          return;
        }

        const tenokeReady =
          meta.__tenoke !== true || tenokeRelinkedConfigs.has(meta.name);
        // Auto-select only after notifications are processed
        if (
          !bootMode &&
          tenokeReady &&
          !isRecentlyUnblocked(appid, meta) &&
          !isAutoSelectSuppressedForMeta(appid, meta)
        ) {
          setTimeout(() => enqueueAutoSelect(meta), 0);
        }

        const appKey = String(appid);
        const runEval = async (retryFlag = false) => {
          let result = false;
          try {
            result = await evaluateFile(appKey, meta, filePath, {
              initial: false,
              retry: retryFlag,
            });
          } catch {}
          if (result === "__retry__") {
            setTimeout(() => runEval(true), 500);
            return;
          }
          if (result) {
            try {
              broadcastAll("achievements:file-updated", {
                appid: appKey,
                configName: meta?.name || null,
              });
            } catch {}
          }
        };
        try {
          await runEval();
        } finally {
          try {
            debounceRefreshAchievementsTable();
            emitDashboardRefresh();
          } catch {}
        }
      })

      .on("change", async (filePath) => {
        if (rescanInProgress.value) return;
        if (isPathBlocked(filePath)) return;
        if (!bootOnboardingGateOpen) {
          markBootOnboardingDirtyRoot(root, "watch:change");
          return;
        }
        if (routeLocalPatchEvent(filePath)) return;
        if (await handleUbisoftOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleEaOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleGogOfficialRootFileEvent(root, filePath)) {
          return;
        }
        if (await handleModernPs4FileEvent(filePath)) {
          return;
        }
        if (isShadPs4RuntimePath(root) || isShadPs4RuntimePath(filePath)) {
          return;
        }
        const steamInfo = parseSteamOfficialBinInfo(filePath);
        const preferredSteamOfficialAccountId =
          getPreferredSteamOfficialAccountId();
        if (
          steamInfo?.kind === "user" &&
          preferredSteamOfficialAccountId &&
          String(steamInfo.accountId || "") !== preferredSteamOfficialAccountId
        ) {
          return;
        }
        const isSteamSchemaBin = !!steamInfo && steamInfo.kind === "schema";
        const isSteamUserBin = !!steamInfo && steamInfo.kind === "user";
        const base = path.basename(filePath).toLowerCase();
        const isGpd = base.endsWith(".gpd");
        const isTropusr = base === "tropusr.dat";
        const isTropconf = base === "tropconf.sfm";
        const isRpcs3File = isTropusr || isTropconf;
        const isPs4Xml = base === "trop.xml";
        if (
          !isGpd &&
          !isRpcs3File &&
          !isPs4Xml &&
          !isSteamSchemaBin &&
          !isSteamUserBin &&
          !(
            base === "stats.ini" &&
            path.basename(path.dirname(filePath)).toLowerCase() === "stats"
          ) &&
          ![
            "achievements.json",
            "achievements.ini",
            "stats.bin",
            "user_stats.ini",
          ].includes(base)
        )
          return;

        const parts = filePath.split(path.sep);
        const strictAppId = strictRootProfile
          ? parseStrictRootAppId(root, filePath)
          : null;
        let appid = null;
        if (isSteamSchemaBin || isSteamUserBin) {
          appid = steamInfo?.appid || null;
        } else if (isGpd) {
          appid = path.basename(filePath, path.extname(filePath));
        } else if (isRpcs3File) {
          appid = path.basename(path.dirname(filePath));
        } else if (isPs4Xml) {
          for (let i = parts.length - 1; i >= 1; i--) {
            if (/^cusa[0-9]+$/i.test(parts[i])) {
              appid = parts[i];
              break;
            }
          }
        } else if (strictRootProfile) {
          appid = strictAppId;
        } else {
          for (let i = parts.length - 1; i >= 0; i--) {
            if (/^[0-9a-fA-F]+$/.test(parts[i])) {
              appid = parts[i];
              break;
            }
          }
        }
        if (!appid) return;

        if (isSteamSchemaBin || isSteamUserBin) {
          try {
            await handleSteamOfficialBinEvent(steamInfo);
          } catch (err) {
            notifyWarn(
              `Steam official parse failed "${filePath}": ${err.message}`,
            );
          }
        }

        let meta = pickMetaForPath(appid, filePath);
        if (!meta && isGpd) {
          try {
            const result = generateConfigFromGpd(filePath, configsDir, {
              schemaRoot: path.join(configsDir, "schema"),
              bootMode,
            });
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(`Xenia GPD parse failed "${filePath}": ${err.message}`);
          }
        }
        if (!meta && isPs4Xml) {
          const trophyDir = path.dirname(path.dirname(path.dirname(filePath))); // .../TrophyFiles/trophy00/Xml/file
          try {
            const result = await generateConfigFromPs4Dir(
              trophyDir,
              configsDir,
              {
                schemaRoot: path.join(configsDir, "schema"),
                bootMode,
              },
            );
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(
              `PS4 trophy parse failed "${trophyDir}": ${err.message}`,
            );
          }
        }
        if (!meta && isRpcs3File) {
          const trophyDir = path.dirname(filePath);
          const baseName = path.basename(trophyDir || "").toLowerCase();
          if (isRpcs3TempFolderName(baseName)) return;
          const confPath = path.join(trophyDir, "TROPCONF.SFM");
          const usrPath = path.join(trophyDir, "TROPUSR.DAT");
          if (!fs.existsSync(confPath) || !fs.existsSync(usrPath)) {
            return;
          }
          try {
            const result = await generateConfigFromTrophyDir(
              trophyDir,
              configsDir,
              {
                schemaRoot: path.join(configsDir, "schema"),
                bootMode,
              },
            );
            if (!result || result.skipped) {
              return;
            }
            await indexExistingConfigsSync();
            meta = pickMetaForPath(result.appid, filePath);
            if (meta) {
              attachSaveWatcherForAppId(String(meta.appid), {
                suppressInitialNotify: false,
              });
              broadcastAll("configs:changed");
              broadcastAll("refresh-achievements-table");
            }
          } catch (err) {
            notifyWarn(
              `RPCS3 trophy parse failed "${trophyDir}": ${err.message}`,
            );
          }
        }
        if (!meta) {
          await indexExistingConfigsSync();
          meta = pickMetaForPath(appid, filePath);
        }
        if (!meta) return;

        const pendingAlternatePlatform = getPendingAlternatePlatformForEvent(
          appid,
          filePath,
          meta,
        );
        if (pendingAlternatePlatform) {
          watcherLogger.info("strict-root:defer-existing-meta", {
            appid: String(appid),
            config: meta?.name || null,
            platform: normalizePlatform(meta?.platform) || null,
            pendingPlatform: pendingAlternatePlatform,
            filePath,
          });
          return;
        }

        const appKey = String(appid);
        const runEval = async (retryFlag = false) => {
          let result = false;
          try {
            result = await evaluateFile(appKey, meta, filePath, {
              initial: false,
              retry: retryFlag,
            });
          } catch {}
          if (result === "__retry__") {
            setTimeout(() => runEval(true), 500);
            return;
          }
          if (result) {
            try {
              broadcastAll("achievements:file-updated", {
                appid: appKey,
                configName: meta?.name || null,
              });
            } catch {}
            const tenokeReady =
              meta.__tenoke !== true || tenokeRelinkedConfigs.has(meta.name);
            if (
              !bootMode &&
              tenokeReady &&
              !isRecentlyUnblocked(appid, meta) &&
              !isAutoSelectSuppressedForMeta(appid, meta)
            ) {
              setTimeout(() => enqueueAutoSelect(meta), 0);
            } else {
              watcherLogger.info("auto-select:skip-conditions", {
                config: meta?.name || null,
                appid: String(appid),
                bootMode,
                tenokeReady,
                justUnblocked: isRecentlyUnblocked(appid, meta),
                suppressAutoSelect: isAutoSelectSuppressedForMeta(appid, meta),
              });
            }
          }
        };
        await runEval();

        try {
          debounceRefreshAchievementsTable();
          emitDashboardRefresh();
        } catch {}
      })

      .on("addDir", async (dir) => {
        if (rescanInProgress.value) return;
        if (isPathBlocked(dir)) return;
        if (!bootOnboardingGateOpen) {
          markBootOnboardingDirtyRoot(root, "watch:addDir");
          return;
        }
        if (routeLocalPatchEvent(dir)) return;
        if (handleUbisoftOfficialRootDirEvent(root, dir, schedule)) {
          return;
        }
        if (handleGogOfficialRootDirEvent(root, dir, schedule)) {
          return;
        }
        if (isShadPs4RuntimePath(root) || isShadPs4RuntimePath(dir)) {
          schedule();
          return;
        }

        const base = path.basename(dir);
        if (strictRootProfile) {
          const relSegments = getRelativeSegmentsFromRoot(root, dir);
          const strictDirAppId = parseStrictRootAppId(root, dir);
          if (!strictDirAppId || relSegments.length !== 1) return;
        }
        const looksPs4 =
          /^cusa\d+/i.test(base) || base.toLowerCase() === "trophy00";
        const looksRpcs3 = /^npwr\d+/i.test(base);
        const invalidAutoAppIdReason = getInvalidAutoAppIdReason(base);
        if (invalidAutoAppIdReason && !looksPs4 && !looksRpcs3) {
          watcherLogger.info("watcher:addDir-skip-invalid-appid", {
            appid: String(base),
            path: dir,
            reason: invalidAutoAppIdReason,
          });
          return;
        }
        if (!isAppIdName(base) && !looksPs4 && !looksRpcs3) return;

        // PS4/RPCS3: let the dedicated scan handle it (avoid generateConfigForAppId, which expects a numeric appid)
        if (looksPs4 || looksRpcs3) {
          schedule();
          return;
        }

        if (typeof generateConfigForAppId === "function") {
          const gpdCandidate = path.join(dir, `${base}.gpd`);
          const gpdPath = fs.existsSync(gpdCandidate)
            ? gpdCandidate
            : (await discoverGpdFilesUnder(dir, 2)).find(Boolean);
          if (gpdPath) {
            try {
              const result = generateConfigFromGpd(gpdPath, configsDir, {
                schemaRoot: path.join(configsDir, "schema"),
                bootMode,
              });
              if (!result || result.skipped) {
                return;
              }
              await indexExistingConfigsSync();
              broadcastAll("refresh-achievements-table");
              const metas = getConfigMetas(String(result.appid));
              if (metas.length) {
                attachSaveWatcherForAppId(String(result.appid));
              }
              broadcastAll("configs:changed");
              return;
            } catch (e) {
              notifyWarn(`Xenia GPD parse failed "${gpdPath}": ${e.message}`);
            }
          }
          try {
            const alternatePlatform = determineAlternatePlatform(base);
            const normalizedDir = normalizeObservedPath(dir, base);
            const existingSchemaMeta = findExistingSchemaMetaForGeneration(
              String(base),
              alternatePlatform,
              normalizedDir || "",
            );
            if (existingSchemaMeta) {
              watcherLogger.info("watcher:addDir-skip-existing-schema", {
                appid: String(base),
                path: dir,
                platform: alternatePlatform || null,
                configName: existingSchemaMeta.name || null,
                normalizedPath: normalizedDir || null,
              });
              if (normalizedDir) recordExistingSavePath(base, normalizedDir);
              const existingBucket = ensureWatcherBucket(String(base));
              if (existingBucket.has(existingSchemaMeta.name)) {
                const maybe = buildInitialSeedCandidatesForMeta(
                  existingSchemaMeta,
                  dir,
                );
                runInitialSeedForMeta(String(base), existingSchemaMeta, maybe, {
                  suppressInitialNotify: false,
                });
              } else {
                attachWatcherForMeta(existingSchemaMeta, {
                  suppressInitialNotify: false,
                });
              }
              return;
            }
            if (normalizedDir) markPendingSavePath(base, normalizedDir);
            let generationResult = {
              created: false,
              reason: "not-started",
            };
            try {
              generationResult = await generateOneAppId(base, dir, {
                forcePlatform: alternatePlatform,
                normalizedSavePath: normalizedDir || "",
              });
            } finally {
              if (normalizedDir && generationResult?.reason !== "inflight") {
                clearPendingSavePath(base, normalizedDir);
              }
            }
            if (generationResult?.created === true) {
              try {
                await indexExistingConfigsSync();
              } catch (indexErr) {
                watcherLogger.warn("watcher:addDir-post-create-index-failed", {
                  appid: String(base),
                  path: dir,
                  error: indexErr?.message || String(indexErr),
                });
              }

              const createdMeta =
                findConfigMetaForGeneration(
                  String(base),
                  alternatePlatform,
                  normalizedDir || "",
                ) || pickMetaForPath(String(base), dir);

              if (createdMeta) {
                const createdBucket = ensureWatcherBucket(String(base));
                if (createdBucket.has(createdMeta.name)) {
                  const maybe = buildInitialSeedCandidatesForMeta(
                    createdMeta,
                    dir,
                  );
                  runInitialSeedForMeta(String(base), createdMeta, maybe, {
                    suppressInitialNotify: false,
                  });
                } else {
                  attachWatcherForMeta(createdMeta, {
                    suppressInitialNotify: false,
                  });
                }
              } else {
                const metas = getConfigMetas(String(base));
                if (metas.length) {
                  attachSaveWatcherForAppId(String(base), {
                    suppressInitialNotify: false,
                  });
                } else {
                  watcherLogger.warn("watcher:addDir-created-meta-missing", {
                    appid: String(base),
                    path: dir,
                    platform: alternatePlatform || null,
                    normalizedPath: normalizedDir || null,
                  });
                }
              }

              try {
                broadcastAll("refresh-achievements-table");
              } catch {}
              try {
                emitDashboardRefresh();
              } catch {}
              try {
                broadcastAll("configs:changed");
              } catch {}
              return;
            }
            if (
              [
                "inflight",
                "existing-auto",
                "existing-variant",
                "blacklisted",
                "pending-save-path",
                "recent-save-path",
                "recent-app-platform",
                "config-deleting",
              ].includes(generationResult?.reason || "")
            ) {
              watcherLogger.info("watcher:addDir-skip-fallback", {
                appid: String(base),
                path: dir,
                reason: generationResult.reason,
              });
              return;
            }
          } catch (e) {
            notifyWarn(`Generate failed for "${base}": ${e.message}`);
          }
        }
        schedule(); // fallback
      })
      .on("unlink", (filePath) => {
        routeLocalPatchEvent(filePath);
      })
      .on("unlinkDir", (dirPath) => {
        if (!bootOnboardingGateOpen) {
          markBootOnboardingDirtyRoot(root, "watch:unlinkDir");
          return;
        }
        routeLocalPatchEvent(dirPath);
        if (!rescanInProgress.value) schedule();
      })
      .on("error", (err) => {
        try {
          state.resolveReady?.(false);
        } catch {}
        state.resolveReady = null;
        watcherLogger.error("watch-folder-error", {
          root,
          error: err?.message || String(err),
        });
        notifyWarn(`Watcher error "${root}": ${err.message}`);
      });
    return readyPromise;
  }

  function stopFolderWatcher(inputRoot) {
    const root = normalizeRoot(inputRoot);
    const entry = folderWatchers.get(root) || folderWatchers.get(inputRoot);
    if (!entry) return;
    entry.stopped = true;
    entry.rescanQueued = false;
    clearTimeout(entry.debounce);
    try {
      entry.resolveReady?.(false);
    } catch {}
    entry.resolveReady = null;
    entry.watcher.close().catch(() => {});
    watcherLogger.info("unwatch-folder", { root });
    folderWatchers.delete(root);
  }

  async function syncFolderWatchersWithCurrentPrefs() {
    const allowedRoots = new Set(getWatchedFolders().map(normalizeRoot));
    const toStop = [];
    for (const watchedRoot of folderWatchers.keys()) {
      const normalized = normalizeRoot(watchedRoot);
      if (!allowedRoots.has(normalized)) {
        toStop.push(watchedRoot);
      }
    }
    for (const root of toStop) {
      stopFolderWatcher(root);
    }
    await startFolderWatchersBatched(Array.from(allowedRoots), {
      initialScan: false,
      batchDelayMs: 0,
    });
    return {
      running: folderWatchers.size,
      allowed: allowedRoots.size,
      stopped: toStop.length,
    };
  }

  // ——— IPC ———
  ipcMain.handle("folders:list", async () => {
    return {
      ok: true,
      folders: getWatchedFolders({ includeMeta: true }),
    };
  });

  ipcMain.handle("boot:onboarding:get-state", async () => {
    const state = readAutoConfigOnboardingState();
    return {
      required: state.required,
      completed: state.completed,
      version: state.version,
      targetVersion: state.targetVersion,
      gateOpen: bootOnboardingGateOpen,
      startedAt: bootOnboardingStartedAt || 0,
      decisionAt: bootOnboardingDecisionAt || 0,
      completedAt: state.completedAt || 0,
    };
  });

  ipcMain.handle("boot:onboarding:discover-folders", async () => {
    const started = Date.now();
    try {
      const candidates = await discoverOnboardingFolders({ force: true });
      return {
        ok: true,
        candidates,
        scanMs: Date.now() - started,
      };
    } catch (err) {
      emitBootOnboardingError("discover", err, { recoverable: true });
      return {
        ok: false,
        candidates: [],
        scanMs: Date.now() - started,
        error: err?.message || String(err),
      };
    }
  });

  ipcMain.handle(
    "boot:onboarding:apply-selection",
    async (_e, payload = {}) => {
      try {
        const discovered = await discoverOnboardingFolders({ force: true });
        const selectedRaw = Array.isArray(payload?.selectedPaths)
          ? payload.selectedPaths
          : [];
        return await applyBootOnboardingDecision({
          discovered,
          selectedPaths: selectedRaw,
          reason: "apply-selection",
        });
      } catch (err) {
        emitBootOnboardingError("apply-selection", err, { recoverable: true });
        return {
          ok: false,
          selectedCount: 0,
          mutedCount: 0,
          restartedWatchers: folderWatchers.size,
          error: err?.message || String(err),
        };
      }
    },
  );

  ipcMain.handle("boot:onboarding:skip-all", async () => {
    try {
      const discovered = await discoverOnboardingFolders({ force: true });
      return await applyBootOnboardingDecision({
        discovered,
        selectedPaths: [],
        reason: "skip-all",
        muteAllDefaultRoots: true,
      });
    } catch (err) {
      emitBootOnboardingError("skip-all", err, { recoverable: true });
      return {
        ok: false,
        mutedCount: 0,
        restartedWatchers: folderWatchers.size,
        error: err?.message || String(err),
      };
    }
  });

  async function restartWatchersAndRescan(selectedPaths = null) {
    rescanInProgress.value = true;
    try {
      activeRoots.clear();

      const entries = Array.from(folderWatchers.values());
      folderWatchers.clear();
      await Promise.allSettled(
        entries.map((e) => {
          try {
            clearTimeout(e.debounce);
          } catch {}
          try {
            return e.watcher.close();
          } catch {
            return Promise.resolve();
          }
        }),
      );

      await rebuildKnownAppIds({
        forceAsyncIndex: true,
        forceAsyncRootScan: true,
      });

      const folders = getWatchedFolders();
      const availableByPath = new Map(
        folders.map((folder) => [normalizePrefPath(folder), folder]),
      );
      const scanFolders = Array.isArray(selectedPaths)
        ? Array.from(
            new Set(
              selectedPaths
                .map((folder) => normalizePrefPath(folder))
                .filter((folder) => availableByPath.has(folder)),
            ),
          ).map((folder) => availableByPath.get(folder))
        : folders;
      const selectedScanSet = new Set(
        scanFolders.map((folder) => normalizePrefPath(folder)).filter(Boolean),
      );
      const excludedScanRoots = Array.isArray(selectedPaths)
        ? folders.filter(
            (folder) => !selectedScanSet.has(normalizePrefPath(folder)),
          )
        : [];

      await startFolderWatchersBatched(folders, {
        initialScan: false,
        batchDelayMs: BOOT_ATTACH_DELAY_MS,
        onError: (err, dir) => {
          notifyWarn(`Failed to start watcher for "${dir}": ${err.message}`);
        },
      });
      if (ROOT_WATCH_SETTLE_DELAY_MS > 0 && folders.length > 0) {
        await sleep(ROOT_WATCH_SETTLE_DELAY_MS);
      }

      const before = existingConfigIds.size;
      for (const f of scanFolders) {
        try {
          await scanRootOnce(f, {
            suppressInitialNotify: true,
            scanScopeRoot: Array.isArray(selectedPaths) ? f : null,
            excludedScanRoots,
          });
        } catch (e) {
          notifyWarn(`Rescan failed for "${f}": ${e.message}`);
        }
      }
      if (RESCAN_PHASE_SETTLE_DELAY_MS > 0) {
        await sleep(RESCAN_PHASE_SETTLE_DELAY_MS);
      }
      try {
        await scanLumaPlayRegistryOnce({
          suppressInitialNotify: true,
          autoRebuild: false,
        });
      } catch (e) {
        watcherLogger.warn("lumaplay:rescan-failed", {
          error: e?.message || String(e),
        });
      }
      if (RESCAN_PHASE_SETTLE_DELAY_MS > 0) {
        await sleep(RESCAN_PHASE_SETTLE_DELAY_MS);
      }
      const generatedSomething = existingConfigIds.size > before;

      await rebuildSaveWatchers({
        suppressInitialNotify: true,
        deferInitialSeed: true,
        deferLumaPlayPolling: true,
      });
      if (RESCAN_PHASE_SETTLE_DELAY_MS > 0) {
        await sleep(RESCAN_PHASE_SETTLE_DELAY_MS);
      }
      broadcastAll("refresh-achievements-table");

      if (getActiveLumaPlayWatcherEntries().length > 0) {
        startLumaPlayDiscoveryPolling();
      }
      if (lumaPlayDiscoveryPending) {
        if (RESCAN_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(RESCAN_PHASE_SETTLE_DELAY_MS);
        }
        try {
          await runLumaPlayDiscoveryTick({ autoRebuild: true });
        } catch {}
      }
      return {
        ok: true,
        restarted: folders.length,
        scanned: scanFolders.length,
        available: folders.length,
        generated: generatedSomething,
      };
    } finally {
      rescanInProgress.value = false;
    }
  }

  // add
  ipcMain.handle("folders:add", async (_e, dirPath) => {
    try {
      let p = coercePath(dirPath);
      try {
        p = fs.realpathSync(p);
      } catch {}
      if (!p || !fs.existsSync(p)) {
        return { ok: false, errorCode: "folderNotFound" };
      }
      const blocked = getBlockedFoldersSet();
      if (isPathBlocked(p, blocked)) {
        return {
          ok: false,
          errorCode: "folderBlocked",
          folders: getWatchedFolders({ includeMeta: true }),
        };
      }
      const cur = getUserWatchedFoldersRaw()
        .map(normalizePrefPath)
        .filter(Boolean);
      if (!cur.includes(p)) saveWatchedFolders([...cur, p]);
      startFolderWatcher(p);
      await scanRootOnce(p, {
        suppressInitialNotify: true,
        promoteSingleGeneratedInitialNotify: true,
      });
      watcherLogger.info("folders:add", { folder: p });
      return {
        ok: true,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    } catch (e) {
      watcherLogger.error("folders:add-failed", {
        error: e.message,
        input: dirPath,
      });
      return {
        ok: false,
        error: e.message,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    }
  });

  // remove
  ipcMain.handle("folders:remove", async (_e, dirPath) => {
    try {
      const target = normalizePrefPath(coercePath(dirPath));
      if (!target) {
        return { ok: false, errorCode: "folderPathInvalid" };
      }

      stopFolderWatcher(target);
      const markerPatchMeta = findMarkerPatchMetaForRoot(target);
      if (markerPatchMeta) {
        stopMarkerPatchSaveWatcher(markerPatchMeta, "folder-removed");
      }
      const madnessPatchMeta = findMadnessPatchMetaForRoot(target);
      if (madnessPatchMeta) {
        stopMadnessPatchSaveWatcher(madnessPatchMeta, "folder-removed");
      }

      // Remove the target completely, including any hidden ignored state.
      const currentRaw = getUserWatchedFoldersRaw();
      const next = currentRaw.filter(
        (entry) => normalizePrefPath(entry) !== target,
      );
      saveWatchedFolders(next);
      const blocked = getBlockedFoldersSet();
      if (blocked.delete(target)) {
        saveBlockedFolders([...blocked]);
      }

      watcherLogger.info("folders:remove", { folder: target });
      return {
        ok: true,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    } catch (e) {
      watcherLogger.error("folders:remove-failed", {
        error: e.message,
        input: dirPath,
      });
      return {
        ok: false,
        error: e.message,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    }
  });

  //block
  ipcMain.handle("folders:block", async (_e, dirPath) => {
    try {
      const target = normalizePrefPath(coercePath(dirPath));
      if (!target) {
        return { ok: false, errorCode: "folderPathInvalid" };
      }
      const blocked = getBlockedFoldersSet();
      blocked.add(target);
      saveBlockedFolders([...blocked]);
      stopFolderWatcher(target);
      await syncFolderWatchersWithCurrentPrefs();
      await rebuildSaveWatchers({ suppressInitialNotify: true });
      return {
        ok: true,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    } catch (err) {
      watcherLogger.error("folders:block-failed", {
        error: err.message,
        input: dirPath,
      });
      return {
        ok: false,
        error: err.message,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    }
  });

  ipcMain.handle("folders:unblock", async (_e, dirPath) => {
    try {
      const target = normalizePrefPath(coercePath(dirPath));
      const blocked = getBlockedFoldersSet();
      blocked.delete(target);
      saveBlockedFolders([...blocked]);
      const cur = getUserWatchedFoldersRaw()
        .map(normalizePrefPath)
        .filter(Boolean);
      if (target && !cur.includes(target)) {
        saveWatchedFolders([...cur, target]);
      }
      await indexExistingConfigsSync();
      startFolderWatcher(target, { initialScan: false });
      await scanRootOnce(target, { suppressInitialNotify: true });
      await rebuildSaveWatchers({ suppressInitialNotify: true });
      return {
        ok: true,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    } catch (err) {
      watcherLogger.error("folders:unblock-failed", {
        error: err.message,
        input: dirPath,
      });
      return {
        ok: false,
        error: err.message,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    }
  });

  // rescan
  ipcMain.handle("folders:rescan", async (_e, payload = null) => {
    try {
      if (!bootOnboardingGateOpen) {
        return {
          ok: false,
          errorCode: "onboardingPending",
          error: "Boot onboarding is still in progress.",
          folders: getWatchedFolders({ includeMeta: true }),
        };
      }
      if (rescanInProgress.value)
        return { ok: false, errorCode: "rescanBusy", busy: true };
      const selectedPaths = Array.isArray(payload?.selectedPaths)
        ? payload.selectedPaths
        : null;
      const result = await restartWatchersAndRescan(selectedPaths);
      watcherLogger.info("folders:rescan", result);
      return {
        ...result,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    } catch (e) {
      watcherLogger.error("folders:rescan-failed", { error: e.message });
      return {
        ok: false,
        error: e.message,
        folders: getWatchedFolders({ includeMeta: true }),
      };
    }
  });

  async function waitForBootOverlayHiddenBeforeBackgroundScan() {
    const startedAt = Date.now();
    while (global.bootOverlayHidden !== true) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= BOOT_SCAN_OVERLAY_WAIT_MAX_MS) {
        watcherLogger.warn("boot:scan-overlay-gate-timeout", {
          waitedMs,
          maxMs: BOOT_SCAN_OVERLAY_WAIT_MAX_MS,
        });
        return;
      }
      await sleep(BOOT_SCAN_OVERLAY_WAIT_POLL_MS);
    }
    if (BOOT_SCAN_AFTER_OVERLAY_HIDE_DELAY_MS > 0) {
      await sleep(BOOT_SCAN_AFTER_OVERLAY_HIDE_DELAY_MS);
    }
    watcherLogger.info("boot:scan-overlay-gate-open", {
      reason: "overlay-hidden",
      delayMs: BOOT_SCAN_AFTER_OVERLAY_HIDE_DELAY_MS,
    });
  }

  // ——— boot ———
  app.whenReady().then(async () => {
    const onboardingState = readAutoConfigOnboardingState();
    bootOnboardingRequired = onboardingState.required;
    if (bootOnboardingRequired) {
      closeBootOnboardingGate();
      watcherLogger.info("boot:onboarding:required", {
        version: onboardingState.version,
        targetVersion: onboardingState.targetVersion,
      });
    } else {
      openBootOnboardingGate({ reason: "already-completed" });
    }
    const folders = getWatchedFolders();
    if (bootOnboardingRequired) {
      watcherLogger.info("boot:onboarding:watchers-deferred", {
        folderCount: folders.length,
      });
    } else {
      watcherLogger.info("boot:watchers-deferred", {
        folderCount: folders.length,
        reason: "background-scan",
      });
    }
    try {
      global.bootDone = true;
    } catch {}
    maybeEmitBootComplete();

    // UI-ready phase: wait for main window load before dismissing boot overlay.
    waitForMainWindowReady()
      .then(() => {
        try {
          global.bootUiReady = true;
        } catch {}
        try {
          broadcastAll("boot:ui-ready", { bootMode });
        } catch {}
        if (bootOnboardingRequired && !bootOnboardingShowSent) {
          bootOnboardingShowSent = true;
          try {
            broadcastAll("boot:onboarding:show", {
              required: true,
              version: onboardingState.version,
              targetVersion: onboardingState.targetVersion,
            });
          } catch {}
        }
        maybeEmitBootComplete();
      })
      .catch(() => {});

    // Background boot scan with bounded concurrency.
    (async () => {
      let bootProgressTotal = 8;
      const emitBootProgress = (patch = {}, options = {}) => {
        updateBootWatcherProgress(
          {
            total: bootProgressTotal,
            ...patch,
          },
          options,
        );
      };

      try {
        startBootWatcherProgress({
          phase: "waitingForUi",
          current: 0,
          total: bootProgressTotal,
          percent: 1,
        });
        try {
          await waitForBootOverlayHiddenBeforeBackgroundScan();
        } catch {}
        try {
          await waitForBootOnboardingGateOpen();
        } catch {}

        emitBootProgress(
          {
            phase: "indexingConfigs",
            itemName: "Configs",
            current: 1,
            percent: getBootProgressPercent(1, bootProgressTotal, 12),
          },
          { force: true },
        );
        try {
          await rebuildKnownAppIds({
            forceAsyncIndex: true,
            forceAsyncRootScan: true,
          });
        } catch {}
        const rootsForBootScan = getWatchedFolders();
        bootProgressTotal = Math.max(7, rootsForBootScan.length + 7);

        emitBootProgress(
          {
            phase: "attachingWatchers",
            itemName: `${rootsForBootScan.length} folders`,
            current: 2,
            percent: getBootProgressPercent(2, bootProgressTotal, 18),
          },
          { force: true },
        );
        try {
          if (BOOT_WATCH_FOLDER_DELAY_MS > 0) {
            await sleep(BOOT_WATCH_FOLDER_DELAY_MS);
          }
          await startFolderWatchersBatched(rootsForBootScan, {
            initialScan: false,
            batchDelayMs: BOOT_ATTACH_DELAY_MS,
          });
          if (ROOT_WATCH_SETTLE_DELAY_MS > 0 && rootsForBootScan.length > 0) {
            await sleep(ROOT_WATCH_SETTLE_DELAY_MS);
          }
        } catch {}
        try {
          await flushBootOnboardingDirtyRoots({
            reason: "boot-scan-gate-open",
          });
        } catch {}
        try {
          const scanJobs = rootsForBootScan.map((root, index) => ({
            root,
            index,
          }));
          await runWithConcurrency(scanJobs, 1, async ({ root, index }) => {
            emitBootProgress(
              {
                phase: "scanningFolders",
                itemName: getBootProgressItemName(root),
                current: Math.min(bootProgressTotal, 3 + index),
                percent: getBootProgressPercent(
                  Math.min(bootProgressTotal, 3 + index),
                  bootProgressTotal,
                  35,
                ),
              },
              { force: index === 0 || index === rootsForBootScan.length - 1 },
            );
            try {
              const normalizedRoot = normalizeRoot(root);
              const strictProfile = getStrictRootProfile(normalizedRoot);
              if (
                strictProfile &&
                BOOT_STRICT_SCAN_STAGGER_BASE_MS > 0 &&
                BOOT_STRICT_SCAN_STAGGER_SLOTS > 0
              ) {
                const offset =
                  (Math.max(0, Number(index) || 0) %
                    BOOT_STRICT_SCAN_STAGGER_SLOTS) *
                  BOOT_STRICT_SCAN_STAGGER_STEP_MS;
                const delayMs = BOOT_STRICT_SCAN_STAGGER_BASE_MS + offset;
                if (delayMs > 0) {
                  await sleep(delayMs);
                }
              }
              await scanRootOnce(root);
            } catch {}
          });
        } catch {}
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }

        const afterFolderScanCurrent = Math.min(
          bootProgressTotal,
          rootsForBootScan.length + 3,
        );
        emitBootProgress(
          {
            phase: "scanningLumaplay",
            itemName: "LumaPlay",
            current: afterFolderScanCurrent,
            percent: getBootProgressPercent(
              afterFolderScanCurrent,
              bootProgressTotal,
              72,
            ),
          },
          { force: true },
        );
        try {
          await scanLumaPlayRegistryOnce({
            suppressInitialNotify: true,
            autoRebuild: false,
          });
        } catch (err) {
          watcherLogger.warn("lumaplay:boot-scan-failed", {
            error: err?.message || String(err),
          });
        }
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }

        const rebuildCurrent = Math.min(
          bootProgressTotal,
          rootsForBootScan.length + 4,
        );
        emitBootProgress(
          {
            phase: "rebuildingWatchers",
            itemName: "Save watchers",
            current: rebuildCurrent,
            percent: getBootProgressPercent(
              rebuildCurrent,
              bootProgressTotal,
              82,
            ),
          },
          { force: true },
        );
        try {
          await rebuildSaveWatchers({
            deferLumaPlayPolling: true,
          });
        } catch {}
        try {
          emitDashboardRefresh();
        } catch {}
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }
        bootMode = false;
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }

        const pollersCurrent = Math.min(
          bootProgressTotal,
          rootsForBootScan.length + 5,
        );
        emitBootProgress(
          {
            phase: "startingPollers",
            itemName: "Background pollers",
            current: pollersCurrent,
            percent: getBootProgressPercent(
              pollersCurrent,
              bootProgressTotal,
              90,
            ),
          },
          { force: true },
        );
        startLumaPlayDiscoveryPolling();
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }
        try {
          await runLumaPlayDiscoveryTick({ autoRebuild: true });
        } catch {}
        if (BOOT_PHASE_SETTLE_DELAY_MS > 0) {
          await sleep(BOOT_PHASE_SETTLE_DELAY_MS);
        }

        emitBootProgress(
          {
            phase: "finalizing",
            itemName: "",
            current: Math.max(0, bootProgressTotal - 1),
            percent: 96,
          },
          { force: true },
        );
        scheduleDeferredSeedPumpAfterOverlayGate();
        finishBootWatcherProgress("success", {
          phase: "completed",
          itemName: "",
          current: bootProgressTotal,
          total: bootProgressTotal,
          percent: 100,
        });
      } catch (err) {
        finishBootWatcherProgress("failed", {
          phase: "failed",
          detail: err?.message || String(err || "Boot background startup failed"),
          percent: 0,
        });
      }
    })().catch(() => {});
  });

  function maybeEmitBootComplete() {
    if (bootCompleteEmitted) return;
    if (global.bootDone !== true) return;
    if (global.bootUiReady !== true) return;
    const dashOpen = global.dashboardOpen === true;
    const dashReady = global.dashboardReady === true;
    if (dashOpen && !dashReady) return;
    bootCompleteEmitted = true;
    try {
      broadcastAll("boot:complete", { bootMode });
    } catch {}
    watcherLogger.info("boot:complete", {
      bootMode,
      dashboardOpen: dashOpen,
      dashboardReady: dashReady,
    });
  }

  ipcMain.on("dashboard:ready", () => {
    try {
      global.dashboardReady = true;
    } catch {}
    maybeEmitBootComplete();
  });

  function collectResetUnblockCandidates(removedEntries = []) {
    const candidates = [];
    if (!Array.isArray(removedEntries)) return candidates;

    for (const entry of removedEntries) {
      if (!entry || typeof entry !== "object") continue;
      const entryAppId = normalizeAppIdValue(entry.appid);
      if (!entryAppId) continue;

      const entryScope = String(entry.scope || "")
        .trim()
        .toLowerCase();
      const entryPlatform = entry.platform
        ? normalizePlatform(entry.platform)
        : null;
      if (entryScope !== "global" && entryScope !== "platform") continue;
      if (entryScope === "platform" && !entryPlatform) continue;

      for (const meta of getConfigMetas(entryAppId)) {
        if (
          entryScope === "platform" &&
          normalizePlatform(meta?.platform) !== entryPlatform
        ) {
          continue;
        }
        candidates.push(meta);
      }
    }

    return candidates;
  }

  ipcMain.on("blacklist:removed-appid", (_e, payload) => {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const removedScopes = new Set(
        Array.isArray(payload?.removedScopes)
          ? payload.removedScopes.map((scope) =>
              String(scope || "").trim().toLowerCase(),
            )
          : [],
      );
      const normalizedAppId = normalizeAppIdValue(payload?.appid);
      const normalizedPlatform = payload?.platform
        ? normalizePlatform(payload.platform)
        : null;
      const candidates = [];

      if (payload?.reset === true) {
        candidates.push(
          ...collectResetUnblockCandidates(payload?.removedEntries),
        );
      } else if (normalizedAppId) {
        const appMetas = getConfigMetas(normalizedAppId);
        const globalScopeRemoved = removedScopes.has("global");
        for (const meta of appMetas) {
          if (
            !globalScopeRemoved &&
            normalizedPlatform &&
            normalizePlatform(meta?.platform) !== normalizedPlatform
          ) {
            continue;
          }
          candidates.push(meta);
        }
      }

      const currentBlacklist = getBlacklistState();
      const markedConfigs = new Set();
      for (const meta of candidates) {
        const metaAppId = normalizeAppIdValue(meta?.appid || normalizedAppId);
        if (!metaAppId || !meta?.name || markedConfigs.has(meta.name)) continue;
        if (
          isAppIdBlacklisted(
            metaAppId,
            meta?.platform || null,
            currentBlacklist,
          )
        ) {
          continue;
        }
        markedConfigs.add(meta.name);
        justUnblockedConfigs.add(meta.name);
        cancelAutoSelectForMeta(meta);
      }
      watcherLogger.info("blacklist:unblock-suppression-applied", {
        appid: normalizedAppId || null,
        platform: normalizedPlatform || null,
        reset: payload?.reset === true,
        removedEntryCount: Array.isArray(payload?.removedEntries)
          ? payload.removedEntries.length
          : 0,
        removedScopes: Array.from(removedScopes),
        configs: Array.from(markedConfigs),
      });
      return;
    }

    if (Array.isArray(payload)) {
      for (const id of payload) {
        const normalized = normalizeAppIdValue(id);
        if (normalized) {
          justUnblocked.add(normalized);
          suppressAutoSelect.add(normalized);
          cancelAutoSelectForApp(normalized);
        }
      }
      return;
    }
    const normalized = normalizeAppIdValue(payload);
    if (normalized) {
      justUnblocked.add(normalized);
      suppressAutoSelect.add(normalized);
      cancelAutoSelectForApp(normalized);
    } else if (payload === null) {
      justUnblocked.clear();
      justUnblockedConfigs.clear();
      suppressAutoSelect.clear();
      suppressAutoSelectByConfig.clear();
      autoSelectEmitted.clear();
    }
  });

  async function refreshConfigState(options = {}) {
    const suppressInitialNotify = options?.suppressInitialNotify === true;
    watcherLogger.info("refresh-config-state:start", {
      saveWatcherBuckets: appidSaveWatchers.size,
      folderWatchers: folderWatchers.size,
      suppressInitialNotify,
    });
    await indexExistingConfigsSync();
    await rebuildSaveWatchers({ suppressInitialNotify });
    watcherLogger.info("refresh-config-state:complete", {
      saveWatcherBuckets: appidSaveWatchers.size,
      folderWatchers: folderWatchers.size,
      suppressInitialNotify,
    });
  }

  async function findShippingExeDir(
    root,
    maxDepth = 6,
    shouldSkipPath = null,
  ) {
    const matches = (name) => /shipping\.exe$/i.test(name || "");
    async function walk(dir, depth = 0) {
      if (depth > maxDepth) return null;
      if (typeof shouldSkipPath === "function" && shouldSkipPath(dir)) {
        return null;
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isFile() && matches(ent.name)) {
          return path.dirname(full);
        }
      }
      if (depth < maxDepth) {
        for (const ent of entries) {
          if (ent.isDirectory()) {
            const next = path.join(dir, ent.name);
            const found = await walk(next, depth + 1);
            if (found) return found;
          }
        }
      }
      return null;
    }
    return await walk(root, 0);
  }

  if (app && typeof app.on === "function") {
    app.on("before-quit", async () => {
      stopLumaPlayDiscoveryPolling();
      stopBootOnboardingAttentionLoop();
      for (const entry of folderWatchers.values()) {
        entry.stopped = true;
        entry.rescanQueued = false;
        clearTimeout(entry.debounce);
        try {
          await entry.watcher.close();
        } catch {}
      }
      for (const bucket of appidSaveWatchers.values()) {
        if (!(bucket instanceof Map)) continue;
        for (const w of bucket.values()) {
          try {
            await w.close();
          } catch {}
        }
      }
      for (const t of autoSelectTimers.values()) {
        clearTimeout(t);
      }
      autoSelectTimers.clear();
      if (deferredSeedPumpTimer) {
        clearTimeout(deferredSeedPumpTimer);
        deferredSeedPumpTimer = null;
      }
      deferredSeedQueue.length = 0;
      deferredSeedByConfig.clear();
      deferredSeedPendingConfigs.clear();
      deferredSeedActiveConfigs.clear();
      clearLumaPlayDiscoveryTimer();
      lumaPlayDiscoveryScheduledOptions = null;
      steamOfficialSeedOnlyLogged.clear();
      strictRootSeedOnlyLogged.clear();
    });
  }

  return {
    beginConfigDeletion,
    endConfigDeletion,
    resetPlatinumState,
    rebuildKnownAppIds,
    refreshConfigState,
    isBootOnboardingPending,
    forceBootOnboardingSkipAll,
  };
};
