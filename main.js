const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  globalShortcut,
  Tray,
  shell,
} = require("electron");
// Polyfill File for environments where undici expects it (Electron main may lack global File)
if (typeof globalThis.File === "undefined") {
  const { Blob } = require("buffer");
  class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = String(name);
      this.lastModified = options?.lastModified ?? Date.now();
      this.webkitRelativePath = "";
    }
  }
  globalThis.File = File;
}
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-hid-blocklist");
app.setName("Achievements");
const {
  spawn,
  fork,
  execFile,
  execFileSync,
  spawnSync,
} = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ini = require("ini");
const chokidar = require("chokidar");
const CRC32 = require("crc-32");
const { copyFolderOnce, copyFolderOverwrite } = require("./utils/fileCopy");
const { computeFolderContentVersion } = require("./utils/content-version");
const {
  defaultSoundsFolder,
  defaultPresetsFolder,
  userSoundsFolder,
  userPresetsFolder,
  preferencesPath,
  configsDir,
  cacheDir,
} = require("./utils/paths");
const { startPlaytimeLogWatcher } = require("./utils/playtime-log-watcher");
const { parseGpdFile, buildSnapshotFromGpd } = require("./utils/xenia-gpd");
const {
  parseTrophySetDir,
  buildSnapshotFromTrophy,
} = require("./utils/rpcs3-trophy");
const {
  parseKVBinary: parseSteamKv,
  extractUserStats,
  buildSnapshotFromAppcache,
  pickLatestUserBin,
} = require("./utils/steam-appcache");
const {
  clearLumaPlayReadCache,
  readLumaPlayAchievementsSnapshot,
  startLumaPlayRegistryEventWatcher,
} = require("./utils/lumaplay-registry");
const {
  RARITY_SOURCES,
  fetchEpicGlobalAchievementPercentages,
  fetchGogGlobalAchievementPercentages,
  fetchSteamGlobalAchievementPercentages,
  buildRarityEntriesForSchema,
  writeAchievementPercentagesSidecar,
  readAchievementPercentagesMap,
  mergeRarityIntoAchievements,
} = require("./utils/achievement-rarity");
const { ensureGogAccessToken } = require("./utils/gog-auth");
const {
  bindingsCanConflict: overlayBindingsCanConflict,
  createOverlayShortcutManager,
  getShortcutBindingSignature: getOverlayShortcutBindingSignature,
  normalizeShortcutAccelerator: normalizeOverlayShortcutAccelerator,
  parseShortcutAccelerator: parseOverlayShortcutAccelerator,
} = require("./utils/overlay-shortcut-manager");
const getConfigInflight = new Map();
const { createLogger } = require("./utils/logger");

const appLogger = createLogger("app");
const notificationLogger = createLogger("notifications");
const windowLogger = createLogger("windows");
const overlayLogger = createLogger("overlay", {
  level: process.env.OVERLAY_LOG_LEVEL || "info",
});
const ipcLogger = createLogger("ipc");
const uiLogger = createLogger("ui");
const coverUiLogger = createLogger("covers");
const prefsLogger = createLogger("preferences");
const persistenceLogger = createLogger("persistence");
const execLogger = createLogger("execution");
const schemaLogger = createLogger("achschema");
const rarityLogger = createLogger("rarity");
const overlayShortcutManager = createOverlayShortcutManager({
  loadHook: () => {
    const { uIOhook, UiohookKey } = require("uiohook-napi");
    return { hook: uIOhook, keyMap: UiohookKey };
  },
  logger: overlayLogger,
});

const PRESETS_MIGRATION_VERSION_FALLBACK = "2026-01-12-duration";
let cachedPresetsMigrationVersion = "";
const PRESET_FOLDER_DEFAULT = "Default Presets";
const PRESET_FOLDER_USERS = "Users Presets";
const PRESET_FOLDER_DEFAULT_LEGACY = "Scalable";
const PRESET_FOLDER_USERS_LEGACY = "Non-scalable";

function getPresetsMigrationVersion() {
  if (cachedPresetsMigrationVersion) return cachedPresetsMigrationVersion;

  try {
    cachedPresetsMigrationVersion = computeFolderContentVersion(
      defaultPresetsFolder,
      { prefix: "presets" },
    );
  } catch (err) {
    cachedPresetsMigrationVersion = PRESETS_MIGRATION_VERSION_FALLBACK;
    appLogger.warn("presets:version-compute-failed", {
      error: err?.message || String(err),
      fallbackVersion: PRESETS_MIGRATION_VERSION_FALLBACK,
    });
  }

  return cachedPresetsMigrationVersion;
}

function getPresetCategoryRoots(baseFolder, category) {
  const names =
    category === "default"
      ? [PRESET_FOLDER_DEFAULT, PRESET_FOLDER_DEFAULT_LEGACY]
      : [PRESET_FOLDER_USERS, PRESET_FOLDER_USERS_LEGACY];
  return names.map((name) => path.join(baseFolder, name));
}

function getUniqueSiblingPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  let suffix = 1;
  let candidate = `${basePath}_${suffix}`;
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = `${basePath}_${suffix}`;
  }
  return candidate;
}

function renameLegacyPresetFolder(legacyName, nextName) {
  const legacyPath = path.join(userPresetsFolder, legacyName);
  const nextPath = path.join(userPresetsFolder, nextName);

  if (!fs.existsSync(legacyPath)) return;
  let legacyStat = null;
  try {
    legacyStat = fs.statSync(legacyPath);
  } catch (err) {
    appLogger.warn("presets:legacy-stat-failed", {
      legacyPath,
      error: err?.message || String(err),
    });
    return;
  }
  if (!legacyStat.isDirectory()) return;

  if (!fs.existsSync(nextPath)) {
    try {
      fs.renameSync(legacyPath, nextPath);
      appLogger.info("presets:legacy-renamed", {
        from: legacyPath,
        to: nextPath,
      });
    } catch (err) {
      appLogger.warn("presets:legacy-rename-failed", {
        from: legacyPath,
        to: nextPath,
        error: err?.message || String(err),
      });
    }
    return;
  }

  let nextStat = null;
  try {
    nextStat = fs.statSync(nextPath);
  } catch (err) {
    appLogger.warn("presets:new-stat-failed", {
      nextPath,
      error: err?.message || String(err),
    });
    return;
  }
  if (!nextStat.isDirectory()) {
    appLogger.warn("presets:legacy-target-not-dir", {
      nextPath,
      legacyPath,
    });
    return;
  }

  const backupBase = path.join(
    path.dirname(userPresetsFolder),
    `presets_${legacyName.replace(/[\\/:*?"<>|]/g, "_")}_legacy_backup`,
  );
  const backupPath = getUniqueSiblingPath(backupBase);
  try {
    fs.renameSync(legacyPath, backupPath);
    copyFolderOnce(backupPath, nextPath);
    appLogger.warn("presets:legacy-merged-with-backup", {
      legacyPath,
      nextPath,
      backupPath,
    });
  } catch (err) {
    appLogger.warn("presets:legacy-merge-failed", {
      legacyPath,
      nextPath,
      backupPath,
      error: err?.message || String(err),
    });
  }
}

function renameLegacyPresetFoldersIfNeeded() {
  try {
    fs.mkdirSync(userPresetsFolder, { recursive: true });
  } catch (err) {
    appLogger.warn("presets:user-dir-create-failed", { error: err.message });
    return;
  }

  renameLegacyPresetFolder(PRESET_FOLDER_DEFAULT_LEGACY, PRESET_FOLDER_DEFAULT);
  renameLegacyPresetFolder(PRESET_FOLDER_USERS_LEGACY, PRESET_FOLDER_USERS);
}

function runWindowsConfirm({ title, message }) {
  const ps = process.env.SystemRoot
    ? path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$title = $env:ACH_CONFIRM_TITLE;",
    "$message = $env:ACH_CONFIRM_MESSAGE;",
    "$result = [System.Windows.Forms.MessageBox]::Show($message, $title, 'OKCancel', 'Question');",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }",
  ].join(" ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const env = {
    ...process.env,
    ACH_CONFIRM_TITLE: title || app.getName() || "Confirm",
    ACH_CONFIRM_MESSAGE: message || "Are you sure?",
  };
  try {
    const res = spawnSync(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded,
      ],
      { env, stdio: "ignore", windowsHide: true },
    );
    if (typeof res.status === "number") {
      return res.status === 0;
    }
    if (res.error) {
      appLogger.error("ui:confirm:powershell-failed", {
        error: res.error?.message || String(res.error),
      });
    }
    return null;
  } catch (err) {
    appLogger.error("ui:confirm:powershell-failed", {
      error: err?.message || String(err),
    });
    return null;
  }
}

function migrateDefaultPresetsIfNeeded() {
  const targetVersion = getPresetsMigrationVersion();
  const versionFile = path.join(userPresetsFolder, ".presets-version");
  let currentVersion = "";
  try {
    if (fs.existsSync(versionFile)) {
      currentVersion = fs.readFileSync(versionFile, "utf8").trim();
    }
  } catch (err) {
    appLogger.warn("presets:version-read-failed", { error: err.message });
  }

  if (currentVersion === targetVersion) return;

  try {
    fs.mkdirSync(userPresetsFolder, { recursive: true });
  } catch (err) {
    appLogger.warn("presets:user-dir-create-failed", { error: err.message });
  }

  try {
    if (fs.existsSync(userPresetsFolder)) {
      const entries = fs.readdirSync(userPresetsFolder);
      if (entries.length > 0) {
        const baseUserDir = path.dirname(userPresetsFolder);
        const backupDir = path.join(
          baseUserDir,
          `presets_backup_${targetVersion}`,
        );
        if (!fs.existsSync(backupDir)) {
          copyFolderOnce(userPresetsFolder, backupDir);
          appLogger.info("presets:backup-created", {
            backupDir,
            version: targetVersion,
          });
        }
      }
    }
  } catch (err) {
    appLogger.warn("presets:backup-failed", { error: err.message });
  }

  try {
    copyFolderOverwrite(defaultPresetsFolder, userPresetsFolder);
    appLogger.info("presets:migrated", {
      version: targetVersion,
      source: defaultPresetsFolder,
      target: userPresetsFolder,
    });
  } catch (err) {
    appLogger.warn("presets:migration-failed", { error: err.message });
  }

  try {
    fs.writeFileSync(versionFile, targetVersion, "utf8");
  } catch (err) {
    appLogger.warn("presets:version-write-failed", { error: err.message });
  }
}

function copyProgressTemplateToUserPresetsOnce() {
  const targetPath = getUserProgressTemplatePath();
  const targetDir = path.dirname(targetPath);
  const bundledSourcePath = path.join(__dirname, "progress.html");
  const usersPresetProgressCandidates = getPresetCategoryRoots(
    userPresetsFolder,
    "users",
  ).map((root) => path.join(root, "Progress", "progress.html"));
  const sourcePath =
    usersPresetProgressCandidates.find((candidate) =>
      fs.existsSync(candidate),
    ) || bundledSourcePath;

  try {
    if (!fs.existsSync(sourcePath)) {
      appLogger.warn("progress-template:source-missing", { sourcePath });
      return;
    }
    if (fs.existsSync(targetPath)) return;

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    appLogger.info("progress-template:copied", {
      source: sourcePath,
      target: targetPath,
    });
  } catch (err) {
    appLogger.warn("progress-template:copy-failed", {
      error: err?.message || String(err),
      source: sourcePath,
      target: targetPath,
    });
  }
}

function getUserProgressTemplatePath() {
  return path.join(path.dirname(userPresetsFolder), "progress.html");
}

function resolveProgressTemplatePath() {
  const userPath = getUserProgressTemplatePath();
  if (fs.existsSync(userPath)) return userPath;
  return path.join(__dirname, "progress.html");
}

function resolveNotificationPresetFolder(presetName) {
  const requested = String(presetName || "default");
  const defaultPresetFolders = getPresetCategoryRoots(
    userPresetsFolder,
    "default",
  ).map((root) => path.join(root, requested));
  const userPresetFolders = getPresetCategoryRoots(
    userPresetsFolder,
    "users",
  ).map((root) => path.join(root, requested));
  const oldStyleFolder = path.join(userPresetsFolder, requested);

  const candidates = [
    ...defaultPresetFolders,
    ...userPresetFolders,
    oldStyleFolder,
  ];
  const firstWithIndex = candidates.find((folder) =>
    fs.existsSync(path.join(folder, "index.html")),
  );
  if (firstWithIndex) {
    return { presetFolder: firstWithIndex, requestedPreset: requested };
  }

  const defaultRootCandidates = getPresetCategoryRoots(
    userPresetsFolder,
    "default",
  );
  const userRootCandidates = getPresetCategoryRoots(userPresetsFolder, "users");
  const fallbackCandidates = [
    ...defaultRootCandidates.map((root) => path.join(root, "Default")),
    ...userRootCandidates.map((root) => path.join(root, "Default")),
    path.join(userPresetsFolder, "Default"),
    ...defaultRootCandidates.map((root) => path.join(root, "default")),
    ...userRootCandidates.map((root) => path.join(root, "default")),
    path.join(userPresetsFolder, "default"),
  ];
  const fallbackFolder = fallbackCandidates.find((folder) =>
    fs.existsSync(path.join(folder, "index.html")),
  );

  if (fallbackFolder) {
    appLogger.warn("preset:index-missing-fallback", {
      preset: requested,
      candidates,
      fallbackFolder,
    });
    return { presetFolder: fallbackFolder, requestedPreset: requested };
  }

  return {
    presetFolder:
      candidates.find((folder) => fs.existsSync(folder)) || oldStyleFolder,
    requestedPreset: requested,
  };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function getDefaultScreenshotFolder() {
  try {
    return path.join(app.getPath("pictures"), "Achievements Screenshots");
  } catch {
    return path.join(process.cwd(), "Achievements Screenshots");
  }
}

const SCHEMA_LANGUAGE_VALUES = [
  "arabic",
  "bulgarian",
  "schinese",
  "tchinese",
  "czech",
  "danish",
  "dutch",
  "english",
  "finnish",
  "french",
  "german",
  "greek",
  "hungarian",
  "indonesian",
  "italian",
  "japanese",
  "koreana",
  "norwegian",
  "polish",
  "portuguese",
  "brazilian",
  "romanian",
  "russian",
  "spanish",
  "latam",
  "swedish",
  "thai",
  "turkish",
  "ukrainian",
  "vietnamese",
];

function normalizeSchemaLanguageList(value) {
  const allowed = new Set(SCHEMA_LANGUAGE_VALUES);
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const token = String(item || "")
      .trim()
      .toLowerCase();
    if (!token || !allowed.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function getSchemaLanguagesFromPreferences(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  const normalized = normalizeSchemaLanguageList(source?.schemaLanguages);
  if (normalized.length) return normalized;
  if (Object.prototype.hasOwnProperty.call(source || {}, "schemaLanguages")) {
    return ["english"];
  }
  return [...SCHEMA_LANGUAGE_VALUES];
}

const DEFAULT_PREFERENCES = {
  startInTray: false,
  screenshotFolder: getDefaultScreenshotFolder(),
  overlayShortcut: "",
  overlayInteractShortcut: "\\",
  sound: "mute",
  soundVolume: 100,
  preset: "default",
  notificationScale: 1,
  notificationDuration: 0,
  position: "center-bottom",
  language: "english",
  uiLanguage: "english",
  achievementLanguageManual: false,
  disableProgress: false,
  progressMutedConfigs: [],
  windowZoomFactor: 1,
  disableAchievementScreenshot: false,
  showDashboardOnStart: false,
  startMaximized: false,
  disableHardwareAcceleration: true,
  disablePlaytime: false,
  platinumSound: "mute",
  platinumPreset: "default",
  platinumPosition: "center-bottom",
  showBlacklistedGames: false,
  disablePlatinum: false,
  showHiddenDescription: false,
  closeToTray: false,
  blockedWatchedFolders: [],
  blacklistedAppIds: [],
  watchedFolders: [],
  lumaPlayWatcherEnabled: false,
  disableProcessNameWatcher: false,
  forceGlobalOverlayShortcuts: false,
  ignoreLeadingArticlesSort: true,
  schemaLanguages: [...SCHEMA_LANGUAGE_VALUES],
  steamApiKey: "",
};

const UI_LOCALE_DIR = path.join(__dirname, "assets", "locales");
const uiLocaleCache = new Map();

function normalizeUiLanguage(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "english";
  return raw === "latam" || raw === "es-419" ? "latam" : raw;
}

function getUiLanguage() {
  const prefs = cachedPreferences || {};
  return normalizeUiLanguage(
    prefs.uiLanguage || prefs.language || DEFAULT_PREFERENCES.uiLanguage,
  );
}

function loadUiLocale(lang) {
  const normalized = normalizeUiLanguage(lang);
  if (uiLocaleCache.has(normalized)) return uiLocaleCache.get(normalized);
  let data = {};
  const filePath = path.join(UI_LOCALE_DIR, `${normalized}.json`);
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    if (normalized !== "english") {
      try {
        const fallbackPath = path.join(UI_LOCALE_DIR, "english.json");
        data = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
      } catch {
        data = {};
      }
    }
  }
  uiLocaleCache.set(normalized, data);
  return data;
}

function tUi(key, params = {}, fallback = "") {
  const strings = loadUiLocale(getUiLanguage());
  let template = strings[key] || fallback || key;
  if (!params || typeof params !== "object") return template;
  return template.replace(/\{(\w+)\}/g, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      return String(params[name] ?? "");
    }
    return `{${name}}`;
  });
}

function mergeWithDefaultPreferences(prefs = {}) {
  return { ...DEFAULT_PREFERENCES, ...(prefs || {}) };
}

const shouldDisableHardwareAcceleration = (() => {
  try {
    const prefs = readPrefsSafe();
    const merged = mergeWithDefaultPreferences(prefs);
    return merged.disableHardwareAcceleration === true;
  } catch (err) {
    prefsLogger.warn("preferences:hardwareAccel-read-failed", {
      error: err?.message || String(err),
    });
    return DEFAULT_PREFERENCES.disableHardwareAcceleration === true;
  }
})();
if (shouldDisableHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

function ensurePreferencesFile() {
  try {
    const current = readPrefsSafe();
    const merged = mergeWithDefaultPreferences(current);
    const exists = fs.existsSync(preferencesPath);
    if (!exists || !deepEqual(current, merged)) {
      fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
      fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2));
    }
    return merged;
  } catch (err) {
    prefsLogger.warn("preferences:ensure-failed", { error: err.message });
    return readPrefsSafe();
  }
}

const BLACKLIST_PREF_KEY = "blacklistedAppIds";
const blacklistedAppIdsSet = new Set();
let watchedFoldersApi = null;
let cachedPreferences = {};
let mainWindow;
let selectedConfigPath = null;
let selectedConfig = null;
let selectedPlatform = null;
let mainWindowUserZoom = 1;
let mainWindowZoomTimer = null;
let displayMetricsListenerAdded = false;
const ZOOM_LOG_EPS = 0.001;
let lastZoomLog = null;
let selectedSound = "mute";
let selectedPreset = "default";
let selectedPosition = "center-bottom";
let selectedNotificationScale = 1;
let bootSeeding = true;
let bootOnboardingRecoveryTimer = null;
let bootOnboardingRecoveryLastAt = 0;
global.bootDone = false;
global.bootUiReady = false;
global.bootOverlayHidden = false;
global.bootOnboardingGateOpen = true;
global.bootOnboardingRequired = false;
let bootOverlayHiddenAt = 0;
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  app.exit(0);
  process.exit(0);
} else {
  app.on("second-instance", () => {
    // Ignore subsequent launches; keep the first instance state (tray/hidden).
    return;
  });
}

function normalizeAppIdValue(value) {
  const trimmed = String(value || "").trim();
  if (
    /^[0-9a-fA-F]+$/.test(trimmed) ||
    /^CUSA\d+$/i.test(trimmed) ||
    /^NP[A-Z0-9_]+$/i.test(trimmed) ||
    /^0x[0-9a-f]+$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return "";
}

function setBlacklistedAppIds(list) {
  blacklistedAppIdsSet.clear();
  const arr = Array.isArray(list) ? list : [];
  for (const id of arr) {
    const normalized = normalizeAppIdValue(id);
    if (normalized) blacklistedAppIdsSet.add(normalized);
  }
}

process.on("uncaughtException", (err) => {
  ipcLogger.error("process:uncaught-exception", {
    error: err?.message || String(err),
    stack: err?.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  ipcLogger.error("process:unhandled-rejection", {
    error: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

function normalizeProgressMutePath(value) {
  if (!value) return "";
  const normalized = path.normalize(String(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function buildProgressMuteKey(configPath, configName) {
  if (configPath) return `path:${normalizeProgressMutePath(configPath)}`;
  if (configName) return `name:${String(configName)}`;
  return "";
}

function isProgressMutedByPrefs(prefs, payload) {
  const list = Array.isArray(prefs?.progressMutedConfigs)
    ? prefs.progressMutedConfigs
    : [];
  if (!list.length) return false;
  const key = buildProgressMuteKey(
    payload?.config_path || payload?.configPath || "",
    payload?.configName ||
      payload?.config_name ||
      payload?.config ||
      selectedConfig,
  );
  return key ? list.includes(key) : false;
}

function readBlacklistFromPrefs() {
  const prefs = readPrefsSafe();
  const arr = Array.isArray(prefs[BLACKLIST_PREF_KEY])
    ? prefs[BLACKLIST_PREF_KEY]
    : [];
  return arr.map(normalizeAppIdValue).filter(Boolean);
}

function persistBlacklist(appIds) {
  const nextList = Array.from(new Set(appIds))
    .map(normalizeAppIdValue)
    .filter(Boolean);
  try {
    const prefs = updatePreferences({ [BLACKLIST_PREF_KEY]: nextList });
    return prefs[BLACKLIST_PREF_KEY] || [];
  } catch (err) {
    prefsLogger.error("blacklist:write-failed", { error: err.message });
  }
  return readBlacklistFromPrefs();
}

function addAppIdToBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return readBlacklistFromPrefs();
  const next = new Set(readBlacklistFromPrefs());
  next.add(normalized);
  return persistBlacklist(Array.from(next));
}

function removeAppIdFromBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return readBlacklistFromPrefs();
  const next = new Set(readBlacklistFromPrefs());
  next.delete(normalized);
  return persistBlacklist(Array.from(next));
}

function resetBlacklist() {
  return persistBlacklist([]);
}

function isAppIdBlacklisted(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return false;
  const current = readBlacklistFromPrefs();
  return current.includes(normalized);
}

function refreshBlacklistEffects() {
  try {
    if (watchedFoldersApi?.refreshConfigState) {
      watchedFoldersApi.refreshConfigState();
    }
  } catch (err) {
    ipcLogger.error("blacklist:refresh-config-state-failed", {
      error: err?.message || String(err),
    });
  }
  try {
    if (watchedFoldersApi?.rebuildKnownAppIds) {
      watchedFoldersApi.rebuildKnownAppIds();
    }
  } catch (err) {
    ipcLogger.error("blacklist:rebuild-known-appids-failed", {
      error: err?.message || String(err),
    });
  }
  try {
    notifyConfigsChanged();
  } catch (err) {
    ipcLogger.error("blacklist:notify-configs-changed-failed", {
      error: err?.message || String(err),
    });
  }
}

const MY_LOGIN_FILENAME = "my_login.txt";

function getMyLoginUserDataPath() {
  try {
    return path.join(app.getPath("userData"), MY_LOGIN_FILENAME);
  } catch {
    return path.join(process.cwd(), MY_LOGIN_FILENAME);
  }
}

function getMyLoginAppPath() {
  return path.join(__dirname, MY_LOGIN_FILENAME);
}

function parseSteamApiKeyFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*(key|apikey|steam_api_key)\s*=/i.test(line)) {
      return line.split("=").slice(1).join("=").trim();
    }
  }
  return "";
}

function readSteamApiKeyFromFile() {
  const candidates = [getMyLoginUserDataPath(), getMyLoginAppPath()];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, "utf8");
      const key = parseSteamApiKeyFromText(raw);
      if (key) return key;
    } catch {}
  }
  return "";
}

function maskSteamApiKey(value) {
  const key = String(value || "");
  if (!key) return "";
  if (key.length <= 4) {
    return "•".repeat(key.length);
  }
  return `${"•".repeat(key.length - 4)}${key.slice(-4)}`;
}

function writeSteamApiKeyFile(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return;
  const target = getMyLoginUserDataPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `key=${trimmed}\n`, "utf8");
  } catch (err) {
    prefsLogger.error("steam-api-key:write-failed", { error: err.message });
  }
}

function removeSteamApiKeyFiles() {
  const targets = [getMyLoginUserDataPath()];
  const legacy = getMyLoginAppPath();
  if (legacy && !targets.includes(legacy)) targets.push(legacy);
  for (const fp of targets) {
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
  }
}

function ensureSteamApiKeyFileFromPrefs() {
  const key = String(cachedPreferences?.steamApiKey || "").trim();
  if (!key) return;
  writeSteamApiKeyFile(key);
}

function looksLikeSchemaArray(json) {
  if (!Array.isArray(json)) return false;
  if (json.length === 0) return true;
  const a = json[0] || {};
  return (
    typeof a.name === "string" &&
    (typeof a.displayName === "string" || typeof a.displayName === "object") &&
    ("icon" in a || "icon_gray" in a || "icongray" in a)
  );
}

function looksLikeSaveJson(json) {
  if (!json || typeof json !== "object") return false;
  if (Array.isArray(json)) {
    const a = json[0] || {};
    return (
      "Achieved" in a ||
      "UnlockTime" in a ||
      "CurProgress" in a ||
      "MaxProgress" in a ||
      "earned" in a
    );
  }
  const firstVal = Object.values(json)[0];
  return (
    firstVal &&
    typeof firstVal === "object" &&
    ("Achieved" in firstVal ||
      "UnlockTime" in firstVal ||
      "CurProgress" in firstVal ||
      "MaxProgress" in firstVal ||
      "earned" in firstVal)
  );
}

function readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function findConfigDirFromSelection(selDir, appid = "", platform = "") {
  if (!isNonEmptyString(selDir)) return null;
  const normalizedAppId = String(appid || "").trim();
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const candidates = [];

  const pushCandidate = (dir) => {
    if (!dir || candidates.includes(dir)) return;
    candidates.push(dir);
  };

  pushCandidate(path.join(selDir, "steam_settings"));
  pushCandidate(selDir);
  if (normalizedAppId) {
    pushCandidate(path.join(selDir, normalizedAppId));
    if (normalizedPlatform) {
      pushCandidate(path.join(selDir, normalizedPlatform, normalizedAppId));
    }
    ["uplay", "steam", "epic", "gog"].forEach((plat) =>
      pushCandidate(path.join(selDir, plat, normalizedAppId)),
    );
  }

  for (const dir of candidates) {
    if (!dir) continue;
    const file = path.join(dir, "achievements.json");
    try {
      if (fs.existsSync(file) && looksLikeSchemaArray(readJsonSafe(file))) {
        return dir;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findSaveBaseFromSelection(selDir, appid) {
  // 1) <sel>/steam_settings/<appid>/achievements.json → save_path = <sel>/steam_settings
  const s1 = path.join(
    selDir,
    "steam_settings",
    String(appid),
    "achievements.json",
  );
  if (fs.existsSync(s1) && looksLikeSaveJson(readJsonSafe(s1))) {
    return path.join(selDir, "steam_settings");
  }
  // 2) <sel>/<appid>/achievements.json → save_path = <sel>
  const s2 = path.join(selDir, String(appid), "achievements.json");
  if (fs.existsSync(s2) && looksLikeSaveJson(readJsonSafe(s2))) {
    return selDir;
  }
  // 3) <sel>/achievements.json → save_path = <sel>
  const s3 = path.join(selDir, "achievements.json");
  if (fs.existsSync(s3) && looksLikeSaveJson(readJsonSafe(s3))) {
    return selDir;
  }
  return null;
}

function resolveSaveFilePath(saveBase, appid) {
  const candidates = [
    path.join(saveBase, "steam_settings", String(appid), "achievements.json"),
    path.join(saveBase, String(appid), "achievements.json"),
    path.join(saveBase, "achievements.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return path.join(saveBase, String(appid), "achievements.json");
}

function resolveSaveSidecarPaths(saveBase, appid) {
  const dirs = [
    path.join(saveBase, "steam_settings", String(appid)),
    path.join(saveBase, String(appid)),
    saveBase,
  ];
  for (const d of dirs) {
    const iniPath = path.join(d, "achievements.ini");
    const universeIniPath = path.join(d, "UniverseLANData", "Achievements.ini");
    const tenokeIniNested = path.join(d, "SteamData", "user_stats.ini");
    const tenokeIniDirect = path.join(d, "user_stats.ini");
    const tenokeIni = fs.existsSync(tenokeIniDirect)
      ? tenokeIniDirect
      : tenokeIniNested;
    const ofx = path.join(d, "Stats", "achievements.ini");
    const bin = path.join(d, "stats.bin");
    if (fs.existsSync(tenokeIni))
      return {
        dir: d,
        ini: null,
        tenokeIni,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };
    if (fs.existsSync(ofx))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(universeIniPath))
      return {
        dir: d,
        ini: universeIniPath,
        tenokeIni: null,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(iniPath))
      return {
        dir: d,
        ini: iniPath,
        tenokeIni: null,
        ofx: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(bin))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx: null,
        bin,
      };
  }
  return {
    dir: path.join(saveBase, String(appid)),
    ini: null,
    tenokeIni: null,
    ofx: null,
    bin: null,
  };
}

function resolveGpdPathForConfig(config) {
  if (!config) return "";
  const direct =
    typeof config.gpd_path === "string" && config.gpd_path
      ? config.gpd_path
      : "";
  if (direct && fs.existsSync(direct)) return direct;
  const base = typeof config.save_path === "string" ? config.save_path : "";
  const appid = String(config.appid || "").trim();
  if (base && appid) {
    const candidate = path.join(base, `${appid}.gpd`);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (base) {
    try {
      const files = fs.readdirSync(base);
      const found = files.find((f) => f.toLowerCase().endsWith(".gpd"));
      if (found) return path.join(base, found);
    } catch {}
  }
  return base && appid ? path.join(base, `${appid}.gpd`) : "";
}

function resolveRpcs3TrophyDirForConfig(config) {
  if (!config) return "";
  const direct =
    typeof config.trophy_path === "string" && config.trophy_path
      ? config.trophy_path
      : typeof config.trophy_dir === "string" && config.trophy_dir
        ? config.trophy_dir
        : "";
  if (direct && fs.existsSync(direct)) return direct;
  const base = typeof config.save_path === "string" ? config.save_path : "";
  if (base && fs.existsSync(base)) return base;
  return direct || base || "";
}

function resolveTropusrPathForConfig(config) {
  const trophyDir = resolveRpcs3TrophyDirForConfig(config);
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

const ACHGEN_BUFFER_MAX = 300;
const achgenBuffer = [];

function mapAchgenUiMessage(message) {
  const raw = String(message || "").trim();
  const msg = raw.replace(/^[\u2705\u2139\u23ed\u23e9\u26a0]\s*/i, "");
  if (msg === "steam-scrape:exophase:start") {
    return tUi(
      "main.achgen.exophase.start",
      {},
      "Downloading Extra Languages...",
    );
  }
  if (msg === "steam-scrape:exophase:failed") {
    return tUi(
      "main.achgen.exophase.failed",
      {},
      "Downloading Extra Languages: Failed.",
    );
  }
  if (msg === "steam-scrape:exophase:merged") {
    return tUi(
      "main.achgen.exophase.merged",
      {},
      "Downloading Extra Languages: Success.",
    );
  }
  if (msg === "steam-scrape:exophase:duplicates") {
    return tUi(
      "main.achgen.exophase.duplicates",
      {},
      "Language already exists.",
    );
  }
  if (msg.startsWith("rpcs3:exophase:")) {
    // reuse same translations as exophase scrape
    if (msg.includes("start")) {
      return tUi(
        "main.achgen.exophase.start",
        {},
        "Downloading Extra Languages...",
      );
    }
    if (msg.includes("failed")) {
      return tUi(
        "main.achgen.exophase.failed",
        {},
        "Downloading Extra Languages: Failed.",
      );
    }
    if (msg.includes("merged")) {
      return tUi(
        "main.achgen.exophase.merged",
        {},
        "Downloading Extra Languages: Success.",
      );
    }
  }
  if (
    msg === "steam-scrape:exophase:retry" ||
    msg === "steam-scrape:exophase:alt-slug"
  ) {
    return tUi(
      "main.achgen.exophase.retry",
      {},
      "Downloading Extra Languages: Retrying...",
    );
  }
  if (msg.startsWith("steam-schema:request")) {
    return tUi(
      "main.achgen.steam.schema.request",
      {},
      "Requesting Steam schema...",
    );
  }
  if (msg.startsWith("steam-schema:success")) {
    return tUi(
      "main.achgen.steam.schema.success",
      {},
      "Steam schema downloaded.",
    );
  }
  if (msg.startsWith("steam-schema:failed")) {
    return tUi("main.achgen.steam.schema.failed", {}, "Steam schema failed.");
  }
  if (msg.startsWith("steam-schema:empty")) {
    return tUi("main.achgen.steam.schema.empty", {}, "Steam schema empty.");
  }
  if (msg.startsWith("steam-achievements:request")) {
    return tUi(
      "main.achgen.steam.ach.request",
      {},
      "Requesting Steam achievements...",
    );
  }
  if (msg.startsWith("steam-achievements:success")) {
    return tUi(
      "main.achgen.steam.ach.success",
      {},
      "Steam achievements downloaded.",
    );
  }
  if (msg.startsWith("steam-achievements:failed")) {
    return tUi(
      "main.achgen.steam.ach.failed",
      {},
      "Steam achievements failed.",
    );
  }
  if (msg.startsWith("steam-achievements:empty")) {
    return tUi("main.achgen.steam.ach.empty", {}, "Steam achievements empty.");
  }
  if (msg.startsWith("steam-achievements:fallback-schema")) {
    return tUi(
      "main.achgen.steam.ach.fallback",
      {},
      "Using fallback Steam schema.",
    );
  }
  if (msg.includes("(GOG) No Achievements found!")) {
    return tUi("main.achgen.gog.none", {}, "GOG: No achievements found.");
  }
  if (msg.includes("(GOG) Achievements schema done.")) {
    return tUi("main.achgen.gog.done", {}, "GOG: Achievements schema done.");
  }
  if (msg.includes("Epic API failed")) {
    return tUi("main.achgen.epic.failed", {}, "Epic API failed.");
  }
  if (msg.includes("Steam API key loaded")) {
    return tUi("main.achgen.steam.api.loaded", {}, "Steam API key loaded");
  }
  if (msg.includes("Steam API key not found")) {
    return tUi(
      "main.achgen.steam.api.missing",
      {},
      "Steam API key not found. Running in SteamDB/SteamHunters mode. (English only)",
    );
  }
  if (/Achievements schema done/i.test(msg)) {
    return tUi("main.achgen.schema.done", {}, "Achievements schema done.");
  }
  if (
    /Achievements schema skipped/i.test(msg) ||
    /No Achievements found/i.test(msg)
  ) {
    return tUi(
      "main.achgen.schema.empty",
      {},
      "Achievements schema skipped. No achievements found.",
    );
  }
  return msg;
}

const ACHGEN_UI_SUPPRESSED_MESSAGES = new Set([
  "rarity:steam:request",
  "rarity:steam:success",
  "rarity:steam:written",
  "rarity:epic:request",
  "rarity:epic:success",
  "rarity:epic:written",
  "rarity:gog:request",
  "rarity:gog:success",
  "rarity:gog:written",
]);

function shouldSuppressAchgenMessageInUi(message) {
  const msg = String(message || "")
    .trim()
    .replace(/^[\u2705\u2139\u23ed\u23e9\u26a0]\s*/i, "");
  if (!msg) return true;
  return ACHGEN_UI_SUPPRESSED_MESSAGES.has(msg);
}

function pushAchgen(level, message) {
  const rawMsg = String(message || "").trim();
  if (!rawMsg) return;
  const msg = mapAchgenUiMessage(rawMsg);
  const suppressInUi = shouldSuppressAchgenMessageInUi(rawMsg);

  if (!suppressInUi) {
    const payload = {
      type: "achgen:log",
      level,
      message: msg,
      ts: Date.now(),
      rawMessage: rawMsg,
    };
    achgenBuffer.push(payload);
    if (achgenBuffer.length > ACHGEN_BUFFER_MAX) achgenBuffer.shift();

    // broadcast “achgen:log”
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send("achgen:log", payload);
      } catch {}
    }

    const color =
      level === "error" ? "#f44336" : level === "warn" ? "#FFC107" : "#2196f3";
    const suppressNotify =
      msg.startsWith("steam-achievements:request") ||
      msg.startsWith("steam-achievements:success");
    if (!suppressNotify) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed())
            win.webContents.send("notify", { message: msg, color });
        } catch {}
      }
    }
  }

  try {
    const fn =
      level === "error"
        ? originalConsole.error
        : level === "warn"
          ? originalConsole.warn
          : originalConsole.info;
    fn(`${msg}`);
  } catch {}
}

ipcMain.handle("achgen:get-backlog", () => achgenBuffer);

function emitSchemaReady(data, senderWC = null) {
  try {
    if (senderWC && !senderWC.isDestroyed?.())
      senderWC.send("config:schema-ready", data);
  } catch {}
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("config:schema-ready", data);
    } catch {}
  }
}

function notifyWarn(message) {
  originalConsole.warn(message);
  appLogger.warn(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#FFC107" });
  }
}

const infoOnceKeys = new Set();
function infoOnce(key, message) {
  if (infoOnceKeys.has(key)) return;
  infoOnceKeys.add(key);
  notifyInfo(message);
  setTimeout(() => infoOnceKeys.delete(key), 60_000);
}

const warnedOnce = new Set();
function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  notifyWarn(message);
  setTimeout(() => warnedOnce.delete(key), 60_000);
}

const warnedOnceLogOnly = new Set();
function warnOnceLog(key, message) {
  if (warnedOnceLogOnly.has(key)) return;
  warnedOnceLogOnly.add(key);
  originalConsole.warn(message);
  setTimeout(() => warnedOnceLogOnly.delete(key), 60_000);
}

function notifyError(message) {
  originalConsole.error(message);
  appLogger.error(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#f44336" });
  }
}

function notifyInfo(message) {
  originalConsole.info(message);
  appLogger.info(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("notify", { message, color: "#2196f3" });
  }
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function normalizeEmuValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isLumaPlayConfig(config) {
  return (
    normalizePlatform(config?.platform) === "uplay" &&
    normalizeEmuValue(config?.emu) === "lumaplay"
  );
}

function isLumaPlayWatcherEnabled(prefs = null) {
  const source =
    prefs && typeof prefs === "object" ? prefs : readPrefsSafe?.() || {};
  return source?.lumaPlayWatcherEnabled === true;
}

function isProcessNameWatcherEnabled(prefs = null) {
  const source =
    prefs && typeof prefs === "object" ? prefs : readPrefsSafe?.() || {};
  return source?.disableProcessNameWatcher !== true;
}

//Achievements Image
function resolveIconAbsolutePath(configPath, rel) {
  try {
    if (!rel) return ICON_PNG_PATH;
    if (path.isAbsolute(rel)) {
      try {
        if (fs.existsSync(rel)) return rel;
      } catch {}
    }
    if (!isNonEmptyString(configPath)) return ICON_PNG_PATH;
    const base = path.basename(String(rel));
    const candidates = [];

    candidates.push(path.join(configPath, rel));
    candidates.push(path.join(configPath, "achievement_images", base));
    candidates.push(
      path.join(configPath, "steam_settings", "achievement_images", base),
    );
    candidates.push(path.join(configPath, "img", base));
    candidates.push(path.join(configPath, "steam_settings", "img", base));
    candidates.push(path.join(configPath, "images", base));
    candidates.push(path.join(configPath, "steam_settings", "images", base));
    candidates.push(ICON_PNG_PATH);
    candidates.push(ICON_PATH);

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  } catch {}
  return ICON_PNG_PATH;
}

//Config Name Sanitize
function sanitizeConfigName(raw) {
  const s = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "") // Windows-illegal
    .replace(/\s+/g, " ") // multiple spaces
    .trim()
    .replace(/[. ]+$/, ""); // without dot/space at end
  const base = s || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function waitForFileExists(fp, tries = 50, delay = 80) {
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

async function queueXeniaNotificationWhenIconReady(achievement) {
  try {
    const configPath = achievement?.config_path;
    const rel = achievement?.icon;
    if (isNonEmptyString(configPath) && isNonEmptyString(rel)) {
      const iconPath = path.isAbsolute(rel) ? rel : path.join(configPath, rel);
      if (!fs.existsSync(iconPath)) {
        notificationLogger.info("xenia:notify:wait-icon", {
          config: configPath,
          icon: rel,
        });
        const ready = await waitForFileExists(iconPath, 50, 100);
        if (!ready) {
          notificationLogger.info("xenia:notify:icon-timeout", {
            config: configPath,
            icon: rel,
          });
        }
      }
    }
  } catch {}
  queueAchievementNotification(achievement);
}

function registerOverlayShortcut(newShortcut) {
  try {
    if (!newShortcut || typeof newShortcut !== "string") return;

    const interactShortcut =
      global.overlayInteractShortcut ||
      (cachedPreferences && cachedPreferences.overlayInteractShortcut);
    const ownShortcut = normalizeOverlayShortcutAccelerator(newShortcut, {
      allowSingle: false,
    });
    const normalizedInteractShortcut = normalizeOverlayShortcutAccelerator(
      interactShortcut,
      { allowSingle: true },
    );
    const shortcutConflicts = findOverlayShortcutConflicts(newShortcut, {
      allowSingle: false,
      matchMode: "required",
      otherShortcuts: interactShortcut
        ? [
            {
              id: "overlay-interact",
              source: "overlay-interact",
              scope: "user",
              shortcut: interactShortcut,
              allowSingle: true,
              matchMode: "required",
              priority: OVERLAY_SHORTCUT_PRIORITY_INTERACT,
              target: "overlay-interact",
            },
          ]
        : [],
    });
    if (
      shortcutConflicts.conflicts.length ||
      (!shortcutConflicts.parsed &&
        ownShortcut &&
        normalizedInteractShortcut &&
        ownShortcut === normalizedInteractShortcut)
    ) {
      const firstConflict =
        shortcutConflicts.conflicts[0] ||
        createOverlayShortcutConflictSummary(
          {
            normalized: normalizedInteractShortcut,
            keyName: null,
            triggerKey: null,
            matchMode: "required",
          },
          {
            id: "overlay-interact",
            source: "overlay-interact",
            scope: "user",
            shortcut: interactShortcut,
            target: "overlay-interact",
          },
        );
      overlayLogger.warn("overlay:shortcut:user-conflict", {
        shortcut: newShortcut,
        conflictWith: getOverlayShortcutConflictDisplayValue(firstConflict),
        target: firstConflict?.target || firstConflict?.source || null,
        conflicts: shortcutConflicts.conflicts,
      });
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    clearOverlayShortcutRegistration();

    const onFire = () => {
      const onboardingBlocked =
        isBootOnboardingGatePending() || global.bootOnboardingRequired;
      const currentlyPresented = isOverlayEffectivelyPresented();
      overlayLogger.info("overlay:shortcut-trigger", {
        shortcut: newShortcut,
        onboardingBlocked,
        hasWindow: !!overlayWindow && !overlayWindow.isDestroyed(),
        overlayPresented,
        overlayVisible:
          !!overlayWindow &&
          !overlayWindow.isDestroyed() &&
          overlayWindow.isVisible(),
      });
      console.log(
        tUi(
          "main.notify.overlayShortcutPressed",
          { shortcut: newShortcut },
          `Overlay Shortcut Pressed : ${newShortcut}`,
        ),
      );
      if (onboardingBlocked) {
        return;
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayLogger.debug("overlay:present-path", {
          path: "reuse-existing-window",
          nextPresented: !currentlyPresented,
          state: getOverlayWindowLogState(),
        });
        setOverlayPresented(!currentlyPresented);
      } else {
        overlayLogger.debug("overlay:present-path", {
          path: "create-new-window",
          nextPresented: true,
          state: getOverlayWindowLogState(),
        });
        createOverlayWindow(selectedConfig);
      }
    };

    const directResult = tryRegisterDirectOverlayShortcut(
      "overlay-shortcut",
      newShortcut,
      {
        allowSingle: false,
        cooldownMs: OVERLAY_SHORTCUT_REPEAT_COOLDOWN_MS,
        source: "overlay-shortcut",
        onFire,
        getLastTriggeredAt: () => overlayShortcutLastTriggeredAt,
        setLastTriggeredAt: (value) => {
          overlayShortcutLastTriggeredAt = value;
        },
        setListener: (listener) => {
          overlayShortcutKeydownListener = listener;
        },
        setHook: (hook) => {
          overlayShortcutKeydownHook = hook;
        },
        setBinding: (binding) => {
          overlayShortcutDirectBinding = binding;
        },
      },
    );

    if (directResult.ok) {
      registeredOverlayShortcut = newShortcut;
      registeredOverlayShortcutMode = "direct";
      console.log(
        tUi(
          "main.notify.overlayShortcutSaved",
          { shortcut: newShortcut },
          `Overlay shortcut saved: ${newShortcut}`,
        ),
      );
      return;
    }

    if (directResult.reason !== "hook-unavailable") {
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    const candidates = buildElectronAcceleratorCandidates(newShortcut, {
      allowSingle: false,
    });
    const fallbackResult = tryRegisterGlobalShortcutCandidates(
      candidates,
      onFire,
    );
    if (!fallbackResult.ok) {
      overlayLogger.warn("overlay:shortcut:fallback-failed", {
        id: "overlay-shortcut",
        shortcut: newShortcut,
        candidates,
        error: fallbackResult.error?.message || null,
      });
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    overlayLogger.warn("overlay:shortcut:fallback-registered", {
      id: "overlay-shortcut",
      shortcut: newShortcut,
      accelerator: fallbackResult.accelerator,
      candidates,
    });
    registeredOverlayShortcut = fallbackResult.accelerator;
    registeredOverlayShortcutMode = "global";
    console.log(
      tUi(
        "main.notify.overlayShortcutSaved",
        { shortcut: newShortcut },
        `Overlay shortcut saved: ${newShortcut}`,
      ),
    );
  } catch (err) {
    notifyError(
      tUi("main.notify.shortcutSaveFailed", {
        shortcut: newShortcut,
        error: err.message,
      }),
    );
  }
}

function applyOverlayInputMode() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    if (overlayInteractive) {
      overlayWindow.setIgnoreMouseEvents(false);
    } else {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  } catch {}
}

function applyOverlayFocusMode() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    if (overlayWindow.isFocused()) overlayWindow.blur();
    overlayWindow.setFocusable(false);
  } catch {}
}

function isOverlayEffectivelyPresented() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  try {
    return overlayWindow.isVisible();
  } catch {
    return false;
  }
}

function getOverlayWindowLogState() {
  const hasWindow = !!overlayWindow && !overlayWindow.isDestroyed();
  const state = {
    hasWindow,
    overlayPresented,
    overlayInteractive,
  };
  if (!hasWindow) return state;
  try {
    state.windowId = overlayWindow.id;
  } catch {}
  try {
    state.visible = overlayWindow.isVisible();
  } catch {}
  try {
    state.focused = overlayWindow.isFocused();
  } catch {}
  try {
    state.bounds = overlayWindow.getBounds();
  } catch {}
  try {
    if (typeof overlayWindow.isAlwaysOnTop === "function") {
      state.alwaysOnTop = overlayWindow.isAlwaysOnTop();
    }
  } catch {}
  try {
    if (overlayWindow.webContents && !overlayWindow.webContents.isDestroyed()) {
      state.webContentsId = overlayWindow.webContents.id;
      state.webContentsLoading = overlayWindow.webContents.isLoading();
      state.webContentsUrl = overlayWindow.webContents.getURL() || null;
    }
  } catch {}
  return state;
}

function clearOverlayVisibilityAckTimeout() {
  if (overlayVisibilityAckTimer) {
    clearTimeout(overlayVisibilityAckTimer);
    overlayVisibilityAckTimer = null;
  }
  overlayVisibilityAckState = null;
}

function clearOverlayTopmostBoostTimer() {
  if (overlayTopmostBoostTimer) {
    clearTimeout(overlayTopmostBoostTimer);
    overlayTopmostBoostTimer = null;
  }
}

function clearOverlayPendingShowState() {
  overlayPendingVisibleAckShow = false;
  overlayVisibleAckSatisfied = false;
}

function maybeShowOverlayAfterRendererReady(reason = "unknown") {
  if (!overlayPendingVisibleAckShow) return false;
  if (!overlayPresented) return false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  if (!overlayReadyToShow) {
    overlayLogger.debug("overlay:showInactive:deferred", {
      reason,
      waitFor: "ready-to-show",
      state: getOverlayWindowLogState(),
    });
    return false;
  }
  if (!overlayVisibleAckSatisfied) {
    overlayLogger.debug("overlay:showInactive:deferred", {
      reason,
      waitFor: "renderer-ack",
      state: getOverlayWindowLogState(),
    });
    return false;
  }

  let windowVisible = false;
  try {
    windowVisible = overlayWindow.isVisible();
  } catch {}

  clearOverlayPendingShowState();

  try {
    if (!windowVisible) {
      try {
        overlayWindow.setOpacity(0);
      } catch {}
      overlayLogger.debug("overlay:showInactive:attempt", {
        reason,
        state: getOverlayWindowLogState(),
      });
      if (typeof overlayWindow.showInactive === "function") {
        overlayWindow.showInactive();
      } else {
        overlayLogger.debug("overlay:showInactive:unavailable", {
          reason: `${reason}:no-showInactive-api`,
        });
      }
    } else {
      overlayLogger.debug("overlay:showInactive:skipped", {
        reason: `${reason}:window-already-visible`,
      });
    }
  } catch (err) {
    overlayLogger.warn("overlay:present-raise:failed", {
      reason,
      error: err?.message || String(err),
    });
  }

  try {
    overlayWindow.blur();
  } catch {}
  try {
    overlayLogger.debug("overlay:visibility-check:after-showInactive", {
      reason,
      visible: !!overlayWindow.isVisible(),
    });
  } catch {}
  setTimeout(() => {
    overlayLogger.debug("overlay:post-present-state", {
      source: `maybeShowOverlayAfterRendererReady:${reason}`,
      state: getOverlayWindowLogState(),
    });
  }, 75);
  return true;
}

function setOverlayWindowOpacitySafely(value, reason = "unknown") {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const nextOpacity = Math.max(0, Math.min(1, Number(value)));
  try {
    overlayWindow.setOpacity(nextOpacity);
    overlayLogger.debug("overlay:opacity:set", {
      reason,
      opacity: nextOpacity,
      state: getOverlayWindowLogState(),
    });
    return true;
  } catch (err) {
    overlayLogger.debug("overlay:opacity:set-failed", {
      reason,
      opacity: nextOpacity,
      error: err?.message || String(err),
    });
    return false;
  }
}

function armOverlayVisibilityAckTimeout(visible, source) {
  clearOverlayVisibilityAckTimeout();
  overlayVisibilityAckState = {
    visible: !!visible,
    source: String(source || "unknown"),
    startedAt: Date.now(),
  };
  overlayVisibilityAckTimer = setTimeout(() => {
    const elapsedMs = overlayVisibilityAckState?.startedAt
      ? Date.now() - overlayVisibilityAckState.startedAt
      : null;
    overlayLogger.warn("overlay:renderer-ack-timeout", {
      requestedVisible: overlayVisibilityAckState?.visible ?? !!visible,
      source: overlayVisibilityAckState?.source || String(source || "unknown"),
      elapsedMs,
      state: getOverlayWindowLogState(),
    });
    if (
      (overlayVisibilityAckState?.visible ?? !!visible) &&
      overlayPendingVisibleAckShow &&
      overlayPresented
    ) {
      overlayVisibleAckSatisfied = true;
      overlayLogger.warn("overlay:renderer-ack-timeout:fallback-show", {
        source: overlayVisibilityAckState?.source || String(source || "unknown"),
        elapsedMs,
        state: getOverlayWindowLogState(),
      });
      maybeShowOverlayAfterRendererReady(
        `${overlayVisibilityAckState?.source || String(source || "unknown")}:ack-timeout`,
      );
    }
    clearOverlayVisibilityAckTimeout();
  }, OVERLAY_RENDERER_ACK_TIMEOUT_MS);
}

function sendOverlayVisibility(visible, source) {
  const requestedVisible = !!visible;
  const resolvedSource = String(source || "unknown");
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayLogger.warn("overlay:visibility-dispatch:skipped", {
      requestedVisible,
      source: resolvedSource,
      state: getOverlayWindowLogState(),
    });
    return false;
  }
  armOverlayVisibilityAckTimeout(requestedVisible, resolvedSource);
  try {
    overlayLogger.debug("overlay:visibility-dispatch", {
      visible: requestedVisible,
      source: resolvedSource,
      state: getOverlayWindowLogState(),
    });
    overlayWindow.webContents.send("overlay:set-visible", {
      visible: requestedVisible,
      source: resolvedSource,
    });
    return true;
  } catch (err) {
    overlayLogger.warn("overlay:visibility-dispatch:failed", {
      requestedVisible,
      source: resolvedSource,
      error: err?.message || String(err),
      state: getOverlayWindowLogState(),
    });
    clearOverlayVisibilityAckTimeout();
    return false;
  }
}

function reassertOverlayAlwaysOnTop(reason) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const resolvedReason = String(reason || "unknown");
  overlayLastTopmostReassertAt = Date.now();
  let before = null;
  try {
    if (typeof overlayWindow.isAlwaysOnTop === "function") {
      before = overlayWindow.isAlwaysOnTop();
    }
  } catch {}
  try {
    if (before === false) {
      overlayWindow.setAlwaysOnTop(false);
    }
  } catch {}
  try {
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  } catch {}
  try {
    overlayWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
  } catch {}
  let after = null;
  try {
    if (typeof overlayWindow.isAlwaysOnTop === "function") {
      after = overlayWindow.isAlwaysOnTop();
    }
  } catch {}
  overlayLogger.debug("overlay:always-on-top:reasserted", {
    level: "screen-saver",
    reason: resolvedReason,
    before,
    after,
  });
  setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    let verified = null;
    try {
      if (typeof overlayWindow.isAlwaysOnTop === "function") {
        verified = overlayWindow.isAlwaysOnTop();
      }
    } catch {}
    if (verified !== false) {
      overlayLogger.debug("overlay:always-on-top:verify", {
        reason: resolvedReason,
        verified,
      });
      return;
    }
    overlayLogger.warn("overlay:always-on-top:verify-failed", {
      reason: resolvedReason,
      verified,
    });
    try {
      overlayWindow.setAlwaysOnTop(false);
    } catch {}
    try {
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
    } catch {}
    try {
      overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    } catch {}
    let afterRetry = null;
    try {
      if (typeof overlayWindow.isAlwaysOnTop === "function") {
        afterRetry = overlayWindow.isAlwaysOnTop();
      }
    } catch {}
    overlayLogger.debug("overlay:always-on-top:retry", {
      reason: resolvedReason,
      afterRetry,
    });
  }, 50);
}

/*
function boostOverlayTopmost(reason) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const resolvedReason = String(reason || "unknown");
  let before = null;
  try {
    if (typeof overlayWindow.isAlwaysOnTop === "function") {
      before = overlayWindow.isAlwaysOnTop();
    }
  } catch {}
  try {
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
  } catch {}
  try {
    overlayWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });
  } catch {}
  let after = null;
  try {
    if (typeof overlayWindow.isAlwaysOnTop === "function") {
      after = overlayWindow.isAlwaysOnTop();
    }
  } catch {}
  overlayLogger.debug("overlay:always-on-top:boost", {
    level: "screen-saver",
    reason: resolvedReason,
    before,
    after,
  });
  clearOverlayTopmostBoostTimer();
  overlayTopmostBoostTimer = setTimeout(() => {
    overlayTopmostBoostTimer = null;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!overlayPresented) return;
    reassertOverlayAlwaysOnTop(`${resolvedReason}:settle`);
  }, 150);
}
*/

// Overlay focus safety contract (keep this for drag/snap/reposition fallback logic):
// 1) Do not call `overlayWindow.show()` or `overlayWindow.focus()` from move/snap paths.
// 2) Reposition only an already-created overlay via `setPosition`/`setBounds`.
// 3) Keep the overlay non-focusable and rely on existing click-through toggles.
// 4) Avoid aggressive `setAlwaysOnTop` retoggles during movement (z-order churn/focus side effects).
function setOverlayPresented(next) {
  overlayPresented = !!next;
  overlayLogger.info("overlay:presented:set", {
    next: overlayPresented,
    hasWindow: !!overlayWindow && !overlayWindow.isDestroyed(),
    windowVisible:
      !!overlayWindow &&
      !overlayWindow.isDestroyed() &&
      overlayWindow.isVisible(),
  });
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayPresented) {
    // Always start in click-through mode when presenting.
    setOverlayInteractive(false);

    let windowVisible = false;
    let alreadyTopmost = false;
    try {
      windowVisible = overlayWindow.isVisible();
    } catch {}
    try {
      if (typeof overlayWindow.isAlwaysOnTop === "function") {
        alreadyTopmost = overlayWindow.isAlwaysOnTop() === true;
      }
    } catch {}

    // Keep overlay non-focusable even if something outside toggles it.
    if (!windowVisible || !alreadyTopmost) {
      reassertOverlayAlwaysOnTop("setOverlayPresented:true:pre-show");
    } else {
      overlayLogger.debug("overlay:always-on-top:reassert-skipped", {
        reason: "setOverlayPresented:true:already-visible-and-topmost",
      });
    }
    try {
      overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    } catch {}
    try {
      overlayWindow.setSkipTaskbar(true);
    } catch {}
    try {
      overlayWindow.setFocusable(false);
    } catch {}
    if (!windowVisible) {
      setOverlayWindowOpacitySafely(
        0,
        "setOverlayPresented:true:prepare-hidden-show",
      );
    }
    if (!windowVisible) {
      overlayPendingVisibleAckShow = true;
      overlayVisibleAckSatisfied = false;
    } else {
      clearOverlayPendingShowState();
    }
    const dispatched = sendOverlayVisibility(true, "setOverlayPresented:true");
    if (!dispatched && !windowVisible) {
      overlayVisibleAckSatisfied = true;
      maybeShowOverlayAfterRendererReady(
        "setOverlayPresented:true:visibility-dispatch-failed",
      );
    }
    applyOverlayInteractShortcutRegistration();
    applyOverlayKeyboardScrollShortcutRegistration();
    applyOverlayPositionShortcutRegistration();
    logOverlayShortcutRegistrationSummary("overlay:shortcuts-applied", "info", {
      source: "setOverlayPresented:true",
    });
    return;
  }

  // Hide completely + click-through, and unregister shortcuts.
  const clearedShortcuts = summarizeOverlayShortcutRegistrationState();
  setOverlayInteractive(false);
  clearOverlayInteractShortcut();
  clearOverlayKeyboardScrollShortcuts();
  clearOverlayPositionShortcuts();
  overlaySnapCycleIndex = -1;
  stopOverlayGlobalDrag();
  clearOverlayPendingShowState();
  clearOverlayVisibilityAckTimeout();
  try {
    setOverlayWindowOpacitySafely(0, "setOverlayPresented:false:pre-hide");
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } catch {}
  try {
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    }
  } catch {}
  try {
    overlayWindow.setVisibleOnAllWorkspaces(false);
  } catch {}
  try {
    overlayWindow.setAlwaysOnTop(false);
  } catch {}
  try {
    overlayWindow.blur();
  } catch {}
  clearOverlayTopmostBoostTimer();
  overlayLogger.debug("overlay:hide:os-window-hidden", {
    reason: "compatibility-first-hide",
    state: getOverlayWindowLogState(),
  });
  overlayLogger.info("overlay:shortcuts-cleared", {
    ...clearedShortcuts,
    source: "setOverlayPresented:false",
  });
}

function clearOverlayKeyboardScrollShortcuts() {
  clearRegisteredShortcutEntries(registeredOverlayScrollPageUpShortcuts);
  clearRegisteredShortcutEntries(registeredOverlayScrollPageDownShortcuts);
  registeredOverlayScrollPageUpShortcuts = [];
  registeredOverlayScrollPageDownShortcuts = [];
}

function clearOverlayPositionShortcuts() {
  clearRegisteredShortcutEntries(registeredOverlayPositionShortcuts);
  registeredOverlayPositionShortcuts = [];
}

function getOverlayPositionContext() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  let bounds;
  try {
    bounds = overlayWindow.getBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;
  let workArea = null;
  try {
    workArea = screen.getDisplayMatching(bounds)?.workArea || null;
  } catch {}
  if (!workArea) {
    try {
      workArea = screen.getPrimaryDisplay()?.workArea || null;
    } catch {}
  }
  if (!workArea) return null;
  return { bounds, workArea };
}

function clampOverlayPositionToWorkArea(nextX, nextY, bounds, workArea) {
  const width = Math.max(0, Number(bounds?.width) || 0);
  const height = Math.max(0, Number(bounds?.height) || 0);
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  const maxX = Math.round(workArea.x + Math.max(0, workArea.width - width));
  const maxY = Math.round(workArea.y + Math.max(0, workArea.height - height));
  return {
    x: Math.min(Math.max(Math.round(nextX), minX), maxX),
    y: Math.min(Math.max(Math.round(nextY), minY), maxY),
  };
}

function setOverlayPositionClamped(nextX, nextY) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  const ctx = getOverlayPositionContext();
  if (!ctx) return false;
  const { bounds, workArea } = ctx;
  const { x, y } = clampOverlayPositionToWorkArea(
    nextX,
    nextY,
    bounds,
    workArea,
  );
  try {
    stopOverlayGlobalDrag();
    overlayWindow.setPosition(x, y, false);
    applyOverlayFocusMode();
    return true;
  } catch {
    return false;
  }
}

function snapOverlayByFactors(xFactor, yFactor) {
  const ctx = getOverlayPositionContext();
  if (!ctx) return false;
  const { bounds, workArea } = ctx;
  const minX = Math.round(workArea.x);
  const minY = Math.round(workArea.y);
  const maxX = Math.round(
    workArea.x + Math.max(0, workArea.width - Math.max(0, bounds.width || 0)),
  );
  const maxY = Math.round(
    workArea.y + Math.max(0, workArea.height - Math.max(0, bounds.height || 0)),
  );
  const safeX = Math.min(1, Math.max(0, Number(xFactor) || 0));
  const safeY = Math.min(1, Math.max(0, Number(yFactor) || 0));
  const nextX = minX + Math.round((maxX - minX) * safeX);
  const nextY = minY + Math.round((maxY - minY) * safeY);
  return setOverlayPositionClamped(nextX, nextY);
}

function cycleOverlaySnapPreset() {
  if (!OVERLAY_SNAP5_PRESETS.length) return false;
  overlaySnapCycleIndex =
    (overlaySnapCycleIndex + 1) % OVERLAY_SNAP5_PRESETS.length;
  const preset = OVERLAY_SNAP5_PRESETS[overlaySnapCycleIndex];
  if (!preset) return false;
  return snapOverlayByFactors(preset.x, preset.y);
}

function applyOverlayPositionShortcutRegistration() {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayPresented ||
    !overlayWindow.isVisible()
  ) {
    clearOverlayPositionShortcuts();
    return;
  }

  const registerAll = (baseId, accelerators, onFire) => {
    let bindingIndex = 0;
    const uniqueAccelerators = dedupeOverlayShortcutAccelerators(accelerators, {
      allowSingle: false,
      matchMode: "exact",
      source: baseId,
    });
    for (const accelerator of uniqueAccelerators) {
      const bindingId = `${baseId}:${bindingIndex++}`;
      const result = registerOverlayBindingWithFallback({
        id: bindingId,
        shortcut: accelerator,
        allowSingle: false,
        onFire,
        priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
        scope: "builtin",
        source: "overlay-position",
      });
      if (result.ok) registeredOverlayPositionShortcuts.push(result.entry);
    }
  };

  clearOverlayPositionShortcuts();

  OVERLAY_SNAP5_PRESETS.forEach((preset, index) => {
    registerAll(`overlay-position:snap5:${index}`, [preset.accelerator], () => {
      overlaySnapCycleIndex = index;
      snapOverlayByFactors(preset.x, preset.y);
    });
  });

  OVERLAY_SNAP9_NUMPAD_PRESETS.forEach((preset, index) => {
    registerAll(`overlay-position:snap9:${index}`, preset.accelerators, () => {
      snapOverlayByFactors(preset.x, preset.y);
    });
  });

  registerAll("overlay-position:cycle", ["Control+Alt+Shift+M"], () => {
    cycleOverlaySnapPreset();
  });

  registerAll("overlay-position:nudge-left", ["Control+Alt+Shift+Left"], () => {
    const ctx = getOverlayPositionContext();
    if (!ctx) return;
    setOverlayPositionClamped(
      ctx.bounds.x - OVERLAY_NUDGE_STEP_PX,
      ctx.bounds.y,
    );
  });

  registerAll(
    "overlay-position:nudge-right",
    ["Control+Alt+Shift+Right"],
    () => {
      const ctx = getOverlayPositionContext();
      if (!ctx) return;
      setOverlayPositionClamped(
        ctx.bounds.x + OVERLAY_NUDGE_STEP_PX,
        ctx.bounds.y,
      );
    },
  );

  registerAll("overlay-position:nudge-up", ["Control+Alt+Shift+Up"], () => {
    const ctx = getOverlayPositionContext();
    if (!ctx) return;
    setOverlayPositionClamped(
      ctx.bounds.x,
      ctx.bounds.y - OVERLAY_NUDGE_STEP_PX,
    );
  });

  registerAll("overlay-position:nudge-down", ["Control+Alt+Shift+Down"], () => {
    const ctx = getOverlayPositionContext();
    if (!ctx) return;
    setOverlayPositionClamped(
      ctx.bounds.x,
      ctx.bounds.y + OVERLAY_NUDGE_STEP_PX,
    );
  });
}

function applyOverlayKeyboardScrollShortcutRegistration() {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayPresented ||
    !overlayWindow.isVisible()
  ) {
    clearOverlayKeyboardScrollShortcuts();
    return;
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
      clearOverlayKeyboardScrollShortcuts();
      return;
    }
  } catch {}

  const registerAll = (baseId, accelerators, onFire) => {
    const registered = [];
    let bindingIndex = 0;
    const uniqueAccelerators = dedupeOverlayShortcutAccelerators(accelerators, {
      allowSingle: true,
      matchMode: "exact",
      source: baseId,
    });
    for (const accelerator of uniqueAccelerators) {
      const bindingId = `${baseId}:${bindingIndex++}`;
      const result = registerOverlayBindingWithFallback({
        id: bindingId,
        shortcut: accelerator,
        allowSingle: true,
        onFire,
        priority: OVERLAY_SHORTCUT_PRIORITY_SCROLL,
        scope: "builtin",
        source: baseId,
      });
      if (result.ok) registered.push(result.entry);
    }
    return registered;
  };

  clearOverlayKeyboardScrollShortcuts();

  registeredOverlayScrollPageUpShortcuts = registerAll(
    "overlay-scroll-up",
    ["PageUp", "Control+PageUp"],
    () => {
      if (
        !overlayWindow ||
        overlayWindow.isDestroyed() ||
        !overlayPresented ||
        !overlayWindow.isVisible()
      )
        return;
      overlayWindow.webContents.send("overlay:scroll-page", {
        direction: "up",
      });
    },
  );

  registeredOverlayScrollPageDownShortcuts = registerAll(
    "overlay-scroll-down",
    ["PageDown", "Control+PageDown"],
    () => {
      if (
        !overlayWindow ||
        overlayWindow.isDestroyed() ||
        !overlayPresented ||
        !overlayWindow.isVisible()
      )
        return;
      overlayWindow.webContents.send("overlay:scroll-page", {
        direction: "down",
      });
    },
  );
}

function setOverlayInteractive(next) {
  overlayInteractive = !!next;
  if (!overlayInteractive) stopOverlayGlobalDrag();
  applyOverlayInputMode();
  applyOverlayFocusMode();
  applyOverlayKeyboardScrollShortcutRegistration();
  overlayLogger.debug("overlay:interactive:set", {
    next: overlayInteractive,
    presented: overlayPresented,
    visible:
      !!overlayWindow &&
      !overlayWindow.isDestroyed() &&
      overlayWindow.isVisible(),
  });
}

function toggleOverlayInteractive() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!overlayPresented || !overlayWindow.isVisible()) return;
  setOverlayInteractive(!overlayInteractive);
}

function clearOverlayInteractShortcut() {
  if (overlayInteractDirectBinding) {
    overlayLogger.debug("overlay:shortcut:unregistered", {
      id: "overlay-interact",
      normalized: overlayInteractDirectBinding.normalized,
      mode: "direct",
    });
  }
  removeOverlayDirectKeydownListener(
    overlayInteractKeydownHook,
    overlayInteractKeydownListener,
  );
  overlayInteractKeydownListener = null;
  overlayInteractKeydownHook = null;
  overlayInteractDirectBinding = null;
  overlayInteractLastTriggeredAt = 0;
  unregisterOverlayLowLevelBinding("overlay-interact");
  if (
    registeredOverlayInteractShortcutMode === "global" &&
    registeredOverlayInteractShortcut
  ) {
    try {
      globalShortcut.unregister(registeredOverlayInteractShortcut);
    } catch {}
  }
  registeredOverlayInteractShortcut = null;
  registeredOverlayInteractShortcutMode = null;
}

function applyOverlayInteractShortcutRegistration() {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayPresented ||
    !overlayWindow.isVisible()
  ) {
    clearOverlayInteractShortcut();
    return;
  }
  const shortcut =
    global.overlayInteractShortcut ||
    (cachedPreferences && cachedPreferences.overlayInteractShortcut);
  if (!shortcut || typeof shortcut !== "string" || !shortcut.trim()) {
    clearOverlayInteractShortcut();
    return;
  }
  registerOverlayInteractShortcut(shortcut);
}

function normalizeOverlayInteractAccelerator(shortcut) {
  return normalizeOverlayLowLevelAccelerator(shortcut, { allowSingle: true });
}

function registerOverlayInteractShortcut(newShortcut) {
  try {
    if (!newShortcut || typeof newShortcut !== "string") return;

    const accelerator = normalizeOverlayInteractAccelerator(newShortcut);
    if (!accelerator) return;
    const overlayShortcut =
      global.overlayShortcut ||
      (cachedPreferences && cachedPreferences.overlayShortcut);
    const normalizedOverlayShortcut = normalizeOverlayShortcutAccelerator(
      overlayShortcut,
      { allowSingle: false },
    );
    const shortcutConflicts = findOverlayShortcutConflicts(accelerator, {
      allowSingle: true,
      matchMode: "required",
      otherShortcuts: overlayShortcut
        ? [
            {
              id: "overlay-shortcut",
              source: "overlay-shortcut",
              scope: "user",
              shortcut: overlayShortcut,
              allowSingle: false,
              matchMode: "required",
              priority: OVERLAY_SHORTCUT_PRIORITY_TOGGLE,
              target: "overlay-shortcut",
            },
          ]
        : [],
    });
    if (
      shortcutConflicts.conflicts.length ||
      (!shortcutConflicts.parsed &&
        accelerator &&
        normalizedOverlayShortcut &&
        accelerator === normalizedOverlayShortcut)
    ) {
      const firstConflict =
        shortcutConflicts.conflicts[0] ||
        createOverlayShortcutConflictSummary(
          {
            normalized: normalizedOverlayShortcut,
            keyName: null,
            triggerKey: null,
            matchMode: "required",
          },
          {
            id: "overlay-shortcut",
            source: "overlay-shortcut",
            scope: "user",
            shortcut: overlayShortcut,
            target: "overlay-shortcut",
          },
        );
      overlayLogger.warn("overlay:shortcut:user-conflict", {
        shortcut: newShortcut,
        conflictWith: getOverlayShortcutConflictDisplayValue(firstConflict),
        target: firstConflict?.target || firstConflict?.source || null,
        conflicts: shortcutConflicts.conflicts,
      });
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    clearOverlayInteractShortcut();

    const directResult = tryRegisterDirectOverlayShortcut(
      "overlay-interact",
      accelerator,
      {
        allowSingle: true,
        cooldownMs: OVERLAY_SHORTCUT_REPEAT_COOLDOWN_MS,
        source: "overlay-interact",
        onFire: () => {
          toggleOverlayInteractive();
        },
        getLastTriggeredAt: () => overlayInteractLastTriggeredAt,
        setLastTriggeredAt: (value) => {
          overlayInteractLastTriggeredAt = value;
        },
        setListener: (listener) => {
          overlayInteractKeydownListener = listener;
        },
        setHook: (hook) => {
          overlayInteractKeydownHook = hook;
        },
        setBinding: (binding) => {
          overlayInteractDirectBinding = binding;
        },
      },
    );
    if (directResult.ok) {
      registeredOverlayInteractShortcut = accelerator;
      registeredOverlayInteractShortcutMode = "direct";
      return;
    }
    if (directResult.reason !== "hook-unavailable") {
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    const candidates = buildElectronAcceleratorCandidates(accelerator, {
      allowSingle: true,
    });
    const fallbackResult = tryRegisterGlobalShortcutCandidates(
      candidates,
      () => {
        toggleOverlayInteractive();
      },
    );
    if (!fallbackResult.ok) {
      overlayLogger.warn("overlay:shortcut:fallback-failed", {
        id: "overlay-interact",
        shortcut: accelerator,
        candidates,
        error: fallbackResult.error?.message || null,
      });
      notifyError(
        tUi("main.notify.shortcutSaveRejected", { shortcut: newShortcut }),
      );
      return;
    }

    overlayLogger.warn("overlay:shortcut:fallback-registered", {
      id: "overlay-interact",
      shortcut: accelerator,
      accelerator: fallbackResult.accelerator,
      candidates,
    });
    registeredOverlayInteractShortcut = fallbackResult.accelerator;
    registeredOverlayInteractShortcutMode = "global";
  } catch (err) {
    notifyError(
      tUi("main.notify.shortcutSaveFailed", {
        shortcut: newShortcut,
        error: err.message,
      }),
    );
  }
}

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

const UI_CONSOLE_SUPPRESS_PATTERNS = [
  /\bDeprecationWarning\b/i,
  /\[DEP\d{4}\]/i,
  /--trace-deprecation/i,
  /node:internal\/process\/warning/i,
  /fs\.rmdir\(path,\s*\{\s*recursive:\s*true\s*\}\)/i,
];

function shouldSuppressConsoleMessageInUI(msg) {
  if (!msg) return true;
  if (
    msg.startsWith("steam-achievements:request") ||
    msg.startsWith("steam-achievements:success")
  ) {
    return true;
  }
  return UI_CONSOLE_SUPPRESS_PATTERNS.some((rx) => rx.test(msg));
}

function sendConsoleMessageToUI(message, color) {
  const msg = String(message || "").trim();
  if (shouldSuppressConsoleMessageInUI(msg)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed?.() || wc.isCrashed?.()) return;
  // Rate-limit UI notifications to avoid renderer OOM on log storms.
  const now = Date.now();
  if (!sendConsoleMessageToUI._bucket) {
    sendConsoleMessageToUI._bucket = { ts: now, count: 0 };
  }
  const bucket = sendConsoleMessageToUI._bucket;
  if (now - bucket.ts > 2000) {
    bucket.ts = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  if (bucket.count > 15) return;
  try {
    wc.send("notify", { message: msg, color });
  } catch {
    // avoid recursive console error loops
  }
}

console.log = (...args) => {
  originalConsole.log(...args);
  sendConsoleMessageToUI(args.join(" "), "#4CAF50");
};

console.info = (...args) => {
  originalConsole.info(...args);
  sendConsoleMessageToUI(args.join(" "), "#2196F3");
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  sendConsoleMessageToUI(args.join(" "), "#FFC107");
};

console.error = (...args) => {
  originalConsole.error(...args);
  sendConsoleMessageToUI(args.join(" "), "#f44336");
};

if (!fs.existsSync(configsDir)) {
  fs.mkdirSync(configsDir, { recursive: true });
}

// === Watcher on configsDir ===
let configsWatcher = chokidar.watch(configsDir, {
  persistent: true,
  ignoreInitial: true,
  depth: 0,
  awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
});

function broadcastToAll(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch {}
  }
}

function notifyConfigsChanged() {
  broadcastToAll("configs:changed");
}

configsWatcher
  .on("add", (p) => {
    if (p.endsWith(".json")) {
      notifyConfigsChanged();
      queueAutoSelectIndexUpsertFromConfigPath(p);
    }
  })
  .on("unlink", (p) => {
    if (p.endsWith(".json")) {
      notifyConfigsChanged();
      queueAutoSelectIndexRemoveByConfigPath(p);
    }
  })
  .on("change", (p) => {
    if (p.endsWith(".json")) {
      notifyConfigsChanged();
      queueAutoSelectIndexUpsertFromConfigPath(p);
    }
  });

let selectedLanguage = "english";
let selectedUiLanguage = getUiLanguage();
const ACH_TABLE_STATUS_VALUES = new Set(["all", "locked", "unlocked"]);
const ACH_TABLE_SORT_VALUES = new Set(["off", "asc", "desc"]);
let sharedAchievementTableViewState = null;

function normalizeAchievementTableViewState(payload) {
  if (!payload || typeof payload !== "object") return null;
  const status = String(payload.status || "")
    .trim()
    .toLowerCase();
  const nameSort = String(payload.nameSort || "")
    .trim()
    .toLowerCase();
  const timeSort = String(payload.timeSort || "")
    .trim()
    .toLowerCase();
  const raritySort = String(payload.raritySort || "")
    .trim()
    .toLowerCase();

  return {
    status: ACH_TABLE_STATUS_VALUES.has(status) ? status : "all",
    nameSort: ACH_TABLE_SORT_VALUES.has(nameSort) ? nameSort : "off",
    timeSort: ACH_TABLE_SORT_VALUES.has(timeSort) ? timeSort : "off",
    raritySort: ACH_TABLE_SORT_VALUES.has(raritySort) ? raritySort : "off",
  };
}

let manualLaunchInProgress = false;
const manualLaunchPidMap = new Map();
cachedPreferences = ensurePreferencesFile();
if (!cachedPreferences || typeof cachedPreferences !== "object") {
  cachedPreferences = {};
}
try {
  setBlacklistedAppIds(cachedPreferences?.[BLACKLIST_PREF_KEY]);
} catch {}
const fileSteamApiKey = readSteamApiKeyFromFile();
if (fileSteamApiKey && !cachedPreferences.steamApiKey) {
  cachedPreferences.steamApiKey = fileSteamApiKey;
}
if (typeof cachedPreferences.steamApiKey === "string") {
  cachedPreferences.steamApiKey = cachedPreferences.steamApiKey.trim();
  if (!cachedPreferences.steamApiKey) {
    delete cachedPreferences.steamApiKey;
  }
}
if (cachedPreferences && typeof cachedPreferences === "object") {
  if (typeof cachedPreferences.language === "string") {
    selectedLanguage = cachedPreferences.language;
  }
  if (cachedPreferences.preset) {
    selectedPreset = cachedPreferences.preset;
  }
  if (cachedPreferences.position) {
    selectedPosition = cachedPreferences.position;
  }
  if (cachedPreferences.sound) {
    selectedSound = cachedPreferences.sound;
  }
  if (cachedPreferences.notificationScale != null) {
    const n = Number(cachedPreferences.notificationScale);
    if (!Number.isNaN(n) && n > 0) selectedNotificationScale = n;
  }
  if ("disableProgress" in cachedPreferences) {
    global.disableProgress = cachedPreferences.disableProgress === true;
  }
  if ("disablePlaytime" in cachedPreferences) {
    global.disablePlaytime = cachedPreferences.disablePlaytime === true;
  }
  if ("startMaximized" in cachedPreferences) {
    global.startMaximized = !!cachedPreferences.startMaximized;
  }
  if ("startInTray" in cachedPreferences) {
    global.startInTray = !!cachedPreferences.startInTray;
  }
  if ("closeToTray" in cachedPreferences) {
    global.closeToTray = !!cachedPreferences.closeToTray;
  }
}
ensureSteamApiKeyFileFromPrefs();

function applyPreferenceSideEffects(
  patch = {},
  prefsSnapshot = {},
  options = {},
) {
  if (Object.prototype.hasOwnProperty.call(patch, BLACKLIST_PREF_KEY)) {
    try {
      setBlacklistedAppIds(prefsSnapshot?.[BLACKLIST_PREF_KEY]);
    } catch {}
  }
  if ("language" in patch && typeof prefsSnapshot.language === "string") {
    selectedLanguage = prefsSnapshot.language;
  }
  if ("disableProgress" in patch) {
    global.disableProgress = prefsSnapshot.disableProgress === true;
  }
  if ("disablePlaytime" in patch) {
    global.disablePlaytime = prefsSnapshot.disablePlaytime === true;
  }
  if ("startMaximized" in patch) {
    global.startMaximized = !!prefsSnapshot.startMaximized;
  }
  if ("startInTray" in patch) {
    global.startInTray = !!prefsSnapshot.startInTray;
  }
  if ("closeToTray" in patch) {
    global.closeToTray = !!prefsSnapshot.closeToTray;
  }
  if ("preset" in patch) {
    selectedPreset = prefsSnapshot.preset || "default";
  }
  if ("position" in patch) {
    selectedPosition = prefsSnapshot.position || "center-bottom";
  }
  if ("sound" in patch) {
    selectedSound = prefsSnapshot.sound || "mute";
  }
  if ("notificationScale" in patch) {
    const n = Number(prefsSnapshot.notificationScale);
    if (!Number.isNaN(n) && n > 0) selectedNotificationScale = n;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "overlayShortcut")) {
    global.overlayShortcut = patch.overlayShortcut;
    registerOverlayShortcut(patch.overlayShortcut);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "overlayInteractShortcut")) {
    global.overlayInteractShortcut = patch.overlayInteractShortcut;
    applyOverlayInteractShortcutRegistration();
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "forceGlobalOverlayShortcuts")
  ) {
    refreshOverlayInputBackend("preferences:force-global-overlay-shortcuts");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showHiddenDescription")) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay-preferences-updated", {
        showHiddenDescription: prefsSnapshot.showHiddenDescription === true,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lumaPlayWatcherEnabled")) {
    try {
      watchedFoldersApi?.refreshConfigState?.();
    } catch (err) {
      ipcLogger.error("lumaplay:refresh-config-state-failed", {
        error: err?.message || String(err),
      });
    }
    let selectedLumaAppId = "";
    let selectedIsLumaPlay = false;
    try {
      const safeConfig = sanitizeConfigName(selectedConfig || "");
      const cfgPath = safeConfig
        ? path.join(configsDir, `${safeConfig}.json`)
        : "";
      if (cfgPath && fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        selectedIsLumaPlay = isLumaPlayConfig(cfg);
        selectedLumaAppId = String(cfg?.appid || "");
      }
    } catch {}
    const enabled = isLumaPlayWatcherEnabled(prefsSnapshot);
    if (!enabled) {
      try {
        stopActiveLumaPlayRegistryWatcher();
      } catch {}
      if (selectedIsLumaPlay) {
        try {
          monitorAchievementsFile(null);
        } catch {}
        achievementsFilePath = null;
      }
    } else {
      if (selectedIsLumaPlay) {
        achievementsFilePath = `lumaplay:${selectedLumaAppId || "unknown"}`;
        monitorAchievementsFile(achievementsFilePath);
      }
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, "disableProcessNameWatcher")
  ) {
    const processWatcherEnabled = isProcessNameWatcherEnabled(prefsSnapshot);
    try {
      processPoller.setEnabled(processWatcherEnabled);
    } catch {}
    if (!processWatcherEnabled) {
      stopAutoSelectProcessPoller();
      appLogger.info("process-poller:disabled-by-preferences");
    } else {
      appLogger.info("process-poller:enabled-by-preferences");
      scheduleAutoSelectProcessPollerAfterBoot();
    }
  }
  if (options.removeSteamKey === true) {
    removeSteamApiKeyFiles();
  } else if (Object.prototype.hasOwnProperty.call(patch, "steamApiKey")) {
    const trimmed = String(prefsSnapshot.steamApiKey || "").trim();
    if (trimmed) writeSteamApiKeyFile(trimmed);
  }
}

function updatePreferences(patch = {}) {
  const incoming = { ...(patch || {}) };
  let removeSteamKey = false;

  if ("steamApiKeyMasked" in incoming) delete incoming.steamApiKeyMasked;

  if (Object.prototype.hasOwnProperty.call(incoming, "steamApiKey")) {
    const raw = incoming.steamApiKey;
    const trimmed =
      typeof raw === "string" ? raw.trim() : raw ? String(raw).trim() : "";
    if (trimmed) {
      incoming.steamApiKey = trimmed;
    } else {
      removeSteamKey = true;
      delete incoming.steamApiKey;
    }
  }

  try {
    const current = readPrefsSafe();
    const merged = mergeWithDefaultPreferences({
      ...current,
      ...incoming,
    });
    if (removeSteamKey) delete merged.steamApiKey;

    const overlayShortcutValidation =
      validateOverlayShortcutPreferencePair(merged);
    if (overlayShortcutValidation) {
      prefsLogger.warn("preferences:update:overlay-shortcut-rejected", {
        key: overlayShortcutValidation.key,
        reason: overlayShortcutValidation.reason,
        shortcut: overlayShortcutValidation.shortcut,
        conflictWith: overlayShortcutValidation.conflictWith || null,
        conflictSource: overlayShortcutValidation.conflictSource || null,
        resetKey: overlayShortcutValidation.resetKey || null,
      });
      notifyError(
        tUi("main.notify.shortcutSaveRejected", {
          shortcut: overlayShortcutValidation.shortcut,
        }),
      );
      return current;
    }

    const keysSet = new Set([
      ...Object.keys(current || {}),
      ...Object.keys(merged || {}),
    ]);
    const changedKeys = [];
    for (const key of keysSet) {
      if (!deepEqual(current?.[key], merged?.[key])) {
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) {
      return current;
    }

    fs.writeFileSync(preferencesPath, JSON.stringify(merged, null, 2));
    cachedPreferences = { ...merged };
    const effectivePatch = {};
    for (const key of changedKeys) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        effectivePatch[key] = merged[key];
      }
    }
    if (removeSteamKey && !effectivePatch.steamApiKey) {
      effectivePatch.steamApiKey = undefined;
    }
    prefsLogger.info("preferences:update:written", {
      path: preferencesPath,
      keys: changedKeys,
    });
    applyPreferenceSideEffects(effectivePatch, cachedPreferences, {
      removeSteamKey,
    });
    return cachedPreferences;
  } catch (err) {
    notifyError(
      tUi("main.notify.preferences.mergeWriteFailed", { error: err.message }),
    );
    prefsLogger.error("preferences:update:error", { error: err.message });
    throw err;
  }
}

ipcMain.handle("preferences:update", async (_event, newPrefs) => {
  return updatePreferences(newPrefs || {});
});

// Backwards compatibility
ipcMain.handle("save-preferences", async (_event, newPrefs) =>
  updatePreferences(newPrefs || {}),
);

ipcMain.on("set-zoom", (_event, zoomFactor) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const safeZoom = Number(zoomFactor) || 1;
    mainWindowUserZoom = safeZoom;
    applyMainWindowZoomFactor(safeZoom);

    try {
      const updatedPrefs = updatePreferences({ windowZoomFactor: safeZoom });
      cachedPreferences = updatedPrefs;
    } catch (err) {
      notifyError(
        tUi("main.notify.preferences.zoomSaveFailed", { error: err.message }),
      );
    }
  }
});

function getScreenshotRootFolder() {
  const prefs = readPrefsSafe();
  // Default Pictures\Achievements Screenshots
  const fallback = path.join(
    app.getPath("pictures"),
    "Achievements Screenshots",
  );
  const root = prefs.screenshotFolder || fallback;
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    console.warn(
      tUi(
        "main.log.screenshotRootCreateFailed",
        { error: e.message },
        `Cannot create screenshot root folder: ${e.message}`,
      ),
    );
  }
  return root;
}

function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    console.warn(
      tUi(
        "main.log.dirCreateFailed",
        { path: p, error: e.message },
        `Cannot create dir: ${p} ${e.message}`,
      ),
    );
  }
}

function sanitizeFilename(name) {
  return (
    String(name || "achievement")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || "achievement"
  );
}

// --- Achievements schema generator (manual configs) ---
async function runAchievementsGenerator(
  appid,
  schemaBaseDir,
  userDataDir,
  opts = {},
) {
  if (isAppIdBlacklisted(appid)) {
    schemaLogger.warn("schema:skip-blacklisted", { appid });
    throw new Error(`AppID ${appid} is blacklisted. Remove it to continue.`);
  }
  return new Promise((resolve, reject) => {
    ensureSteamApiKeyFileFromPrefs();
    const script = path.join(
      __dirname,
      "utils",
      "generate_achievements_schema.js",
    );
    const logDir = path.join(app.getPath("userData"), "logs");
    try {
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    } catch {}
    const platform =
      typeof opts.platform === "string" && opts.platform.length
        ? opts.platform.toLowerCase()
        : null;
    const schemaLangs = normalizeSchemaLanguageList(opts.langs);
    const args = [
      String(appid),
      "--apps-concurrency=1",
      `--out=${schemaBaseDir}`,
      `--user-data-dir=${userDataDir}`,
    ];
    if (platform) args.push(`--platform=${platform}`);
    if (schemaLangs.length) args.push(`--langs=${schemaLangs.join(",")}`);
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOGGER_DIR: logDir,
        LOGGER_SUPPRESS_CLEAR: "1",
      },
      windowsHide: true,
    });

    // forward logs to UI (same topic as auto-configs)
    const flushLines = (chunk, level) => {
      String(chunk)
        .split(/\r?\n/)
        .forEach((line) => {
          const s = line.trim();
          if (s) pushAchgen(level, s);
        });
    };

    cp.on("message", (msg) => {
      if (!msg || msg.type !== "achgen:log") return;
      const line = `${msg.message || ""}`;
      const lvl = (msg.level || "info").toLowerCase();
      pushAchgen(lvl, line);
    });
    cp.on("error", reject);
    cp.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Code: ${code}`)),
    );
  });
}

async function ensureSchemaForApp(appid, platform = "steam") {
  const appidStr = String(appid || "");
  if (!platform && /[a-f]/i.test(appidStr)) {
    platform = "epic";
  }
  if (!/^[0-9a-fA-F]+$/.test(String(appid || ""))) return null;

  const schemaBase = SCHEMA_ROOT_PATH; // %APPDATA%\Achievements\configs\schema
  const normalizedPlatform = normalizeStoragePlatform(platform);
  const destDir = resolveSchemaDirForPlatform(appid, normalizedPlatform);
  const achJson = path.join(destDir, "achievements.json");
  if (normalizedPlatform === "xenia") {
    if (fs.existsSync(achJson)) {
      return { dir: destDir, existed: true };
    }
    return null;
  }
  const legacyDir = path.join(schemaBase, String(appid));
  const legacyJson = path.join(legacyDir, "achievements.json");

  try {
    if (!fs.existsSync(schemaBase))
      fs.mkdirSync(schemaBase, { recursive: true });
  } catch {}
  // if achievements schema exist
  if (fs.existsSync(achJson)) {
    ipcLogger.info("schema:ensure-exists", {
      appid,
      platform: normalizedPlatform,
      dir: destDir,
    });
    return { dir: destDir, existed: true };
  }
  if (fs.existsSync(legacyJson)) {
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(legacyDir, destDir);
      if (fs.existsSync(achJson)) {
        ipcLogger.info("schema:ensure-migrated-legacy", {
          appid,
          from: legacyDir,
          to: destDir,
        });
        return { dir: destDir, existed: true };
      }
    } catch (err) {
      ipcLogger.warn("schema:legacy-move-failed", {
        appid,
        error: err?.message || String(err),
      });
      return { dir: legacyDir, existed: true };
    }
  }

  for (const altPlatform of SCHEMA_PLATFORM_DIRS) {
    if (altPlatform === normalizedPlatform) continue;
    const altDir = resolveSchemaDirForPlatform(appid, altPlatform);
    if (
      path.normalize(altDir).toLowerCase() ===
      path.normalize(destDir).toLowerCase()
    ) {
      continue;
    }
    const altJson = path.join(altDir, "achievements.json");
    if (!fs.existsSync(altJson)) continue;
    try {
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.renameSync(altDir, destDir);
      if (fs.existsSync(achJson)) {
        ipcLogger.info("schema:ensure-migrated-platform", {
          appid,
          from: altDir,
          to: destDir,
        });
        return { dir: destDir, existed: true };
      }
    } catch (err) {
      ipcLogger.warn("schema:platform-move-failed", {
        appid,
        from: altPlatform,
        to: normalizedPlatform,
        error: err?.message || String(err),
      });
    }
    break;
  }

  try {
    await runAchievementsGenerator(appid, schemaBase, app.getPath("userData"), {
      platform: normalizedPlatform,
      langs: getSchemaLanguagesFromPreferences(),
    });
    if (fs.existsSync(achJson)) {
      ipcLogger.info("schema:ensure-generated", {
        appid,
        platform: normalizedPlatform,
        dir: destDir,
      });
      return { dir: destDir, existed: false };
    }
  } catch (e) {
    warnOnce(`${appid}:fail`, `Generate schema failed: ${e.message}`);
  }
  return null;
}

/* <root>/<gameName>/<displayName>.png (timestamp if exists) */
async function saveFullScreenShot(gameName, achDisplayName) {
  if (!screenshot) throw new Error("screenshot-desktop is not installed");
  const root = getScreenshotRootFolder();
  const gameFolder = path.join(
    root,
    sanitizeFilename(gameName || "Unknown Game"),
  );
  ensureDir(gameFolder);

  let file = path.join(gameFolder, sanitizeFilename(achDisplayName) + ".png");
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    file = path.join(
      gameFolder,
      `${sanitizeFilename(achDisplayName)}_${ts}.png`,
    );
  }

  const buf = await screenshot({ format: "png" }); // full desktop
  fs.writeFileSync(file, buf);
  return file;
}

ipcMain.handle("load-preferences", () => {
  cachedPreferences = readPrefsSafe();
  if (
    typeof cachedPreferences.overlayShortcut === "string" &&
    cachedPreferences.overlayShortcut.trim() &&
    !normalizeOverlayShortcutAccelerator(cachedPreferences.overlayShortcut, {
      allowSingle: false,
    })
  ) {
    cachedPreferences.overlayShortcut = DEFAULT_PREFERENCES.overlayShortcut;
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      cachedPreferences || {},
      "overlayInteractShortcut",
    )
  ) {
    cachedPreferences.overlayInteractShortcut =
      DEFAULT_PREFERENCES.overlayInteractShortcut;
  } else if (
    typeof cachedPreferences.overlayInteractShortcut === "string" &&
    cachedPreferences.overlayInteractShortcut.trim() &&
    !normalizeOverlayInteractAccelerator(
      cachedPreferences.overlayInteractShortcut,
    )
  ) {
    cachedPreferences.overlayInteractShortcut =
      DEFAULT_PREFERENCES.overlayInteractShortcut;
  }
  const overlayShortcutPreferenceValidation =
    validateOverlayShortcutPreferencePair(cachedPreferences);
  if (overlayShortcutPreferenceValidation?.reason === "conflict") {
    const resolvedOverlayShortcutPrefs =
      resolveOverlayShortcutPreferenceConflicts(cachedPreferences);
    cachedPreferences.overlayShortcut =
      resolvedOverlayShortcutPrefs.resolved.overlayShortcut;
    cachedPreferences.overlayInteractShortcut =
      resolvedOverlayShortcutPrefs.resolved.overlayInteractShortcut;
  }
  const fileKey = readSteamApiKeyFromFile();
  if (fileKey && !cachedPreferences.steamApiKey) {
    cachedPreferences.steamApiKey = fileKey;
  }
  if (
    typeof cachedPreferences.steamApiKey === "string" &&
    !cachedPreferences.steamApiKey.trim()
  ) {
    delete cachedPreferences.steamApiKey;
  }
  const safePrefs = { ...cachedPreferences };
  if (safePrefs.steamApiKey) {
    safePrefs.steamApiKeyMasked = maskSteamApiKey(safePrefs.steamApiKey);
    delete safePrefs.steamApiKey;
  } else {
    safePrefs.steamApiKeyMasked = "";
  }
  return safePrefs;
});

ipcMain.handle("blacklist:check", async (_event, appid) => {
  const normalized = normalizeAppIdValue(appid);
  const blacklisted = normalized ? isAppIdBlacklisted(normalized) : false;
  return { appid: normalized, blacklisted };
});

ipcMain.handle("config:get-by-appid", async (_event, appid) => {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return null;
  try {
    const files = fs.readdirSync(configsDir);
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".json")) continue;
      const cfgPath = path.join(configsDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const cfgAppId = normalizeAppIdValue(
          data?.appid || data?.appId || data?.steamAppId,
        );
        if (cfgAppId === normalized) {
          return {
            name: data?.name || path.basename(f, ".json"),
            displayName: data?.displayName || null,
            appid: cfgAppId,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
});

ipcMain.handle("get-sound-files", () => {
  if (!fs.existsSync(userSoundsFolder)) return [];
  const files = fs
    .readdirSync(userSoundsFolder)
    .filter((file) => file.endsWith(".wav"));
  return files;
});

ipcMain.handle("get-sound-path", (_event, fileName) => {
  const fullPath = path.join(app.getPath("userData"), "sounds", fileName);
  return `file://${fullPath.replace(/\\/g, "/")}`;
});

ipcMain.handle("ui:confirm", async (e, { title, message, detail }) => {
  appLogger.info("ui:confirm:request", {
    title: title || "",
    message: message || "",
    hasDetail: !!detail,
  });
  ipcLogger.info("ui:confirm:request", {
    title: title || "",
    message: message || "",
    hasDetail: !!detail,
  });
  if (app.isPackaged && process.platform === "win32") {
    const result = runWindowsConfirm({ title, message });
    if (result !== null) {
      appLogger.info("ui:confirm:powershell-result", { ok: result });
      ipcLogger.info("ui:confirm:powershell-result", { ok: result });
      return result;
    }
    appLogger.warn("ui:confirm:powershell-fallback");
    ipcLogger.warn("ui:confirm:powershell-fallback");
    throw new Error("native-confirm-failed");
  }
  const win = BrowserWindow.fromWebContents(e.sender);
  const baseOptions = {
    type: "question",
    buttons: [
      tUi("main.dialog.confirm.cancel", {}, "Cancel"),
      tUi("main.dialog.confirm.ok", {}, "OK"),
    ],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: title || tUi("main.dialog.confirm.title", {}, "Confirm"),
    message: message || tUi("main.dialog.confirm.message", {}, "Are you sure?"),
    detail: detail || "",
  };
  try {
    const canParent =
      win &&
      !win.isDestroyed() &&
      win.isVisible() &&
      !app.isPackaged &&
      !win.isMinimized();
    const options = canParent ? { ...baseOptions, modal: false } : baseOptions;
    const res = canParent
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    try {
      if (win && !win.isDestroyed()) {
        win.setIgnoreMouseEvents(false);
        if (!win.isVisible()) win.show();
        win.focus();
      }
    } catch {}
    appLogger.info("ui:confirm:dispatch", {
      parent: canParent,
      packaged: app.isPackaged,
    });
    appLogger.info("ui:confirm:response", { ok: res.response === 1 });
    ipcLogger.info("ui:confirm:response", { ok: res.response === 1 });
    return res.response === 1;
  } catch (err) {
    ipcLogger.warn("ui:confirm:failed", {
      error: err?.message || String(err),
    });
    appLogger.error("ui:confirm:failed", {
      error: err?.message || String(err),
    });
    return false;
  }
});

ipcMain.handle("ui:refocus", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, "screen-saver");
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(false);
        win.focus();
      }
    }, 0);
  } catch {}
});

// dashboard visibility & refresh
let dashboardOpen = false;
let pendingDashboardRefresh = false;
let dashboardRefreshTimer = null;

// Platinum tracking for pending delivery and dedupe
const pendingPlatinumByConfig = new Map();

function requestDashboardRefresh() {
  if (!dashboardOpen) {
    pendingDashboardRefresh = true;
    return;
  }
  pendingDashboardRefresh = false;
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    try {
      broadcastToAll("dashboard:refresh");
    } catch {}
  }, 350);
}

ipcMain.handle("dashboard:set-open", (_e, state) => {
  dashboardOpen = !!state;
  try {
    global.dashboardOpen = dashboardOpen;
  } catch {}
  if (dashboardOpen && pendingDashboardRefresh) {
    requestDashboardRefresh();
  }
  return dashboardOpen;
});

ipcMain.handle("dashboard:is-open", () => {
  return dashboardOpen;
});
ipcMain.handle("boot:status", () => ({
  bootDone: global.bootDone === true,
  uiReady: global.bootUiReady === true,
  bootSeeding,
  bootManualSeedComplete: global.bootManualSeedComplete === true,
  bootOnboardingGateOpen: global.bootOnboardingGateOpen !== false,
  bootOnboardingRequired: global.bootOnboardingRequired === true,
}));
ipcMain.handle("app:get-version", () => app.getVersion());
ipcMain.on("boot:overlay-hidden", () => {
  if (global.bootOverlayHidden === true) return;
  global.bootOverlayHidden = true;
  bootOverlayHiddenAt = Date.now();
  appLogger.info("boot:overlay-hidden", { at: bootOverlayHiddenAt });
});

// List existing configs
function listConfigs() {
  const files = fs.readdirSync(configsDir);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(".json", ""));
}

function isRpcs3ConfigName(configName) {
  const safeName = sanitizeConfigName(configName);
  if (!safeName) return false;
  const cfgPath = path.join(configsDir, `${safeName}.json`);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return normalizePlatform(data?.platform) === "rpcs3";
  } catch {
    return false;
  }
}

function isLumaPlayConfigName(configName) {
  const safeName = sanitizeConfigName(configName);
  if (!safeName) return false;
  const cfgPath = path.join(configsDir, `${safeName}.json`);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return isLumaPlayConfig(data);
  } catch {
    return false;
  }
}

function readCacheSilent(configName, platform = "steam") {
  const cachePath = getCachePath(configName, platform);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function mergeRpcs3EarnedTime(snapshot, cached) {
  return mergeEarnedTimeFromCached(snapshot, cached);
}

function mergeEarnedTimeFromCached(snapshot, cached) {
  if (!snapshot || typeof snapshot !== "object") return snapshot || {};
  if (!cached || typeof cached !== "object") return snapshot;
  let changed = false;
  const merged = { ...snapshot };
  for (const [key, entry] of Object.entries(merged)) {
    if (!entry || typeof entry !== "object") continue;
    const cacheEntry = cached[key];
    if (!cacheEntry || typeof cacheEntry !== "object") continue;
    const entryTime = Number(entry.earned_time || 0);
    const cacheTime = Number(cacheEntry.earned_time || 0);
    if (entry.earned && entryTime <= 0 && cacheTime > 0) {
      merged[key] = { ...entry, earned_time: cacheEntry.earned_time };
      changed = true;
    }
  }
  return changed ? merged : snapshot;
}

function ensureXeniaDisplayName(name) {
  const base = String(name || "").trim();
  if (!base) return "Unknown Game (Xenia)";
  return /\(xenia\)\s*$/i.test(base) ? base : `${base} (Xenia)`;
}

function ensureRpcs3DisplayName(name) {
  const base = String(name || "").trim();
  if (!base) return "Unknown Game (RPCS3)";
  return /\(rpcs3\)\s*$/i.test(base) ? base : `${base} (RPCS3)`;
}

// Handler for config saving
ipcMain.handle("saveConfig", async (event, config) => {
  ipcLogger.info("saveConfig:request", {
    name: config?.name || null,
    appid: config?.appid || null,
  });
  try {
    const safeName = sanitizeConfigName(config.name);
    if (!fs.existsSync(configsDir))
      fs.mkdirSync(configsDir, { recursive: true });
    const filePath = path.join(configsDir, `${safeName}.json`);
    let prevConfig = null;
    if (fs.existsSync(filePath)) {
      try {
        prevConfig = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {}
    }

    const exePath = isNonEmptyString(config.executable)
      ? config.executable
      : null;

    const payload = {
      ...prevConfig, // preserve custom fields like platinum
      ...config,
      name: safeName,
      displayName: config.displayName || config.name,
      config_path: isNonEmptyString(config.config_path)
        ? config.config_path
        : null,
      save_path: isNonEmptyString(config.save_path) ? config.save_path : null,
      executable: exePath,
      arguments: isNonEmptyString(config.arguments) ? config.arguments : "",
      process_name: isNonEmptyString(config.process_name)
        ? config.process_name
        : exePath
          ? path.basename(exePath)
          : "",
    };

    const sanitizedAppId = sanitizeAppIdForPlatform(
      payload.appid,
      payload.platform,
    );
    if (!sanitizedAppId) {
      return { success: false, message: tUi("main.message.appidRequired") };
    }
    if (isAppIdBlacklisted(sanitizedAppId)) {
      const message = `AppID ${sanitizedAppId} is blacklisted. Remove it to continue.`;
      ipcLogger.info("saveConfig:blocked-blacklist", {
        appid: sanitizedAppId,
        name: payload?.name || null,
      });
      return { success: false, message, blacklisted: true };
    }
    payload.appid = sanitizedAppId;
    applyConfigPlatformDefaults(payload);
    const prevPlatform = normalizePlatform(prevConfig?.platform) || null;
    let nextPlatform = normalizePlatform(payload.platform) || null;
    if (!nextPlatform && /[a-f]/i.test(String(payload.appid || ""))) {
      nextPlatform = "epic";
    }
    nextPlatform = nextPlatform || "steam";

    const wc = event.sender;

    // 1) Manually selected config_path
    let finalSchemaDir = null;
    if (isNonEmptyString(payload.config_path)) {
      if (isManagedSchemaPath(payload.config_path)) {
        const bySel = findConfigDirFromSelection(
          payload.config_path,
          payload.appid,
          payload.platform,
        );
        if (bySel) {
          finalSchemaDir = bySel;
        }
      } else {
        finalSchemaDir = payload.config_path;
      }
    }

    // 2) Search schema locally
    let needBackground = false;
    if (!finalSchemaDir) {
      const preferredDir = resolveSchemaDirForPlatform(
        payload.appid,
        payload.platform,
      );
      const achPath = path.join(preferredDir, "achievements.json");
      if (
        fs.existsSync(achPath) &&
        looksLikeSchemaArray(readJsonSafe(achPath))
      ) {
        finalSchemaDir = preferredDir;
      } else {
        const legacyDir = path.join(SCHEMA_ROOT_PATH, String(payload.appid));
        const legacyJson = path.join(legacyDir, "achievements.json");
        if (
          fs.existsSync(legacyJson) &&
          looksLikeSchemaArray(readJsonSafe(legacyJson))
        ) {
          try {
            if (legacyDir !== preferredDir) {
              fs.mkdirSync(preferredDir, { recursive: true });
              fs.renameSync(legacyDir, preferredDir);
              finalSchemaDir = preferredDir;
            } else {
              finalSchemaDir = legacyDir;
            }
          } catch {
            finalSchemaDir = legacyDir;
          }
        } else {
          needBackground = true;
        }
      }
    }

    const managesSchemaPath =
      isManagedSchemaPath(payload.config_path) ||
      (!isNonEmptyString(payload.config_path) &&
        isManagedSchemaPath(prevConfig?.config_path));
    if (prevPlatform && prevPlatform !== nextPlatform && managesSchemaPath) {
      ipcLogger.info("config:platform-change", {
        name: payload.name,
        appid: payload.appid,
        from: prevPlatform,
        to: nextPlatform,
      });
      finalSchemaDir = null;
      payload.config_path = null;
      needBackground = true;
    } else if (
      finalSchemaDir &&
      managesSchemaPath &&
      !schemaPathMatchesPlatform(payload.appid, nextPlatform, finalSchemaDir)
    ) {
      finalSchemaDir = null;
      payload.config_path = null;
      needBackground = true;
    }

    if (finalSchemaDir && !needBackground) payload.config_path = finalSchemaDir;

    try {
      const selForSave = isNonEmptyString(config.save_path)
        ? config.save_path
        : isNonEmptyString(config.config_path)
          ? config.config_path
          : payload.config_path;

      if (isNonEmptyString(selForSave) && fs.existsSync(selForSave)) {
        const detectedBase = findSaveBaseFromSelection(
          selForSave,
          payload.appid,
        );
        if (detectedBase) {
          payload.save_path = detectedBase; // ex: <root>/steam_settings
        } else if (!isNonEmptyString(payload.save_path)) {
          payload.save_path = selForSave; // fallback
        }
      }
    } catch {}

    // 3) Create config
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    ipcLogger.info("saveConfig:written", {
      name: payload.name,
      appid: payload.appid,
      filePath,
      savePath: payload.save_path || null,
      schemaDir: finalSchemaDir || null,
      needBackground,
    });
    notifyConfigsChanged();

    // 4) Schema exists
    if (finalSchemaDir && !needBackground) {
      const txt = tUi(
        "main.log.schemaExists",
        { appid: payload.appid },
        `⏭ [${payload.appid}] Achievements schema exists. Skip generating!`,
      );

      const reply = {
        success: true,
        message: tUi("main.message.configSaved"),
        schemaReady: true,
        config_path: finalSchemaDir,
        save_path: payload.save_path || null,
      };

      setTimeout(() => {
        console.log(`${txt}`);
        emitSchemaReady(
          {
            name: payload.name,
            appid: payload.appid,
            config_path: finalSchemaDir,
          },
          wc,
        );
      }, 15);

      ipcLogger.info("saveConfig:success", {
        name: payload.name,
        appid: payload.appid,
        schemaReady: true,
        config_path: finalSchemaDir,
        save_path: payload.save_path || null,
      });
      return reply;
    }

    // 5) Generate Achievements Schema
    if (needBackground) {
      const startTxt = tUi(
        "main.log.schemaGenerateStart",
        { appid: payload.appid },
        `↪ Generate achievements schema for ${payload.appid}...`,
      );

      const reply = {
        success: true,
        message: tUi("main.message.configSavedGenerating"),
        schemaReady: false,
        config_path: null,
        save_path: payload.save_path || null,
      };

      (async () => {
        try {
          const res = await ensureSchemaForApp(payload.appid, payload.platform);
          if (res?.dir) {
            try {
              const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
              if (curr.config_path !== res.dir) {
                curr.config_path = res.dir;
                fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
              }
            } catch (e) {
              notifyError(
                tUi("main.notify.schema.persistConfigPathFailed", {
                  error: e.message,
                }),
              );
            }

            // 2) Schema Done (set new config path)
            emitSchemaReady(
              {
                name: payload.name,
                appid: payload.appid,
                config_path: res.dir,
              },
              wc,
            );
            notifyConfigsChanged();
          } else {
          }
        } catch (e) {
          console.warn(
            `Generate schema failed for ${payload.appid}: ${e.message}`,
          );
          notifyError(
            tUi("main.notify.schema.generateFailed", { error: e.message }),
          );
          ipcLogger.error("saveConfig:schema-generation-failed", {
            appid: payload.appid,
            error: e.message,
          });
        }
      })();
      setTimeout(() => {
        console.log(`${startTxt}`);
      }, 15);
      ipcLogger.info("saveConfig:success", {
        name: payload.name,
        appid: payload.appid,
        schemaReady: false,
        config_path: null,
        save_path: payload.save_path || null,
      });
      return reply;
    }
  } catch (error) {
    ipcLogger.error("saveConfig:error", {
      error: error?.message || String(error),
      name: config?.name || null,
      appid: config?.appid || null,
    });
    return { success: false, message: tUi("main.message.configSaveError") };
  }
});

// Handler for config load
ipcMain.handle("loadConfigs", () => {
  ipcLogger.info("loadConfigs:request");
  const blacklist = new Set(readBlacklistFromPrefs());
  const lang = cachedPreferences?.language || "english";
  const configFiles = fs
    .readdirSync(configsDir)
    .filter((file) => file.endsWith(".json"));
  const configs = configFiles.map((file) => {
    const baseName = path.basename(file, ".json");
    const meta = {
      name: baseName,
      displayName: baseName,
      appid: null,
      blacklisted: false,
    };
    const fullPath = path.join(configsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      let platformNorm = normalizePlatform(raw?.platform);
      const isXenia = platformNorm === "xenia";
      const isRpcs3 = platformNorm === "rpcs3";
      const looksSteamOfficial =
        platformNorm === "steam-official" ||
        (typeof raw?.config_path === "string" &&
          raw.config_path
            .toLowerCase()
            .includes(
              `${path.sep}schema${path.sep}steam-official${path.sep}`.toLowerCase(),
            ));
      meta.platform = platformNorm || null;
      if (raw?.displayName) {
        meta.displayName =
          getSafeLocalizedText(raw.displayName, lang) || raw.name || baseName;
      } else if (raw?.name) {
        meta.displayName = raw.name;
      }
      if (looksSteamOfficial) {
        meta.platform = "steam-official";
      }
      if (isXenia) {
        const desiredDisplay = ensureXeniaDisplayName(
          typeof raw?.displayName === "string"
            ? raw.displayName
            : meta.displayName,
        );
        meta.displayName = desiredDisplay;
        if (raw?.displayName == null || typeof raw.displayName === "string") {
          if (raw.displayName !== desiredDisplay) {
            raw.displayName = desiredDisplay;
            fs.writeFileSync(fullPath, JSON.stringify(raw, null, 2));
          }
        }
      }
      if (isRpcs3) {
        const desiredDisplay = ensureRpcs3DisplayName(
          typeof raw?.displayName === "string"
            ? raw.displayName
            : meta.displayName,
        );
        meta.displayName = desiredDisplay;
        if (raw?.displayName == null || typeof raw.displayName === "string") {
          if (raw.displayName !== desiredDisplay) {
            raw.displayName = desiredDisplay;
            fs.writeFileSync(fullPath, JSON.stringify(raw, null, 2));
          }
        }
      }
      if (raw?.appid) {
        meta.appid = String(raw.appid);
        meta.blacklisted = blacklist.has(meta.appid);
      }
      if (raw?.executable) {
        meta.executable = raw.executable;
      }
      if (raw?.arguments !== undefined) {
        meta.arguments = raw.arguments;
      }
      if (raw?.process_name) {
        meta.process_name = raw.process_name;
      }
    } catch (err) {
      ipcLogger.warn("loadConfigs:parse-failed", {
        file: fullPath,
        error: err?.message || String(err),
      });
    }
    return meta;
  });
  ipcLogger.info("loadConfigs:success", { count: configs.length });
  return configs;
});

// Handler for folder load
ipcMain.handle("selectFolder", async () => {
  ipcLogger.info("selectFolder:request");
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (!result.canceled) {
    const folder = result.filePaths[0];
    ipcLogger.info("selectFolder:success", { folder });
    return folder;
  }
  ipcLogger.info("selectFolder:cancelled");
  return null;
});

// Handler for json load
function resolveAchievementsSchemaPath(config = {}) {
  const cfgDir = isNonEmptyString(config?.config_path)
    ? config.config_path
    : "";
  if (!cfgDir) return "";
  const p1 = path.join(cfgDir, "steam_settings", "achievements.json");
  const p2 = path.join(cfgDir, "achievements.json");
  const p3 =
    config.appid != null
      ? path.join(cfgDir, String(config.appid), "achievements.json")
      : "";
  if (fs.existsSync(p1)) return p1;
  if (fs.existsSync(p2)) return p2;
  if (p3 && fs.existsSync(p3)) return p3;
  return "";
}

function stripAchievementPrefixForRarity(name) {
  if (typeof name !== "string") return name;
  const match = name.match(/Ach_(.+)$/i);
  if (match && match[1]) return match[1];
  return name;
}

function normalizeAchievementNameForRarity(name, shouldStrip = false) {
  if (typeof name !== "string") return name;
  let result = name.trim();
  if (shouldStrip) {
    result = stripAchievementPrefixForRarity(result);
    const match = result.match(/^(.*)_(\d+)$/);
    if (match && match[1] && /[A-Za-z]/.test(match[1])) {
      result = match[2];
    }
  }
  return result;
}

function resolveSteamAppIdForRarity(config = {}) {
  const platform = normalizePlatform(config?.platform) || "steam";
  const localAppId = config?.appid != null ? String(config.appid).trim() : "";
  if (platform === "uplay") {
    let mapping = uplayToSteam.get(localAppId);
    if (!mapping) {
      try {
        hydrateRuntimeMapping(loadRuntimeUplayMap());
        mapping = uplayToSteam.get(localAppId);
      } catch {}
    }
    const steamAppId =
      mapping?.steam_appid != null ? String(mapping.steam_appid).trim() : "";
    return {
      platform,
      steamAppId,
      stripNames: true,
      mapped: !!steamAppId,
      localAppId,
    };
  }
  if (platform === "steam" || platform === "steam-official") {
    return {
      platform,
      steamAppId: localAppId,
      stripNames: false,
      mapped: !!localAppId,
      localAppId,
    };
  }
  return {
    platform,
    steamAppId: "",
    stripNames: false,
    mapped: false,
    localAppId,
  };
}

ipcMain.handle("load-achievements", async (event, configName, options = {}) => {
  const includeRarity = options?.includeRarity !== false;
  ipcLogger.info("load-achievements:request", { configName, includeRarity });
  try {
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const cfgDir = isNonEmptyString(config?.config_path)
      ? config.config_path
      : "";
    if (!cfgDir) {
      event.sender.send("achievements-missing", {
        configName,
        reason: !cfgDir ? "no-config-path" : "no-file",
      });
      ipcLogger.warn("load-achievements:missing", {
        configName,
        reason: !cfgDir ? "no-config-path" : "no-file",
      });
      return { achievements: null, config_path: cfgDir || "" };
    }

    // 1) <cfgDir>/steam_settings/achievements.json
    const p1 = path.join(cfgDir, "steam_settings", "achievements.json");
    // 2) <cfgDir>/achievements.json
    const p2 = path.join(cfgDir, "achievements.json");
    // 3) (opțional) <cfgDir>/<appid>/achievements.json – auto-generated
    const p3 =
      config.appid != null
        ? path.join(cfgDir, String(config.appid), "achievements.json")
        : null;

    let foundPath = null;
    if (fs.existsSync(p1)) foundPath = p1;
    else if (fs.existsSync(p2)) foundPath = p2;
    else if (p3 && fs.existsSync(p3)) foundPath = p3;

    if (!foundPath) {
      event.sender.send("achievements-missing", {
        configName,
        reason: "no-file",
      });
      ipcLogger.warn("load-achievements:missing", {
        configName,
        reason: "no-file",
        config_path: cfgDir,
      });
      return { achievements: null, config_path: cfgDir };
    }

    const configDir = path.dirname(foundPath);
    const achievementsRaw = JSON.parse(fs.readFileSync(foundPath, "utf-8"));
    let achievements = achievementsRaw;
    let rarityPath = path.join(configDir, "achievementpercentages.json");
    let rarityFileExists = false;
    let rarityMatched = 0;
    let raritySource = RARITY_SOURCES.steamGlobal;
    if (includeRarity) {
      let rarityByName = new Map();
      try {
        const rarityInfo = readAchievementPercentagesMap(rarityPath);
        rarityByName =
          rarityInfo?.map instanceof Map ? rarityInfo.map : new Map();
        rarityFileExists = rarityInfo?.fileExists === true;
        if (typeof rarityInfo?.source === "string" && rarityInfo.source) {
          raritySource = rarityInfo.source;
        }
      } catch (err) {
        rarityLogger.warn("rarity:sidecar:read-failed", {
          configName,
          source: raritySource,
          sidecarPath: rarityPath,
          error: err?.message || String(err),
        });
        ipcLogger.warn("load-achievements:rarity-read-failed", {
          configName,
          filePath: rarityPath,
          error: err?.message || String(err),
        });
      }
      const mergedRarity = mergeRarityIntoAchievements(
        achievementsRaw,
        rarityByName,
        {
          source: raritySource,
        },
      );
      achievements = mergedRarity?.achievements;
      rarityMatched = Number(mergedRarity?.matched) || 0;
      if (rarityFileExists) {
        rarityLogger.info("rarity:sidecar:merged", {
          configName,
          source: raritySource,
          sidecarPath: rarityPath,
          matchedCount: rarityMatched,
        });
      }
    } else {
      rarityPath = null;
      raritySource = null;
    }
    ipcLogger.info("load-achievements:success", {
      configName,
      source: foundPath,
      count: Array.isArray(achievements)
        ? achievements.length
        : achievements && typeof achievements === "object"
          ? Object.keys(achievements).length
          : 0,
      includeRarity,
      rarityFile: rarityFileExists,
      rarityMatched,
      rarityPath,
      raritySource,
    });
    return { achievements, config_path: configDir };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      notifyError(
        tUi("main.notify.achievements.readFailed", { error: error.message }),
      );
      ipcLogger.error("load-achievements:error", {
        configName,
        error: error.message,
      });
    }
    return { achievements: null, config_path: "" };
  }
});

ipcMain.handle("load-saved-achievements", async (_event, configName) => {
  ipcLogger.info("load-saved-achievements:request", { configName });
  try {
    const rawName = String(configName || "").trim();
    if (!rawName) {
      ipcLogger.warn("load-saved-achievements:missing-name", { configName });
      return { achievements: {}, save_path: "", error: "configName required" };
    }
    const seedWaitTimedOut = await waitForBootManualSeedBeforeLoad(15000);
    if (seedWaitTimedOut && !bootManualSeedWaitWarned) {
      bootManualSeedWaitWarned = true;
      ipcLogger.warn("load-saved-achievements:seed-wait-timeout", {
        timeoutMs: 15000,
      });
    }
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    if (!fs.existsSync(configPath)) {
      const ready = await waitForFileExists(configPath, 50, 100);
      if (!ready || !fs.existsSync(configPath)) {
        ipcLogger.warn("load-saved-achievements:not-found", {
          configName: safeName,
          configPath,
        });
        return { achievements: {}, save_path: "", error: "config not ready" };
      }
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    const normalizedPlatform = normalizePlatform(config?.platform);
    const cacheFallbackPlatforms = new Set([
      "xenia",
      "steam",
      "uplay",
      "gog",
      "epic",
    ]);
    const getCacheFallback = async () =>
      (await loadPreviousAchievements(configName, normalizedPlatform)) || {};
    const shouldUseCacheFallback = () =>
      cacheFallbackPlatforms.has(normalizedPlatform);

    if (normalizedPlatform === "xenia") {
      const gpdPath = resolveGpdPathForConfig(config);
      if (!gpdPath || !fs.existsSync(gpdPath)) {
        if (shouldUseCacheFallback()) {
          const cached = await getCacheFallback();
          if (cached && Object.keys(cached).length) {
            return {
              achievements: cached,
              save_path: config.save_path || "",
              error: "gpd not found (cached)",
            };
          }
        }
        return {
          achievements: {},
          save_path: config.save_path || "",
          error: "gpd not found",
        };
      }
      try {
        const parsed = parseGpdFile(gpdPath);
        const snapshot = buildSnapshotFromGpd(parsed);
        return {
          achievements: snapshot || {},
          save_path: config.save_path || path.dirname(gpdPath),
        };
      } catch (error) {
        return {
          achievements: {},
          save_path: config.save_path || path.dirname(gpdPath),
          error: error.message,
        };
      }
    }
    if (normalizedPlatform === "rpcs3") {
      const trophyDir = resolveRpcs3TrophyDirForConfig(config);
      const usrPath = resolveTropusrPathForConfig(config);
      if (!trophyDir || !usrPath || !fs.existsSync(usrPath)) {
        return {
          achievements: {},
          save_path: config.save_path || "",
          error: "tropusr not found",
        };
      }
      try {
        const parsed = parseTrophySetDir(trophyDir);
        const snapshot = buildSnapshotFromTrophy(parsed);
        const cached = await loadPreviousAchievements(
          configName,
          normalizedPlatform,
        );
        const merged = mergeRpcs3EarnedTime(snapshot, cached);
        return {
          achievements: merged || snapshot || {},
          save_path: config.save_path || trophyDir,
        };
      } catch (error) {
        return {
          achievements: {},
          save_path: config.save_path || trophyDir,
          error: error.message,
        };
      }
    }
    if (normalizedPlatform === "shadps4") {
      const trophyDir = config.save_path || "";
      const xmlPath = path.join(trophyDir, "Xml", "TROP.XML");
      if (!trophyDir || !fs.existsSync(xmlPath)) {
        return {
          achievements: {},
          save_path: trophyDir,
          error: "trop xml not found",
        };
      }
      try {
        const parsed = require("./utils/shadps4-trophy").parsePs4TrophySetDir(
          trophyDir,
        );
        parsed.appid = config.appid || parsed.appid;
        const snapshot = require("./utils/shadps4-trophy").buildSnapshotFromPs4(
          parsed,
          (await loadPreviousAchievements(configName, normalizedPlatform)) ||
            {},
        );
        return {
          achievements: snapshot || {},
          save_path: trophyDir,
        };
      } catch (error) {
        return {
          achievements: {},
          save_path: trophyDir,
          error: error.message,
        };
      }
    }

    if (isLumaPlayConfig(config)) {
      const cached =
        (await loadPreviousAchievements(configName, normalizedPlatform)) || {};
      if (!isLumaPlayWatcherEnabled()) {
        return {
          achievements: cached || {},
          save_path: config.save_path || "",
        };
      }
      try {
        const parsed = readLumaPlayAchievementsSnapshot({
          appid: String(config?.appid || ""),
          configPath: config?.config_path || "",
          preferredUser: config?.lumaplay_user || config?.lumaplayUser || "",
          preferredKeyPath:
            config?.lumaplay_key_path || config?.lumaplayKeyPath || "",
          previousSnapshot: cached,
        });
        if (parsed?.user && parsed.user !== config?.lumaplay_user) {
          config.lumaplay_user = parsed.user;
          try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          } catch {}
        }
        const snapshot =
          parsed?.snapshot && Object.keys(parsed.snapshot).length
            ? parsed.snapshot
            : cached;
        const merged = mergeEarnedTimeFromCached(snapshot, cached);
        return {
          achievements: merged || snapshot || {},
          save_path: config.save_path || "",
        };
      } catch (error) {
        return {
          achievements: cached || {},
          save_path: config.save_path || "",
          error: error?.message || "lumaplay read failed",
        };
      }
    }

    if (normalizedPlatform === "steam-official") {
      const schemaPath = resolveConfigSchemaPath(config);
      const schemaArr =
        schemaPath && fs.existsSync(schemaPath)
          ? JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
          : [];
      const entries = Array.isArray(schemaArr)
        ? schemaArr
            .map((e) => ({
              api: e?.name || e?.api,
              statId: e?.statId,
              bit: e?.bit,
            }))
            .filter(
              (e) =>
                e.api && Number.isInteger(e.statId) && Number.isInteger(e.bit),
            )
        : [];
      const statsDir = config.save_path || "";
      const cached =
        (await loadPreviousAchievements(
          configName,
          normalizedPlatform,
          statsDir,
        )) || {};
      const userBin =
        statsDir && config.appid
          ? pickLatestUserBin(statsDir, config.appid)
          : null;

      // If we don't have schema entries yet, just surface cached so UI isn't empty.
      if (!entries.length) {
        return { achievements: cached, save_path: statsDir };
      }

      if (userBin && fs.existsSync(userBin)) {
        try {
          const kv = parseSteamKv(fs.readFileSync(userBin));
          const userStats = extractUserStats(kv.data);
          let snapshot = buildSnapshotFromAppcache(entries, userStats);
          // merge with cache to keep any extra metadata (e.g., previously detected times)
          const merged = { ...snapshot };
          for (const [k, v] of Object.entries(cached)) {
            if (!merged[k]) {
              merged[k] = v;
              continue;
            }
            if (
              merged[k].earned &&
              (merged[k].earned_time == null ||
                merged[k].earned_time === undefined) &&
              v.earned_time != null
            ) {
              merged[k].earned_time = v.earned_time;
            }
          }
          snapshot = merged;
          return {
            achievements: snapshot || {},
            save_path: statsDir,
          };
        } catch (error) {
          ipcLogger.warn("load-saved-achievements:steam-appcache-failed", {
            configName,
            error: error.message,
          });
        }
      }
      // Fallback to cache if parsing failed or no user bin yet
      return {
        achievements: cached,
        save_path: statsDir,
      };
    }

    const saveBase = config.save_path;
    const appid = String(config.appid || "");
    const saveJsonPath = resolveSaveFilePath(saveBase, appid);
    const {
      tenokeIni: tenokeIniPath,
      ini: achievementsIniPath,
      ofx: achievementsIniOnlineFixPath,
      bin: achievementsBinPath,
    } = resolveSaveSidecarPaths(saveBase, appid);

    const safeExists = (p) =>
      typeof p === "string" && p.length > 0 && fs.existsSync(p);

    let effectiveSavePath = "";
    if (safeExists(saveJsonPath))
      effectiveSavePath = path.dirname(saveJsonPath);
    else if (safeExists(tenokeIniPath))
      effectiveSavePath = path.dirname(tenokeIniPath);
    else if (safeExists(achievementsIniPath))
      effectiveSavePath = path.dirname(achievementsIniPath);
    else if (safeExists(achievementsIniOnlineFixPath))
      effectiveSavePath = path.dirname(achievementsIniOnlineFixPath);
    else if (safeExists(achievementsBinPath))
      effectiveSavePath = path.dirname(achievementsBinPath);

    const schemaPath = resolveConfigSchemaPath(config);
    const achievements = loadAchievementsFromSaveFile(
      effectiveSavePath || saveBase,
      {},
      {
        configMeta: config,
        fullSchemaPath: schemaPath,
      },
    );

    const hasAchievements =
      achievements && Object.keys(achievements).length > 0;
    if (!hasAchievements && !effectiveSavePath && shouldUseCacheFallback()) {
      const cached = await getCacheFallback();
      if (cached && Object.keys(cached).length) {
        return {
          achievements: cached,
          save_path: effectiveSavePath || saveBase || "",
          error: "save file missing (cached)",
        };
      }
    }

    return {
      achievements: achievements || {},
      save_path: effectiveSavePath || saveBase || "",
    };
  } catch (error) {
    ipcLogger.error("load-saved-achievements:error", {
      configName,
      error: error.message,
    });
    return { achievements: {}, save_path: "", error: error.message };
  }
});

// Handler for config deletion
ipcMain.handle("delete-config", async (_event, payload) => {
  const configName =
    typeof payload === "string" ? payload : payload?.configName;
  const deleteExtras = payload?.deleteExtras === true;
  const deleteSaveFiles = payload?.deleteSaveFiles === true;
  ipcLogger.info("delete-config:request", {
    configName,
    deleteExtras,
    deleteSaveFiles,
  });
  if (!configName || typeof configName !== "string") {
    return { success: false, error: "Config name missing." };
  }
  try {
    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${safe}.json`);
    if (fs.existsSync(configPath)) {
      const needsConfigData = deleteExtras || deleteSaveFiles;
      let configData = null;
      if (needsConfigData) {
        try {
          configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
        } catch (err) {
          ipcLogger.warn("delete-config:parse-failed", {
            configName,
            error: err?.message || String(err),
          });
        }
      }
      const appid = needsConfigData
        ? sanitizeAppId(configData?.appid) ||
          sanitizeAppId(configData?.appId) ||
          sanitizeAppId(configData?.steamAppId) ||
          ""
        : "";
      const platform = needsConfigData
        ? normalizePlatform(configData?.platform) ||
          getPlatformForAppId(appid) ||
          "steam"
        : "steam";
      const savePath =
        needsConfigData && typeof configData?.save_path === "string"
          ? configData.save_path
          : "";

      if (deleteExtras) {
        try {
          const cachePath = getCachePath(configName, platform);
          if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
          const legacyCachePath = path.join(
            cacheDir,
            `${safeName}_achievements_cache.json`,
          );
          if (fs.existsSync(legacyCachePath)) fs.unlinkSync(legacyCachePath);
        } catch (err) {
          ipcLogger.warn("delete-config:cache-delete-failed", {
            configName,
            error: err?.message || String(err),
          });
        }
        if (appid) {
          try {
            const imagesDir = path.join(
              app.getPath("userData"),
              "images",
              platform || "steam",
              String(appid),
            );
            if (fs.existsSync(imagesDir)) {
              fs.rmSync(imagesDir, { recursive: true, force: true });
            }
          } catch (err) {
            ipcLogger.warn("delete-config:images-delete-failed", {
              configName,
              appid,
              error: err?.message || String(err),
            });
          }
        }
        const configPathValue =
          typeof configData?.config_path === "string"
            ? configData.config_path
            : "";
        const canDeleteSchema =
          !configPathValue || isManagedSchemaPath(configPathValue);
        if (canDeleteSchema && appid) {
          try {
            const schemaDir = resolveSchemaDirForPlatform(appid, platform);
            if (fs.existsSync(schemaDir)) {
              fs.rmSync(schemaDir, { recursive: true, force: true });
            }
          } catch (err) {
            ipcLogger.warn("delete-config:schema-delete-failed", {
              configName,
              appid,
              error: err?.message || String(err),
            });
          }
        }
      }
      if (deleteSaveFiles) {
        if (platform === "steam-official") {
          ipcLogger.info("delete-config:save-delete-skip", {
            configName,
            platform,
          });
        } else {
          const deleteFile = (p) => {
            if (!p || typeof p !== "string") return;
            try {
              if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                fs.unlinkSync(p);
                ipcLogger.info("delete-config:save-delete", {
                  configName,
                  path: p,
                });
              }
            } catch (err) {
              ipcLogger.warn("delete-config:save-delete-failed", {
                configName,
                path: p,
                error: err?.message || String(err),
              });
            }
          };
          const deleteDir = (dir) => {
            if (!dir || typeof dir !== "string") return false;
            try {
              if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                fs.rmSync(dir, { recursive: true, force: true });
                ipcLogger.info("delete-config:save-delete-dir", {
                  configName,
                  path: dir,
                });
                return true;
              }
            } catch (err) {
              ipcLogger.warn("delete-config:save-delete-dir-failed", {
                configName,
                path: dir,
                error: err?.message || String(err),
              });
            }
            return false;
          };
          const deleteAllMatching = (dir, matcher) => {
            if (!dir || typeof dir !== "string") return;
            try {
              const entries = fs.readdirSync(dir);
              for (const name of entries) {
                if (matcher(name)) {
                  deleteFile(path.join(dir, name));
                }
              }
            } catch (err) {
              ipcLogger.warn("delete-config:save-scan-failed", {
                configName,
                dir,
                error: err?.message || String(err),
              });
            }
          };

          const appidStr = String(appid || "").trim();
          const saveBase = savePath || "";
          const appidDirs = new Set();
          const addDir = (dir) => {
            if (dir && typeof dir === "string") appidDirs.add(dir);
          };

          if (appidStr && saveBase) {
            const baseLower = saveBase.toLowerCase();
            const appLower = appidStr.toLowerCase();
            addDir(path.join(saveBase, appidStr));
            if (!baseLower.endsWith(`${path.sep}steam_settings`)) {
              addDir(path.join(saveBase, "steam_settings", appidStr));
            }
            if (!baseLower.endsWith(`${path.sep}remote`)) {
              addDir(path.join(saveBase, "remote", appidStr));
            }
            addDir(path.join(saveBase, normalizePlatform(platform), appidStr));
            if (path.basename(baseLower) === appLower) addDir(saveBase);
          }

          if (platform === "rpcs3") {
            const trophyDir = resolveRpcs3TrophyDirForConfig(configData || {});
            if (trophyDir) {
              const base = path.basename(trophyDir).toLowerCase();
              if (appidStr && base === appidStr.toLowerCase()) {
                addDir(trophyDir);
              }
            }
          } else if (platform === "shadps4") {
            const trophyDir =
              typeof configData?.trophy_path === "string" &&
              configData.trophy_path
                ? configData.trophy_path
                : saveBase;
            if (trophyDir) {
              const appDir = path.dirname(path.dirname(trophyDir));
              const base = path.basename(appDir || "").toLowerCase();
              if (appidStr && base === appidStr.toLowerCase()) addDir(appDir);
            }
          }

          let deletedDir = false;
          for (const dir of appidDirs) {
            if (deleteDir(dir)) deletedDir = true;
          }

          if (!deletedDir) {
            if (platform === "rpcs3") {
              const tropusr = resolveTropusrPathForConfig(configData || {});
              deleteFile(tropusr);
            } else if (platform === "shadps4") {
              const trophyDir = saveBase || "";
              if (trophyDir) {
                const xmlDir = path.join(trophyDir, "Xml");
                deleteAllMatching(xmlDir, (n) =>
                  /^trop(_\d{2})?\.xml$/i.test(n),
                );
              }
            } else if (platform === "xenia") {
              const gpd = resolveGpdPathForConfig(configData || {});
              deleteFile(gpd);
            } else if (saveBase) {
              const saveJsonPath = resolveSaveFilePath(saveBase, appid);
              const {
                tenokeIni: tenokeIniPath,
                ini: achievementsIniPath,
                ofx: achievementsIniOnlineFixPath,
                bin: achievementsBinPath,
              } = resolveSaveSidecarPaths(saveBase, appid);
              deleteFile(saveJsonPath);
              deleteFile(tenokeIniPath);
              deleteFile(achievementsIniPath);
              deleteFile(achievementsIniOnlineFixPath);
              deleteFile(achievementsBinPath);
            }
          }
        }
      }
      fs.unlinkSync(configPath);
      pendingMissingAchievementFiles.delete(safeName);
      watchedFoldersApi?.refreshConfigState?.();
      ipcLogger.info("delete-config:success", { configName, configPath });
      return { success: true };
    }
    ipcLogger.warn("delete-config:not-found", { configName, configPath });
    return { success: false, error: "File not found." };
  } catch (error) {
    ipcLogger.error("delete-config:error", {
      configName,
      error: error.message,
    });
    return { success: false, error: error.message };
  }
});

ipcMain.handle("config:blacklist", async (_event, payload = {}) => {
  const rawName = payload.configName || "";
  const safeName = rawName ? sanitizeConfigName(rawName) : null;
  let resolvedAppId = payload.appid ? String(payload.appid) : null;
  const configPath = safeName
    ? path.join(configsDir, `${safeName}.json`)
    : null;
  const removeFlag = payload?.remove === true || payload?.action === "remove";

  ipcLogger.info("config:blacklist:request", {
    configName: safeName || null,
    appid: resolvedAppId || null,
    remove: removeFlag,
  });

  try {
    if (!resolvedAppId && configPath && fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed?.appid) resolvedAppId = String(parsed.appid);
    }
    if (!resolvedAppId) throw new Error("AppID missing");

    const updatedList = removeFlag
      ? removeAppIdFromBlacklist(resolvedAppId)
      : addAppIdToBlacklist(resolvedAppId);

    if (removeFlag) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, resolvedAppId);
      } catch {}
    }

    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", { appids: updatedList });
    } catch {}

    ipcLogger.info("config:blacklist:success", {
      configName: safeName || null,
      appid: resolvedAppId,
      remove: removeFlag,
    });
    return {
      success: true,
      appid: resolvedAppId,
      blacklisted: !removeFlag,
      blacklist: updatedList,
    };
  } catch (err) {
    ipcLogger.error("config:blacklist:error", {
      configName: safeName || null,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Blacklist failed" };
  }
});

ipcMain.handle("blacklist:list", async () => {
  return { appids: readBlacklistFromPrefs() };
});

ipcMain.handle("blacklist:reset", async () => {
  ipcLogger.info("blacklist:reset:request");
  try {
    const before = readBlacklistFromPrefs();
    resetBlacklist();
    if (Array.isArray(before) && before.length) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, before);
      } catch {}
    }
    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", { appids: readBlacklistFromPrefs() });
    } catch {}
    ipcLogger.info("blacklist:reset:success", { count: before?.length || 0 });
    return { success: true, appids: [] };
  } catch (err) {
    ipcLogger.error("blacklist:reset:error", {
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Reset failed" };
  }
});

ipcMain.handle("schema:regenerate", async (event, payload) => {
  try {
    const rawName = payload?.name || payload?.configName || "";
    const safeName = sanitizeConfigName(rawName);
    if (!safeName) {
      return {
        success: false,
        message: tUi("main.message.configNameRequired"),
      };
    }
    const cfgFile = path.join(configsDir, `${safeName}.json`);
    if (!fs.existsSync(cfgFile)) {
      return {
        success: false,
        message: tUi("main.message.configNotFound", { name: safeName }),
      };
    }

    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    } catch (err) {
      ipcLogger.warn("schema:regenerate-config-parse-failed", {
        name: safeName,
        error: err?.message || String(err),
      });
      return { success: false, message: tUi("main.message.configReadFailed") };
    }

    const rawAppId = String(
      payload?.appid ||
        config?.appid ||
        config?.appId ||
        config?.steamAppId ||
        "",
    ).trim();

    let platform =
      normalizePlatform(payload?.platform) ||
      normalizePlatform(config?.platform);
    if (!platform && /[a-f]/i.test(rawAppId)) {
      platform = "epic";
    }
    platform = platform || "steam";
    if (platform === "xenia") {
      return {
        success: false,
        message: tUi("main.message.schemaXeniaRescan"),
      };
    }
    if (platform === "rpcs3") {
      return {
        success: false,
        message: tUi("main.message.schemaRpcs3Rescan"),
      };
    }
    if (platform === "shadps4") {
      return {
        success: false,
        message: tUi(
          "main.message.schemaPs4Rescan",
          {},
          "PS4 schemas are generated from trophy files. Rescan the folder instead.",
        ),
      };
    }
    if (platform === "steam-official") {
      return {
        success: false,
        message: tUi(
          "main.message.schemaSteamOfficialRescan",
          {},
          "Steam (Official) schemas are generated from appcache stats. Rescan the stats folder instead.",
        ),
      };
    }
    const appid = sanitizeAppIdForPlatform(rawAppId, platform);
    if (!appid) {
      return { success: false, message: tUi("main.message.appidRequired") };
    }
    if (isAppIdBlacklisted(appid)) {
      const message = tUi("main.message.appidBlacklisted", { appid });
      ipcLogger.info("schema:regenerate-blocked-blacklist", {
        appid,
        name: safeName,
      });
      return { success: false, message, blacklisted: true };
    }

    const destDir = resolveSchemaDirForPlatform(appid, platform);
    config.appid = appid;
    config.platform = platform;
    config.config_path = destDir;

    try {
      fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
    } catch (err) {
      ipcLogger.warn("schema:regenerate-config-write-failed", {
        name: safeName,
        error: err?.message || String(err),
      });
      return {
        success: false,
        message: tUi("main.message.configUpdateFailed"),
      };
    }

    notifyConfigsChanged();

    try {
      await runAchievementsGenerator(
        appid,
        SCHEMA_ROOT_PATH,
        app.getPath("userData"),
        {
          platform,
          langs: getSchemaLanguagesFromPreferences(),
        },
      );
    } catch (err) {
      ipcLogger.error("schema:regenerate-failed", {
        appid,
        name: safeName,
        error: err?.message || String(err),
      });
      return {
        success: false,
        message: tUi("main.message.schemaGenerateFailed", {
          error: err?.message || err,
        }),
        config_path: destDir,
      };
    }

    const achJson = path.join(destDir, "achievements.json");
    if (fs.existsSync(achJson)) {
      emitSchemaReady({
        name: safeName,
        appid,
        config_path: destDir,
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("refresh-achievements-table", safeName);
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", safeName);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return {
        success: true,
        message: tUi("main.message.schemaRegenerateSuccess"),
        config_path: destDir,
      };
    }

    return {
      success: false,
      message: tUi("main.message.schemaMissing"),
      config_path: destDir,
    };
  } catch (error) {
    ipcLogger.error("schema:regenerate-error", {
      error: error?.message || String(error),
    });
    return {
      success: false,
      message: tUi("main.message.schemaRegenerateFailed"),
    };
  }
});

ipcMain.on("set-animation-duration", (_event, duration) => {
  global.animationDuration = Number(duration);
});

function getPresetAnimationDuration(presetFolder) {
  const presetIndexPath = path.join(presetFolder, "index.html");
  try {
    const content = fs.readFileSync(presetIndexPath, "utf-8");
    const durationMatch = content.match(
      /<meta\s+name="duration"\s+content="(\d+)"\s*\/>/i,
    );
    if (durationMatch && !isNaN(durationMatch[1])) {
      const duration = parseInt(durationMatch[1], 10);
      return duration;
    }
  } catch (error) {
    notifyError(
      tUi("main.notify.animationDuration.readFailed", {
        error: error.message,
      }),
    );
  }
  return 5000; // fallback default
}

function getUserPreferredSound() {
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    return prefs.sound || null;
  } catch (err) {
    console.warn(
      tUi(
        "main.log.soundPreferenceLoadFailed",
        { error: err.message || String(err) },
        `Could not load sound preference: ${err.message || String(err)}`,
      ),
    );
    return null;
  }
}

let tray = null;
let trayMenuWindow = null;
let isQuitting = false;
const ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico") // in installer: resources\icon.ico
  : path.join(__dirname, "icon.ico");
const ICON_PNG_PATH = app.isPackaged
  ? path.join(app.getAppPath(), "assets", "icon.png") // in installer: resources\app.asar\assets\icon.png
  : path.join(__dirname, "assets", "icon.png");
const TRAY_MENU_WIDTH = 180;
const TRAY_MENU_HEIGHT = 170;
const TRAY_MENU_HEIGHT_WITH_RESUME = 220;

function shouldShowTrayResumeStartup() {
  return (
    global.bootOnboardingGateOpen === false ||
    global.bootOnboardingRequired === true
  );
}

function getTrayMenuTargetHeight() {
  return shouldShowTrayResumeStartup()
    ? TRAY_MENU_HEIGHT_WITH_RESUME
    : TRAY_MENU_HEIGHT;
}

function getTrayScaleFactor() {
  try {
    if (tray) {
      const bounds = tray.getBounds();
      return screen.getDisplayNearestPoint(bounds)?.scaleFactor || 1;
    }
  } catch {}
  return screen.getPrimaryDisplay()?.scaleFactor || 1;
}

function applyTrayMenuScale() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  const scale = getTrayScaleFactor();
  const width = Math.max(120, Math.round(TRAY_MENU_WIDTH));
  const height = Math.max(120, Math.round(getTrayMenuTargetHeight()));
  trayMenuWindow.setBounds({ width, height }, false);
  if (!trayMenuWindow.webContents.isDestroyed()) {
    trayMenuWindow.webContents.setZoomFactor(1);
  }
  windowLogger.info("tray:scale", {
    scale,
    width,
    height,
    mode: "linear",
  });
}
function showMainWindowRespectingPrefs() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ forceShow: true });
    return;
  }
  const prefs = readPrefsSafe();
  if (prefs.startMaximized) {
    mainWindow.maximize();
  }
  mainWindow.show();
}

// Zoom model:
// - userZoom: preference from UI dropdown (1.0, 1.25, 1.5, etc).
// - effectiveZoom: value applied to webContents (userZoom / display scale).
// This keeps the main window visually at userZoom while tray/notifications use DPI.
function getDisplayScaleForBounds(bounds) {
  try {
    if (bounds) {
      return screen.getDisplayMatching(bounds)?.scaleFactor || 1;
    }
  } catch {}
  return screen.getPrimaryDisplay()?.scaleFactor || 1;
}

function getMainWindowScaleFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  return getDisplayScaleForBounds(mainWindow.getBounds());
}

function shouldLogZoomChange(prev, next) {
  if (!prev) return true;
  return (
    Math.abs(prev.userZoom - next.userZoom) > ZOOM_LOG_EPS ||
    Math.abs(prev.scaleFactor - next.scaleFactor) > ZOOM_LOG_EPS ||
    Math.abs(prev.effectiveZoom - next.effectiveZoom) > ZOOM_LOG_EPS
  );
}

function logMainZoomState(userZoom, scaleFactor, effectiveZoom) {
  const next = { userZoom, scaleFactor, effectiveZoom };
  if (!shouldLogZoomChange(lastZoomLog, next)) return;
  lastZoomLog = next;
  windowLogger.info("zoom:apply", next);
}

function applyMainWindowZoomFactor(userZoom = mainWindowUserZoom) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = getMainWindowScaleFactor() || 1;
  const safeZoom = Number(userZoom) || 1;
  mainWindowUserZoom = safeZoom;
  const effectiveZoom = safeZoom / scale;
  mainWindow.webContents.setZoomFactor(effectiveZoom);
  logMainZoomState(safeZoom, scale, effectiveZoom);
  mainWindow.webContents.send("zoom-factor-changed", {
    userZoom: safeZoom,
    effectiveZoom,
  });
}

function scheduleMainWindowZoomUpdate() {
  if (mainWindowZoomTimer) clearTimeout(mainWindowZoomTimer);
  mainWindowZoomTimer = setTimeout(() => {
    mainWindowZoomTimer = null;
    applyMainWindowZoomFactor();
  }, 120);
}

function ensureDisplayMetricsListener() {
  if (displayMetricsListenerAdded) return;
  displayMetricsListenerAdded = true;
  screen.on("display-metrics-changed", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
  screen.on("display-added", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
  screen.on("display-removed", () => {
    scheduleMainWindowZoomUpdate();
    applyTrayMenuScale();
  });
}

function createTrayMenuWindow() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    return trayMenuWindow;
  }
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: getTrayMenuTargetHeight(),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: "#282a36",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  trayMenuWindow.setAlwaysOnTop(true, "pop-up-menu");
  trayMenuWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  trayMenuWindow.loadFile("tray-menu.html");
  trayMenuWindow.webContents.once("did-finish-load", () => {
    applyTrayMenuScale();
  });
  trayMenuWindow.on("blur", () => {
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.hide();
    }
  });
  trayMenuWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      trayMenuWindow.hide();
    }
  });
  return trayMenuWindow;
}

function hideTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.hide();
  }
}

function positionTrayMenu() {
  if (!tray || !trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  applyTrayMenuScale();
  const trayBounds = tray.getBounds();
  const winBounds = trayMenuWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const workArea = display.workArea;
  const x = Math.round(
    trayBounds.x + trayBounds.width / 2 - winBounds.width / 2,
  );
  const shouldPlaceBelow = trayBounds.y < workArea.y + workArea.height / 2;
  const y = shouldPlaceBelow
    ? Math.round(trayBounds.y + trayBounds.height)
    : Math.round(trayBounds.y - winBounds.height);
  const clampedX = Math.min(
    Math.max(x, workArea.x),
    workArea.x + workArea.width - winBounds.width,
  );
  const clampedY = Math.min(
    Math.max(y, workArea.y),
    workArea.y + workArea.height - winBounds.height,
  );
  trayMenuWindow.setPosition(clampedX, clampedY, false);
}

function toggleTrayMenu() {
  if (!tray) return;
  const win = createTrayMenuWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  positionTrayMenu();
  win.show();
  win.focus();
}

function openSettingsFromTray() {
  showMainWindowRespectingPrefs();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.send("tray:open-settings");
    });
  } else {
    mainWindow.webContents.send("tray:open-settings");
  }
}

function isBootOnboardingGatePending() {
  return global.bootOnboardingGateOpen === false;
}

function emitBootOnboardingShowToMain(reason = "manual", extra = {}) {
  if (!isBootOnboardingGatePending()) return;
  const payload = {
    required: true,
    recovery: true,
    reason: String(reason || "manual"),
    ...extra,
  };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const sendShow = () => {
    try {
      mainWindow.webContents.send("boot:onboarding:show", payload);
    } catch {}
  };
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", sendShow);
  } else {
    sendShow();
  }
}

function scheduleBootOnboardingUiRecovery(reason = "unknown", extra = {}) {
  if (!isBootOnboardingGatePending()) return;
  if (isQuitting) return;
  if (bootOnboardingRecoveryTimer) return;
  const now = Date.now();
  if (now - bootOnboardingRecoveryLastAt < 1200) return;
  bootOnboardingRecoveryTimer = setTimeout(() => {
    bootOnboardingRecoveryTimer = null;
    bootOnboardingRecoveryLastAt = Date.now();
    appLogger.warn("boot:onboarding:ui-recovery", {
      reason: String(reason || "unknown"),
      ...extra,
    });
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow({ forceShow: true });
    } else {
      try {
        if (mainWindow.webContents?.isCrashed?.()) {
          mainWindow.webContents.reload();
        }
      } catch {}
      showMainWindowRespectingPrefs();
    }
    emitBootOnboardingShowToMain(reason, extra);
  }, 350);
}

async function resumeStartupFromTray() {
  if (!isBootOnboardingGatePending()) {
    return {
      ok: true,
      alreadyOpen: true,
      reason: "already-open",
    };
  }
  if (!watchedFoldersApi?.forceBootOnboardingSkipAll) {
    return {
      ok: false,
      reason: "tray-resume-startup",
      error: "Boot onboarding API unavailable.",
    };
  }
  return await watchedFoldersApi.forceBootOnboardingSkipAll(
    "tray-resume-startup",
  );
}

function createTray() {
  tray = new Tray(ICON_PATH);
  tray.setToolTip("Achievements App");
  createTrayMenuWindow();

  tray.on("click", () => {
    toggleTrayMenu();
  });
  tray.on("right-click", () => {
    toggleTrayMenu();
  });
  tray.on("double-click", () => {
    hideTrayMenu();
    showMainWindowRespectingPrefs();
  });
}

let achievementsFilePath; // achievements.json path
let currentConfigPath;
let previousAchievements = {};
const pendingMissingAchievementFiles = new Map();

function createMainWindow(options = {}) {
  windowLogger.info("create-main-window:start", {
    existing: Boolean(mainWindow && !mainWindow.isDestroyed?.()),
  });
  const forceShowOnLoad = !!options.forceShow;
  let initialZoom = 1;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};
    initialZoom = Number(prefs.windowZoomFactor) || 1;
  } catch {}
  mainWindowUserZoom = initialZoom;
  const initialScale = getDisplayScaleForBounds();
  const initialZoomFactor = initialZoom / (initialScale || 1);
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    frame: false,
    show: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 10 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
      zoomFactor: initialZoomFactor,
    },
  });
  windowLogger.info("create-main-window:browserwindow-created", {
    width: 1000,
    height: 1000,
    zoom: initialZoom,
  });

  const ICON_URL = pathToFileURL(ICON_PNG_PATH).toString();
  mainWindow.loadFile("index.html", { query: { icon: ICON_URL } });
  windowLogger.info("create-main-window:load-file", { icon: ICON_URL });

  mainWindow.webContents.on("did-finish-load", () => {
    windowLogger.info("create-main-window:did-finish-load");
    try {
      const prefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
        : {};
      const shouldStartInTray = !!prefs.startInTray;
      const shouldStartMaximized = !!prefs.startMaximized;
      const zoom = Number(prefs.windowZoomFactor) || 1;
      setTimeout(() => {
        applyMainWindowZoomFactor(zoom);
      }, POST_BOOT_ZOOM_DELAY_MS);
      if (forceShowOnLoad || !shouldStartInTray) {
        if (shouldStartMaximized) {
          mainWindow.maximize();
        }
        mainWindow.show();
      }
    } catch (e) {
      setTimeout(() => {
        applyMainWindowZoomFactor(1);
      }, POST_BOOT_ZOOM_DELAY_MS);
      mainWindow.show();
    }
    windowLogger.info("create-main-window:visible", {
      maximized: mainWindow.isMaximized(),
    });
    mainWindow.webContents.send(
      "window-state-change",
      mainWindow.isMaximized(),
    );
  });
  global.mainWindow = mainWindow;

  // Track window state changes
  mainWindow.on("maximize", () => {
    windowLogger.info("create-main-window:maximize");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", true);
    }
  });

  mainWindow.on("unmaximize", () => {
    windowLogger.info("create-main-window:unmaximize");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-state-change", false);
    }
  });

  mainWindow.on("enter-full-screen", () => {
    windowLogger.info("create-main-window:enter-full-screen");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-fullscreen-change", true);
    }
  });

  mainWindow.on("leave-full-screen", () => {
    windowLogger.info("create-main-window:leave-full-screen");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("window-fullscreen-change", false);
    }
  });

  const refreshOverlayKeyboardScrollShortcuts = () => {
    try {
      applyOverlayKeyboardScrollShortcutRegistration();
    } catch {}
  };
  mainWindow.on("focus", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("blur", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("minimize", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("restore", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("show", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("hide", refreshOverlayKeyboardScrollShortcuts);
  mainWindow.on("unresponsive", () => {
    windowLogger.warn("create-main-window:unresponsive");
    scheduleBootOnboardingUiRecovery("main-window-unresponsive", {
      source: "mainWindow",
    });
  });

  mainWindow.on("move", () => scheduleMainWindowZoomUpdate());
  mainWindow.on("resize", () => scheduleMainWindowZoomUpdate());
  ensureDisplayMetricsListener();

  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    const shouldCloseToTray =
      cachedPreferences?.closeToTray === true || global.closeToTray === true;
    if (shouldCloseToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    windowLogger.info("create-main-window:closed");
    if (mainWindowZoomTimer) {
      clearTimeout(mainWindowZoomTimer);
      mainWindowZoomTimer = null;
    }
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      trayMenuWindow.destroy();
    }
    trayMenuWindow = null;
    mainWindow = null;
  });
}

function getPresetDimensions(presetFolder) {
  const presetIndexPath = path.join(presetFolder, "index.html");
  try {
    const content = fs.readFileSync(presetIndexPath, "utf-8");
    const metaRegex =
      /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i;
    const match = content.match(metaRegex);
    if (match) {
      return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
  } catch (error) {
    notifyError(tUi("main.notify.preset.readFailed", { error: error.message }));
  }
  // Default values if not defined
  return { width: 400, height: 200 };
}

function normalizeNotificationScale(rawScale) {
  const scale = Number(rawScale);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const displayScale = screen.getPrimaryDisplay()?.scaleFactor || 1;
  const effectiveScale = safeScale * displayScale;
  return { scale: safeScale, displayScale, effectiveScale };
}

function createNotificationWindow(message) {
  const preset = message.preset || "default";
  const { presetFolder } = resolveNotificationPresetFolder(preset);

  const presetHtml = path.join(presetFolder, "index.html");
  const position = message.position || "center-bottom";
  const scaleInfo = normalizeNotificationScale(message.scale);
  const scale = scaleInfo.scale;
  windowLogger.info("create-notification-window:start", {
    preset,
    position,
    scale,
  });

  const { width: windowWidth, height: windowHeight } =
    getPresetDimensions(presetFolder);

  // Apply scaling to window dimensions to prevent content overflow
  // at higher scale factors by increasing the window size proportionally
  const scaledWidth = Math.ceil(windowWidth * (scale > 1 ? scale : 1));
  const scaledHeight = Math.ceil(windowHeight * (scale > 1 ? scale : 1));

  const {
    x: ax,
    y: ay,
    width: aw,
    height: ah,
  } = screen.getPrimaryDisplay().workArea;
  const gapX = Math.round(16 * scale);
  const gapY = Math.round(0 * scale);

  let x = 0,
    y = 0;

  switch (position) {
    case "center-top":
      x = ax + Math.floor((aw - scaledWidth) / 2);
      y = ay + gapY;
      break;

    case "top-right":
      x = ax + aw - scaledWidth - gapX;
      y = ay + gapY;
      break;

    case "bottom-right":
      x = ax + aw - scaledWidth - gapX;
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;

    case "top-left":
      x = ax + gapX;
      y = ay + gapY;
      break;

    case "bottom-left":
      x = ax + gapX;
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;

    case "center-bottom":
    default:
      x = ax + Math.floor((aw - scaledWidth) / 2);
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;
  }

  const notificationWindow = new BrowserWindow({
    width: scaledWidth,
    height: scaledHeight,
    x,
    y,
    transparent: true,
    frame: false,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: "notification",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  notificationWindow.setAlwaysOnTop(true, "screen-saver");
  notificationWindow.setVisibleOnAllWorkspaces(true);
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(false);
  notificationWindow.setIgnoreMouseEvents(true, { forward: true });
  notificationWindow.loadFile(presetHtml);
  notificationWindow.showInactive();
  windowLogger.info("create-notification-window:load-file", {
    presetHtml,
  });

  notificationWindow.webContents.on("did-finish-load", async () => {
    const iconPathToSend =
      message.iconPath ||
      (message.icon ? path.join(message.config_path, message.icon) : "");
    const durationMs = Number(message?.durationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
      try {
        await notificationWindow.webContents.executeJavaScript(
          `(function(){const meta=document.querySelector('meta[name="duration"]');if(meta){meta.content='${Math.round(
            durationMs,
          )}';}})();`,
          true,
        );
      } catch (err) {
        windowLogger.warn(
          "create-notification-window:duration-override-failed",
          {
            error: err?.message || String(err),
          },
        );
      }
    }
    notificationWindow.webContents.send("show-notification", {
      displayName: message.displayName,
      description: message.description,
      iconPath: iconPathToSend,
      scale,
    });
  });

  return notificationWindow;
}

// Legacy direct-notification channel.
// Current app flows (runtime watcher + test button) use queue-* notifications,
// so this path is not hit in normal usage in the current version.
ipcMain.on("show-notification", async (_event, achievement) => {
  const configName =
    achievement?.configName ||
    achievement?.config_name ||
    selectedConfig ||
    null;
  const achKey =
    achievement?.name ||
    (typeof achievement?.displayName === "string"
      ? achievement.displayName
      : null);
  if (configName && achKey) {
    const prev =
      (await loadPreviousAchievements(
        configName,
        normalizePlatform(payload?.platform) || "steam",
        payload?.save_path || "",
      )) || {};
    const prevEntry = prev[achKey];
    const incomingProg = Number(achievement.progress);
    const prevProg = Number(prevEntry?.progress);
    const prevMax = Number(prevEntry?.max_progress);
    const maxProg = Number(achievement.max_progress);
    if (prevEntry?.earned === true) return;
    if (
      Number.isFinite(incomingProg) &&
      Number.isFinite(prevProg) &&
      incomingProg <= prevProg &&
      (Number.isNaN(maxProg) || maxProg === prevMax)
    ) {
      return;
    }
  }

  const displayName = getSafeLocalizedText(
    achievement.displayName,
    selectedLanguage,
  );
  const descriptionText = getSafeLocalizedText(
    achievement.description,
    selectedLanguage,
  );

  if (displayName && descriptionText) {
    const notificationData = {
      displayName,
      description: descriptionText,
      icon: achievement.icon,
      icon_gray: achievement.icon_gray || achievement.icongray,
      config_path: achievement.config_path,
      preset: achievement.preset,
      position: achievement.position,
      sound: achievement.sound,
    };

    queueAchievementNotification(notificationData);

    const achName = achievement.name;
    if (achName) {
      if (!previousAchievements) previousAchievements = {};
      previousAchievements[achName] = {
        earned: true,
        progress: achievement.progress || undefined,
        max_progress: achievement.max_progress || undefined,
        earned_time: Date.now(),
      };
      if (selectedConfig) {
        const plat = normalizePlatform(achievement?.platform) || "steam";
        savePreviousAchievements(selectedConfig, previousAchievements, plat);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("refresh-achievements-table", selectedConfig);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", {
        language: selectedLanguage,
        uiLanguage: selectedUiLanguage,
      });
    }
  } else {
    notifyError(tUi("main.notify.achievement.syntaxInvalid"));
  }
});

// New Image Windows
// Return path to image if exists locally
ipcMain.handle("checkLocalGameImage", async (_event, appid, platformArg) => {
  const platform = normalizePlatform(platformArg) || getPlatformForAppId(appid);
  ipcLogger.info("checkLocalGameImage:request", { appid, platform });
  const baseDir = path.join(app.getPath("userData"), "images");
  const newPath = path.join(
    baseDir,
    platform || "steam",
    `${appid}`,
    `${appid}.jpg`,
  );
  const legacyPath = path.join(baseDir, `${appid}.jpg`);
  try {
    await fs.promises.access(newPath, fs.constants.F_OK);
    ipcLogger.info("checkLocalGameImage:hit", {
      appid,
      platform,
      imagePath: newPath,
    });
    return newPath;
  } catch {}
  try {
    await fs.promises.access(legacyPath, fs.constants.F_OK);
    ipcLogger.info("checkLocalGameImage:legacy-hit", {
      appid,
      platform,
      imagePath: legacyPath,
    });
    return legacyPath;
  } catch {}
  ipcLogger.info("checkLocalGameImage:miss", { appid, platform });
  return null;
});

// Save image locally from renderer
ipcMain.handle("saveGameImage", async (_event, appid, buffer, platformArg) => {
  const platform = normalizePlatform(platformArg) || getPlatformForAppId(appid);
  ipcLogger.info("saveGameImage:request", { appid, platform });
  try {
    const imageDir = path.join(
      app.getPath("userData"),
      "images",
      platform || "steam",
      String(appid),
    );
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    const fullPath = path.join(imageDir, `${appid}.jpg`);
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    broadcastToAll("update-image", { appid: String(appid), platform });
    return { success: true, path: fullPath };
  } catch (err) {
    notifyError(tUi("main.notify.image.saveFailed", { error: err.message }));
    return { success: false, error: err.message };
  }
});

// Add new IPC handler for test achievements that doesn't require a config
ipcMain.on("show-test-notification", (event, options) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;

  const notificationData = {
    displayName: "This is a testing achievement notification",
    description: "This is a testing achievement notification for this app",
    icon: ICON_PNG_PATH, // Use app icon
    icon_gray: ICON_PNG_PATH, // Use app icon
    config_path: baseDir, // Use app's directory
    preset: options.preset || "default",
    position: options.position || "center-bottom",
    sound: options.sound || "mute",
    scale: parseFloat(
      options.scale != null
        ? options.scale
        : prefs.notificationScale != null
          ? prefs.notificationScale
          : 1,
    ),
    skipScreenshot: true,
    isTest: true,
  };

  queueAchievementNotification(notificationData);
});

// Add new IPC handler for Platinum Achievement
const platinumDedup = new Set();

function markConfigPlatinumFlag(configName) {
  const safe = configName ? sanitizeConfigName(configName) : "";
  if (!safe) return false;
  const cfgPath = path.join(configsDir, `${safe}.json`);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (data.platinum === true) return false; // already flagged
    data.platinum = true;
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function handlePlatinumComplete({
  configName,
  appid,
  savePath,
  configPath,
  isActive = false,
}) {
  const dedupKey =
    (configName ? sanitizeConfigName(configName) : "") ||
    (appid ? String(appid) : "") ||
    (configPath ? path.basename(configPath) : "");
  if (dedupKey) {
    if (platinumDedup.has(dedupKey)) return;
    platinumDedup.add(dedupKey);
  }

  const prefs = cachedPreferences || {};
  if (prefs.disablePlatinum) return;

  const preset = prefs.platinumPreset || "default";
  const position = prefs.platinumPosition || "center-bottom";
  const sound = prefs.platinumSound || "mute";
  const scale = Number(prefs.notificationScale) || 1;
  const safeName = configName ? sanitizeConfigName(configName) : "";

  const message = {
    displayName: tUi("main.notify.platinumCompleteTitle", {}, "100% Completed"),
    description: tUi(
      "main.notify.platinumCompleteDescription",
      {},
      "You've unlocked all achievements!",
    ),
    preset,
    position,
    sound,
    scale,
    config_path: configPath || null,
    save_path: savePath || null,
    configName: configName || null,
    appid: appid ? String(appid) : null,
    __isPlatinum: true,
  };

  if (isActive) {
    // Mark flag but defer popup until queue is idle
    markConfigPlatinumFlag(configName);
    const key =
      safeName ||
      (appid ? String(appid) : "") ||
      (configPath ? path.basename(configPath) : "");
    if (key) {
      pendingPlatinumByConfig.set(key, message);
    }
    flushPendingPlatinum();
    return;
  }

  queuePlatinumAfterCurrent(message);
}

ipcMain.handle("load-presets", async () => {
  if (!fs.existsSync(userPresetsFolder)) return [];

  try {
    const defaultPresetRoots = getPresetCategoryRoots(
      userPresetsFolder,
      "default",
    );
    const userPresetRoots = getPresetCategoryRoots(userPresetsFolder, "users");

    const listPresetDirs = (roots, options = {}) => {
      const out = [];
      const seen = new Set();
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const dirs = fs
          .readdirSync(root, { withFileTypes: true })
          .filter((dirent) => dirent.isDirectory())
          .map((dirent) => dirent.name)
          .filter((name) => {
            const value = String(name || "").toLowerCase();
            if (options.excludeProgress && value === "progress") return false;
            return true;
          });
        for (const name of dirs) {
          const key = String(name || "").toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(name);
        }
      }
      return out;
    };

    const defaultPresets = listPresetDirs(defaultPresetRoots);
    const userPresets = listPresetDirs(userPresetRoots, {
      excludeProgress: true,
    });

    if (defaultPresets.length || userPresets.length) {
      return {
        defaultPresets,
        userPresets,
        scalable: defaultPresets,
        nonScalable: userPresets,
        isStructured: true,
      };
    }

    const dirs = fs
      .readdirSync(userPresetsFolder, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    const flatDirs = dirs.filter(
      (dir) =>
        dir !== PRESET_FOLDER_DEFAULT &&
        dir !== PRESET_FOLDER_USERS &&
        dir !== PRESET_FOLDER_DEFAULT_LEGACY &&
        dir !== PRESET_FOLDER_USERS_LEGACY,
    );

    return flatDirs;
  } catch (error) {
    notifyError(
      tUi("main.notify.presets.readFailed", { error: error.message }),
    );
    return [];
  }
});

const earnedNotificationQueue = [];
let isNotificationShowing = false;
const progressNotificationQueue = [];
let isProgressShowing = false;
let pendingPlatinumNotification = null;
let platinumAwaitingNormal = false;
let platinumFallbackTimer = null;
const pendingNotificationScreenshots = new Map();

function computeNotificationScreenshotFallbackDelay(durationMs) {
  const safeDuration =
    Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
      ? Number(durationMs)
      : 4000;
  return Math.max(450, Math.min(1600, Math.round(safeDuration * 0.35)));
}

function clearPendingNotificationScreenshot(webContentsId) {
  const state = pendingNotificationScreenshots.get(webContentsId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  pendingNotificationScreenshots.delete(webContentsId);
}

function armPendingNotificationScreenshot(
  notificationWindow,
  doShot,
  durationMs,
) {
  if (!notificationWindow || notificationWindow.isDestroyed()) return;
  const webContentsId = notificationWindow.webContents.id;
  clearPendingNotificationScreenshot(webContentsId);

  const state = {
    fired: false,
    timer: null,
    run: async (reason) => {
      if (state.fired) return;
      state.fired = true;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      pendingNotificationScreenshots.delete(webContentsId);
      notificationLogger.info("notification:screenshot-trigger", {
        reason,
        webContentsId,
      });
      await doShot();
    },
  };

  state.timer = setTimeout(() => {
    void state.run("fallback-timeout");
  }, computeNotificationScreenshotFallbackDelay(durationMs));

  pendingNotificationScreenshots.set(webContentsId, state);
}

function queueAchievementNotification(achievement) {
  const prefs = cachedPreferences || {};
  const preferredScale =
    achievement.scale != null
      ? achievement.scale
      : prefs.notificationScale != null
        ? prefs.notificationScale
        : 1;
  achievement.scale = preferredScale;
  const lang = selectedLanguage || "english";

  const displayName = getSafeLocalizedText(achievement.displayName, lang);
  const description = getSafeLocalizedText(achievement.description, lang);

  const resolvedPreset =
    achievement.preset || selectedPreset || prefs.preset || "default";
  const resolvedPosition =
    achievement.position ||
    selectedPosition ||
    prefs.position ||
    "center-bottom";
  const resolvedSound =
    achievement.sound || selectedSound || prefs.sound || "mute";
  const resolvedSkipScreenshot =
    achievement.skipScreenshot === true
      ? true
      : prefs.disableAchievementScreenshot === true;

  const notificationData = {
    displayName: displayName || "",
    description: description || "",
    icon: achievement.icon,
    icon_gray: achievement.icon_gray || achievement.icongray,
    config_path: achievement.config_path,
    preset: resolvedPreset,
    position: resolvedPosition,
    sound: resolvedSound,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: resolvedSkipScreenshot,
    isTest: !!achievement.isTest,
  };

  notificationLogger.info("queue-achievement", {
    displayName: notificationData.displayName,
    preset: notificationData.preset || "default",
    position: notificationData.position || "center-bottom",
    config: notificationData.config_path || null,
    test: notificationData.isTest || false,
  });
  const isPlatinum = achievement.__isPlatinum === true;
  if (!isPlatinum && pendingPlatinumNotification) {
    platinumAwaitingNormal = false;
  }
  earnedNotificationQueue.push(notificationData);
  processNextNotification();
}

function processNextNotification() {
  if (isNotificationShowing || earnedNotificationQueue.length === 0) return;

  const achievement = earnedNotificationQueue.shift();
  isNotificationShowing = true;

  const lang = selectedLanguage || "english";

  const notificationData = {
    displayName: achievement.displayName,
    description: achievement.description,
    icon: achievement.icon,
    icon_gray: achievement.icon_gray,
    config_path: achievement.config_path,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: !!achievement.skipScreenshot,
    isTest: !!achievement.isTest,
  };

  const iconCandidate = notificationData.icon || notificationData.icon_gray;
  let iconPathFinal = resolveIconAbsolutePath(
    notificationData.config_path,
    iconCandidate,
  );

  if (!iconPathFinal) {
    iconPathFinal = ICON_PATH;
  }
  notificationData.iconPath = iconPathFinal;
  notificationLogger.info("show-notification", {
    displayName: notificationData.displayName,
    preset: notificationData.preset || "default",
    position: notificationData.position || "center-bottom",
    config: notificationData.config_path || null,
    iconResolved: iconPathFinal,
  });

  const preset = achievement.preset || "default";
  const { presetFolder } = resolveNotificationPresetFolder(preset);

  const overrideDurationSec = Number(cachedPreferences?.notificationDuration);
  const overrideDurationMs =
    Number.isFinite(overrideDurationSec) && overrideDurationSec > 0
      ? Math.round(overrideDurationSec * 1000)
      : 0;
  const duration =
    overrideDurationMs || getPresetAnimationDuration(presetFolder);
  notificationData.durationMs = duration;
  const notificationWindow = createNotificationWindow(notificationData);
  const notificationWebContentsId = notificationWindow.webContents.id;

  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    achievement.sound &&
    achievement.sound !== "mute"
  ) {
    mainWindow.webContents.send("play-sound", achievement.sound);
  }

  // Screenshot
  const disableByPrefs = !!cachedPreferences.disableAchievementScreenshot;
  const shouldScreenshot =
    !notificationData.isTest &&
    !notificationData.skipScreenshot &&
    !disableByPrefs;

  const doShot = async () => {
    try {
      if (!screenshot) {
        console.warn(
          tUi(
            "main.log.screenshotDesktopMissing",
            {},
            "screenshot-desktop not installed",
          ),
        );
        return;
      }
      const gameName = selectedConfig || "Unknown Game";
      const achName = notificationData.displayName || "Achievement";
      const saved = await saveFullScreenShot(gameName, achName);
      console.log(
        tUi("main.log.screenshotSaved", {}, "Screenshot saved:"),
        saved,
      );
    } catch (err) {
      console.warn(
        tUi(
          "main.log.screenshotFailed",
          { error: err.message },
          `Screenshot failed: ${err.message}`,
        ),
      );
    }
  };

  if (shouldScreenshot) {
    const armScreenshot = () =>
      armPendingNotificationScreenshot(
        notificationWindow,
        doShot,
        notificationData.durationMs,
      );
    if (notificationWindow.webContents.isLoading()) {
      notificationWindow.webContents.once("did-finish-load", armScreenshot);
    } else {
      armScreenshot();
    }
  }

  notificationWindow.on("closed", () => {
    clearPendingNotificationScreenshot(notificationWebContentsId);
    windowLogger.info("create-notification-window:closed", {
      preset: notificationData.preset || "default",
      position: notificationData.position || "center-bottom",
    });
    isNotificationShowing = false;
    processNextNotification();
    flushPendingPlatinum();
  });

  setTimeout(() => {
    if (!notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  }, duration);
}

function flushPendingPlatinum() {
  if (
    pendingPlatinumNotification &&
    !platinumAwaitingNormal &&
    !isNotificationShowing &&
    earnedNotificationQueue.length === 0
  ) {
    queueAchievementNotification(pendingPlatinumNotification);
    pendingPlatinumNotification = null;
    if (platinumFallbackTimer) {
      clearTimeout(platinumFallbackTimer);
      platinumFallbackTimer = null;
    }
  } else if (
    !pendingPlatinumNotification &&
    !isNotificationShowing &&
    earnedNotificationQueue.length === 0 &&
    pendingPlatinumByConfig.size > 0
  ) {
    const [key, payload] = pendingPlatinumByConfig.entries().next().value || [];
    if (key) pendingPlatinumByConfig.delete(key);
    if (payload) {
      queuePlatinumAfterCurrent(payload);
    }
  }
}

function queuePlatinumAfterCurrent(notificationData) {
  pendingPlatinumNotification = notificationData;
  platinumAwaitingNormal = true;
  if (platinumFallbackTimer) clearTimeout(platinumFallbackTimer);
  platinumFallbackTimer = setTimeout(() => {
    platinumAwaitingNormal = false;
    flushPendingPlatinum();
  }, 300);
  flushPendingPlatinum();
}

function queueProgressNotification(data) {
  if (global.disableProgress) return;
  if (isProgressMutedByPrefs(cachedPreferences, data)) {
    notificationLogger.info("queue-progress:muted", {
      displayName: data?.displayName || "",
      config: data?.config_path || null,
    });
    return;
  }
  notificationLogger.info("queue-progress", {
    displayName: data?.displayName || "",
    progress: data?.progress ?? null,
    max: data?.max_progress ?? null,
    config: data?.config_path || null,
  });
  progressNotificationQueue.push(data);
  processNextProgressNotification();
}

function processNextProgressNotification() {
  if (isProgressShowing || progressNotificationQueue.length === 0) return;

  const data = progressNotificationQueue.shift();
  isProgressShowing = true;

  const progressWindow = showProgressNotification(data);

  if (progressWindow) {
    progressWindow.on("closed", () => {
      isProgressShowing = false;
      processNextProgressNotification();
    });
  } else {
    isProgressShowing = false;
    processNextProgressNotification();
  }
}

let currentAchievementsFilePath = null;
let achievementsWatcher = null;
let extraAchievementFiles = new Set();
let achievementMonitorToken = 0;
let achievementMonitorTimer = null;
let activeLumaPlayRegistryWatcher = null;
let activeLumaPlayRegistryDebounceTimer = null;
const LUMAPLAY_ACTIVE_EVENT_DEBOUNCE_MS = Math.max(
  150,
  Number(process.env.LUMAPLAY_ACTIVE_EVENT_DEBOUNCE_MS) || 350,
);

function stopActiveLumaPlayRegistryWatcher() {
  if (activeLumaPlayRegistryDebounceTimer) {
    clearTimeout(activeLumaPlayRegistryDebounceTimer);
    activeLumaPlayRegistryDebounceTimer = null;
  }
  clearLumaPlayReadCache();
  if (!activeLumaPlayRegistryWatcher) return;
  try {
    activeLumaPlayRegistryWatcher.stop();
  } catch {}
  activeLumaPlayRegistryWatcher = null;
}

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function makeCacheKey(configName, platform = "steam") {
  const safeName = sanitizeConfigName(configName || "") || "unknown";
  const safePlatform = normalizePlatform(platform) || "steam";
  return [safeName, safePlatform].join("_");
}

function getCachePath(configName, platform = "steam") {
  const key = makeCacheKey(configName, platform).replace(/[:\\/]+/g, "_");
  return path.join(cacheDir, `${key}_achievements_cache.json`);
}

const achCacheMetaPath = (() => {
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
let achCacheMetaLoaded = false;
const achCacheMeta = new Map();

function normalizeAchCacheMetaPath(inputPath) {
  if (!inputPath) return "";
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(String(inputPath));
  }
}

function loadAchCacheMetaOnce() {
  if (achCacheMetaLoaded) return;
  achCacheMetaLoaded = true;
  if (!achCacheMetaPath || !fs.existsSync(achCacheMetaPath)) return;
  try {
    const raw = fs.readFileSync(achCacheMetaPath, "utf8");
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
      achCacheMeta.set(key, { mtimeMs, size });
    }
  } catch {}
}

function getAchCacheMetaKey(configName, platform, filePath, appid = "") {
  const normalizedPath = normalizeAchCacheMetaPath(filePath);
  if (!normalizedPath) return "";
  const safeName = sanitizeConfigName(configName || "") || String(appid || "");
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (!safeName) return "";
  return `${safeName}::${normalizedPlatform}::${normalizedPath}`;
}

function isAchCacheMetaMatch(configName, platform, filePath, appid = "") {
  const key = getAchCacheMetaKey(configName, platform, filePath, appid);
  if (!key) return false;
  loadAchCacheMetaOnce();
  const entry = achCacheMeta.get(key);
  if (!entry || typeof entry !== "object") return false;
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  const expectedMtime = Number(entry.mtimeMs ?? 0);
  const expectedSize = Number(entry.size ?? 0);
  if (!Number.isFinite(expectedMtime) || !Number.isFinite(expectedSize)) {
    return false;
  }
  return stat.mtimeMs === expectedMtime && stat.size === expectedSize;
}

function resolveBootSeedCandidatePath(config) {
  const savePathRaw = config?.save_path;
  if (!savePathRaw) return null;
  let saveRoot = savePathRaw;
  let candidatePath = null;
  try {
    const stat = fs.statSync(savePathRaw);
    if (stat.isFile()) {
      candidatePath = savePathRaw;
      saveRoot = path.dirname(savePathRaw);
    }
  } catch {}
  if (!candidatePath) {
    if (!fs.existsSync(saveRoot)) return null;
    const appid = String(config?.appid || "").trim();
    const saveJsonPath = resolveSaveFilePath(saveRoot, appid);
    const {
      tenokeIni: tenokeIniPath,
      ini: iniPath,
      ofx: onlineFixIniPath,
      bin: binPath,
    } = resolveSaveSidecarPaths(saveRoot, appid);
    if (fs.existsSync(saveJsonPath)) candidatePath = saveJsonPath;
    else if (tenokeIniPath) candidatePath = tenokeIniPath;
    else if (onlineFixIniPath) candidatePath = onlineFixIniPath;
    else if (iniPath) candidatePath = iniPath;
    else if (binPath) candidatePath = binPath;
    else if (appid) {
      candidatePath = findAchievementFileDeepForAppId(saveRoot, appid, 2);
    } else {
      candidatePath = findAchievementFileDeep(saveRoot, 2);
    }
  }
  return candidatePath || null;
}

const bootSeededCacheKeys = new Set();
let bootManualSeedScheduled = false;
let bootManualSeedRunning = false;
let bootManualSeedComplete = false;
let bootManualSeedWaitWarned = false;
let bootManualSeedCompletionResolve = null;
let bootPostSeedLimiterActive = false;
const BOOT_MANUAL_POST_SEED_DELAY_MS = 1000;
const BOOT_MANUAL_AFTER_OVERLAY_HIDE_DELAY_MS = 2000;
const BOOT_MANUAL_OVERLAY_WAIT_MAX_MS = 20000;
let bootOverlayWaitStartedAt = 0;
const bootManualSeedCompletion = new Promise((resolve) => {
  bootManualSeedCompletionResolve = resolve;
});
const CACHE_BATCH_LOG_INTERVAL_MS = 1000;
const cacheBatchWindow = {
  hits: 0,
  misses: 0,
  seeded: 0,
  errors: 0,
};
const cacheBatchTotals = {
  hits: 0,
  misses: 0,
  seeded: 0,
  errors: 0,
};
let cacheBatchTimer = null;
try {
  global.bootManualSeedComplete = false;
} catch {}

function hasCacheBatchPending() {
  return (
    cacheBatchWindow.hits > 0 ||
    cacheBatchWindow.misses > 0 ||
    cacheBatchWindow.seeded > 0 ||
    cacheBatchWindow.errors > 0
  );
}

function flushCacheBatchWindow(reason = "interval", force = false) {
  if (cacheBatchTimer) {
    clearTimeout(cacheBatchTimer);
    cacheBatchTimer = null;
  }
  if (!force && !hasCacheBatchPending()) return;
  const payload = {
    reason,
    ...cacheBatchWindow,
  };
  persistenceLogger.info("load-achievement-cache:batch", payload);
  cacheBatchWindow.hits = 0;
  cacheBatchWindow.misses = 0;
  cacheBatchWindow.seeded = 0;
  cacheBatchWindow.errors = 0;
}

function scheduleCacheBatchFlush() {
  if (cacheBatchTimer) return;
  cacheBatchTimer = setTimeout(() => {
    flushCacheBatchWindow("interval");
  }, CACHE_BATCH_LOG_INTERVAL_MS);
}

function bumpCacheBatchStat(field, amount = 1) {
  if (!Object.prototype.hasOwnProperty.call(cacheBatchWindow, field)) return;
  const step = Number(amount) || 0;
  if (step <= 0) return;
  cacheBatchWindow[field] += step;
  cacheBatchTotals[field] += step;
  scheduleCacheBatchFlush();
}

function markBootManualSeedComplete() {
  if (bootManualSeedComplete) return;
  bootManualSeedComplete = true;
  try {
    global.bootManualSeedComplete = true;
  } catch {}
  scheduleOverlayDragHookAfterBootComplete();
  flushCacheBatchWindow("boot-manual-seed-complete");
  persistenceLogger.info("load-achievement-cache:summary", {
    phase: "boot-manual-seed-complete",
    ...cacheBatchTotals,
  });
  try {
    broadcastToAll("boot:manual-seed-complete", { complete: true });
  } catch {}
  try {
    bootManualSeedCompletionResolve?.();
  } catch {}
  bootManualSeedCompletionResolve = null;
}

async function waitForBootManualSeedBeforeLoad(timeoutMs = 15000) {
  if (bootManualSeedComplete) return false;
  if (!bootManualSeedScheduled) return false;
  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timeout = null;
  let timedOut = false;
  await Promise.race([
    bootManualSeedCompletion,
    new Promise((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, ms);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return timedOut;
}

function normalizeCacheSeedPath(input) {
  if (!input) return "";
  let resolved = "";
  try {
    resolved = fs.realpathSync(input);
  } catch {
    try {
      resolved = path.resolve(String(input));
    } catch {
      resolved = String(input);
    }
  }
  if (!resolved) return "";
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function buildCacheSeedKey(config) {
  if (!config || typeof config !== "object") return "";
  const cfgPath = normalizeCacheSeedPath(config.config_path);
  if (cfgPath) return `cfg:${cfgPath}`;
  const savePath = normalizeCacheSeedPath(config.save_path);
  if (savePath) return `save:${savePath}`;
  const name = sanitizeConfigName(config.name || config.displayName || "");
  return name ? `name:${name}` : "";
}

function markCacheSeedKeyFromConfig(config) {
  const key = buildCacheSeedKey(config);
  if (key) bootSeededCacheKeys.add(key);
  return key;
}

function markCacheSeedKeyFromName(configName) {
  const safeName = sanitizeConfigName(configName);
  if (!safeName) return "";
  const cfgPath = path.join(configsDir, `${safeName}.json`);
  if (fs.existsSync(cfgPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      return markCacheSeedKeyFromConfig(data);
    } catch {}
  }
  const fallback = `name:${safeName}`;
  bootSeededCacheKeys.add(fallback);
  return fallback;
}

const BOOT_CACHE_READ_CONCURRENCY = 10;
const BOOT_CACHE_READ_SLICE_MS = 100;
let bootCacheReadLimiter = null;

function isBootCacheReadActive() {
  return global.bootDone !== true || bootPostSeedLimiterActive;
}

function createLimiter(limit, sliceMs) {
  const max = Math.max(1, Number(limit) || 1);
  const slice = Math.max(0, Number(sliceMs) || 0);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          if (slice > 0) {
            setTimeout(pump, slice);
          } else {
            setTimeout(pump, 0);
          }
        });
    }
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

function getBootCacheReadLimiter() {
  if (!bootCacheReadLimiter) {
    bootCacheReadLimiter = createLimiter(
      BOOT_CACHE_READ_CONCURRENCY,
      BOOT_CACHE_READ_SLICE_MS,
    );
  }
  return bootCacheReadLimiter;
}

async function readCacheJson(pathToRead) {
  if (!isBootCacheReadActive()) {
    const raw = fs.readFileSync(pathToRead, "utf8");
    return JSON.parse(raw);
  }
  const limiter = getBootCacheReadLimiter();
  return limiter(async () => {
    const raw = await fs.promises.readFile(pathToRead, "utf8");
    return JSON.parse(raw);
  });
}

async function loadPreviousAchievements(configName, platform = "steam") {
  const cachePath = getCachePath(configName, platform);
  if (fs.existsSync(cachePath)) {
    try {
      const data = await readCacheJson(cachePath);
      bumpCacheBatchStat("hits");
      return data;
    } catch (e) {
      notifyError(tUi("main.notify.cache.readFailed", { error: e.message }));
      bumpCacheBatchStat("errors");
    }
  }
  // fallback legacy cache (name-only) for compatibility
  const legacyPath = path.join(
    cacheDir,
    `${configName}_achievements_cache.json`,
  );
  if (fs.existsSync(legacyPath)) {
    try {
      const data = await readCacheJson(legacyPath);
      bumpCacheBatchStat("hits");
      return data;
    } catch (e) {
      bumpCacheBatchStat("errors");
    }
  }

  // Alias fallback: some configs (notably steam-official) historically seeded caches under a
  // different key (e.g. config.displayName/config.name), while the UI uses the config filename.
  // On a miss, probe aliases from the config JSON and write-through to the canonical path.
  try {
    const normalizedPlatform = normalizePlatform(platform) || "steam";
    const safeName = sanitizeConfigName(configName || "");
    const configPath = safeName
      ? path.join(configsDir, `${safeName}.json`)
      : "";
    if (configPath && fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const candidates = [];
      if (typeof cfg?.name === "string" && cfg.name.trim()) {
        candidates.push(cfg.name.trim());
      }
      if (typeof cfg?.displayName === "string" && cfg.displayName.trim()) {
        candidates.push(cfg.displayName.trim());
      }
      for (const altName of candidates) {
        const altPath = getCachePath(altName, normalizedPlatform);
        if (!altPath || altPath === cachePath) continue;
        if (!fs.existsSync(altPath)) continue;
        try {
          const data = await readCacheJson(altPath);
          bumpCacheBatchStat("hits");
          try {
            if (!fs.existsSync(cachePath)) {
              fs.copyFileSync(altPath, cachePath);
            }
          } catch {}
          return data;
        } catch {
          bumpCacheBatchStat("errors");
        }
      }
    }
  } catch {}

  bumpCacheBatchStat("misses");
  return {};
}

function savePreviousAchievements(configName, data, platform = "steam") {
  const cachePath = getCachePath(configName, platform);
  try {
    let effectiveData = data;
    if (isRpcs3ConfigName(configName) || isLumaPlayConfigName(configName)) {
      const cached = readCacheSilent(configName, platform);
      if (cached && typeof cached === "object") {
        effectiveData = mergeEarnedTimeFromCached(data, cached);
      }
    }
    const ordered = {};
    const keys = Object.keys(effectiveData || {});
    const known = new Set([
      "earned",
      "earned_time",
      "max_progress",
      "progress",
    ]);
    for (const key of keys) {
      const entry = effectiveData?.[key];
      if (!entry || typeof entry !== "object") {
        ordered[key] = entry;
        continue;
      }
      const normalized = {};
      if (Object.prototype.hasOwnProperty.call(entry, "earned")) {
        normalized.earned = entry.earned;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "earned_time")) {
        const rawTime = entry.earned_time;
        normalized.earned_time =
          rawTime === null || rawTime === undefined ? 0 : rawTime;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "max_progress")) {
        normalized.max_progress = entry.max_progress;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "progress")) {
        normalized.progress = entry.progress;
      }
      for (const [k, v] of Object.entries(entry)) {
        if (known.has(k)) continue;
        normalized[k] = v;
      }
      ordered[key] = normalized;
    }
    fs.writeFileSync(cachePath, JSON.stringify(ordered, null, 2));
    persistenceLogger.info("save-achievement-cache", {
      config: configName,
      path: cachePath,
      count: data ? Object.keys(data).length : 0,
    });
  } catch (e) {
    notifyError(tUi("main.notify.cache.readFailed", { error: e.message }));
    persistenceLogger.error("save-achievement-cache:error", {
      config: configName,
      error: e.message,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedCacheFromSnapshot(configName, snapshot, platform = "steam") {
  if (!configName || !snapshot) return;
  savePreviousAchievements(configName, snapshot, platform);
  markCacheSeedKeyFromName(configName);
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function readJsonWithRetries(filePath, maxTries = 12, baseDelayMs = 45) {
  let lastErr = null;
  for (let i = 0; i < maxTries; i++) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      if (
        msg.includes("Unexpected end of JSON input") ||
        msg.includes("Unexpected token") ||
        e.code === "EBUSY"
      ) {
        sleepSync(baseDelayMs + i * 35);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function findAchievementFileDeep(baseDir, maxDepth = 2) {
  if (!isNonEmptyString(baseDir)) return null;
  const targets = [
    "achievements.json",
    "achievements.ini",
    "stats.bin",
    "user_stats.ini",
  ];
  const targetLc = targets.map((t) => t.toLowerCase());
  const stack = [{ dir: baseDir, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && targetLc.includes(ent.name.toLowerCase())) {
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
      /* ignore */
    }
  }
  return null;
}

function findAchievementFileDeepForAppId(saveBase, appid, maxDepth = 2) {
  if (!isNonEmptyString(saveBase) || !isNonEmptyString(appid)) return null;
  const appidStr = String(appid);
  const candidates = [];
  if (path.basename(saveBase) === appidStr) {
    candidates.push(saveBase);
  }
  candidates.push(
    path.join(saveBase, "steam_settings", appidStr),
    path.join(saveBase, appidStr),
    path.join(saveBase, "remote", appidStr),
  );
  for (const root of candidates) {
    if (!root || !fs.existsSync(root)) continue;
    const found = findAchievementFileDeep(root, maxDepth);
    if (found) return found;
  }
  return null;
}

async function monitorAchievementsFile(filePath) {
  if (!filePath) {
    achievementMonitorToken += 1;
    stopActiveLumaPlayRegistryWatcher();
    if (achievementMonitorTimer) {
      clearTimeout(achievementMonitorTimer);
      achievementMonitorTimer = null;
    }
    if (extraAchievementFiles.size) {
      for (const fp of extraAchievementFiles) {
        try {
          fs.unwatchFile(fp);
        } catch {}
      }
      extraAchievementFiles.clear();
    }
    if (achievementsWatcher && currentAchievementsFilePath) {
      fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
      achievementsWatcher = null;
    }
    currentAchievementsFilePath = null;
    return;
  }

  const isLumaPlayPath =
    typeof filePath === "string" && filePath.startsWith("lumaplay:");
  const samePathActive =
    currentAchievementsFilePath === filePath &&
    (isLumaPlayPath ? !!activeLumaPlayRegistryWatcher : !!achievementsWatcher);
  if (samePathActive && (isLumaPlayPath || fs.existsSync(filePath))) {
    if (achievementMonitorTimer) {
      clearTimeout(achievementMonitorTimer);
      achievementMonitorTimer = null;
    }
    return;
  }

  achievementMonitorToken += 1;
  stopActiveLumaPlayRegistryWatcher();
  if (achievementMonitorTimer) {
    clearTimeout(achievementMonitorTimer);
    achievementMonitorTimer = null;
  }
  const monitorToken = achievementMonitorToken;

  if (achievementsWatcher && currentAchievementsFilePath) {
    fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
    achievementsWatcher = null;
  }
  if (extraAchievementFiles.size) {
    for (const fp of extraAchievementFiles) {
      try {
        fs.unwatchFile(fp);
      } catch {}
    }
    extraAchievementFiles.clear();
  }

  currentAchievementsFilePath = filePath;
  const safeConfigName = selectedConfig
    ? sanitizeConfigName(selectedConfig)
    : null;
  const configFile = safeConfigName
    ? path.join(configsDir, `${safeConfigName}.json`)
    : null;
  const configName = selectedConfig;
  const configPath = path.join(configsDir, `${configName}.json`);
  let configMeta = null;
  let previousAchievements = {};
  let isFirstLoad = true;
  let initialTouched = false;
  let fullConfig = [];
  let crcMap = {};
  const pendingMissingFile = isNonEmptyString(configName)
    ? pendingMissingAchievementFiles.get(configName)
    : null;
  let allowInitialNotify =
    pendingMissingFile && pendingMissingFile === filePath;
  try {
    configMeta =
      configFile && fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8"))
        : null;
  } catch (err) {
    console.warn(
      tUi(
        "main.log.configLoadFailed",
        { name: safeConfigName, error: err.message },
        `Failed to load config ${safeConfigName}: ${err.message}`,
      ),
    );
  }
  const isXenia =
    normalizePlatform(configMeta?.platform) === "xenia" ||
    String(filePath || "")
      .toLowerCase()
      .endsWith(".gpd");
  const isRpcs3 =
    normalizePlatform(configMeta?.platform) === "rpcs3" ||
    String(filePath || "")
      .toLowerCase()
      .endsWith("tropusr.dat");

  const currentPlatform =
    normalizePlatform(selectedPlatform) ||
    normalizePlatform(configMeta?.platform) ||
    "steam";
  previousAchievements =
    (await loadPreviousAchievements(configName, currentPlatform)) || {};
  const isPs4 =
    normalizePlatform(configMeta?.platform) === "shadps4" ||
    String(filePath || "")
      .toLowerCase()
      .endsWith(".xml");
  const isSteamOfficial =
    normalizePlatform(configMeta?.platform) === "steam-official" ||
    String(filePath || "")
      .toLowerCase()
      .startsWith("usergamestats_");
  const isLumaPlay = isLumaPlayConfig(configMeta) && isLumaPlayWatcherEnabled();
  try {
    if (
      fullAchievementsConfigPath &&
      fs.existsSync(fullAchievementsConfigPath)
    ) {
      fullConfig = JSON.parse(
        fs.readFileSync(fullAchievementsConfigPath, "utf8"),
      );
      crcMap = buildCrcNameMap(fullConfig);
    } else {
      fullConfig = [];
      crcMap = {};
    }
  } catch (e) {
    warnOnce(
      `${selectedConfig}`,
      `Could not parse achievements.json": ${e.message}`,
    );
    fullConfig = [];
    crcMap = {};
  }
  const processSnapshot = (isRetry = false) => {
    let currentAchievements = null;
    let touchedInLoop = false;
    let lumaPlayReadFailed = false;
    try {
      if (isXenia) {
        const parsed = parseGpdFile(filePath);
        currentAchievements = buildSnapshotFromGpd(parsed);
      } else if (isRpcs3) {
        const trophyDir =
          resolveRpcs3TrophyDirForConfig(configMeta) || path.dirname(filePath);
        const parsed = parseTrophySetDir(trophyDir);
        currentAchievements = buildSnapshotFromTrophy(parsed);
      } else if (isSteamOfficial) {
        const statsDir = configMeta?.save_path || path.dirname(filePath);
        const schemaPath = fullAchievementsConfigPath;
        const schemaArr =
          schemaPath && fs.existsSync(schemaPath)
            ? JSON.parse(fs.readFileSync(schemaPath, "utf8"))
            : [];
        const entries = Array.isArray(schemaArr)
          ? schemaArr
              .map((e) => ({
                api: e?.name || e?.api,
                statId: e?.statId,
                bit: e?.bit,
              }))
              .filter(
                (e) =>
                  e.api &&
                  Number.isInteger(e.statId) &&
                  Number.isInteger(e.bit),
              )
          : [];
        let userBin = filePath;
        const base = path.basename(userBin || "").toLowerCase();
        if (!base.startsWith("usergamestats_") || !base.endsWith(".bin")) {
          userBin = pickLatestUserBin(statsDir, configMeta?.appid);
        }
        if (entries.length && userBin && fs.existsSync(userBin)) {
          const kv = parseSteamKv(fs.readFileSync(userBin));
          const userStats = extractUserStats(kv.data);
          currentAchievements = buildSnapshotFromAppcache(entries, userStats);
        } else {
          currentAchievements = previousAchievements;
        }
      } else if (isPs4) {
        const trophyDir =
          configMeta?.save_path ||
          path.dirname(path.dirname(filePath)) ||
          path.dirname(filePath);
        const parsed = require("./utils/shadps4-trophy").parsePs4TrophySetDir(
          trophyDir,
        );
        parsed.appid = configMeta?.appid || parsed.appid;
        currentAchievements =
          require("./utils/shadps4-trophy").buildSnapshotFromPs4(
            parsed,
            previousAchievements,
          );
      } else if (isLumaPlay) {
        const parsed = readLumaPlayAchievementsSnapshot({
          appid: String(configMeta?.appid || ""),
          configPath: configMeta?.config_path || selectedConfigPath || "",
          preferredUser:
            configMeta?.lumaplay_user || configMeta?.lumaplayUser || "",
          preferredKeyPath:
            configMeta?.lumaplay_key_path || configMeta?.lumaplayKeyPath || "",
          previousSnapshot: previousAchievements,
        });
        if (parsed?.user && parsed.user !== configMeta?.lumaplay_user) {
          configMeta.lumaplay_user = parsed.user;
          try {
            if (configFile && fs.existsSync(configFile)) {
              const raw = fs.readFileSync(configFile, "utf8");
              const cfg = JSON.parse(raw);
              if (cfg.lumaplay_user !== parsed.user) {
                cfg.lumaplay_user = parsed.user;
                fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
              }
            }
          } catch {}
        }
        if (parsed?.found === false) {
          lumaPlayReadFailed = true;
          currentAchievements = { ...previousAchievements };
        } else {
          currentAchievements = parsed?.snapshot || {};
        }
      } else {
        currentAchievements = loadAchievementsFromSaveFile(
          path.dirname(filePath),
          previousAchievements,
          {
            configMeta,
            selectedConfigPath,
            fullSchemaPath: fullAchievementsConfigPath,
          },
        );
      }
    } catch {
      return;
    }
    const hitFallback = currentAchievements === previousAchievements;
    if (hitFallback) {
      if (!isRetry) {
        setTimeout(() => processSnapshot(true), 220);
      }
      return;
    }

    if (allowInitialNotify && isFirstLoad) {
      previousAchievements = {};
      allowInitialNotify = false;
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
    }

    const isFirstTime = Object.keys(previousAchievements).length === 0;
    if (isFirstLoad && isFirstTime) {
      const bootNotDoneYet = bootSeeding && global.bootDone !== true;
      if (bootNotDoneYet) {
        previousAchievements = { ...currentAchievements };
        savePreviousAchievements(
          configName,
          previousAchievements,
          currentPlatform,
        );
        isFirstLoad = false;
        bootSeeding = false;
        return;
      }
      bootSeeding = false;
      const earnedKeys = Object.keys(currentAchievements).filter(
        (key) =>
          currentAchievements[key].earned === true ||
          currentAchievements[key].earned === 1,
      );

      if (earnedKeys.length > 0) {
        earnedKeys.forEach((key) => {
          const current = currentAchievements[key];
          const isBin = path.basename(filePath).endsWith(".bin");
          const achievementConfig = fullConfig.find((a) => a.name === key);

          const lang = selectedLanguage || "english";
          const selectedSound = getUserPreferredSound();
          const displayName = getSafeLocalizedText(
            achievementConfig?.displayName,
            lang,
          );
          const description = getSafeLocalizedText(
            achievementConfig?.description,
            lang,
          );

          if (achievementConfig) {
            queueAchievementNotification({
              displayName,
              description,
              icon: achievementConfig.icon,
              icon_gray: achievementConfig.icon_gray,
              config_path: selectedConfigPath,
              preset: selectedPreset,
              position: selectedPosition,
              sound: selectedSound || "mute",
              soundPath: selectedSound
                ? path.join(app.getAppPath(), "sounds", selectedSound)
                : null,
            });
            initialTouched = true;
            previousAchievements[key] = {
              earned: true,
              earned_time: current.earned_time || Date.now(),
              progress: current.progress,
              max_progress: current.max_progress,
            };
          }
        });
      }

      if (!global.disableProgress) {
        const pendingProgress = Object.keys(currentAchievements).filter(
          (key) => {
            const cur = currentAchievements[key];
            const alreadyEarned =
              cur?.earned === true || cur?.earned === 1 || false;
            const curProg = Number(cur?.progress);
            const curMax = Number(cur?.max_progress);
            return (
              !alreadyEarned &&
              Number.isFinite(curProg) &&
              Number.isFinite(curMax) &&
              curMax > 0 &&
              curProg > 0
            );
          },
        );

        if (pendingProgress.length) {
          const isBin = path.basename(filePath).endsWith(".bin");
          for (const key of pendingProgress) {
            const cur = currentAchievements[key];
            const achievementConfig = isBin
              ? crcMap[key.toLowerCase()]
              : fullConfig.find((a) => a.name === key || a.name === cur?.name);
            if (!achievementConfig) continue;

            queueProgressNotification({
              displayName: getSafeLocalizedText(
                achievementConfig.displayName,
                selectedLanguage,
              ),
              icon: achievementConfig.icon,
              progress: cur.progress,
              max_progress: cur.max_progress,
              config_path: selectedConfigPath,
              configName,
            });
            initialTouched = true;
          }
        }
      }
      if (isFirstLoad) {
        previousAchievements = { ...currentAchievements };
      }
    }

    Object.keys(currentAchievements).forEach((key) => {
      const current = currentAchievements[key];
      const previous = previousAchievements[key];
      const lang = selectedLanguage || "english";
      const newlyEarned =
        Boolean(current.earned) && (!previous || !Boolean(previous.earned));
      if (newlyEarned && (isRpcs3 || isLumaPlay) && !current.earned_time) {
        current.earned_time = Date.now();
      }

      if (newlyEarned) {
        touchedInLoop = true;
        const isBin = path.basename(filePath).endsWith(".bin");
        const achievementConfig = fullConfig.find((a) => a.name === key);

        if (!achievementConfig) {
          console.warn(
            tUi(
              "main.log.achievementConfigMissing",
              { key },
              `Achievement config not found for key: ${key}`,
            ),
          );
          return;
        }
        if (achievementConfig) {
          const notificationData = {
            displayName:
              typeof achievementConfig.displayName === "object"
                ? achievementConfig.displayName[lang] ||
                  achievementConfig.displayName.english ||
                  Object.values(achievementConfig.displayName)[0]
                : achievementConfig.displayName,

            description:
              typeof achievementConfig.description === "object"
                ? achievementConfig.description[lang] ||
                  achievementConfig.description.english ||
                  Object.values(achievementConfig.description)[0]
                : achievementConfig.description,
            icon: achievementConfig.icon,
            icon_gray:
              achievementConfig.icon_gray || achievementConfig.icongray,
            config_path: selectedConfigPath,
            preset: selectedPreset,
            position: selectedPosition,
            sound: getUserPreferredSound() || "mute",
          };

          queueAchievementNotification(notificationData);

          mainWindow.webContents.send("refresh-achievements-table");
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send("load-overlay-data", selectedConfig);
            overlayWindow.webContents.send("set-language", {
              language: selectedLanguage,
              uiLanguage: selectedUiLanguage,
            });
          }
        }
      }
      const stillLocked = !(current?.earned === true || current?.earned === 1);
      const curProgress = Number(current?.progress);
      const curMax = Number(current?.max_progress);
      const prevProgress = Number(previous?.progress);
      const prevMax = Number(previous?.max_progress);
      const hasProgress =
        Number.isFinite(curProgress) && Number.isFinite(curMax) && curMax > 0;
      const progressChanged =
        stillLocked &&
        hasProgress &&
        (!Number.isFinite(prevProgress) ||
          !Number.isFinite(prevMax) ||
          curProgress !== prevProgress ||
          curMax !== prevMax);

      if (progressChanged) {
        touchedInLoop = true;
        const isBin = path.basename(filePath).endsWith(".bin");
        const achievementConfig = isBin
          ? crcMap[key.toLowerCase()]
          : fullConfig.find((a) => a.name == key || a.name == current?.name);

        if (achievementConfig) {
          if (!global.disableProgress) {
            queueProgressNotification({
              displayName: getSafeLocalizedText(
                achievementConfig.displayName,
                selectedLanguage,
              ),
              icon: achievementConfig.icon,
              progress: current.progress,
              max_progress: current.max_progress,
              config_path: selectedConfigPath,
              configName,
            });
          }

          mainWindow.webContents.send("refresh-achievements-table");
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send("load-overlay-data", selectedConfig);
            overlayWindow.webContents.send("set-language", {
              language: selectedLanguage,
              uiLanguage: selectedUiLanguage,
            });
          }
        }
      }
    });

    if (initialTouched) {
      broadcastToAll("achievements:file-updated", {
        appid: currentAppId || null,
        configName,
      });
    }
    const appid = String(configMeta?.appid || currentAppId || "");
    currentAppId = appid || null;
    previousAchievements = currentAchievements;
    if (!(isLumaPlay && lumaPlayReadFailed)) {
      savePreviousAchievements(
        configName,
        previousAchievements,
        currentPlatform,
      );
    }
    isFirstLoad = false;
  };
  achievementsWatcher = () => processSnapshot(false);
  const refreshAchievementsUi = () => {
    mainWindow.webContents.send("refresh-achievements-table");
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", {
        language: selectedLanguage,
        uiLanguage: selectedUiLanguage,
      });
    }
  };

  if (isLumaPlay) {
    const activeConfigName = selectedConfig || null;
    const activeAppId = String(configMeta?.appid || "");
    const restartDelayMs = Math.max(
      500,
      Number(process.env.LUMAPLAY_EVENT_WATCH_RESTART_MS) || 1500,
    );
    let running = false;
    let pending = false;
    const clearSnapshotDebounceTimer = () => {
      if (activeLumaPlayRegistryDebounceTimer) {
        clearTimeout(activeLumaPlayRegistryDebounceTimer);
        activeLumaPlayRegistryDebounceTimer = null;
      }
    };
    const scheduleSnapshotFromEvent = (
      delayMs = LUMAPLAY_ACTIVE_EVENT_DEBOUNCE_MS,
    ) => {
      if (monitorToken !== achievementMonitorToken) return;
      if (running) {
        pending = true;
        return;
      }
      clearSnapshotDebounceTimer();
      activeLumaPlayRegistryDebounceTimer = setTimeout(
        () => {
          activeLumaPlayRegistryDebounceTimer = null;
          runSnapshotFromEvent();
        },
        Math.max(0, Number(delayMs) || 0),
      );
    };

    const runSnapshotFromEvent = () => {
      if (monitorToken !== achievementMonitorToken) return;
      clearSnapshotDebounceTimer();
      if (running) {
        pending = true;
        return;
      }
      running = true;
      try {
        do {
          pending = false;
          processSnapshot(false);
          refreshAchievementsUi();
        } while (pending && monitorToken === achievementMonitorToken);
      } finally {
        running = false;
        if (pending && monitorToken === achievementMonitorToken) {
          scheduleSnapshotFromEvent();
        }
      }
    };

    activeLumaPlayRegistryWatcher = startLumaPlayRegistryEventWatcher({
      restartDelayMs,
      onReady: () => {
        appLogger.info("active-lumaplay:event-start", {
          config: activeConfigName,
          appid: activeAppId || null,
          restartDelayMs,
        });
      },
      onWarn: (error) => {
        appLogger.warn("active-lumaplay:event-warning", {
          config: activeConfigName,
          appid: activeAppId || null,
          error: String(error || ""),
        });
      },
      onChange: () => {
        clearLumaPlayReadCache();
        scheduleSnapshotFromEvent();
      },
    });

    runSnapshotFromEvent();
    return;
  }

  const checkFileLoop = () => {
    if (monitorToken !== achievementMonitorToken) return;
    if (fs.existsSync(filePath)) {
      processSnapshot(false);
      refreshAchievementsUi();

      try {
        fs.unwatchFile(filePath);
      } catch {}
      fs.watchFile(filePath, { interval: 1000 }, achievementsWatcher);
      achievementMonitorTimer = null;
    } else {
      const baseDir = path.dirname(filePath);
      const tenokePath = path.join(baseDir, "SteamData", "user_stats.ini");
      const iniPath = path.join(baseDir, "achievements.ini");
      const universeIniPath = path.join(
        baseDir,
        "UniverseLANData",
        "Achievements.ini",
      );
      const onlineFixIniPath = path.join(baseDir, "Stats", "achievements.ini");
      const binPath = path.join(baseDir, "stats.bin");

      if (fs.existsSync(tenokePath)) {
        monitorAchievementsFile(tenokePath);
        return;
      }

      if (fs.existsSync(iniPath)) {
        monitorAchievementsFile(iniPath);
        return;
      }

      if (fs.existsSync(universeIniPath)) {
        monitorAchievementsFile(universeIniPath);
        return;
      }

      if (fs.existsSync(onlineFixIniPath)) {
        monitorAchievementsFile(onlineFixIniPath);
        return;
      }

      if (fs.existsSync(binPath)) {
        monitorAchievementsFile(binPath);
        return;
      }

      const saveBase = configMeta?.save_path;
      const appid = String(configMeta?.appid || "");
      if (isNonEmptyString(saveBase) && isNonEmptyString(appid)) {
        const alt = findAchievementFileDeepForAppId(saveBase, appid, 2);
        if (alt && alt !== filePath) {
          if (isNonEmptyString(configName)) {
            pendingMissingAchievementFiles.set(configName, alt);
          }
          monitorAchievementsFile(alt);
          return;
        }
      }

      // Retry discovery later in case the save file appears after config load
      achievementMonitorTimer = setTimeout(checkFileLoop, 1000);
    }
  };

  checkFileLoop();
}

let fullAchievementsConfigPath;
ipcMain.on(
  "update-config",
  (event, { configName, preset, position, platform }) => {
    const safeName = configName ? sanitizeConfigName(configName) : null;

    if (!safeName) {
      stopActiveLumaPlayRegistryWatcher();
      if (achievementMonitorTimer) {
        clearTimeout(achievementMonitorTimer);
        achievementMonitorTimer = null;
      }
      if (achievementsWatcher && achievementsFilePath) {
        fs.unwatchFile(achievementsFilePath, achievementsWatcher);
        achievementsWatcher = null;
      }
      achievementsFilePath = null;
      selectedConfig = null;
      selectedPlatform = null;

      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }

    const cfgFile = path.join(configsDir, `${safeName}.json`);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
    } catch (err) {
      notifyError(
        tUi("main.notify.configPath.readFailed", { error: err.message }),
      );
      return;
    }

    const appIdString =
      config?.appid != null ? String(config.appid).trim() : "";

    if (appIdString && isAppIdBlacklisted(appIdString)) {
      ipcLogger.info("update-config:ignored-blacklisted", {
        configName: configName || null,
        appid: appIdString,
      });
      return;
    }

    selectedPreset = preset || "default";
    selectedPosition = position || "center-bottom";
    selectedConfig = configName;
    selectedPlatform =
      normalizePlatform(platform) ||
      normalizePlatform(config?.platform) ||
      null;
    selectedConfigPath = isNonEmptyString(config.config_path)
      ? config.config_path
      : null;
    fullAchievementsConfigPath = isNonEmptyString(config.config_path)
      ? path.join(config.config_path, "achievements.json")
      : null;

    const normalizedPlatform = normalizePlatform(config.platform);
    if (isLumaPlayConfig(config)) {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      if (!isLumaPlayWatcherEnabled()) {
        stopActiveLumaPlayRegistryWatcher();
        achievementsFilePath = null;
        monitorAchievementsFile(null);
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("load-overlay-data", selectedConfig);
          overlayWindow.webContents.send("set-language", {
            language: selectedLanguage,
            uiLanguage: selectedUiLanguage,
          });
        }
        return;
      }
      achievementsFilePath = `lumaplay:${appid || "unknown"}`;
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      monitorAchievementsFile(achievementsFilePath);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }
    if (normalizedPlatform === "xenia") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const gpdPath = resolveGpdPathForConfig(config);
      achievementsFilePath = gpdPath || null;
      if (!gpdPath || !fs.existsSync(gpdPath)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-gpd",
        });
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("load-overlay-data", selectedConfig);
          overlayWindow.webContents.send("set-language", {
            language: selectedLanguage,
            uiLanguage: selectedUiLanguage,
          });
        }
        return;
      }
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      monitorAchievementsFile(achievementsFilePath);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }
    if (normalizedPlatform === "rpcs3") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const trophyDir = resolveRpcs3TrophyDirForConfig(config);
      const tropusrPath = resolveTropusrPathForConfig(config);
      achievementsFilePath = tropusrPath || null;
      if (!tropusrPath || !fs.existsSync(tropusrPath)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-tropusr",
        });
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("load-overlay-data", selectedConfig);
          overlayWindow.webContents.send("set-language", {
            language: selectedLanguage,
            uiLanguage: selectedUiLanguage,
          });
        }
        return;
      }
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      monitorAchievementsFile(achievementsFilePath);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }
    if (normalizedPlatform === "shadps4") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const trophyDir = config.save_path || "";
      const xmlRoot = path.join(trophyDir, "Xml");
      const xmlMain = path.join(xmlRoot, "TROP.XML");
      achievementsFilePath = fs.existsSync(xmlMain) ? xmlMain : null;
      if (!achievementsFilePath) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-tropxml",
        });
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("load-overlay-data", selectedConfig);
          overlayWindow.webContents.send("set-language", {
            language: selectedLanguage,
            uiLanguage: selectedUiLanguage,
          });
        }
        return;
      }
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      monitorAchievementsFile(achievementsFilePath);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }

    if (normalizedPlatform === "steam-official") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const statsDir = config.save_path || "";
      const userBin =
        statsDir && appid ? pickLatestUserBin(statsDir, appid) : null;
      achievementsFilePath = userBin || null;
      if (!userBin || !fs.existsSync(userBin)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-usergamestats",
        });
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.send("load-overlay-data", selectedConfig);
          overlayWindow.webContents.send("set-language", {
            language: selectedLanguage,
            uiLanguage: selectedUiLanguage,
          });
        }
        return;
      }
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      monitorAchievementsFile(achievementsFilePath);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }

    if (normalizedPlatform === "shadps4") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      achievementsFilePath = null; // we watch via renderer requests; overlay uses config path data
      monitorAchievementsFile(null);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }

    if (!isNonEmptyString(config.save_path)) {
      monitorAchievementsFile(null);
      achievementsFilePath = null;
      event.sender.send("achievements-missing", {
        configName,
        reason: "no-save-path",
      });
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      return;
    }
    if (selectedConfigPath) {
      const c1 = fullAchievementsConfigPath; // <config_path>/achievements.json
      const c2 =
        config.appid != null
          ? path.join(
              selectedConfigPath,
              String(config.appid),
              "achievements.json",
            )
          : null;

      if (c1 && fs.existsSync(c1)) {
      } else if (c2 && fs.existsSync(c2)) {
        fullAchievementsConfigPath = c2;
        selectedConfigPath = path.dirname(c2);
      }
      const appid = String(config.appid || "");
      currentAppId = appid || null;
    }

    const appid = String(config.appid || "");
    const saveBase = config.save_path;

    const saveJsonPath = resolveSaveFilePath(saveBase, appid);
    const {
      tenokeIni: tenokeIniPath,
      ini: iniPath,
      ofx: onlineFixIniPath,
      bin: binPath,
    } = resolveSaveSidecarPaths(saveBase, appid);

    if (fs.existsSync(saveJsonPath)) achievementsFilePath = saveJsonPath;
    else if (tenokeIniPath) achievementsFilePath = tenokeIniPath;
    else if (onlineFixIniPath) achievementsFilePath = onlineFixIniPath;
    else if (iniPath) achievementsFilePath = iniPath;
    else if (binPath) achievementsFilePath = binPath;
    else achievementsFilePath = saveJsonPath; // fallback

    if (
      (!achievementsFilePath || !fs.existsSync(achievementsFilePath)) &&
      isNonEmptyString(saveBase)
    ) {
      const deep = findAchievementFileDeepForAppId(saveBase, appid, 2);
      if (deep) {
        achievementsFilePath = deep;
        try {
          const cfgFile = path.join(configsDir, `${safeName}.json`);
          if (fs.existsSync(cfgFile)) {
            const raw = fs.readFileSync(cfgFile, "utf8");
            const data = JSON.parse(raw);
            data.save_path = path.dirname(deep);
            fs.writeFileSync(cfgFile, JSON.stringify(data, null, 2));
            selectedConfigPath = isNonEmptyString(data.config_path)
              ? data.config_path
              : null;
          }
        } catch {}
      }
    }

    if (isNonEmptyString(configName)) {
      const existsNow =
        isNonEmptyString(achievementsFilePath) &&
        fs.existsSync(achievementsFilePath);
      if (existsNow || global.bootDone !== true) {
        pendingMissingAchievementFiles.delete(configName);
      } else {
        pendingMissingAchievementFiles.set(configName, achievementsFilePath);
      }
    }

    monitorAchievementsFile(achievementsFilePath);

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", {
        language: selectedLanguage,
        uiLanguage: selectedUiLanguage,
      });
    }
  },
);

async function waitForPathExists(p, tries = 50, delay = 60) {
  return new Promise((resolve) => {
    const tick = (n) => {
      try {
        if (fs.existsSync(p)) return resolve(true);
      } catch {}
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), delay);
    };
    tick(tries);
  });
}

ipcMain.handle("get-config-by-name", async (_event, name) => {
  const safe = sanitizeConfigName(name || "");
  if (!safe) throw new Error("Invalid name");

  if (getConfigInflight.has(safe)) return getConfigInflight.get(safe);

  const job = (async () => {
    let configPath = path.join(configsDir, `${safe}.json`);
    if (!fs.existsSync(configPath)) {
      await waitForPathExists(configPath, 60, 70);
    }

    if (!fs.existsSync(configPath)) {
      try {
        const files = fs
          .readdirSync(configsDir)
          .filter((f) => f.toLowerCase().endsWith(".json"));
        const target = safe.toLowerCase();

        const matchName = (val) =>
          sanitizeConfigName(String(val || "")).toLowerCase() === target;

        for (const f of files) {
          const full = path.join(configsDir, f);
          let obj;
          try {
            obj = readJsonWithRetries(full, 6, 35);
          } catch {
            obj = null;
          }
          const base = path.basename(f, ".json");

          const nameCandidates = [
            obj?.name,
            obj?.displayName,
            obj?.appid,
            obj?.appId,
            obj?.steamAppId,
            base,
          ].filter(Boolean);

          const ok = nameCandidates.some((val) => {
            if (
              /^[0-9a-fA-F]+$/.test(target) &&
              /^[0-9a-fA-F]+$/.test(String(val || ""))
            ) {
              return String(val) === target;
            }
            return matchName(val);
          });

          if (ok) {
            configPath = full;
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!fs.existsSync(configPath)) {
      return { __notFound: true, name: safe };
    }

    let data;
    try {
      data = readJsonWithRetries(configPath, 8, 40);
    } catch (e) {
      return { __notFound: true, name: safe, __error: "corrupt-or-busy" };
    }

    const appid = String(data?.appid || data?.appId || data?.steamAppId || "");
    const hasAppId = /^[0-9a-fA-F]+$/.test(appid);
    const hasConfigPath = isNonEmptyString(data?.config_path);

    const probe = [];
    if (hasConfigPath) {
      probe.push(path.join(data.config_path, "achievements.json"));
      probe.push(
        path.join(data.config_path, "steam_settings", "achievements.json"),
      );
      if (hasAppId)
        probe.push(path.join(data.config_path, appid, "achievements.json"));
    }

    let foundSchemaPath = null;
    for (const p of probe) {
      if (p && fs.existsSync(p) && looksLikeSchemaArray(readJsonSafe(p))) {
        foundSchemaPath = p;
        break;
      }
    }

    if (!foundSchemaPath && hasAppId) {
      const schemaBase = path.join(configsDir, "schema");
      const platformDir = resolveSchemaDirForPlatform(appid, data?.platform);
      const platformJson = path.join(platformDir, "achievements.json");
      const legacyDir = path.join(schemaBase, appid);
      const legacyJson = path.join(legacyDir, "achievements.json");
      const candidates = [
        { dir: platformDir, file: platformJson },
        { dir: legacyDir, file: legacyJson, legacy: true },
      ];
      for (const candidate of candidates) {
        if (candidate.legacy && candidate.dir !== platformDir) {
          try {
            fs.mkdirSync(platformDir, { recursive: true });
            fs.renameSync(candidate.dir, platformDir);
            candidate.dir = platformDir;
            candidate.file = path.join(platformDir, "achievements.json");
          } catch {}
        }
        if (!fs.existsSync(candidate.file)) {
          await waitForPathExists(candidate.file, 40, 60);
        }
        if (
          fs.existsSync(candidate.file) &&
          looksLikeSchemaArray(readJsonSafe(candidate.file))
        ) {
          data.config_path = candidate.dir;
          try {
            const now = readJsonWithRetries(configPath, 3, 40);
            if (now.config_path !== candidate.dir) {
              now.config_path = candidate.dir;
              fs.writeFileSync(configPath, JSON.stringify(now, null, 2));
              data = now;
            }
          } catch {}
          foundSchemaPath = candidate.file;
          break;
        }
      }
    }

    if (!isNonEmptyString(data.save_path)) {
      try {
        const tryBase = data.config_path || "";
        if (isNonEmptyString(tryBase) && hasAppId) {
          const detected = findSaveBaseFromSelection(tryBase, appid);
          if (detected) {
            data.save_path = detected;
            try {
              const now = readJsonWithRetries(configPath, 2, 40);
              if (now.save_path !== detected) {
                now.save_path = detected;
                fs.writeFileSync(configPath, JSON.stringify(now, null, 2));
                data = now;
              }
            } catch {}
          }
        }
      } catch {}
    }

    const schemaReady =
      !!foundSchemaPath ||
      (hasConfigPath &&
        [
          path.join(data.config_path, "achievements.json"),
          path.join(data.config_path, "steam_settings", "achievements.json"),
          hasAppId
            ? path.join(data.config_path, appid, "achievements.json")
            : null,
        ].some((p) => p && fs.existsSync(p)));

    return { ...data, __schemaReady: schemaReady };
  })()
    .catch((err) => ({
      __error: String(err?.message || err),
      __failed: true,
      name: safe,
    }))
    .finally(() => {
      getConfigInflight.delete(safe);
    });

  getConfigInflight.set(safe, job);
  return job;
});

ipcMain.handle("renameAndSaveConfig", async (event, oldName, newConfig) => {
  try {
    const safeOld = sanitizeConfigName(oldName);
    const safeNew = sanitizeConfigName(newConfig.name);

    const oldConfigPath = path.join(configsDir, `${safeOld}.json`);
    const newConfigPath = path.join(configsDir, `${safeNew}.json`);
    let prevConfig = null;
    if (fs.existsSync(oldConfigPath)) {
      try {
        prevConfig = JSON.parse(fs.readFileSync(oldConfigPath, "utf8"));
      } catch {}
    }

    if (safeOld !== safeNew && fs.existsSync(oldConfigPath)) {
      fs.renameSync(oldConfigPath, newConfigPath);
    }

    const exePath = isNonEmptyString(newConfig.executable)
      ? newConfig.executable
      : null;

    const payload = {
      ...prevConfig, // preserve custom fields like platinum
      ...newConfig,
      name: safeNew,
      displayName: newConfig.displayName || newConfig.name,
      config_path: isNonEmptyString(newConfig.config_path)
        ? newConfig.config_path
        : null,
      save_path: isNonEmptyString(newConfig.save_path)
        ? newConfig.save_path
        : null,
      executable: exePath,
      arguments: isNonEmptyString(newConfig.arguments)
        ? newConfig.arguments
        : "",
      process_name: isNonEmptyString(newConfig.process_name)
        ? newConfig.process_name
        : exePath
          ? path.basename(exePath)
          : "",
    };

    const sanitizedAppId = sanitizeAppIdForPlatform(
      payload.appid,
      payload.platform,
    );
    if (!sanitizedAppId) {
      return { success: false, message: tUi("main.message.appidRequired") };
    }
    if (isAppIdBlacklisted(sanitizedAppId)) {
      const message = `AppID ${sanitizedAppId} is blacklisted. Remove it to continue.`;
      ipcLogger.info("renameConfig:blocked-blacklist", {
        appid: sanitizedAppId,
        oldName: safeOld,
        newName: safeNew,
      });
      return { success: false, message, blacklisted: true };
    }
    payload.appid = sanitizedAppId;

    applyConfigPlatformDefaults(payload);
    const prevPlatform = normalizePlatform(prevConfig?.platform) || null;
    let nextPlatform = normalizePlatform(payload.platform) || null;
    if (!nextPlatform && /[a-f]/i.test(String(payload.appid || ""))) {
      nextPlatform = "epic";
    }
    nextPlatform = nextPlatform || "steam";
    payload.platform = nextPlatform;
    const oldCachePath = getCachePath(safeOld, prevPlatform || "steam");
    const newCachePath = getCachePath(safeNew, nextPlatform);

    // missing config_path, generate and set path
    if (
      !payload.config_path &&
      /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
    ) {
      try {
        global.mainWindow = BrowserWindow.fromWebContents(event.sender);
      } catch {}
      const res = await ensureSchemaForApp(payload.appid, payload.platform);
      if (res && res.dir) payload.config_path = res.dir;
    }
    try {
      const selForSave = isNonEmptyString(payload.save_path)
        ? payload.save_path
        : isNonEmptyString(payload.config_path)
          ? payload.config_path
          : null;

      if (
        isNonEmptyString(selForSave) &&
        fs.existsSync(selForSave) &&
        /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
      ) {
        const detectedBase = findSaveBaseFromSelection(
          selForSave,
          payload.appid,
        );
        if (detectedBase) payload.save_path = detectedBase;
      }
    } catch {}
    fs.writeFileSync(newConfigPath, JSON.stringify(payload, null, 2));

    if (fs.existsSync(oldCachePath)) {
      fs.renameSync(oldCachePath, newCachePath);
    }

    const managesSchemaPath = isManagedSchemaPath(prevConfig?.config_path);
    if (
      prevPlatform &&
      prevPlatform !== nextPlatform &&
      managesSchemaPath &&
      /^[0-9a-fA-F]+$/.test(String(payload.appid || ""))
    ) {
      ipcLogger.info("config:platform-change", {
        name: safeNew,
        appid: payload.appid,
        from: prevPlatform,
        to: nextPlatform,
      });
      try {
        const res = await ensureSchemaForApp(payload.appid, nextPlatform);
        if (res?.dir) {
          const current = JSON.parse(fs.readFileSync(newConfigPath, "utf8"));
          if (current.config_path !== res.dir) {
            current.config_path = res.dir;
            fs.writeFileSync(newConfigPath, JSON.stringify(current, null, 2));
          }
        }
      } catch (err) {
        ipcLogger.warn("renameConfig:schema-sync-failed", {
          appid: payload.appid,
          error: err?.message || String(err),
        });
      }
    }

    pendingMissingAchievementFiles.delete(safeOld);
    pendingMissingAchievementFiles.delete(safeNew);

    notifyConfigsChanged();
    return {
      success: true,
      message: tUi("main.message.configRenameSuccess", { name: oldName }),
    };
  } catch (error) {
    return { success: false, message: tUi("main.message.configRenameFailed") };
  }
});

ipcMain.on("close-notification-window", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }, global.animationDuration);
});

let overlayWindow = null;
let overlayInteractive = false;
let overlayPresented = false;
let overlayVisibilityAckTimer = null;
let overlayVisibilityAckState = null;
let overlayPendingVisibleAckShow = false;
let overlayVisibleAckSatisfied = false;
let overlayReadyToShow = false;
let overlayShownAtLeastOnce = false;
let overlayTopmostBoostTimer = null;
let overlayLastTopmostReassertAt = 0;
let registeredOverlayShortcut = null;
let registeredOverlayShortcutMode = null;
let registeredOverlayInteractShortcut = null;
let registeredOverlayInteractShortcutMode = null;
let overlayShortcutKeydownListener = null;
let overlayShortcutKeydownHook = null;
let overlayShortcutDirectBinding = null;
let overlayShortcutLastTriggeredAt = 0;
let overlayInteractKeydownListener = null;
let overlayInteractKeydownHook = null;
let overlayInteractDirectBinding = null;
let overlayInteractLastTriggeredAt = 0;
let registeredOverlayScrollPageUpShortcuts = [];
let registeredOverlayScrollPageDownShortcuts = [];
let registeredOverlayPositionShortcuts = [];
let overlaySnapCycleIndex = -1;
let overlayDragRegionHeight = 90;
let overlayDragActive = false;
let overlayDragOffset = null;
let overlayGlobalMouseHandlersAttached = false;
let overlayDragMouseDownListener = null;
let overlayDragMouseMoveListener = null;
let overlayDragMouseUpListener = null;
let overlayDragHookBootWaitTimer = null;
const OVERLAY_RENDERER_ACK_TIMEOUT_MS = 2500;
const OVERLAY_NUDGE_STEP_PX = 20;
const OVERLAY_SHORTCUT_PRIORITY_TOGGLE = 100;
const OVERLAY_SHORTCUT_PRIORITY_INTERACT = 90;
const OVERLAY_SHORTCUT_PRIORITY_SCROLL = 40;
const OVERLAY_SHORTCUT_PRIORITY_POSITION = 30;
const OVERLAY_SHORTCUT_REPEAT_COOLDOWN_MS = 200;

function isForceGlobalOverlayShortcutsEnabled(preferences = cachedPreferences) {
  return preferences?.forceGlobalOverlayShortcuts === true;
}

const OVERLAY_SNAP5_PRESETS = [
  { accelerator: "Control+Alt+Shift+1", x: 0, y: 0 },
  { accelerator: "Control+Alt+Shift+2", x: 1, y: 0 },
  { accelerator: "Control+Alt+Shift+3", x: 0.5, y: 0.5 },
  { accelerator: "Control+Alt+Shift+4", x: 0, y: 1 },
  { accelerator: "Control+Alt+Shift+5", x: 1, y: 1 },
];
const OVERLAY_SNAP9_NUMPAD_PRESETS = [
  {
    accelerators: [
      "Control+Alt+Shift+num1",
      "Control+Alt+Shift+Num1",
      "Control+Alt+Shift+Numpad1",
    ],
    x: 0,
    y: 1,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num2",
      "Control+Alt+Shift+Num2",
      "Control+Alt+Shift+Numpad2",
    ],
    x: 0.5,
    y: 1,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num3",
      "Control+Alt+Shift+Num3",
      "Control+Alt+Shift+Numpad3",
    ],
    x: 1,
    y: 1,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num4",
      "Control+Alt+Shift+Num4",
      "Control+Alt+Shift+Numpad4",
    ],
    x: 0,
    y: 0.5,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num5",
      "Control+Alt+Shift+Num5",
      "Control+Alt+Shift+Numpad5",
    ],
    x: 0.5,
    y: 0.5,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num6",
      "Control+Alt+Shift+Num6",
      "Control+Alt+Shift+Numpad6",
    ],
    x: 1,
    y: 0.5,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num7",
      "Control+Alt+Shift+Num7",
      "Control+Alt+Shift+Numpad7",
    ],
    x: 0,
    y: 0,
  },
  {
    accelerators: [
      "Control+Alt+Shift+num8",
      "Control+Alt+Shift+Num8",
      "Control+Alt+Shift+Numpad8",
    ],
    x: 0.5,
    y: 0,
  },
];
const POST_BOOT_UI_INITIAL_DELAY_MS = 350;
const POST_BOOT_UI_STEP_DELAY_MS = 300;
const POST_BOOT_ZOOM_DELAY_MS = 200;
let postBootUiInitScheduled = false;

function stopOverlayGlobalDrag() {
  overlayDragActive = false;
  overlayDragOffset = null;
}

function isOverlayUserDefinedShortcutConflict(conflict) {
  return conflict?.scope === "user";
}

function createRegisteredShortcutEntry(mode, token) {
  return { mode, token };
}

function clearRegisteredShortcutEntry(entry) {
  if (!entry) return;
  if (entry.mode === "low-level") {
    unregisterOverlayLowLevelBinding(entry.token);
    return;
  }
  if (entry.mode === "global" && entry.token) {
    try {
      globalShortcut.unregister(entry.token);
    } catch {}
  }
}

function clearRegisteredShortcutEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  for (const entry of entries) {
    clearRegisteredShortcutEntry(entry);
  }
}

function clearOverlayGlobalDragHookRegistration() {
  stopOverlayGlobalDrag();
  if (overlayDragHookBootWaitTimer) {
    clearTimeout(overlayDragHookBootWaitTimer);
    overlayDragHookBootWaitTimer = null;
  }
  if (overlayDragMouseDownListener) {
    overlayShortcutManager.off("mousedown", overlayDragMouseDownListener);
    overlayDragMouseDownListener = null;
  }
  if (overlayDragMouseMoveListener) {
    overlayShortcutManager.off("mousemove", overlayDragMouseMoveListener);
    overlayDragMouseMoveListener = null;
  }
  if (overlayDragMouseUpListener) {
    overlayShortcutManager.off("mouseup", overlayDragMouseUpListener);
    overlayDragMouseUpListener = null;
  }
  overlayGlobalMouseHandlersAttached = false;
}

function refreshOverlayInputBackend(reason = "unknown") {
  const forcedGlobal = isForceGlobalOverlayShortcutsEnabled();
  overlayLogger.info("overlay:input-backend:refresh", {
    reason,
    forcedGlobal,
    overlayPresented: isOverlayEffectivelyPresented(),
  });

  clearOverlayShortcutRegistration();
  clearOverlayInteractShortcut();
  clearOverlayKeyboardScrollShortcuts();
  clearOverlayPositionShortcuts();
  clearOverlayGlobalDragHookRegistration();
  overlayShortcutManager.shutdown();

  const overlayShortcut =
    typeof global.overlayShortcut === "string"
      ? global.overlayShortcut
      : cachedPreferences?.overlayShortcut;
  if (typeof overlayShortcut === "string" && overlayShortcut.trim()) {
    registerOverlayShortcut(overlayShortcut);
  }

  applyOverlayInteractShortcutRegistration();
  if (!forcedGlobal && overlayWindow && !overlayWindow.isDestroyed()) {
    scheduleOverlayDragHookAfterBootComplete();
  }
  if (!isOverlayEffectivelyPresented()) return;

  applyOverlayKeyboardScrollShortcutRegistration();
  applyOverlayPositionShortcutRegistration();
}

function summarizeOverlayShortcutRegistrationState() {
  return {
    interact:
      overlayInteractDirectBinding?.normalized ||
      (registeredOverlayInteractShortcutMode === "global"
        ? registeredOverlayInteractShortcut
        : null),
    scrollUp: registeredOverlayScrollPageUpShortcuts.length,
    scrollDown: registeredOverlayScrollPageDownShortcuts.length,
    position: registeredOverlayPositionShortcuts.length,
  };
}

function logOverlayShortcutRegistrationSummary(
  event,
  level = "info",
  extra = {},
) {
  const log =
    overlayLogger && typeof overlayLogger[level] === "function"
      ? overlayLogger[level].bind(overlayLogger)
      : overlayLogger.info.bind(overlayLogger);
  log(event, {
    ...summarizeOverlayShortcutRegistrationState(),
    ...extra,
  });
}

function normalizeOverlayLowLevelAccelerator(
  shortcut,
  { allowSingle = false } = {},
) {
  return normalizeOverlayShortcutAccelerator(shortcut, { allowSingle });
}

function parseOverlayShortcutConflictBinding(
  shortcut,
  { allowSingle = false, matchMode = "required" } = {},
) {
  const deps = getOverlayDirectKeyboardHookDeps();
  if (!deps?.keyMap) return null;
  return parseOverlayShortcutAccelerator(shortcut, {
    allowSingle,
    keyMap: deps.keyMap,
    matchMode,
  });
}

function createOverlayShortcutConflictSummary(
  binding,
  {
    id,
    source = id,
    scope = "builtin",
    priority = 0,
    shortcut = null,
    target = source,
  } = {},
) {
  if (!binding) return null;
  return {
    id,
    source,
    scope,
    shortcut: shortcut || binding.normalized,
    normalized: binding.normalized,
    keyName: binding.keyName,
    keycode: binding.triggerKey,
    priority: Number(priority) || 0,
    matchMode: binding.matchMode || "exact",
    target,
  };
}

function getOverlayShortcutConflictDisplayValue(conflict) {
  if (!conflict) return null;
  return (
    conflict.shortcut ||
    conflict.normalized ||
    conflict.target ||
    conflict.source ||
    null
  );
}

function getOverlayReservedBuiltInShortcutSpecs() {
  const specs = [];
  const pushMany = (
    source,
    accelerators,
    { allowSingle = false, priority = 0 } = {},
  ) => {
    if (!Array.isArray(accelerators) || !accelerators.length) return;
    accelerators.forEach((shortcut, index) => {
      specs.push({
        id: `${source}:${index}`,
        source,
        scope: "builtin",
        shortcut,
        allowSingle,
        matchMode: "exact",
        priority,
        target: source,
      });
    });
  };

  pushMany("overlay-scroll-up", ["PageUp", "Control+PageUp"], {
    allowSingle: true,
    priority: OVERLAY_SHORTCUT_PRIORITY_SCROLL,
  });
  pushMany("overlay-scroll-down", ["PageDown", "Control+PageDown"], {
    allowSingle: true,
    priority: OVERLAY_SHORTCUT_PRIORITY_SCROLL,
  });

  OVERLAY_SNAP5_PRESETS.forEach((preset, index) => {
    pushMany(`overlay-position:snap5:${index}`, [preset.accelerator], {
      allowSingle: false,
      priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
    });
  });
  OVERLAY_SNAP9_NUMPAD_PRESETS.forEach((preset, index) => {
    pushMany(`overlay-position:snap9:${index}`, preset.accelerators, {
      allowSingle: false,
      priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
    });
  });

  pushMany("overlay-position:cycle", ["Control+Alt+Shift+M"], {
    allowSingle: false,
    priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
  });
  pushMany("overlay-position:nudge-left", ["Control+Alt+Shift+Left"], {
    allowSingle: false,
    priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
  });
  pushMany("overlay-position:nudge-right", ["Control+Alt+Shift+Right"], {
    allowSingle: false,
    priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
  });
  pushMany("overlay-position:nudge-up", ["Control+Alt+Shift+Up"], {
    allowSingle: false,
    priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
  });
  pushMany("overlay-position:nudge-down", ["Control+Alt+Shift+Down"], {
    allowSingle: false,
    priority: OVERLAY_SHORTCUT_PRIORITY_POSITION,
  });

  return specs;
}

function getOverlayReservedBuiltInConflictCandidates() {
  const seen = new Set();
  const candidates = [];
  for (const spec of getOverlayReservedBuiltInShortcutSpecs()) {
    const binding = parseOverlayShortcutConflictBinding(spec.shortcut, {
      allowSingle: spec.allowSingle === true,
      matchMode: spec.matchMode || "exact",
    });
    if (!binding) continue;
    const signature = getOverlayShortcutBindingSignature(binding);
    const dedupeKey = `${spec.source}:${signature || binding.normalized}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({
      binding,
      summary: createOverlayShortcutConflictSummary(binding, spec),
    });
  }
  return candidates;
}

function dedupeOverlayShortcutAccelerators(
  accelerators,
  { allowSingle = false, matchMode = "exact", source = "" } = {},
) {
  if (!Array.isArray(accelerators) || !accelerators.length) return [];
  const seen = new Set();
  const deduped = [];
  for (const accelerator of accelerators) {
    if (typeof accelerator !== "string" || !accelerator.trim()) continue;
    const normalized = normalizeOverlayShortcutAccelerator(accelerator, {
      allowSingle,
    });
    if (!normalized) continue;
    const binding = parseOverlayShortcutConflictBinding(normalized, {
      allowSingle,
      matchMode,
    });
    const signature = binding
      ? getOverlayShortcutBindingSignature(binding)
      : `${matchMode}:${normalized}`;
    const dedupeKey = `${source}:${signature}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(accelerator);
  }
  return deduped;
}

function findOverlayShortcutConflicts(
  shortcut,
  {
    allowSingle = false,
    matchMode = "required",
    otherShortcuts = [],
    includeReservedBuiltins = true,
  } = {},
) {
  const parsed = parseOverlayShortcutConflictBinding(shortcut, {
    allowSingle,
    matchMode,
  });
  if (!parsed) return { parsed: null, conflicts: [] };

  const conflicts = [];
  const seen = new Set();
  const pushConflict = (binding, meta) => {
    if (!binding || !meta) return;
    const signature = getOverlayShortcutBindingSignature(binding);
    const conflictKey = `${meta.scope || "builtin"}:${meta.source || meta.id}:${signature || binding.normalized}`;
    if (seen.has(conflictKey)) return;
    seen.add(conflictKey);
    conflicts.push(createOverlayShortcutConflictSummary(binding, meta));
  };

  for (const other of otherShortcuts) {
    if (!other?.shortcut) continue;
    const otherBinding = parseOverlayShortcutConflictBinding(other.shortcut, {
      allowSingle: other.allowSingle === true,
      matchMode: other.matchMode || "required",
    });
    if (!otherBinding) continue;
    if (!overlayBindingsCanConflict(parsed, otherBinding)) continue;
    pushConflict(otherBinding, {
      id: other.id,
      source: other.source || other.id,
      scope: other.scope || "user",
      priority: Number(other.priority) || 0,
      shortcut: other.shortcut,
      target: other.target || other.source || other.id,
    });
  }

  if (includeReservedBuiltins) {
    for (const reserved of getOverlayReservedBuiltInConflictCandidates()) {
      if (!overlayBindingsCanConflict(parsed, reserved.binding)) continue;
      pushConflict(reserved.binding, reserved.summary);
    }
  }

  return { parsed, conflicts };
}

function getOverlayDirectKeyboardHookDeps() {
  if (isForceGlobalOverlayShortcutsEnabled()) return null;
  const deps = overlayShortcutManager.getHookDeps();
  if (!deps?.hook || !deps?.keyMap) return null;
  return deps;
}

function ensureOverlayDirectKeyboardHookStarted(reason = "overlay-direct") {
  const deps = getOverlayDirectKeyboardHookDeps();
  if (!deps) return null;
  if (!overlayShortcutManager.ensureStarted(reason)) return null;
  return deps;
}

function getOverlayDirectBindingTriggerKeys(binding) {
  if (!binding) return [];
  if (Array.isArray(binding.triggerKeys) && binding.triggerKeys.length) {
    return binding.triggerKeys
      .map((keycode) => Number(keycode))
      .filter((keycode) => Number.isFinite(keycode));
  }
  const triggerKey = Number(binding.triggerKey);
  return Number.isFinite(triggerKey) ? [triggerKey] : [];
}

function matchesOverlayDirectKeyboardShortcut(binding, event) {
  if (!binding || !event) return false;
  if (
    !getOverlayDirectBindingTriggerKeys(binding).includes(Number(event.keycode))
  ) {
    return false;
  }
  if (binding.requireCtrl && !event.ctrlKey) return false;
  if (binding.requireShift && !event.shiftKey) return false;
  if (binding.requireAlt && !event.altKey) return false;
  if (binding.requireMeta && !event.metaKey) return false;
  return true;
}

function summarizeOverlayDirectKeyboardBinding(binding, id, source) {
  if (!binding) return null;
  return {
    id,
    source,
    normalized: binding.normalized,
    keyName: binding.keyName,
    keycode: binding.triggerKey,
    keycodes: getOverlayDirectBindingTriggerKeys(binding),
    matchMode: binding.matchMode,
  };
}

function summarizeOverlayDirectKeyboardEvent(event) {
  return {
    keycode: Number(event?.keycode),
    ctrlKey: !!event?.ctrlKey,
    shiftKey: !!event?.shiftKey,
    altKey: !!event?.altKey,
    metaKey: !!event?.metaKey,
  };
}

function removeOverlayDirectKeydownListener(hook, listener) {
  if (!hook || typeof listener !== "function") return;
  try {
    hook.off("keydown", listener);
  } catch {}
}

function tryRegisterDirectOverlayShortcut(
  id,
  shortcut,
  {
    allowSingle = false,
    cooldownMs = 0,
    source = id,
    onFire,
    getLastTriggeredAt = () => 0,
    setLastTriggeredAt = () => {},
    setListener = () => {},
    setHook = () => {},
    setBinding = () => {},
  } = {},
) {
  const deps = ensureOverlayDirectKeyboardHookStarted(source);
  if (!deps) return { ok: false, reason: "hook-unavailable" };

  const parsed = parseOverlayShortcutAccelerator(shortcut, {
    allowSingle,
    keyMap: deps.keyMap,
    matchMode: "required",
  });
  if (!parsed) {
    overlayLogger.warn("overlay:shortcut:parse-failed", {
      id,
      shortcut,
      allowSingle,
      matchMode: "required",
    });
    return { ok: false, reason: "invalid-shortcut" };
  }

  const listener = (event) => {
    if (
      !getOverlayDirectBindingTriggerKeys(parsed).includes(
        Number(event?.keycode),
      )
    ) {
      return;
    }

    overlayLogger.debug("overlay:input-hook:keydown", {
      source,
      event: summarizeOverlayDirectKeyboardEvent(event),
      candidates: [summarizeOverlayDirectKeyboardBinding(parsed, id, source)],
    });

    if (!matchesOverlayDirectKeyboardShortcut(parsed, event)) {
      overlayLogger.debug("overlay:input-hook:keydown-result", {
        source,
        event: summarizeOverlayDirectKeyboardEvent(event),
        matchedIds: [],
        skippedActiveIds: [],
        skippedCooldownIds: [],
        whenRejectedIds: [],
        firedIds: [],
      });
      return;
    }

    const now = Date.now();
    if (
      cooldownMs > 0 &&
      now - (Number(getLastTriggeredAt()) || 0) < cooldownMs
    ) {
      overlayLogger.debug("overlay:input-hook:keydown-result", {
        source,
        event: summarizeOverlayDirectKeyboardEvent(event),
        matchedIds: [id],
        skippedActiveIds: [],
        skippedCooldownIds: [id],
        whenRejectedIds: [],
        firedIds: [],
      });
      return;
    }

    setLastTriggeredAt(now);
    try {
      onFire?.(event, parsed);
      overlayLogger.debug("overlay:input-hook:keydown-result", {
        source,
        event: summarizeOverlayDirectKeyboardEvent(event),
        matchedIds: [id],
        skippedActiveIds: [],
        skippedCooldownIds: [],
        whenRejectedIds: [],
        firedIds: [id],
      });
    } catch (err) {
      overlayLogger.warn("overlay:shortcut:fire-failed", {
        id,
        error: err?.message || String(err),
      });
    }
  };

  deps.hook.on("keydown", listener);
  setListener(listener);
  setHook(deps.hook);
  setBinding(parsed);
  overlayLogger.debug("overlay:shortcut:registered", {
    id,
    shortcut,
    normalized: parsed.normalized,
    keyName: parsed.keyName,
    keycode: parsed.triggerKey,
    keycodes: getOverlayDirectBindingTriggerKeys(parsed),
    priority: null,
    matchMode: parsed.matchMode,
    mode: "direct",
    conflicts: [],
  });
  return { ok: true, parsed };
}

function registerOverlayLowLevelBinding(id, shortcut, options = {}) {
  if (isForceGlobalOverlayShortcutsEnabled()) {
    return { ok: false, reason: "hook-unavailable" };
  }
  return overlayShortcutManager.registerBinding(id, shortcut, {
    allowSingle: options.allowSingle === true,
    continueOnMatch: options.continueOnMatch === true,
    cooldownMs: Number(options.cooldownMs) || 0,
    matchMode: options.matchMode || "exact",
    onFire: options.onFire,
    priority: Number(options.priority) || 0,
    rejectOnConflict: options.rejectOnConflict,
    scope: options.scope || "builtin",
    source: options.source || id,
    when: options.when,
  });
}

function unregisterOverlayLowLevelBinding(id) {
  overlayShortcutManager.unregisterBinding(id);
}

function buildElectronAcceleratorCandidates(
  shortcut,
  { allowSingle = false } = {},
) {
  const normalized = normalizeOverlayShortcutAccelerator(shortcut, {
    allowSingle,
  });
  if (!normalized) return [];

  const parts = normalized
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return [];

  const out = [];
  const push = (value) => {
    if (!value || out.includes(value)) return;
    out.push(value);
  };
  const join = (mapper) => parts.map(mapper).join("+");
  const translateElectronToken = (token) => {
    switch (token) {
      case "ArrowLeft":
        return "Left";
      case "ArrowRight":
        return "Right";
      case "ArrowUp":
        return "Up";
      case "ArrowDown":
        return "Down";
      case "Meta":
        return "Super";
      default:
        return token;
    }
  };

  push(parts.join("+"));
  push(join((token) => translateElectronToken(token)));
  push(join((token) => (token === "\\" ? "Backslash" : token)));
  push(join((token) => (/^backslash$/i.test(token) ? "\\" : token)));
  push(
    join((token) =>
      token === "\\" || /^backslash$/i.test(token) ? "Oem5" : token,
    ),
  );
  push(
    join((token) =>
      token === "\\" || /^backslash$/i.test(token) ? "OEM_5" : token,
    ),
  );

  return out;
}

function tryRegisterGlobalShortcutCandidates(candidates, onFire) {
  let lastErr = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") continue;
    try {
      const registered = globalShortcut.register(candidate, onFire);
      if (registered) {
        return { ok: true, accelerator: candidate };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr };
}

function registerOverlayBindingWithFallback({
  id,
  shortcut,
  allowSingle = false,
  priority = 0,
  cooldownMs = 0,
  scope = "builtin",
  source = id,
  rejectOnConflict = false,
  onFire,
  matchMode = "exact",
  fallbackCandidates = null,
}) {
  const lowLevelResult = registerOverlayLowLevelBinding(id, shortcut, {
    allowSingle,
    cooldownMs,
    matchMode,
    onFire,
    priority,
    rejectOnConflict,
    scope,
    source,
  });

  if (lowLevelResult.ok) {
    return {
      ...lowLevelResult,
      entry: createRegisteredShortcutEntry("low-level", id),
    };
  }

  if (lowLevelResult.reason !== "hook-unavailable") {
    return lowLevelResult;
  }

  const candidates =
    Array.isArray(fallbackCandidates) && fallbackCandidates.length
      ? fallbackCandidates
      : buildElectronAcceleratorCandidates(shortcut, { allowSingle });
  const fallbackResult = tryRegisterGlobalShortcutCandidates(
    candidates,
    onFire,
  );
  if (!fallbackResult.ok) {
    overlayLogger.warn("overlay:shortcut:fallback-failed", {
      id,
      shortcut,
      candidates,
      error: fallbackResult.error?.message || null,
    });
    return {
      ok: false,
      reason: "hook-unavailable",
      error: fallbackResult.error || null,
    };
  }

  overlayLogger.warn("overlay:shortcut:fallback-registered", {
    id,
    shortcut,
    accelerator: fallbackResult.accelerator,
    candidates,
  });
  return {
    ok: true,
    entry: createRegisteredShortcutEntry("global", fallbackResult.accelerator),
    parsed: null,
    conflicts: [],
    fallback: true,
  };
}

function clearOverlayShortcutRegistration() {
  if (overlayShortcutDirectBinding) {
    overlayLogger.debug("overlay:shortcut:unregistered", {
      id: "overlay-shortcut",
      normalized: overlayShortcutDirectBinding.normalized,
      mode: "direct",
    });
  }
  removeOverlayDirectKeydownListener(
    overlayShortcutKeydownHook,
    overlayShortcutKeydownListener,
  );
  overlayShortcutKeydownListener = null;
  overlayShortcutKeydownHook = null;
  overlayShortcutDirectBinding = null;
  overlayShortcutLastTriggeredAt = 0;
  unregisterOverlayLowLevelBinding("overlay-shortcut");
  if (
    registeredOverlayShortcutMode === "global" &&
    registeredOverlayShortcut &&
    typeof registeredOverlayShortcut === "string"
  ) {
    try {
      globalShortcut.unregister(registeredOverlayShortcut);
    } catch {}
  }
  registeredOverlayShortcut = null;
  registeredOverlayShortcutMode = null;
}

function validateOverlayShortcutPreferencePair(preferences) {
  const overlayShortcutValue =
    typeof preferences?.overlayShortcut === "string"
      ? preferences.overlayShortcut.trim()
      : "";
  const overlayInteractValue =
    typeof preferences?.overlayInteractShortcut === "string"
      ? preferences.overlayInteractShortcut.trim()
      : "";

  const normalizedOverlayShortcut = overlayShortcutValue
    ? normalizeOverlayShortcutAccelerator(overlayShortcutValue, {
        allowSingle: false,
      })
    : null;
  const normalizedOverlayInteract = overlayInteractValue
    ? normalizeOverlayShortcutAccelerator(overlayInteractValue, {
        allowSingle: true,
      })
    : null;

  if (overlayShortcutValue && !normalizedOverlayShortcut) {
    return {
      key: "overlayShortcut",
      reason: "invalid",
      shortcut: overlayShortcutValue,
    };
  }
  if (overlayInteractValue && !normalizedOverlayInteract) {
    return {
      key: "overlayInteractShortcut",
      reason: "invalid",
      shortcut: overlayInteractValue,
    };
  }

  const overlayShortcutConflict = overlayShortcutValue
    ? findOverlayShortcutConflicts(overlayShortcutValue, {
        allowSingle: false,
        matchMode: "required",
        otherShortcuts: overlayInteractValue
          ? [
              {
                id: "overlay-interact",
                source: "overlay-interact",
                scope: "user",
                shortcut: overlayInteractValue,
                allowSingle: true,
                matchMode: "required",
                priority: OVERLAY_SHORTCUT_PRIORITY_INTERACT,
                target: "overlayInteractShortcut",
              },
            ]
          : [],
      })
    : null;
  if (overlayShortcutConflict?.conflicts?.length) {
    const firstConflict = overlayShortcutConflict.conflicts[0];
    return {
      key: "overlayShortcut",
      reason: "conflict",
      shortcut: overlayShortcutValue,
      conflictWith: getOverlayShortcutConflictDisplayValue(firstConflict),
      conflictSource: firstConflict?.source || null,
      conflicts: overlayShortcutConflict.conflicts,
      resetKey:
        firstConflict?.scope === "user"
          ? "overlayInteractShortcut"
          : "overlayShortcut",
    };
  }

  const overlayInteractConflict = overlayInteractValue
    ? findOverlayShortcutConflicts(overlayInteractValue, {
        allowSingle: true,
        matchMode: "required",
        otherShortcuts: overlayShortcutValue
          ? [
              {
                id: "overlay-shortcut",
                source: "overlay-shortcut",
                scope: "user",
                shortcut: overlayShortcutValue,
                allowSingle: false,
                matchMode: "required",
                priority: OVERLAY_SHORTCUT_PRIORITY_TOGGLE,
                target: "overlayShortcut",
              },
            ]
          : [],
      })
    : null;
  if (overlayInteractConflict?.conflicts?.length) {
    const firstConflict = overlayInteractConflict.conflicts[0];
    return {
      key: "overlayInteractShortcut",
      reason: "conflict",
      shortcut: overlayInteractValue,
      conflictWith: getOverlayShortcutConflictDisplayValue(firstConflict),
      conflictSource: firstConflict?.source || null,
      conflicts: overlayInteractConflict.conflicts,
      resetKey: "overlayInteractShortcut",
    };
  }

  if (
    !getOverlayDirectKeyboardHookDeps() &&
    normalizedOverlayShortcut &&
    normalizedOverlayInteract &&
    normalizedOverlayShortcut === normalizedOverlayInteract
  ) {
    return {
      key: "overlayShortcut",
      reason: "conflict",
      shortcut: overlayShortcutValue,
      conflictWith: overlayInteractValue,
      conflictSource: "overlay-interact",
      resetKey: "overlayInteractShortcut",
    };
  }

  return null;
}

function applyOverlayShortcutConflictFallback(preferences, validation) {
  if (!preferences || !validation || validation.reason !== "conflict") {
    return preferences;
  }

  const resolved = { ...preferences };
  const primaryResetKey =
    validation.resetKey || validation.key || "overlayInteractShortcut";
  const alternateResetKey =
    primaryResetKey === "overlayShortcut"
      ? "overlayInteractShortcut"
      : primaryResetKey === "overlayInteractShortcut"
        ? "overlayShortcut"
        : null;

  const primaryDefault = Object.prototype.hasOwnProperty.call(
    DEFAULT_PREFERENCES,
    primaryResetKey,
  )
    ? DEFAULT_PREFERENCES[primaryResetKey]
    : "";
  if (resolved[primaryResetKey] !== primaryDefault) {
    resolved[primaryResetKey] = primaryDefault;
    return resolved;
  }

  if (!alternateResetKey) return resolved;
  const alternateDefault = Object.prototype.hasOwnProperty.call(
    DEFAULT_PREFERENCES,
    alternateResetKey,
  )
    ? DEFAULT_PREFERENCES[alternateResetKey]
    : "";
  resolved[alternateResetKey] = alternateDefault;
  return resolved;
}

function resolveOverlayShortcutPreferenceConflicts(preferences) {
  let resolved = {
    overlayShortcut:
      typeof preferences?.overlayShortcut === "string"
        ? preferences.overlayShortcut
        : "",
    overlayInteractShortcut:
      typeof preferences?.overlayInteractShortcut === "string"
        ? preferences.overlayInteractShortcut
        : DEFAULT_PREFERENCES.overlayInteractShortcut,
  };
  let validation = validateOverlayShortcutPreferencePair(resolved);

  for (
    let attempt = 0;
    attempt < 3 && validation?.reason === "conflict";
    attempt += 1
  ) {
    const nextResolved = applyOverlayShortcutConflictFallback(
      resolved,
      validation,
    );
    if (
      nextResolved.overlayShortcut === resolved.overlayShortcut &&
      nextResolved.overlayInteractShortcut === resolved.overlayInteractShortcut
    ) {
      break;
    }
    resolved = nextResolved;
    validation = validateOverlayShortcutPreferencePair(resolved);
  }

  return { resolved, validation };
}

function isOverlayDragEligible(point) {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayPresented ||
    !overlayWindow.isVisible() ||
    !overlayInteractive
  ) {
    return false;
  }
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return false;
  }
  let bounds;
  try {
    bounds = overlayWindow.getBounds();
  } catch {
    return false;
  }
  if (!bounds || typeof bounds.x !== "number" || typeof bounds.y !== "number") {
    return false;
  }
  const inX =
    point.x >= bounds.x && point.x <= bounds.x + Math.max(0, bounds.width);
  if (!inX) return false;
  const dragHeight = Math.min(
    Math.max(0, bounds.height),
    Math.max(0, Number(overlayDragRegionHeight) || 0),
  );
  return point.y >= bounds.y && point.y <= bounds.y + dragHeight;
}

function initOverlayGlobalDragHook() {
  if (isForceGlobalOverlayShortcutsEnabled()) return;
  if (overlayGlobalMouseHandlersAttached) {
    overlayShortcutManager.ensureStarted("mouse");
    return;
  }

  overlayDragMouseDownListener = (event) => {
    if (event?.button !== 1) return;
    const point = { x: Number(event.x), y: Number(event.y) };
    if (!isOverlayDragEligible(point)) return;
    let bounds;
    try {
      bounds = overlayWindow.getBounds();
    } catch {
      return;
    }
    overlayDragActive = true;
    overlayDragOffset = {
      x: point.x - bounds.x,
      y: point.y - bounds.y,
    };
  };

  overlayDragMouseMoveListener = (event) => {
    if (!overlayDragActive || !overlayDragOffset) return;
    if (
      !overlayWindow ||
      overlayWindow.isDestroyed() ||
      !overlayPresented ||
      !overlayWindow.isVisible() ||
      !overlayInteractive
    ) {
      stopOverlayGlobalDrag();
      return;
    }
    const point = { x: Number(event.x), y: Number(event.y) };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const nextX = Math.round(point.x - overlayDragOffset.x);
    const nextY = Math.round(point.y - overlayDragOffset.y);
    try {
      // Reposition only; do not activate/focus the window while dragging.
      overlayWindow.setPosition(nextX, nextY, false);
    } catch {}
  };

  overlayDragMouseUpListener = (event) => {
    if (event?.button !== 1) return;
    stopOverlayGlobalDrag();
  };

  const attached = [
    overlayShortcutManager.on("mousedown", overlayDragMouseDownListener),
    overlayShortcutManager.on("mousemove", overlayDragMouseMoveListener),
    overlayShortcutManager.on("mouseup", overlayDragMouseUpListener),
  ];
  if (attached.some((result) => result !== true)) {
    overlayShortcutManager.off("mousedown", overlayDragMouseDownListener);
    overlayShortcutManager.off("mousemove", overlayDragMouseMoveListener);
    overlayShortcutManager.off("mouseup", overlayDragMouseUpListener);
    overlayDragMouseDownListener = null;
    overlayDragMouseMoveListener = null;
    overlayDragMouseUpListener = null;
    overlayLogger.warn("overlay:drag-hook:attach-failed");
    return;
  }

  overlayGlobalMouseHandlersAttached = true;
  overlayShortcutManager.ensureStarted("mouse");
}

function isOverlayDragHookEligible() {
  if (isForceGlobalOverlayShortcutsEnabled()) return false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  if (global.bootDone !== true || global.bootUiReady !== true) return false;
  if (global.bootManualSeedComplete !== true) return false;
  return true;
}

function scheduleOverlayDragHookAfterBootComplete() {
  if (isForceGlobalOverlayShortcutsEnabled()) return;
  if (overlayGlobalMouseHandlersAttached) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayDragHookBootWaitTimer) return;
  const waitAndStart = () => {
    if (overlayGlobalMouseHandlersAttached) {
      overlayDragHookBootWaitTimer = null;
      return;
    }
    if (isOverlayDragHookEligible()) {
      overlayDragHookBootWaitTimer = null;
      initOverlayGlobalDragHook();
      return;
    }
    overlayDragHookBootWaitTimer = setTimeout(waitAndStart, 500);
  };
  waitAndStart();
}

function schedulePostBootUiInitialization() {
  if (postBootUiInitScheduled) return;
  postBootUiInitScheduled = true;

  const runSteps = () => {
    const steps = [
      () => {
        if (!tray || tray.isDestroyed?.()) {
          createTray();
        }
      },
    ];

    steps.forEach((step, index) => {
      const delay =
        POST_BOOT_UI_INITIAL_DELAY_MS + index * POST_BOOT_UI_STEP_DELAY_MS;
      setTimeout(step, delay);
    });
  };

  if (!mainWindow || mainWindow.isDestroyed()) {
    runSteps();
    return;
  }

  if (mainWindow.webContents.isLoading()) {
    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      runSteps();
    };
    mainWindow.webContents.once("did-finish-load", startOnce);
    setTimeout(startOnce, 1500);
    return;
  }

  runSteps();
}

function createOverlayWindow(selectedConfig, initialPresented = true) {
  overlayLogger.debug("create-overlay:start", {
    selectedConfig: selectedConfig || null,
    initialPresented: !!initialPresented,
  });
  const { width, height } =
    require("electron").screen.getPrimaryDisplay().workAreaSize;
  try {
    overlayWindow = new BrowserWindow({
      width: 450,
      height: 950,
      // Create hidden; keep it non-focusable and only present it after the
      // renderer confirms it is ready to render visible content.
      show: false,
      x: width - 470,
      y: 20,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      focusable: false,
      hasShadow: false,
      fullscreenable: false,
      type: "notification",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
  } catch (err) {
    overlayWindow = null;
    overlayLogger.error("create-overlay:create-failed", {
      error: err?.message || String(err),
      stack: err?.stack,
      selectedConfig: selectedConfig || null,
      initialPresented: !!initialPresented,
    });
    throw err;
  }
  overlayPresented = !!initialPresented;
  overlayReadyToShow = false;
  overlayVisibleAckSatisfied = false;
  overlayPendingVisibleAckShow = overlayPresented;
  overlayLogger.debug("create-overlay:browserwindow-created", {
    width: 450,
    height: 950,
    position: { x: width - 470, y: 20 },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  // Keep this as one-time setup; avoid frequent retoggles during runtime moves/snaps.
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setFocusable(false);
  overlayWindow.setSkipTaskbar(true);
  setOverlayWindowOpacitySafely(0, "createOverlayWindow:initial");
  //setOverlayInteractive(false);
  const iconUrl = pathToFileURL(ICON_PNG_PATH).toString();
  overlayWindow
    .loadFile("overlay.html", { query: { icon: iconUrl } })
    .catch((err) => {
      overlayLogger.error("create-overlay:load-file-failed", {
        error: err?.message || String(err),
        stack: err?.stack,
        icon: iconUrl,
        state: getOverlayWindowLogState(),
      });
    });
  overlayLogger.debug("create-overlay:load-file", { icon: iconUrl });

  // Defensive: re-apply click-through after the window is actually visible (race safety).
  overlayWindow.once("ready-to-show", () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayReadyToShow = true;
    overlayLogger.debug("create-overlay:ready-to-show", {
      initialPresented: overlayPresented,
    });
    try {
      setOverlayInteractive(false);
    } catch {}
    if (overlayPresented) {
      maybeShowOverlayAfterRendererReady("createOverlayWindow:ready-to-show");
    } else {
      overlayLogger.debug("create-overlay:ready-hidden", {
        initialPresented: false,
      });
    }
    setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      if (overlayPresented) {
        if (!overlayInteractive) applyOverlayInputMode();
        applyOverlayFocusMode();
        applyOverlayInteractShortcutRegistration();
        applyOverlayKeyboardScrollShortcutRegistration();
        applyOverlayPositionShortcutRegistration();
      } else {
        if (!overlayInteractive) applyOverlayInputMode();
        clearOverlayInteractShortcut();
        clearOverlayKeyboardScrollShortcuts();
        clearOverlayPositionShortcuts();
        overlaySnapCycleIndex = -1;
      }
    }, 50);
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayLogger.debug("create-overlay:did-finish-load", {
      selectedConfig: selectedConfig || null,
    });
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", {
      language: selectedLanguage,
      uiLanguage: selectedUiLanguage,
    });
    const dispatched = sendOverlayVisibility(
      overlayPresented,
      "createOverlayWindow:did-finish-load",
    );
    if (overlayPresented && !dispatched) {
      overlayVisibleAckSatisfied = true;
      maybeShowOverlayAfterRendererReady(
        "createOverlayWindow:did-finish-load:visibility-dispatch-failed",
      );
    }
    if (sharedAchievementTableViewState) {
      try {
        overlayWindow.webContents.send(
          "ach-table:view-state",
          sharedAchievementTableViewState,
        );
      } catch {}
    }
  });

  overlayWindow.on("closed", () => {
    overlayLogger.info("create-overlay:closed");
    clearOverlayVisibilityAckTimeout();
    clearOverlayTopmostBoostTimer();
    stopOverlayGlobalDrag();
    overlayWindow = null;
    overlayInteractive = false;
    overlayPresented = false;
    overlayReadyToShow = false;
    clearOverlayPendingShowState();
    overlayShownAtLeastOnce = false;
    clearOverlayInteractShortcut();
    clearOverlayKeyboardScrollShortcuts();
    clearOverlayPositionShortcuts();
    overlaySnapCycleIndex = -1;
  });

  overlayWindow.on("show", () => {
    overlayPresented = true;
    overlayShownAtLeastOnce = true;
    clearOverlayPendingShowState();
    overlayLogger.info("create-overlay:show", {
      presented: overlayPresented,
      visible: overlayWindow?.isVisible?.() || false,
    });
    if (Date.now() - overlayLastTopmostReassertAt > 250) {
      reassertOverlayAlwaysOnTop("overlay-window:show");
    } else {
      overlayLogger.debug("overlay:always-on-top:show-skip-reassert", {
        reason: "recent-pre-show-reassert",
        elapsedMs: Date.now() - overlayLastTopmostReassertAt,
      });
    }
    // Always start in click-through mode when the overlay is shown.
    setOverlayInteractive(false);
    applyOverlayInteractShortcutRegistration();
    // // Race safety: some environments briefly accept input on show.
    setTimeout(() => {
      if (
        !overlayWindow ||
        overlayWindow.isDestroyed() ||
        !overlayWindow.isVisible()
      )
        return;
      setOverlayWindowOpacitySafely(1, "overlay-window:show:reveal");
      if (!overlayInteractive) applyOverlayInputMode();
      applyOverlayFocusMode();
      applyOverlayKeyboardScrollShortcutRegistration();
      applyOverlayPositionShortcutRegistration();
    }, 50);
  });

  overlayWindow.on("hide", () => {
    overlayPresented = false;
    clearOverlayPendingShowState();
    clearOverlayVisibilityAckTimeout();
    overlayLogger.info("create-overlay:hide", {
      presented: overlayPresented,
    });
    setOverlayInteractive(false);
    applyOverlayInteractShortcutRegistration();
    clearOverlayKeyboardScrollShortcuts();
    clearOverlayPositionShortcuts();
    overlaySnapCycleIndex = -1;
    stopOverlayGlobalDrag();
  });

  overlayWindow.on("unresponsive", () => {
    overlayLogger.warn("create-overlay:unresponsive", {
      state: getOverlayWindowLogState(),
    });
  });

  overlayWindow.on("responsive", () => {
    overlayLogger.debug("create-overlay:responsive", {
      state: getOverlayWindowLogState(),
    });
  });

  overlayWindow.webContents.on("dom-ready", () => {
    overlayLogger.debug("create-overlay:dom-ready", {
      state: getOverlayWindowLogState(),
    });
  });

  overlayWindow.webContents.on(
    "did-fail-load",
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      overlayLogger.error("create-overlay:did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        state: getOverlayWindowLogState(),
      });
      if (isMainFrame === false) return;
      try {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.destroy();
        }
      } catch {}
    },
  );

  overlayWindow.webContents.on("render-process-gone", (_event, details) => {
    overlayLogger.error("create-overlay:render-gone", {
      reason: details?.reason,
      exitCode: details?.exitCode,
      state: getOverlayWindowLogState(),
    });
    try {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.destroy();
      }
    } catch {}
  });

  scheduleOverlayDragHookAfterBootComplete();

  // Intentionally avoid blur-driven state changes here. The overlay is designed to be non-focusable.
}

ipcMain.handle("selectExecutable", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle("launchExecutable", async (_event, exePath, argsString) => {
  try {
    if (!exePath) {
      notifyError(tUi("main.notify.executable.pathMissing"));
      return;
    }
    const args = splitArgsString(argsString);
    const child = spawn(exePath, args, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        notifyError(tUi("main.notify.executable.notFound", { path: exePath }));
      } else if (err.code === "EACCES") {
        notifyError(
          "❌ Permission denied. Try running the app as administrator or check file permissions.",
        );
      } else {
        notifyError(
          tUi("main.notify.executable.launchFailed", { error: err.message }),
        );
      }
    });
    child.unref();

    if (selectedConfig) {
      const configPath = path.join(configsDir, `${selectedConfig}.json`);
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (isProcessNameWatcherEnabled(cachedPreferences)) {
          const safeConfigName = sanitizeConfigName(selectedConfig);
          configData.__playtimeKey = safeConfigName;
          if (child?.pid) {
            configData.__launchPid = child.pid;
            manualLaunchPidMap.set(child.pid, selectedConfig);
            setTimeout(() => {
              if (manualLaunchPidMap.get(child.pid) === selectedConfig) {
                manualLaunchPidMap.delete(child.pid);
              }
            }, 120000);
          }
          manualLaunchInProgress = true;
          detectedConfigName = configData.name;
          activePlaytimeConfigs.add(configData.name);
          startPlaytimeLogWatcher(configData);
        } else {
          appLogger.info("process-poller:playtime-watch-skipped", {
            reason: "process-watcher-disabled",
            config: selectedConfig,
            appid: String(configData?.appid || ""),
          });
        }
      } else {
        notifyError(
          tUi("main.notify.config.notFound", { config: selectedConfig }),
        );
      }
    } else {
      notifyError(
        `❌ selectedConfig is null – cannot start playtime log watcher.`,
      );
    }
  } catch (err) {
    notifyError(
      tUi("main.notify.executable.launchFailed", { error: err.message }),
    );
  }
});

let currentAppId = null;

ipcMain.on("toggle-overlay", (_event, selectedConfig) => {
  if (!selectedConfig) {
    if (isOverlayEffectivelyPresented()) {
      setOverlayPresented(false);
    }
    return;
  }
  if (isBootOnboardingGatePending() || global.bootOnboardingRequired) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow(selectedConfig);
  } else {
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", {
      language: selectedLanguage,
      uiLanguage: selectedUiLanguage,
    });
    if (!isOverlayEffectivelyPresented()) {
      setOverlayPresented(true);
    }
  }
});

// Handle request for current config from overlay
ipcMain.on("request-current-config", (event) => {
  if (selectedConfig) {
    event.sender.send("load-overlay-data", selectedConfig);
    event.sender.send("set-language", {
      language: selectedLanguage,
      uiLanguage: selectedUiLanguage,
    });
    if (sharedAchievementTableViewState) {
      event.sender.send(
        "ach-table:view-state",
        sharedAchievementTableViewState,
      );
    }
  }
});

ipcMain.on("ach-table:view-state", (_event, payload) => {
  const normalized = normalizeAchievementTableViewState(payload);
  if (!normalized) return;
  sharedAchievementTableViewState = normalized;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send("ach-table:view-state", normalized);
    } catch {}
  }
});

ipcMain.on(
  "refresh-ui-after-language-change",
  (event, { language, configName, uiLanguage }) => {
    const effectiveUiLang = normalizeUiLanguage(
      uiLanguage ||
        (cachedPreferences && cachedPreferences.uiLanguage) ||
        language ||
        selectedLanguage ||
        "english",
    );

    if (language) {
      selectedLanguage = language;
    }
    selectedUiLanguage = effectiveUiLang;
    // keep in-memory prefs aligned so tUi() uses the right locale
    if (cachedPreferences && typeof cachedPreferences === "object") {
      cachedPreferences.uiLanguage = effectiveUiLang;
      if (language) cachedPreferences.language = language;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("refresh-achievements-table", configName);
    }

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", {
        language: selectedLanguage,
        uiLanguage: selectedUiLanguage,
      });
    }
    broadcastToAll("tray:language-changed", { language: selectedUiLanguage });
  },
);

function minimizeWindow() {
  if (mainWindow) mainWindow.hide();
}

function maximizeWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
}

function closeWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const shouldCloseToTray =
      cachedPreferences?.closeToTray === true || global.closeToTray === true;
    if (shouldCloseToTray && !isQuitting) {
      mainWindow.hide();
      return;
    }
  }
  isQuitting = true;
  app.quit();
}

ipcMain.on("minimize-window", minimizeWindow);
ipcMain.on("maximize-window", maximizeWindow);
ipcMain.on("close-window", closeWindow);
ipcMain.handle("window:get-position", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return null;
  try {
    return win.getPosition();
  } catch {
    return null;
  }
});
ipcMain.on("window:set-position", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const x = Number(pos?.x);
  const y = Number(pos?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  try {
    win.setPosition(Math.round(x), Math.round(y), false);
  } catch {}
});
ipcMain.on("overlay:request-focus", () => {
  return;
});
ipcMain.on("overlay:drag-region", (event, payload) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.id !== overlayWindow.id) return;
  const h = Number(payload?.height);
  if (!Number.isFinite(h) || h <= 0) return;
  overlayDragRegionHeight = Math.round(h);
});
ipcMain.on("tray:action", (_event, action) => {
  const cmd = String(action || "").toLowerCase();
  if (cmd === "show") {
    hideTrayMenu();
    showMainWindowRespectingPrefs();
    return;
  }
  if (cmd === "settings") {
    hideTrayMenu();
    openSettingsFromTray();
    return;
  }
  if (cmd === "hide") {
    hideTrayMenu();
    return;
  }
  if (cmd === "resume-startup") {
    hideTrayMenu();
    (async () => {
      const result = await resumeStartupFromTray();
      const ok = result?.ok === true;
      appLogger.info("boot:onboarding:tray-resume", {
        ok,
        alreadyOpen: result?.alreadyOpen === true,
        mutedCount: Number(result?.mutedCount || 0) || 0,
        error: result?.error || null,
      });
      if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow({ forceShow: true });
      } else {
        showMainWindowRespectingPrefs();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        const message = ok
          ? "Startup resumed. Auto-config was skipped and discovered folders were muted."
          : `Failed to resume startup: ${result?.error || "unknown error"}`;
        try {
          mainWindow.webContents.send("notify", {
            message,
            color: ok ? "#4CAF50" : "#f44336",
          });
        } catch {}
        if (!ok) {
          emitBootOnboardingShowToMain("tray-resume-failed", {
            error: result?.error || null,
          });
        }
      }
    })().catch((err) => {
      appLogger.error("boot:onboarding:tray-resume-failed", {
        error: err?.message || String(err),
      });
      scheduleBootOnboardingUiRecovery("tray-resume-error");
    });
    return;
  }
  if (cmd === "quit") {
    isQuitting = true;
    app.quit();
  }
});

app.whenReady().then(async () => {
  appLogger.info("app:ready", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    platform: process.platform,
    arch: process.arch,
  });
  // Load preferences
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};

    selectedLanguage = prefs.language || selectedLanguage;
    let overlayShortcut = prefs.overlayShortcut || null;
    if (
      typeof overlayShortcut === "string" &&
      overlayShortcut.trim() &&
      !normalizeOverlayShortcutAccelerator(overlayShortcut, {
        allowSingle: false,
      })
    ) {
      overlayShortcut = null;
    }
    let overlayInteractShortcut = Object.prototype.hasOwnProperty.call(
      prefs,
      "overlayInteractShortcut",
    )
      ? prefs.overlayInteractShortcut
      : DEFAULT_PREFERENCES.overlayInteractShortcut;
    if (
      typeof overlayInteractShortcut === "string" &&
      overlayInteractShortcut.trim() &&
      !normalizeOverlayInteractAccelerator(overlayInteractShortcut)
    ) {
      overlayInteractShortcut = DEFAULT_PREFERENCES.overlayInteractShortcut;
    }
    const resolvedOverlayStartupShortcuts =
      resolveOverlayShortcutPreferenceConflicts({
        overlayShortcut,
        overlayInteractShortcut,
      });
    overlayShortcut = resolvedOverlayStartupShortcuts.resolved.overlayShortcut;
    overlayInteractShortcut =
      resolvedOverlayStartupShortcuts.resolved.overlayInteractShortcut;
    const overlayStartupShortcutValidation =
      resolvedOverlayStartupShortcuts.validation;
    if (overlayStartupShortcutValidation?.reason === "conflict") {
      prefsLogger.warn("preferences:start:overlay-shortcut-conflict", {
        key: overlayStartupShortcutValidation.key,
        shortcut: overlayStartupShortcutValidation.shortcut,
        conflictWith: overlayStartupShortcutValidation.conflictWith || null,
        conflictSource: overlayStartupShortcutValidation.conflictSource || null,
        resetKey: overlayStartupShortcutValidation.resetKey || null,
      });
    }
    global.overlayShortcut = overlayShortcut;
    if (overlayShortcut) {
      registerOverlayShortcut(overlayShortcut);
    }
    global.overlayInteractShortcut = overlayInteractShortcut;
    applyOverlayInteractShortcutRegistration();
    global.disableProgress = prefs.disableProgress === true;
    global.disablePlaytime = prefs.disablePlaytime === true;
    try {
      processPoller.setEnabled(isProcessNameWatcherEnabled(prefs));
    } catch {}
    selectedSound = prefs.sound || "mute";
    selectedPreset = prefs.preset || "default";
    selectedPosition = prefs.position || "center-bottom";
  } catch (err) {
    notifyError(tUi("main.notify.language.loadFailed", { error: err.message }));
  }

  copyFolderOnce(defaultSoundsFolder, userSoundsFolder);
  renameLegacyPresetFoldersIfNeeded();
  migrateDefaultPresetsIfNeeded();
  copyFolderOnce(defaultPresetsFolder, userPresetsFolder);
  copyProgressTemplateToUserPresetsOnce();

  createMainWindow();
  scheduleAutoSelectProcessPollerAfterBoot();
  mainWindow.hide();
  schedulePostBootUiInitialization();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("will-quit", () => {
  clearOverlayShortcutRegistration();
  clearOverlayInteractShortcut();
  clearOverlayGlobalDragHookRegistration();
  overlayShortcutManager.shutdown();
});

function showProgressNotification(data) {
  windowLogger.info("create-progress-window:start", {
    displayName: data?.displayName || "",
    config: data?.config_path || null,
  });
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const progressHtmlPath = resolveProgressTemplatePath();
  let progressWidth = 350;
  let progressHeight = 150;
  let progressDurationMs = 5000;
  try {
    const htmlContent = fs.readFileSync(progressHtmlPath, "utf-8");
    const sizeMatch = htmlContent.match(
      /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i,
    );
    if (sizeMatch) {
      const parsedWidth = Number.parseInt(sizeMatch[1], 10);
      const parsedHeight = Number.parseInt(sizeMatch[2], 10);
      if (Number.isFinite(parsedWidth) && parsedWidth > 0) {
        progressWidth = parsedWidth;
      }
      if (Number.isFinite(parsedHeight) && parsedHeight > 0) {
        progressHeight = parsedHeight;
      }
    }
    const durationMatch = htmlContent.match(
      /<meta\s+name\s*=\s*"duration"\s+content\s*=\s*"(\d+)"\s*\/?>/i,
    );
    if (durationMatch) {
      const parsedDuration = Number.parseInt(durationMatch[1], 10);
      if (Number.isFinite(parsedDuration) && parsedDuration > 0) {
        progressDurationMs = parsedDuration;
      }
    }
  } catch {}
  const x = 20;
  const y = Math.max(0, height - progressHeight + 10);
  const progressWindow = new BrowserWindow({
    width: progressWidth,
    height: progressHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  progressWindow.setAlwaysOnTop(true, "screen-saver");
  progressWindow.setVisibleOnAllWorkspaces(true);
  progressWindow.setFullScreenable(false);
  progressWindow.setFocusable(false);
  progressWindow.loadFile(progressHtmlPath);
  windowLogger.info("create-progress-window:browserwindow-created", {
    size: { width: progressWidth, height: progressHeight },
    position: { x, y },
    durationMs: progressDurationMs,
    progressHtmlPath,
  });

  progressWindow.once("ready-to-show", () => {
    notificationLogger.info("show-progress", {
      displayName: data?.displayName || "",
      progress: data?.progress ?? null,
      max: data?.max_progress ?? null,
      config: data?.config_path || null,
    });
    windowLogger.info("create-progress-window:ready-to-show");
    progressWindow.show();
    progressWindow.webContents.send("show-progress", data);
  });

  setTimeout(() => {
    if (!progressWindow.isDestroyed()) progressWindow.close();
  }, progressDurationMs);
  return progressWindow;
}
ipcMain.on("disable-progress-check", (event) => {
  event.returnValue = global.disableProgress || false;
});

ipcMain.on("set-disable-progress", (_, value) => {
  global.disableProgress = value;
});

// === Disable Playtime: check + set ===
ipcMain.on("disable-playtime-check", (event) => {
  event.returnValue = global.disablePlaytime || false;
});

ipcMain.on("set-disable-playtime", (_event, value) => {
  global.disablePlaytime = !!value;
  try {
    updatePreferences({ disablePlaytime: !!value });
  } catch (err) {
    notifyError(
      tUi("main.notify.playtime.persistDisabledFailed", {
        error: err.message,
      }),
    );
  }
});

let playtimeWindow = null;
let playtimeAlreadyClosing = false;
let pendingPlayData = null;

let __lastPlaySig = null,
  __lastPlayAt = 0;
function isDuplicatePlay(data) {
  try {
    const sig = [
      data?.phase || "start",
      data?.displayName || data?.name || "",
      data?.description || "",
    ].join("|");
    const now = Date.now();
    if (__lastPlaySig === sig && now - __lastPlayAt < 1000) return true;
    __lastPlaySig = sig;
    __lastPlayAt = now;
  } catch {}
  return false;
}

function normalizePlayPayload(raw) {
  const p = raw || {};
  const displayName = p.displayName || p.name || "Unknown Game";
  const description =
    p.description || (p.phase === "start" ? "Start Playtime!" : "");
  const holdMs = Number.isFinite(p.holdMs)
    ? p.holdMs
    : p.phase === "stop"
      ? 2000
      : 0;
  return { ...p, displayName, description, scale: 1, holdMs };
}

ipcMain.on("show-playtime", (_event, playData) => {
  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) {
      if (playtimeWindow && !playtimeWindow.isDestroyed())
        playtimeWindow.close();
      return;
    }
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }

  const normalized = normalizePlayPayload(playData);
  if (isDuplicatePlay(normalized)) return;
  createPlaytimeWindow(normalized);
});

function createPlaytimeWindow(playData = {}) {
  windowLogger.info("create-playtime-window:start", {
    displayName: playData?.displayName || playData?.name || null,
    phase: playData?.phase || "start",
  });
  const phase = playData.phase || "start";

  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) return;
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }

  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    if (!playtimeAlreadyClosing) {
      windowLogger.info("create-playtime-window:reuse", {
        reason: "closing-existing",
      });
      playtimeAlreadyClosing = true;
      const normalized = normalizePlayPayload(playData);
      const isStop = normalized.phase === "stop";
      if (!isStop) {
        pendingPlayData = normalized;
      } else {
        pendingPlayData = null;
      }
      try {
        playtimeWindow.webContents.send("start-close-animation", normalized);
      } catch {}
      setTimeout(
        () => {
          try {
            if (playtimeWindow && !playtimeWindow.isDestroyed())
              playtimeWindow.close();
          } finally {
            playtimeAlreadyClosing = false;
          }
        },
        Math.max(1200, (normalized.holdMs || 0) + 400),
      );
    }
    return;
  }

  const {
    x: ax,
    y: ay,
    width: aw,
  } = require("electron").screen.getPrimaryDisplay().workArea;
  const winWidth = 460;
  const winHeight = 340;
  const x = Math.floor(ax + (aw - winWidth) / 2),
    y = Math.floor(ay + 40);

  playtimeWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    type: "notification",
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  windowLogger.info("create-playtime-window:browserwindow-created", {
    size: { width: winWidth, height: winHeight },
    position: { x, y },
  });
  playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
  playtimeWindow.setAlwaysOnTop(true, "screen-saver");
  playtimeWindow.setVisibleOnAllWorkspaces(true);
  playtimeWindow.setFullScreenable(false);
  playtimeWindow.setFocusable(false);
  playtimeWindow.loadFile("playtime.html");

  playtimeWindow.webContents.once("dom-ready", () => {
    try {
      const prefs = fs.existsSync(preferencesPath)
        ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
        : {};
      const scale = normalizeNotificationScale(prefs.notificationScale).scale;
      const source = pendingPlayData ?? playData;
      const payload = normalizePlayPayload({ ...source, phase, scale });

      pendingPlayData = null;
      playtimeAlreadyClosing = false;
      playtimeWindow.show();
      windowLogger.info("create-playtime-window:dom-ready", {
        displayName: payload.displayName,
        phase: payload.phase,
        scale,
      });
      playtimeWindow.webContents.send("show-playtime", payload);
    } catch (err) {
      console.error(
        tUi(
          "main.log.playtimeSendFailed",
          { error: err.message },
          `[playtime] send failed: ${err.message}`,
        ),
      );
    }
  });

  ipcMain.once("close-playtime-window", () => {
    const next = pendingPlayData;
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.close();
      playtimeAlreadyClosing = false;
    }
    if (next) {
      pendingPlayData = null;
      createPlaytimeWindow(next);
    }
  });

  const localWindow = playtimeWindow;
  localWindow.on("closed", () => {
    windowLogger.info("create-playtime-window:closed");
    if (playtimeWindow === localWindow) {
      playtimeWindow = null;
      playtimeAlreadyClosing = false;
    }
    pendingPlayData = null;
  });
}

ipcMain.on("queue-achievement-notification", async (_event, payload) => {
  try {
    const configName =
      payload?.configName || payload?.config_name || selectedConfig || null;
    const achKey =
      payload?.name ||
      (typeof payload?.displayName === "string" ? payload.displayName : null);
    if (configName && achKey) {
      const platform =
        normalizePlatform(payload?.platform) ||
        normalizePlatform(selectedPlatform) ||
        "steam";
      const prev = (await loadPreviousAchievements(configName, platform)) || {};
      const prevEntry = prev[achKey];
      const incomingProg = Number(payload.progress);
      const prevProg = Number(prevEntry?.progress);
      const prevMax = Number(prevEntry?.max_progress);
      const maxProg = Number(payload.max_progress);
      if (prevEntry?.earned === true) return;
      if (
        Number.isFinite(incomingProg) &&
        Number.isFinite(prevProg) &&
        incomingProg <= prevProg &&
        (Number.isNaN(maxProg) || maxProg === prevMax)
      ) {
        return;
      }
    }

    queueAchievementNotification(payload);
  } catch (err) {
    notifyError(
      tUi("main.notify.queue.achievementFailed", { error: err.message }),
    );
  }
});

ipcMain.on("queue-progress-notification", async (_event, payload) => {
  try {
    const configName =
      payload?.configName || payload?.config_name || selectedConfig || null;
    const achKey =
      payload?.name ||
      (typeof payload?.displayName === "string" ? payload.displayName : null);
    if (configName && achKey) {
      const platform =
        normalizePlatform(payload?.platform) ||
        normalizePlatform(selectedPlatform) ||
        "steam";
      const prev = (await loadPreviousAchievements(configName, platform)) || {};
      const prevEntry = prev[achKey];
      const incomingProg = Number(payload.progress);
      const prevProg = Number(prevEntry?.progress);
      const prevMax = Number(prevEntry?.max_progress);
      const maxProg = Number(payload.max_progress);
      if (prevEntry?.earned === true) return;
      if (
        Number.isFinite(incomingProg) &&
        Number.isFinite(prevProg) &&
        incomingProg <= prevProg &&
        (Number.isNaN(maxProg) || maxProg === prevMax)
      ) {
        return;
      }
    }

    queueProgressNotification(payload);
  } catch (err) {
    notifyError(
      tUi("main.notify.queue.progressFailed", { error: err.message }),
    );
  }
});

ipcMain.on("notify-from-child", (_event, message) => {
  if (typeof message === "string" && message.trim()) {
    notifyInfo(message);
  }
});

ipcMain.on("notification-render-ready", (event) => {
  const state = pendingNotificationScreenshots.get(event.sender.id);
  if (!state) return;
  void state.run("renderer-ready");
});

ipcMain.on("overlay:visibility-ack", (event, payload = {}) => {
  const senderId = event.sender?.id || null;
  const currentWebContentsId =
    overlayWindow &&
    !overlayWindow.isDestroyed() &&
    overlayWindow.webContents &&
    !overlayWindow.webContents.isDestroyed()
      ? overlayWindow.webContents.id
      : null;
  const ackMeta = {
    senderId,
    currentWebContentsId,
    requestedVisible:
      payload && typeof payload === "object" ? !!payload.visible : null,
    source:
      payload && typeof payload === "object" && payload.source
        ? String(payload.source)
        : null,
    cssHidden:
      payload && typeof payload === "object" ? !!payload.cssHidden : null,
    documentHidden:
      payload && typeof payload === "object" ? !!payload.documentHidden : null,
    elapsedMs: overlayVisibilityAckState?.startedAt
      ? Date.now() - overlayVisibilityAckState.startedAt
      : null,
    expectedVisible: overlayVisibilityAckState?.visible ?? null,
    expectedSource: overlayVisibilityAckState?.source || null,
    state: getOverlayWindowLogState(),
  };
  if (!currentWebContentsId || currentWebContentsId !== senderId) {
    overlayLogger.warn("overlay:renderer-ack:stale", ackMeta);
    return;
  }
  overlayLogger.debug("overlay:renderer-ack", ackMeta);
  if (ackMeta.requestedVisible === true) {
    overlayVisibleAckSatisfied = true;
  }
  clearOverlayVisibilityAckTimeout();
  if (ackMeta.requestedVisible === true) {
    maybeShowOverlayAfterRendererReady(
      ackMeta.source || "overlay:visibility-ack",
    );
  }
});

const { pathToFileURL } = require("url");
const processPoller = require("./utils/process-poller");

const autoSelectIndex = {
  built: false,
  buildPromise: null,
  lastBuildAt: 0,
  exeToConfigs: new Map(), // exeLower -> Set(configName)
  configEntries: new Map(), // configName -> { name, exeLower, appid, data }
};
const autoSelectIndexTimers = new Map(); // configName -> timeout
const AUTO_SELECT_INDEX_UPSERT_DEBOUNCE_MS = 120;
const AUTO_SELECT_INDEX_BUILD_CONCURRENCY = 16;

function getConfigNameFromConfigFilePath(filePath) {
  try {
    if (!filePath) return "";
    return path.basename(String(filePath), ".json");
  } catch {
    return "";
  }
}

function normalizeExeNameFromProcessName(processName) {
  const raw = String(processName || "").trim();
  if (!raw) return "";
  try {
    return path.basename(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizeConfigAppIdValue(configData) {
  try {
    return normalizeAppIdValue(
      configData?.appid || configData?.appId || configData?.steamAppId || "",
    );
  } catch {
    return "";
  }
}

function removeAutoSelectIndexEntry(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return;

  const existing = autoSelectIndex.configEntries.get(safeName);
  if (existing?.exeLower) {
    const set = autoSelectIndex.exeToConfigs.get(existing.exeLower);
    if (set) {
      set.delete(safeName);
      if (set.size === 0)
        autoSelectIndex.exeToConfigs.delete(existing.exeLower);
    }
  }
  autoSelectIndex.configEntries.delete(safeName);
}

async function upsertAutoSelectIndexEntryFromPath(filePath) {
  const rawName = getConfigNameFromConfigFilePath(filePath);
  const safeName = sanitizeConfigName(rawName);
  if (!safeName) return;

  let data = null;
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    data = JSON.parse(raw);
  } catch {
    removeAutoSelectIndexEntry(safeName);
    return;
  }
  if (!data || typeof data !== "object") {
    removeAutoSelectIndexEntry(safeName);
    return;
  }

  const exeLower = normalizeExeNameFromProcessName(data?.process_name);
  if (!exeLower) {
    removeAutoSelectIndexEntry(safeName);
    return;
  }

  const appid = normalizeConfigAppIdValue(data);
  if (!data.name) data.name = safeName;

  const prev = autoSelectIndex.configEntries.get(safeName);
  if (prev?.exeLower && prev.exeLower !== exeLower) {
    const prevSet = autoSelectIndex.exeToConfigs.get(prev.exeLower);
    if (prevSet) {
      prevSet.delete(safeName);
      if (prevSet.size === 0)
        autoSelectIndex.exeToConfigs.delete(prev.exeLower);
    }
  }

  autoSelectIndex.configEntries.set(safeName, {
    name: safeName,
    exeLower,
    appid,
    data,
  });
  if (!autoSelectIndex.exeToConfigs.has(exeLower)) {
    autoSelectIndex.exeToConfigs.set(exeLower, new Set());
  }
  autoSelectIndex.exeToConfigs.get(exeLower).add(safeName);
}

function queueAutoSelectIndexUpsertFromConfigPath(filePath) {
  const rawName = getConfigNameFromConfigFilePath(filePath);
  const safeName = sanitizeConfigName(rawName);
  if (!safeName) return;

  const prev = autoSelectIndexTimers.get(safeName);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    autoSelectIndexTimers.delete(safeName);
    upsertAutoSelectIndexEntryFromPath(filePath).catch(() => {});
  }, AUTO_SELECT_INDEX_UPSERT_DEBOUNCE_MS);
  autoSelectIndexTimers.set(safeName, t);
}

function queueAutoSelectIndexRemoveByConfigPath(filePath) {
  const rawName = getConfigNameFromConfigFilePath(filePath);
  const safeName = sanitizeConfigName(rawName);
  if (!safeName) return;

  const prev = autoSelectIndexTimers.get(safeName);
  if (prev) {
    clearTimeout(prev);
    autoSelectIndexTimers.delete(safeName);
  }
  removeAutoSelectIndexEntry(safeName);
}

async function rebuildAutoSelectIndex(reason = "manual") {
  autoSelectIndex.exeToConfigs.clear();
  autoSelectIndex.configEntries.clear();
  autoSelectIndex.built = false;

  let files = [];
  try {
    if (!configsDir || !fs.existsSync(configsDir)) {
      autoSelectIndex.built = true;
      autoSelectIndex.lastBuildAt = Date.now();
      return;
    }
    files = await fs.promises.readdir(configsDir);
  } catch {
    files = [];
  }

  const fullPaths = (Array.isArray(files) ? files : [])
    .filter((f) =>
      String(f || "")
        .toLowerCase()
        .endsWith(".json"),
    )
    .map((f) => path.join(configsDir, f));

  const max = Math.max(1, Math.floor(AUTO_SELECT_INDEX_BUILD_CONCURRENCY));
  let idx = 0;
  const workers = Array.from({ length: max }, async () => {
    while (idx < fullPaths.length) {
      const p = fullPaths[idx++];
      try {
        await upsertAutoSelectIndexEntryFromPath(p);
      } catch {
        /* ignore */
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch {
    /* ignore */
  }

  autoSelectIndex.built = true;
  autoSelectIndex.lastBuildAt = Date.now();
  appLogger.info("auto-select:index-built", {
    reason,
    totalFiles: fullPaths.length,
    entries: autoSelectIndex.configEntries.size,
  });
}

async function ensureAutoSelectIndexReady() {
  if (autoSelectIndex.built) return;
  if (autoSelectIndex.buildPromise) return autoSelectIndex.buildPromise;
  autoSelectIndex.buildPromise = rebuildAutoSelectIndex("ensure")
    .catch((err) => {
      appLogger.warn("auto-select:index-build-failed", {
        error: err?.message || String(err),
      });
    })
    .finally(() => {
      autoSelectIndex.buildPromise = null;
    });
  return autoSelectIndex.buildPromise;
}

const AUTO_SELECT_AFTER_BOOT_DELAY_MS = 5000;
const AUTO_SELECT_BOOT_CHECK_INTERVAL_MS = 500;
let autoSelectProcessPollerStarted = false;
let autoSelectProcessPollerUnsubscribe = null;
let autoSelectProcessPollerWaitTimer = null;
let autoSelectProcessPollerStartTimer = null;

function clearAutoSelectProcessPollerTimers() {
  if (autoSelectProcessPollerWaitTimer) {
    clearTimeout(autoSelectProcessPollerWaitTimer);
    autoSelectProcessPollerWaitTimer = null;
  }
  if (autoSelectProcessPollerStartTimer) {
    clearTimeout(autoSelectProcessPollerStartTimer);
    autoSelectProcessPollerStartTimer = null;
  }
}

function stopAutoSelectProcessPoller() {
  clearAutoSelectProcessPollerTimers();
  if (typeof autoSelectProcessPollerUnsubscribe === "function") {
    try {
      autoSelectProcessPollerUnsubscribe();
    } catch {}
    autoSelectProcessPollerUnsubscribe = null;
  }
  autoSelectProcessPollerStarted = false;
}

function startAutoSelectProcessPoller() {
  if (autoSelectProcessPollerStarted) return;
  if (!isProcessNameWatcherEnabled(cachedPreferences)) {
    appLogger.info("process-poller:auto-select-start-skipped", {
      reason: "process-watcher-disabled",
    });
    return;
  }
  try {
    processPoller.setEnabled(true);
  } catch {}
  autoSelectProcessPollerStarted = true;
  ensureAutoSelectIndexReady().catch(() => {});
  autoSelectProcessPollerUnsubscribe = processPoller.subscribe((list) => {
    autoSelectRunningGameConfig(list);
  });
  appLogger.info("process-poller:auto-select-started", {
    delayMs: AUTO_SELECT_AFTER_BOOT_DELAY_MS,
  });
}

function scheduleAutoSelectProcessPollerAfterBoot() {
  if (!isProcessNameWatcherEnabled(cachedPreferences)) {
    stopAutoSelectProcessPoller();
    try {
      processPoller.setEnabled(false);
    } catch {}
    appLogger.info("process-poller:auto-select-disabled", {
      reason: "process-watcher-disabled",
    });
    return;
  }
  if (autoSelectProcessPollerStarted) return;
  if (autoSelectProcessPollerWaitTimer || autoSelectProcessPollerStartTimer)
    return;
  const waitForBootReady = () => {
    const bootDone = global.bootDone === true;
    const bootUiReady = global.bootUiReady === true;
    const manualSeedDone = global.bootManualSeedComplete === true;
    if (!bootDone || !bootUiReady || !manualSeedDone) {
      autoSelectProcessPollerWaitTimer = setTimeout(
        waitForBootReady,
        AUTO_SELECT_BOOT_CHECK_INTERVAL_MS,
      );
      return;
    }
    autoSelectProcessPollerWaitTimer = null;
    appLogger.info("process-poller:auto-select-scheduled", {
      bootDone,
      uiReady: bootUiReady,
      manualSeedDone,
      delayMs: AUTO_SELECT_AFTER_BOOT_DELAY_MS,
    });
    autoSelectProcessPollerStartTimer = setTimeout(() => {
      autoSelectProcessPollerStartTimer = null;
      startAutoSelectProcessPoller();
    }, AUTO_SELECT_AFTER_BOOT_DELAY_MS);
  };
  waitForBootReady();
}

let detectedConfigName = null;
const activePlaytimeConfigs = new Set();
let autoSelectRunningGameConfigInFlight = false;

function splitArgsString(input) {
  const argStr = String(input || "").trim();
  if (!argStr) return [];
  const matches = argStr.match(/(?:[^\s"]+|"[^"]*"|'[^']*')+/g) || [];
  return matches
    .map((part) => {
      const trimmed = String(part || "").trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ) {
        return trimmed.slice(1, -1);
      }
      return trimmed;
    })
    .filter(Boolean);
}

function normalizeProcessCmdLine(proc) {
  if (!proc || typeof proc !== "object") return "";
  if (typeof proc.cmd === "string" && proc.cmd.trim()) {
    return proc.cmd.trim().toLowerCase();
  }
  if (Array.isArray(proc.cmd)) {
    const joined = proc.cmd
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (joined) return joined.toLowerCase();
  }
  if (typeof proc.command === "string" && proc.command.trim()) {
    return proc.command.trim().toLowerCase();
  }
  return "";
}

function getConfigProcessArgTokens(configData) {
  if (!configData || typeof configData !== "object") return [];
  if (Array.isArray(configData.__processArgsTokens)) {
    return configData.__processArgsTokens;
  }
  const rawArgs =
    typeof configData.arguments === "string"
      ? configData.arguments
      : typeof configData.args === "string"
        ? configData.args
        : "";
  const tokens = splitArgsString(rawArgs)
    .map((token) =>
      String(token || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  configData.__processArgsTokens = tokens;
  return tokens;
}

function processMatchesConfig(proc, configData, configName) {
  if (!proc || !proc.name || !configData?.process_name) return false;
  const exeName = path.basename(configData.process_name).toLowerCase();
  if (String(proc.name || "").toLowerCase() !== exeName) return false;
  const mapped = manualLaunchPidMap.get(proc.pid);
  if (mapped) return mapped === configName;
  const argTokens = getConfigProcessArgTokens(configData);
  if (!argTokens.length) return true;
  const cmdLine = normalizeProcessCmdLine(proc);
  if (!cmdLine) return true;
  return argTokens.every((token) => cmdLine.includes(token));
}

async function autoSelectRunningGameConfig(processes) {
  if (autoSelectRunningGameConfigInFlight) return;
  autoSelectRunningGameConfigInFlight = true;
  try {
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return;
    if (!isProcessNameWatcherEnabled(cachedPreferences)) return;
    if (process.env.ACH_LOG_PROCESSES === "1") {
      const logPath = path.join(app.getPath("userData"), "process-log.txt");
      fs.writeFileSync(logPath, list.map((p) => p.name).join("\n"), "utf8");
    }

    await ensureAutoSelectIndexReady();

    const procsByExe = new Map();
    for (const p of list) {
      const exe = String(p?.name || "").toLowerCase();
      if (!exe) continue;
      if (!procsByExe.has(exe)) procsByExe.set(exe, []);
      procsByExe.get(exe).push(p);
    }

    const getEntry = (name) => {
      const safe = sanitizeConfigName(name || "");
      if (!safe) return null;
      return autoSelectIndex.configEntries.get(safe) || null;
    };

    const isBlacklisted = (entry) => {
      const id = String(entry?.appid || "").trim();
      if (!id) return false;
      return blacklistedAppIdsSet.has(id);
    };

    const isEntryRunning = (entry, configName) => {
      if (!entry?.exeLower || !entry?.data?.process_name) return false;
      const procs = procsByExe.get(entry.exeLower) || [];
      if (!procs.length) return false;
      return procs.some((p) => processMatchesConfig(p, entry.data, configName));
    };

    if (manualLaunchInProgress) {
      const entry = getEntry(detectedConfigName);
      if (!entry) {
        manualLaunchInProgress = false;
        detectedConfigName = null;
      } else {
        const isRunning = isEntryRunning(entry, detectedConfigName);
        if (!isRunning) {
          notifyInfo(
            tUi("main.notify.config.closed", {
              name: entry?.data?.name || entry?.name || detectedConfigName,
            }),
          );
          manualLaunchInProgress = false;
          activePlaytimeConfigs.delete(entry?.data?.name || detectedConfigName);
          detectedConfigName = null;
        }
      }
    }

    if (detectedConfigName) {
      const entry = getEntry(detectedConfigName);
      if (!entry) {
        detectedConfigName = null;
      } else {
        const isStillRunning = isEntryRunning(entry, detectedConfigName);
        if (!isStillRunning) {
          notifyInfo(
            tUi("main.notify.config.closed", {
              name: entry?.data?.name || entry?.name || detectedConfigName,
            }),
          );
          activePlaytimeConfigs.delete(entry?.data?.name || detectedConfigName);
          if (detectedConfigName === entry?.data?.name)
            detectedConfigName = null;
        }
      }
    }

    for (const activeName of [...activePlaytimeConfigs]) {
      const entry = getEntry(activeName);
      if (!entry) {
        activePlaytimeConfigs.delete(activeName);
        if (detectedConfigName === activeName) detectedConfigName = null;
        continue;
      }
      const stillRunning = isEntryRunning(entry, activeName);
      if (!stillRunning) {
        notifyInfo(
          tUi("main.notify.config.closed", {
            name: entry?.data?.name || entry?.name || activeName,
          }),
        );
        activePlaytimeConfigs.delete(activeName);
        if (detectedConfigName === activeName) detectedConfigName = null;
      }
    }

    for (const p of list) {
      const mapped = manualLaunchPidMap.get(p?.pid);
      if (!mapped) continue;
      const entry = getEntry(mapped);
      if (!entry) continue;
      if (isBlacklisted(entry)) continue;
      if (activePlaytimeConfigs.has(entry.name)) continue;
      if (!processMatchesConfig(p, entry.data, entry.name)) continue;

      detectedConfigName = entry.name;
      activePlaytimeConfigs.add(entry.name);
      notifyInfo(
        tUi("main.notify.config.started", {
          name: entry?.data?.name || entry?.name || entry.name,
        }),
      );
      entry.data.__playtimeKey = sanitizeConfigName(entry.name);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("auto-select-config", entry.name);
        startPlaytimeLogWatcher(entry.data);
      }
      return;
    }

    for (const [exe, procs] of procsByExe.entries()) {
      const candidates = autoSelectIndex.exeToConfigs.get(exe);
      if (!candidates || !candidates.size) continue;

      for (const configName of Array.from(candidates)) {
        if (activePlaytimeConfigs.has(configName)) continue;

        const entry = getEntry(configName);
        if (!entry) continue;
        if (isBlacklisted(entry)) continue;

        const running = (Array.isArray(procs) ? procs : []).some((p) =>
          processMatchesConfig(p, entry.data, entry.name),
        );
        if (!running) continue;

        detectedConfigName = entry.name;
        activePlaytimeConfigs.add(entry.name);
        notifyInfo(
          tUi("main.notify.config.started", {
            name: entry?.data?.name || entry?.name || entry.name,
          }),
        );
        entry.data.__playtimeKey = sanitizeConfigName(entry.name);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("auto-select-config", entry.name);
          startPlaytimeLogWatcher(entry.data);
        }
        return;
      }
    }
  } catch (err) {
    notifyError(
      tUi("main.notify.autoSelect.error", {
        error: err?.message || String(err),
      }),
    );
  } finally {
    autoSelectRunningGameConfigInFlight = false;
  }
}

ipcMain.handle("resolve-icon-url", async (_event, configPath, rel) => {
  try {
    const p = resolveIconAbsolutePath(configPath, rel);
    if (!p) {
      return pathToFileURL(ICON_PATH).toString();
    }
    await fs.promises.access(p, fs.constants.R_OK);
    return pathToFileURL(p).toString();
  } catch {
    return pathToFileURL(ICON_PATH).toString();
  }
});

const {
  generateGameConfigs,
  generateConfigForAppId,
} = require("./utils/auto-config-generator");
const {
  loadAchievementsFromSaveFile,
  getSafeLocalizedText,
  buildCrcNameMap,
  resolveConfigSchemaPath,
} = require("./utils/achievement-data");

async function seedManualConfigsAtBoot() {
  if (bootManualSeedRunning) return;
  bootManualSeedRunning = true;
  let files = [];
  const BOOT_MANUAL_SEED_CONCURRENCY = 10;
  const BOOT_MANUAL_SEED_SLICE_MS = 500;
  try {
    if (!fs.existsSync(configsDir)) {
      bootManualSeedRunning = false;
      return;
    }
    files = fs
      .readdirSync(configsDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
  } catch {
    bootManualSeedRunning = false;
    return;
  }

  persistenceLogger.info("boot-cache:manual-start", { total: files.length });
  const runWithConcurrency = async (items, limit, worker) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const max = Math.max(1, Number(limit) || 1);
    const sliceMs = Math.max(0, Number(BOOT_MANUAL_SEED_SLICE_MS) || 0);
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
              setTimeout(next, sliceMs);
            });
        }
        if (running === 0 && idx >= items.length) resolve();
      };
      next();
    });
  };

  const processFile = async (file) => {
    const full = path.join(configsDir, file);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      bumpCacheBatchStat("errors");
      return;
    }
    const configFileName = path.basename(file, ".json");
    if (!config?.save_path) return;

    const seedKey = buildCacheSeedKey(config);
    if (seedKey && bootSeededCacheKeys.has(seedKey)) return;

    const platform = normalizePlatform(config?.platform) || "steam";

    const cachePath = getCachePath(configFileName, platform);
    if (fs.existsSync(cachePath)) {
      if (seedKey) bootSeededCacheKeys.add(seedKey);
      return;
    }

    // If cache exists under an older alias key, copy it to the canonical key to avoid re-parsing.
    try {
      const aliases = [];
      if (typeof config?.name === "string" && config.name.trim()) {
        aliases.push(config.name.trim());
      }
      if (
        typeof config?.displayName === "string" &&
        config.displayName.trim()
      ) {
        aliases.push(config.displayName.trim());
      }
      for (const altName of aliases) {
        const altPath = getCachePath(altName, platform);
        if (!altPath || altPath === cachePath) continue;
        if (!fs.existsSync(altPath)) continue;
        try {
          fs.copyFileSync(altPath, cachePath);
          if (seedKey) bootSeededCacheKeys.add(seedKey);
          return;
        } catch {}
      }
    } catch {}

    const candidatePath = resolveBootSeedCandidatePath(config);
    if (!candidatePath) return;

    if (
      isAchCacheMetaMatch(
        configFileName,
        platform,
        candidatePath,
        String(config?.appid || ""),
      )
    ) {
      const cachedSnapshot =
        (await loadPreviousAchievements(configFileName, platform)) || {};
      if (Object.keys(cachedSnapshot).length) {
        seedCacheFromSnapshot(configFileName, cachedSnapshot, platform);
        if (seedKey) bootSeededCacheKeys.add(seedKey);
        persistenceLogger.info("boot-cache:manual-meta-skip", {
          config: configFileName,
          platform,
          file: candidatePath,
        });
        return;
      }
    }

    let schemaPath = null;
    try {
      schemaPath = resolveConfigSchemaPath(config, config?.config_path || null);
    } catch {}
    const snapshot = loadAchievementsFromSaveFile(
      path.dirname(candidatePath),
      {},
      {
        configMeta: config,
        selectedConfigPath: config?.config_path || null,
        fullSchemaPath: schemaPath,
      },
    );
    if (snapshot && Object.keys(snapshot).length) {
      seedCacheFromSnapshot(configFileName, snapshot, platform);
      if (seedKey) bootSeededCacheKeys.add(seedKey);
      bumpCacheBatchStat("seeded");
    }
  };

  await runWithConcurrency(files, BOOT_MANUAL_SEED_CONCURRENCY, processFile);
  persistenceLogger.info("boot-cache:manual-complete", { total: files.length });
  bootManualSeedRunning = false;
}

function scheduleManualCacheSeedAfterBoot() {
  if (bootManualSeedScheduled) return;
  bootManualSeedScheduled = true;
  // Keep cache reads throttled until post-boot seed/platinum pass completes.
  bootPostSeedLimiterActive = true;
  const tick = async () => {
    if (global.bootDone === true) {
      if (global.bootUiReady !== true) {
        setTimeout(tick, 500);
        return;
      }
      if (global.bootOnboardingGateOpen === false) {
        setTimeout(tick, 500);
        return;
      }
      if (global.bootOverlayHidden !== true) {
        const now = Date.now();
        if (!bootOverlayWaitStartedAt) {
          bootOverlayWaitStartedAt = now;
        }
        const waitedMs = now - bootOverlayWaitStartedAt;
        if (waitedMs < BOOT_MANUAL_OVERLAY_WAIT_MAX_MS) {
          setTimeout(tick, 500);
          return;
        }
        global.bootOverlayHidden = true;
        bootOverlayHiddenAt = now;
        appLogger.warn("boot:overlay-hidden-timeout", {
          waitedMs,
          maxMs: BOOT_MANUAL_OVERLAY_WAIT_MAX_MS,
        });
      }
      if (!bootOverlayHiddenAt) {
        bootOverlayHiddenAt = Date.now();
      }
      const elapsedSinceOverlayHidden = Date.now() - bootOverlayHiddenAt;
      if (elapsedSinceOverlayHidden < BOOT_MANUAL_AFTER_OVERLAY_HIDE_DELAY_MS) {
        const remainingMs =
          BOOT_MANUAL_AFTER_OVERLAY_HIDE_DELAY_MS - elapsedSinceOverlayHidden;
        setTimeout(tick, Math.max(250, Math.min(500, remainingMs)));
        return;
      }
      try {
        await seedManualConfigsAtBoot();
        if (BOOT_MANUAL_POST_SEED_DELAY_MS > 0) {
          await sleep(BOOT_MANUAL_POST_SEED_DELAY_MS);
        }
        try {
          await flagPlatinumFromCacheOnBoot();
        } catch {}
      } finally {
        bootPostSeedLimiterActive = false;
        markBootManualSeedComplete();
      }
      return;
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}
const {
  migrateConfigPlatforms,
  normalizePlatform,
  sanitizeAppId,
  sanitizeAppIdForPlatform,
  inferPlatformAndSteamId,
  migrateSchemaStorage,
} = require("./utils/config-platform-migrator");
ipcMain.handle("parse-stats-bin", async (_event, filePath) => {
  try {
    const parseStatsBin = require("./utils/parseStatsBin");
    return parseStatsBin(filePath);
  } catch (err) {
    notifyError(tUi("main.notify.parseStatsBinFailed", { error: err.message }));
    throw err;
  }
});

const defaultUplaySteamMapPath = path.join(
  __dirname,
  "assets",
  "uplay-steam.json",
);
const defaultSteamDbPath = path.join(__dirname, "assets", "steamdb.json");
const runtimeUplaySteamMapPath = path.join(
  app.getPath("userData"),
  "uplay-steam.json",
);
const runtimeSteamDbPath = path.join(app.getPath("userData"), "steamdb.json");

function ensureRuntimeSteamDb() {
  try {
    if (fs.existsSync(runtimeSteamDbPath)) return;
    fs.mkdirSync(path.dirname(runtimeSteamDbPath), { recursive: true });
    if (fs.existsSync(defaultSteamDbPath)) {
      fs.copyFileSync(defaultSteamDbPath, runtimeSteamDbPath);
    } else {
      fs.writeFileSync(runtimeSteamDbPath, "[]", "utf8");
    }
  } catch (err) {
    ipcLogger.warn("steamdb:init-failed", {
      error: err?.message || String(err),
    });
  }
}

function getRuntimeUplayMappingEnv() {
  return {
    ...process.env,
    STEAM_DB_PATH: runtimeSteamDbPath,
  };
}

function ensureRuntimeUplayMap() {
  try {
    if (fs.existsSync(runtimeUplaySteamMapPath)) return;
    fs.mkdirSync(path.dirname(runtimeUplaySteamMapPath), { recursive: true });
    if (fs.existsSync(defaultUplaySteamMapPath)) {
      fs.copyFileSync(defaultUplaySteamMapPath, runtimeUplaySteamMapPath);
    } else {
      fs.writeFileSync(runtimeUplaySteamMapPath, "[]", "utf8");
    }
  } catch (err) {
    ipcLogger.warn("uplay-mapping:init-failed", {
      error: err?.message || String(err),
    });
  }
}
function loadRuntimeUplayMap() {
  try {
    const raw = fs.readFileSync(runtimeUplaySteamMapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    ipcLogger.warn("uplay-mapping:load-failed", {
      error: err?.message || String(err),
    });
    return [];
  }
}
function refreshRuntimeUplayMapping() {
  try {
    const script = path.join(__dirname, "utils", "match-uplay-steam.js");
    execFileSync(
      process.execPath,
      ["--run-as-node", script, `--output=${runtimeUplaySteamMapPath}`],
      {
        windowsHide: true,
        stdio: "ignore",
        env: getRuntimeUplayMappingEnv(),
      },
    );
    ipcLogger.info("uplay-mapping:refresh-success");
  } catch (err) {
    ipcLogger.warn("uplay-mapping:refresh-failed", {
      error: err?.message || String(err),
    });
  }
}
function hydrateRuntimeMapping(rows) {
  uplaySteamMap = Array.isArray(rows) ? rows : [];
  uplayToSteam.clear();
  for (const row of uplaySteamMap) {
    if (row && row.uplay_id) {
      uplayToSteam.set(String(row.uplay_id), row);
    }
  }
}

function refreshRuntimeUplayMappingAsync() {
  if (refreshRuntimeUplayMappingAsync.inflight) return;
  const script = path.join(__dirname, "utils", "match-uplay-steam.js");
  refreshRuntimeUplayMappingAsync.inflight = true;
  execFile(
    process.execPath,
    ["--run-as-node", script, `--output=${runtimeUplaySteamMapPath}`],
    { windowsHide: true, env: getRuntimeUplayMappingEnv() },
    (err) => {
      if (err) {
        ipcLogger.warn("uplay-mapping:refresh-failed", {
          error: err?.message || String(err),
        });
      } else {
        try {
          const rows = loadRuntimeUplayMap();
          hydrateRuntimeMapping(rows);
          ipcLogger.info("uplay-mapping:refresh-success", {
            entries: uplaySteamMap.length,
          });
        } catch (reloadErr) {
          ipcLogger.warn("uplay-mapping:refresh-reload-failed", {
            error: reloadErr?.message || String(reloadErr),
          });
        }
      }
      refreshRuntimeUplayMappingAsync.inflight = false;
    },
  );
}
refreshRuntimeUplayMappingAsync.inflight = false;

ensureRuntimeSteamDb();
process.env.STEAM_DB_PATH = runtimeSteamDbPath;
ensureRuntimeUplayMap();
let uplaySteamMap = loadRuntimeUplayMap();
const uplayToSteam = new Map();
hydrateRuntimeMapping(uplaySteamMap);
refreshRuntimeUplayMappingAsync();

function applyConfigPlatformDefaults(payload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const normalizedPlatform = normalizePlatform(payload.platform);
  if (
    normalizedPlatform === "xenia" ||
    normalizedPlatform === "rpcs3" ||
    normalizedPlatform === "shadps4" ||
    normalizedPlatform === "steam-official"
  ) {
    const sanitizedSpecial = sanitizeAppIdForPlatform(
      payload.appid || payload.appId || payload.steamAppId,
      normalizedPlatform,
    );
    if (sanitizedSpecial) {
      payload.appid = sanitizedSpecial;
    }
    payload.platform = normalizedPlatform;
    if (payload.steamAppId) delete payload.steamAppId;
    return payload;
  }
  const sanitizedAppId =
    sanitizeAppId(payload.appid) ||
    sanitizeAppId(payload.appId) ||
    sanitizeAppId(payload.steamAppId);
  if (sanitizedAppId) {
    payload.appid = sanitizedAppId;
  }
  const mapping = sanitizedAppId ? uplayToSteam.get(sanitizedAppId) : null;
  const { platform, steamAppId } = inferPlatformAndSteamId({
    config: payload,
    mapping,
  });
  if (platform) payload.platform = platform;
  else delete payload.platform;
  if (steamAppId) payload.steamAppId = steamAppId;
  else delete payload.steamAppId;
  return payload;
}

const SCHEMA_ROOT_PATH = path.join(configsDir, "schema");
const SCHEMA_PLATFORM_DIRS = [
  "steam",
  "steam-official",
  "uplay",
  "gog",
  "epic",
  "xenia",
  "rpcs3",
  "shadps4",
];

function normalizeStoragePlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === "steam-official") return "steam-official";
  if (normalized === "uplay") return "uplay";
  if (normalized === "gog") return "gog";
  if (normalized === "epic") return "epic";
  if (normalized === "xenia") return "xenia";
  if (normalized === "rpcs3") return "rpcs3";
  if (normalized === "shadps4") return "shadps4";
  return "steam";
}

function resolveSchemaDirForPlatform(appid, platform) {
  const storagePlatform = normalizeStoragePlatform(platform);
  return path.join(SCHEMA_ROOT_PATH, storagePlatform, String(appid));
}

function isManagedSchemaPath(p) {
  if (!isNonEmptyString(p)) return true;
  const normalized = path.normalize(p).toLowerCase();
  return normalized.startsWith(path.normalize(SCHEMA_ROOT_PATH).toLowerCase());
}

function schemaPathMatchesPlatform(appid, platform, schemaPath) {
  if (!isManagedSchemaPath(schemaPath)) return false;
  const expected = resolveSchemaDirForPlatform(appid, platform);
  return (
    path.normalize(schemaPath || "").toLowerCase() ===
    path.normalize(expected).toLowerCase()
  );
}
const { updated: platformMetaUpdated, platformIndex: configPlatformIndex } =
  migrateConfigPlatforms({
    configsDir,
    mappingByUplayId: uplayToSteam,
    logger: persistenceLogger,
  });
if (platformMetaUpdated) {
  persistenceLogger.info("platform-migrate:configs-updated", {
    updated: platformMetaUpdated,
  });
}
global.configPlatformIndex = configPlatformIndex;
const { moved: schemaDirsMoved, updatedConfigs: schemaConfigsUpdated } =
  migrateSchemaStorage({
    configsDir,
    platformIndex: configPlatformIndex,
    logger: persistenceLogger,
  });
if (schemaDirsMoved || schemaConfigsUpdated) {
  persistenceLogger.info("platform-migrate:schema-updated", {
    moved: schemaDirsMoved,
    configsUpdated: schemaConfigsUpdated,
  });
}

function getPlatformForAppId(appid) {
  const key = String(appid || "").trim();
  if (!key) return "steam";
  try {
    const idx = global.configPlatformIndex;
    const set = idx && typeof idx.get === "function" ? idx.get(key) : null;
    if (!set || set.size === 0) return "steam";
    const order = [
      "steam",
      "steam-official",
      "uplay",
      "gog",
      "epic",
      "xenia",
      "rpcs3",
      "shadps4",
    ];
    for (const p of order) {
      if (set.has(p)) return p;
    }
    const first = set.values().next();
    return first && typeof first.value === "string" ? first.value : "steam";
  } catch {
    return "steam";
  }
}

function pickFresherPath(src, dest) {
  try {
    if (!fs.existsSync(dest)) return src;
    const sStat = fs.statSync(src);
    const dStat = fs.statSync(dest);
    return sStat.mtimeMs >= dStat.mtimeMs ? src : dest;
  } catch {
    return src;
  }
}

function migrateImagesToPlatformStorage() {
  let imagesRoot;
  try {
    imagesRoot = path.join(app.getPath("userData"), "images");
  } catch {
    return;
  }
  if (!imagesRoot || !fs.existsSync(imagesRoot)) return;

  const isNumeric = (name) => /^[0-9a-fA-F]+$/.test(String(name || ""));
  const entries = fs.readdirSync(imagesRoot, { withFileTypes: true });

  // Covers: images/<appid>.jpg -> images/<platform>/<appid>/<appid>.jpg
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^(\d+)\.jpg$/i);
    if (!m) continue;
    const appid = m[1];
    const platform = getPlatformForAppId(appid);
    const src = path.join(imagesRoot, entry.name);
    const destDir = path.join(imagesRoot, platform, appid);
    const dest = path.join(destDir, `${appid}.jpg`);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      const preferred = pickFresherPath(src, dest);
      if (preferred === src) {
        fs.renameSync(src, dest);
      } else {
        fs.unlinkSync(src);
      }
    } catch (err) {
      ipcLogger?.warn?.("images:migrate-cover-failed", {
        appid,
        platform,
        error: err?.message || String(err),
      });
    }
  }

  // Headers/other per-app folders: images/<appid>/header.jpg -> images/<platform>/<appid>/header.jpg
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appid = entry.name;
    if (!isNumeric(appid)) continue;
    const srcDir = path.join(imagesRoot, appid);
    const platform = getPlatformForAppId(appid);
    const destDir = path.join(imagesRoot, platform, appid);
    try {
      const files = fs.readdirSync(srcDir);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of files || []) {
        const src = path.join(srcDir, file);
        const dest = path.join(destDir, file);
        try {
          const preferred = pickFresherPath(src, dest);
          if (preferred === src) {
            fs.renameSync(src, dest);
          } else {
            fs.unlinkSync(src);
          }
        } catch (moveErr) {
          ipcLogger?.warn?.("images:migrate-header-failed", {
            appid,
            file,
            platform,
            error: moveErr?.message || String(moveErr),
          });
        }
      }
      try {
        fs.rmSync(srcDir, { recursive: true, force: true });
      } catch {}
    } catch (err) {
      ipcLogger?.warn?.("images:migrate-dir-failed", {
        appid,
        platform,
        error: err?.message || String(err),
      });
    }
  }
}

migrateImagesToPlatformStorage();

ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("get-display-workarea", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      const display = screen.getDisplayMatching(bounds);
      return display.workAreaSize || display.size;
    }
  } catch {}
  const primary = screen.getPrimaryDisplay();
  return primary?.workAreaSize || primary?.size || { width: 0, height: 0 };
});

ipcMain.handle("generate-auto-configs", async (event, folderPath) => {
  const outputDir = configsDir;
  global.mainWindow = BrowserWindow.fromWebContents(event.sender);
  try {
    ensureSteamApiKeyFileFromPrefs();
    const result = await generateGameConfigs(folderPath, outputDir, {
      onSeedCache: ({ appid, configName, snapshot }) => {
        try {
          seedCacheFromSnapshot(configName, snapshot);
        } catch (e) {
          console.warn(
            `[seed-cache] ${configName} (${appid}) failed: ${e.message}`,
          );
        }
      },
    });
    if (!result || result.processed === 0) {
      return {
        success: false,
        message: tUi("main.message.autoConfigsNoAppId"),
      };
    }
    return {
      success: true,
      message: tUi("main.message.autoConfigsSuccess"),
    };
  } catch (error) {
    console.error(
      tUi(
        "main.log.configsGenerateError",
        { error: error.message || String(error) },
        `Error generating configs: ${error.message || String(error)}`,
      ),
    );
    return { success: false, message: error.message };
  }
});

const {
  hasStartupTask,
  createStartupTask,
  deleteStartupTask,
} = require("./utils/startup-task");

function quoteForCmd(arg) {
  const stringified = String(arg ?? "");
  return `"${stringified.replace(/"/g, '""')}"`;
}

function buildStartupCommandLine() {
  const exe = quoteForCmd(process.execPath);
  const argList = process.argv.slice(1).map(quoteForCmd);
  return [exe].concat(argList).join(" ").trim();
}

ipcMain.handle("startup:get-start-with-windows", async () => {
  return await hasStartupTask();
});

ipcMain.handle("startup:set-start-with-windows", async (_e, enabled) => {
  if (enabled) {
    const commandLine = buildStartupCommandLine();
    await createStartupTask(commandLine);
  } else {
    await deleteStartupTask();
  }
  return true;
});

ipcMain.handle(
  "rarity:refresh-selected-config",
  async (_event, payload = {}) => {
    const incomingName =
      typeof payload === "string"
        ? payload
        : payload?.configName || payload?.name || "";
    const configName = String(incomingName || "").trim();
    if (!configName) {
      return {
        success: false,
        code: "config-required",
        message: "Config name is required.",
      };
    }

    const safeName = sanitizeConfigName(configName);
    const configPath = path.join(configsDir, `${safeName}.json`);
    if (!fs.existsSync(configPath)) {
      return {
        success: false,
        code: "config-missing",
        message: "Selected config was not found.",
      };
    }

    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      return {
        success: false,
        code: "config-read-failed",
        message: `Failed to read config: ${err?.message || String(err)}`,
      };
    }

    const schemaPath = resolveAchievementsSchemaPath(config);
    if (!schemaPath) {
      return {
        success: false,
        code: "schema-missing",
        message: "Achievements schema file was not found for this config.",
      };
    }

    let schemaAchievements = null;
    try {
      schemaAchievements = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    } catch (err) {
      return {
        success: false,
        code: "schema-read-failed",
        message: `Failed to read achievements schema: ${err?.message || String(err)}`,
      };
    }
    if (!Array.isArray(schemaAchievements)) {
      return {
        success: false,
        code: "schema-invalid",
        message: "Achievements schema is invalid for rarity refresh.",
      };
    }

    const platform = normalizePlatform(config?.platform) || "steam";
    const supportedPlatform =
      platform === "steam" ||
      platform === "steam-official" ||
      platform === "uplay" ||
      platform === "epic" ||
      platform === "gog";

    if (!supportedPlatform) {
      return {
        success: false,
        code: "unsupported-platform",
        message: `Rarity refresh is supported only for Steam/Uplay/Epic/GOG configs (current: ${platform}).`,
      };
    }

    if (platform === "gog") {
      const productId =
        config?.appid != null ? String(config.appid).trim() : "";
      if (!productId) {
        return {
          success: false,
          code: "invalid-gog-product-id",
          message: "GOG Product ID for rarity refresh is invalid.",
        };
      }
      const source = RARITY_SOURCES.gogGameplay;
      rarityLogger.info("rarity:manual-refresh:start", {
        configName: config?.name || safeName,
        platform,
        appid: productId,
        source,
      });
      try {
        const token = await ensureGogAccessToken({
          userDataDir: app.getPath("userData"),
          timeoutMs: 15000,
        });
        const fetchedMap = await fetchGogGlobalAchievementPercentages(
          productId,
          {
            accessToken: token?.access_token,
            userId: token?.user_id,
            timeoutMs: 15000,
            lang: "en-US",
          },
        );
        if (!fetchedMap.size) {
          rarityLogger.warn("rarity:gog:empty", {
            appid: productId,
            source,
            configName: config?.name || safeName,
          });
        }
        const entries = buildRarityEntriesForSchema(
          fetchedMap,
          schemaAchievements,
          {
            normalizeName: (name) =>
              typeof name === "string" || typeof name === "number"
                ? String(name).trim()
                : "",
          },
        );
        const sidecarPath = writeAchievementPercentagesSidecar(
          path.dirname(schemaPath),
          productId,
          entries,
          { source },
        );
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        });
        broadcastToAll("refresh-achievements-table", config?.name || safeName);
        return {
          success: true,
          configName: config?.name || safeName,
          platform,
          appid: productId,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source,
          error: err?.message || String(err),
        });
        return {
          success: false,
          code: "fetch-failed",
          message: `Rarity refresh failed: ${err?.message || String(err)}`,
        };
      }
    }

    if (platform === "epic") {
      const productId =
        config?.appid != null ? String(config.appid).trim() : "";
      if (!productId) {
        return {
          success: false,
          code: "invalid-epic-product-id",
          message: "Epic Product ID for rarity refresh is invalid.",
        };
      }
      const source = RARITY_SOURCES.epicPublic;
      rarityLogger.info("rarity:manual-refresh:start", {
        configName: config?.name || safeName,
        platform,
        appid: productId,
        source,
      });
      try {
        const fetchedMap = await fetchEpicGlobalAchievementPercentages(
          productId,
          {
            locale: "en",
            timeoutMs: 15000,
          },
        );
        if (!fetchedMap.size) {
          rarityLogger.warn("rarity:epic:empty", {
            appid: productId,
            source,
            configName: config?.name || safeName,
          });
        }
        const entries = buildRarityEntriesForSchema(
          fetchedMap,
          schemaAchievements,
          {
            normalizeName: (name) =>
              typeof name === "string" || typeof name === "number"
                ? String(name).trim()
                : "",
          },
        );
        const sidecarPath = writeAchievementPercentagesSidecar(
          path.dirname(schemaPath),
          productId,
          entries,
          { source },
        );
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        });
        broadcastToAll("refresh-achievements-table", config?.name || safeName);
        return {
          success: true,
          configName: config?.name || safeName,
          platform,
          appid: productId,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source,
          error: err?.message || String(err),
        });
        return {
          success: false,
          code: "fetch-failed",
          message: `Rarity refresh failed: ${err?.message || String(err)}`,
        };
      }
    }

    const resolved = resolveSteamAppIdForRarity(config);
    const steamAppId = String(resolved?.steamAppId || "").trim();
    if (platform === "uplay" && !resolved?.mapped) {
      return {
        success: false,
        code: "uplay-steam-mapping-missing",
        message:
          "Steam AppID mapping for this Uplay config is missing. Refresh mapping and try again.",
      };
    }
    if (!/^\d+$/.test(steamAppId)) {
      return {
        success: false,
        code: "invalid-steam-appid",
        message: "Steam AppID for rarity refresh is invalid.",
      };
    }

    const source = RARITY_SOURCES.steamGlobal;
    rarityLogger.info("rarity:manual-refresh:start", {
      configName: config?.name || safeName,
      platform,
      appid: steamAppId,
      source,
    });
    try {
      const fetchedMap = await fetchSteamGlobalAchievementPercentages(
        steamAppId,
        {
          timeoutMs: 15000,
        },
      );
      if (!fetchedMap.size) {
        rarityLogger.warn("rarity:steam:empty", {
          appid: steamAppId,
          source,
          configName: config?.name || safeName,
        });
      }
      const entries = buildRarityEntriesForSchema(
        fetchedMap,
        schemaAchievements,
        {
          normalizeName: (name) =>
            normalizeAchievementNameForRarity(
              name,
              resolved?.stripNames === true,
            ),
        },
      );
      const sidecarPath = writeAchievementPercentagesSidecar(
        path.dirname(schemaPath),
        steamAppId,
        entries,
        { source },
      );
      rarityLogger.info("rarity:manual-refresh:written", {
        configName: config?.name || safeName,
        platform,
        appid: steamAppId,
        source,
        sidecarPath,
        fetchedCount: fetchedMap.size,
        matchedCount: entries.length,
      });
      broadcastToAll("refresh-achievements-table", config?.name || safeName);
      return {
        success: true,
        configName: config?.name || safeName,
        platform,
        appid: steamAppId,
        sidecarPath,
        fetchedCount: fetchedMap.size,
        matchedCount: entries.length,
      };
    } catch (err) {
      rarityLogger.warn("rarity:manual-refresh:failed", {
        configName: config?.name || safeName,
        platform,
        appid: steamAppId,
        source,
        error: err?.message || String(err),
      });
      return {
        success: false,
        code: "fetch-failed",
        message: `Rarity refresh failed: ${err?.message || String(err)}`,
      };
    }
  },
);

ipcMain.handle("open-external-url", async (_evt, url) => {
  const raw = String(url || "").trim();
  try {
    if (!raw) throw new Error("url-required");
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid-protocol");
    }
    await shell.openExternal(parsed.toString());
    return { success: true };
  } catch (err) {
    ipcLogger.warn("open-external-url:failed", {
      url: raw || null,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
});

const {
  fetchSteamDbLibraryCover,
  fetchSteamGridDbImage,
} = require("./utils/game-cover");

ipcMain.handle("covers:steamdb", async (_evt, appid) => {
  try {
    const mapping = uplayToSteam.get(String(appid));
    const steamAppId = mapping?.steam_appid
      ? String(mapping.steam_appid)
      : String(appid);
    const url = await fetchSteamDbLibraryCover(String(steamAppId));
    return { ok: true, url };
  } catch (err) {
    const notFound = err && err.tag === Symbol.for("steamdb-miss");
    return { ok: false, notFound, message: String(err?.message || err) };
  }
});

ipcMain.handle("covers:steamgriddb", async (_evt, payload = {}) => {
  try {
    const term = String(payload?.term || "").trim();
    if (!term) throw new Error("term-required");
    const size = payload?.size || "600x900";
    const url = await fetchSteamGridDbImage(term, { size });
    return { ok: true, url };
  } catch (err) {
    const notFound = err && err.tag === Symbol.for("steamgriddb-miss");
    return { ok: false, notFound, message: String(err?.message || err) };
  }
});

ipcMain.handle("uplay:steam-appid", async (_evt, appid) => {
  const mapping = uplayToSteam.get(String(appid));
  return mapping?.steam_appid ? String(mapping.steam_appid) : null;
});

const {
  accumulatePlaytime,
  getPlaytimeInfo,
} = require("./utils/playtime-store");

ipcMain.on("playtime:session-ended", (_event, payload = {}) => {
  const safeKey = sanitizeConfigName(payload.configName || "");
  const info = getPlaytimeInfo(safeKey);
  const totalMs =
    typeof payload.totalMs === "number" ? payload.totalMs : info.totalMs;
  const updatedAt = Number(info.updatedAt) || (totalMs > 0 ? Date.now() : 0);

  broadcastToAll("playtime:update", {
    configName: payload.configName || "",
    totalMs,
    updatedAt,
  });
});

ipcMain.handle("playtime:get-total", async (_event, configName) => {
  const safe = sanitizeConfigName(configName);
  return getPlaytimeInfo(safe);
});

ipcMain.handle("covers:ui-log", async (_event, payload = {}) => {
  const level = ["info", "warn", "error"].includes(
    String(payload.level || "").toLowerCase(),
  )
    ? String(payload.level || "").toLowerCase()
    : "info";
  const message = String(payload.message || "").trim();
  const meta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  try {
    coverUiLogger[level](
      message || "covers:ui-log",
      Object.keys(meta).length ? meta : undefined,
    );
  } catch {}
  return true;
});

ipcMain.handle("ui:log", async (_event, payload = {}) => {
  const level = ["debug", "info", "warn", "error"].includes(
    String(payload.level || "").toLowerCase(),
  )
    ? String(payload.level || "").toLowerCase()
    : "info";
  const message = String(payload.message || "").trim();
  const meta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  try {
    uiLogger[level](
      message || "ui:log",
      Object.keys(meta).length ? meta : undefined,
    );
  } catch {}
  return true;
});

ipcMain.handle("overlay:log", async (_event, payload = {}) => {
  const level = ["debug", "info", "warn", "error"].includes(
    String(payload.level || "").toLowerCase(),
  )
    ? String(payload.level || "").toLowerCase()
    : "info";
  const message = String(payload.message || "").trim();
  const meta =
    payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  try {
    overlayLogger[level](
      message || "overlay:log",
      Object.keys(meta).length ? meta : undefined,
    );
  } catch {}
  return true;
});

const makeWatchedFolders = require("./utils/watched-folders");

watchedFoldersApi = makeWatchedFolders({
  app,
  ipcMain,
  BrowserWindow,
  preferencesPath,
  updatePreferences,
  configsDir,
  generateGameConfigs,
  generateConfigForAppId,
  notifyWarn: (m) => console.warn(m),
  requestDashboardRefresh,
  onSeedCache: ({ appid, configName, snapshot, platform }) => {
    try {
      let plat = normalizePlatform(platform) || "steam";
      if (!platform) {
        try {
          const cfgPath = configName
            ? path.join(configsDir, `${sanitizeConfigName(configName)}.json`)
            : null;
          if (cfgPath && fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
            plat = normalizePlatform(cfg?.platform) || plat;
          }
        } catch {}
      }
      seedCacheFromSnapshot(configName, snapshot, plat);
    } catch (e) {
      console.warn(
        tUi(
          "main.log.configGenerateFailedWithAppid",
          { name: configName, appid, error: e.message },
          `${configName} (${appid}) failed: ${e.message}`,
        ),
      );
    }
  },
  getCachedSnapshot: (configName, platform = "steam") => {
    try {
      const cachePath = getCachePath(
        configName,
        normalizePlatform(platform) || "steam",
      );
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed;
      }
    } catch (err) {
      console.warn(
        tUi(
          "main.log.configGenerateFailed",
          { name: configName, error: err.message },
          `${configName} failed: ${err.message}`,
        ),
      );
    }
    return null;
  },
  onEarned: (payload) => {
    const platform = normalizePlatform(payload?.platform);
    if (platform === "xenia") {
      queueXeniaNotificationWhenIconReady(payload);
      return;
    }
    queueAchievementNotification(payload);
  },
  onProgress: (payload) => {
    if (global.disableProgress) return;
    queueProgressNotification(payload);
  },
  isConfigActive: (name) =>
    sanitizeConfigName(name) === sanitizeConfigName(selectedConfig),
  onPlatinumComplete: handlePlatinumComplete,
});

scheduleManualCacheSeedAfterBoot();

// === screenshots support ===
let screenshot = null;
try {
  screenshot = require("screenshot-desktop");
} catch (e) {
  console.warn(
    '⚠️ "screenshot-desktop" missing. Run: npm i screenshot-desktop',
  );
}

function readPrefsSafe() {
  try {
    return fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
  } catch (err) {
    prefsLogger.error("read-preferences:error", { error: err.message });
    return {};
  }
}
ipcMain.handle("platinum:manual", async (_event, payload = {}) => {
  const {
    configName = "",
    appid = null,
    savePath = null,
    configPath = null,
    suppressNotify = false,
  } = payload || {};
  const flagged = markConfigPlatinumFlag(configName);
  const alreadyFlagged = flagged === false;
  if (
    !suppressNotify &&
    !cachedPreferences.disablePlatinum &&
    !alreadyFlagged
  ) {
    handlePlatinumComplete({
      configName,
      appid,
      savePath,
      configPath,
      isActive: false,
    });
  }
  return { flagged: flagged || alreadyFlagged };
});
// Flag already-complete configs at boot to avoid retroactive platinum popups
async function flagPlatinumFromCacheOnBoot() {
  try {
    if (!configsDir || !fs.existsSync(configsDir)) return;
    const entries = await fs.promises.readdir(configsDir);
    const files = entries.filter((f) => f.toLowerCase().endsWith(".json"));
    if (!files.length) return;

    const BATCH_SIZE = 20;
    const CONCURRENCY = 4;
    const runWithConcurrency = async (items, limit, worker) => {
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
    };

    const processFile = async (file) => {
      const name = path.basename(file, ".json");
      const configPath = path.join(configsDir, file);
      let config = null;
      try {
        const raw = await fs.promises.readFile(configPath, "utf8");
        config = JSON.parse(raw);
      } catch {
        return;
      }
      const platform = normalizePlatform(config?.platform) || "steam";
      const seedCandidatePath = resolveBootSeedCandidatePath(config);
      const unchangedByMeta = seedCandidatePath
        ? isAchCacheMetaMatch(
            name,
            platform,
            seedCandidatePath,
            String(config?.appid || ""),
          )
        : false;
      if (unchangedByMeta && config?.platinum === true) return;
      const schemaPath = resolveConfigSchemaPath(config);
      if (!schemaPath) return;
      let schema = null;
      try {
        const rawSchema = await fs.promises.readFile(schemaPath, "utf8");
        schema = JSON.parse(rawSchema);
      } catch {
        return;
      }
      const schemaNames = Array.isArray(schema)
        ? schema
            .map((a) => (a && a.name ? String(a.name) : null))
            .filter(Boolean)
        : [];
      if (!schemaNames.length) return;

      const snapshot = (await loadPreviousAchievements(name, platform)) || {};
      const isEarnedByName = (achName) => {
        const main = snapshot?.[achName];
        if (main?.earned) return true;
        if (/^ach_/i.test(achName)) {
          const alt = achName.replace(/^ach_/i, "");
          return !!snapshot?.[alt]?.earned;
        }
        const withPrefix = `ach_${achName}`;
        return !!snapshot?.[withPrefix]?.earned;
      };

      const total = schemaNames.length;
      const earned = schemaNames.filter(isEarnedByName).length;
      if (total > 0 && earned === total) {
        markConfigPlatinumFlag(name);
      }
    };

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await runWithConcurrency(batch, CONCURRENCY, processFile);
      await sleep(0);
    }
  } catch {}
}

app.on("before-quit", () => {
  stopActiveLumaPlayRegistryWatcher();
  stopAutoSelectProcessPoller();
  try {
    processPoller.setEnabled(false);
  } catch {}
  if (overlayDragHookBootWaitTimer) {
    clearTimeout(overlayDragHookBootWaitTimer);
    overlayDragHookBootWaitTimer = null;
  }
  flushCacheBatchWindow("before-quit", true);
  appLogger.info("app:before-quit", {
    isQuitting,
    hasMainWindow: !!mainWindow && !mainWindow.isDestroyed(),
  });
  isQuitting = true;
  manualLaunchInProgress = false;
  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    playtimeWindow.destroy();
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.destroy();
  }
});

app.on("window-all-closed", () => {
  appLogger.info("app:window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("render-process-gone", (_event, webContents, details) => {
  const crashedUrl = webContents?.getURL?.() || null;
  appLogger.error("process:render-gone", {
    reason: details?.reason,
    exitCode: details?.exitCode,
    type: details?.type,
    id: webContents?.id,
    url: crashedUrl,
  });
  ipcLogger.error("process:render-gone", {
    reason: details?.reason,
    exitCode: details?.exitCode,
    type: details?.type,
    id: webContents?.id,
    url: crashedUrl,
  });
  if (!isBootOnboardingGatePending()) return;
  const isMainRenderer = (() => {
    try {
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.webContents &&
        !mainWindow.webContents.isDestroyed()
      ) {
        return mainWindow.webContents.id === webContents?.id;
      }
    } catch {}
    const u = String(crashedUrl || "").toLowerCase();
    return u.includes("index.html");
  })();
  if (!isMainRenderer) return;
  scheduleBootOnboardingUiRecovery("render-process-gone", {
    processType: details?.type || null,
    reason: details?.reason || null,
  });
});

app.on("child-process-gone", (_event, details) => {
  appLogger.error("process:child-gone", {
    type: details?.type,
    reason: details?.reason,
    exitCode: details?.exitCode,
    name: details?.name,
  });
  ipcLogger.error("process:child-gone", {
    type: details?.type,
    reason: details?.reason,
    exitCode: details?.exitCode,
    name: details?.name,
  });
});
