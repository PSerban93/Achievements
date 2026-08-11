const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  screen,
  globalShortcut,
  Tray,
  shell,
  Notification,
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
if (process.platform === "win32") {
  app.setAppUserModelId("com.achievements.app");
}
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
const crypto = require("crypto");
const axios = require("axios");
const { pathToFileURL } = require("url");
const ini = require("ini");
const chokidar = require("chokidar");
const CRC32 = require("crc-32");
const AdmZip = require("adm-zip");
const { copyFolderOnce, copyFolderOverwrite } = require("./utils/fileCopy");
const { computeFolderContentVersion } = require("./utils/content-version");
const {
  readJsonWithBackupSync,
  writeJsonAtomicSync,
} = require("./utils/atomic-json-store");
const {
  validateAppIdDirectoryTarget,
} = require("./utils/config-deletion-paths");
const {
  defaultSoundsFolder,
  defaultPresetsFolder,
  userSoundsFolder,
  userPresetsFolder,
  preferencesPath,
  configsDir,
  cacheDir,
} = require("./utils/paths");
const { normalizeAppTheme } = require("./utils/app-theme");
const {
  configMatchesNavigationRoute,
  normalizeNavigationAppId,
  normalizeNavigationPlatform,
  normalizeNotificationNavigationTarget,
  parseAppNavigationArgs,
  stripAppNavigationArgs,
} = require("./utils/app-navigation");
const {
  buildNativeWindowsAchievementToastXml,
  decodeNativeWindowsNotificationLaunchArguments,
  encodeNativeWindowsNotificationLaunchArguments,
  NativeWindowsNotificationReferenceStore,
} = require("./utils/native-windows-notification-navigation");
const {
  buildBlacklistConfigKey,
  normalizeAppIdValue,
  normalizeBlacklistConfigKey,
  normalizeBlacklistPlatformValue,
} = require("./utils/blacklist-identity");
const {
  resolveConfigJsonPath,
  sanitizeConfigName,
} = require("./utils/config-name");
const {
  ensureUserThemes,
  getThemeRegistryPayload,
} = require("./utils/theme-manager");
const {
  pickWindowsExecutableOrShortcut,
} = require("./utils/windows-shortcut-picker");
const { ensureSchemaParseRuntimeReady } = require("./utils/steam-schema-parse");
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
  normalizeAppcacheSchemaEntries,
  enrichSchemaEntriesFromAppcacheSchemaFile,
  pickPreferredUserBin,
  parseUserBinName,
} = require("./utils/steam-appcache");
const {
  listSteamLoginUsers,
  steamId64ToAccountId,
} = require("./utils/steam-local-users");
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
  normalizeRarityPercent,
} = require("./utils/achievement-rarity");
const { ensureGogAccessToken } = require("./utils/gog-auth");
const {
  bindingsCanConflict: overlayBindingsCanConflict,
  createOverlayShortcutManager,
  getShortcutBindingSignature: getOverlayShortcutBindingSignature,
  normalizeShortcutAccelerator: normalizeOverlayShortcutAccelerator,
  parseShortcutAccelerator: parseOverlayShortcutAccelerator,
} = require("./utils/overlay-shortcut-manager");
const {
  DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
  DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
  OVERLAY_CONTROLLER_CONTROL_MODE_ALLOWED_BUTTONS,
  OVERLAY_CONTROLLER_TOGGLE_ALLOWED_BUTTONS,
  inspectControllerBackendAvailability,
  normalizeBackendPreference,
  normalizeControllerBinding,
} = require("./utils/controller-input-manager");
const {
  createOverlayControllerService,
} = require("./utils/overlay-controller-service");
const { autoUpdater } = require("electron-updater");
const getConfigInflight = new Map();
const epicOfficialLoadSyncInflight = new Map();
const epicOfficialRecentLoadSync = new Map();
const epicOfficialPassiveLoadSync = new Map();
const epicOfficialSilentSeedState = new Map();
const epicOfficialCacheOnlyLogState = new Map();
const epicOfficialRecentUnlockNotificationState = new Map();
const xboxPcLoadSyncInflight = new Map();
const xboxPcRecentLoadSync = new Map();
const XBOX_PC_RECENT_SYNC_MAX_ENTRIES = 500;
const EPIC_OFFICIAL_LOAD_SYNC_DEDUPE_MS = 2000;
const EPIC_OFFICIAL_RECENT_SYNC_TTL_MS = 5 * 60 * 1000;
const EPIC_OFFICIAL_PASSIVE_SYNC_TTL_MS = 10 * 60 * 1000;
const EPIC_OFFICIAL_SILENT_SEED_TTL_MS = 6 * 60 * 60 * 1000;
const EPIC_OFFICIAL_CACHE_ONLY_LOG_TTL_MS = 60 * 1000;
const EPIC_OFFICIAL_UNLOCK_NOTIFY_DEDUPE_MS = 30000;
const EPIC_OFFICIAL_RECENT_SYNC_MAX_ENTRIES = 500;
const EPIC_OFFICIAL_PASSIVE_SYNC_MAX_ENTRIES = 500;
const EPIC_OFFICIAL_SILENT_SEED_MAX_ENTRIES = 500;
const EPIC_OFFICIAL_CACHE_ONLY_LOG_MAX_ENTRIES = 500;
const { createLogger } = require("./utils/logger");
const {
  getProcessExecutableNames,
  hasProcessNameValue,
  normalizeProcessNameValue,
  processNameValuesEqual,
} = require("./utils/process-name-utils");
const {
  PROCESS_CONFIG_MATCH,
  classifyProcessConfigMatch,
  getProcessConfigMatchRank,
  selectBestProcessConfigCandidate,
} = require("./utils/process-config-match");

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
const updateLogger = createLogger("updates");
const epicOfficialLogger = createLogger("epic-official", {
  level: process.env.EPIC_OFFICIAL_LOG_LEVEL || "info",
});
const xboxPcLogger = createLogger("xbox-pc", {
  level: process.env.XBOX_PC_LOG_LEVEL || "info",
});
const controllerLogger = createLogger("controller", {
  level: process.env.CONTROLLER_LOG_LEVEL || "info",
});
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
const SAN_PRESETS_FOLDER_NAME = "SANpresets";
const SAN_CACHE_FOLDER_NAME = "SANcache";
const SAN_RUNTIME_FOLDER = path.join(__dirname, "assets", "san-runtime");
const SAN_BUILTIN_PRESET_ID_PREFIX = "builtin:";
const SAN_AUDIO_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
]);
const SAN_PRESET_DIMENSIONS = {
  default: { width: 300, height: 50 },
  xqjan: { width: 300, height: 50 },
  steamdeck: { width: 300, height: 50 },
  epicgames: { width: 300, height: 50 },
  xboxone: { width: 400, height: 100 },
  xbox360: { width: 400, height: 100 },
  ps5: { width: 300, height: 50 },
  ps4: { width: 300, height: 50 },
  ps3: { width: 300, height: 50 },
  windows: { width: 300, height: 80 },
  gfwl: { width: 300, height: 80 },
  os: { width: 360, height: 120 },
};
const SAN_DEFAULT_PRESET_ICONS = {
  default: {
    logo: ["img", "sanlogosquare.svg"],
    decoration: ["img", "sanlogotrophy.svg"],
    elems: ["unlockmsg", "title", "desc"],
  },
  xqjan: {
    logo: ["img", "steamlogonew.svg"],
    elems: ["unlockmsg", "title", "desc"],
  },
  steamdeck: {
    decoration: ["img", "ribbonbw.svg"],
    elems: ["title", "desc"],
  },
  epicgames: {
    decoration: [
      ["img", "sanlogotrophy_bronze.svg"],
      ["img", "sanlogotrophy_silver.svg"],
      ["img", "sanlogotrophy_gold.svg"],
    ],
    elems: ["title"],
  },
  xboxone: {
    logo: ["img", "sanlogotrophy.svg"],
    elems: ["unlockmsg", "title", "desc"],
  },
  xbox360: {
    logo: ["img", "sanlogotrophy_small.svg"],
    elems: ["unlockmsg", "title"],
  },
  ps5: {
    logo: ["img", "sanlogo.svg"],
    decoration: [
      ["img", "sanlogotrophy_bronze.svg"],
      ["img", "sanlogotrophy_silver.svg"],
      ["img", "sanlogotrophy_gold.svg"],
    ],
    elems: ["title", "desc"],
  },
  ps4: {
    logo: ["img", "sanlogo.svg"],
    decoration: [
      ["img", "sanlogotrophy_bronze.svg"],
      ["img", "sanlogotrophy_silver.svg"],
      ["img", "sanlogotrophy_gold.svg"],
    ],
    elems: ["unlockmsg", "title"],
  },
  ps3: {
    decoration: [
      ["img", "sanlogotrophy_bronze.svg"],
      ["img", "sanlogotrophy_silver.svg"],
      ["img", "sanlogotrophy_gold.svg"],
    ],
    elems: ["unlockmsg", "title"],
  },
  windows: {
    logo: ["img", "sanlogotrophy.svg"],
    elems: ["unlockmsg", "title", "desc"],
  },
  gfwl: {
    logo: ["img", "sanlogotrophy_small.svg"],
    elems: ["unlockmsg", "title"],
  },
  os: {
    logo: ["img", "sanlogotrophy.svg"],
    elems: ["unlockmsg", "title", "desc"],
  },
};
function normalizeSanPresetKey(preset) {
  return String(preset || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "") || "default";
}

function toFileUrl(filePath) {
  return pathToFileURL(filePath).toString();
}

function getSanRuntimePath(...parts) {
  return path.join(SAN_RUNTIME_FOLDER, ...parts);
}

function getSanRuntimeAssetPath(value) {
  if (Array.isArray(value)) {
    return getSanRuntimePath(...value);
  }
  return "";
}

function resolveSanRuntimeAssetValue(value) {
  if (Array.isArray(value) && Array.isArray(value[0])) {
    return value.map((entry) => getSanRuntimeAssetPath(entry));
  }
  if (Array.isArray(value)) return getSanRuntimeAssetPath(value);
  return value || "";
}

function getSanRuntimePresetPath(preset, fileName) {
  const safePreset = normalizeSanPresetKey(preset);
  const candidate = getSanRuntimePath(
    "notify",
    "presets",
    safePreset,
    fileName,
  );
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  return getSanRuntimePath("notify", "presets", "default", fileName);
}

function getSanRuntimePresetHtml(preset) {
  const indexPath = getSanRuntimePresetPath(preset, "index.html");
  return fs.readFileSync(indexPath, "utf8");
}

function getSanRuntimePresetDimensions(preset) {
  try {
    const html = getSanRuntimePresetHtml(preset);
    const meta = html.match(
      /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"(?:\s+offset\s*=\s*"(\d+)")?\s*\/?>/i,
    );
    if (meta) {
      return {
        width: Number(meta[1]) || 300,
        height: Number(meta[2]) || 50,
        offset: Number(meta[3]) || 20,
      };
    }
  } catch (err) {
    appLogger.warn("san-runtime:preset-dimensions-failed", {
      preset,
      error: err?.message || String(err),
    });
  }
  const fallback = SAN_PRESET_DIMENSIONS[normalizeSanPresetKey(preset)] ||
    SAN_PRESET_DIMENSIONS.default;
  return { ...fallback, offset: 20 };
}

function getSanPresetsFolder() {
  return path.join(app.getPath("userData"), SAN_PRESETS_FOLDER_NAME);
}

function getSanCacheFolder() {
  return path.join(app.getPath("userData"), SAN_CACHE_FOLDER_NAME);
}

function normalizeSanZipEntryName(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    segments.includes("..") ||
    normalized.includes("../") ||
    normalized === ".." ||
    normalized.startsWith("/")
  ) {
    return "";
  }
  return normalized;
}

function getSanPresetId(filePath, stat = null) {
  const details = path.resolve(filePath).toLowerCase();
  return crypto.createHash("sha1").update(details).digest("hex").slice(0, 16);
}

function isSanBuiltinPresetId(id) {
  return String(id || "").startsWith(SAN_BUILTIN_PRESET_ID_PREFIX);
}

function readSanArchive(filePath) {
  const stat = fs.statSync(filePath);
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (!normalizeSanZipEntryName(entry.entryName)) {
      throw new Error(`Unsafe SAN archive entry: ${entry.entryName}`);
    }
  }
  const themeEntry = zip.getEntry("usertheme.json");
  if (!themeEntry) {
    throw new Error('SAN archive is missing "usertheme.json"');
  }
  const theme = JSON.parse(zip.readAsText(themeEntry));
  if (!theme || typeof theme !== "object" || !theme.customisation) {
    throw new Error("SAN theme customisation is missing");
  }
  const id = getSanPresetId(filePath, stat);
  const sounds = entries
    .filter((entry) => !entry.isDirectory)
    .filter((entry) =>
      SAN_AUDIO_EXTENSIONS.has(path.extname(entry.entryName).toLowerCase()),
    )
    .map((entry) => ({
      entryName: entry.entryName,
      fileName: path.basename(entry.entryName),
      value: `san:${id}:${Buffer.from(entry.entryName, "utf8").toString(
        "base64url",
      )}`,
    }));

  const source = theme.source === "achievements-default" ? "default" : "imported";
  const preset = String(theme.customisation?.preset || "default").trim();
  const presetKey = normalizeSanPresetKey(preset);
  const fileLabel = path.basename(filePath, ".san").trim();
  const themeLabel = String(theme.label || "").trim();
  const label = source === "default"
    ? themeLabel || fileLabel
    : fileLabel || themeLabel || presetKey;

  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    label,
    preset,
    version: String(theme.version || "").trim(),
    source,
    legacyId: "",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sounds,
    theme,
  };
}

function getSanPresetDisplayLabel(label) {
  const clean = String(label || "").trim();
  if (!clean) return "SAN";
  return /^SAN\s+-\s+/i.test(clean) ? clean : `SAN - ${clean}`;
}

function listSanPresets() {
  const folder = getSanPresetsFolder();
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    appLogger.warn("san-presets:folder-create-failed", {
      folder,
      error: err?.message || String(err),
    });
    return [];
  }

  let files = [];
  try {
    files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => path.extname(name).toLowerCase() === ".san")
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    appLogger.warn("san-presets:list-failed", {
      folder,
      error: err?.message || String(err),
    });
    return [];
  }

  const presets = [];
  for (const fileName of files) {
    const filePath = path.join(folder, fileName);
    try {
      const info = readSanArchive(filePath);
      if (info.source === "default") continue;
      presets.push({
        id: info.id,
        label: info.label,
        displayLabel: getSanPresetDisplayLabel(info.label),
        fileName: info.fileName,
        preset: info.preset,
        version: info.version,
        source: info.source,
        legacyId: info.legacyId,
        sounds: info.sounds,
      });
    } catch (err) {
      appLogger.warn("san-presets:invalid", {
        filePath,
        error: err?.message || String(err),
      });
    }
  }
  return presets.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "default" ? -1 : 1;
    }
    return String(a.displayLabel || a.label || a.fileName || "").localeCompare(
      String(b.displayLabel || b.label || b.fileName || ""),
    );
  });
}

function findSanPresetById(id) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  if (isSanBuiltinPresetId(wanted)) return null;
  const folder = getSanPresetsFolder();
  try {
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => path.extname(name).toLowerCase() === ".san");
    for (const fileName of files) {
      const filePath = path.join(folder, fileName);
      const info = readSanArchive(filePath);
      if (info.id === wanted) return info;
    }
  } catch (err) {
    appLogger.warn("san-presets:find-failed", {
      id: wanted,
      error: err?.message || String(err),
    });
  }
  return null;
}

function ensureSanPresetCache(info) {
  if (!info?.id || !info?.filePath) return "";
  const cacheDir = path.join(getSanCacheFolder(), info.id);
  const markerPath = path.join(cacheDir, ".source.json");
  const marker = {
    filePath: info.filePath,
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs || 0),
  };
  try {
    if (fs.existsSync(markerPath)) {
      const existing = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (
        existing?.filePath === marker.filePath &&
        existing?.size === marker.size &&
        existing?.mtimeMs === marker.mtimeMs
      ) {
        return cacheDir;
      }
    }
  } catch {}

  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = new AdmZip(info.filePath);
  for (const entry of zip.getEntries()) {
    const safeName = normalizeSanZipEntryName(entry.entryName);
    if (!safeName) {
      throw new Error(`Unsafe SAN archive entry: ${entry.entryName}`);
    }
    const targetPath = path.resolve(cacheDir, safeName);
    const cacheRoot = path.resolve(cacheDir);
    if (targetPath !== cacheRoot && !targetPath.startsWith(cacheRoot + path.sep)) {
      throw new Error(`Unsafe SAN extraction target: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, entry.getData());
  }
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
  return cacheDir;
}

function resolveSanAssetPath(cacheDir, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidate = path.join(cacheDir, "assets", path.basename(raw));
  try {
    return fs.existsSync(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

function resolveSanAssetList(cacheDir, value) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveSanAssetPath(cacheDir, item)).filter(Boolean);
  }
  const single = resolveSanAssetPath(cacheDir, value);
  return single ? [single] : [];
}

function resolveSanThemeAssetPath(cacheDir, value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
  } catch {}
  return resolveSanAssetPath(cacheDir, raw);
}

function resolveSanThemeAssetList(cacheDir, value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => resolveSanThemeAssetPath(cacheDir, item))
      .filter(Boolean);
  }
  const single = resolveSanThemeAssetPath(cacheDir, value);
  return single ? [single] : [];
}

function rewriteSanCustomisationAssetPaths(cacheDir, value) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteSanCustomisationAssetPaths(cacheDir, item));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entryValue] of Object.entries(value)) {
      out[key] = rewriteSanCustomisationAssetPaths(cacheDir, entryValue);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  if (!value.trim()) return value;
  const ext = path.extname(value).toLowerCase();
  const likelyAssetExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ttf",
    ".otf",
    ".wav",
    ".mp3",
    ".ogg",
    ".aac",
    ".flac",
    ".m4a",
  ]);
  if (!likelyAssetExts.has(ext)) return value;
  return resolveSanAssetPath(cacheDir, value) || value;
}

function getSanPresetIcons(customisation = {}) {
  const presetKey = normalizeSanPresetKey(customisation.preset);
  const icons = customisation.customicons || {};
  return icons[customisation.preset] || icons[presetKey] || {};
}

function sanRuntimeAssetIfExists(...parts) {
  const filePath = getSanRuntimePath(...parts);
  try {
    return fs.existsSync(filePath) ? filePath : "";
  } catch {
    return "";
  }
}

function mergeSanRuntimeDefaults(customisation = {}) {
  const presetKey = normalizeSanPresetKey(customisation.preset);
  const runtimeDefaults =
    SAN_DEFAULT_PRESET_ICONS[presetKey] || SAN_DEFAULT_PRESET_ICONS.default;
  const customIcons =
    customisation.customicons && typeof customisation.customicons === "object"
      ? { ...customisation.customicons }
      : {};
  const existingIcons =
    customIcons[customisation.preset] || customIcons[presetKey] || {};
  const defaultIcons = {};

  for (const [key, value] of Object.entries(runtimeDefaults)) {
    defaultIcons[key] = resolveSanRuntimeAssetValue(value);
  }

  const mergedIcons = {
    ...defaultIcons,
    ...existingIcons,
  };

  customIcons[presetKey] = mergedIcons;
  if (customisation.preset && customisation.preset !== presetKey) {
    customIcons[customisation.preset] = mergedIcons;
  }

  return {
    ...customisation,
    preset: presetKey,
    customicons: customIcons,
    iconanim: customisation.iconanim !== false,
    showdecoration: customisation.showdecoration !== false,
    bgimg: customisation.bgimg || sanRuntimeAssetIfExists("img", "sanimgbg.png"),
    base64: customisation.base64 || sanRuntimeAssetIfExists("img", "base64.png"),
    gameicon: customisation.gameicon || sanRuntimeAssetIfExists("img", "gameicon.png"),
    maskimg: customisation.maskimg || sanRuntimeAssetIfExists("img", "san_trophy_mask.png"),
    iconborderimg:
      customisation.iconborderimg || sanRuntimeAssetIfExists("img", "saniconborder.png"),
    iconborderimgbronze:
      customisation.iconborderimgbronze ||
      sanRuntimeAssetIfExists("img", "saniconborder_bronze.png"),
    iconborderimgsilver:
      customisation.iconborderimgsilver ||
      sanRuntimeAssetIfExists("img", "saniconborder_silver.png"),
    percentbadgeimgbronze:
      customisation.percentbadgeimgbronze ||
      sanRuntimeAssetIfExists("img", "sanlogotrophy_bronze.svg"),
    percentbadgeimgsilver:
      customisation.percentbadgeimgsilver ||
      sanRuntimeAssetIfExists("img", "sanlogotrophy_silver.svg"),
    percentbadgeimggold:
      customisation.percentbadgeimggold ||
      sanRuntimeAssetIfExists("img", "sanlogotrophy_gold.svg"),
    hiddenicon: customisation.hiddenicon || sanRuntimeAssetIfExists("icon", "lock.svg"),
    defaultAchIcon: customisation.defaultAchIcon || sanRuntimeAssetIfExists("img", "achicon.png"),
  };
}

function buildSanThemeForNotification(sanPresetId, notificationScale = 1) {
  const info = findSanPresetById(sanPresetId);
  if (!info) return null;
  const cacheDir = ensureSanPresetCache(info);
  const theme = JSON.parse(fs.readFileSync(path.join(cacheDir, "usertheme.json"), "utf8"));
  const customisation = mergeSanRuntimeDefaults(
    rewriteSanCustomisationAssetPaths(cacheDir, theme.customisation || {}),
  );
  const presetKey = normalizeSanPresetKey(customisation.preset);
  const baseDimensions = getSanRuntimePresetDimensions(presetKey);
  const sanScaleRaw = Number(customisation.scale);
  const baseSanScale = Number.isFinite(sanScaleRaw) && sanScaleRaw > 0
    ? sanScaleRaw / 100
    : 1;
  const appScaleRaw = Number(notificationScale);
  const appScale = Number.isFinite(appScaleRaw) && appScaleRaw > 0
    ? appScaleRaw
    : 1;
  const sanScale = baseSanScale * appScale;
  const effectiveSanScalePercent = Math.max(1, sanScale * 100);
  const bgImage = resolveSanThemeAssetPath(cacheDir, customisation.bgimg);
  const customFont = resolveSanThemeAssetPath(cacheDir, customisation.customfont);
  const hiddenIcon = resolveSanThemeAssetPath(cacheDir, customisation.hiddenicon);
  const customIcon = resolveSanThemeAssetPath(cacheDir, customisation.customimgicon);
  const presetIcons = getSanPresetIcons(customisation);
  const logo = resolveSanThemeAssetPath(cacheDir, presetIcons.logo);
  const decorations = resolveSanThemeAssetList(cacheDir, presetIcons.decoration);
  const mask = resolveSanThemeAssetPath(cacheDir, customisation.maskimg);

  return {
    id: info.id,
    label: info.label,
    cacheDir,
    preset: presetKey,
    width: Math.max(
      260,
      Math.ceil((baseDimensions.width + (baseDimensions.offset || 20) * 2) * sanScale),
    ),
    height: Math.max(
      90,
      Math.ceil((baseDimensions.height + (baseDimensions.offset || 20) * 2) * sanScale),
    ),
    scale: sanScale,
    presetHtml: getSanRuntimePresetHtml(presetKey),
    runtime: {
      globalCssUrl: toFileUrl(getSanRuntimePath("dist", "app", "global.css")),
      baseCssUrl: toFileUrl(getSanRuntimePath("notify", "base.css")),
      baseAnimCssUrl: toFileUrl(getSanRuntimePath("notify", "baseanim.css")),
      presetCssUrl: toFileUrl(getSanRuntimePresetPath(presetKey, "styles.css")),
    },
    presetDimensions: baseDimensions,
    customisation: {
      ...customisation,
      preset: presetKey,
      scale: effectiveSanScalePercent,
      sourceScale: Number(customisation.scale) || 100,
      notificationScale: appScale,
      displaytime: Number(customisation.displaytime) || 8,
      bgstyle: customisation.bgstyle || "",
      bgImage,
      bgimgbrightness: Number(customisation.bgimgbrightness) || 100,
      blur: Number(customisation.blur) || 0,
      brightness: Number(customisation.brightness) || 100,
      roundness: Number(customisation.roundness) || 0,
      opacity: Number(customisation.opacity) || 100,
      primarycolor: customisation.primarycolor || "#203e7a",
      secondarycolor: customisation.secondarycolor || "#0c2a66",
      tertiarycolor: customisation.tertiarycolor || "#ffffff",
      fontcolor: customisation.fontcolor || "#ffffff",
      titlefontcolor: customisation.titlefontcolor || customisation.fontcolor || "#ffffff",
      descfontcolor: customisation.descfontcolor || customisation.fontcolor || "#ffffff",
      fontshadow: customisation.fontshadow === true,
      fontshadowcolor: customisation.fontshadowcolor || "#000000",
      fontoutline: customisation.fontoutline === true,
      fontoutlinecolor: customisation.fontoutlinecolor || "#000000",
      fontsize: Number(customisation.fontsize) || 100,
      iconroundness: Number(customisation.iconroundness) || 0,
      iconscale: Number(customisation.iconscale) || 100,
      logoscale: Number(customisation.logoscale) || 100,
      customFont,
      hiddenIcon,
      customIcon,
      logo,
      decorations,
      mask: customisation.mask === true,
      maskimg: mask,
      usegameicon: customisation.usegameicon === true,
      usecustomimgicon: customisation.usecustomimgicon === true,
      replacelogo: customisation.replacelogo === true,
      showdecoration: customisation.showdecoration === true,
      maskEnabled: customisation.mask === true,
      bgonly: customisation.bgonly === true,
    },
  };
}

function parseSanSoundValue(value) {
  const raw = String(value || "");
  if (!raw.startsWith("san:")) return null;
  const parts = raw.split(":");
  if (parts.length < 3) return null;
  const id = parts[1];
  const encoded = parts.slice(2).join(":");
  try {
    const entryName = Buffer.from(encoded, "base64url").toString("utf8");
    if (!normalizeSanZipEntryName(entryName)) return null;
    return { id, entryName };
  } catch {
    return null;
  }
}

function resolveSanSoundPath(value) {
  const parsed = parseSanSoundValue(value);
  if (!parsed) return "";
  const info = findSanPresetById(parsed.id);
  if (!info) return "";
  const cacheDir = ensureSanPresetCache(info);
  const target = path.resolve(cacheDir, parsed.entryName);
  const root = path.resolve(cacheDir);
  if (target !== root && !target.startsWith(root + path.sep)) return "";
  try {
    return fs.existsSync(target) ? target : "";
  } catch {
    return "";
  }
}

function isSupportedNotificationSoundFile(fileName) {
  return SAN_AUDIO_EXTENSIONS.has(path.extname(String(fileName || "")).toLowerCase());
}

function getSanExportedSoundFileName(info, entryName, index = 0, total = 1) {
  const ext = path.extname(entryName).toLowerCase();
  const label = sanitizeFilename(info?.label || info?.fileName || "SAN Preset") || "SAN Preset";
  const suffix = total > 1 ? ` ${index + 1}` : "";
  return `SAN - ${label}${suffix}${ext}`;
}

function getSanLegacyExportedSoundFileName(info, entryName) {
  const ext = path.extname(entryName).toLowerCase();
  const rawBase = path.basename(entryName, ext);
  const label = sanitizeFilename(info?.label || info?.fileName || "SAN Preset") || "SAN Preset";
  const base = sanitizeFilename(rawBase || "sound") || "sound";
  const hash = crypto
    .createHash("sha1")
    .update(`${info?.id || ""}:${entryName}`)
    .digest("hex")
    .slice(0, 8);
  return `SAN - ${label} - ${base}-${hash}${ext}`;
}

function exportSanPresetSoundsToUserSounds(info) {
  if (!info?.filePath) return 0;
  let exported = 0;
  try {
    const zip = new AdmZip(info.filePath);
    fs.mkdirSync(userSoundsFolder, { recursive: true });
    const soundEntries = zip
      .getEntries()
      .filter((entry) => {
        if (entry.isDirectory) return false;
        const entryName = normalizeSanZipEntryName(entry.entryName);
        return !!entryName && isSupportedNotificationSoundFile(entryName);
      });
    for (const [index, entry] of soundEntries.entries()) {
      const entryName = normalizeSanZipEntryName(entry.entryName);
      const fileName = getSanExportedSoundFileName(
        info,
        entryName,
        index,
        soundEntries.length,
      );
      const targetPath = path.join(userSoundsFolder, fileName);
      if (!fs.existsSync(targetPath)) {
        fs.writeFileSync(targetPath, entry.getData());
        exported += 1;
      }
      const legacyPath = path.join(
        userSoundsFolder,
        getSanLegacyExportedSoundFileName(info, entryName),
      );
      if (legacyPath !== targetPath && fs.existsSync(legacyPath)) {
        fs.rmSync(legacyPath, { force: true });
      }
    }
  } catch (err) {
    appLogger.warn("san-presets:sounds-export-failed", {
      filePath: info.filePath,
      error: err?.message || String(err),
    });
  }
  return exported;
}

function listExpectedSanExportedSoundNames(presetInfos) {
  const expected = new Set();
  for (const info of presetInfos) {
    try {
      const zip = new AdmZip(info.filePath);
      const soundEntries = zip
        .getEntries()
        .filter((entry) => {
          if (entry.isDirectory) return false;
          const entryName = normalizeSanZipEntryName(entry.entryName);
          return !!entryName && isSupportedNotificationSoundFile(entryName);
        });
      soundEntries.forEach((entry, index) => {
        const entryName = normalizeSanZipEntryName(entry.entryName);
        expected.add(
          getSanExportedSoundFileName(info, entryName, index, soundEntries.length),
        );
      });
    } catch {}
  }
  return expected;
}

function cleanupStaleSanExportedSounds(expectedNames) {
  if (!fs.existsSync(userSoundsFolder)) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(userSoundsFolder, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("SAN - ")) continue;
      if (!isSupportedNotificationSoundFile(entry.name)) continue;
      if (expectedNames.has(entry.name)) continue;
      fs.rmSync(path.join(userSoundsFolder, entry.name), { force: true });
      removed += 1;
    }
  } catch (err) {
    appLogger.warn("san-presets:sounds-cleanup-failed", {
      error: err?.message || String(err),
    });
  }
  return removed;
}

function syncSanPresetSoundsToUserSounds() {
  const folder = getSanPresetsFolder();
  try {
    fs.mkdirSync(userSoundsFolder, { recursive: true });
    if (!fs.existsSync(folder)) return 0;
    let exported = 0;
    const presetInfos = [];
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => path.extname(name).toLowerCase() === ".san");
    for (const fileName of files) {
      try {
        const info = readSanArchive(path.join(folder, fileName));
        if (info.source === "default") continue;
        presetInfos.push(info);
      } catch (err) {
        appLogger.warn("san-presets:sounds-scan-invalid", {
          fileName,
          error: err?.message || String(err),
        });
      }
    }
    const removed = cleanupStaleSanExportedSounds(
      listExpectedSanExportedSoundNames(presetInfos),
    );
    for (const info of presetInfos) {
      exported += exportSanPresetSoundsToUserSounds(info);
    }
    if (exported > 0 || removed > 0) {
      appLogger.info("san-presets:sounds-exported", { count: exported, removed });
    }
    return exported;
  } catch (err) {
    appLogger.warn("san-presets:sounds-sync-failed", {
      error: err?.message || String(err),
    });
    return 0;
  }
}

function buildEpicOfficialLoadSyncKey(configName, accountId, productId) {
  return [
    sanitizeConfigName(configName || ""),
    normalizeEpicAccountId(accountId) || "",
    String(productId || "").trim(),
  ].join("::");
}

function buildEpicOfficialPassiveSyncResult(config, achievements) {
  return {
    achievements: achievements || {},
    save_path: config?.save_path || "",
  };
}

function countEpicOfficialEarnedAchievements(snapshot = {}) {
  let count = 0;
  for (const entry of Object.values(snapshot || {})) {
    if (entry && typeof entry === "object" && entry.earned === true) {
      count += 1;
    }
  }
  return count;
}

function pruneTimestampedMap(
  map,
  { ttlMs = 0, maxEntries = 0, timestampKeys = ["timestamp"] } = {},
) {
  if (!(map instanceof Map) || map.size === 0) return 0;
  const now = Date.now();
  const getTimestamp = (entry) => {
    if (!entry || typeof entry !== "object") return 0;
    for (const key of timestampKeys) {
      const value = Number(entry?.[key] || 0);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };

  const expiredKeys = [];
  if (ttlMs > 0) {
    for (const [key, entry] of map.entries()) {
      const timestamp = getTimestamp(entry);
      if (timestamp > 0 && now - timestamp > ttlMs) {
        expiredKeys.push(key);
      }
    }
  }

  for (const key of expiredKeys) {
    map.delete(key);
  }

  if (maxEntries > 0 && map.size > maxEntries) {
    const overflow = map.size - maxEntries;
    const sortedEntries = Array.from(map.entries()).sort((a, b) => {
      return getTimestamp(a[1]) - getTimestamp(b[1]);
    });
    for (let i = 0; i < overflow; i += 1) {
      map.delete(sortedEntries[i][0]);
    }
  }

  return expiredKeys.length;
}

function pruneEpicOfficialRuntimeState() {
  pruneTimestampedMap(epicOfficialRecentLoadSync, {
    ttlMs: EPIC_OFFICIAL_RECENT_SYNC_TTL_MS,
    maxEntries: EPIC_OFFICIAL_RECENT_SYNC_MAX_ENTRIES,
  });
  pruneTimestampedMap(epicOfficialPassiveLoadSync, {
    ttlMs: EPIC_OFFICIAL_PASSIVE_SYNC_TTL_MS,
    maxEntries: EPIC_OFFICIAL_PASSIVE_SYNC_MAX_ENTRIES,
  });
  pruneTimestampedMap(epicOfficialSilentSeedState, {
    ttlMs: EPIC_OFFICIAL_SILENT_SEED_TTL_MS,
    maxEntries: EPIC_OFFICIAL_SILENT_SEED_MAX_ENTRIES,
  });
  pruneTimestampedMap(epicOfficialCacheOnlyLogState, {
    ttlMs: EPIC_OFFICIAL_CACHE_ONLY_LOG_TTL_MS,
    maxEntries: EPIC_OFFICIAL_CACHE_ONLY_LOG_MAX_ENTRIES,
    timestampKeys: ["loggedAt", "timestamp"],
  });
  if (epicOfficialRecentUnlockNotificationState.size > 1000) {
    const now = Date.now();
    for (const [key, timestamp] of epicOfficialRecentUnlockNotificationState) {
      if (
        now - Number(timestamp || 0) >
        EPIC_OFFICIAL_UNLOCK_NOTIFY_DEDUPE_MS
      ) {
        epicOfficialRecentUnlockNotificationState.delete(key);
      }
    }
  }
}

function clearEpicOfficialRuntimeState(reason = "manual", meta = {}) {
  const counts = {
    recent: epicOfficialRecentLoadSync.size,
    passive: epicOfficialPassiveLoadSync.size,
    silentSeed: epicOfficialSilentSeedState.size,
    cacheOnlyLog: epicOfficialCacheOnlyLogState.size,
    recentUnlock: epicOfficialRecentUnlockNotificationState.size,
    inflight: epicOfficialLoadSyncInflight.size,
  };
  epicOfficialRecentLoadSync.clear();
  epicOfficialPassiveLoadSync.clear();
  epicOfficialSilentSeedState.clear();
  epicOfficialCacheOnlyLogState.clear();
  epicOfficialRecentUnlockNotificationState.clear();
  epicOfficialLoadSyncInflight.clear();
  epicOfficialLogger.debug?.("epic-official:runtime-state:cleared", {
    reason,
    ...counts,
    ...meta,
  });
}

function getEpicOfficialSilentSeedKey(configName, accountId, productId) {
  return buildEpicOfficialLoadSyncKey(configName, accountId, productId);
}

function getEpicOfficialSilentSeedEntry(configName, accountId, productId) {
  pruneEpicOfficialRuntimeState();
  const key = getEpicOfficialSilentSeedKey(configName, accountId, productId);
  if (!key) return null;
  const entry = epicOfficialSilentSeedState.get(key) || null;
  if (!entry) return null;
  if (
    entry.timestamp &&
    Date.now() - entry.timestamp > EPIC_OFFICIAL_SILENT_SEED_TTL_MS
  ) {
    epicOfficialSilentSeedState.delete(key);
    return null;
  }
  return entry;
}

function clearEpicOfficialSilentSeed(
  configName,
  accountId,
  productId,
  reason = "cleared",
  meta = {},
) {
  const key = getEpicOfficialSilentSeedKey(configName, accountId, productId);
  if (!key) return;
  const existing = epicOfficialSilentSeedState.get(key);
  if (!existing) return;
  epicOfficialSilentSeedState.delete(key);
  epicOfficialLogger.info("epic-official:silent-seed:cleared", {
    configName: sanitizeConfigName(configName || "") || null,
    accountId: normalizeEpicAccountId(accountId) || null,
    productId: String(productId || "").trim() || null,
    expectedUnlocked: Number(existing.expectedUnlocked || 0) || 0,
    reason,
    ...meta,
  });
}

function markEpicOfficialSilentSeed(
  configName,
  accountId,
  productId,
  options = {},
) {
  pruneEpicOfficialRuntimeState();
  const normalizedConfig = sanitizeConfigName(configName || "");
  const normalizedAccountId = normalizeEpicAccountId(accountId) || "";
  const normalizedProductId = String(productId || "").trim();
  const expectedUnlocked = Math.max(
    0,
    Number(options?.expectedUnlocked || 0) || 0,
  );
  if (!normalizedConfig || !normalizedAccountId || !normalizedProductId) return;
  if (expectedUnlocked <= 0) return;
  const key = getEpicOfficialSilentSeedKey(
    normalizedConfig,
    normalizedAccountId,
    normalizedProductId,
  );
  epicOfficialSilentSeedState.set(key, {
    timestamp: Date.now(),
    expectedUnlocked,
    reason: String(options?.reason || "").trim() || "seed",
  });
  epicOfficialLogger.info("epic-official:silent-seed:marked", {
    configName: normalizedConfig,
    accountId: normalizedAccountId,
    productId: normalizedProductId,
    expectedUnlocked,
    reason: String(options?.reason || "").trim() || "seed",
  });
}

function shouldSuppressEpicOfficialUnlocksFromSilentSeed(
  configName,
  accountId,
  productId,
  snapshot = {},
  delta = { unlockedKeys: [] },
) {
  const entry = getEpicOfficialSilentSeedEntry(
    configName,
    accountId,
    productId,
  );
  if (!entry) return false;
  const earnedCount = countEpicOfficialEarnedAchievements(snapshot);
  const expectedUnlocked = Math.max(
    0,
    Number(entry.expectedUnlocked || 0) || 0,
  );
  if (!Array.isArray(delta?.unlockedKeys) || !delta.unlockedKeys.length) {
    if (earnedCount >= expectedUnlocked) {
      clearEpicOfficialSilentSeed(
        configName,
        accountId,
        productId,
        "reconciled-no-delta",
        { earnedCount, expectedUnlocked },
      );
    }
    return false;
  }
  epicOfficialLogger.info("epic-official:silent-seed:suppress", {
    configName: sanitizeConfigName(configName || "") || null,
    accountId: normalizeEpicAccountId(accountId) || null,
    productId: String(productId || "").trim() || null,
    unlockedCount: delta.unlockedKeys.length,
    earnedCount,
    expectedUnlocked,
  });
  if (earnedCount >= expectedUnlocked) {
    clearEpicOfficialSilentSeed(
      configName,
      accountId,
      productId,
      "reconciled-after-suppress",
      { earnedCount, expectedUnlocked },
    );
  }
  return true;
}

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

function normalizeSteamOfficialSteamId(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "auto") return "";
  return /^\d{17,20}$/.test(raw) ? raw : "";
}

function collectSteamOfficialHintPaths() {
  const hints = [];
  try {
    if (!configsDir || !fs.existsSync(configsDir)) return hints;
    const entries = fs.readdirSync(configsDir);
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith(".json")) continue;
      const full = path.join(configsDir, entry);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        if (normalizePlatform(data?.platform) !== "steam-official") continue;
        if (typeof data?.save_path === "string" && data.save_path.trim()) {
          hints.push(data.save_path.trim());
        }
      } catch {}
    }
  } catch {}
  return hints;
}

function getSteamOfficialAccountCatalog(options = {}) {
  const hintPaths = [
    ...collectSteamOfficialHintPaths(),
    ...(Array.isArray(options?.hintPaths) ? options.hintPaths : []),
  ].filter(Boolean);
  return listSteamLoginUsers({ hintPaths });
}

function getPreferredSteamOfficialAccountId(preferences = cachedPreferences) {
  return steamId64ToAccountId(
    normalizeSteamOfficialSteamId(preferences?.steamOfficialSteamId),
  );
}

function pickConfiguredSteamOfficialUserBin(
  statsDir,
  appid,
  preferences = cachedPreferences,
) {
  return pickPreferredUserBin(
    statsDir,
    appid,
    getPreferredSteamOfficialAccountId(preferences),
  );
}

function normalizeAchievementCacheOptions(options) {
  if (!options) return {};
  if (typeof options === "string") {
    return { savePath: String(options || "").trim() };
  }
  return options && typeof options === "object" ? { ...options } : {};
}

function readConfigForAchievementCache(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return null;
  const cfgPath = resolveConfigJsonPath(configsDir, configName);
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveSteamOfficialCacheAccountId(
  configName,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (normalizedPlatform !== "steam-official") return "";
  const resolved = normalizeAchievementCacheOptions(options);
  const explicitAccountId = String(resolved.accountId || "").trim();
  if (explicitAccountId) return explicitAccountId;

  const parsedBin =
    parseUserBinName(resolved.userBinPath || resolved.filePath || "") || null;
  if (parsedBin?.accountId) {
    return String(parsedBin.accountId || "").trim();
  }

  let appid = String(resolved.appid || "").trim();
  let savePath = String(
    resolved.savePath || resolved.statsDir || resolved.save_path || "",
  ).trim();

  const explicitSteamId = normalizeSteamOfficialSteamId(
    resolved.steamOfficialSteamId,
  );
  if (!appid || !savePath || !explicitSteamId) {
    const cfg = readConfigForAchievementCache(configName);
    if (cfg && typeof cfg === "object") {
      if (!appid) appid = String(cfg.appid || "").trim();
      if (!savePath) savePath = String(cfg.save_path || "").trim();
    }
  }

  const preferredSteamId =
    explicitSteamId ||
    normalizeSteamOfficialSteamId(
      resolved?.preferences?.steamOfficialSteamId ||
        cachedPreferences?.steamOfficialSteamId,
    );
  const preferredAccountId = steamId64ToAccountId(preferredSteamId);
  if (preferredAccountId) return preferredAccountId;

  if (savePath && appid) {
    const userBin = pickConfiguredSteamOfficialUserBin(
      savePath,
      appid,
      resolved?.preferences || cachedPreferences,
    );
    const resolvedBin = parseUserBinName(userBin || "");
    if (resolvedBin?.accountId) {
      return String(resolvedBin.accountId || "").trim();
    }
  }

  return "";
}

function resolveEpicOfficialCacheAccountId(
  configName,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (normalizedPlatform !== "epic-official") return "";
  const resolved = normalizeAchievementCacheOptions(options);
  const explicitAccountId = normalizeEpicAccountId(
    resolved.accountId || resolved.epicAccountId || resolved.epic_account_id,
  );
  if (explicitAccountId) return explicitAccountId;
  const cfg = readConfigForAchievementCache(configName);
  return (
    normalizeEpicAccountId(cachedPreferences?.epicOfficialAccountId) ||
    normalizeEpicAccountId(cfg?.epic_account_id)
  );
}

function resolvePreferredEpicOfficialAccountId(
  config = {},
  token = null,
  options = null,
) {
  const explicitAccountId = normalizeEpicAccountId(
    options?.accountId || options?.epicAccountId || options?.epic_account_id,
  );
  if (explicitAccountId) return explicitAccountId;
  return (
    normalizeEpicAccountId(cachedPreferences?.epicOfficialAccountId) ||
    normalizeEpicAccountId(token?.account_id) ||
    normalizeEpicAccountId(config?.epic_account_id)
  );
}

function resolveScopedAchievementCacheAccountId(
  configName,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (normalizedPlatform === "steam-official") {
    return resolveSteamOfficialCacheAccountId(
      configName,
      normalizedPlatform,
      options,
    );
  }
  if (normalizedPlatform === "epic-official") {
    return resolveEpicOfficialCacheAccountId(
      configName,
      normalizedPlatform,
      options,
    );
  }
  return "";
}

function resolveShadPs4AchievementCacheUserId(
  configName,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (normalizedPlatform !== "shadps4") return "";
  const resolved = normalizeAchievementCacheOptions(options);
  const explicitUserId = String(
    resolved.shadps4UserId ||
      resolved.shadps4_user_id ||
      resolved.userId ||
      resolved.user_id ||
      "",
  ).trim();
  if (explicitUserId)
    return sanitizeConfigName(explicitUserId) || explicitUserId;

  const candidatePaths = [
    resolved.progressPath,
    resolved.progress_path,
    resolved.filePath,
    resolved.savePath,
    resolved.save_path,
  ];
  for (const candidate of candidatePaths) {
    const userId = getPs4UserIdFromProgressPath(candidate);
    if (userId) return sanitizeConfigName(userId) || userId;
  }

  const cfg = readConfigForAchievementCache(configName);
  const configuredUserId = String(cfg?.shadps4_user_id || "").trim();
  if (configuredUserId) {
    return sanitizeConfigName(configuredUserId) || configuredUserId;
  }
  const progressPath = cfg ? resolvePs4ProgressPathForConfig(cfg) : "";
  const resolvedUserId = getPs4UserIdFromProgressPath(progressPath);
  return resolvedUserId
    ? sanitizeConfigName(resolvedUserId) || resolvedUserId
    : "";
}

const DEFAULT_PREFERENCES = {
  startInTray: false,
  screenshotFolder: getDefaultScreenshotFolder(),
  appTheme: "dracula",
  overlayShortcut: "",
  overlayInteractShortcut: "\\",
  sound: "mute",
  soundVolume: 100,
  preset: "default",
  notificationScale: 1,
  playtimeNotificationScale: 1,
  notificationDuration: 0,
  position: "center-bottom",
  language: "english",
  uiLanguage: "english",
  achievementLanguageManual: false,
  disableProgress: false,
  progressMutedConfigs: [],
  windowZoomFactor: 1,
  disableAchievementScreenshot: false,
  notificationClickRedirectEnabled: false,
  notificationClickRedirectTarget: "overlay",
  showDashboardOnStart: false,
  startMaximized: false,
  disableHardwareAcceleration: true,
  disableUpdate: false,
  disablePlaytime: false,
  showNotificationRarityPercentage: true,
  progressPosition: "bottom-left",
  useSanPreset: false,
  sanPreset: "",
  rareSanPreset: "",
  platinumSanPreset: "",
  xeniaSanPreset: "",
  rpcs3SanPreset: "",
  shadps4SanPreset: "",
  rareSound: "mute",
  rarePreset: "default",
  rarePosition: "center-bottom",
  xeniaSound: "mute",
  xeniaPreset: "default",
  xeniaPosition: "center-bottom",
  rpcs3Sound: "mute",
  rpcs3Preset: "default",
  rpcs3Position: "center-bottom",
  shadps4Sound: "mute",
  shadps4Preset: "default",
  shadps4Position: "center-bottom",
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
  overlayControllerSupportEnabled: false,
  overlayControllerBackend: "auto",
  overlayControllerDebugLogging: false,
  overlayControllerToggleBinding: [
    ...DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
  ],
  overlayControllerControlModeBinding: [
    ...DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
  ],
  ignoreLeadingArticlesSort: true,
  hideZeroCompletionGames: false,
  schemaLanguages: [...SCHEMA_LANGUAGE_VALUES],
  steamApiKey: "",
  steamOfficialSteamId: "",
  epicOfficialAccountId: "",
};

try {
  ensureUserThemes();
} catch (err) {
  console.warn("themes:ensure-failed", err?.message || err);
}

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
  let englishData = {};
  let localizedData = {};
  const englishPath = path.join(UI_LOCALE_DIR, "english.json");
  const filePath = path.join(UI_LOCALE_DIR, `${normalized}.json`);
  try {
    englishData = JSON.parse(fs.readFileSync(englishPath, "utf8"));
  } catch {}
  if (normalized === "english") {
    localizedData = englishData;
  } else {
    try {
      localizedData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {}
  }
  const data =
    normalized === "english"
      ? englishData
      : { ...(englishData || {}), ...(localizedData || {}) };
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

function isNotificationClickRedirectEnabled(
  preferences = cachedPreferences,
) {
  return preferences?.notificationClickRedirectEnabled === true;
}

function getNotificationClickRedirectTarget(
  preferences = cachedPreferences,
) {
  return normalizeNotificationNavigationTarget(
    preferences?.notificationClickRedirectTarget,
    DEFAULT_PREFERENCES.notificationClickRedirectTarget,
  );
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
    const primaryRead = readJsonWithBackupSync(preferencesPath, {
      backup: false,
      fallback: null,
    });
    const primaryIsValid = primaryRead.source === "primary";
    if (!exists || !primaryIsValid || !deepEqual(current, merged)) {
      fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
      writeJsonAtomicSync(preferencesPath, merged, { backup: true });
    }
    return merged;
  } catch (err) {
    prefsLogger.warn("preferences:ensure-failed", { error: err.message });
    return readPrefsSafe();
  }
}

const BLACKLIST_PREF_KEY = "blacklistedAppIds";
const BLACKLIST_CONFIG_PREF_KEY = "blacklistedConfigKeys";
const blacklistedAppIdsSet = new Set();
const blacklistedConfigKeysSet = new Set();
let watchedFoldersApi = null;
let cachedPreferences = {};
let mainWindow;
let selectedConfigPath = null;
let selectedConfig = null;
let selectedPlatform = null;
let selectedConfigMode = "none";
let activeConfigUpdateGeneration = 0;
let overlayControllerService = null;
let overlayControllerRuntimeStateCache = {
  supportEnabled: false,
  toggleBinding: [...DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING],
  controlModeBinding: [...DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING],
  controlModeActive: false,
  controlModeUserIndex: null,
};
let mainWindowUserZoom = 1;
let mainWindowZoomTimer = null;
let displayMetricsListenerAdded = false;
const ZOOM_LOG_EPS = 0.001;
let lastZoomLog = null;
const STARTUP_APP_UPDATE_CHECK_DELAY_MS = 4000;
let appUpdateCheckStarted = false;
let appUpdatePromptActive = false;
let appUpdateDownloadRequested = false;
let appUpdateDownloadInFlight = false;
let appUpdateKnownVersion = "";
let appUpdateProgressJob = null;
let appUpdateCheckTimer = null;
let appUpdateCheckRequested = false;
let appUpdateCheckContext = null;
const APP_UPDATE_INSTALL_COMPLETE_ARG = "--updated";
const APP_UPDATE_PENDING_INFO_FILE = "update-info.json";
const APP_UPDATE_PENDING_BLOCKMAP_FILE = "current.blockmap";
const APP_UPDATE_NO_PUBLISHED_GITHUB_RE = /No published versions on GitHub/i;
let selectedSound = "mute";
let selectedPreset = "default";
let selectedPosition = "center-bottom";
let selectedNotificationScale = 1;
let bootSeeding = true;
let bootOnboardingRecoveryTimer = null;
let bootOnboardingRecoveryLastAt = 0;
let appNavigationRendererReady = false;
let pendingAppNavigationRoute = null;
let appNavigationRequestSequence = 0;
const recentAppNavigationKeys = new Map();
let pendingOverlayNotificationNavigation = null;
let overlayNavigationRendererReadyWebContentsId = null;
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
  app.on("second-instance", (_event, argv) => {
    handleAppNavigationArgv(argv, "second-instance", { showWindow: true });
  });
}
handleAppNavigationArgv(process.argv, "initial-launch", { showWindow: false });

function setBlacklistedAppIds(list) {
  blacklistedAppIdsSet.clear();
  const arr = Array.isArray(list) ? list : [];
  for (const id of arr) {
    const normalized = normalizeAppIdValue(id);
    if (normalized) blacklistedAppIdsSet.add(normalized);
  }
}

function setBlacklistedConfigKeys(list) {
  blacklistedConfigKeysSet.clear();
  const arr = Array.isArray(list) ? list : [];
  for (const entry of arr) {
    const normalized = normalizeBlacklistConfigKey(entry);
    if (normalized) blacklistedConfigKeysSet.add(normalized);
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
  return Array.from(
    new Set(arr.map(normalizeAppIdValue).filter(Boolean)),
  );
}

function readBlacklistedConfigKeysFromPrefs() {
  const prefs = readPrefsSafe();
  const arr = Array.isArray(prefs[BLACKLIST_CONFIG_PREF_KEY])
    ? prefs[BLACKLIST_CONFIG_PREF_KEY]
    : [];
  return Array.from(
    new Set(arr.map(normalizeBlacklistConfigKey).filter(Boolean)),
  );
}

function buildBlacklistPayload({
  appIds = readBlacklistFromPrefs(),
  configKeys = readBlacklistedConfigKeysFromPrefs(),
} = {}) {
  const entries = [
    ...appIds.map((appid) => ({
      key: `appid:${appid}`,
      appid,
      platform: null,
      scope: "global",
      legacy: true,
    })),
    ...configKeys.map((configKey) => {
      const [appid, platform] = String(configKey).split("::");
      return {
        key: configKey,
        appid,
        platform: platform || null,
        scope: "platform",
        legacy: false,
      };
    }),
  ];
  return {
    appids: Array.from(new Set(appIds)),
    configKeys: Array.from(new Set(configKeys)),
    entries,
  };
}

function persistBlacklist({ appIds = [], configKeys = [] } = {}) {
  const nextAppIds = Array.from(
    new Set((appIds || []).map(normalizeAppIdValue).filter(Boolean)),
  );
  const nextConfigKeys = Array.from(
    new Set(
      (configKeys || []).map(normalizeBlacklistConfigKey).filter(Boolean),
    ),
  );
  try {
    const prefs = updatePreferences({
      [BLACKLIST_PREF_KEY]: nextAppIds,
      [BLACKLIST_CONFIG_PREF_KEY]: nextConfigKeys,
    });
    return buildBlacklistPayload({
      appIds: Array.isArray(prefs?.[BLACKLIST_PREF_KEY])
        ? prefs[BLACKLIST_PREF_KEY]
        : nextAppIds,
      configKeys: Array.isArray(prefs?.[BLACKLIST_CONFIG_PREF_KEY])
        ? prefs[BLACKLIST_CONFIG_PREF_KEY]
        : nextConfigKeys,
    });
  } catch (err) {
    prefsLogger.error("blacklist:write-failed", { error: err.message });
    throw err;
  }
}

function addAppIdToBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return buildBlacklistPayload();
  const next = new Set(readBlacklistFromPrefs());
  next.add(normalized);
  return persistBlacklist({
    appIds: Array.from(next),
    configKeys: readBlacklistedConfigKeysFromPrefs(),
  });
}

function removeAppIdFromBlacklist(appid) {
  const normalized = normalizeAppIdValue(appid);
  if (!normalized) return buildBlacklistPayload();
  const next = new Set(readBlacklistFromPrefs());
  next.delete(normalized);
  return persistBlacklist({
    appIds: Array.from(next),
    configKeys: readBlacklistedConfigKeysFromPrefs(),
  });
}

function addConfigKeyToBlacklist(appid, platform) {
  const normalized = buildBlacklistConfigKey(appid, platform);
  if (!normalized) return buildBlacklistPayload();
  const next = new Set(readBlacklistedConfigKeysFromPrefs());
  next.add(normalized);
  return persistBlacklist({
    appIds: readBlacklistFromPrefs(),
    configKeys: Array.from(next),
  });
}

function removeConfigKeyFromBlacklist(appid, platform) {
  const normalized = buildBlacklistConfigKey(appid, platform);
  if (!normalized) return buildBlacklistPayload();
  const next = new Set(readBlacklistedConfigKeysFromPrefs());
  next.delete(normalized);
  return persistBlacklist({
    appIds: readBlacklistFromPrefs(),
    configKeys: Array.from(next),
  });
}

function resetBlacklist() {
  return persistBlacklist({ appIds: [], configKeys: [] });
}

function getBlacklistMatch(appid, platform = null) {
  const normalizedAppId = normalizeAppIdValue(appid);
  const rawPlatform = String(platform || "").trim();
  const configKey =
    normalizedAppId && rawPlatform
      ? buildBlacklistConfigKey(normalizedAppId, rawPlatform)
      : "";
  const globalMatch =
    !!normalizedAppId && blacklistedAppIdsSet.has(normalizedAppId);
  const platformMatch =
    !!configKey && blacklistedConfigKeysSet.has(configKey);
  return {
    appid: normalizedAppId || null,
    platform: rawPlatform
      ? normalizeBlacklistPlatformValue(rawPlatform)
      : null,
    configKey: configKey || null,
    global: globalMatch,
    scoped: platformMatch,
    effective: globalMatch || platformMatch,
  };
}

function isAppIdBlacklisted(appid, platform = null) {
  return getBlacklistMatch(appid, platform).effective;
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
    [
      "uplay",
      "ubisoft-official",
      "ea-official",
      "steam",
      "epic",
      "epic-official",
      "gog",
      "gog-official",
      "xbox-pc",
    ].forEach((plat) =>
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
    const isOnlineFixStatsDir = path.basename(d).toLowerCase() === "stats";
    const ofx = isOnlineFixStatsDir
      ? path.join(d, "achievements.ini")
      : path.join(d, "Stats", "achievements.ini");
    const ofxStats = isOnlineFixStatsDir
      ? path.join(d, "stats.ini")
      : path.join(d, "Stats", "stats.ini");
    const bin = path.join(d, "stats.bin");
    if (fs.existsSync(tenokeIni))
      return {
        dir: d,
        ini: null,
        tenokeIni,
        ofx: null,
        ofxStats: null,
        bin: fs.existsSync(bin) ? bin : null,
      };
    if (fs.existsSync(ofx))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx,
        ofxStats: fs.existsSync(ofxStats) ? ofxStats : null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(ofxStats))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx: null,
        ofxStats,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(universeIniPath))
      return {
        dir: d,
        ini: universeIniPath,
        tenokeIni: null,
        ofx: null,
        ofxStats: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(iniPath))
      return {
        dir: d,
        ini: iniPath,
        tenokeIni: null,
        ofx: null,
        ofxStats: null,
        bin: fs.existsSync(bin) ? bin : null,
      };

    if (fs.existsSync(bin))
      return {
        dir: d,
        ini: null,
        tenokeIni: null,
        ofx: null,
        ofxStats: null,
        bin,
      };
  }
  return {
    dir: path.join(saveBase, String(appid)),
    ini: null,
    tenokeIni: null,
    ofx: null,
    ofxStats: null,
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

function isPs4ProgressXmlPath(filePath) {
  const base = path.basename(String(filePath || ""));
  if (!/^NP[A-Z0-9_]+\.xml$/i.test(base)) return false;
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

function collectPs4ProgressFilesForConfig(root, npcommid, preferredUser = "") {
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
      path.join(homeDir, preferredUser, "trophy", `${normalizedNpCommId}.xml`),
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

function selectPs4ProgressFileForConfig(
  root,
  npcommid,
  preferredUser = "",
  direct = "",
) {
  const candidates = collectPs4ProgressFilesForConfig(
    root,
    npcommid,
    preferredUser,
  );
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

function resolvePs4TrophyDirForConfig(config) {
  if (!config) return "";
  const npcommid = String(config.shadps4_npcommid || "").trim();
  if (npcommid) {
    const modernRoot = resolveShadPs4RootForConfig(config);
    const modernSchema = modernRoot
      ? path.join(modernRoot, "trophy", npcommid)
      : "";
    if (modernSchema && fs.existsSync(modernSchema)) return modernSchema;
  }
  const schemaPath =
    typeof config.shadps4_schema_path === "string" && config.shadps4_schema_path
      ? config.shadps4_schema_path
      : "";
  if (schemaPath && fs.existsSync(schemaPath)) return schemaPath;
  const trophyPath =
    typeof config.trophy_path === "string" && config.trophy_path
      ? config.trophy_path
      : "";
  if (trophyPath && fs.existsSync(trophyPath)) return trophyPath;
  const savePath = typeof config.save_path === "string" ? config.save_path : "";
  if (savePath) {
    try {
      const stat = fs.statSync(savePath);
      if (stat.isDirectory()) return savePath;
    } catch {}
  }
  return schemaPath || trophyPath || "";
}

function resolveShadPs4RootForConfig(config) {
  const candidates = [
    config?.shadps4_schema_path,
    config?.trophy_path,
    config?.shadps4_progress_path,
    config?.save_path,
    config?.config_path,
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

function resolvePs4ProgressPathForConfig(config) {
  if (!config) return "";
  const direct =
    typeof config.shadps4_progress_path === "string" &&
    config.shadps4_progress_path
      ? config.shadps4_progress_path
      : typeof config.save_path === "string" && config.save_path
        ? config.save_path
        : "";
  const npcommid = String(config.shadps4_npcommid || "").trim();
  const trophyDir = resolvePs4TrophyDirForConfig(config);
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
    resolveShadPs4RootForConfig(config) ||
    (trophyDir ? path.dirname(path.dirname(trophyDir)) : "");
  if (!root) {
    if (direct) {
      try {
        const stat = fs.statSync(direct);
        if (stat.isFile()) return direct;
      } catch {}
    }
    return "";
  }
  const preferredUser = String(config.shadps4_user_id || "").trim();
  const selected = selectPs4ProgressFileForConfig(
    root,
    npcommid,
    preferredUser,
    direct,
  );
  return selected?.progressPath || "";
}

const ACHGEN_BUFFER_MAX = 300;
const achgenBuffer = [];
const generationProgressJobs = new Map();
let generationProgressSequence = 0;

function clampGenerationPercent(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

function normalizeGenerationProgressState(payload = {}, fallback = {}) {
  const current =
    Number.isFinite(Number(payload.current)) && Number(payload.current) >= 0
      ? Number(payload.current)
      : Number.isFinite(Number(fallback.current)) &&
          Number(fallback.current) >= 0
        ? Number(fallback.current)
        : 0;
  const total =
    Number.isFinite(Number(payload.total)) && Number(payload.total) >= 0
      ? Number(payload.total)
      : Number.isFinite(Number(fallback.total)) && Number(fallback.total) >= 0
        ? Number(fallback.total)
        : 0;
  return {
    id: String(payload.id || fallback.id || ""),
    kind: String(payload.kind || fallback.kind || "config-generate"),
    scope: String(payload.scope || fallback.scope || "single"),
    status: String(payload.status || fallback.status || "running"),
    title: String(payload.title || fallback.title || ""),
    itemName: String(payload.itemName || fallback.itemName || ""),
    appid: String(payload.appid || fallback.appid || ""),
    phase: String(payload.phase || fallback.phase || ""),
    detail: String(payload.detail || fallback.detail || ""),
    current,
    total,
    percent: clampGenerationPercent(
      payload.percent,
      clampGenerationPercent(fallback.percent, 0),
    ),
  };
}

function broadcastGenerationProgress(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    } catch {}
  }
}

function hasActiveGenerationProgress() {
  return generationProgressJobs.size > 0;
}

function getLatestActiveGenerationProgress() {
  const values = Array.from(generationProgressJobs.values());
  return values.length ? values[values.length - 1] : null;
}

function createGenerationProgressJob(seed = {}) {
  const id =
    seed.id || `generation-${Date.now()}-${++generationProgressSequence}`;
  const initial = normalizeGenerationProgressState(
    { ...seed, id, status: "running" },
    { id },
  );
  generationProgressJobs.set(id, initial);
  broadcastGenerationProgress("generation:progress:start", initial);
  return {
    id,
    update(patch = {}) {
      const current = generationProgressJobs.get(id);
      if (!current) return null;
      const next = normalizeGenerationProgressState(
        {
          ...current,
          ...patch,
          id,
          status:
            patch.status === "success" || patch.status === "failed"
              ? patch.status
              : "running",
        },
        current,
      );
      generationProgressJobs.set(id, next);
      broadcastGenerationProgress("generation:progress:update", next);
      return next;
    },
    succeed(patch = {}) {
      const current =
        generationProgressJobs.get(id) ||
        normalizeGenerationProgressState({ ...seed, id }, { id });
      const next = normalizeGenerationProgressState(
        {
          ...current,
          ...patch,
          id,
          status: "success",
          percent:
            patch.percent === undefined
              ? 100
              : clampGenerationPercent(patch.percent, 100),
        },
        current,
      );
      generationProgressJobs.delete(id);
      broadcastGenerationProgress("generation:progress:end", next);
      return next;
    },
    fail(patch = {}) {
      const current =
        generationProgressJobs.get(id) ||
        normalizeGenerationProgressState({ ...seed, id }, { id });
      const fallbackPercent =
        current.percent > 0
          ? current.percent
          : clampGenerationPercent(seed.percent, 0);
      const next = normalizeGenerationProgressState(
        {
          ...current,
          ...patch,
          id,
          status: "failed",
          percent:
            patch.percent === undefined
              ? fallbackPercent
              : clampGenerationPercent(patch.percent, fallbackPercent),
        },
        current,
      );
      generationProgressJobs.delete(id);
      broadcastGenerationProgress("generation:progress:end", next);
      return next;
    },
  };
}

const BOOT_CACHE_PROGRESS_ID = "boot-cache";
let bootCacheProgressLastEmitAt = 0;

function broadcastBootCacheProgress(channel, patch = {}) {
  const status =
    patch.status ||
    (channel === "generation:progress:end" ? "success" : "running");
  const payload = normalizeGenerationProgressState(
    {
      id: BOOT_CACHE_PROGRESS_ID,
      kind: "boot-background",
      scope: "boot",
      phase: "loadingCache",
      itemName: "Achievement cache",
      status,
      ...patch,
    },
    {
      id: BOOT_CACHE_PROGRESS_ID,
      kind: "boot-background",
      scope: "boot",
      phase: "loadingCache",
      itemName: "Achievement cache",
      status,
    },
  );
  broadcastGenerationProgress(channel, payload);
}

function updateBootCacheProgress(patch = {}, options = {}) {
  const now = Date.now();
  const force = options.force === true;
  if (!force && now - bootCacheProgressLastEmitAt < 700) return;
  bootCacheProgressLastEmitAt = now;
  broadcastBootCacheProgress("generation:progress:update", patch);
}

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
    const suppressNotify = hasActiveGenerationProgress();
    if (!suppressNotify) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed())
            win.webContents.send("notify", {
              message: msg,
              color,
              rawMessage: rawMsg,
            });
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

function isPrereleaseAppVersion(version = app.getVersion()) {
  return typeof version === "string" && /-[0-9A-Za-z]/.test(version);
}

function isNoPublishedGitHubUpdateError(err) {
  const message = String(err?.message || err || "").trim();
  return APP_UPDATE_NO_PUBLISHED_GITHUB_RE.test(message);
}

function shouldFallbackPrereleaseUpdateCheckToStable(err, options = {}) {
  if (options?.allowPrerelease !== true) return false;
  return isNoPublishedGitHubUpdateError(err);
}

async function checkForAppUpdatesWithStableFallback(trigger = "startup") {
  const originalAllowPrerelease = autoUpdater.allowPrerelease === true;
  appUpdateCheckContext = {
    trigger,
    allowPrerelease: originalAllowPrerelease,
    phase: originalAllowPrerelease ? "primary-prerelease" : "primary-stable",
  };
  try {
    return await autoUpdater.checkForUpdates();
  } catch (err) {
    if (
      !shouldFallbackPrereleaseUpdateCheckToStable(err, {
        allowPrerelease: originalAllowPrerelease,
      })
    ) {
      throw err;
    }
    updateLogger.warn("app-update:stable-fallback", {
      trigger,
      fromPrerelease: true,
      reason: err?.message || String(err),
    });
    autoUpdater.allowPrerelease = false;
    appUpdateCheckContext = {
      trigger,
      allowPrerelease: false,
      phase: "stable-fallback",
    };
    try {
      return await autoUpdater.checkForUpdates();
    } finally {
      autoUpdater.allowPrerelease = originalAllowPrerelease;
    }
  } finally {
    appUpdateCheckContext = null;
  }
}

function getUpdateDialogParentWindow() {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible?.() === true
  ) {
    return mainWindow;
  }
  return null;
}

function shouldDisableAppUpdateChecks(prefs = cachedPreferences) {
  return prefs?.disableUpdate === true;
}

function clearScheduledStartupAppUpdateCheck() {
  if (!appUpdateCheckTimer) return;
  clearTimeout(appUpdateCheckTimer);
  appUpdateCheckTimer = null;
}

function scheduleStartupAppUpdateCheck(prefs = cachedPreferences) {
  if (!appUpdateCheckStarted) return;
  if (!app.isPackaged) return;
  const appUpdateConfigPath = getAppUpdateConfigPath();
  if (!fs.existsSync(appUpdateConfigPath)) return;
  if (shouldDisableAppUpdateChecks(prefs)) {
    clearScheduledStartupAppUpdateCheck();
    return;
  }
  if (appUpdateCheckRequested || appUpdateCheckTimer) return;
  appUpdateCheckTimer = setTimeout(() => {
    appUpdateCheckTimer = null;
    if (shouldDisableAppUpdateChecks(cachedPreferences)) {
      updateLogger.info("app-update:skip", {
        reason: "disabled-by-preference",
      });
      return;
    }
    appUpdateCheckRequested = true;
    checkForAppUpdatesWithStableFallback("startup").catch((err) => {
      updateLogger.error("app-update:check-failed", {
        error: err?.message || String(err),
      });
    });
  }, STARTUP_APP_UPDATE_CHECK_DELAY_MS);
}

function ensureMainWindowVisibleForUpdatePrompt() {
  showMainWindowRespectingPrefs();
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    if (mainWindow.isMinimized?.()) {
      mainWindow.restore();
    }
  } catch {}
  try {
    if (!mainWindow.isVisible?.()) {
      mainWindow.show();
    }
  } catch {}
  try {
    mainWindow.focus();
  } catch {}
  return mainWindow;
}

function getAppUpdateConfigPath() {
  return path.join(process.resourcesPath, "app-update.yml");
}

function stripSurroundingQuotes(value) {
  const normalized = String(value || "").trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function getAppUpdateCacheDirName() {
  if (!app.isPackaged) return "";
  const configPath = getAppUpdateConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return "";
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const match = raw.match(/^\s*updaterCacheDirName\s*:\s*(.+?)\s*$/m);
    return stripSurroundingQuotes(match?.[1] || "");
  } catch (err) {
    updateLogger.warn("app-update:cache-prune-failed", {
      trigger: "resolve-cache-dir-name",
      error: err?.message || String(err),
    });
    return "";
  }
}

function getAppUpdatePendingDir() {
  const cacheDirName = getAppUpdateCacheDirName();
  if (!cacheDirName) return "";
  const baseCacheDir =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(baseCacheDir, cacheDirName, "pending");
}

function extractAppUpdateVersionFromFileName(fileName) {
  const normalized = path.basename(String(fileName || "").trim());
  if (!normalized) return "";
  const setupMatch = normalized.match(/-Setup-(.+)\.exe$/i);
  if (setupMatch?.[1]) {
    return stripSurroundingQuotes(setupMatch[1]);
  }
  const genericMatch = normalized.match(
    /([0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z.-]+)?)\.exe$/i,
  );
  return genericMatch?.[1] ? stripSurroundingQuotes(genericMatch[1]) : "";
}

function parseLooseAppVersion(version) {
  const normalized = String(version || "").trim();
  const match = normalized.match(/^(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    raw: normalized,
    core: match[1].split(".").map((part) => Number(part) || 0),
    suffix: String(match[2] || "")
      .trim()
      .toLowerCase(),
  };
}

function classifyLooseAppVersionSuffix(suffix) {
  const normalized = String(suffix || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return { recognized: true, rank: 0, value: "" };
  }
  if (/^(?:alpha|a|pre|preview)(?:[.-]?\d+)?$/.test(normalized)) {
    return { recognized: true, rank: -30, value: normalized };
  }
  if (/^(?:beta|b)(?:[.-]?\d+)?$/.test(normalized)) {
    return { recognized: true, rank: -20, value: normalized };
  }
  if (/^rc(?:[.-]?\d+)?$/.test(normalized)) {
    return { recognized: true, rank: -10, value: normalized };
  }
  if (/^(?:hf|hotfix|patch)(?:[.-]?\d+)?$/.test(normalized)) {
    return { recognized: true, rank: 10, value: normalized };
  }
  return { recognized: false, rank: 0, value: normalized };
}

function compareLooseAppVersions(leftVersion, rightVersion) {
  const left = parseLooseAppVersion(leftVersion);
  const right = parseLooseAppVersion(rightVersion);
  if (!left || !right) return null;
  const maxLength = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < maxLength; i += 1) {
    const leftPart = left.core[i] || 0;
    const rightPart = right.core[i] || 0;
    if (leftPart === rightPart) continue;
    return leftPart > rightPart ? 1 : -1;
  }
  if (left.raw.toLowerCase() === right.raw.toLowerCase()) {
    return 0;
  }
  const leftSuffix = classifyLooseAppVersionSuffix(left.suffix);
  const rightSuffix = classifyLooseAppVersionSuffix(right.suffix);
  if (!(leftSuffix.recognized && rightSuffix.recognized)) {
    return null;
  }
  if (leftSuffix.rank !== rightSuffix.rank) {
    return leftSuffix.rank > rightSuffix.rank ? 1 : -1;
  }
  if (leftSuffix.value === rightSuffix.value) {
    return 0;
  }
  const suffixCompare = leftSuffix.value.localeCompare(
    rightSuffix.value,
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
  if (suffixCompare === 0) return 0;
  return suffixCompare > 0 ? 1 : -1;
}

function wasAppUpdatedOnCurrentLaunch(argv = process.argv) {
  return Array.isArray(argv)
    ? argv.some(
        (arg) =>
          String(arg || "")
            .trim()
            .toLowerCase() === APP_UPDATE_INSTALL_COMPLETE_ARG,
      )
    : false;
}

async function clearAppUpdatePendingDir(pendingDir, meta = {}) {
  await fs.promises.rm(pendingDir, { recursive: true, force: true });
  await fs.promises.mkdir(pendingDir, { recursive: true });
  updateLogger.info("app-update:cache-pruned", {
    scope: "pending",
    ...meta,
  });
}

async function pruneAppUpdatePendingCache(options = {}) {
  if (!app.isPackaged) return;
  const trigger = String(options?.trigger || "startup").trim() || "startup";
  const pendingDir = getAppUpdatePendingDir();
  if (!pendingDir || !fs.existsSync(pendingDir)) return;
  try {
    const entries = await fs.promises.readdir(pendingDir, {
      withFileTypes: true,
    });
    if (!entries.length) return;

    if (wasAppUpdatedOnCurrentLaunch()) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "post-install",
        entryCount: entries.length,
      });
      return;
    }

    const updateInfoPath = path.join(pendingDir, APP_UPDATE_PENDING_INFO_FILE);
    if (!fs.existsSync(updateInfoPath)) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "missing-update-info",
        entryCount: entries.length,
      });
      return;
    }

    let pendingInfo = null;
    try {
      pendingInfo = JSON.parse(
        await fs.promises.readFile(updateInfoPath, "utf8"),
      );
    } catch (err) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "invalid-update-info",
        error: err?.message || String(err),
      });
      return;
    }

    const pendingFileName = path.basename(
      String(pendingInfo?.fileName || "").trim(),
    );
    if (!pendingFileName) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "missing-file-name",
      });
      return;
    }

    const pendingFilePath = path.join(pendingDir, pendingFileName);
    if (!fs.existsSync(pendingFilePath)) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "missing-update-file",
        fileName: pendingFileName,
      });
      return;
    }

    const currentVersion = String(app.getVersion() || "").trim();
    const pendingVersion = extractAppUpdateVersionFromFileName(pendingFileName);
    const versionCompare = compareLooseAppVersions(
      currentVersion,
      pendingVersion,
    );
    if (versionCompare !== null && versionCompare >= 0) {
      await clearAppUpdatePendingDir(pendingDir, {
        trigger,
        cleanup: "stale-or-installed",
        currentVersion,
        pendingVersion: pendingVersion || null,
      });
      return;
    }

    const keepNames = new Set([
      APP_UPDATE_PENDING_INFO_FILE,
      APP_UPDATE_PENDING_BLOCKMAP_FILE,
      pendingFileName,
    ]);
    const removed = [];
    for (const entry of entries) {
      if (keepNames.has(entry.name)) continue;
      const targetPath = path.join(pendingDir, entry.name);
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      removed.push(entry.name);
    }
    if (removed.length) {
      updateLogger.info("app-update:cache-pruned", {
        scope: "pending",
        trigger,
        cleanup: "removed-extra-files",
        keptFile: pendingFileName,
        removed,
      });
    }
  } catch (err) {
    updateLogger.warn("app-update:cache-prune-failed", {
      trigger,
      error: err?.message || String(err),
    });
  }
}

function getUpdateVersionLabel(info = null) {
  const version = String(info?.version || "").trim();
  return version || "new";
}

function normalizeUpdateReleaseName(info = null) {
  const releaseName = String(info?.releaseName || "").trim();
  return releaseName || "";
}

function normalizeUpdateReleaseNotes(info = null) {
  const rawNotes = info?.releaseNotes;
  if (typeof rawNotes === "string") {
    return rawNotes.trim();
  }
  if (Array.isArray(rawNotes)) {
    return rawNotes
      .map((entry) => {
        const version = String(entry?.version || "").trim();
        const note = String(entry?.note || "").trim();
        if (!note) return "";
        return version ? `${version}\n${note}` : note;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function formatAppUpdateBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = bytes;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const precision =
    current >= 100 || unitIndex === 0 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(precision)} ${units[unitIndex]}`;
}

function formatAppUpdateSpeed(bytesPerSecond) {
  const text = formatAppUpdateBytes(bytesPerSecond);
  return text ? `${text}/s` : "";
}

function getAppUpdateProgressTitle() {
  return tUi("main.update.progress.title", {}, "Downloading Update");
}

function getAppUpdateProgressVersionLabel(version = appUpdateKnownVersion) {
  const normalized = String(version || "").trim();
  if (!normalized || normalized === "new") return "";
  return normalized;
}

function getAppUpdatePreparingDetail() {
  return tUi("main.update.progress.preparing", {}, "Preparing download");
}

function getAppUpdateDownloadedDetail() {
  return tUi("main.update.progress.completed", {}, "Update downloaded");
}

function getAppUpdateFailedDetail(errorMessage = "") {
  const normalized = String(errorMessage || "").trim();
  if (!normalized) {
    return tUi("main.update.progress.failed", {}, "Update download failed");
  }
  return tUi(
    "main.update.progress.failedWithError",
    { error: normalized },
    `Update download failed: ${normalized}`,
  );
}

function buildAppUpdateProgressDetail(progress = {}) {
  const transferred = formatAppUpdateBytes(progress?.transferred);
  const total = formatAppUpdateBytes(progress?.total);
  const speed = formatAppUpdateSpeed(progress?.bytesPerSecond);
  if (transferred && total && speed) {
    return `${transferred} / ${total} (${speed})`;
  }
  if (transferred && total) {
    return `${transferred} / ${total}`;
  }
  if (speed) {
    return speed;
  }
  return tUi("main.update.progress.downloading", {}, "Downloading update...");
}

function ensureAppUpdateProgressJob(options = {}) {
  const versionLabel = getAppUpdateProgressVersionLabel(options.version);
  if (appUpdateProgressJob) return appUpdateProgressJob;
  appUpdateProgressJob = createGenerationProgressJob({
    kind: "app-update",
    scope: "single",
    status: "running",
    title: getAppUpdateProgressTitle(),
    itemName: versionLabel,
    phase: options.phase || "preparing",
    detail: options.detail || getAppUpdatePreparingDetail(),
    current: 0,
    total: 0,
    percent: clampGenerationPercent(options.percent, 0),
  });
  return appUpdateProgressJob;
}

function updateAppUpdateProgress(progress = {}, options = {}) {
  const job = ensureAppUpdateProgressJob({
    version: options.version,
    phase: "downloading",
    detail: buildAppUpdateProgressDetail(progress),
    percent: Number(progress?.percent || 0),
  });
  job?.update?.({
    kind: "app-update",
    scope: "single",
    title: getAppUpdateProgressTitle(),
    itemName: getAppUpdateProgressVersionLabel(options.version),
    phase: "downloading",
    detail: buildAppUpdateProgressDetail(progress),
    current: 0,
    total: 0,
    percent: clampGenerationPercent(progress?.percent, 0),
  });
}

function finishAppUpdateProgress(status, options = {}) {
  if (!appUpdateProgressJob) return;
  const versionLabel = getAppUpdateProgressVersionLabel(options.version);
  const patch = {
    kind: "app-update",
    scope: "single",
    title: getAppUpdateProgressTitle(),
    itemName: versionLabel,
    phase: status === "success" ? "completed" : "failed",
    detail:
      status === "success"
        ? options.detail || getAppUpdateDownloadedDetail()
        : options.detail || getAppUpdateFailedDetail(options.error),
    current: 0,
    total: 0,
  };
  if (status === "success") {
    patch.percent = 100;
  } else if (options.percent !== undefined) {
    patch.percent = clampGenerationPercent(options.percent, 0);
  }
  const job = appUpdateProgressJob;
  appUpdateProgressJob = null;
  if (status === "success") {
    job.succeed(patch);
    return;
  }
  job.fail(patch);
}

function emitAppUpdateEvent(channel, payload = {}) {
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send(channel, payload);
      updateLogger.info("app-update:prompt", {
        channel,
        version: payload?.version || null,
      });
    } catch (err) {
      updateLogger.error("app-update:prompt-failed", {
        channel,
        error: err?.message || String(err),
      });
    }
  };

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ forceShow: true });
  }
  ensureMainWindowVisibleForUpdatePrompt();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", send);
    return;
  }
  send();
}

function initializeStartupAppUpdater() {
  if (appUpdateCheckStarted) return;
  appUpdateCheckStarted = true;
  if (!app.isPackaged) {
    updateLogger.info("app-update:skip", { reason: "not-packaged" });
    return;
  }
  const appUpdateConfigPath = getAppUpdateConfigPath();
  if (!fs.existsSync(appUpdateConfigPath)) {
    updateLogger.warn("app-update:skip", {
      reason: "missing-app-update-config",
      path: appUpdateConfigPath,
    });
    return;
  }
  autoUpdater.autoDownload = false;
  // "Later" after update-downloaded must defer installation, not trigger it on
  // the next normal app quit.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = isPrereleaseAppVersion();
  autoUpdater.on("error", async (err) => {
    if (
      appUpdateCheckContext?.phase === "primary-prerelease" &&
      shouldFallbackPrereleaseUpdateCheckToStable(err, {
        allowPrerelease: appUpdateCheckContext?.allowPrerelease === true,
      })
    ) {
      return;
    }
    appUpdateDownloadRequested = false;
    appUpdateDownloadInFlight = false;
    updateLogger.error("app-update:error", {
      error: err?.message || String(err),
    });
    finishAppUpdateProgress("failed", {
      version: appUpdateKnownVersion,
      error: err?.message || String(err),
    });
  });
  autoUpdater.on("checking-for-update", () => {
    updateLogger.info("app-update:checking", {
      allowPrerelease: autoUpdater.allowPrerelease === true,
    });
  });
  autoUpdater.on("update-available", (info) => {
    appUpdateKnownVersion = getUpdateVersionLabel(info);
    updateLogger.info("app-update:available", {
      version: info?.version || null,
    });
    emitAppUpdateEvent("app-update:available", {
      version: appUpdateKnownVersion,
      releaseName: normalizeUpdateReleaseName(info),
      releaseNotes: normalizeUpdateReleaseNotes(info),
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    appUpdateKnownVersion = "";
    updateLogger.info("app-update:not-available", {
      version: info?.version || null,
    });
  });
  autoUpdater.on("download-progress", (progress) => {
    updateAppUpdateProgress(progress, { version: appUpdateKnownVersion });
    updateLogger.debug?.("app-update:download-progress", {
      percent: Number(progress?.percent || 0),
      bytesPerSecond: Number(progress?.bytesPerSecond || 0),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    appUpdateDownloadRequested = false;
    appUpdateDownloadInFlight = false;
    appUpdateKnownVersion =
      getUpdateVersionLabel(info) || appUpdateKnownVersion;
    updateLogger.info("app-update:downloaded", {
      version: info?.version || null,
    });
    finishAppUpdateProgress("success", {
      version: appUpdateKnownVersion,
      detail: getAppUpdateDownloadedDetail(),
    });
    emitAppUpdateEvent("app-update:downloaded", {
      version: appUpdateKnownVersion,
    });
    void pruneAppUpdatePendingCache({
      trigger: "update-downloaded",
    });
  });
  if (shouldDisableAppUpdateChecks(cachedPreferences)) {
    updateLogger.info("app-update:skip", {
      reason: "disabled-by-preference",
    });
    return;
  }
  scheduleStartupAppUpdateCheck(cachedPreferences);
}

ipcMain.handle("app:update-download", async () => {
  if (appUpdateDownloadInFlight) {
    ensureAppUpdateProgressJob({
      version: appUpdateKnownVersion,
      phase: "downloading",
      detail: tUi(
        "main.update.progress.downloading",
        {},
        "Downloading update...",
      ),
    });
    return { success: true, state: "downloading" };
  }
  appUpdateDownloadRequested = true;
  appUpdateDownloadInFlight = true;
  try {
    ensureAppUpdateProgressJob({
      version: appUpdateKnownVersion,
      phase: "preparing",
      detail: getAppUpdatePreparingDetail(),
      percent: 0,
    });
    updateLogger.info("app-update:download-start", {});
    await autoUpdater.downloadUpdate();
    return { success: true, state: "started" };
  } catch (err) {
    appUpdateDownloadRequested = false;
    appUpdateDownloadInFlight = false;
    updateLogger.error("app-update:download-failed", {
      error: err?.message || String(err),
    });
    finishAppUpdateProgress("failed", {
      version: appUpdateKnownVersion,
      error: err?.message || String(err),
    });
    return {
      success: false,
      state: "failed",
      error: err?.message || String(err),
    };
  }
});

ipcMain.handle("app:update-install", async () => {
  updateLogger.info("app-update:install-now", {});
  isQuitting = true;
  autoUpdater.quitAndInstall();
  return { success: true };
});

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

function isOverlayControllerSupportEnabled(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  return source?.overlayControllerSupportEnabled === true;
}

function getOverlayControllerBackendPreference(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  return normalizeBackendPreference(source?.overlayControllerBackend);
}

function isOverlayControllerDebugLoggingEnabled(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  return source?.overlayControllerDebugLogging === true;
}

function getOverlayControllerToggleBinding(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  return normalizeControllerBinding(source?.overlayControllerToggleBinding, {
    allowSingle: true,
    maxButtons: 2,
    allowedButtons: OVERLAY_CONTROLLER_TOGGLE_ALLOWED_BUTTONS,
    defaultBinding: DEFAULT_OVERLAY_CONTROLLER_TOGGLE_BINDING,
  });
}

function getOverlayControllerControlModeBinding(prefs = null) {
  const source =
    prefs && typeof prefs === "object"
      ? prefs
      : cachedPreferences && typeof cachedPreferences === "object"
        ? cachedPreferences
        : readPrefsSafe?.() || {};
  return normalizeControllerBinding(
    source?.overlayControllerControlModeBinding,
    {
      allowSingle: true,
      maxButtons: 2,
      allowedButtons: OVERLAY_CONTROLLER_CONTROL_MODE_ALLOWED_BUTTONS,
      defaultBinding: DEFAULT_OVERLAY_CONTROLLER_CONTROL_MODE_BINDING,
    },
  );
}

function overlayControllerBindingsCanConflict(
  toggleBinding,
  controlModeBinding,
) {
  const toggleButtons = Array.isArray(toggleBinding) ? toggleBinding : [];
  const controlButtons = Array.isArray(controlModeBinding)
    ? controlModeBinding
    : [];
  if (!toggleButtons.length || !controlButtons.length) return false;
  const toggleSet = new Set(toggleButtons);
  return controlButtons.some((button) => toggleSet.has(button));
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
      const overlayLabel = tUi("settings-overlayControlsTitle", {}, "Overlay");
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
      if (onboardingBlocked) {
        return;
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        const nextPresented = !currentlyPresented;
        overlayLogger.debug("overlay:present-path", {
          path: "reuse-existing-window",
          nextPresented,
          state: getOverlayWindowLogState(),
        });
        setOverlayPresented(nextPresented);
        console.log(
          tUi(
            nextPresented
              ? "main.notify.overlayOpened"
              : "main.notify.overlayClosed",
            { shortcut: newShortcut },
            nextPresented
              ? `${overlayLabel} opened.`
              : `${overlayLabel} closed.`,
          ),
        );
      } else {
        overlayLogger.debug("overlay:present-path", {
          path: "create-new-window",
          nextPresented: true,
          state: getOverlayWindowLogState(),
        });
        createOverlayWindow(selectedConfig);
        console.log(
          tUi(
            "main.notify.overlayCreated",
            { shortcut: newShortcut },
            `${overlayLabel} created.`,
          ),
        );
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

function isOverlayControllable() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return false;
  if (!overlayPresented) return false;
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
        source:
          overlayVisibilityAckState?.source || String(source || "unknown"),
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

// Overlay focus safety contract (keep this for drag/snap/reposition fallback logic):
// 1) Do not call `overlayWindow.show()` or `overlayWindow.focus()` from move/snap paths.
// 2) Reposition only an already-created overlay via `setPosition`/`setBounds`.
// 3) Keep the overlay non-focusable and rely on existing click-through toggles.
// 4) Avoid aggressive `setAlwaysOnTop` retoggles during movement (z-order churn/focus side effects).
function setOverlayPresented(next) {
  overlayPresented = !!next;
  try {
    overlayControllerService?.notifyOverlayPresentationChanged?.(
      overlayPresented,
      "setOverlayPresented",
    );
  } catch {}
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

function moveOverlayRelative(deltaX, deltaY) {
  const ctx = getOverlayPositionContext();
  if (!ctx) return false;
  return setOverlayPositionClamped(
    ctx.bounds.x + (Number(deltaX) || 0),
    ctx.bounds.y + (Number(deltaY) || 0),
  );
}

function nudgeOverlayPosition(direction, step = OVERLAY_NUDGE_STEP_PX) {
  const ctx = getOverlayPositionContext();
  if (!ctx) return false;
  const resolvedStep = Math.max(1, Number(step) || OVERLAY_NUDGE_STEP_PX);
  const dir = String(direction || "").toLowerCase();
  if (dir === "left") {
    return setOverlayPositionClamped(ctx.bounds.x - resolvedStep, ctx.bounds.y);
  }
  if (dir === "right") {
    return setOverlayPositionClamped(ctx.bounds.x + resolvedStep, ctx.bounds.y);
  }
  if (dir === "up") {
    return setOverlayPositionClamped(ctx.bounds.x, ctx.bounds.y - resolvedStep);
  }
  if (dir === "down") {
    return setOverlayPositionClamped(ctx.bounds.x, ctx.bounds.y + resolvedStep);
  }
  return false;
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

function sendOverlayScrollPage(direction, source = "unknown") {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayPresented ||
    !overlayWindow.isVisible()
  ) {
    return false;
  }
  const resolvedDirection =
    String(direction || "").toLowerCase() === "up" ? "up" : "down";
  try {
    overlayWindow.webContents.send("overlay:scroll-page", {
      direction: resolvedDirection,
      source: String(source || "unknown"),
    });
    overlayLogger.debug("overlay:scroll-page:sent", {
      direction: resolvedDirection,
      source: String(source || "unknown"),
    });
    return true;
  } catch (err) {
    overlayLogger.warn("overlay:scroll-page:send-failed", {
      direction: resolvedDirection,
      source: String(source || "unknown"),
      error: err?.message || String(err),
    });
    return false;
  }
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
    nudgeOverlayPosition("left");
  });

  registerAll(
    "overlay-position:nudge-right",
    ["Control+Alt+Shift+Right"],
    () => {
      nudgeOverlayPosition("right");
    },
  );

  registerAll("overlay-position:nudge-up", ["Control+Alt+Shift+Up"], () => {
    nudgeOverlayPosition("up");
  });

  registerAll("overlay-position:nudge-down", ["Control+Alt+Shift+Down"], () => {
    nudgeOverlayPosition("down");
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
      sendOverlayScrollPage("up", "keyboard-shortcut");
    },
  );

  registeredOverlayScrollPageDownShortcuts = registerAll(
    "overlay-scroll-down",
    ["PageDown", "Control+PageDown"],
    () => {
      sendOverlayScrollPage("down", "keyboard-shortcut");
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

function toggleOverlayFromController(payload = {}) {
  const onboardingBlocked =
    isBootOnboardingGatePending() || global.bootOnboardingRequired;
  const userIndex = Number(payload?.userIndex);
  if (onboardingBlocked) {
    controllerLogger.info("controller:overlay-toggle:blocked", {
      reason: "boot-onboarding",
      userIndex: Number.isFinite(userIndex) ? userIndex : null,
    });
    return false;
  }

  const currentlyPresented = isOverlayEffectivelyPresented();
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayPresented(!currentlyPresented);
      return true;
    }
    createOverlayWindow(selectedConfig);
    return true;
  } catch (err) {
    controllerLogger.error("controller:overlay-toggle:failed", {
      userIndex: Number.isFinite(userIndex) ? userIndex : null,
      error: err?.message || String(err),
    });
    return false;
  }
}

function buildOverlayControllerRuntimeState(prefs = null, overrides = {}) {
  return {
    supportEnabled: isOverlayControllerSupportEnabled(prefs),
    toggleBinding: getOverlayControllerToggleBinding(prefs),
    controlModeBinding: getOverlayControllerControlModeBinding(prefs),
    controlModeActive: Object.prototype.hasOwnProperty.call(
      overrides || {},
      "controlModeActive",
    )
      ? overrides.controlModeActive === true
      : overlayControllerRuntimeStateCache.controlModeActive === true,
    controlModeUserIndex: Number.isFinite(
      Number(overrides?.controlModeUserIndex),
    )
      ? Number(overrides.controlModeUserIndex)
      : Number.isFinite(
            Number(overlayControllerRuntimeStateCache.controlModeUserIndex),
          )
        ? Number(overlayControllerRuntimeStateCache.controlModeUserIndex)
        : null,
  };
}

function broadcastOverlayControllerRuntimeState(prefs = null, overrides = {}) {
  overlayControllerRuntimeStateCache = buildOverlayControllerRuntimeState(
    prefs,
    overrides,
  );
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "overlay-controller-runtime-state",
        overlayControllerRuntimeStateCache,
      );
    }
  } catch {}
  return overlayControllerRuntimeStateCache;
}

function handleOverlayControllerAction(type, payload = {}) {
  const action = String(type || "");
  if (!action) return;

  if (action === "overlay.control-mode") {
    const controlModeUserIndex =
      Number.isFinite(Number(payload?.userIndex)) &&
      Number(payload?.userIndex) >= 0
        ? Number(payload?.userIndex)
        : null;
    controllerLogger.info("controller:overlay-control-mode", {
      active: payload?.active === true,
      reason: payload?.reason || null,
      userIndex: controlModeUserIndex,
    });
    broadcastOverlayControllerRuntimeState(cachedPreferences, {
      controlModeActive: payload?.active === true,
      controlModeUserIndex,
    });
    return;
  }

  if (action === "overlay.toggle") {
    toggleOverlayFromController(payload);
    return;
  }

  if (!isOverlayControllable()) {
    controllerLogger.debug("controller:overlay-action:skipped", {
      action,
      reason: "overlay-not-controllable",
    });
    return;
  }

  if (action === "overlay.move-relative") {
    moveOverlayRelative(payload?.dx, payload?.dy);
    return;
  }
  if (action === "overlay.scroll-page") {
    sendOverlayScrollPage(payload?.direction, "controller-input");
    return;
  }
  if (action === "overlay.nudge") {
    nudgeOverlayPosition(payload?.direction);
    return;
  }
  if (action === "overlay.snap-cycle") {
    cycleOverlaySnapPreset();
    return;
  }

  controllerLogger.debug("controller:overlay-action:unknown", {
    action,
    payload,
  });
}

function syncOverlayControllerSupportState(reason, prefs = null) {
  if (!overlayControllerService) {
    overlayControllerService = createOverlayControllerService({
      logger: controllerLogger,
      isSupportEnabled: (source) => isOverlayControllerSupportEnabled(source),
      getPreferredBackend: (source) =>
        getOverlayControllerBackendPreference(source),
      isDebugLoggingEnabled: (source) =>
        isOverlayControllerDebugLoggingEnabled(source),
      getOverlayToggleBinding: (source) =>
        getOverlayControllerToggleBinding(source),
      getOverlayControlModeBinding: (source) =>
        getOverlayControllerControlModeBinding(source),
      canEnterOverlayControlMode: () => isOverlayControllable(),
      isOverlayPresented: () => isOverlayEffectivelyPresented(),
      onAction: handleOverlayControllerAction,
    });
  }
  const status = overlayControllerService.sync(reason, prefs);
  broadcastOverlayControllerRuntimeState(prefs, {
    controlModeActive: status?.controlModeActive === true,
    controlModeUserIndex:
      Number.isFinite(Number(status?.controlModeUserIndex)) &&
      Number(status?.controlModeUserIndex) >= 0
        ? Number(status.controlModeUserIndex)
        : null,
  });
  return status;
}

function validateOverlayControllerSupportPreference(
  currentPrefs,
  mergedPrefs,
  incomingPatch,
) {
  const currentBackend = getOverlayControllerBackendPreference(currentPrefs);
  const mergedBackend = getOverlayControllerBackendPreference(mergedPrefs);
  const enablingNow =
    currentPrefs?.overlayControllerSupportEnabled !== true &&
    mergedPrefs?.overlayControllerSupportEnabled === true;
  const backendChanged = currentBackend !== mergedBackend;
  const supportEnabled = mergedPrefs?.overlayControllerSupportEnabled === true;
  if (!supportEnabled || (!enablingNow && !backendChanged)) return mergedPrefs;

  const availability = inspectControllerBackendAvailability();
  const preferredBackend = mergedBackend;
  const selectedBackendAvailable =
    preferredBackend === "gameinput"
      ? availability.gameInput.available
      : preferredBackend === "xinput"
        ? availability.xInput.available
        : availability.anyAvailable;

  if (!selectedBackendAvailable) {
    if (backendChanged && !enablingNow) {
      controllerLogger.warn("controller:preference-backend-rejected", {
        reason: "selected-backend-unavailable",
        requestedBackend: preferredBackend,
        fallbackBackend: currentBackend,
        gameInputError: availability.gameInput.error,
        xInputError: availability.xInput.error,
      });
      notifyError(
        tUi(
          preferredBackend === "xinput"
            ? "main.notify.overlayControllerSupportXInputUnavailable"
            : "main.notify.overlayControllerSupportGameInputUnavailable",
          {},
          preferredBackend === "xinput"
            ? "The XInput backend is not available on this PC. The previous overlay controller backend was kept."
            : "The GameInput backend is not available on this PC. The previous overlay controller backend was kept.",
        ),
      );
      mergedPrefs.overlayControllerBackend = currentBackend;
      if (
        Object.prototype.hasOwnProperty.call(
          incomingPatch || {},
          "overlayControllerBackend",
        )
      ) {
        incomingPatch.overlayControllerBackend = currentBackend;
      }
      return mergedPrefs;
    }

    controllerLogger.warn("controller:preference-enable:rejected", {
      reason:
        preferredBackend === "auto"
          ? "no-backend-available"
          : "selected-backend-unavailable",
      preferredBackend,
      gameInputError: availability.gameInput.error,
      xInputError: availability.xInput.error,
    });
    notifyError(
      tUi(
        preferredBackend === "xinput"
          ? "main.notify.overlayControllerSupportXInputUnavailable"
          : preferredBackend === "gameinput"
            ? "main.notify.overlayControllerSupportGameInputUnavailable"
            : "main.notify.overlayControllerSupportUnavailable",
        {},
        preferredBackend === "xinput"
          ? "The XInput backend is not available on this PC. Switch the overlay controller backend to Auto or GameInput."
          : preferredBackend === "gameinput"
            ? "The GameInput backend is not available on this PC. Install Microsoft GameInput or switch the overlay controller backend to Auto or XInput."
            : "No supported controller runtime was found. Install Microsoft GameInput or use an XInput-compatible controller.",
      ),
    );
    mergedPrefs.overlayControllerSupportEnabled = false;
    if (
      Object.prototype.hasOwnProperty.call(
        incomingPatch || {},
        "overlayControllerSupportEnabled",
      )
    ) {
      incomingPatch.overlayControllerSupportEnabled = false;
    }
    return mergedPrefs;
  }

  if (preferredBackend === "auto" && !availability.gameInput.available) {
    controllerLogger.warn("controller:preference-enable:gameinput-missing", {
      xInputDllName: availability.xInput.dllName,
      gameInputError: availability.gameInput.error,
    });
    notifyWarn(
      tUi(
        "main.notify.overlayControllerSupportGameInputMissing",
        {},
        "Microsoft GameInput was not found on this PC. Native PlayStation controller support is unavailable; XInput-compatible controllers can still use the overlay.",
      ),
    );
  }

  return mergedPrefs;
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
  /^\[[^\]]+\]\s+\[(?:DEBUG|INFO|WARN|ERROR)\]\s+/i,
  /\b(?:boot-cache|load-achievement-cache|initial-notify|refresh-config-state|seed|watcher|watch|save-path):/i,
  /\b(?:overlay|create-overlay|createOverlayWindow|overlay-window|setOverlayPresented|overlay-position):/i,
  /\b(?:controller|process-poller):/i,
  /\bsteam-local-users:resolveSteamRoot-not-found\b/i,
  /\blistSteamLoginUsers-(?:no-root|no-loginusers|read-failed|success)\b/i,
  /\bachgen:(?:spawn|stdout|stderr|process-(?:error|exit)|launch-metadata|child-log|schema-exists|attempt-failed|schema-failed)\b/i,
  /\b(?:uplay-mapping|seeded-json|platform-migrate):/i,
  /\bsteamdb:launch-metadata:/i,
  /\bsteam-appcache:/i,
  /\bsteam-official:(?:list-accounts|librarycache:|preferences-refresh-failed|pending-schema|skip-existing|skip-nonselected-account)\b/i,
  /\bepic-official:/i,
  /\bauto-select:index-(?:build-failed|built)\b/i,
  /\bDeprecationWarning\b/i,
  /\[DEP\d{4}\]/i,
  /--trace-deprecation/i,
  /node:internal\/process\/warning/i,
  /fs\.rmdir\(path,\s*\{\s*recursive:\s*true\s*\}\)/i,
  /No published versions on GitHub/i,
  /latest\.yml/i,
  /builder-util-runtime/i,
  /electron-updater/i,
  /\bnet::ERR_[A-Z0-9_]+\b/i,
  /\bERR_(?:NETWORK_ACCESS_DENIED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_TIMED_OUT)\b/i,
  /\bSimpleURLLoaderWrapper\b/i,
  /node:electron\/js2c\/browser_init/i,
  /GitHubProvider\.getLatestVersion/i,
  /\bNsisUpdater\b/i,
  /\bAppUpdater\b/i,
  /\bUpdate\b.*\bfound\b/i,
  /\bFound version\b/i,
  /Download block maps/i,
  /disableWebInstaller is set to false/i,
  /releases\/download\//i,
  /\bNew version\b.*\bdownloaded to\b/i,
  /\bUpdate has already been downloaded to\b/i,
  /\bChecking for update\b/i,
  /Checking for update \(already in progress\)/i,
  /\bUpdate for version\b.*\bis not available\b/i,
  /Downloading update \(already in progress\)/i,
  /\bDownloading update from\b/i,
  /Cannot download differentially,\s*fallback to full download/i,
  /^\s*cancelled\s*$/i,
  /Install on explicit quitAndInstall/i,
  /\bInstall:\s*isSilent:\b/i,
  /install call ignored: quitAndInstallCalled is set to true/i,
  /Update installer has already been triggered/i,
  /Update will not be installed on quit because autoInstallOnAppQuit is set to false/i,
  /Update will be not installed on quit because application is quitting with exit code/i,
  /Auto install update on quit/i,
  /\bExecuting:\b.*\bwith args:\b/i,
  /isAdminRightsRequired is set to true/i,
  /Cannot run installer: error code:/i,
  /Error on remove temp update file/i,
  /Cannot rename temp file to final file/i,
  /Generated new staging user ID/i,
  /Staging percentage:/i,
  /Staging percentage is NaN/i,
  /Failed to compare current OS version/i,
  /Current OS version .* is less than the minimum OS version required/i,
  /\bapp-update:(?:checking|available|not-available|download-start|download-progress|downloaded|error|prompt|prompt-failed|check-failed|install-now|skip|cache-pruned|cache-prune-failed)\b/i,
  /\bupdater\b.*\bcache\b/i,
  /\bcache\b.*\b(?:updater|update|installer|pending|blockmap)\b/i,
  /\bblockmap\b/i,
  /\bsha512\b/i,
  /\bfileInfo\b/i,
  /\bdownloaded\s+file\b/i,
  /\bfull:\s*\d+/i,
  /\bdifferential:\s*\d+/i,
  /\bupdat(?:e|er)\b.*\b(?:size|bytes?|download|downloaded|pending|package)\b/i,
];

const APP_UPDATE_NOTIFICATION_SUPPRESS_PATTERNS = [
  /\bapp-update:/i,
  /\belectron-updater\b/i,
  /\bbuilder-util-runtime\b/i,
  /\bGitHubProvider\b/i,
  /\bNsisUpdater\b/i,
  /\bAppUpdater\b/i,
  /\bupdater\b.*\bcache\b/i,
  /\bcache\b.*\b(?:updater|update|installer|pending|blockmap)\b/i,
  /\bblockmap\b/i,
  /\bsha512\b/i,
  /\bfileInfo\b/i,
  /\bChecking for update\b/i,
  /\bDownloading update\b/i,
  /\bDownloading\b.*\b(?:update|installer|package|block)\b/i,
  /\bdownloaded\s+file\b/i,
  /\bCannot download differentially\b/i,
  /\bStaging percentage\b/i,
  /\blatest\.yml\b/i,
  /releases\/download\//i,
];

function shouldSuppressConsoleMessageInUI(msg) {
  if (!msg) return true;
  if (
    msg.startsWith("steam-achievements:request") ||
    msg.startsWith("steam-achievements:success")
  ) {
    return true;
  }
  return (
    UI_CONSOLE_SUPPRESS_PATTERNS.some((rx) => rx.test(msg)) ||
    APP_UPDATE_NOTIFICATION_SUPPRESS_PATTERNS.some((rx) => rx.test(msg))
  );
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
let configsChangedNotifyTimer = null;
const CONFIGS_CHANGED_NOTIFY_DEBOUNCE_MS = 500;

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
  clearTimeout(configsChangedNotifyTimer);
  configsChangedNotifyTimer = setTimeout(() => {
    configsChangedNotifyTimer = null;
    broadcastToAll("configs:changed");
  }, CONFIGS_CHANGED_NOTIFY_DEBOUNCE_MS);
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
  setBlacklistedConfigKeys(cachedPreferences?.[BLACKLIST_CONFIG_PREF_KEY]);
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
  if (Object.prototype.hasOwnProperty.call(patch, BLACKLIST_CONFIG_PREF_KEY)) {
    try {
      setBlacklistedConfigKeys(prefsSnapshot?.[BLACKLIST_CONFIG_PREF_KEY]);
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
  if ("disableUpdate" in patch) {
    if (shouldDisableAppUpdateChecks(prefsSnapshot)) {
      clearScheduledStartupAppUpdateCheck();
    } else {
      scheduleStartupAppUpdateCheck(prefsSnapshot);
    }
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
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "overlayControllerSupportEnabled",
    ) ||
    Object.prototype.hasOwnProperty.call(patch, "overlayControllerBackend") ||
    Object.prototype.hasOwnProperty.call(
      patch,
      "overlayControllerToggleBinding",
    ) ||
    Object.prototype.hasOwnProperty.call(
      patch,
      "overlayControllerControlModeBinding",
    )
  ) {
    syncOverlayControllerSupportState(
      "preferences:overlay-controller-support",
      prefsSnapshot,
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "showHiddenDescription")) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay-preferences-updated", {
        showHiddenDescription: prefsSnapshot.showHiddenDescription === true,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "appTheme")) {
    const appTheme = normalizeAppTheme(prefsSnapshot.appTheme);
    const themeRegistry = getThemeRegistryPayload();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay-preferences-updated", {
        appTheme,
        themes: themeRegistry.themes,
      });
    }
    broadcastToAll("tray:theme-changed", {
      appTheme,
      themes: themeRegistry.themes,
      themesFolder: themeRegistry.folder,
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(
      patch,
      "notificationClickRedirectEnabled",
    ) &&
    prefsSnapshot.notificationClickRedirectEnabled !== true
  ) {
    disableActiveAnimatedNotificationNavigation("preferences-disabled");
    activeNativeAchievementNotifications.releaseAll("preferences-disabled");
    clearNativeWindowsNotificationRoutes("preferences-disabled");
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
      processPoller.setEnabled(true);
      processPoller.setEventWatcherEnabled(processWatcherEnabled);
    } catch {}
    if (!processWatcherEnabled) {
      appLogger.info("process-poller:fallback-enabled-by-preferences");
      scheduleAutoSelectProcessPollerAfterBoot();
    } else {
      appLogger.info("process-poller:native-enabled-by-preferences");
      scheduleAutoSelectProcessPollerAfterBoot();
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "steamOfficialSteamId")) {
    refreshSelectedSteamOfficialMonitoring().catch((err) => {
      appLogger.warn("steam-official:preferences-refresh-failed", {
        error: err?.message || String(err),
      });
    });
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

  if (Object.prototype.hasOwnProperty.call(incoming, "soundVolume")) {
    const parsedSoundVolume = Number.parseInt(incoming.soundVolume, 10);
    if (Number.isFinite(parsedSoundVolume)) {
      incoming.soundVolume = Math.max(0, Math.min(200, parsedSoundVolume));
    } else {
      delete incoming.soundVolume;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incoming, "appTheme")) {
    incoming.appTheme = normalizeAppTheme(incoming.appTheme);
  }

  if (
    Object.prototype.hasOwnProperty.call(
      incoming,
      "notificationClickRedirectEnabled",
    )
  ) {
    incoming.notificationClickRedirectEnabled =
      incoming.notificationClickRedirectEnabled === true;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      incoming,
      "notificationClickRedirectTarget",
    )
  ) {
    incoming.notificationClickRedirectTarget =
      normalizeNotificationNavigationTarget(
        incoming.notificationClickRedirectTarget,
        DEFAULT_PREFERENCES.notificationClickRedirectTarget,
      );
  }

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

  if (Object.prototype.hasOwnProperty.call(incoming, "steamOfficialSteamId")) {
    incoming.steamOfficialSteamId = normalizeSteamOfficialSteamId(
      incoming.steamOfficialSteamId,
    );
  }
  if (Object.prototype.hasOwnProperty.call(incoming, "epicOfficialAccountId")) {
    incoming.epicOfficialAccountId = normalizeEpicAccountId(
      incoming.epicOfficialAccountId,
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(incoming, "overlayControllerBackend")
  ) {
    incoming.overlayControllerBackend = normalizeBackendPreference(
      incoming.overlayControllerBackend,
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      incoming,
      "overlayControllerDebugLogging",
    )
  ) {
    incoming.overlayControllerDebugLogging =
      incoming.overlayControllerDebugLogging === true;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      incoming,
      "overlayControllerToggleBinding",
    )
  ) {
    incoming.overlayControllerToggleBinding =
      getOverlayControllerToggleBinding(incoming);
  }
  if (
    Object.prototype.hasOwnProperty.call(
      incoming,
      "overlayControllerControlModeBinding",
    )
  ) {
    incoming.overlayControllerControlModeBinding =
      getOverlayControllerControlModeBinding(incoming);
  }

  try {
    const current = readPrefsSafe();
    const merged = mergeWithDefaultPreferences({
      ...current,
      ...incoming,
    });
    merged.overlayControllerToggleBinding =
      getOverlayControllerToggleBinding(merged);
    merged.overlayControllerControlModeBinding =
      getOverlayControllerControlModeBinding(merged);
    if (
      overlayControllerBindingsCanConflict(
        merged.overlayControllerToggleBinding,
        merged.overlayControllerControlModeBinding,
      )
    ) {
      prefsLogger.warn(
        "preferences:update:overlay-controller-binding-conflict",
        {
          toggleBinding: merged.overlayControllerToggleBinding,
          controlModeBinding: merged.overlayControllerControlModeBinding,
        },
      );
      notifyError(
        tUi(
          "main.notify.overlayControllerBindingConflict",
          {},
          "Overlay controller bindings cannot use the same buttons.",
        ),
      );
      return current;
    }
    validateOverlayControllerSupportPreference(current, merged, incoming);
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

    writeJsonAtomicSync(preferencesPath, merged, { backup: true });
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
  if (isAppIdBlacklisted(appid, opts?.platform || null)) {
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
      if (!msg) return;
      if (msg.type === "achgen:progress") {
        try {
          if (typeof opts.onProgress === "function") {
            opts.onProgress({
              appid: String(msg.appid || appid),
              phase: String(msg.phase || ""),
              detail: String(msg.detail || ""),
              current:
                Number.isFinite(Number(msg.current)) && Number(msg.current) >= 0
                  ? Number(msg.current)
                  : 0,
              total:
                Number.isFinite(Number(msg.total)) && Number(msg.total) >= 0
                  ? Number(msg.total)
                  : 0,
              percent: clampGenerationPercent(msg.percent, 0),
            });
          }
        } catch {}
        return;
      }
      if (msg.type !== "achgen:log") return;
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

function createSchemaRegenerateTempRoot(platform, appid) {
  const safePlatform = String(platform || "schema").replace(/[^\w.-]+/g, "_");
  const safeAppId = String(appid || "unknown").replace(/[^\w.-]+/g, "_");
  const token = crypto.randomBytes(4).toString("hex");
  return path.join(
    app.getPath("userData"),
    "tmp",
    "schema-regenerate",
    `${safePlatform}-${safeAppId}-${Date.now()}-${token}`,
  );
}

function validateGeneratedSchemaDir(schemaDir) {
  const achJson = path.join(schemaDir, "achievements.json");
  if (!fs.existsSync(achJson)) {
    return {
      ok: false,
      message: tUi(
        "main.message.schemaGeneratedMissing",
        {},
        "Generated achievements.json is missing",
      ),
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(achJson, "utf8"));
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        message: tUi(
          "main.message.schemaGeneratedInvalidType",
          {},
          "Generated achievements.json is not an array",
        ),
      };
    }
    if (parsed.length === 0) {
      return {
        ok: false,
        message: tUi(
          "main.message.schemaGeneratedEmpty",
          {},
          "Generated achievements.json is empty",
        ),
      };
    }
    return { ok: true, count: parsed.length };
  } catch (err) {
    return {
      ok: false,
      message: tUi(
        "main.message.schemaGeneratedInvalidJson",
        { error: err?.message || err },
        "Generated achievements.json is invalid: {error}",
      ),
    };
  }
}

function replaceSchemaDirWithBackup(sourceDir, destDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error("Generated schema directory is missing");
  }
  const parent = path.dirname(destDir);
  const backupBase = path.join(
    parent,
    `${path.basename(destDir)}.__backup_${Date.now()}`,
  );
  const backupDir = getUniqueSiblingPath(backupBase);
  const hadExisting = fs.existsSync(destDir);

  fs.mkdirSync(parent, { recursive: true });
  try {
    if (hadExisting) {
      fs.renameSync(destDir, backupDir);
      copyFolderOverwrite(backupDir, destDir);
    }
    copyFolderOverwrite(sourceDir, destDir);
    if (hadExisting) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (err) {
    try {
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (hadExisting && fs.existsSync(backupDir)) {
        fs.renameSync(backupDir, destDir);
      }
    } catch (restoreErr) {
      schemaLogger.error("schema:regenerate-restore-failed", {
        destDir,
        backupDir,
        error: restoreErr?.message || String(restoreErr),
      });
    }
    throw err;
  }
}

async function ensureSchemaForApp(appid, platform = "steam", options = {}) {
  let appidStr = String(appid || "").trim();
  const onGenerationProgress =
    typeof options.onGenerationProgress === "function"
      ? options.onGenerationProgress
      : null;
  const emitGenerationProgress = (progress = {}) => {
    if (!onGenerationProgress) return;
    try {
      onGenerationProgress({
        appid: String(progress.appid || appidStr || appid || ""),
        phase: String(progress.phase || ""),
        detail: String(progress.detail || ""),
        current:
          Number.isFinite(Number(progress.current)) &&
          Number(progress.current) >= 0
            ? Number(progress.current)
            : 0,
        total:
          Number.isFinite(Number(progress.total)) && Number(progress.total) >= 0
            ? Number(progress.total)
            : 0,
        percent: clampGenerationPercent(progress.percent, 0),
      });
    } catch {}
  };
  if (!platform && /[a-f]/i.test(appidStr)) {
    platform = "epic";
  }
  const normalizedPlatform = normalizeStoragePlatform(platform);
  const sanitizedAppId = sanitizeAppIdForPlatform(appidStr, normalizedPlatform);
  if (!sanitizedAppId) return null;
  appidStr = sanitizedAppId;
  appid = sanitizedAppId;

  const schemaBase = SCHEMA_ROOT_PATH; // %APPDATA%\Achievements\configs\schema
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

  if (normalizedPlatform === "epic-official") {
    emitGenerationProgress({
      phase: "generatingSchema",
      detail: "Generating schema",
      percent: 20,
    });
    try {
      const result = await ensureEpicOfficialSchema(appid, destDir, {
        ...options,
        productId:
          options?.epic_product_id ||
          options?.epicProductId ||
          options?.productId,
        sandboxId:
          options?.epic_sandbox_id ||
          options?.epicSandboxId ||
          options?.epic_namespace ||
          options?.epicNamespace,
      });
      if (result?.dir && fs.existsSync(achJson)) {
        emitGenerationProgress({
          phase: "finalizing",
          detail: "Finalizing",
          percent: 96,
        });
        ipcLogger.info("schema:ensure-generated-epic-official", {
          appid,
          platform: normalizedPlatform,
          dir: result.dir,
          productId: result.productId || null,
          sandboxId: result.sandboxId || null,
        });
        return { ...result, dir: result.dir, existed: false };
      }
    } catch (err) {
      ipcLogger.warn("schema:epic-official-failed", {
        appid,
        error: err?.message || String(err),
      });
      throw err;
    }
    return null;
  }

  if (normalizedPlatform === "gog-official") {
    emitGenerationProgress({
      phase: "generatingSchema",
      detail: "Generating schema",
      percent: 20,
    });
    try {
      const result = await ensureGogOfficialSchema(appid, destDir, {
        gameplayDbPath:
          options?.gog_gameplay_db ||
          options?.gogGameplayDb ||
          options?.gameplayDbPath,
        clientId: options?.gog_client_id || options?.gogClientId,
        userId: options?.gog_user_id || options?.gogUserId,
      });
      if (result?.dir && fs.existsSync(achJson)) {
        emitGenerationProgress({
          phase: "finalizing",
          detail: "Finalizing",
          percent: 96,
        });
        ipcLogger.info("schema:ensure-generated-local", {
          appid,
          platform: normalizedPlatform,
          dir: result.dir,
          gameplayDbPath: result.gameplayDbPath || null,
        });
        return { dir: result.dir, existed: false };
      }
    } catch (err) {
      ipcLogger.warn("schema:gog-official-failed", {
        appid,
        error: err?.message || String(err),
      });
      throw err;
    }
    return null;
  }

  if (normalizedPlatform === "ubisoft-official") {
    emitGenerationProgress({
      phase: "generatingSchema",
      detail: "Generating schema",
      percent: 20,
    });
    try {
      const result = await ensureUbisoftOfficialSchema(appid, destDir, {
        archivePath:
          options?.ubisoft_achievements_archive ||
          options?.ubisoftAchievementsArchive ||
          options?.archivePath,
        steamAppId:
          options?.steamAppId || resolveUbisoftSteamAppId(appid) || "",
      });
      if (result?.dir && fs.existsSync(achJson)) {
        emitGenerationProgress({
          phase: "finalizing",
          detail: "Finalizing",
          percent: 96,
        });
        ipcLogger.info("schema:ensure-generated-local", {
          appid,
          platform: normalizedPlatform,
          dir: result.dir,
          archivePath: result.archivePath || null,
        });
        return { dir: result.dir, existed: false };
      }
    } catch (err) {
      ipcLogger.warn("schema:ubisoft-official-failed", {
        appid,
        error: err?.message || String(err),
      });
      throw err;
    }
    return null;
  }

  if (normalizedPlatform === "ea-official") {
    emitGenerationProgress({
      phase: "generatingSchema",
      detail: "Generating schema",
      percent: 20,
    });
    try {
      const result = await ensureEaOfficialSchema(appid, destDir, {
        logFilePath:
          options?.ea_log_file || options?.eaLogFile || options?.logFilePath,
        achievementSet:
          options?.ea_achievement_set || options?.eaAchievementSet,
        savePath: options?.save_path || options?.savePath,
      });
      if (result?.dir && fs.existsSync(achJson)) {
        emitGenerationProgress({
          phase: "finalizing",
          detail: "Finalizing",
          percent: 96,
        });
        ipcLogger.info("schema:ensure-generated-local", {
          appid,
          platform: normalizedPlatform,
          dir: result.dir,
          logFilePath: result.logFilePath || null,
          achievementSet: result.achievementSet || null,
        });
        return { dir: result.dir, existed: false };
      }
    } catch (err) {
      ipcLogger.warn("schema:ea-official-failed", {
        appid,
        error: err?.message || String(err),
      });
      throw err;
    }
    return null;
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
    emitGenerationProgress({
      phase: "generatingSchema",
      detail: "Starting schema generation",
      percent: 12,
    });
    const tempRoot = createSchemaRegenerateTempRoot(normalizedPlatform, appid);
    const tempDestDir = path.join(tempRoot, normalizedPlatform, appid);
    try {
      await runAchievementsGenerator(appid, tempRoot, app.getPath("userData"), {
        platform: normalizedPlatform,
        langs: getSchemaLanguagesFromPreferences(),
        onProgress: (progress) => {
          emitGenerationProgress({
            ...progress,
            percent:
              18 +
              Math.round(clampGenerationPercent(progress?.percent, 0) * 0.72),
          });
        },
      });
      const validation = validateGeneratedSchemaDir(tempDestDir);
      if (!validation.ok) {
        ipcLogger.warn("schema:ensure-empty-output-kept-existing", {
          appid,
          platform: normalizedPlatform,
          tempDestDir,
          reason: validation.message,
        });
        throw new Error(
          tUi(
            "main.message.schemaRegenerateSafeFailure",
            { reason: validation.message },
            "{reason}. Existing schema was kept unchanged.",
          ),
        );
      }
      replaceSchemaDirWithBackup(tempDestDir, destDir);
    } finally {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
    if (fs.existsSync(achJson)) {
      emitGenerationProgress({
        phase: "finalizing",
        detail: "Finalizing",
        percent: 96,
      });
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

  await enqueueScreenshotCaptureTask(() => captureFullScreenShotInWorker(file), {
    gameName,
    achievement: achDisplayName,
  });
  return file;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    process.kill(pid, "SIGKILL");
  } catch {}
}

const screenshotCaptureQueue = [];
let screenshotCaptureInFlight = false;

function pumpScreenshotCaptureQueue() {
  if (screenshotCaptureInFlight) return;
  const next = screenshotCaptureQueue.shift();
  if (!next) return;
  screenshotCaptureInFlight = true;
  notificationLogger.info("notification:screenshot:queue-run", {
    queuedRemaining: screenshotCaptureQueue.length,
    gameName: next.meta.gameName || null,
    achievement: next.meta.achievement || null,
  });
  Promise.resolve()
    .then(() => next.task())
    .then((result) => next.resolve(result))
    .catch((error) => next.reject(error))
    .finally(() => {
      screenshotCaptureInFlight = false;
      if (screenshotCaptureQueue.length > 0) {
        setImmediate(pumpScreenshotCaptureQueue);
      }
    });
}

function enqueueScreenshotCaptureTask(task, meta = {}) {
  return new Promise((resolve, reject) => {
    screenshotCaptureQueue.push({
      task,
      resolve,
      reject,
      meta: meta && typeof meta === "object" ? meta : {},
    });
    notificationLogger.info("notification:screenshot:queued", {
      queued: screenshotCaptureQueue.length,
      inFlight: screenshotCaptureInFlight,
      gameName: meta?.gameName || null,
      achievement: meta?.achievement || null,
    });
    pumpScreenshotCaptureQueue();
  });
}

function captureFullScreenShotInWorker(outputPath, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) ||
      Number(process.env.ACHIEVEMENTS_SCREENSHOT_TIMEOUT_MS) ||
      8000,
  );
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "utils", "screenshot-capture-worker.js");
    const payload = JSON.stringify({ outputPath, timeoutMs });
    const cp = fork(script, [payload], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let settled = false;
    const stderr = [];
    let reportedSuccessPath = "";
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        killProcessTree(cp.pid);
        reject(err);
        return;
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      const err = new Error(`Screenshot capture timed out after ${timeoutMs}ms`);
      err.code = "capture-timeout";
      finish(err);
    }, timeoutMs + 1000);

    cp.stderr?.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) stderr.push(text.slice(0, 1000));
    });
    cp.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.ok) {
        reportedSuccessPath = message.outputPath || outputPath;
        return;
      }
      const err = new Error(message.error || "Screenshot capture failed");
      err.code = message.code || "capture-failed";
      finish(err);
    });
    cp.on("error", (err) => finish(err));
    cp.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0 && (reportedSuccessPath || fs.existsSync(outputPath))) {
        finish(null, reportedSuccessPath || outputPath);
        return;
      }
      const err = new Error(
        stderr[0] ||
          `Screenshot worker exited before completing (code=${code}, signal=${signal || ""})`,
      );
      err.code = code === null && signal ? "capture-killed" : "capture-failed";
      finish(err);
    });
  });
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
  cachedPreferences.overlayControllerToggleBinding =
    getOverlayControllerToggleBinding(cachedPreferences);
  cachedPreferences.overlayControllerControlModeBinding =
    getOverlayControllerControlModeBinding(cachedPreferences);
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
  cachedPreferences.steamOfficialSteamId = normalizeSteamOfficialSteamId(
    cachedPreferences.steamOfficialSteamId,
  );
  cachedPreferences.epicOfficialAccountId = normalizeEpicAccountId(
    cachedPreferences.epicOfficialAccountId,
  );
  const safePrefs = { ...cachedPreferences };
  if (safePrefs.steamApiKey) {
    safePrefs.steamApiKeyMasked = maskSteamApiKey(safePrefs.steamApiKey);
    delete safePrefs.steamApiKey;
  } else {
    safePrefs.steamApiKeyMasked = "";
  }
  return safePrefs;
});

ipcMain.handle("themes:list", () => getThemeRegistryPayload());

ipcMain.handle("themes:reload", () => {
  const payload = getThemeRegistryPayload();
  const prefs = readPrefsSafe();
  const appTheme = normalizeAppTheme(prefs?.appTheme);
  broadcastToAll("tray:theme-changed", {
    appTheme,
    themes: payload.themes,
    themesFolder: payload.folder,
  });
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay-preferences-updated", {
      appTheme,
      themes: payload.themes,
    });
  }
  return payload;
});

ipcMain.handle("steam-official:list-accounts", () => {
  const catalog = getSteamOfficialAccountCatalog();
  appLogger.info("steam-official:list-accounts", {
    steamRoot: catalog?.steamRoot || "",
    loginUsersPath: catalog?.loginUsersPath || "",
    accountCount: Array.isArray(catalog?.accounts)
      ? catalog.accounts.length
      : 0,
  });
  return {
    steamRoot: catalog?.steamRoot || "",
    loginUsersPath: catalog?.loginUsersPath || "",
    accounts: Array.isArray(catalog?.accounts)
      ? catalog.accounts.map((account) => ({
          steamid64: account.steamid64,
          accountId: account.accountId,
          accountName: account.accountName,
          personaName: account.personaName,
          mostRecent: account.mostRecent === true,
          label:
            account.label ||
            account.personaName ||
            account.accountName ||
            account.steamid64,
        }))
      : [],
  };
});

function normalizeEpicAuthCode(value) {
  const code = String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
  return /^[a-zA-Z0-9_-]{20,256}$/.test(code) ? code : "";
}

function extractEpicAuthResult(rawUrl) {
  const raw = String(rawUrl || "");
  try {
    const parsed = new URL(raw);
    const code = normalizeEpicAuthCode(parsed.searchParams.get("code"));
    const errorCode = parsed.searchParams.get("error");
    const errorDescription = parsed.searchParams.get("error_description");
    if (code) return { code };
    if (errorCode || errorDescription) {
      return {
        error: errorDescription || errorCode || "epic-auth-failed",
      };
    }
  } catch {}
  try {
    const parsed = JSON.parse(raw);
    const code =
      normalizeEpicAuthCode(parsed?.authorizationCode) ||
      normalizeEpicAuthCode(parsed?.code);
    if (code) return { code };
    const redirectUrl = String(parsed?.redirectUrl || "");
    const redirectMatch = redirectUrl.match(
      /[?&]code=([a-zA-Z0-9_-]{20,256})/i,
    );
    const redirectCode = normalizeEpicAuthCode(redirectMatch?.[1]);
    if (redirectCode) return { code: redirectCode };
  } catch {}
  const codeMatch =
    raw.match(
      /localhost\/launcher\/authorized\?code=([a-zA-Z0-9_-]{20,256})/i,
    ) ||
    raw.match(
      /["']authorizationCode["']\s*:\s*["']([a-zA-Z0-9_-]{20,256})["']/i,
    ) ||
    raw.match(/["']code["']\s*:\s*["']([a-zA-Z0-9_-]{20,256})["']/i);
  const matchedCode = normalizeEpicAuthCode(codeMatch?.[1]);
  if (matchedCode) {
    return { code: matchedCode };
  }
  return null;
}

function getEpicAuthRequestOptions(extra = {}) {
  return {
    userDataDir: app.getPath("userData"),
    ...extra,
  };
}

const EPIC_OFFICIAL_AUTH_PARTITION = "persist:epic-official-auth";

async function clearEpicOfficialAuthSession(reason = "unknown") {
  try {
    const authSession = session.fromPartition(EPIC_OFFICIAL_AUTH_PARTITION);
    await authSession.clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "indexdb",
        "serviceworkers",
        "cachestorage",
      ],
    });
    try {
      await authSession.clearCache();
    } catch {}
    epicOfficialLogger.info("epic-official:auth-session:cleared", {
      reason,
      partition: EPIC_OFFICIAL_AUTH_PARTITION,
    });
  } catch (err) {
    epicOfficialLogger.warn("epic-official:auth-session:clear-failed", {
      reason,
      error: err?.message || String(err),
    });
  }
}

function waitForEpicAuthCode(parentWindow, authOptions = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let authWindow = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      } catch {}
      fn(value);
    };
    try {
      const loginUrl = buildEpicLoginUrl(authOptions);
      authWindow = new BrowserWindow({
        width: 980,
        height: 720,
        parent:
          parentWindow && !parentWindow.isDestroyed()
            ? parentWindow
            : undefined,
        modal: false,
        show: true,
        title: "Connect Epic",
        webPreferences: {
          partition: EPIC_OFFICIAL_AUTH_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      authWindow.webContents.setUserAgent(EPIC_LAUNCHER_USER_AGENT);
      const handleUrl = (rawUrl) => {
        const result = extractEpicAuthResult(rawUrl);
        if (!result) return;
        if (result.code) {
          settle(resolve, result.code);
        } else {
          settle(reject, new Error(result.error || "epic-auth-failed"));
        }
      };
      const interceptAuthNavigation = (event, url) => {
        const result = extractEpicAuthResult(url);
        if (!result) return;
        event.preventDefault();
        if (result.code) {
          settle(resolve, result.code);
        } else {
          settle(reject, new Error(result.error || "epic-auth-failed"));
        }
      };
      const inspectPageForCode = async () => {
        if (settled || !authWindow || authWindow.isDestroyed()) return;
        try {
          const payload = await authWindow.webContents.executeJavaScript(
            `({
              url: location.href,
              text: document.body ? document.body.innerText : "",
              html: document.documentElement ? document.documentElement.outerHTML : ""
            })`,
            true,
          );
          handleUrl(payload?.url);
          handleUrl(payload?.text);
          handleUrl(payload?.html);
        } catch {}
      };
      authWindow.webContents.on("will-navigate", interceptAuthNavigation);
      authWindow.webContents.on("will-redirect", interceptAuthNavigation);
      authWindow.webContents.on("did-navigate", (_event, url) =>
        handleUrl(url),
      );
      authWindow.webContents.on("did-navigate-in-page", (_event, url) =>
        handleUrl(url),
      );
      authWindow.webContents.on("dom-ready", inspectPageForCode);
      authWindow.webContents.on("did-finish-load", inspectPageForCode);
      authWindow.on("closed", () => {
        authWindow = null;
        if (!settled) reject(new Error("epic-auth-cancelled"));
      });
      authWindow.loadURL(loginUrl).catch((err) => {
        settle(reject, err);
      });
    } catch (err) {
      settle(reject, err);
    }
  });
}

ipcMain.handle("epic-official:status", async () => {
  try {
    const status = await getEpicAuthStatus(getEpicAuthRequestOptions());
    const { tokensFile: _tokensFile, ...safeStatus } = status;
    return { success: true, ...safeStatus };
  } catch (err) {
    epicOfficialLogger.warn("epic-official:status-failed", {
      error: err?.message || String(err),
    });
    return {
      success: false,
      connected: false,
      error: err?.message || String(err),
    };
  }
});

ipcMain.handle("epic-official:connect", async (event) => {
  try {
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const authOptions = getEpicAuthRequestOptions({
      timeoutMs: 15000,
    });
    await clearEpicOfficialAuthSession("connect");
    const code = await waitForEpicAuthCode(parent, authOptions);
    const token = await authenticateEpicWithCode(code, authOptions);
    const accountId = normalizeEpicAccountId(token?.account_id);
    if (accountId) {
      updatePreferences({ epicOfficialAccountId: accountId });
    }
    const status = await getEpicAuthStatus(getEpicAuthRequestOptions());
    const { tokensFile: _tokensFile, ...safeStatus } = status;
    epicOfficialLogger.info("epic-official:connect-success", {
      accountId: status.accountId || null,
    });
    return { success: true, ...safeStatus };
  } catch (err) {
    epicOfficialLogger.warn("epic-official:connect-failed", {
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("epic-official:disconnect", async () => {
  try {
    stopEpicOfficialActivePoll("disconnect");
    clearEpicOfficialRuntimeState("disconnect");
    await clearEpicTokens({ userDataDir: app.getPath("userData") });
    await clearEpicOfficialAuthSession("disconnect");
    updatePreferences({ epicOfficialAccountId: "" });
    epicOfficialLogger.info("epic-official:disconnect-success");
    return { success: true, connected: false };
  } catch (err) {
    epicOfficialLogger.warn("epic-official:disconnect-failed", {
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
});

async function seedEpicOfficialImportCaches(imported = [], options = {}) {
  const entries = Array.isArray(imported)
    ? imported.filter((entry) => entry?.name && entry?.appid)
    : [];
  const stats = {
    total: entries.length,
    seeded: 0,
    unchanged: 0,
    skipped: 0,
    blacklistedSkipped: 0,
    skippedExistingCache: 0,
    failed: 0,
  };
  if (!entries.length) return stats;

  const accountId = normalizeEpicAccountId(options?.accountId);
  let token = options?.token || null;
  const timeoutMs =
    Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : 15000;
  const onProgress =
    typeof options?.onProgress === "function" ? options.onProgress : null;
  const concurrency = Math.max(
    1,
    Math.min(4, Number(options?.concurrency || 3) || 3),
  );
  let index = 0;

  epicOfficialLogger.info("epic-official:import-cache-seed:start", {
    total: stats.total,
    accountId: accountId || null,
    concurrency,
  });

  let refreshTokenInFlight = null;
  const isUnauthorizedEpicOfficialSyncError = (err) =>
    /(?:status code|HTTP)\s*401\b|\b401\b/i.test(
      String(err?.message || err || ""),
    );
  const refreshEpicOfficialSeedToken = async (reason = "401") => {
    if (!refreshTokenInFlight) {
      epicOfficialLogger.info("epic-official:import-cache-seed:token-refresh", {
        reason,
        accountId: accountId || null,
      });
      refreshTokenInFlight = ensureEpicAccessToken(
        getEpicAuthRequestOptions({
          timeoutMs,
          forceRefresh: true,
        }),
      )
        .then((refreshed) => {
          token = refreshed;
          return refreshed;
        })
        .finally(() => {
          refreshTokenInFlight = null;
        });
    }
    return refreshTokenInFlight;
  };
  const syncEpicOfficialSeedWithAuthRetry = async (
    config,
    syncOptions,
    entry,
  ) => {
    try {
      return await syncEpicOfficialAchievements(config, syncOptions);
    } catch (err) {
      if (!isUnauthorizedEpicOfficialSyncError(err)) throw err;
      const refreshed = await refreshEpicOfficialSeedToken("sync-401");
      const retryOptions = getEpicAuthRequestOptions({
        ...syncOptions,
        token: refreshed,
        accountId:
          syncOptions?.accountId ||
          normalizeEpicAccountId(refreshed?.account_id) ||
          "",
      });
      epicOfficialLogger.info("epic-official:import-cache-seed:retry", {
        configName: sanitizeConfigName(entry?.name || "") || null,
        appid: entry?.appid || null,
        reason: "sync-401",
      });
      return await syncEpicOfficialAchievements(config, retryOptions);
    }
  };

  const worker = async (entry) => {
    const current = ++index;
    const safeName = sanitizeConfigName(entry?.name || "");
    onProgress?.({
      phase: "seedingCache",
      detail: entry?.title || safeName || "Epic Official",
      appid: entry?.appid || "",
      current,
      total: stats.total,
      percent: 90 + Math.round((current / Math.max(stats.total, 1)) * 9),
    });
    if (!safeName) {
      stats.skipped += 1;
      return;
    }
    if (isAppIdBlacklisted(entry?.appid, "epic-official")) {
      stats.skipped += 1;
      stats.blacklistedSkipped += 1;
      epicOfficialLogger.info(
        "epic-official:import-cache-seed:skip-blacklisted",
        {
          configName: safeName,
          appid: entry?.appid || null,
        },
      );
      return;
    }

    try {
      const configPath = path.join(configsDir, `${safeName}.json`);
      if (!fs.existsSync(configPath)) {
        stats.skipped += 1;
        return;
      }
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (normalizePlatform(config?.platform) !== "epic-official") {
        stats.skipped += 1;
        return;
      }
      const configProductId = String(
        config?.epic_product_id ||
          config?.epicProductId ||
          config?.appid ||
          entry?.appid ||
          "",
      ).trim();
      if (isAppIdBlacklisted(configProductId, "epic-official")) {
        stats.skipped += 1;
        stats.blacklistedSkipped += 1;
        epicOfficialLogger.info(
          "epic-official:import-cache-seed:skip-blacklisted",
          {
            configName: safeName,
            appid: configProductId || null,
          },
        );
        return;
      }
      const schemaPath = resolveAchievementsSchemaPath(config);
      if (!schemaPath || !fs.existsSync(schemaPath)) {
        stats.skipped += 1;
        return;
      }
      let schemaAchievements = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        if (Array.isArray(parsed)) schemaAchievements = parsed;
      } catch {}
      if (!schemaAchievements.length) {
        stats.skipped += 1;
        return;
      }

      let productId = String(
        config?.epic_product_id ||
          config?.epicProductId ||
          config?.appid ||
          entry?.appid ||
          "",
      ).trim();
      try {
        const sidecarPath = path.join(
          path.dirname(schemaPath),
          "achievementpercentages.json",
        );
        if (fs.existsSync(sidecarPath)) {
          const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          if (sidecar?.appid) productId = String(sidecar.appid).trim();
        }
      } catch {}
      const resolvedAccountId =
        accountId || resolvePreferredEpicOfficialAccountId(config, token);
      const cached =
        (await loadPreviousAchievements(safeName, "epic-official", {
          accountId: resolvedAccountId,
        })) || {};
      if (
        entry?.skippedUnchanged === true &&
        cached &&
        typeof cached === "object" &&
        Object.keys(cached).length > 0
      ) {
        stats.skippedExistingCache += 1;
        return;
      }
      const syncOptions = getEpicAuthRequestOptions({
        token,
        accountId: resolvedAccountId,
        productId,
        schemaAchievements,
        timeoutMs,
      });
      const synced = await syncEpicOfficialSeedWithAuthRetry(
        config,
        syncOptions,
        entry,
      );
      const nextAccountId = synced.accountId || resolvedAccountId || "";
      const nextProductId = synced.productId || productId || "";
      const snapshot = mergeEarnedTimeFromCached(synced.snapshot || {}, cached);
      const result = {
        achievements: snapshot || {},
        save_path: config.save_path || "",
      };
      markEpicOfficialRecentLoadSync(
        safeName,
        nextAccountId,
        nextProductId,
        result,
      );
      if (deepEqual(cached || {}, snapshot || {})) {
        stats.unchanged += 1;
        return;
      }
      const saved = savePreviousAchievements(
        safeName,
        snapshot,
        "epic-official",
        { accountId: nextAccountId },
      );
      if (saved) stats.seeded += 1;
      else stats.unchanged += 1;
    } catch (err) {
      stats.failed += 1;
      epicOfficialLogger.warn("epic-official:import-cache-seed:failed", {
        configName: safeName || null,
        appid: entry?.appid || null,
        error: err?.message || String(err),
      });
    }
  };

  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, entries.length) },
    async () => {
      while (nextIndex < entries.length) {
        const entry = entries[nextIndex++];
        await worker(entry);
      }
    },
  );
  await Promise.all(runners);

  epicOfficialLogger.info("epic-official:import-cache-seed:summary", stats);
  return stats;
}

ipcMain.handle("epic-official:import-library", async () => {
  let progressJob = null;
  try {
    const token = await ensureEpicAccessToken(
      getEpicAuthRequestOptions({
        timeoutMs: 15000,
      }),
    );
    const accountId = normalizeEpicAccountId(token?.account_id);
    progressJob = createGenerationProgressJob({
      kind: "config-generate",
      scope: "batch",
      status: "running",
      itemName: "Epic Official",
      appid: "",
      phase: "fetchingLibrary",
      detail: "Fetching Epic library",
      current: 0,
      total: 0,
      percent: 5,
    });
    const result = await importEpicOfficialLibrary(
      configsDir,
      getEpicAuthRequestOptions({
        token,
        accountId,
        schemaRootDir: SCHEMA_ROOT_PATH,
        timeoutMs: 15000,
        isTitleBlacklisted: (productId, platform) =>
          isAppIdBlacklisted(productId, platform || "epic-official"),
        onProgress: (progress = {}) => {
          progressJob?.update({
            itemName: progress?.itemName || progress?.detail || "Epic Official",
            appid: progress?.appid || "",
            phase: progress?.phase || "importingLibrary",
            detail: progress?.detail || "",
            current:
              Number.isFinite(Number(progress?.current)) &&
              Number(progress.current) >= 0
                ? Number(progress.current)
                : 0,
            total:
              Number.isFinite(Number(progress?.total)) &&
              Number(progress.total) >= 0
                ? Number(progress.total)
                : 0,
            percent: clampGenerationPercent(progress?.percent, 5),
          });
        },
      }),
    );
    const cacheSeed = await seedEpicOfficialImportCaches(result?.imported, {
      token,
      accountId: result?.accountId || accountId,
      timeoutMs: 15000,
      onProgress: (progress = {}) => {
        progressJob?.update({
          itemName: progress?.detail || "Epic Official",
          appid: progress?.appid || "",
          phase: progress?.phase || "seedingCache",
          detail: progress?.detail || "Seeding Epic Official cache",
          current:
            Number.isFinite(Number(progress?.current)) &&
            Number(progress.current) >= 0
              ? Number(progress.current)
              : 0,
          total:
            Number.isFinite(Number(progress?.total)) &&
            Number(progress.total) >= 0
              ? Number(progress.total)
              : 0,
          percent: clampGenerationPercent(progress?.percent, 90),
        });
      },
    });
    notifyConfigsChanged();
    progressJob?.succeed({
      phase: "completed",
      detail: "Epic library imported",
      current: result?.totalAssets || 0,
      total: result?.totalAssets || 0,
      percent: 100,
    });
    epicOfficialLogger.info("epic-official:import-library-success", {
      accountId: result?.accountId || accountId || null,
      totalAssets: result?.totalAssets || 0,
      entitlementsTotal: result?.entitlementsTotal || 0,
      libraryAssetsTotal: result?.libraryAssetsTotal || 0,
      ownedGamesTotal: result?.ownedGamesTotal || 0,
      created: result?.created || 0,
      updated: result?.updated || 0,
      skipped: result?.skipped || 0,
      blacklistedSkipped: result?.blacklistedSkipped || 0,
      skippedUnchanged: result?.skippedUnchanged || 0,
      skippedNoAchievementsCached: result?.skippedNoAchievementsCached || 0,
      withoutAchievements: result?.withoutAchievements || 0,
      failed: result?.failed || 0,
      schemaChecked: result?.schemaChecked || 0,
      existingSchemaSkipped: result?.existingSchemaSkipped || 0,
      imageSkippedExisting: result?.imageSkippedExisting || 0,
      localInstallUpdated: result?.localInstallUpdated || 0,
      importMetaUpdated: result?.importMetaUpdated === true,
      cacheSeed,
    });
    return {
      success: true,
      message: `Epic library imported. Created ${result.created}, updated ${result.updated}, unchanged ${result.skippedUnchanged || 0}, skipped ${result.withoutAchievements} without achievements and ${result.blacklistedSkipped || 0} blacklisted.`,
      cacheSeed,
      ...result,
    };
  } catch (err) {
    progressJob?.fail({
      phase: "failed",
      detail: err?.message || "Epic library import failed",
    });
    epicOfficialLogger.warn("epic-official:import-library-failed", {
      error: err?.message || String(err),
    });
    return {
      success: false,
      message: err?.message || "Epic library import failed.",
    };
  }
});

ipcMain.handle("blacklist:check", async (_event, appid) => {
  const payload =
    appid && typeof appid === "object" && !Array.isArray(appid) ? appid : {};
  const rawAppId =
    typeof appid === "string" || typeof appid === "number"
      ? appid
      : payload?.appid;
  const normalized = normalizeAppIdValue(rawAppId);
  const match = normalized
    ? getBlacklistMatch(normalized, payload?.platform || null)
    : getBlacklistMatch(null, payload?.platform || null);
  return {
    appid: normalized,
    platform: payload?.platform || null,
    blacklisted: match.effective,
    global: match.global,
    scoped: match.scoped,
    configKey: match.configKey,
  };
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
  syncSanPresetSoundsToUserSounds();
  if (!fs.existsSync(userSoundsFolder)) return [];
  const files = fs
    .readdirSync(userSoundsFolder)
    .filter((file) => isSupportedNotificationSoundFile(file));
  return files;
});

const XBOX_PC_AUTH_PARTITION = "persist:xbox-pc-microsoft-auth";

async function clearXboxPcAuthSession(reason = "unknown") {
  try {
    const authSession = session.fromPartition(XBOX_PC_AUTH_PARTITION);
    await authSession.clearStorageData({
      storages: [
        "cookies",
        "localstorage",
        "indexdb",
        "serviceworkers",
        "cachestorage",
      ],
    });
    try {
      await authSession.clearCache();
    } catch {}
    xboxPcLogger.info("xbox-pc:auth-session-cleared", { reason });
  } catch (error) {
    xboxPcLogger.warn("xbox-pc:auth-session-clear-failed", {
      reason,
      error: error?.message || String(error),
    });
  }
}

function waitForXboxPcAuthCode(parentWindow, clientId) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(24).toString("hex");
    let settled = false;
    let authWindow = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      } catch {}
      fn(value);
    };
    try {
      const loginUrl = buildXboxDirectAuthorizeUrl(clientId, state);
      authWindow = new BrowserWindow({
        width: 980,
        height: 720,
        parent:
          parentWindow && !parentWindow.isDestroyed()
            ? parentWindow
            : undefined,
        modal: false,
        show: true,
        title: "Connect Microsoft / Xbox Network",
        webPreferences: {
          partition: XBOX_PC_AUTH_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const handleUrl = (url) => {
        const result = extractXboxDirectAuthResult(url, state);
        if (!result) return false;
        if (result.tokens || result.code) settle(resolve, result);
        else settle(reject, new Error(result.error || "xbox-pc-oauth-failed"));
        return true;
      };
      const interceptNavigation = (event, url) => {
        if (handleUrl(url)) event.preventDefault();
      };
      authWindow.webContents.on("will-navigate", interceptNavigation);
      authWindow.webContents.on("will-redirect", interceptNavigation);
      authWindow.webContents.on("did-navigate", (_event, url) =>
        handleUrl(url),
      );
      authWindow.webContents.on("did-navigate-in-page", (_event, url) =>
        handleUrl(url),
      );
      authWindow.on("closed", () => {
        authWindow = null;
        if (!settled) reject(new Error("xbox-pc-auth-cancelled"));
      });
      authWindow.loadURL(loginUrl).catch((error) => settle(reject, error));
    } catch (error) {
      settle(reject, error);
    }
  });
}

ipcMain.handle("xbox-pc:status", async () => {
  const status = await getXboxPcStatus({
    userDataDir: app.getPath("userData"),
    timeoutMs: 15000,
  });
  return { success: status.connected === true, ...status };
});

ipcMain.handle("xbox-pc:connect", async (event) => {
  try {
    await clearXboxPcAuthSession("connect-start");
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const authResult = await waitForXboxPcAuthCode(
      parentWindow,
      XBOX_PC_CLIENT_ID,
    );
    await completeXboxDirectAuthentication(
      app.getPath("userData"),
      authResult,
    );
    const status = await getXboxPcStatus({
      userDataDir: app.getPath("userData"),
      timeoutMs: 15000,
    });
    if (!status.connected) {
      return {
        success: false,
        error: status.error || "Xbox Network account validation failed.",
      };
    }
    xboxPcLogger.info("xbox-pc:connect-success", {
      xuid: status.xuid || null,
      gamertag: status.gamertag || null,
    });
    return { success: true, ...status };
  } catch (error) {
    const authError = getXboxPcAuthErrorInfo(error);
    xboxPcLogger.warn("xbox-pc:connect-failed", {
      error: error?.message || String(error),
      ...authError,
    });
    const diagnostic = [
      authError.stage ? `stage ${authError.stage}` : "",
      authError.statusCode ? `HTTP ${authError.statusCode}` : "",
      authError.xerr ? `XErr ${authError.xerr}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      success: false,
      error: diagnostic
        ? `Xbox authentication failed (${diagnostic}).`
        : error?.message || String(error),
    };
  }
});

ipcMain.handle("xbox-pc:disconnect", async () => {
  try {
    stopXboxPcActivePoll("disconnect");
    await clearXboxDirectAuth(app.getPath("userData"));
    await clearXboxPcAuthSession("disconnect");
    xboxPcLogger.info("xbox-pc:disconnect-success");
    return { success: true, connected: false, configured: false };
  } catch (error) {
    xboxPcLogger.warn("xbox-pc:disconnect-failed", {
      error: error?.message || String(error),
    });
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("xbox-pc:import-library", async () => {
  let progressJob = null;
  try {
    progressJob = createGenerationProgressJob({
      kind: "config-generate",
      scope: "batch",
      status: "running",
      itemName: "Xbox PC",
      appid: "",
      phase: "fetchingLibrary",
      detail: "Fetching Xbox PC achievement history",
      current: 0,
      total: 0,
      percent: 5,
    });
    const result = await importXboxPcLibrary(configsDir, {
      userDataDir: app.getPath("userData"),
      schemaRootDir: SCHEMA_ROOT_PATH,
      schemaLanguages: getSchemaLanguagesFromPreferences(),
      timeoutMs: 15000,
      isTitleBlacklisted: (titleId, platform) =>
        isAppIdBlacklisted(titleId, platform || "xbox-pc"),
      onProgress: (progress = {}) => {
        progressJob?.update({
          itemName: progress.detail || "Xbox PC",
          appid: progress.appid || "",
          phase: "importingLibrary",
          detail: progress.detail || "",
          current: Number(progress.current) || 0,
          total: Number(progress.total) || 0,
          percent: clampGenerationPercent(progress.percent, 5),
        });
      },
    });
    for (const entry of result.imported || []) {
      savePreviousAchievements(entry.name, entry.snapshot || {}, "xbox-pc");
    }
    notifyConfigsChanged();
    progressJob?.succeed({
      phase: "completed",
      detail: "Xbox PC library imported",
      current: result.pcTitles || 0,
      total: result.pcTitles || 0,
      percent: 100,
    });
    return {
      success: true,
      message:
        `Xbox PC import complete. Created ${result.created}, updated ` +
        `${result.updated}, skipped ${result.skipped}, failed ${result.failed}.`,
      ...result,
    };
  } catch (error) {
    progressJob?.fail({
      phase: "failed",
      detail: error?.message || "Xbox PC import failed",
    });
    xboxPcLogger.warn("xbox-pc:import-library-failed", {
      error: error?.message || String(error),
    });
    return {
      success: false,
      message: error?.message || "Xbox PC library import failed.",
    };
  }
});

ipcMain.handle("get-sound-path", (_event, fileName) => {
  const sanSoundPath = resolveSanSoundPath(fileName);
  if (sanSoundPath) {
    return `file://${sanSoundPath.replace(/\\/g, "/")}`;
  }
  const fullPath = path.join(app.getPath("userData"), "sounds", fileName);
  return `file://${fullPath.replace(/\\/g, "/")}`;
});

ipcMain.handle("load-san-presets", () => {
  syncSanPresetSoundsToUserSounds();
  return {
    folder: getSanPresetsFolder(),
    presets: listSanPresets(),
  };
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

ipcMain.on("app-navigation:ready", (event) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender?.id !== mainWindow.webContents?.id
  ) {
    return;
  }
  appNavigationRendererReady = true;
  appLogger.info("app-navigation:renderer-ready");
  flushPendingAppNavigationRoute();
});

ipcMain.on("app-navigation:result", (event, payload = {}) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender?.id !== mainWindow.webContents?.id
  ) {
    return;
  }
  const success = payload?.success === true;
  const resultConfigName = String(payload?.configName || "").trim();
  const meta = {
    requestId: String(payload?.requestId || ""),
    success,
    configName: resultConfigName
      ? sanitizeConfigName(resultConfigName)
      : null,
    achievementId: String(payload?.achievementId || "").slice(0, 256) || null,
    reason: String(payload?.reason || "").slice(0, 128) || null,
  };
  if (success) appLogger.info("app-navigation:completed", meta);
  else appLogger.warn("app-navigation:renderer-failed", meta);
});

ipcMain.on("overlay:navigation-ready", (event) => {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    event.sender?.id !== overlayWindow.webContents?.id
  ) {
    return;
  }
  overlayNavigationRendererReadyWebContentsId = event.sender.id;
  notificationLogger.info("notification-navigation:overlay-renderer-ready", {
    webContentsId: event.sender.id,
  });
  flushPendingOverlayNotificationNavigation();
});

ipcMain.on("overlay:navigation-result", (event, payload = {}) => {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    event.sender?.id !== overlayWindow.webContents?.id
  ) {
    return;
  }
  const pending = pendingOverlayNotificationNavigation;
  const requestId = String(payload?.requestId || "");
  if (!pending || !requestId || requestId !== pending.requestId) {
    notificationLogger.info("notification-navigation:overlay-result-stale", {
      requestId: requestId || null,
      pendingRequestId: pending?.requestId || null,
    });
    return;
  }

  const success = payload?.success === true;
  const meta = {
    requestId,
    success,
    configName: sanitizeConfigName(
      String(payload?.configName || pending.configName || ""),
    ),
    achievementId:
      String(payload?.achievementId || pending.achievementId || "").slice(
        0,
        256,
      ) || null,
    reason: String(payload?.reason || "").slice(0, 128) || null,
  };
  pendingOverlayNotificationNavigation = null;
  if (success) {
    notificationLogger.info(
      "notification-navigation:overlay-renderer-complete",
      meta,
    );
  } else {
    notificationLogger.warn(
      "notification-navigation:overlay-renderer-failed",
      meta,
    );
  }
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
  const cfgPath = resolveConfigJsonPath(configsDir, configName);
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
  const cfgPath = resolveConfigJsonPath(configsDir, configName);
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return isLumaPlayConfig(data);
  } catch {
    return false;
  }
}

function readCacheSilent(configName, platform = "steam", options = null) {
  const cachePath = getCachePath(configName, platform, options);
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

function mergeManualAchievementOverrides(snapshot, cached) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const cache = cached && typeof cached === "object" ? cached : {};
  let changed = false;
  const merged = { ...source };
  for (const [key, cacheEntry] of Object.entries(cache)) {
    if (!cacheEntry || typeof cacheEntry !== "object") continue;
    if (cacheEntry.manual !== true || cacheEntry.earned !== true) continue;
    const nextEntry = merged[key];
    const nextEarned =
      nextEntry && typeof nextEntry === "object"
        ? nextEntry.earned === true || nextEntry.earned === 1
        : false;
    if (!nextEarned) {
      merged[key] = {
        ...(nextEntry && typeof nextEntry === "object" ? nextEntry : {}),
        ...cacheEntry,
        earned: true,
        manual: true,
      };
      changed = true;
      continue;
    }
    const nextManual = nextEntry?.manual === true;
    const nextTime = nextEntry?.earned_time ?? 0;
    const cacheTime = cacheEntry.earned_time ?? 0;
    if (!nextManual || (!nextTime && cacheTime)) {
      merged[key] = {
        ...cacheEntry,
        ...(nextEntry && typeof nextEntry === "object" ? nextEntry : {}),
        earned: true,
        manual: true,
        earned_time: nextTime || cacheTime || Date.now(),
      };
      changed = true;
    }
  }
  return changed ? merged : source;
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
      process_name: hasProcessNameValue(config.process_name, {
        splitString: true,
      })
        ? normalizeProcessNameValue(config.process_name, { splitString: true })
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
    if (isAppIdBlacklisted(sanitizedAppId, payload.platform)) {
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
      const progressJob = createGenerationProgressJob({
        kind: "config-generate",
        scope: "single",
        status: "running",
        itemName: String(
          payload.displayName || payload.name || payload.appid || "",
        ).trim(),
        appid: String(payload.appid || ""),
        phase: "preparing",
        detail: "Preparing config generation",
        current: 0,
        total: 0,
        percent: 5,
      });

      const reply = {
        success: true,
        message: tUi("main.message.configSavedGenerating"),
        schemaReady: false,
        config_path: null,
        save_path: payload.save_path || null,
      };

      (async () => {
        try {
          const res = await ensureSchemaForApp(
            payload.appid,
            payload.platform,
            {
              ...payload,
              onGenerationProgress: (progress) => {
                progressJob.update({
                  itemName:
                    progress?.itemName ||
                    payload.displayName ||
                    payload.name ||
                    payload.appid,
                  appid: progress?.appid || payload.appid,
                  phase: progress?.phase || "generatingSchema",
                  detail: progress?.detail || "",
                  current:
                    Number.isFinite(Number(progress?.current)) &&
                    Number(progress.current) >= 0
                      ? Number(progress.current)
                      : 0,
                  total:
                    Number.isFinite(Number(progress?.total)) &&
                    Number(progress.total) >= 0
                      ? Number(progress.total)
                      : 0,
                  percent: clampGenerationPercent(progress?.percent, 5),
                });
              },
            },
          );
          if (res?.dir) {
            try {
              const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
              if (curr.config_path !== res.dir) {
                curr.config_path = res.dir;
              }
              if (normalizePlatform(curr.platform) === "epic-official") {
                if (res.productId) curr.epic_product_id = res.productId;
                if (res.sandboxId) curr.epic_namespace = res.sandboxId;
              }
              fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
            } catch (e) {
              notifyError(
                tUi("main.notify.schema.persistConfigPathFailed", {
                  error: e.message,
                }),
              );
            }

            progressJob.update({
              phase: "finalizing",
              detail: "Refreshing config",
              percent: 96,
            });
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
            progressJob.succeed({
              phase: "completed",
              detail: "Config created",
              percent: 100,
            });
          } else {
            progressJob.fail({
              phase: "failed",
              detail: "Achievements schema file was not generated",
            });
          }
        } catch (e) {
          console.warn(
            `Generate schema failed for ${payload.appid}: ${e.message}`,
          );
          progressJob.fail({
            phase: "failed",
            detail: e?.message || "Schema generation failed",
          });
          notifyError(
            tUi("main.notify.schema.generateFailed", { error: e.message }),
          );
          ipcLogger.error("saveConfig:schema-generation-failed", {
            appid: payload.appid,
            error: e.message,
          });
        }
      })();
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
      const mapping = raw?.appid
        ? uplayToSteam.get(String(raw.appid).trim())
        : null;
      const inferredPlatform =
        inferOfficialPlatformFromMarkers(raw) ||
        inferPlatformAndSteamId({ config: raw, mapping }).platform;
      let platformNorm = normalizePlatform(inferredPlatform || raw?.platform);
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
      const looksGogOfficial =
        platformNorm === "gog-official" ||
        (typeof raw?.config_path === "string" &&
          raw.config_path
            .toLowerCase()
            .includes(
              `${path.sep}schema${path.sep}gog-official${path.sep}`.toLowerCase(),
            ));
      const looksUbisoftOfficial =
        platformNorm === "ubisoft-official" ||
        (typeof raw?.config_path === "string" &&
          raw.config_path
            .toLowerCase()
            .includes(
              `${path.sep}schema${path.sep}ubisoft-official${path.sep}`.toLowerCase(),
            ));
      const looksEaOfficial =
        platformNorm === "ea-official" ||
        (typeof raw?.config_path === "string" &&
          raw.config_path
            .toLowerCase()
            .includes(
              `${path.sep}schema${path.sep}ea-official${path.sep}`.toLowerCase(),
            ));
      const looksEpicOfficial =
        platformNorm === "epic-official" ||
        (typeof raw?.config_path === "string" &&
          raw.config_path
            .toLowerCase()
            .includes(
              `${path.sep}schema${path.sep}epic-official${path.sep}`.toLowerCase(),
            ));
      meta.platform = platformNorm || null;
      if (platformNorm && raw?.platform !== platformNorm) {
        raw.platform = platformNorm;
        try {
          fs.writeFileSync(fullPath, JSON.stringify(raw, null, 2));
        } catch {}
      }
      if (raw?.displayName) {
        meta.displayName =
          getSafeLocalizedText(raw.displayName, lang) || raw.name || baseName;
      } else if (raw?.name) {
        meta.displayName = raw.name;
      }
      if (looksSteamOfficial) {
        meta.platform = "steam-official";
      }
      if (looksGogOfficial) {
        meta.platform = "gog-official";
      }
      if (looksUbisoftOfficial) {
        meta.platform = "ubisoft-official";
      }
      if (looksEaOfficial) {
        meta.platform = "ea-official";
      }
      if (looksEpicOfficial) {
        meta.platform = "epic-official";
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
        meta.blacklisted = isAppIdBlacklisted(meta.appid, meta.platform);
      }
      if (raw?.executable) {
        meta.executable = raw.executable;
      }
      if (raw?.arguments !== undefined) {
        meta.arguments = raw.arguments;
      }
      if (raw && Object.prototype.hasOwnProperty.call(raw, "process_name")) {
        meta.process_name = normalizeProcessNameValue(raw.process_name);
      }
      if (raw?.gog_client_id || raw?.gogClientId) {
        meta.gog_client_id = raw.gog_client_id || raw.gogClientId;
      }
      if (raw?.gog_user_id || raw?.gogUserId) {
        meta.gog_user_id = raw.gog_user_id || raw.gogUserId;
      }
      if (raw?.gog_gameplay_db || raw?.gogGameplayDb) {
        meta.gog_gameplay_db = raw.gog_gameplay_db || raw.gogGameplayDb;
      }
      if (raw?.epic_product_id || raw?.epicProductId) {
        meta.epic_product_id = raw.epic_product_id || raw.epicProductId;
      }
      if (raw?.epic_catalog_item_id || raw?.epicCatalogItemId) {
        meta.epic_catalog_item_id =
          raw.epic_catalog_item_id || raw.epicCatalogItemId;
      }
      if (raw?.epic_namespace || raw?.epicNamespace) {
        meta.epic_namespace = raw.epic_namespace || raw.epicNamespace;
      }
      if (raw?.epic_app_name || raw?.epicAppName) {
        meta.epic_app_name = raw.epic_app_name || raw.epicAppName;
      }
      if (raw?.epic_store_slug || raw?.epicStoreSlug) {
        meta.epic_store_slug = raw.epic_store_slug || raw.epicStoreSlug;
      }
      if (raw?.ea_offer_id || raw?.eaOfferId) {
        meta.ea_offer_id = raw.ea_offer_id || raw.eaOfferId;
      }
      if (
        raw?.ps_content_id ||
        raw?.psContentId ||
        raw?.content_id ||
        raw?.contentId ||
        raw?.playstation_content_id ||
        raw?.playstationContentId
      ) {
        meta.ps_content_id =
          raw.ps_content_id ||
          raw.psContentId ||
          raw.content_id ||
          raw.contentId ||
          raw.playstation_content_id ||
          raw.playstationContentId;
      }
      if (
        raw?.ps_store_url ||
        raw?.psStoreUrl ||
        raw?.playstation_store_url ||
        raw?.playstationStoreUrl
      ) {
        meta.ps_store_url =
          raw.ps_store_url ||
          raw.psStoreUrl ||
          raw.playstation_store_url ||
          raw.playstationStoreUrl;
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

function normalizeExophaseRarityPct(value) {
  const normalized = normalizeRarityPercent(value);
  if (normalized !== null) return Number(normalized.toFixed(4));
  if (typeof value !== "string") return null;
  const match = value.replace(",", ".").trim().match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed)
    ? Number(Math.min(100, Math.max(0, parsed)).toFixed(4))
    : null;
}

function normalizeExophaseMatchText(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildExophaseMatchKey(title, description) {
  const t = normalizeExophaseMatchText(title);
  if (!t) return "";
  const d = normalizeExophaseMatchText(description);
  return `${t}|${d}`;
}

function getSchemaLocalizedTextForRarity(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (value && typeof value === "object") {
    return (
      String(value.english || "").trim() ||
      Object.values(value)
        .map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : ""))
        .find(Boolean) ||
      ""
    );
  }
  return "";
}

function getConfigTitleForExophaseRarity(config = {}, fallback = "") {
  const raw =
    getSafeLocalizedText(config?.displayName, "english") ||
    getSchemaLocalizedTextForRarity(config?.displayName) ||
    config?.name ||
    fallback ||
    "";
  return String(raw || "")
    .replace(/\((?:Xenia|RPCS3|PS4|shadps4)\)\s*$/i, "")
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildExophaseRaritySlugCandidates(config = {}, platform = "") {
  const title = getConfigTitleForExophaseRarity(
    config,
    config?.appid != null ? String(config.appid).trim() : "",
  );
  const variants = buildExophaseSlugVariants(title);
  if (platform === "shadps4") {
    return Array.from(
      new Set([
        ...variants,
        ...variants.map((slug) => `${slug}-ps4`),
      ]),
    );
  }
  if (platform !== "rpcs3") return variants;
  return Array.from(
    new Set([
      ...variants,
      ...variants.map((slug) => `${slug}-ps3`),
      ...variants.map((slug) => `${slug}-psn`),
    ]),
  );
}

function buildExophaseRarityMatchMaps(items = []) {
  const keyMap = new Map();
  const keyDupes = new Set();
  const titleMap = new Map();
  const titleDupes = new Set();
  const register = (map, dupes, key, item) => {
    if (!key) return;
    const previous = map.get(key);
    if (previous && previous !== item) {
      dupes.add(key);
      return;
    }
    map.set(key, item);
  };

  for (const item of Array.isArray(items) ? items : []) {
    const titles = item?.titles || {};
    const descriptions = item?.descriptions || {};
    for (const langKey of Object.keys(titles)) {
      const title = titles[langKey] || "";
      const description = descriptions[langKey] || "";
      register(
        keyMap,
        keyDupes,
        buildExophaseMatchKey(title, description),
        item,
      );
      register(
        titleMap,
        titleDupes,
        normalizeExophaseMatchText(title),
        item,
      );
    }
  }
  return { keyMap, keyDupes, titleMap, titleDupes };
}

function mergeExophaseRarityIntoSchema(schemaAchievements = [], items = []) {
  const { keyMap, keyDupes, titleMap, titleDupes } =
    buildExophaseRarityMatchMaps(items);
  const sidecarEntries = [];
  let updated = false;
  let matched = 0;
  const seen = new Set();

  for (const entry of Array.isArray(schemaAchievements) ? schemaAchievements : []) {
    if (!entry || typeof entry !== "object") continue;
    const title = getSchemaLocalizedTextForRarity(entry.displayName);
    const description = getSchemaLocalizedTextForRarity(entry.description);
    let match = null;
    const key = buildExophaseMatchKey(title, description);
    if (key && !keyDupes.has(key)) match = keyMap.get(key) || null;
    if (!match) {
      const titleKey = normalizeExophaseMatchText(title);
      if (titleKey && !titleDupes.has(titleKey)) {
        match = titleMap.get(titleKey) || null;
      }
    }
    const percent = normalizeExophaseRarityPct(match?.rarityPct);
    const name =
      typeof entry?.name === "string" || typeof entry?.name === "number"
        ? String(entry.name).trim()
        : "";
    if (!match || percent === null || !name || seen.has(name)) continue;

    matched += 1;
    seen.add(name);
    sidecarEntries.push({ name, percent });
    if (entry.rarityPct !== percent) {
      entry.rarityPct = percent;
      updated = true;
    }
    const source = match.raritySource || EXOPHASE_RARITY_SOURCE;
    if (entry.raritySource !== source) {
      entry.raritySource = source;
      updated = true;
    }
  }

  sidecarEntries.sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
  return { entries: sidecarEntries, matched, updated };
}

async function refreshExophaseRarityForConfig(
  config,
  platform,
  schemaAchievements,
) {
  const appid = config?.appid != null ? String(config.appid).trim() : "";
  const slugCandidates = buildExophaseRaritySlugCandidates(config, platform);
  if (!slugCandidates.length) {
    throw new Error("No Exophase slug candidates could be built.");
  }

  let exoData = null;
  let usedSlug = slugCandidates[0];
  let lastError = null;
  for (const slug of slugCandidates) {
    try {
      exoData = await fetchExophaseAchievementsMultiLang({
        slug,
        platform,
        langKeys: ["english"],
        langMap: EXOPHASE_LANG_MAP,
        logger: rarityLogger,
      });
      usedSlug = slug;
      break;
    } catch (err) {
      lastError = err;
      rarityLogger.warn("rarity:exophase:retry", {
        platform,
        appid,
        slug,
        error: err?.message || String(err),
      });
    }
  }
  if (!exoData) throw lastError || new Error("No working Exophase URL");

  const items = Array.isArray(exoData?.items) ? exoData.items : [];
  const fetchedCount = items.reduce(
    (count, item) =>
      normalizeExophaseRarityPct(item?.rarityPct) !== null ? count + 1 : count,
    0,
  );
  const merged = mergeExophaseRarityIntoSchema(schemaAchievements, items);
  return {
    ...merged,
    fetchedCount,
    usedSlug,
    baseUrl: exoData?.baseUrl || "",
  };
}

function resolveSteamAppIdForRarity(config = {}) {
  const platform = normalizePlatform(config?.platform) || "steam";
  const localAppId = config?.appid != null ? String(config.appid).trim() : "";
  if (platform === "uplay" || platform === "ubisoft-official") {
    let mapping = uplayToSteam.get(localAppId);
    if (!mapping) {
      try {
        hydrateRuntimeMapping(loadRuntimeUplayMap());
        mapping = uplayToSteam.get(localAppId);
      } catch {}
    }
    const steamAppId =
      sanitizeAppId(config?.steamAppId) ||
      (mapping?.steam_appid != null ? String(mapping.steam_appid).trim() : "");
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
    const configPath = resolveConfigJsonPath(configsDir, configName);
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
    // 3) (optional) <cfgDir>/<appid>/achievements.json – auto-generated
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

ipcMain.handle(
  "load-saved-achievements",
  async (_event, configName, options = null) => {
    const requestOptions = normalizeAchievementCacheOptions(options);
    ipcLogger.info("load-saved-achievements:request", {
      configName,
      cacheOnly: requestOptions.cacheOnly === true,
    });
    try {
      const rawName = String(configName || "").trim();
      if (!rawName) {
        ipcLogger.warn("load-saved-achievements:missing-name", { configName });
        return {
          achievements: {},
          save_path: "",
          error: "configName required",
        };
      }
      const seedWaitTimedOut = await waitForBootManualSeedBeforeLoad(15000);
      if (seedWaitTimedOut && !bootManualSeedWaitWarned) {
        bootManualSeedWaitWarned = true;
        ipcLogger.warn("load-saved-achievements:seed-wait-timeout", {
          timeoutMs: 15000,
        });
      }
      const safeName = sanitizeConfigName(configName);
      const configPath = resolveConfigJsonPath(configsDir, configName);
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
        "ubisoft-official",
        "ea-official",
        "gog",
        "gog-official",
        "xbox-pc",
        "epic",
        "epic-official",
        "shadps4",
      ]);
      const getCacheFallback = async () =>
        (await loadPreviousAchievements(configName, normalizedPlatform)) || {};
      const shouldUseCacheFallback = () =>
        cacheFallbackPlatforms.has(normalizedPlatform);
      const applyManualOverridesForReturn = async (
        snapshot,
        cacheOptions = null,
        cachedSnapshot,
      ) => {
        const cached =
          cachedSnapshot !== undefined
            ? cachedSnapshot
            : (await loadPreviousAchievements(
                configName,
                normalizedPlatform,
                cacheOptions,
              )) || {};
        return mergeManualAchievementOverrides(snapshot || {}, cached || {});
      };

      if (normalizedPlatform === "xbox-pc") {
        const cached = await getCacheFallback();
        const titleId = String(
          config?.xbox_title_id || config?.appid || "",
        ).trim();
        const xuid = String(config?.xbox_xuid || "").trim();
        const syncKey = `${xuid}:${titleId}`;
        if (titleId && isAppIdBlacklisted(titleId, "xbox-pc")) {
          return {
            achievements: await applyManualOverridesForReturn(
              cached || {},
              null,
              cached || {},
            ),
            save_path: config.save_path || "",
          };
        }
        const lastSync = Number(xboxPcRecentLoadSync.get(syncKey) || 0);
        const activePollOwnsSync =
          xboxPcActivePollState?.configName === safeName &&
          isXboxPcConfigActiveForPolling(safeName);
        const shouldSync =
          Boolean(titleId && xuid) &&
          !activePollOwnsSync &&
          (safeName === sanitizeConfigName(selectedConfig || "") ||
            !Object.keys(cached || {}).length) &&
          Date.now() - lastSync >= 30000;
        if (!shouldSync) {
          return {
            achievements: await applyManualOverridesForReturn(
              cached || {},
              null,
              cached || {},
            ),
            save_path: config.save_path || "",
          };
        }
        let job = xboxPcLoadSyncInflight.get(syncKey);
        if (!job) {
          job = syncXboxPcAchievements(config, {
            userDataDir: app.getPath("userData"),
            timeoutMs: 15000,
          }).finally(() => {
            xboxPcLoadSyncInflight.delete(syncKey);
          });
          xboxPcLoadSyncInflight.set(syncKey, job);
        }
        try {
          const synced = await job;
          const snapshot = mergeEarnedTimeFromCached(
            synced?.snapshot || {},
            cached || {},
          );
          savePreviousAchievements(safeName, snapshot, "xbox-pc");
          markXboxPcRecentSync(syncKey);
          const statePath = path.join(
            String(config.save_path || ""),
            "achievements.json",
          );
          if (config.save_path) {
            try {
              writeJsonAtomicSync(statePath, snapshot);
            } catch (error) {
              xboxPcLogger.warn("xbox-pc:state-write-failed", {
                configName: safeName,
                error: error?.message || String(error),
              });
            }
          }
          return {
            achievements: await applyManualOverridesForReturn(
              snapshot,
              null,
              snapshot,
            ),
            save_path: config.save_path || "",
          };
        } catch (error) {
          xboxPcLogger.warn("xbox-pc:load-sync-failed", {
            configName: safeName,
            titleId: titleId || null,
            error: error?.message || String(error),
          });
          return {
            achievements: await applyManualOverridesForReturn(
              cached || {},
              null,
              cached || {},
            ),
            save_path: config.save_path || "",
            error: error?.message || String(error),
          };
        }
      }

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
            achievements: await applyManualOverridesForReturn(snapshot),
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
            achievements: await applyManualOverridesForReturn(
              merged || snapshot || {},
              null,
              cached || {},
            ),
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
        const progressPath = resolvePs4ProgressPathForConfig(config);
        const trophyDir = resolvePs4TrophyDirForConfig(config);
        const xmlPath = trophyDir
          ? path.join(trophyDir, "Xml", "TROP.XML")
          : "";
        if (
          (!progressPath || !fs.existsSync(progressPath)) &&
          (!trophyDir || !fs.existsSync(xmlPath))
        ) {
          return {
            achievements: {},
            save_path: progressPath || trophyDir,
            error: "trop xml not found",
          };
        }
        try {
          const ps4Trophy = require("./utils/shadps4-trophy");
          const ps4CacheOptions = {
            appid: config?.appid || "",
            filePath: progressPath || "",
            savePath: progressPath || trophyDir || config?.save_path || "",
            shadps4UserId: getPs4UserIdFromProgressPath(progressPath),
          };
          const previous =
            (await loadPreviousAchievements(
              configName,
              normalizedPlatform,
              ps4CacheOptions,
            )) || {};
          const snapshot =
            progressPath && fs.existsSync(progressPath)
              ? ps4Trophy.buildSnapshotFromPs4ProgressFile(
                  progressPath,
                  previous,
                )
              : (() => {
                  const parsed = ps4Trophy.parsePs4TrophySetDir(trophyDir);
                  parsed.appid = config.appid || parsed.appid;
                  return ps4Trophy.buildSnapshotFromPs4(parsed, previous);
                })();
          return {
            achievements: await applyManualOverridesForReturn(
              snapshot || {},
              ps4CacheOptions,
              previous || {},
            ),
            save_path: progressPath || trophyDir,
          };
        } catch (error) {
          return {
            achievements: {},
            save_path: progressPath || trophyDir,
            error: error.message,
          };
        }
      }

      if (isLumaPlayConfig(config)) {
        const cached =
          (await loadPreviousAchievements(configName, normalizedPlatform)) ||
          {};
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
            achievements: await applyManualOverridesForReturn(
              merged || snapshot || {},
              null,
              cached || {},
            ),
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

      if (normalizedPlatform === "gog-official") {
        const cached =
          (await loadPreviousAchievements(configName, normalizedPlatform)) ||
          {};
        const resolved = resolveGogOfficialGameplayDbForConfig(config);
        const gameplayDbPath = resolved?.gameplayDbPath || "";
        const gameplayDir = resolved?.gameplayDir || config.save_path || "";
        if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
          return {
            achievements: cached || {},
            save_path: gameplayDir,
            error: "gameplay.db not found",
          };
        }
        try {
          const parsed = readGogGameplayDb(gameplayDbPath);
          const snapshot = buildGogOfficialSnapshot(parsed?.achievements || []);
          const merged = mergeEarnedTimeFromCached(snapshot, cached);
          updateAchCacheMetaEntry(
            configName,
            normalizedPlatform,
            gameplayDbPath,
            String(config?.appid || ""),
          );

          const nextClientId =
            resolved?.clientId || config?.gog_client_id || "";
          const nextUserId = resolved?.userId || config?.gog_user_id || "";
          const nextSavePath = gameplayDir || config.save_path || "";
          if (
            nextSavePath !== config.save_path ||
            nextClientId !== (config?.gog_client_id || "") ||
            nextUserId !== (config?.gog_user_id || "") ||
            gameplayDbPath !== (config?.gog_gameplay_db || "")
          ) {
            config.save_path = nextSavePath;
            config.gog_client_id = nextClientId;
            config.gog_user_id = nextUserId;
            config.gog_gameplay_db = gameplayDbPath;
            try {
              fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            } catch {}
          }

          return {
            achievements: await applyManualOverridesForReturn(
              merged || snapshot || {},
              null,
              cached || {},
            ),
            save_path: nextSavePath,
          };
        } catch (error) {
          return {
            achievements: cached || {},
            save_path: gameplayDir,
            error: error?.message || "gameplay db read failed",
          };
        }
      }

      if (normalizedPlatform === "epic-official") {
        const cached =
          (await loadPreviousAchievements(
            configName,
            normalizedPlatform,
            null,
          )) || {};
        if (requestOptions.cacheOnly === true) {
          const cacheCount = Object.keys(cached || {}).length;
          if (shouldLogEpicOfficialCacheOnly(configName, cacheCount)) {
            epicOfficialLogger.info?.(
              "load-saved-achievements:epic-official:cache-only",
              {
                configName,
                cacheCount,
              },
            );
          }
          return {
            achievements: cached || {},
            save_path: config.save_path || "",
          };
        }
        let token = null;
        try {
          token = await ensureEpicAccessToken(
            getEpicAuthRequestOptions({
              timeoutMs: 15000,
            }),
          );
        } catch (error) {
          return {
            achievements: cached || {},
            save_path: config.save_path || "",
            error: error?.message || "epic auth missing",
          };
        }

        const accountId = resolvePreferredEpicOfficialAccountId(config, token);
        const schemaPath = resolveAchievementsSchemaPath(config);
        let schemaAchievements = [];
        if (schemaPath && fs.existsSync(schemaPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
            if (Array.isArray(parsed)) schemaAchievements = parsed;
          } catch {}
        }
        let productId = String(
          config?.epic_product_id ||
            config?.epicProductId ||
            config?.appid ||
            "",
        ).trim();
        if (schemaPath) {
          try {
            const sidecarPath = path.join(
              path.dirname(schemaPath),
              "achievementpercentages.json",
            );
            if (fs.existsSync(sidecarPath)) {
              const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
              if (sidecar?.appid) productId = String(sidecar.appid).trim();
            }
          } catch {}
        }
        const syncKey = buildEpicOfficialLoadSyncKey(
          configName,
          accountId,
          productId || config?.epic_product_id || config?.appid || "",
        );
        const passiveResult = buildEpicOfficialPassiveSyncResult(
          config,
          cached,
        );
        const isPrioritySyncTarget =
          isEpicOfficialPrioritySyncTarget(configName);
        if (!isPrioritySyncTarget && !isEpicOfficialBackgroundWorkBootReady()) {
          epicOfficialLogger.debug?.(
            "load-saved-achievements:epic-official:sync-deferred",
            {
              configName,
              accountId,
              productId: productId || config?.epic_product_id || config?.appid,
              reason: "boot-priority",
            },
          );
          return passiveResult;
        }
        const passiveSync = epicOfficialPassiveLoadSync.get(syncKey);
        if (!isPrioritySyncTarget && passiveSync) {
          const passiveAgeMs = Date.now() - passiveSync.timestamp;
          if (passiveAgeMs <= EPIC_OFFICIAL_PASSIVE_SYNC_TTL_MS) {
            epicOfficialLogger.debug?.(
              "load-saved-achievements:epic-official:sync-deduped",
              {
                configName,
                accountId,
                productId:
                  productId || config?.epic_product_id || config?.appid,
                source: "passive-cache",
                ageMs: passiveAgeMs,
              },
            );
            return passiveSync.result || passiveResult;
          }
          epicOfficialPassiveLoadSync.delete(syncKey);
        }
        const recentSync = epicOfficialRecentLoadSync.get(syncKey);
        if (
          recentSync &&
          Date.now() - recentSync.timestamp <= EPIC_OFFICIAL_LOAD_SYNC_DEDUPE_MS
        ) {
          epicOfficialLogger.debug?.(
            "load-saved-achievements:epic-official:sync-deduped",
            {
              configName,
              accountId,
              productId: productId || config?.epic_product_id || config?.appid,
              source: "recent",
              ageMs: Date.now() - recentSync.timestamp,
            },
          );
          return recentSync.result;
        }
        if (recentSync) {
          epicOfficialRecentLoadSync.delete(syncKey);
        }
        const inflightSync = epicOfficialLoadSyncInflight.get(syncKey);
        if (inflightSync) {
          epicOfficialLogger.debug?.(
            "load-saved-achievements:epic-official:sync-deduped",
            {
              configName,
              accountId,
              productId: productId || config?.epic_product_id || config?.appid,
              source: "inflight",
            },
          );
          return inflightSync;
        }
        try {
          const syncJob = (async () => {
            epicOfficialLogger.debug?.(
              "load-saved-achievements:epic-official:sync-start",
              {
                configName,
                accountId,
                productId,
              },
            );
            const synced = await syncEpicOfficialAchievements(
              config,
              getEpicAuthRequestOptions({
                token,
                accountId,
                productId,
                schemaAchievements,
                timeoutMs: 15000,
              }),
            );
            const preservedSnapshot = preserveEpicOfficialEarnedStateFromCache(
              synced.snapshot || {},
              cached,
            );
            const snapshot = mergeEarnedTimeFromCached(
              preservedSnapshot.snapshot || {},
              cached,
            );
            const nextAccountId = synced.accountId || accountId || "";
            const nextProductId = synced.productId || productId || "";
            const delta = getEpicOfficialUnlockedDelta(cached, snapshot);
            const hadCachedSnapshot = Object.keys(cached || {}).length > 0;
            const cachedEarnedCount =
              countEpicOfficialEarnedAchievements(cached);
            const nextEarnedCount =
              countEpicOfficialEarnedAchievements(snapshot);
            if (!hadCachedSnapshot && Number(synced.totalUnlocked || 0) > 0) {
              markEpicOfficialSilentSeed(
                configName,
                nextAccountId,
                nextProductId,
                {
                  expectedUnlocked: synced.totalUnlocked || 0,
                  reason: "load-saved-achievements",
                },
              );
            }
            const snapshotChanged = !deepEqual(cached || {}, snapshot || {});
            if (preservedSnapshot.changed) {
              epicOfficialLogger.warn(
                "epic-official:sync:regression-preserved",
                {
                  source: "load-saved-achievements",
                  configName,
                  accountId: nextAccountId || null,
                  productId: nextProductId || null,
                  cachedEarnedCount,
                  nextEarnedCount,
                  preservedEarnedCount:
                    preservedSnapshot.preservedEarnedCount || 0,
                  reportedTotalUnlocked: Number(synced.totalUnlocked || 0) || 0,
                },
              );
            }
            if (snapshotChanged) {
              savePreviousAchievements(
                configName,
                snapshot,
                normalizedPlatform,
                {
                  accountId: nextAccountId,
                },
              );
            }
            epicOfficialLogger.debug?.(
              "load-saved-achievements:epic-official:sync-success",
              {
                configName,
                count: Object.keys(snapshot || {}).length,
                accountId: nextAccountId,
                productId: nextProductId,
              },
            );
            if (
              nextAccountId !== (config?.epic_account_id || "") ||
              nextProductId !== (config?.epic_product_id || "")
            ) {
              config.epic_account_id = nextAccountId;
              config.epic_product_id = nextProductId;
              try {
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
              } catch {}
            }
            const result = {
              achievements: snapshot || {},
              save_path: config.save_path || "",
            };
            if (
              snapshotChanged &&
              isEpicOfficialConfigActiveForPolling(configName)
            ) {
              handleEpicOfficialSnapshotDelta({
                source: "load-saved-achievements",
                trigger: "sync",
                config,
                configName,
                schemaAchievements,
                snapshot,
                delta,
                hadCachedSnapshot,
                accountId: nextAccountId,
                productId: nextProductId,
              });
            }
            markEpicOfficialRecentLoadSync(
              configName,
              synced.accountId || accountId,
              synced.productId || productId,
              result,
            );
            return result;
          })().finally(() => {
            epicOfficialLoadSyncInflight.delete(syncKey);
          });
          epicOfficialLoadSyncInflight.set(syncKey, syncJob);
          return await syncJob;
        } catch (error) {
          epicOfficialLogger.warn(
            "load-saved-achievements:epic-official:sync-failed",
            {
              configName,
              error: error?.message || String(error),
            },
          );
          return {
            achievements: cached || {},
            save_path: config.save_path || "",
            error: error?.message || "epic official sync failed",
          };
        }
      }

      if (normalizedPlatform === "ubisoft-official") {
        const cached =
          (await loadPreviousAchievements(configName, normalizedPlatform)) ||
          {};
        const resolved = resolveUbisoftOfficialSpoolFileForConfig(config);
        const spoolFilePath = resolved?.spoolFilePath || "";
        const spoolDir = resolved?.spoolDir || config.save_path || "";
        if (!spoolFilePath || !fs.existsSync(spoolFilePath)) {
          return {
            achievements: cached || {},
            save_path: spoolDir,
            error: "spool file not found",
          };
        }
        try {
          const parsed = readUbisoftSpoolFile(spoolFilePath);
          const snapshot = buildUbisoftOfficialSnapshot(parsed?.records || []);
          const merged = mergeEarnedTimeFromCached(snapshot, cached);
          const nextUserId = resolved?.userId || config?.ubisoft_user_id || "";
          const nextSavePath = spoolDir || config.save_path || "";
          if (
            nextSavePath !== config.save_path ||
            nextUserId !== (config?.ubisoft_user_id || "") ||
            spoolFilePath !== (config?.ubisoft_spool_file || "")
          ) {
            config.save_path = nextSavePath;
            config.ubisoft_user_id = nextUserId;
            config.ubisoft_spool_file = spoolFilePath;
            try {
              fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            } catch {}
          }
          return {
            achievements: await applyManualOverridesForReturn(
              merged || snapshot || {},
              null,
              cached || {},
            ),
            save_path: nextSavePath,
          };
        } catch (error) {
          return {
            achievements: cached || {},
            save_path: spoolDir,
            error: error?.message || "spool read failed",
          };
        }
      }

      if (normalizedPlatform === "ea-official") {
        const cached =
          (await loadPreviousAchievements(configName, normalizedPlatform)) ||
          {};
        const resolved = resolveEaOfficialVerboseLogForConfig(config);
        const logFilePath = resolved?.logFilePath || "";
        const logsRoot = resolved?.logsRoot || config.save_path || "";
        if (!logFilePath || !fs.existsSync(logFilePath)) {
          return {
            achievements: cached || {},
            save_path: logsRoot,
            error: "ea verbose log not found",
          };
        }
        try {
          const parsed = readEaDesktopVerboseLog(logFilePath);
          const entry = resolveEaOfficialAchievementSetForAppId(config.appid, {
            achievementSet: config?.ea_achievement_set || "",
            savePath: logsRoot,
            logFilePath,
            parsedLog: parsed,
          });
          const achievementSet =
            entry?.achievementSet || config?.ea_achievement_set || "";
          if (!entry && !achievementSet) {
            return {
              achievements: cached || {},
              save_path: logsRoot,
              error: "ea achievement set not found",
            };
          }

          const snapshot = buildEaOfficialSnapshot(
            entry || achievementSet,
            parsed,
            cached || {},
          );
          const nextSavePath = logsRoot || config.save_path || "";
          const nextLogFile = logFilePath || config?.ea_log_file || "";
          const nextAchievementSet = achievementSet;
          const nextOfferId = entry?.offerId || config?.ea_offer_id || "";
          const nextInstallPath =
            entry?.installPath || config?.ea_install_path || "";
          const nextExecutable = entry?.exePath || config?.executable || "";
          const nextProcessName = normalizeProcessNameValue(
            entry?.processName ||
              config?.process_name ||
              (nextExecutable ? path.basename(nextExecutable) : ""),
          );
          if (
            nextSavePath !== config.save_path ||
            nextLogFile !== (config?.ea_log_file || "") ||
            nextAchievementSet !== (config?.ea_achievement_set || "") ||
            nextOfferId !== (config?.ea_offer_id || "") ||
            nextInstallPath !== (config?.ea_install_path || "") ||
            nextExecutable !== (config?.executable || "") ||
            !processNameValuesEqual(nextProcessName, config?.process_name)
          ) {
            config.save_path = nextSavePath;
            config.ea_log_file = nextLogFile;
            config.ea_achievement_set = nextAchievementSet;
            config.ea_offer_id = nextOfferId;
            config.ea_install_path = nextInstallPath;
            config.executable = nextExecutable;
            config.process_name = nextProcessName;
            try {
              fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            } catch {}
          }

          return {
            achievements: await applyManualOverridesForReturn(
              snapshot || cached || {},
              null,
              cached || {},
            ),
            save_path: nextSavePath,
          };
        } catch (error) {
          return {
            achievements: cached || {},
            save_path: logsRoot,
            error: error?.message || "ea verbose log read failed",
          };
        }
      }

      if (normalizedPlatform === "steam-official") {
        const schemaPath = resolveConfigSchemaPath(config);
        const statsDir = config.save_path || "";
        const schemaArr =
          schemaPath && fs.existsSync(schemaPath)
            ? JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
            : [];
        let entries = normalizeAppcacheSchemaEntries(schemaArr);
        const schemaBin =
          statsDir && config.appid
            ? path.join(statsDir, `UserGameStatsSchema_${config.appid}.bin`)
            : "";
        entries = enrichSchemaEntriesFromAppcacheSchemaFile(
          entries,
          schemaBin,
        );
        const cached =
          (await loadPreviousAchievements(
            configName,
            normalizedPlatform,
            statsDir,
          )) || {};
        const userBin =
          statsDir && config.appid
            ? pickConfiguredSteamOfficialUserBin(
                statsDir,
                config.appid,
                cachedPreferences,
              )
            : null;
        const hasPinnedSteamOfficialAccount = !!normalizeSteamOfficialSteamId(
          cachedPreferences?.steamOfficialSteamId,
        );

        // If we don't have schema entries yet, just surface cached so UI isn't empty.
        if (!entries.length) {
          return {
            achievements:
              hasPinnedSteamOfficialAccount && !userBin
                ? {}
                : await applyManualOverridesForReturn(
                    cached || {},
                    statsDir,
                    cached || {},
                  ),
            save_path: statsDir,
          };
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
              achievements: await applyManualOverridesForReturn(
                snapshot || {},
                statsDir,
                cached || {},
              ),
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
          achievements: hasPinnedSteamOfficialAccount
            ? {}
            : await applyManualOverridesForReturn(
                cached || {},
                statsDir,
                cached || {},
              ),
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
        ofxStats: statsIniOnlineFixPath,
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
      else if (safeExists(statsIniOnlineFixPath))
        effectiveSavePath = path.dirname(statsIniOnlineFixPath);
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
        achievements: await applyManualOverridesForReturn(
          achievements || {},
        ),
        save_path: effectiveSavePath || saveBase || "",
      };
    } catch (error) {
      ipcLogger.error("load-saved-achievements:error", {
        configName,
        error: error.message,
      });
      return { achievements: {}, save_path: "", error: error.message };
    }
  },
);

function collectConfigSaveDeletionDirectories({
  appid,
  platform,
  savePath,
  configData,
}) {
  const appidStr = String(appid || "").trim();
  if (!appidStr) return [];
  const targets = new Set();
  const addTarget = (candidate) => {
    const validated = validateAppIdDirectoryTarget(candidate, appidStr);
    if (validated) targets.add(validated);
  };
  const saveBase = typeof savePath === "string" ? savePath.trim() : "";

  if (saveBase && path.isAbsolute(saveBase)) {
    const baseLower = saveBase.toLowerCase();
    const appLower = appidStr.toLowerCase();
    addTarget(path.join(saveBase, appidStr));
    if (!baseLower.endsWith(`${path.sep}steam_settings`)) {
      addTarget(path.join(saveBase, "steam_settings", appidStr));
    }
    if (!baseLower.endsWith(`${path.sep}remote`)) {
      addTarget(path.join(saveBase, "remote", appidStr));
    }
    addTarget(path.join(saveBase, normalizePlatform(platform), appidStr));
    if (path.basename(baseLower) === appLower) addTarget(saveBase);
  }

  if (platform === "rpcs3") {
    const trophyDir = resolveRpcs3TrophyDirForConfig(configData || {});
    addTarget(trophyDir);
  } else if (platform === "shadps4") {
    const trophyDir =
      typeof configData?.trophy_path === "string" && configData.trophy_path
        ? configData.trophy_path
        : saveBase;
    if (trophyDir && path.isAbsolute(trophyDir)) {
      addTarget(path.dirname(path.dirname(trophyDir)));
    }
  }

  return Array.from(targets);
}

// Handler for config deletion
ipcMain.handle("delete-config", async (_event, payload) => {
  const configName =
    typeof payload === "string" ? payload : payload?.configName;
  const deleteExtras = payload?.deleteExtras === true;
  const deleteSaveFiles = payload?.deleteSaveFiles === true;
  const logDeleteInfo = (message, meta) => {
    appLogger.info(message, meta);
    ipcLogger.info(message, meta);
  };
  const logDeleteWarn = (message, meta) => {
    appLogger.warn(message, meta);
    ipcLogger.warn(message, meta);
  };
  const logDeleteError = (message, meta) => {
    appLogger.error(message, meta);
    ipcLogger.error(message, meta);
  };
  const deleteWarnings = [];
  const pushDeleteWarning = (message, meta) => {
    deleteWarnings.push({
      message,
      ...(meta && typeof meta === "object" ? meta : {}),
    });
    logDeleteWarn(message, meta);
  };
  let deletionGuardToken = null;
  let saveDeletionTargets = [];
  let configFileDeleted = false;
  let deletedConfigIdentity = null;
  let configStateRefreshAttempted = false;
  const refreshDeletedConfigState = async () => {
    if (
      !configFileDeleted ||
      configStateRefreshAttempted ||
      !watchedFoldersApi?.refreshConfigState
    ) {
      return;
    }
    configStateRefreshAttempted = true;
    logDeleteInfo("delete-config:refresh-config-state:start", {
      configName,
    });
    try {
      await watchedFoldersApi.refreshConfigState({
        suppressInitialNotify: true,
      });
      logDeleteInfo("delete-config:refresh-config-state:complete", {
        configName,
      });
    } catch (error) {
      pushDeleteWarning("delete-config:refresh-config-state-failed", {
        configName,
        error: error?.message || String(error),
      });
    }
  };
  const isRetryableDeleteError = (err) => {
    const code = String(err?.code || "").toUpperCase();
    return code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
  };
  const runDeleteWithRetries = async (stage, targetPath, fn) => {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        if (!isRetryableDeleteError(err) || attempt === maxAttempts) throw err;
        logDeleteWarn("delete-config:retry", {
          configName,
          stage,
          path: targetPath || null,
          attempt,
          error: err?.message || String(err),
        });
        await sleep(80);
      }
    }
    return undefined;
  };
  logDeleteInfo("delete-config:request", {
    configName,
    deleteExtras,
    deleteSaveFiles,
  });
  if (!configName || typeof configName !== "string") {
    return { success: false, error: "Config name missing." };
  }
  try {
    const safeName = sanitizeConfigName(configName);
    const configPath = resolveConfigJsonPath(configsDir, configName);
    //const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${safe}.json`);
    if (fs.existsSync(configPath)) {
      let configData = null;
      try {
        configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (err) {
        pushDeleteWarning("delete-config:parse-failed", {
          configName,
          error: err?.message || String(err),
        });
      }
      const appid =
        sanitizeAppId(configData?.appid) ||
        sanitizeAppId(configData?.appId) ||
        sanitizeAppId(configData?.steamAppId) ||
        "";
      const inferredConfigPlatform =
        inferOfficialPlatformFromMarkers(configData) ||
        normalizePlatform(configData?.platform);
      const platform =
        inferredConfigPlatform || getPlatformForAppId(appid) || "steam";
      const savePath =
        typeof configData?.save_path === "string"
          ? configData.save_path
          : "";
      const skipSaveDirectoryDeletion = [
        "steam-official",
        "epic-official",
        "gog-official",
        "ubisoft-official",
        "ea-official",
        "xbox-pc",
      ].includes(platform);
      if (deleteSaveFiles && !skipSaveDirectoryDeletion) {
        saveDeletionTargets = collectConfigSaveDeletionDirectories({
          appid,
          platform,
          savePath,
          configData,
        });
      }

      if (appid && watchedFoldersApi?.beginConfigDeletion) {
        logDeleteInfo("delete-config:generation-guard:start", {
          configName,
          appid,
          platform,
        });
        deletionGuardToken = await watchedFoldersApi.beginConfigDeletion({
          appid,
          configName: safeName,
          platform,
          savePath,
          deleteTargets: saveDeletionTargets,
          timeoutMs: 60000,
        });
        if (Array.isArray(deletionGuardToken?.deleteTargets)) {
          saveDeletionTargets = deletionGuardToken.deleteTargets;
        }
        logDeleteInfo("delete-config:generation-guard:ready", {
          configName,
          appid,
          platform,
        });
      }

      const deletingActiveConfig =
        sanitizeConfigName(selectedConfig || "") === safeName;
      if (deletingActiveConfig) {
        logDeleteInfo("delete-config:active-clear:start", {
          configName,
          activeConfig: selectedConfig || null,
        });
        await clearActiveConfigSelection({
          reason: "delete-config",
          configName,
        });
        logDeleteInfo("delete-config:active-clear:complete", {
          configName,
        });
      }

      await runDeleteWithRetries("config-file", configPath, () =>
        fs.unlinkSync(configPath),
      );
      configFileDeleted = true;
      deletedConfigIdentity = {
        configName: safeName,
        appid,
      };
      clearPendingMissingAchievementFile(configName);

      if (deleteExtras) {
        try {
          const cachePath = getCachePath(configName, platform);
          if (fs.existsSync(cachePath)) {
            await runDeleteWithRetries("cache-file", cachePath, () =>
              fs.unlinkSync(cachePath),
            );
          }
          const legacyCachePath = path.join(
            cacheDir,
            `${safeName}_achievements_cache.json`,
          );
          if (fs.existsSync(legacyCachePath)) {
            await runDeleteWithRetries(
              "legacy-cache-file",
              legacyCachePath,
              () => fs.unlinkSync(legacyCachePath),
            );
          }
        } catch (err) {
          pushDeleteWarning("delete-config:cache-delete-failed", {
            configName,
            error: err?.message || String(err),
          });
        }
        if (appid) {
          try {
            const imagePlatforms = getImagePlatformCandidates(appid, platform);
            for (const imagePlatform of imagePlatforms) {
              const imagesDir = path.join(
                app.getPath("userData"),
                "images",
                imagePlatform || "steam",
                String(appid),
              );
              if (!fs.existsSync(imagesDir)) continue;
              await runDeleteWithRetries("images-dir", imagesDir, () =>
                fs.rmSync(imagesDir, { recursive: true, force: true }),
              );
            }
          } catch (err) {
            pushDeleteWarning("delete-config:images-delete-failed", {
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
              await runDeleteWithRetries("schema-dir", schemaDir, () =>
                fs.rmSync(schemaDir, { recursive: true, force: true }),
              );
            }
          } catch (err) {
            pushDeleteWarning("delete-config:schema-delete-failed", {
              configName,
              appid,
              error: err?.message || String(err),
            });
          }
        }
      }
      if (deleteSaveFiles) {
        if (skipSaveDirectoryDeletion) {
          logDeleteInfo("delete-config:save-delete-skip", {
            configName,
            platform,
          });
        } else {
          const deleteFile = async (p) => {
            if (!p || typeof p !== "string") return;
            try {
              if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                await runDeleteWithRetries("save-file", p, () =>
                  fs.unlinkSync(p),
                );
                logDeleteInfo("delete-config:save-delete", {
                  configName,
                  path: p,
                });
              }
            } catch (err) {
              pushDeleteWarning("delete-config:save-delete-failed", {
                configName,
                path: p,
                error: err?.message || String(err),
              });
            }
          };
          const deleteDir = async (dir) => {
            if (!dir || typeof dir !== "string") return false;
            try {
              if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                await runDeleteWithRetries("save-dir", dir, () =>
                  fs.rmSync(dir, { recursive: true, force: true }),
                );
                logDeleteInfo("delete-config:save-delete-dir", {
                  configName,
                  path: dir,
                });
                return true;
              }
            } catch (err) {
              pushDeleteWarning("delete-config:save-delete-dir-failed", {
                configName,
                path: dir,
                error: err?.message || String(err),
              });
            }
            return false;
          };
          const deleteAllMatching = async (dir, matcher) => {
            if (!dir || typeof dir !== "string") return;
            try {
              const entries = fs.readdirSync(dir);
              for (const name of entries) {
                if (matcher(name)) {
                  await deleteFile(path.join(dir, name));
                }
              }
            } catch (err) {
              pushDeleteWarning("delete-config:save-scan-failed", {
                configName,
                dir,
                error: err?.message || String(err),
              });
            }
          };

          const appidStr = String(appid || "").trim();
          const saveBase = savePath || "";
          const appidDirs = new Set(saveDeletionTargets);

          let deletedDir = false;
          for (const dir of appidDirs) {
            if (await deleteDir(dir)) deletedDir = true;
          }

          if (!deletedDir) {
            if (platform === "rpcs3") {
              const tropusr = resolveTropusrPathForConfig(configData || {});
              await deleteFile(tropusr);
            } else if (platform === "shadps4") {
              const trophyDir = saveBase || "";
              if (trophyDir) {
                const xmlDir = path.join(trophyDir, "Xml");
                await deleteAllMatching(xmlDir, (n) =>
                  /^trop(_\d{2})?\.xml$/i.test(n),
                );
              }
            } else if (platform === "xenia") {
              const gpd = resolveGpdPathForConfig(configData || {});
              await deleteFile(gpd);
            } else if (saveBase) {
              const saveJsonPath = resolveSaveFilePath(saveBase, appid);
              const {
                tenokeIni: tenokeIniPath,
                ini: achievementsIniPath,
                ofx: achievementsIniOnlineFixPath,
                ofxStats: statsIniOnlineFixPath,
                bin: achievementsBinPath,
              } = resolveSaveSidecarPaths(saveBase, appid);
              await deleteFile(saveJsonPath);
              await deleteFile(tenokeIniPath);
              await deleteFile(achievementsIniPath);
              await deleteFile(achievementsIniOnlineFixPath);
              await deleteFile(statsIniOnlineFixPath);
              await deleteFile(achievementsBinPath);
            }
          }
        }
      }
      await refreshDeletedConfigState();
      logDeleteInfo("delete-config:success", {
        configName,
        configPath,
        warnings: deleteWarnings.length,
      });
      return {
        success: true,
        warnings: deleteWarnings,
      };
    }
    logDeleteWarn("delete-config:not-found", { configName, configPath });
    return { success: false, error: "File not found." };
  } catch (error) {
    logDeleteError("delete-config:error", {
      configName,
      error: error.message,
    });
    return { success: false, error: error.message };
  } finally {
    await refreshDeletedConfigState();
    if (configFileDeleted && deletedConfigIdentity) {
      const resetResult = resetMainPlatinumNotificationState(
        deletedConfigIdentity,
      );
      let watcherResetResult = null;
      try {
        watcherResetResult =
          watchedFoldersApi?.resetPlatinumState?.(deletedConfigIdentity) ||
          null;
      } catch (error) {
        logDeleteWarn("delete-config:platinum-state-reset-failed", {
          configName: deletedConfigIdentity.configName,
          appid: deletedConfigIdentity.appid || null,
          error: error?.message || String(error),
        });
      }
      logDeleteInfo("delete-config:platinum-state-reset", {
        configName: deletedConfigIdentity.configName,
        appid: deletedConfigIdentity.appid || null,
        main: resetResult,
        watcher: watcherResetResult,
      });
    }
    if (deletionGuardToken && watchedFoldersApi?.endConfigDeletion) {
      try {
        await watchedFoldersApi.endConfigDeletion(deletionGuardToken, {
          settleMs: 800,
          timeoutMs: 60000,
        });
        logDeleteInfo("delete-config:generation-guard:released", {
          configName,
          appid: deletionGuardToken.appid || null,
        });
      } catch (error) {
        logDeleteWarn("delete-config:generation-guard-release-failed", {
          configName,
          appid: deletionGuardToken.appid || null,
          error: error?.message || String(error),
        });
      }
    }
  }
});

ipcMain.handle("config:blacklist", async (_event, payload = {}) => {
  const rawName = payload.configName || "";
  const safeName = rawName ? sanitizeConfigName(rawName) : null;
  let resolvedAppId = payload.appid ? String(payload.appid) : null;
  let resolvedPlatform = payload.platform
    ? normalizeBlacklistPlatformValue(payload.platform)
    : null;
  const configPath = safeName
    ? resolveConfigJsonPath(configsDir, rawName)
    : null;
  const removeFlag = payload?.remove === true || payload?.action === "remove";

  const normalizeMutationScopes = (match) => {
    const requested = Array.isArray(payload?.scopes)
      ? payload.scopes
      : payload?.scope
        ? [payload.scope]
        : [];
    const normalized = Array.from(
      new Set(
        requested
          .map((scope) => String(scope || "").trim().toLowerCase())
          .filter((scope) => scope === "global" || scope === "platform"),
      ),
    );
    if (normalized.length) return normalized;
    if (removeFlag && payload?.scope === "effective") {
      return [
        ...(match?.global ? ["global"] : []),
        ...(match?.scoped ? ["platform"] : []),
      ];
    }
    return resolvedPlatform ? ["platform"] : ["global"];
  };

  ipcLogger.info("config:blacklist:request", {
    configName: safeName || null,
    appid: resolvedAppId || null,
    platform: resolvedPlatform || null,
    remove: removeFlag,
  });

  try {
    if (
      configPath &&
      fs.existsSync(configPath) &&
      (!resolvedAppId || !resolvedPlatform)
    ) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!resolvedAppId && parsed?.appid) resolvedAppId = String(parsed.appid);
      if (!resolvedPlatform && parsed?.platform) {
        resolvedPlatform = normalizeBlacklistPlatformValue(parsed.platform);
      }
    }
    if (!resolvedAppId) throw new Error("AppID missing");

    const beforeMatch = getBlacklistMatch(resolvedAppId, resolvedPlatform);
    const mutationScopes = normalizeMutationScopes(beforeMatch);
    if (!mutationScopes.length) {
      throw new Error("Blacklist scope missing");
    }
    if (mutationScopes.includes("platform") && !resolvedPlatform) {
      throw new Error("Platform missing for platform-scoped blacklist entry");
    }

    const nextAppIds = new Set(readBlacklistFromPrefs());
    const nextConfigKeys = new Set(readBlacklistedConfigKeysFromPrefs());
    const normalizedAppId = normalizeAppIdValue(resolvedAppId);
    const scopedKey = resolvedPlatform
      ? buildBlacklistConfigKey(normalizedAppId, resolvedPlatform)
      : "";
    for (const scope of mutationScopes) {
      const target = scope === "global" ? normalizedAppId : scopedKey;
      const collection = scope === "global" ? nextAppIds : nextConfigKeys;
      if (!target) continue;
      if (removeFlag) collection.delete(target);
      else collection.add(target);
    }
    const updatedList = persistBlacklist({
      appIds: Array.from(nextAppIds),
      configKeys: Array.from(nextConfigKeys),
    });
    const afterMatch = getBlacklistMatch(resolvedAppId, resolvedPlatform);
    const removedScopes = removeFlag
      ? mutationScopes.filter(
          (scope) =>
            (scope === "global" && beforeMatch.global) ||
            (scope === "platform" && beforeMatch.scoped),
        )
      : [];

    if (!removeFlag) {
      const activeEpicPollName = epicOfficialActivePollState?.configName || "";
      if (
        activeEpicPollName &&
        isEpicOfficialConfigBlacklisted(activeEpicPollName)
      ) {
        stopEpicOfficialActivePoll("blacklisted", {
          configName: activeEpicPollName,
          appid: resolvedAppId,
        });
      }
      const activeXboxPollName = xboxPcActivePollState?.configName || "";
      if (
        activeXboxPollName &&
        isXboxPcConfigBlacklisted(activeXboxPollName)
      ) {
        stopXboxPcActivePoll("blacklisted", {
          configName: activeXboxPollName,
          appid: resolvedAppId,
        });
      }
      if (selectedConfig) {
        const activeConfigName = sanitizeConfigName(selectedConfig);
        const activeConfig = activeConfigName
          ? readConfigForAchievementCache(activeConfigName)
          : null;
        const activeAppId = String(
          activeConfig?.xbox_title_id || activeConfig?.appid || "",
        ).trim();
        const activePlatform =
          normalizePlatform(activeConfig?.platform) || null;
        if (
          activeAppId &&
          isAppIdBlacklisted(activeAppId, activePlatform)
        ) {
          await clearActiveConfigSelection({
            reason: "config-blacklisted",
            configName: activeConfigName,
          });
        }
      }
    }

    if (removeFlag && removedScopes.length) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, {
          appid: normalizedAppId,
          platform: resolvedPlatform || null,
          configName: safeName || null,
          removedScopes,
          effectiveUnblocked: beforeMatch.effective && !afterMatch.effective,
        });
      } catch {}
    }

    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", updatedList);
    } catch {}

    ipcLogger.info("config:blacklist:success", {
      configName: safeName || null,
      appid: resolvedAppId,
      platform: resolvedPlatform || null,
      remove: removeFlag,
    });
    return {
      success: true,
      appid: resolvedAppId,
      platform: resolvedPlatform || null,
      blacklisted: afterMatch.effective,
      blacklistMatch: afterMatch,
      scopes: mutationScopes,
      blacklist: updatedList.entries,
      blacklistPayload: updatedList,
    };
  } catch (err) {
    ipcLogger.error("config:blacklist:error", {
      configName: safeName || null,
      appid: resolvedAppId || null,
      platform: resolvedPlatform || null,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Blacklist failed" };
  }
});

ipcMain.handle("blacklist:add-manual", async (_event, payload = {}) => {
  const source = Array.isArray(payload?.appids)
    ? payload.appids
    : typeof payload?.appids === "string"
      ? payload.appids.split(/[\s,;]+/)
      : [];
  const rawValues = source
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const MAX_MANUAL_BLACKLIST_APPIDS = 500;

  ipcLogger.info("blacklist:add-manual:request", {
    count: rawValues.length,
  });

  if (rawValues.length > MAX_MANUAL_BLACKLIST_APPIDS) {
    ipcLogger.warn("blacklist:add-manual:too-many", {
      count: rawValues.length,
      limit: MAX_MANUAL_BLACKLIST_APPIDS,
    });
    return {
      success: false,
      errorCode: "tooManyAppIds",
      error: `A maximum of ${MAX_MANUAL_BLACKLIST_APPIDS} AppIDs can be added at once.`,
      limit: MAX_MANUAL_BLACKLIST_APPIDS,
    };
  }

  try {
    const appIds = new Set(readBlacklistFromPrefs());
    const added = [];
    const duplicates = [];
    const invalid = [];

    for (const rawValue of rawValues) {
      const normalized = normalizeAppIdValue(rawValue);
      if (!normalized) {
        invalid.push(rawValue);
        continue;
      }
      if (appIds.has(normalized)) {
        duplicates.push(normalized);
        continue;
      }
      appIds.add(normalized);
      added.push(normalized);
    }

    const blacklistPayload = added.length
      ? persistBlacklist({
          appIds: Array.from(appIds),
          configKeys: readBlacklistedConfigKeysFromPrefs(),
        })
      : buildBlacklistPayload();

    if (added.length) {
      const persisted = new Set(blacklistPayload?.appids || []);
      if (added.some((appid) => !persisted.has(appid))) {
        throw new Error("Manual blacklist entries could not be saved.");
      }

      const activeEpicPollName = epicOfficialActivePollState?.configName || "";
      if (
        activeEpicPollName &&
        isEpicOfficialConfigBlacklisted(activeEpicPollName)
      ) {
        stopEpicOfficialActivePoll("blacklisted", {
          configName: activeEpicPollName,
          appid: null,
        });
      }
      const activeXboxPollName = xboxPcActivePollState?.configName || "";
      if (
        activeXboxPollName &&
        isXboxPcConfigBlacklisted(activeXboxPollName)
      ) {
        stopXboxPcActivePoll("blacklisted", {
          configName: activeXboxPollName,
          appid: null,
        });
      }
      if (selectedConfig) {
        const activeConfigName = sanitizeConfigName(selectedConfig);
        const activeConfig = activeConfigName
          ? readConfigForAchievementCache(activeConfigName)
          : null;
        const activeAppId = String(
          activeConfig?.xbox_title_id || activeConfig?.appid || "",
        ).trim();
        const activePlatform =
          normalizePlatform(activeConfig?.platform) || null;
        if (
          activeAppId &&
          isAppIdBlacklisted(activeAppId, activePlatform)
        ) {
          await clearActiveConfigSelection({
            reason: "manual-appid-blacklisted",
            configName: activeConfigName,
          });
        }
      }

      refreshBlacklistEffects();
      try {
        broadcastToAll("blacklist:updated", blacklistPayload);
      } catch {}
    }

    ipcLogger.info("blacklist:add-manual:success", {
      requested: rawValues.length,
      added: added.length,
      duplicates: duplicates.length,
      invalid: invalid.length,
    });
    return {
      success: true,
      added,
      duplicates,
      invalid,
      blacklistPayload,
    };
  } catch (err) {
    ipcLogger.error("blacklist:add-manual:error", {
      error: err?.message || String(err),
    });
    return {
      success: false,
      error: err?.message || "Failed to add manual blacklist entries.",
    };
  }
});

ipcMain.handle("blacklist:list", async () => {
  return buildBlacklistPayload();
});

ipcMain.handle("blacklist:reset", async () => {
  ipcLogger.info("blacklist:reset:request");
  try {
    const before = buildBlacklistPayload();
    const removedEntries = Array.isArray(before?.entries)
      ? before.entries.map(({ appid, platform, scope }) => ({
          appid,
          platform,
          scope,
        }))
      : [];
    const removedScopes = Array.from(
      new Set(
        removedEntries
          .map((entry) => String(entry?.scope || "").trim().toLowerCase())
          .filter((scope) => scope === "global" || scope === "platform"),
      ),
    );
    resetBlacklist();
    if (removedEntries.length > 0) {
      try {
        ipcMain.emit("blacklist:removed-appid", null, {
          reset: true,
          removedEntries,
          removedScopes,
          effectiveUnblocked: true,
        });
      } catch {}
    }
    refreshBlacklistEffects();
    try {
      broadcastToAll("blacklist:updated", buildBlacklistPayload());
    } catch {}
    ipcLogger.info("blacklist:reset:success", {
      count: (before?.appids?.length || 0) + (before?.configKeys?.length || 0),
    });
    return { success: true, appids: [], configKeys: [], entries: [] };
  } catch (err) {
    ipcLogger.error("blacklist:reset:error", {
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || "Reset failed" };
  }
});

ipcMain.handle("schema:regenerate", async (event, payload) => {
  let progressJob = null;
  try {
    const rawName = payload?.name || payload?.configName || "";
    const safeName = sanitizeConfigName(rawName);
    if (!safeName) {
      return {
        success: false,
        message: tUi("main.message.configNameRequired"),
      };
    }
    const cfgFile = resolveConfigJsonPath(configsDir, rawName);
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
    if (platform === "gog-official") {
      return {
        success: false,
        message: tUi(
          "main.message.schemaGogOfficialRescan",
          {},
          "GOG (Official) schemas are generated from GOG Galaxy gameplay.db. Rescan the GOG Galaxy Applications root instead.",
        ),
      };
    }
    if (platform === "ubisoft-official") {
      return {
        success: false,
        message: tUi(
          "main.message.schemaUbisoftOfficialRescan",
          {},
          "Ubisoft (Official) schemas are generated from Ubisoft Connect cache archives. Rescan the Ubisoft Connect spool root instead.",
        ),
      };
    }
    if (platform === "ea-official") {
      return {
        success: false,
        message: tUi(
          "main.message.schemaEaOfficialRescan",
          {},
          "EA (Official) schemas are generated from EA Desktop achievement logs. Rescan the EA Desktop Logs root instead.",
        ),
      };
    }
    if (platform === "xbox-pc") {
      return {
        success: false,
        message:
          "Xbox PC schemas are generated from Xbox Network. Use Import Xbox PC in Settings.",
      };
    }
    const appid = sanitizeAppIdForPlatform(rawAppId, platform);
    if (!appid) {
      return { success: false, message: tUi("main.message.appidRequired") };
    }
    if (isAppIdBlacklisted(appid, platform)) {
      const message = tUi("main.message.appidBlacklisted", { appid });
      ipcLogger.info("schema:regenerate-blocked-blacklist", {
        appid,
        name: safeName,
      });
      return { success: false, message, blacklisted: true };
    }

    progressJob = createGenerationProgressJob({
      kind: "schema-regenerate",
      scope: "single",
      status: "running",
      itemName: safeName,
      appid,
      phase: "preparing",
      detail: "Preparing schema regeneration",
      current: 0,
      total: 0,
      percent: 5,
    });

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
      progressJob?.fail({
        phase: "failed",
        detail: err?.message || "Failed to update config",
      });
      return {
        success: false,
        message: tUi("main.message.configUpdateFailed"),
      };
    }

    progressJob.update({
      phase: "writingConfig",
      detail: "Updating config",
      percent: 12,
    });
    notifyConfigsChanged();
    progressJob.update({
      phase: "generatingSchema",
      detail: "Starting schema generation",
      percent: 18,
    });

    let schemaResult = null;
    try {
      if (platform === "epic-official") {
        schemaResult = await ensureEpicOfficialSchema(appid, destDir, {
          ...config,
          productId: config?.epic_product_id || config?.epicProductId,
          sandboxId:
            config?.epic_sandbox_id ||
            config?.epicSandboxId ||
            config?.epic_namespace ||
            config?.epicNamespace,
          timeoutMs: 15000,
        });
        progressJob?.update({
          phase: "generatingSchema",
          detail: "Generating schema",
          percent: 90,
        });
      } else {
        const tempRoot = createSchemaRegenerateTempRoot(platform, appid);
        const tempDestDir = path.join(tempRoot, platform, appid);
        try {
          await runAchievementsGenerator(
            appid,
            tempRoot,
            app.getPath("userData"),
            {
              platform,
              langs: getSchemaLanguagesFromPreferences(),
              onProgress: (progress) => {
                const childPercent = clampGenerationPercent(
                  progress?.percent,
                  0,
                );
                progressJob?.update({
                  phase: progress?.phase || "generatingSchema",
                  detail: progress?.detail || "",
                  current:
                    Number.isFinite(Number(progress?.current)) &&
                    Number(progress.current) >= 0
                      ? Number(progress.current)
                      : 0,
                  total:
                    Number.isFinite(Number(progress?.total)) &&
                    Number(progress.total) >= 0
                      ? Number(progress.total)
                      : 0,
                  percent: 18 + Math.round(childPercent * 0.72),
                });
              },
            },
          );
          const validation = validateGeneratedSchemaDir(tempDestDir);
          if (!validation.ok) {
            ipcLogger.warn("schema:regenerate-empty-output-kept-existing", {
              appid,
              name: safeName,
              platform,
              tempDestDir,
              reason: validation.message,
            });
            throw new Error(
              tUi(
                "main.message.schemaRegenerateSafeFailure",
                { reason: validation.message },
                "{reason}. Existing schema was kept unchanged.",
              ),
            );
          }
          replaceSchemaDirWithBackup(tempDestDir, destDir);
        } finally {
          try {
            fs.rmSync(tempRoot, { recursive: true, force: true });
          } catch {}
        }
      }
    } catch (err) {
      ipcLogger.error("schema:regenerate-failed", {
        appid,
        name: safeName,
        error: err?.message || String(err),
      });
      progressJob?.fail({
        phase: "failed",
        detail: err?.message || "Schema generation failed",
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
      if (platform === "epic-official" && schemaResult) {
        try {
          const current = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
          if (schemaResult.productId) {
            current.epic_product_id = schemaResult.productId;
          }
          if (schemaResult.sandboxId) {
            current.epic_namespace = schemaResult.sandboxId;
          }
          fs.writeFileSync(cfgFile, JSON.stringify(current, null, 2));
        } catch {}
      }
      progressJob?.update({
        phase: "finalizing",
        detail: "Refreshing achievements",
        percent: 96,
      });
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
      progressJob?.succeed({
        phase: "completed",
        detail: "Schema regenerated",
        percent: 100,
      });
      return {
        success: true,
        message: tUi("main.message.schemaRegenerateSuccess"),
        config_path: destDir,
      };
    }

    progressJob?.fail({
      phase: "failed",
      detail: "Achievements schema file was not generated",
    });
    return {
      success: false,
      message: tUi("main.message.schemaMissing"),
      config_path: destDir,
    };
  } catch (error) {
    ipcLogger.error("schema:regenerate-error", {
      error: error?.message || String(error),
    });
    progressJob?.fail({
      phase: "failed",
      detail: error?.message || "Schema regeneration failed",
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

const RANDOM_SOUND_VALUE = "random";
let lastRandomAchievementSound = "";
let lastRandomRareSound = "";
let lastRandomPlatinumSound = "";
let lastRandomTestSound = "";

function getAvailableNotificationSounds() {
  try {
    if (!fs.existsSync(userSoundsFolder)) return [];
    return fs
      .readdirSync(userSoundsFolder, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && isSupportedNotificationSoundFile(entry.name),
      )
      .map((entry) => entry.name);
  } catch (err) {
    notificationLogger.warn("sound:random-list-failed", {
      error: err?.message || String(err),
    });
    return [];
  }
}

function resolveNotificationSound(sound, options = {}) {
  const requested = String(sound || "mute").trim() || "mute";
  if (requested !== RANDOM_SOUND_VALUE) return requested;

  const isPlatinum = options.isPlatinum === true;
  const isRare = options.isRare === true;
  const isTest = options.isTest === true;
  const sounds = getAvailableNotificationSounds();
  if (!sounds.length) return "mute";

  const previous = isTest
    ? lastRandomTestSound
    : isPlatinum
      ? lastRandomPlatinumSound
      : isRare
        ? lastRandomRareSound
        : lastRandomAchievementSound;
  const candidates =
    sounds.length > 1
      ? sounds.filter((candidate) => candidate !== previous)
      : sounds;
  const selected = candidates[crypto.randomInt(candidates.length)];

  if (isTest) {
    lastRandomTestSound = selected;
  } else if (isPlatinum) {
    lastRandomPlatinumSound = selected;
  } else if (isRare) {
    lastRandomRareSound = selected;
  } else {
    lastRandomAchievementSound = selected;
  }
  return selected;
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

function createAppNavigationRoute(route = {}, source = "unknown") {
  const appid = normalizeNavigationAppId(route?.appid);
  const platform = normalizeNavigationPlatform(route?.platform);
  const rawConfigName = String(route?.configName || "").trim();
  const configName = rawConfigName ? sanitizeConfigName(rawConfigName) : "";
  const rawAchievementId = String(route?.achievementId || "").trim();
  const achievementId =
    rawAchievementId &&
    rawAchievementId.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(rawAchievementId)
      ? rawAchievementId
      : "";
  if ((!appid || !platform) && !configName) return null;
  appNavigationRequestSequence += 1;
  return {
    appid: appid || "",
    platform: platform || "",
    configName: configName || "",
    achievementId,
    source: String(source || "unknown").slice(0, 64),
    requestId: `${Date.now()}-${appNavigationRequestSequence}`,
  };
}

function handleAppNavigationArgv(argv, source, options = {}) {
  const parsed = parseAppNavigationArgs(argv);
  if (!parsed.hasNavigationArgs) return false;
  if (!parsed.route) {
    appLogger.warn("app-navigation:arguments-invalid", {
      source,
      reason: parsed.error || "invalid",
    });
    return false;
  }
  return requestAppNavigation(parsed.route, {
    source,
    showWindow: options?.showWindow === true,
  });
}

function pruneRecentAppNavigationKeys(now = Date.now()) {
  for (const [key, timestamp] of recentAppNavigationKeys) {
    if (now - timestamp > 5000) recentAppNavigationKeys.delete(key);
  }
}

function showMainWindowForNavigation() {
  if (!app.isReady()) return;
  hideTrayMenu?.();
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (global.bootDone === true) {
      createMainWindow({ forceShow: true });
    }
    return;
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
  } catch {}
  try {
    mainWindow.show();
    mainWindow.focus();
  } catch {}
}

function requestAppNavigation(route, options = {}) {
  const source = options?.source || route?.source || "unknown";
  const normalized = createAppNavigationRoute(route, source);
  if (!normalized) {
    appLogger.warn("app-navigation:request-invalid", { source });
    return false;
  }

  const dedupeKey = String(options?.dedupeKey || "").trim();
  if (dedupeKey) {
    const now = Date.now();
    pruneRecentAppNavigationKeys(now);
    const previous = recentAppNavigationKeys.get(dedupeKey) || 0;
    if (now - previous <= 5000) {
      appLogger.info("app-navigation:deduped", { source, dedupeKey });
      return false;
    }
    recentAppNavigationKeys.set(dedupeKey, now);
  }

  pendingAppNavigationRoute = normalized;
  appLogger.info("app-navigation:request", {
    source,
    requestId: normalized.requestId,
    appid: normalized.appid || null,
    platform: normalized.platform || null,
    configName: normalized.configName || null,
    achievementId: normalized.achievementId || null,
  });

  if (options?.showWindow !== false) showMainWindowForNavigation();
  flushPendingAppNavigationRoute();
  return true;
}

function readAppNavigationConfigFile(fileName) {
  const fullPath = path.join(configsDir, fileName);
  try {
    const config = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return {
      config,
      configName: path.basename(fileName, ".json"),
    };
  } catch (err) {
    appLogger.warn("app-navigation:config-read-failed", {
      file: fileName,
      error: err?.message || String(err),
    });
    return null;
  }
}

function resolveAppNavigationConfig(route) {
  let fileNames = [];
  try {
    fileNames = fs
      .readdirSync(configsDir)
      .filter((file) => file.toLowerCase().endsWith(".json"));
  } catch (err) {
    return { ok: false, reason: "config-directory-unavailable", matches: [] };
  }

  const matches = [];
  const rawRequestedName = String(route?.configName || "").trim();
  const requestedName = rawRequestedName
    ? sanitizeConfigName(rawRequestedName)
    : "";
  for (const fileName of fileNames) {
    const configName = path.basename(fileName, ".json");
    if (
      requestedName &&
      sanitizeConfigName(configName).toLowerCase() !== requestedName.toLowerCase()
    ) {
      continue;
    }
    const entry = readAppNavigationConfigFile(fileName);
    if (!entry) continue;
    if (
      route?.appid &&
      route?.platform &&
      !configMatchesNavigationRoute(entry.config, route)
    ) {
      continue;
    }
    matches.push(entry);
  }

  if (matches.length !== 1) {
    return {
      ok: false,
      reason: matches.length ? "ambiguous-config" : "config-not-found",
      matches: matches.map((entry) => entry.configName),
    };
  }

  const match = matches[0];
  const appid = normalizeNavigationAppId(
    match.config?.appid ?? match.config?.appId ?? route?.appid,
  );
  const platform = normalizeNavigationPlatform(
    match.config?.platform ?? route?.platform,
  );
  return {
    ok: true,
    configName: match.configName,
    appid,
    platform,
    blacklisted: !!appid && isAppIdBlacklisted(appid, platform || null),
  };
}

function flushPendingOverlayNotificationNavigation() {
  const pending = pendingOverlayNotificationNavigation;
  if (!pending || !overlayWindow || overlayWindow.isDestroyed()) return false;
  const webContentsId = Number(overlayWindow.webContents?.id);
  if (
    !overlayWindow.webContents ||
    overlayWindow.webContents.isDestroyed() ||
    !Number.isFinite(webContentsId) ||
    overlayNavigationRendererReadyWebContentsId !== webContentsId
  ) {
    return false;
  }
  if (pending.dispatchedWebContentsId === webContentsId) return true;
  try {
    const payload = {
      requestId: pending.requestId,
      source: pending.source,
      configName: pending.configName,
      achievementId: pending.achievementId,
    };
    overlayWindow.webContents.send("overlay:navigate-achievement", payload);
    pending.dispatchedWebContentsId = webContentsId;
    pending.dispatchedAt = Date.now();
    notificationLogger.info(
      "notification-navigation:overlay-dispatched",
      payload,
    );
    return true;
  } catch (error) {
    notificationLogger.warn("notification-navigation:overlay-dispatch-failed", {
      requestId: pending.requestId,
      error: error?.message || String(error),
    });
    return false;
  }
}

function requestOverlayNotificationNavigation(route, options = {}) {
  const source = String(options?.source || route?.source || "notification");
  const normalized = createAppNavigationRoute(route, source);
  if (!normalized?.achievementId) {
    notificationLogger.warn("notification-navigation:overlay-failed", {
      source,
      reason: "achievement-id-missing",
    });
    return false;
  }
  const resolved = resolveAppNavigationConfig(normalized);
  if (!resolved.ok) {
    notificationLogger.warn("notification-navigation:overlay-failed", {
      source,
      reason: resolved.reason,
      matches: resolved.matches,
    });
    return false;
  }
  const activeConfigName = sanitizeConfigName(selectedConfig || "");
  const resolvedConfigName = sanitizeConfigName(resolved.configName || "");
  const activeConfigMatches =
    !!activeConfigName &&
    activeConfigName.toLowerCase() === resolvedConfigName.toLowerCase();
  if (!activeConfigMatches) {
    notificationLogger.info("notification-navigation:overlay-route-config", {
      source,
      activeConfig: selectedConfig || null,
      notificationConfig: resolved.configName || null,
    });
  }

  pendingOverlayNotificationNavigation = {
    requestId: normalized.requestId,
    source,
    configName: resolved.configName,
    achievementId: normalized.achievementId,
  };

  try {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      createOverlayWindow(resolved.configName);
    } else {
      if (!activeConfigMatches && !overlayWindow.webContents.isLoading()) {
        overlayWindow.webContents.send(
          "load-overlay-data",
          resolved.configName,
        );
      }
      if (!isOverlayEffectivelyPresented()) {
        setOverlayPresented(true);
      }
    }
    flushPendingOverlayNotificationNavigation();
    return true;
  } catch (error) {
    pendingOverlayNotificationNavigation = null;
    notificationLogger.warn("notification-navigation:overlay-failed", {
      source,
      reason: "overlay-present-failed",
      error: error?.message || String(error),
    });
    return false;
  }
}

function sendAppNavigationError(route, reason, matches = []) {
  appLogger.warn("app-navigation:resolve-failed", {
    requestId: route?.requestId || null,
    source: route?.source || null,
    appid: route?.appid || null,
    platform: route?.platform || null,
    reason,
    matches,
  });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("app-navigation:error", {
      requestId: route?.requestId || "",
      reason: String(reason || "navigation-failed"),
    });
  } catch {}
}

function flushPendingAppNavigationRoute() {
  if (!pendingAppNavigationRoute || !appNavigationRendererReady) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.webContents.isLoading()) return false;

  const route = pendingAppNavigationRoute;
  const resolved = resolveAppNavigationConfig(route);
  pendingAppNavigationRoute = null;
  if (!resolved.ok) {
    sendAppNavigationError(route, resolved.reason, resolved.matches);
    return false;
  }

  const payload = {
    requestId: route.requestId,
    source: route.source,
    appid: resolved.appid || route.appid,
    platform: resolved.platform || route.platform,
    configName: resolved.configName,
    achievementId: route.achievementId || "",
    blacklisted: resolved.blacklisted === true,
  };
  try {
    mainWindow.webContents.send("app-navigation:open", payload);
    appLogger.info("app-navigation:dispatched", payload);
    return true;
  } catch (err) {
    pendingAppNavigationRoute = route;
    appLogger.warn("app-navigation:dispatch-failed", {
      requestId: route.requestId,
      error: err?.message || String(err),
    });
    return false;
  }
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
  appNavigationRendererReady = false;
  windowLogger.info("create-main-window:start", {
    existing: Boolean(mainWindow && !mainWindow.isDestroyed?.()),
  });
  const forceShowOnLoad = !!options.forceShow;
  let initialZoom = 1;
  let initialPreferences = {};
  try {
    initialPreferences = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf-8"))
      : {};
    initialZoom = Number(initialPreferences.windowZoomFactor) || 1;
  } catch {}
  mainWindowUserZoom = initialZoom;
  const initialScale = getDisplayScaleForBounds();
  const initialZoomFactor = initialZoom / (initialScale || 1);
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 1000,
    frame: false,
    show: false,
    transparent: false,
    roundedCorners: true,
    backgroundColor: "#282a36",
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

  mainWindow.webContents.on("did-start-loading", () => {
    appNavigationRendererReady = false;
  });

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
    broadcastOverlayControllerRuntimeState(cachedPreferences);
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
  const isSanNotification = !!message.sanTheme;
  const { presetFolder } = isSanNotification
    ? { presetFolder: null }
    : resolveNotificationPresetFolder(preset);

  const presetHtml = isSanNotification
    ? path.join(__dirname, "san-notification.html")
    : path.join(presetFolder, "index.html");
  const position = message.position || "center-bottom";
  const scaleInfo = normalizeNotificationScale(message.scale);
  const scale = scaleInfo.scale;
  windowLogger.info("create-notification-window:start", {
    preset,
    position,
    scale,
  });

  const { width: windowWidth, height: windowHeight } = isSanNotification
    ? {
        width: Number(message.sanTheme?.width) || 420,
        height: Number(message.sanTheme?.height) || 140,
      }
    : getPresetDimensions(presetFolder);

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
  const gapX = Math.round(0 * scale);
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

    case "middle-right":
      x = ax + aw - scaledWidth - gapX;
      y = ay + Math.floor((ah - scaledHeight) / 2);
      break;

    case "top-left":
      x = ax + gapX;
      y = ay + gapY;
      break;

    case "bottom-left":
      x = ax + gapX;
      y = ay + ah - Math.floor(scaledHeight) - gapY;
      break;

    case "middle-left":
      x = ax + gapX;
      y = ay + Math.floor((ah - scaledHeight) / 2);
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
      name: message.name || "",
      displayName: message.displayName,
      description: message.description,
      iconPath: iconPathToSend,
      headerPath: message.headerPath || "",
      sanTheme: message.sanTheme || null,
      appid: message.appid || null,
      platform: message.platform || null,
      configName: message.configName || "",
      config_path: message.config_path || "",
      rarityPct: message.rarityPct,
      rarityTier: message.rarityTier || "",
      trophyType: message.trophyType || "",
      isRare: message.isRare === true,
      isPlatinum: message.isPlatinum === true,
      showRarityPercentage: message.showRarityPercentage === true,
      preset: message.preset || preset,
      position: message.position || position,
      scale,
      durationMs: message.durationMs || 0,
      durationOverridden: !!message?.durationOverridden,
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
      name: achievement.name || achievement.api || "",
      displayName,
      description: descriptionText,
      icon: achievement.icon,
      icon_gray: achievement.icon_gray || achievement.icongray,
      appid: achievement.appid || achievement.appId || null,
      platform: normalizePlatform(achievement.platform) || null,
      config_path: achievement.config_path,
      configName:
        achievement.configName || achievement.config_name || configName || "",
      preset: achievement.preset,
      position: achievement.position,
      sound: achievement.sound,
      rarityPct: achievement.rarityPct,
      raritySource: achievement.raritySource,
      trophyType: achievement.trophyType || achievement.trophy_type,
    };

    queueAchievementNotification(notificationData);

    const achName = achievement.name;
    if (achName) {
      if (!previousAchievements) previousAchievements = {};
      previousAchievements[achName] = {
        earned: true,
        progress: achievement.progress || undefined,
        max_progress: achievement.max_progress || undefined,
        progress_is_float: achievement.progress_is_float || undefined,
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
  const candidatePlatforms = getImagePlatformCandidates(appid, platform);
  const preferredDir = path.join(baseDir, platform || "steam", `${appid}`);
  const preferredPath = pickExistingCoverImagePath(preferredDir, appid);
  if (preferredPath) {
    ipcLogger.info("checkLocalGameImage:hit", {
      appid,
      platform,
      imagePath: preferredPath,
    });
    return preferredPath;
  }
  for (const candidatePlatform of candidatePlatforms) {
    if (candidatePlatform === platform) continue;
    const candidateDir = path.join(baseDir, candidatePlatform, `${appid}`);
    const candidatePath = pickExistingCoverImagePath(candidateDir, appid);
    if (!candidatePath) continue;
    let resolvedPath = candidatePath;
    try {
      fs.mkdirSync(preferredDir, { recursive: true });
      const preferredExt = path.extname(candidatePath || "");
      const preferredTarget = path.join(
        preferredDir,
        `${appid}${preferredExt || ".jpg"}`,
      );
      removeSiblingCoverImageFormats(preferredDir, appid, preferredTarget);
      if (!fs.existsSync(preferredTarget)) {
        fs.copyFileSync(candidatePath, preferredTarget);
      }
      resolvedPath = fs.existsSync(preferredTarget)
        ? preferredTarget
        : candidatePath;
    } catch {}
    ipcLogger.info("checkLocalGameImage:platform-alias-hit", {
      appid,
      platform,
      aliasPlatform: candidatePlatform,
      imagePath: candidatePath,
      resolvedPath,
    });
    return resolvedPath;
  }
  const legacyPath = pickExistingCoverImagePath(baseDir, appid);
  if (legacyPath) {
    let resolvedPath = legacyPath;
    try {
      fs.mkdirSync(preferredDir, { recursive: true });
      const legacyExt = path.extname(legacyPath || "");
      const preferredTarget = path.join(
        preferredDir,
        `${appid}${legacyExt || ".jpg"}`,
      );
      removeSiblingCoverImageFormats(preferredDir, appid, preferredTarget);
      if (!fs.existsSync(preferredTarget)) {
        fs.copyFileSync(legacyPath, preferredTarget);
      }
      resolvedPath = fs.existsSync(preferredTarget)
        ? preferredTarget
        : legacyPath;
    } catch {}
    ipcLogger.info("checkLocalGameImage:legacy-hit", {
      appid,
      platform,
      imagePath: legacyPath,
      resolvedPath,
    });
    return resolvedPath;
  }
  ipcLogger.info("checkLocalGameImage:miss", { appid, platform });
  return null;
});

// Check if executable file exists
ipcMain.handle("checkExecutableExists", async (_event, exePath) => {
  if (!exePath) return false;
  try {
    await fs.promises.access(exePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
});

// Save image locally from renderer
ipcMain.handle(
  "saveGameImage",
  async (_event, appid, buffer, platformArg, meta = {}) => {
    const platform =
      normalizePlatform(platformArg) || getPlatformForAppId(appid);
    const extension = getCoverExtensionFromMeta(meta);
    ipcLogger.info("saveGameImage:request", {
      appid,
      platform,
      extension,
      sourceUrl: String(meta?.sourceUrl || meta?.url || "").trim() || null,
      contentType:
        String(meta?.contentType || meta?.mimeType || "").trim() || null,
    });
    try {
      const imageDir = path.join(
        app.getPath("userData"),
        "images",
        platform || "steam",
        String(appid),
      );
      if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
      const fullPath = path.join(imageDir, `${appid}${extension}`);
      removeSiblingCoverImageFormats(imageDir, appid, fullPath);
      fs.writeFileSync(fullPath, Buffer.from(buffer));
      broadcastToAll("update-image", { appid: String(appid), platform });
      return { success: true, path: fullPath };
    } catch (err) {
      notifyError(tUi("main.notify.image.saveFailed", { error: err.message }));
      return { success: false, error: err.message };
    }
  },
);

// Add new IPC handler for test achievements that doesn't require a config
ipcMain.on("show-test-notification", (event, options) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;

  const notificationData = {
    displayName: tUi(
      "main.notify.testAchievementTitle",
      {},
      "Test Achievement Notification",
    ),
    description: tUi(
      "main.notify.testAchievementDescription",
      {},
      "This is a test achievement notification for this app.",
    ),
    icon: ICON_PNG_PATH, // Use app icon
    icon_gray: ICON_PNG_PATH, // Use app icon
    config_path: baseDir, // Use app's directory
    preset: options.preset || "default",
    position: options.position || "center-bottom",
    sound: options.sound || "mute",
    useSanPreset: options.useSanPreset === true,
    sanPreset: options.sanPreset || "",
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

function getRandomTestRareRarity() {
  const tiers = [
    { name: "gold", min: 0.01, max: 1 },
    { name: "silver", min: 1.01, max: 5 },
    { name: "bronze", min: 5.01, max: 10 },
  ];
  const tier = tiers[crypto.randomInt(tiers.length)];
  const percent =
    Math.round((tier.min + Math.random() * (tier.max - tier.min)) * 100) / 100;
  return { tier: tier.name, percent };
}

function resolveTestNotificationSanPreset(options = {}, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(options, "sanPreset")) {
    return String(options.sanPreset || "");
  }
  return String(fallback || "");
}

ipcMain.on("show-test-rare-notification", (_event, options = {}) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;
  const rarity = getRandomTestRareRarity();
  const tierLabel =
    rarity.tier.charAt(0).toUpperCase() + rarity.tier.slice(1);

  queueAchievementNotification({
    name: `TEST_RARE_NOTIFICATION_${rarity.tier.toUpperCase()}`,
    displayName: tUi(
      "main.notify.testRareTitle",
      { tier: tierLabel },
      "{tier} Rare Test",
    ),
    description: tUi(
      "main.notify.testRareDescription",
      { tier: tierLabel.toLowerCase(), percent: rarity.percent },
      "Random {tier} rarity test notification ({percent}%)",
    ),
    icon: ICON_PNG_PATH,
    icon_gray: ICON_PNG_PATH,
    config_path: baseDir,
    rarityPct: rarity.percent,
    raritySource: "test",
    preset: options.preset || prefs.rarePreset || prefs.preset || "default",
    position:
      options.position ||
      prefs.rarePosition ||
      prefs.position ||
      "center-bottom",
    sound: options.sound || prefs.rareSound || prefs.sound || "mute",
    useSanPreset: options.useSanPreset === true,
    sanPreset: resolveTestNotificationSanPreset(options, prefs.rareSanPreset),
    scale: parseFloat(
      options.scale != null
        ? options.scale
        : prefs.notificationScale != null
          ? prefs.notificationScale
          : 1,
    ),
    skipScreenshot: true,
    isTest: true,
    isTestRare: true,
  });
});

function getRandomTestTrophyType() {
  const tiers = ["bronze", "silver", "gold"];
  return tiers[crypto.randomInt(tiers.length)];
}

ipcMain.on("show-test-emulator-notification", (_event, options = {}) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;
  const platform = getEmulatorNotificationPreferencePrefix(options.platform)
    ? normalizePlatform(options.platform)
    : "xenia";
  const isTrophyPlatform = isTrophyTierNotificationPlatform(platform);
  const trophyType = isTrophyPlatform
    ? normalizeNotificationTrophyType(options.trophyType) || getRandomTestTrophyType()
    : "";
  const platformLabel =
    platform === "rpcs3" ? "RPCS3" : platform === "shadps4" ? "ShadPS4" : "Xenia";
  const tierLabel = trophyType
    ? trophyType.charAt(0).toUpperCase() + trophyType.slice(1)
    : "";

  queueAchievementNotification({
    name: `TEST_${String(platform || "emulator").toUpperCase()}_NOTIFICATION`,
    displayName: tUi(
      "main.notify.testEmulatorTitle",
      { platform: platformLabel },
      "{platform} Test Achievement",
    ),
    description: trophyType
      ? tUi(
          "main.notify.testEmulatorDescriptionWithTier",
          { platform: platformLabel, tier: tierLabel },
          "{platform} notification test with {tier} trophy border.",
        )
      : tUi(
          "main.notify.testEmulatorDescription",
          { platform: platformLabel },
          "{platform} notification test.",
        ),
    icon: ICON_PNG_PATH,
    icon_gray: ICON_PNG_PATH,
    config_path: baseDir,
    platform,
    trophyType,
    preset:
      options.preset || prefs[`${platform}Preset`] || prefs.preset || "default",
    position:
      options.position ||
      prefs[`${platform}Position`] ||
      prefs.position ||
      "center-bottom",
    sound: options.sound || prefs[`${platform}Sound`] || prefs.sound || "mute",
    useSanPreset: options.useSanPreset === true,
    sanPreset: resolveTestNotificationSanPreset(
      options,
      prefs[`${platform}SanPreset`],
    ),
    scale: parseFloat(
      options.scale != null
        ? options.scale
        : prefs.notificationScale != null
          ? prefs.notificationScale
          : 1,
    ),
    skipScreenshot: true,
    isTest: true,
  });
});

// Add new IPC handler for Platinum Achievement
const platinumDedup = new Set();

ipcMain.on("show-test-platinum-notification", (_event, options = {}) => {
  const prefs = cachedPreferences || {};
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;

  queueAchievementNotification({
    name: "TEST_PLATINUM_NOTIFICATION",
    displayName: tUi(
      "main.notify.platinumCompleteTitle",
      {},
      "100% Completed",
    ),
    description: tUi(
      "main.notify.platinumCompleteDescription",
      {},
      "You've unlocked all achievements!",
    ),
    icon: ICON_PNG_PATH,
    icon_gray: ICON_PNG_PATH,
    config_path: baseDir,
    preset:
      options.preset ||
      prefs.platinumPreset ||
      prefs.preset ||
      "default",
    position:
      options.position ||
      prefs.platinumPosition ||
      prefs.position ||
      "center-bottom",
    sound: options.sound || prefs.platinumSound || prefs.sound || "mute",
    useSanPreset: options.useSanPreset === true,
    sanPreset: resolveTestNotificationSanPreset(
      options,
      prefs.platinumSanPreset,
    ),
    scale: parseFloat(
      options.scale != null
        ? options.scale
        : prefs.notificationScale != null
          ? prefs.notificationScale
          : 1,
    ),
    skipScreenshot: true,
    isTest: true,
    isPlatinum: true,
    __isPlatinum: true,
  });
});

function markConfigPlatinumFlag(configName) {
  const safe = configName ? sanitizeConfigName(configName) : "";
  if (!safe) return false;
  const cfgPath = resolveConfigJsonPath(configsDir, configName);
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
  if (!fs.existsSync(userPresetsFolder)) {
    return {
      defaultPresets: [NATIVE_WINDOWS_PRESET_NAME],
      userPresets: [],
      scalable: [NATIVE_WINDOWS_PRESET_NAME],
      nonScalable: [],
      isStructured: true,
    };
  }

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
      if (
        !defaultPresets.some((preset) =>
          isNativeWindowsNotificationPreset(preset),
        )
      ) {
        defaultPresets.push(NATIVE_WINDOWS_PRESET_NAME);
      }
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

    if (
      !flatDirs.some((preset) => isNativeWindowsNotificationPreset(preset))
    ) {
      flatDirs.push(NATIVE_WINDOWS_PRESET_NAME);
    }
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
const RECENT_ACHIEVEMENT_NOTIFICATION_DEDUPE_MS = 1500;
const recentAchievementNotificationKeys = new Map();
const NATIVE_WINDOWS_PRESET_NAME = "Native Windows";

function matchesPlatinumNotificationIdentity(notificationData, identity = {}) {
  if (
    !notificationData ||
    (notificationData.isPlatinum !== true &&
      notificationData.__isPlatinum !== true)
  ) {
    return false;
  }
  const rawTargetName = String(identity?.configName || "").trim();
  const targetName = rawTargetName ? sanitizeConfigName(rawTargetName) : "";
  const rawPayloadName = String(
    notificationData?.configName || notificationData?.config_name || "",
  ).trim();
  const payloadName = rawPayloadName
    ? sanitizeConfigName(rawPayloadName)
    : "";
  if (targetName && payloadName) return targetName === payloadName;
  const targetAppId = String(identity?.appid || "").trim();
  const payloadAppId = String(
    notificationData?.appid || notificationData?.appId || "",
  ).trim();
  return !!targetAppId && !!payloadAppId && targetAppId === payloadAppId;
}

function resetMainPlatinumNotificationState(identity = {}) {
  const rawConfigName = String(identity?.configName || "").trim();
  const configName = rawConfigName ? sanitizeConfigName(rawConfigName) : "";
  const appid = String(identity?.appid || "").trim();
  const removedDedupByConfig = configName
    ? platinumDedup.delete(configName)
    : false;
  const removedDedupByApp = appid ? platinumDedup.delete(appid) : false;

  let removedPendingByConfig = 0;
  for (const [key, payload] of pendingPlatinumByConfig) {
    const safeKey = String(key || "").trim();
    if (
      (configName && sanitizeConfigName(safeKey) === configName) ||
      matchesPlatinumNotificationIdentity(payload, { configName, appid })
    ) {
      pendingPlatinumByConfig.delete(key);
      removedPendingByConfig += 1;
    }
  }

  const removedPendingNotification = matchesPlatinumNotificationIdentity(
    pendingPlatinumNotification,
    { configName, appid },
  );
  if (removedPendingNotification) {
    pendingPlatinumNotification = null;
    platinumAwaitingNormal = false;
    if (platinumFallbackTimer) {
      clearTimeout(platinumFallbackTimer);
      platinumFallbackTimer = null;
    }
  }

  let removedQueued = 0;
  for (let index = earnedNotificationQueue.length - 1; index >= 0; index -= 1) {
    if (
      matchesPlatinumNotificationIdentity(earnedNotificationQueue[index], {
        configName,
        appid,
      })
    ) {
      earnedNotificationQueue.splice(index, 1);
      removedQueued += 1;
    }
  }

  return {
    removedDedupByConfig,
    removedDedupByApp,
    removedPendingByConfig,
    removedPendingNotification,
    removedQueued,
  };
}

function isNativeWindowsNotificationPreset(preset) {
  return (
    String(preset || "")
      .trim()
      .toLowerCase() === NATIVE_WINDOWS_PRESET_NAME.toLowerCase()
  );
}

function pruneRecentAchievementNotificationKeys(now = Date.now()) {
  for (const [key, timestamp] of recentAchievementNotificationKeys) {
    if (now - timestamp > RECENT_ACHIEVEMENT_NOTIFICATION_DEDUPE_MS) {
      recentAchievementNotificationKeys.delete(key);
    }
  }
}

function buildAchievementNotificationDedupeKey(notificationData = {}) {
  const normalize = (value) =>
    String(value || "")
      .trim()
      .toLowerCase();
  return [
    normalize(notificationData.config_path || notificationData.configName),
    normalize(notificationData.displayName),
    normalize(notificationData.description),
    normalize(notificationData.icon || notificationData.icon_gray),
  ].join("::");
}

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

function normalizeNotificationRarityPercent(value) {
  const normalized = normalizeRarityPercent(value);
  if (normalized !== null) return normalized;
  if (typeof value !== "string") return null;
  const match = value.replace(",", ".").trim().match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  return normalizeRarityPercent(Number(match[0]));
}

function resolveNotificationRarityFromPayload(achievement = {}) {
  const rarityObject =
    achievement?.rarity && typeof achievement.rarity === "object"
      ? achievement.rarity
      : null;
  const candidates = [
    rarityObject?.pct,
    rarityObject?.percent,
    rarityObject?.value,
    achievement?.rarityPct,
    achievement?.rarity_percent,
    achievement?.unlockRate,
    achievement?.unlock_rate,
    achievement?.globalPercent,
    achievement?.global_percent,
    achievement?.percent,
    typeof achievement?.rarity === "number" ||
    typeof achievement?.rarity === "string"
      ? achievement.rarity
      : null,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeNotificationRarityPercent(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

function getNotificationAchievementKeys(achievement = {}) {
  const candidates = [
    achievement?.name,
    achievement?.api,
    achievement?.achievementName,
    achievement?.achievement_name,
    achievement?.achievementKey,
    achievement?.achievement_key,
    achievement?.key,
  ];
  const keys = [];
  for (const candidate of candidates) {
    const key = String(candidate ?? "").trim();
    if (!key || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

function getNotificationRaritySidecarPaths(achievement = {}) {
  const candidates = [];
  const add = (candidate) => {
    const normalized = String(candidate || "").trim();
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };
  const configPath = String(
    achievement?.config_path || achievement?.configPath || "",
  ).trim();
  const appid = String(achievement?.appid || achievement?.appId || "").trim();

  if (configPath) {
    const baseDir =
      path.extname(configPath).toLowerCase() === ".json"
        ? path.dirname(configPath)
        : configPath;
    add(path.join(baseDir, "achievementpercentages.json"));
    add(path.join(baseDir, "steam_settings", "achievementpercentages.json"));
    if (appid) {
      add(path.join(baseDir, appid, "achievementpercentages.json"));
    }
  }

  const configName =
    achievement?.configName ||
    achievement?.config_name ||
    achievement?.config ||
    "";
  const config = configName ? readConfigForAchievementCache(configName) : null;
  if (config) {
    const schemaPath = resolveAchievementsSchemaPath(config);
    if (schemaPath) {
      add(path.join(path.dirname(schemaPath), "achievementpercentages.json"));
    }
  }
  return candidates;
}

function resolveNotificationRarity(achievement = {}) {
  const direct = resolveNotificationRarityFromPayload(achievement);
  if (direct !== null) {
    return {
      percent: direct,
      source: String(achievement?.raritySource || "").trim() || null,
    };
  }

  const keys = getNotificationAchievementKeys(achievement);
  if (!keys.length) return { percent: null, source: null };
  for (const sidecarPath of getNotificationRaritySidecarPaths(achievement)) {
    try {
      const rarityInfo = readAchievementPercentagesMap(sidecarPath);
      if (!(rarityInfo?.map instanceof Map) || !rarityInfo.map.size) continue;
      const lowerMap = new Map(
        Array.from(rarityInfo.map.entries()).map(([name, percent]) => [
          String(name).toLowerCase(),
          percent,
        ]),
      );
      for (const key of keys) {
        const percent =
          rarityInfo.map.get(key) ?? lowerMap.get(key.toLowerCase()) ?? null;
        const normalized = normalizeNotificationRarityPercent(percent);
        if (normalized === null) continue;
        return {
          percent: normalized,
          source: rarityInfo.source || null,
        };
      }
    } catch (err) {
      notificationLogger.warn("notification:rarity-read-failed", {
        sidecarPath,
        error: err?.message || String(err),
      });
    }
  }
  return { percent: null, source: null };
}

function normalizeNotificationTrophyType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["platinum", "p"].includes(normalized)) return "platinum";
  if (["gold", "g"].includes(normalized)) return "gold";
  if (["silver", "s"].includes(normalized)) return "silver";
  if (["bronze", "b"].includes(normalized)) return "bronze";
  return "";
}

function isTrophyTierNotificationPlatform(platform) {
  const normalized = normalizePlatform(platform);
  return normalized === "rpcs3" || normalized === "shadps4";
}

function getEmulatorNotificationPreferencePrefix(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === "xenia") return "xenia";
  if (normalized === "rpcs3") return "rpcs3";
  if (normalized === "shadps4") return "shadps4";
  return "";
}

function queueAchievementNotification(achievement) {
  const prefs = cachedPreferences || {};
  const platform = normalizePlatform(achievement.platform) || null;
  const trophyType = normalizeNotificationTrophyType(
    achievement.trophyType || achievement.trophy_type,
  );
  const usesTrophyTier = isTrophyTierNotificationPlatform(platform);
  const emulatorPreferencePrefix = getEmulatorNotificationPreferencePrefix(platform);
  const usesEmulatorNotificationProfile = !!emulatorPreferencePrefix;
  const isPlatinum =
    achievement.isPlatinum === true ||
    achievement.__isPlatinum === true ||
    (usesTrophyTier && trophyType === "platinum");
  const isTest = achievement.isTest === true;
  const isTestRare = achievement.isTestRare === true;
  const hasExplicitRarity =
    normalizeNotificationRarityPercent(achievement?.rarityPct) !== null;
  const rarity = isPlatinum || (isTest && !isTestRare && !hasExplicitRarity)
    ? { percent: null, source: null }
    : resolveNotificationRarity(achievement);
  const isRare =
    !usesEmulatorNotificationProfile &&
    rarity.percent !== null &&
    rarity.percent >= 0 &&
    rarity.percent <= 10;
  const trophyRarityTier =
    usesTrophyTier && ["bronze", "silver", "gold"].includes(trophyType)
      ? trophyType
      : "";
  const rarityTier = trophyRarityTier || "";
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

  const normalPreset =
    achievement.preset || selectedPreset || prefs.preset || "default";
  const normalPosition =
    achievement.position ||
    selectedPosition ||
    prefs.position ||
    "center-bottom";
  const normalSound =
    achievement.sound || selectedSound || prefs.sound || "mute";
  const emulatorPreset = emulatorPreferencePrefix
    ? prefs[`${emulatorPreferencePrefix}Preset`] || normalPreset
    : normalPreset;
  const emulatorPosition = emulatorPreferencePrefix
    ? prefs[`${emulatorPreferencePrefix}Position`] || normalPosition
    : normalPosition;
  const emulatorSound = emulatorPreferencePrefix
    ? prefs[`${emulatorPreferencePrefix}Sound`] || normalSound
    : normalSound;
  const resolvedPreset = isPlatinum
    ? prefs.platinumPreset || normalPreset
    : isRare
      ? prefs.rarePreset || normalPreset
      : emulatorPreset;
  const resolvedPosition = isPlatinum
    ? prefs.platinumPosition || normalPosition
    : isRare
      ? prefs.rarePosition || normalPosition
      : emulatorPosition;
  const requestedSound = isPlatinum
    ? prefs.platinumSound || normalSound
    : isRare
      ? prefs.rareSound || normalSound
      : emulatorSound;
  const emulatorSanPreset = emulatorPreferencePrefix
    ? String(prefs[`${emulatorPreferencePrefix}SanPreset`] || "")
    : prefs.sanPreset || "";
  const preferenceSanPreset = isPlatinum
    ? String(prefs.platinumSanPreset || "")
    : isRare
      ? String(prefs.rareSanPreset || "")
      : emulatorSanPreset;
  const sanPresetCandidate = String(
    Object.prototype.hasOwnProperty.call(achievement, "sanPreset")
      ? achievement.sanPreset || ""
      : preferenceSanPreset || "",
  ).trim();
  const useSanPreset =
    (achievement.useSanPreset === true || prefs.useSanPreset === true) &&
    sanPresetCandidate;
  const usesNativeWindowsPreset =
    isNativeWindowsNotificationPreset(resolvedPreset);
  const resolvedSkipScreenshot =
    achievement.skipScreenshot === true
      ? true
      : prefs.disableAchievementScreenshot === true;

  const notificationData = {
    displayName: displayName || "",
    description: description || "",
    icon: achievement.icon,
    icon_gray: achievement.icon_gray || achievement.icongray,
    appid: achievement.appid || achievement.appId || null,
    platform,
    config_path: achievement.config_path,
    configName: achievement.configName || achievement.config_name || "",
    name: getNotificationAchievementKeys(achievement)[0] || "",
    rarityPct: rarity.percent,
    raritySource: rarity.source,
    rarityTier,
    trophyType,
    isRare,
    showRarityPercentage: prefs.showNotificationRarityPercentage !== false,
    preset: resolvedPreset,
    position: resolvedPosition,
    sound: requestedSound,
    sanPreset: !usesNativeWindowsPreset && useSanPreset ? sanPresetCandidate : "",
    useSanPreset: !usesNativeWindowsPreset && !!useSanPreset,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: resolvedSkipScreenshot,
    isPlatinum,
    isTest,
  };

  if (!notificationData.isTest && !isPlatinum) {
    const now = Date.now();
    pruneRecentAchievementNotificationKeys(now);
    const dedupeKey = buildAchievementNotificationDedupeKey(notificationData);
    if (dedupeKey && recentAchievementNotificationKeys.has(dedupeKey)) {
      notificationLogger.info("queue-achievement:deduped", {
        displayName: notificationData.displayName,
        config: notificationData.config_path || null,
      });
      return;
    }
    recentAchievementNotificationKeys.set(dedupeKey, now);
  }

  notificationData.sound = resolveNotificationSound(notificationData.sound, {
    isPlatinum,
    isRare,
    isTest: notificationData.isTest,
  });

  notificationLogger.info("queue-achievement", {
    displayName: notificationData.displayName,
    name: notificationData.name || null,
    rarityPct: notificationData.rarityPct,
    rarityTier: notificationData.rarityTier || null,
    trophyType: notificationData.trophyType || null,
    rare: notificationData.isRare,
    platinum: notificationData.isPlatinum === true,
    preset: notificationData.preset || "default",
    position: notificationData.position || "center-bottom",
    config: notificationData.config_path || null,
    test: notificationData.isTest || false,
  });
  if (!isPlatinum && pendingPlatinumNotification) {
    platinumAwaitingNormal = false;
  }
  earnedNotificationQueue.push(notificationData);
  processNextNotification();
}

function resolveGameHeaderPathForNotification(achievement = {}) {
  const appid = String(achievement.appid || achievement.appId || "").trim();
  if (!appid) return "";
  let platform = normalizePlatform(achievement.platform);
  if (!platform) {
    const configPath = String(achievement.config_path || "").trim();
    if (configPath && fs.existsSync(configPath)) {
      try {
        const rawConfig = fs.readFileSync(configPath, "utf8");
        const parsedConfig = JSON.parse(rawConfig);
        platform = normalizePlatform(parsedConfig?.platform);
      } catch {}
    }
  }
  if (!platform) return "";
  const headerPath = path.join(
    app.getPath("userData"),
    "images",
    platform,
    appid,
    "header.jpg",
  );
  try {
    return fs.existsSync(headerPath) ? headerPath : "";
  } catch {
    return "";
  }
}

function resolveGameCoverHeaderPathForNotification(
  achievement = {},
  { useRandomTestImage = false, useFallbackImage = true } = {},
) {
  if (useRandomTestImage) {
    return getRandomLocalHeaderImagePath({
      fallbackToDefault: useFallbackImage,
    });
  }

  const headerPath = resolveGameHeaderPathForNotification(achievement);
  if (headerPath) return headerPath;
  return useFallbackImage ? getNotificationFallbackHeaderPath() : "";
}

async function captureAchievementUnlockScreenshot(notificationData = {}) {
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
    const gameName =
      selectedConfig || notificationData.configName || "Unknown Game";
    const achName = notificationData.displayName || "Achievement";
    notificationLogger.info("notification:screenshot:start", {
      displayName: achName,
      config: notificationData.config_path || null,
    });
    const saved = await saveFullScreenShot(gameName, achName);
    notificationLogger.info("notification:screenshot:success", {
      displayName: achName,
      path: saved,
    });
  } catch (err) {
    const code = err?.code || null;
    const error = err?.message || String(err);
    const payload = {
      displayName: notificationData.displayName || "Achievement",
      code,
      error,
    };
    if (code === "capture-timeout") {
      notificationLogger.warn("notification:screenshot:timeout", payload);
    } else {
      notificationLogger.warn("notification:screenshot:failed", payload);
    }
  }
}

const NATIVE_WINDOWS_REFERENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_WINDOWS_REFERENCE_MAX_ENTRIES = 64;
const NATIVE_WINDOWS_QUEUE_INTERVAL_MS = 1250;
const NATIVE_WINDOWS_SHOW_WATCHDOG_MS = 3000;
const NATIVE_WINDOWS_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NATIVE_WINDOWS_ROUTE_MAX_ENTRIES = 200;
const nativeWindowsNotificationRoutes = new Map();
const animatedNotificationNavigationRoutes = new Map();
const nativeWindowsNotificationRoutesPath = path.join(
  path.dirname(preferencesPath),
  "native-notification-routes.json",
);
let nativeWindowsNotificationRoutesLoaded = false;
let nativeWindowsActivationHandlerRegistered = false;
const activeNativeAchievementNotifications =
  new NativeWindowsNotificationReferenceStore({
    maxEntries: NATIVE_WINDOWS_REFERENCE_MAX_ENTRIES,
    ttlMs: NATIVE_WINDOWS_REFERENCE_TTL_MS,
    onRelease: ({ token, reason, retainedMs, remaining }) => {
      notificationLogger.debug(
        "native-windows-notification:reference-released",
        { token, reason, retainedMs, remaining },
      );
    },
  });

function pruneNativeWindowsNotificationRoutes(now = Date.now()) {
  for (const [token, route] of nativeWindowsNotificationRoutes) {
    const createdAt = Number(route?.createdAt || 0);
    if (!createdAt || now - createdAt > NATIVE_WINDOWS_ROUTE_TTL_MS) {
      nativeWindowsNotificationRoutes.delete(token);
    }
  }
  if (nativeWindowsNotificationRoutes.size <= NATIVE_WINDOWS_ROUTE_MAX_ENTRIES)
    return;
  const ordered = Array.from(nativeWindowsNotificationRoutes.entries()).sort(
    (left, right) =>
      Number(left[1]?.createdAt || 0) - Number(right[1]?.createdAt || 0),
  );
  const removeCount = ordered.length - NATIVE_WINDOWS_ROUTE_MAX_ENTRIES;
  ordered.slice(0, removeCount).forEach(([token]) => {
    nativeWindowsNotificationRoutes.delete(token);
  });
}

function loadNativeWindowsNotificationRoutes() {
  if (nativeWindowsNotificationRoutesLoaded) return;
  nativeWindowsNotificationRoutesLoaded = true;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(nativeWindowsNotificationRoutesPath, "utf8"),
    );
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      const token = String(entry?.token || "").trim();
      const route = createAppNavigationRoute(entry, "native-notification");
      if (!token || !route) continue;
      nativeWindowsNotificationRoutes.set(token, {
        appid: route.appid,
        platform: route.platform,
        configName: route.configName,
        achievementId: route.achievementId,
        createdAt: Number(entry?.createdAt || 0),
      });
    }
    pruneNativeWindowsNotificationRoutes();
  } catch (err) {
    if (err?.code !== "ENOENT") {
      notificationLogger.warn("native-windows-route-store:load-failed", {
        error: err?.message || String(err),
      });
    }
  }
}

function persistNativeWindowsNotificationRoutes() {
  pruneNativeWindowsNotificationRoutes();
  const payload = {
    version: 1,
    entries: Array.from(nativeWindowsNotificationRoutes.entries()).map(
      ([token, route]) => ({ token, ...route }),
    ),
  };
  const tempPath = `${nativeWindowsNotificationRoutesPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(nativeWindowsNotificationRoutesPath), {
      recursive: true,
    });
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tempPath, nativeWindowsNotificationRoutesPath);
  } catch (err) {
    try {
      fs.writeFileSync(
        nativeWindowsNotificationRoutesPath,
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    } catch {}
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    notificationLogger.warn("native-windows-route-store:save-failed", {
      error: err?.message || String(err),
    });
  }
}

function clearNativeWindowsNotificationRoutes(reason = "unknown") {
  loadNativeWindowsNotificationRoutes();
  if (!nativeWindowsNotificationRoutes.size) return;
  const removed = nativeWindowsNotificationRoutes.size;
  nativeWindowsNotificationRoutes.clear();
  persistNativeWindowsNotificationRoutes();
  notificationLogger.info("notification-navigation:native-routes-cleared", {
    reason,
    removed,
  });
}

function createNotificationNavigationRoute(
  notificationData = {},
  source = "notification",
) {
  if (notificationData?.isTest === true) return null;
  const route = createAppNavigationRoute(
    {
      appid: notificationData?.appid,
      platform: notificationData?.platform,
      configName:
        notificationData?.configName || notificationData?.config_name,
      achievementId: notificationData?.name,
    },
    source,
  );
  return route?.achievementId ? route : null;
}

function registerNativeWindowsNotificationRoute(token, notificationData = {}) {
  if (!token || !isNotificationClickRedirectEnabled()) return false;
  const route = createNotificationNavigationRoute(
    notificationData,
    "native-notification",
  );
  if (!route) return false;
  loadNativeWindowsNotificationRoutes();
  nativeWindowsNotificationRoutes.set(token, {
    appid: route.appid,
    platform: route.platform,
    configName: route.configName,
    achievementId: route.achievementId,
    createdAt: Date.now(),
  });
  persistNativeWindowsNotificationRoutes();
  return true;
}

function removeNativeWindowsNotificationRoute(token) {
  if (!token || !nativeWindowsNotificationRoutes.delete(token)) return;
  persistNativeWindowsNotificationRoutes();
}

function findNativeWindowsNotificationRoute(rawArguments) {
  const raw = String(rawArguments || "").trim();
  if (!raw) return null;

  const embedded = decodeNativeWindowsNotificationLaunchArguments(raw);
  if (embedded) {
    const route = createAppNavigationRoute(
      embedded.route,
      "native-notification-activation",
    );
    if (route?.achievementId) {
      return { token: embedded.token, route };
    }
  }

  loadNativeWindowsNotificationRoutes();
  const candidates = new Set([raw]);
  try {
    candidates.add(decodeURIComponent(raw));
  } catch {}
  try {
    const parsed = JSON.parse(raw);
    [parsed?.token, parsed?.id, parsed?.notificationId, parsed?.arguments]
      .filter(Boolean)
      .forEach((value) => candidates.add(String(value)));
  } catch {}
  for (const [token, route] of nativeWindowsNotificationRoutes) {
    if (
      Array.from(candidates).some(
        (candidate) => candidate === token || candidate.includes(token),
      )
    ) {
      return { token, route };
    }
  }
  return null;
}

function dispatchNotificationNavigation(route, options = {}) {
  const source = String(options?.source || route?.source || "notification");
  const token = String(options?.token || "").trim();
  if (!route || !isNotificationClickRedirectEnabled()) {
    notificationLogger.info("notification-navigation:ignored", {
      source,
      reason: route ? "disabled" : "invalid-route",
    });
    return false;
  }
  if (token) {
    const dedupeKey = `notification:${token}`;
    const now = Date.now();
    pruneRecentAppNavigationKeys(now);
    const previous = recentAppNavigationKeys.get(dedupeKey) || 0;
    if (now - previous <= 5000) {
      notificationLogger.info("notification-navigation:deduped", {
        source,
        token,
      });
      return false;
    }
    recentAppNavigationKeys.set(dedupeKey, now);
  }
  const target = getNotificationClickRedirectTarget();
  notificationLogger.info("notification-navigation:click", {
    source,
    target,
    configName: route?.configName || null,
    appid: route?.appid || null,
    platform: route?.platform || null,
    achievementId: route?.achievementId || null,
  });
  if (target === "overlay") {
    return requestOverlayNotificationNavigation(route, { source, token });
  }
  return requestAppNavigation(route, {
    source,
    showWindow: true,
  });
}

function initializeNativeWindowsActivationHandler() {
  if (
    nativeWindowsActivationHandlerRegistered ||
    process.platform !== "win32" ||
    typeof Notification.handleActivation !== "function"
  ) {
    return;
  }
  nativeWindowsActivationHandlerRegistered = true;
  loadNativeWindowsNotificationRoutes();
  if (!isNotificationClickRedirectEnabled()) {
    clearNativeWindowsNotificationRoutes("startup-disabled");
  }
  Notification.handleActivation((details = {}) => {
    const activationType = String(details?.type || "").toLowerCase();
    notificationLogger.info("native-windows-notification:activation-received", {
      type: activationType || null,
      hasArguments: !!String(details?.arguments || "").trim(),
    });
    if (activationType !== "click") {
      notificationLogger.info("native-windows-notification:activation-ignored", {
        reason: "unsupported-type",
        type: activationType || null,
      });
      return;
    }
    if (!isNotificationClickRedirectEnabled()) {
      notificationLogger.info(
        "native-windows-notification:activation-ignored",
        { reason: "redirect-disabled" },
      );
      return;
    }
    const match = findNativeWindowsNotificationRoute(details?.arguments);
    if (!match) {
      notificationLogger.warn("native-windows-notification:activation-unmatched", {
        hasArguments: !!String(details?.arguments || "").trim(),
      });
      return;
    }
    notificationLogger.info("native-windows-notification:activated", {
      token: match.token,
      configName: match.route?.configName || null,
      achievementId: match.route?.achievementId || null,
      coldStart: !mainWindow || mainWindow.isDestroyed(),
    });
    dispatchNotificationNavigation(match.route, {
      token: match.token,
      source: "native-notification-activation",
    });
    setImmediate(() => {
      activeNativeAchievementNotifications.release(
        match.token,
        "global-activation",
      );
    });
  });
  notificationLogger.info("native-windows-notification:activation-handler-ready", {
    toastActivatorCLSID: app.toastActivatorCLSID || null,
  });
}

function removeAnimatedNotificationNavigationRoute(webContentsId) {
  const id = Number(webContentsId);
  if (!Number.isFinite(id)) return;
  animatedNotificationNavigationRoutes.delete(id);
}

function disableActiveAnimatedNotificationNavigation(reason = "unknown") {
  if (!animatedNotificationNavigationRoutes.size) return;
  const entries = Array.from(animatedNotificationNavigationRoutes.entries());
  animatedNotificationNavigationRoutes.clear();
  for (const [, entry] of entries) {
    const notificationWindow = entry?.window;
    if (!notificationWindow || notificationWindow.isDestroyed()) continue;
    try {
      notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    } catch {}
    try {
      if (!notificationWindow.webContents.isDestroyed()) {
        notificationWindow.webContents.send("notification-navigation:disable");
      }
    } catch {}
  }
  notificationLogger.info("notification-navigation:animated-disabled", {
    reason,
    windows: entries.length,
  });
}

function registerAnimatedNotificationNavigation(
  notificationWindow,
  notificationData = {},
) {
  if (
    !notificationWindow ||
    notificationWindow.isDestroyed() ||
    !isNotificationClickRedirectEnabled()
  ) {
    return false;
  }
  const route = createNotificationNavigationRoute(
    notificationData,
    "animated-notification",
  );
  if (!route) return false;
  const webContentsId = notificationWindow.webContents.id;
  animatedNotificationNavigationRoutes.set(webContentsId, {
    route,
    window: notificationWindow,
    createdAt: Date.now(),
  });

  const enableClick = () => {
    const entry = animatedNotificationNavigationRoutes.get(webContentsId);
    if (
      !entry ||
      !isNotificationClickRedirectEnabled() ||
      notificationWindow.isDestroyed() ||
      notificationWindow.webContents.isDestroyed()
    ) {
      removeAnimatedNotificationNavigationRoute(webContentsId);
      return;
    }
    try {
      notificationWindow.webContents.send("notification-navigation:enable");
      notificationWindow.setIgnoreMouseEvents(false);
      notificationLogger.info("notification-navigation:animated-enabled", {
        webContentsId,
        configName: route.configName || null,
        achievementId: route.achievementId || null,
      });
    } catch (error) {
      removeAnimatedNotificationNavigationRoute(webContentsId);
      notificationLogger.warn("notification-navigation:animated-enable-failed", {
        webContentsId,
        error: error?.message || String(error),
      });
    }
  };

  if (notificationWindow.webContents.isLoading()) {
    notificationWindow.webContents.once("did-finish-load", enableClick);
  } else {
    enableClick();
  }
  notificationWindow.once("closed", () => {
    removeAnimatedNotificationNavigationRoute(webContentsId);
  });
  return true;
}

ipcMain.on("notification-navigation:click", (event) => {
  const webContentsId = Number(event?.sender?.id);
  const entry = animatedNotificationNavigationRoutes.get(webContentsId);
  if (!entry) return;
  animatedNotificationNavigationRoutes.delete(webContentsId);
  const notificationWindow = entry.window;
  try {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  } catch {}

  dispatchNotificationNavigation(entry.route, {
    token: `animated-${webContentsId}-${entry.createdAt}`,
    source: "animated-notification-click",
  });

  try {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  } catch {}
});

function buildNativeWindowsNotificationGroupId(notificationData = {}) {
  const source =
    notificationData.config_path ||
    notificationData.configName ||
    notificationData.appid ||
    "achievements";
  return crypto
    .createHash("sha256")
    .update(String(source))
    .digest("hex")
    .slice(0, 32);
}

function formatNativeWindowsNotificationRarity(notificationData = {}) {
  if (
    notificationData.showRarityPercentage !== true ||
    notificationData.isPlatinum === true
  ) {
    return "";
  }
  const rarityPct = normalizeNotificationRarityPercent(
    notificationData.rarityPct,
  );
  if (rarityPct === null) return "";
  const formatted = Number(rarityPct.toFixed(2)).toString();
  const label = tUi("overlay.rarityLabel", {}, "Rarity");
  return `${label}: ${formatted}%`;
}

function invokeNativeWindowsNotificationCallback(callback, ...args) {
  if (typeof callback !== "function") return;
  try {
    callback(...args);
  } catch (error) {
    notificationLogger.warn("native-windows-notification:callback-failed", {
      error: error?.message || String(error),
    });
  }
}

function showNativeWindowsAchievementNotification(
  notificationData = {},
  callbacks = {},
) {
  if (
    process.platform !== "win32" ||
    !Notification ||
    typeof Notification.isSupported !== "function" ||
    !Notification.isSupported()
  ) {
    notificationLogger.warn("native-windows-notification:unsupported", {
      platform: process.platform,
    });
    return null;
  }

  const iconPath =
    notificationData.iconPath && fs.existsSync(notificationData.iconPath)
      ? notificationData.iconPath
      : ICON_PATH;
  const title = notificationData.displayName || "Achievement";
  const body = [
    notificationData.description || notificationData.configName || "",
    formatNativeWindowsNotificationRarity(notificationData),
  ]
    .filter(Boolean)
    .join("\n");
  const groupId = buildNativeWindowsNotificationGroupId(notificationData);
  const notificationId = `ach-${crypto
    .createHash("sha1")
    .update(
      [
        notificationData.config_path || "",
        notificationData.name || "",
        notificationData.displayName || "",
        Date.now(),
      ].join("::"),
    )
    .digest("hex")}`;
  const hasNavigationRoute = registerNativeWindowsNotificationRoute(
    notificationId,
    notificationData,
  );
  const registeredNavigationRoute = hasNavigationRoute
    ? nativeWindowsNotificationRoutes.get(notificationId) || null
    : null;

  let nativeNotification = null;
  const releaseReference = (reason) =>
    activeNativeAchievementNotifications.release(
      notificationId,
      reason,
      nativeNotification,
    );

  try {
    const notificationOptions = {
      id: notificationId,
      groupId,
      groupTitle: notificationData.configName || "Achievements",
    };
    if (hasNavigationRoute && registeredNavigationRoute) {
      const launchArguments =
        encodeNativeWindowsNotificationLaunchArguments({
          token: notificationId,
          ...registeredNavigationRoute,
        });
      notificationOptions.toastXml = buildNativeWindowsAchievementToastXml({
        launchArguments,
        groupId,
        groupTitle: notificationData.configName || "Achievements",
        title,
        body,
        iconUrl: pathToFileURL(iconPath).toString(),
      });
    } else {
      Object.assign(notificationOptions, {
        title,
        body,
        icon: iconPath,
        silent: true,
        timeoutType: "default",
        urgency: "normal",
      });
    }

    nativeNotification = new Notification(notificationOptions);

    if (hasNavigationRoute) {
      activeNativeAchievementNotifications.retain(
        notificationId,
        nativeNotification,
      );
      notificationLogger.debug(
        "native-windows-notification:reference-retained",
        {
          token: notificationId,
          retained: activeNativeAchievementNotifications.size,
          maxEntries: NATIVE_WINDOWS_REFERENCE_MAX_ENTRIES,
          ttlMs: NATIVE_WINDOWS_REFERENCE_TTL_MS,
        },
      );
    }

    nativeNotification.once("show", () => {
      notificationLogger.info("native-windows-notification:show", {
        displayName: notificationData.displayName,
        config: notificationData.config_path || null,
        groupId,
        navigationEnabled: hasNavigationRoute,
      });
      invokeNativeWindowsNotificationCallback(callbacks.onShow);
    });
    nativeNotification.once("click", () => {
      releaseReference("instance-click");
      if (!hasNavigationRoute) return;
      const route =
        registeredNavigationRoute ||
        nativeWindowsNotificationRoutes.get(notificationId);
      notificationLogger.info("native-windows-notification:click", {
        token: notificationId,
        configName: route?.configName || null,
        achievementId: route?.achievementId || null,
      });
      dispatchNotificationNavigation(route, {
        token: notificationId,
        source: "native-notification-click",
      });
    });
    nativeNotification.once("failed", (_event, error) => {
      releaseReference("failed");
      if (hasNavigationRoute) {
        removeNativeWindowsNotificationRoute(notificationId);
      }
      notificationLogger.warn("native-windows-notification:failed", {
        displayName: notificationData.displayName,
        error: error || null,
      });
      invokeNativeWindowsNotificationCallback(callbacks.onFailed, error);
    });
    nativeNotification.once("close", (details) => {
      const reason = details?.reason || null;
      const retainedForActionCenter =
        hasNavigationRoute && reason === "timedOut";
      if (!retainedForActionCenter) {
        releaseReference(`closed:${reason || "unknown"}`);
      }
      if (hasNavigationRoute && reason === "userCanceled") {
        removeNativeWindowsNotificationRoute(notificationId);
      }
      notificationLogger.info("native-windows-notification:closed", {
        displayName: notificationData.displayName,
        reason,
        retainedForActionCenter,
      });
      invokeNativeWindowsNotificationCallback(callbacks.onClose, reason);
    });
    nativeNotification.show();
    return nativeNotification;
  } catch (error) {
    releaseReference("show-failed");
    if (hasNavigationRoute) {
      removeNativeWindowsNotificationRoute(notificationId);
    }
    notificationLogger.warn("native-windows-notification:show-failed", {
      displayName: notificationData.displayName,
      error: error?.message || String(error),
    });
    return null;
  }
}

function playAchievementNotificationSound(achievement = {}) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    achievement.sound &&
    achievement.sound !== "mute"
  ) {
    mainWindow.webContents.send("play-sound", achievement.sound);
  }
}

function showCustomAchievementNotification({
  achievement,
  notificationData,
  duration,
  shouldScreenshot,
  playSound = true,
  onFinished,
}) {
  let notificationWindow = null;
  try {
    notificationWindow = createNotificationWindow(notificationData);
    registerAnimatedNotificationNavigation(
      notificationWindow,
      notificationData,
    );
  } catch (error) {
    notificationLogger.warn("show-notification:custom-create-failed", {
      displayName: notificationData.displayName,
      preset: notificationData.preset || "default",
      error: error?.message || String(error),
    });
    onFinished();
    return null;
  }

  const notificationWebContentsId = notificationWindow.webContents.id;
  if (playSound) {
    playAchievementNotificationSound(achievement);
  }

  if (shouldScreenshot) {
    const armScreenshot = () =>
      armPendingNotificationScreenshot(
        notificationWindow,
        () => captureAchievementUnlockScreenshot(notificationData),
        notificationData.durationMs,
      );
    if (notificationWindow.webContents.isLoading()) {
      notificationWindow.webContents.once("did-finish-load", armScreenshot);
    } else {
      armScreenshot();
    }
  }

  let closeTimer = null;
  notificationWindow.on("closed", () => {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    clearPendingNotificationScreenshot(notificationWebContentsId);
    windowLogger.info("create-notification-window:closed", {
      preset: notificationData.preset || "default",
      position: notificationData.position || "center-bottom",
    });
    onFinished();
  });

  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (!notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  }, duration);
  return notificationWindow;
}

function processNextNotification() {
  if (isNotificationShowing || earnedNotificationQueue.length === 0) return;

  const achievement = earnedNotificationQueue.shift();
  isNotificationShowing = true;
  let queueEntryFinished = false;
  const finishCurrentNotification = () => {
    if (queueEntryFinished) return;
    queueEntryFinished = true;
    isNotificationShowing = false;
    processNextNotification();
    flushPendingPlatinum();
  };

  const lang = selectedLanguage || "english";

  const notificationData = {
    name: achievement.name || "",
    displayName: achievement.displayName,
    description: achievement.description,
    icon: achievement.icon,
    icon_gray: achievement.icon_gray,
    appid: achievement.appid || achievement.appId || null,
    platform: normalizePlatform(achievement.platform) || null,
    config_path: achievement.config_path,
    configName: achievement.configName || "",
    rarityPct: achievement.rarityPct,
    raritySource: achievement.raritySource || null,
    rarityTier: achievement.rarityTier || "",
    trophyType: achievement.trophyType || "",
    isRare: achievement.isRare === true,
    showRarityPercentage:
      cachedPreferences.showNotificationRarityPercentage !== false,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    sanPreset: achievement.sanPreset || "",
    useSanPreset: achievement.useSanPreset === true,
    scale: parseFloat(achievement.scale || 1),
    skipScreenshot: !!achievement.skipScreenshot,
    isPlatinum:
      achievement.isPlatinum === true || achievement.__isPlatinum === true,
    isTest: !!achievement.isTest,
  };

  const preset = achievement.preset || "default";
  const normalizedPreset = String(preset || "").trim().toLowerCase();
  const isNativeWindowsPreset = isNativeWindowsNotificationPreset(preset);
  const { presetFolder } = isNativeWindowsPreset
    ? { presetFolder: null }
    : resolveNotificationPresetFolder(preset);

  if (
    !isNativeWindowsPreset &&
    notificationData.useSanPreset &&
    notificationData.sanPreset
  ) {
    try {
      const sanTheme = buildSanThemeForNotification(
        notificationData.sanPreset,
        notificationData.scale,
      );
      if (sanTheme) {
        notificationData.sanTheme = sanTheme;
        notificationData.scale = 1;
      }
    } catch (err) {
      notificationLogger.warn("san-notification:theme-load-failed", {
        sanPreset: notificationData.sanPreset,
        error: err?.message || String(err),
      });
    }
  }

  const iconCandidate = notificationData.icon || notificationData.icon_gray;
  let iconPathFinal = resolveIconAbsolutePath(
    notificationData.config_path,
    iconCandidate,
  );

  if (
    !isNativeWindowsPreset &&
    notificationData.isPlatinum &&
    ["xbox series platinum - purple", "xbox series platinum"].includes(
      normalizedPreset,
    )
  ) {
    const diamondIconPath = path.join(presetFolder, "diamond.gif");
    try {
      if (fs.existsSync(diamondIconPath)) {
        iconPathFinal = diamondIconPath;
      }
    } catch {}
  }

  if (!iconPathFinal) {
    iconPathFinal = ICON_PATH;
  }
  notificationData.iconPath = iconPathFinal;
  if (normalizedPreset === "game cover") {
    const headerPath = resolveGameCoverHeaderPathForNotification(achievement, {
      useRandomTestImage: notificationData.isTest === true,
      useFallbackImage: true,
    });
    if (headerPath) {
      notificationData.headerPath = headerPath;
    }
  } else if (normalizedPreset === "game header") {
    const headerPath = resolveGameHeaderPathForNotification(achievement);
    if (headerPath) {
      notificationData.headerPath = headerPath;
    }
  }
  notificationLogger.info("show-notification", {
    displayName: notificationData.displayName,
    preset: notificationData.preset || "default",
    sanPreset: notificationData.sanPreset || null,
    position: notificationData.position || "center-bottom",
    showRarityPercentage: notificationData.showRarityPercentage,
    config: notificationData.config_path || null,
    iconResolved: iconPathFinal,
  });

  const overrideDurationSec = Number(cachedPreferences?.notificationDuration);
  const overrideDurationMs =
    Number.isFinite(overrideDurationSec) && overrideDurationSec > 0
      ? Math.round(overrideDurationSec * 1000)
      : 0;
  const duration =
    overrideDurationMs ||
    (isNativeWindowsPreset
      ? 5000
      : notificationData.sanTheme
      ? Math.round(
          (Number(notificationData.sanTheme?.customisation?.displaytime) || 8) *
            1000,
        )
      : getPresetAnimationDuration(presetFolder));
  notificationData.durationMs = duration;
  notificationData.durationOverridden = overrideDurationMs > 0;
  if (notificationData.sanTheme?.customisation) {
    notificationData.sanTheme.customisation.displaytime = Math.max(
      1,
      duration / 1000,
    );
  }
  const disableByPrefs = !!cachedPreferences.disableAchievementScreenshot;
  const shouldScreenshot =
    !notificationData.isTest &&
    !notificationData.skipScreenshot &&
    !disableByPrefs;

  if (isNativeWindowsPreset) {
    let nativeCompletionTimer = null;
    let nativeFallbackStarted = false;
    let nativeActionsStarted = false;
    let nativeShowReceived = false;
    const clearNativeCompletionTimer = () => {
      if (!nativeCompletionTimer) return;
      clearTimeout(nativeCompletionTimer);
      nativeCompletionTimer = null;
    };
    const scheduleNativeCompletion = (delayMs, reason) => {
      clearNativeCompletionTimer();
      nativeCompletionTimer = setTimeout(() => {
        nativeCompletionTimer = null;
        if (reason === "no-show-signal") {
          notificationLogger.warn(
            "native-windows-notification:no-show-signal",
            {
              displayName: notificationData.displayName,
              config: notificationData.config_path || null,
            },
          );
        }
        finishCurrentNotification();
      }, delayMs);
      nativeCompletionTimer.unref?.();
    };
    const startNativeFallback = (reason, error = null) => {
      if (nativeFallbackStarted || queueEntryFinished) return;
      nativeFallbackStarted = true;
      clearNativeCompletionTimer();
      notificationData.preset = "Default";
      const { presetFolder: fallbackPresetFolder } =
        resolveNotificationPresetFolder(notificationData.preset);
      const fallbackDuration =
        overrideDurationMs ||
        getPresetAnimationDuration(fallbackPresetFolder);
      notificationData.durationMs = fallbackDuration;
      notificationData.durationOverridden = overrideDurationMs > 0;
      notificationLogger.warn("native-windows-notification:fallback", {
        displayName: notificationData.displayName,
        reason,
        error: error ? error?.message || String(error) : null,
      });
      showCustomAchievementNotification({
        achievement,
        notificationData,
        duration: fallbackDuration,
        shouldScreenshot: shouldScreenshot && !nativeActionsStarted,
        playSound: !nativeActionsStarted,
        onFinished: finishCurrentNotification,
      });
    };

    const nativeNotification = showNativeWindowsAchievementNotification(
      notificationData,
      {
        onShow: () => {
          if (nativeFallbackStarted || queueEntryFinished) return;
          nativeShowReceived = true;
          scheduleNativeCompletion(
            NATIVE_WINDOWS_QUEUE_INTERVAL_MS,
            "shown",
          );
        },
        onFailed: (error) => {
          startNativeFallback("failed-event", error);
        },
        onClose: () => {
          if (!nativeFallbackStarted) {
            clearNativeCompletionTimer();
            finishCurrentNotification();
          }
        },
      },
    );

    if (!nativeNotification) {
      startNativeFallback("show-failed");
      return;
    }
    if (nativeFallbackStarted || queueEntryFinished) {
      return;
    }
    nativeActionsStarted = true;
    playAchievementNotificationSound(achievement);
    if (shouldScreenshot) {
      notificationLogger.info("notification:screenshot-trigger", {
        reason: "native-windows",
      });
      setImmediate(() => {
        void captureAchievementUnlockScreenshot(notificationData);
      });
    }
    if (
      !nativeFallbackStarted &&
      !nativeShowReceived &&
      !queueEntryFinished
    ) {
      scheduleNativeCompletion(
        NATIVE_WINDOWS_SHOW_WATCHDOG_MS,
        "no-show-signal",
      );
    }
    return;
  }

  showCustomAchievementNotification({
    achievement,
    notificationData,
    duration,
    shouldScreenshot,
    onFinished: finishCurrentNotification,
  });
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
  const isTestProgress = data?.isTestProgress === true;
  if (!isTestProgress && global.disableProgress) return;
  if (!isTestProgress && isProgressMutedByPrefs(cachedPreferences, data)) {
    notificationLogger.info("queue-progress:muted", {
      displayName: data?.displayName || "",
      config: data?.config_path || null,
    });
    return;
  }
  const scale =
    data?.scale != null
      ? normalizeNotificationScale(data.scale).scale
      : normalizeNotificationScale(
          cachedPreferences?.notificationScale ?? 1,
        ).scale;
  data = { ...(data || {}), scale };
  notificationLogger.info("queue-progress", {
    displayName: data?.displayName || "",
    progress: data?.progress ?? null,
    max: data?.max_progress ?? null,
    config: data?.config_path || null,
    scale,
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

function makeCacheKey(configName, platform = "steam", options = null) {
  const safeName = sanitizeConfigName(configName || "") || "unknown";
  const safePlatform = normalizePlatform(platform) || "steam";
  const parts = [safeName, safePlatform];
  const scopedAccountId = resolveScopedAchievementCacheAccountId(
    configName,
    safePlatform,
    options,
  );
  if (scopedAccountId) {
    parts.push(`acct_${scopedAccountId}`);
  }
  const shadPs4UserId = resolveShadPs4AchievementCacheUserId(
    configName,
    safePlatform,
    options,
  );
  if (shadPs4UserId) {
    parts.push(`user_${shadPs4UserId}`);
  }
  return parts.join("_");
}

function getCachePath(configName, platform = "steam", options = null) {
  const key = makeCacheKey(configName, platform, options).replace(
    /[:\\/]+/g,
    "_",
  );
  return path.join(cacheDir, `${key}_achievements_cache.json`);
}

function listScopedAchievementCachePaths(configName, platform = "steam") {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (
    normalizedPlatform !== "steam-official" &&
    normalizedPlatform !== "epic-official" &&
    normalizedPlatform !== "shadps4"
  ) {
    const exactPath = getCachePath(configName, normalizedPlatform);
    return exactPath ? [exactPath] : [];
  }
  const safeName = sanitizeConfigName(configName || "") || "unknown";
  const baseKey = [safeName, normalizedPlatform]
    .join("_")
    .replace(/[:\\/]+/g, "_");
  if (!cacheDir || !fs.existsSync(cacheDir)) return [];
  const escapedBaseKey = baseKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(
    `^${escapedBaseKey}(?:_acct_[A-Za-z0-9-]+)?(?:_user_[A-Za-z0-9._-]+)?_achievements_cache\\.json$`,
    "i",
  );
  try {
    return fs
      .readdirSync(cacheDir)
      .filter((entry) => rx.test(String(entry || "")))
      .map((entry) => path.join(cacheDir, entry));
  } catch {
    return [];
  }
}

function listScopedSteamOfficialCachePaths(configName, platform = "steam") {
  return listScopedAchievementCachePaths(configName, platform);
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
let achCacheMetaDirty = false;
let achCacheMetaSaveTimer = null;

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

function scheduleAchCacheMetaSave() {
  if (!achCacheMetaPath) return;
  achCacheMetaDirty = true;
  if (achCacheMetaSaveTimer) {
    clearTimeout(achCacheMetaSaveTimer);
  }
  achCacheMetaSaveTimer = setTimeout(() => {
    if (!achCacheMetaDirty) return;
    achCacheMetaDirty = false;
    try {
      const payload = {
        version: 1,
        files: Object.fromEntries(achCacheMeta),
      };
      fs.mkdirSync(path.dirname(achCacheMetaPath), { recursive: true });
      writeJsonAtomicSync(achCacheMetaPath, payload);
    } catch {}
  }, 500);
}

function updateAchCacheMetaEntry(configName, platform, filePath, appid = "") {
  const key = getAchCacheMetaKey(configName, platform, filePath, appid);
  if (!key || !filePath) return;
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  const mtimeMs = Number(stat.mtimeMs ?? 0);
  const size = Number(stat.size ?? 0);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return;
  loadAchCacheMetaOnce();
  achCacheMeta.set(key, { mtimeMs, size });
  scheduleAchCacheMetaSave();
}

function resolveBootSeedCandidatePath(config) {
  const savePathRaw = config?.save_path;
  if (!savePathRaw) return null;
  const normalizedPlatform = normalizePlatform(config?.platform) || "steam";
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
    if (normalizedPlatform === "epic-official") return null;
    if (normalizedPlatform === "gog-official") {
      const resolved = resolveGogOfficialGameplayDbForConfig(config);
      if (resolved?.gameplayDbPath && fs.existsSync(resolved.gameplayDbPath)) {
        return resolved.gameplayDbPath;
      }
      const directGameplayDb = path.join(saveRoot, "gameplay.db");
      if (fs.existsSync(directGameplayDb)) {
        return directGameplayDb;
      }
    }
    if (normalizedPlatform === "ubisoft-official") {
      const resolved = resolveUbisoftOfficialSpoolFileForConfig(config);
      if (resolved?.spoolFilePath && fs.existsSync(resolved.spoolFilePath)) {
        return resolved.spoolFilePath;
      }
      const directSpoolFile = appid
        ? path.join(saveRoot, `${appid}.spool`)
        : "";
      if (directSpoolFile && fs.existsSync(directSpoolFile)) {
        return directSpoolFile;
      }
    }
    if (normalizedPlatform === "ea-official") {
      const resolved = resolveEaOfficialVerboseLogForConfig(config);
      if (resolved?.logFilePath && fs.existsSync(resolved.logFilePath)) {
        return resolved.logFilePath;
      }
      const directVerboseLog = path.join(saveRoot, EA_VERBOSE_LOG_NAME);
      if (fs.existsSync(directVerboseLog)) {
        return directVerboseLog;
      }
    }
    const saveJsonPath = resolveSaveFilePath(saveRoot, appid);
    const {
      tenokeIni: tenokeIniPath,
      ini: iniPath,
      ofx: onlineFixIniPath,
      ofxStats: onlineFixStatsPath,
      bin: binPath,
    } = resolveSaveSidecarPaths(saveRoot, appid);
    if (fs.existsSync(saveJsonPath)) candidatePath = saveJsonPath;
    else if (tenokeIniPath) candidatePath = tenokeIniPath;
    else if (onlineFixIniPath) candidatePath = onlineFixIniPath;
    else if (onlineFixStatsPath) candidatePath = onlineFixStatsPath;
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
  const cfgPath = resolveConfigJsonPath(configsDir, configName);
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

async function loadPreviousAchievements(
  configName,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  const resolvedOptions = normalizeAchievementCacheOptions(options);
  const scopedAccountId = resolveScopedAchievementCacheAccountId(
    configName,
    normalizedPlatform,
    resolvedOptions,
  );
  const scopedShadPs4UserId = resolveShadPs4AchievementCacheUserId(
    configName,
    normalizedPlatform,
    resolvedOptions,
  );
  const effectiveOptions = scopedAccountId
    ? { ...resolvedOptions, accountId: scopedAccountId }
    : resolvedOptions;
  const cachePath = getCachePath(
    configName,
    normalizedPlatform,
    effectiveOptions,
  );
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
  if (
    !(
      (normalizedPlatform === "steam-official" ||
        normalizedPlatform === "epic-official") &&
      scopedAccountId
    ) &&
    !(normalizedPlatform === "shadps4" && scopedShadPs4UserId)
  ) {
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
  }

  // Alias fallback: some configs (notably steam-official) historically seeded caches under a
  // different key (e.g. config.displayName/config.name), while the UI uses the config filename.
  // On a miss, probe aliases from the config JSON and write-through to the canonical path.
  try {
    const safeName = sanitizeConfigName(configName || "");
    const configPath = safeName
      ? resolveConfigJsonPath(configsDir, configName)
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
        const altPath = getCachePath(
          altName,
          normalizedPlatform,
          effectiveOptions,
        );
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

function savePreviousAchievements(
  configName,
  data,
  platform = "steam",
  options = null,
) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  const resolvedOptions = normalizeAchievementCacheOptions(options);
  const scopedAccountId = resolveScopedAchievementCacheAccountId(
    configName,
    normalizedPlatform,
    resolvedOptions,
  );
  const effectiveOptions = scopedAccountId
    ? { ...resolvedOptions, accountId: scopedAccountId }
    : resolvedOptions;
  const cachePath = getCachePath(
    configName,
    normalizedPlatform,
    effectiveOptions,
  );
  try {
    let effectiveData = data;
    const existing = readCacheSilent(
      configName,
      normalizedPlatform,
      effectiveOptions,
    );
    if (
      existing &&
      typeof existing === "object" &&
      resolvedOptions.skipManualMerge !== true
    ) {
      effectiveData = mergeManualAchievementOverrides(effectiveData, existing);
    }
    if (isRpcs3ConfigName(configName) || isLumaPlayConfigName(configName)) {
      if (existing && typeof existing === "object") {
        effectiveData = mergeEarnedTimeFromCached(effectiveData, existing);
      }
    }
    const ordered = {};
    const keys = Object.keys(effectiveData || {});
    const known = new Set([
      "earned",
      "earned_time",
      "max_progress",
      "progress",
      "progress_is_float",
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
      if (Object.prototype.hasOwnProperty.call(entry, "progress_is_float")) {
        normalized.progress_is_float = entry.progress_is_float;
      }
      for (const [k, v] of Object.entries(entry)) {
        if (known.has(k)) continue;
        normalized[k] = v;
      }
      ordered[key] = normalized;
    }
    if (existing && deepEqual(existing, ordered)) {
      return false;
    }
    writeJsonAtomicSync(cachePath, ordered);
    persistenceLogger.info("save-achievement-cache", {
      config: configName,
      path: cachePath,
      steamOfficialAccountId:
        normalizedPlatform === "steam-official"
          ? effectiveOptions.accountId || null
          : null,
      epicOfficialAccountId:
        normalizedPlatform === "epic-official"
          ? effectiveOptions.accountId || null
          : null,
      shadps4UserId:
        normalizedPlatform === "shadps4"
          ? resolveShadPs4AchievementCacheUserId(
              configName,
              normalizedPlatform,
              effectiveOptions,
            ) || null
          : null,
      count: data ? Object.keys(data).length : 0,
    });
    return true;
  } catch (e) {
    notifyError(tUi("main.notify.cache.readFailed", { error: e.message }));
    persistenceLogger.error("save-achievement-cache:error", {
      config: configName,
      error: e.message,
    });
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedCacheFromSnapshot(
  configName,
  snapshot,
  platform = "steam",
  options = null,
) {
  if (!configName || !snapshot) return;
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (normalizedPlatform === "shadps4") {
    const resolvedOptions = normalizeAchievementCacheOptions(options);
    const progressPath =
      resolvedOptions.progressPath ||
      resolvedOptions.progress_path ||
      resolvedOptions.filePath ||
      resolvedOptions.savePath ||
      resolvedOptions.save_path ||
      "";
    if (
      !isPs4ProgressXmlPath(progressPath) &&
      resolvedOptions.allowNonProgressSeed !== true
    ) {
      persistenceLogger.info(
        "save-achievement-cache:shadps4-skip-nonprogress",
        {
          config: configName,
          source: progressPath || null,
        },
      );
      return;
    }
  }
  savePreviousAchievements(configName, snapshot, normalizedPlatform, options);
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
    "stats.ini",
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
        const entryName = ent.name.toLowerCase();
        if (
          ent.isFile() &&
          targetLc.includes(entryName) &&
          (entryName !== "stats.ini" ||
            path.basename(dir).toLowerCase() === "stats")
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
    ? resolveConfigJsonPath(configsDir, selectedConfig)
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
  const isPs4 =
    normalizePlatform(configMeta?.platform) === "shadps4" ||
    String(filePath || "")
      .toLowerCase()
      .endsWith(".xml");
  const selectedPs4ProgressPath = isPs4
    ? (isPs4ProgressXmlPath(filePath) ? filePath : "") ||
      resolvePs4ProgressPathForConfig(configMeta)
    : "";
  const currentCacheOptions = {
    appid: configMeta?.appid || currentAppId || "",
    filePath: selectedPs4ProgressPath || filePath || "",
    savePath:
      selectedPs4ProgressPath ||
      configMeta?.save_path ||
      path.dirname(filePath || ""),
    shadps4UserId: getPs4UserIdFromProgressPath(selectedPs4ProgressPath),
  };
  previousAchievements =
    (await loadPreviousAchievements(
      configName,
      currentPlatform,
      currentCacheOptions,
    )) || {};
  const ps4PreviousByPath = new Map();
  const ps4FirstLoadByPath = new Map();
  const normalizePs4ProgressKey = (fp) =>
    path.normalize(String(fp || "")).toLowerCase();
  const makePs4CacheOptionsForPath = (sourcePath) => {
    const progressPath =
      (isPs4ProgressXmlPath(sourcePath) ? sourcePath : "") ||
      selectedPs4ProgressPath ||
      "";
    return {
      appid: configMeta?.appid || currentAppId || "",
      filePath: progressPath || sourcePath || "",
      savePath:
        progressPath ||
        configMeta?.save_path ||
        path.dirname(sourcePath || filePath || ""),
      shadps4UserId: getPs4UserIdFromProgressPath(progressPath),
    };
  };
  const maybeUpdateSelectedPs4User = (progressPath) => {
    if (!isPs4ProgressXmlPath(progressPath) || !configFile) return;
    const userId = getPs4UserIdFromProgressPath(progressPath);
    if (!userId) return;
    const currentProgress = String(configMeta?.shadps4_progress_path || "");
    const currentUser = String(configMeta?.shadps4_user_id || "");
    if (
      path.normalize(currentProgress || "") === path.normalize(progressPath) &&
      currentUser === userId
    ) {
      return;
    }
    try {
      const cfg = fs.existsSync(configFile)
        ? JSON.parse(fs.readFileSync(configFile, "utf8"))
        : null;
      if (!cfg || normalizePlatform(cfg.platform) !== "shadps4") return;
      cfg.save_path = progressPath;
      cfg.shadps4_progress_path = progressPath;
      cfg.shadps4_user_id = userId;
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
      configMeta.save_path = progressPath;
      configMeta.shadps4_progress_path = progressPath;
      configMeta.shadps4_user_id = userId;
      notifyConfigsChanged();
      ipcLogger.info("shadps4:active-user-updated", {
        configName,
        appid: cfg.appid || null,
        userId,
        progressPath,
      });
    } catch {}
  };
  if (isPs4 && configMeta?.shadps4_npcommid) {
    const root = resolveShadPs4RootForConfig(configMeta);
    const progressFiles = root
      ? collectPs4ProgressFilesForConfig(
          root,
          configMeta.shadps4_npcommid,
          String(configMeta?.shadps4_user_id || "").trim(),
        )
      : [];
    if (
      selectedPs4ProgressPath &&
      fs.existsSync(selectedPs4ProgressPath) &&
      !progressFiles.some(
        (entry) =>
          normalizePs4ProgressKey(entry.progressPath) ===
          normalizePs4ProgressKey(selectedPs4ProgressPath),
      )
    ) {
      progressFiles.unshift({
        userId: getPs4UserIdFromProgressPath(selectedPs4ProgressPath),
        progressPath: selectedPs4ProgressPath,
      });
    }
    for (const progressFile of progressFiles) {
      const progressPath = progressFile?.progressPath || "";
      if (!progressPath || !fs.existsSync(progressPath)) continue;
      const cacheOptions = makePs4CacheOptionsForPath(progressPath);
      const previous =
        (await loadPreviousAchievements(
          configName,
          currentPlatform,
          cacheOptions,
        )) || {};
      ps4PreviousByPath.set(normalizePs4ProgressKey(progressPath), previous);
      ps4FirstLoadByPath.set(normalizePs4ProgressKey(progressPath), true);
    }
  }
  const isSteamOfficial =
    normalizePlatform(configMeta?.platform) === "steam-official" ||
    String(filePath || "")
      .toLowerCase()
      .startsWith("usergamestats_");
  const isEaOfficial =
    normalizePlatform(configMeta?.platform) === "ea-official" ||
    path.basename(String(filePath || "")).toLowerCase() ===
      EA_VERBOSE_LOG_NAME.toLowerCase();
  const isUbisoftOfficial =
    normalizePlatform(configMeta?.platform) === "ubisoft-official" ||
    /\.spool$/i.test(String(filePath || ""));
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
  const processSnapshot = (
    isRetry = false,
    sourceFilePath = filePath,
    opts = {},
  ) => {
    const activeFilePath = sourceFilePath || filePath;
    const activePs4ProgressPath = isPs4
      ? (isPs4ProgressXmlPath(activeFilePath) ? activeFilePath : "") ||
        selectedPs4ProgressPath
      : "";
    const activeCacheOptions = isPs4
      ? makePs4CacheOptionsForPath(activeFilePath)
      : currentCacheOptions;
    const ps4ProgressKey =
      isPs4 && activePs4ProgressPath
        ? normalizePs4ProgressKey(activePs4ProgressPath)
        : "";
    if (isPs4 && ps4ProgressKey) {
      if (!ps4PreviousByPath.has(ps4ProgressKey)) {
        ps4PreviousByPath.set(ps4ProgressKey, {});
      }
      if (!ps4FirstLoadByPath.has(ps4ProgressKey)) {
        ps4FirstLoadByPath.set(ps4ProgressKey, true);
      }
      previousAchievements = ps4PreviousByPath.get(ps4ProgressKey) || {};
      isFirstLoad = ps4FirstLoadByPath.get(ps4ProgressKey) !== false;
      if (opts?.updatePs4User === true) {
        maybeUpdateSelectedPs4User(activePs4ProgressPath);
      }
    }
    let currentAchievements = null;
    let touchedInLoop = false;
    let lumaPlayReadFailed = false;
    try {
      if (isXenia) {
        const parsed = parseGpdFile(activeFilePath);
        currentAchievements = buildSnapshotFromGpd(parsed);
      } else if (isRpcs3) {
        const trophyDir =
          resolveRpcs3TrophyDirForConfig(configMeta) ||
          path.dirname(activeFilePath);
        const parsed = parseTrophySetDir(trophyDir);
        currentAchievements = buildSnapshotFromTrophy(parsed);
      } else if (isSteamOfficial) {
        const statsDir = configMeta?.save_path || path.dirname(activeFilePath);
        const schemaPath = fullAchievementsConfigPath;
        const schemaArr =
          schemaPath && fs.existsSync(schemaPath)
            ? JSON.parse(fs.readFileSync(schemaPath, "utf8"))
            : [];
        let entries = normalizeAppcacheSchemaEntries(schemaArr);
        const schemaBin =
          statsDir && configMeta?.appid
            ? path.join(
                statsDir,
                `UserGameStatsSchema_${configMeta.appid}.bin`,
              )
            : "";
        entries = enrichSchemaEntriesFromAppcacheSchemaFile(
          entries,
          schemaBin,
        );
        let userBin = activeFilePath;
        const base = path.basename(userBin || "").toLowerCase();
        if (!base.startsWith("usergamestats_") || !base.endsWith(".bin")) {
          userBin = pickConfiguredSteamOfficialUserBin(
            statsDir,
            configMeta?.appid,
            cachedPreferences,
          );
        }
        if (entries.length && userBin && fs.existsSync(userBin)) {
          const kv = parseSteamKv(fs.readFileSync(userBin));
          const userStats = extractUserStats(kv.data);
          currentAchievements = buildSnapshotFromAppcache(entries, userStats);
        } else {
          currentAchievements = previousAchievements;
        }
      } else if (isPs4) {
        const ps4Trophy = require("./utils/shadps4-trophy");
        const progressPath =
          activePs4ProgressPath ||
          (isPs4ProgressXmlPath(activeFilePath) ? activeFilePath : "") ||
          resolvePs4ProgressPathForConfig(configMeta);
        if (progressPath && fs.existsSync(progressPath)) {
          currentAchievements = ps4Trophy.buildSnapshotFromPs4ProgressFile(
            progressPath,
            previousAchievements,
          );
        } else {
          const trophyDir =
            resolvePs4TrophyDirForConfig(configMeta) ||
            path.dirname(path.dirname(activeFilePath)) ||
            path.dirname(activeFilePath);
          const parsed = ps4Trophy.parsePs4TrophySetDir(trophyDir);
          parsed.appid = configMeta?.appid || parsed.appid;
          currentAchievements = ps4Trophy.buildSnapshotFromPs4(
            parsed,
            previousAchievements,
          );
        }
      } else if (isUbisoftOfficial) {
        const parsed = readUbisoftSpoolFile(activeFilePath);
        currentAchievements = buildUbisoftOfficialSnapshot(
          parsed?.records || [],
        );
      } else if (isEaOfficial) {
        currentAchievements = loadAchievementsFromSaveFile(
          path.dirname(activeFilePath),
          previousAchievements,
          {
            configMeta,
            selectedConfigPath,
            fullSchemaPath: fullAchievementsConfigPath,
          },
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
          path.dirname(activeFilePath),
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
          currentCacheOptions,
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
          const isBin = path.basename(activeFilePath).endsWith(".bin");
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
              name: achievementConfig.name || key,
              displayName,
              description,
              icon: achievementConfig.icon,
              icon_gray: achievementConfig.icon_gray,
              appid: currentAppId || null,
              platform: currentPlatform || null,
              config_path: selectedConfigPath,
              configName,
              rarityPct: achievementConfig.rarityPct,
              raritySource: achievementConfig.raritySource,
              trophyType:
                achievementConfig.trophyType || achievementConfig.trophy_type,
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
              progress_is_float: current.progress_is_float || undefined,
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
          const isBin = path.basename(activeFilePath).endsWith(".bin");
          for (const key of pendingProgress) {
            const cur = currentAchievements[key];
            const achievementConfig = isSteamOfficial
              ? fullConfig.find((a) => a.name === key || a.name === cur?.name)
              : isBin
                ? crcMap[key.toLowerCase()]
                : fullConfig.find(
                    (a) => a.name === key || a.name === cur?.name,
                  );
            if (!achievementConfig) continue;

            queueProgressNotification({
              displayName: getSafeLocalizedText(
                achievementConfig.displayName,
                selectedLanguage,
              ),
              icon: achievementConfig.icon,
              progress: cur.progress,
              max_progress: cur.max_progress,
              progress_is_float: cur.progress_is_float || undefined,
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
        const isBin = path.basename(activeFilePath).endsWith(".bin");
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
            name: achievementConfig.name || key,
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
            appid: currentAppId || null,
            platform: currentPlatform || null,
            config_path: selectedConfigPath,
            configName,
            rarityPct: achievementConfig.rarityPct,
            raritySource: achievementConfig.raritySource,
            trophyType:
              achievementConfig.trophyType || achievementConfig.trophy_type,
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
        const achievementConfig = isSteamOfficial
          ? fullConfig.find((a) => a.name == key || a.name == current?.name)
          : isBin
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
              progress_is_float: current.progress_is_float || undefined,
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
    const shouldPersistSnapshot =
      !isEaOfficial ||
      !deepEqual(currentAchievements || {}, previousAchievements || {});
    previousAchievements = currentAchievements;
    if (isPs4 && ps4ProgressKey) {
      ps4PreviousByPath.set(ps4ProgressKey, currentAchievements);
      ps4FirstLoadByPath.set(ps4ProgressKey, false);
    }
    if (shouldPersistSnapshot && !(isLumaPlay && lumaPlayReadFailed)) {
      savePreviousAchievements(
        configName,
        previousAchievements,
        currentPlatform,
        activeCacheOptions,
      );
    }
    if (!isPs4) {
      isFirstLoad = false;
    }
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
        clearLumaPlayReadCache();
        scheduleSnapshotFromEvent(0);
      },
      onWarn: (error) => {
        appLogger.warn("active-lumaplay:event-warning", {
          config: activeConfigName,
          appid: activeAppId || null,
          error: String(error || ""),
        });
      },
      onLifecycle: (lifecycle = {}) => {
        const state = String(lifecycle?.state || "");
        if (state === "ready" || state === "spawned") return;
        const details = {
          config: activeConfigName,
          appid: activeAppId || null,
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
          appLogger.warn("active-lumaplay:event-lifecycle", details);
        } else {
          appLogger.info("active-lumaplay:event-lifecycle", details);
        }
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
    if (isPs4) {
      const root = resolveShadPs4RootForConfig(configMeta);
      const npcommid = String(configMeta?.shadps4_npcommid || "").trim();
      const progressFiles =
        root && npcommid
          ? collectPs4ProgressFilesForConfig(
              root,
              npcommid,
              String(configMeta?.shadps4_user_id || "").trim(),
            )
          : [];
      const watchSet = new Set();
      for (const entry of progressFiles) {
        if (entry?.progressPath && fs.existsSync(entry.progressPath)) {
          watchSet.add(entry.progressPath);
        }
      }
      if (isPs4ProgressXmlPath(filePath) && fs.existsSync(filePath)) {
        watchSet.add(filePath);
      }
      if (watchSet.size) {
        const watchFiles = Array.from(watchSet);
        const primary =
          watchFiles.find(
            (fp) =>
              path.normalize(fp).toLowerCase() ===
              path.normalize(filePath).toLowerCase(),
          ) || watchFiles[0];
        currentAchievementsFilePath = primary;
        for (const fp of watchFiles) {
          processSnapshot(false, fp, { updatePs4User: false });
        }
        refreshAchievementsUi();

        try {
          fs.unwatchFile(primary);
        } catch {}
        achievementsWatcher = () =>
          processSnapshot(false, primary, { updatePs4User: true });
        fs.watchFile(primary, { interval: 1000 }, achievementsWatcher);

        for (const fp of watchFiles) {
          if (
            path.normalize(fp).toLowerCase() ===
            path.normalize(primary).toLowerCase()
          ) {
            continue;
          }
          try {
            fs.unwatchFile(fp);
          } catch {}
          extraAchievementFiles.add(fp);
          fs.watchFile(fp, { interval: 1000 }, () =>
            processSnapshot(false, fp, { updatePs4User: true }),
          );
        }
        achievementMonitorTimer = null;
        return;
      }
    }
    if (fs.existsSync(filePath)) {
      processSnapshot(false);
      refreshAchievementsUi();

      try {
        fs.unwatchFile(filePath);
      } catch {}
      fs.watchFile(filePath, { interval: 1000 }, achievementsWatcher);

      const activeBaseName = path.basename(filePath).toLowerCase();
      const activeParent = path.dirname(filePath);
      if (
        path.basename(activeParent).toLowerCase() === "stats" &&
        ["achievements.ini", "stats.ini"].includes(activeBaseName)
      ) {
        const sidecarName =
          activeBaseName === "stats.ini" ? "achievements.ini" : "stats.ini";
        const sidecarPath = path.join(activeParent, sidecarName);
        try {
          fs.unwatchFile(sidecarPath);
        } catch {}
        extraAchievementFiles.add(sidecarPath);
        fs.watchFile(sidecarPath, { interval: 1000 }, () =>
          processSnapshot(false),
        );
      }
      achievementMonitorTimer = null;
    } else {
      const baseDir = path.dirname(filePath);
      if (normalizePlatform(configMeta?.platform) === "gog-official") {
        const resolved = resolveGogOfficialGameplayDbForConfig(
          configMeta || {},
        );
        const nextGameplayDb = resolved?.gameplayDbPath || "";
        if (
          nextGameplayDb &&
          nextGameplayDb !== filePath &&
          fs.existsSync(nextGameplayDb)
        ) {
          if (isNonEmptyString(configName)) {
            pendingMissingAchievementFiles.set(configName, nextGameplayDb);
          }
          monitorAchievementsFile(nextGameplayDb);
          return;
        }
      }
      if (normalizePlatform(configMeta?.platform) === "ubisoft-official") {
        const resolved = resolveUbisoftOfficialSpoolFileForConfig(
          configMeta || {},
        );
        const nextSpoolFile = resolved?.spoolFilePath || "";
        if (
          nextSpoolFile &&
          nextSpoolFile !== filePath &&
          fs.existsSync(nextSpoolFile)
        ) {
          if (isNonEmptyString(configName)) {
            pendingMissingAchievementFiles.set(configName, nextSpoolFile);
          }
          monitorAchievementsFile(nextSpoolFile);
          return;
        }
      }
      if (normalizePlatform(configMeta?.platform) === "ea-official") {
        const resolved = resolveEaOfficialVerboseLogForConfig(configMeta || {});
        const nextEaLog = resolved?.logFilePath || "";
        if (nextEaLog && nextEaLog !== filePath && fs.existsSync(nextEaLog)) {
          if (isNonEmptyString(configName)) {
            pendingMissingAchievementFiles.set(configName, nextEaLog);
          }
          monitorAchievementsFile(nextEaLog);
          return;
        }
      }
      const tenokePath = path.join(baseDir, "SteamData", "user_stats.ini");
      const iniPath = path.join(baseDir, "achievements.ini");
      const universeIniPath = path.join(
        baseDir,
        "UniverseLANData",
        "Achievements.ini",
      );
      const onlineFixIniPath = path.join(baseDir, "Stats", "achievements.ini");
      const onlineFixStatsPath = path.join(baseDir, "Stats", "stats.ini");
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

      if (fs.existsSync(onlineFixStatsPath)) {
        monitorAchievementsFile(onlineFixStatsPath);
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
function clearPendingMissingAchievementFile(configName) {
  if (!isNonEmptyString(configName)) return;
  pendingMissingAchievementFiles.delete(configName);
  const safeName = sanitizeConfigName(configName);
  if (safeName && safeName !== configName) {
    pendingMissingAchievementFiles.delete(safeName);
  }
}

async function refreshSelectedSteamOfficialMonitoring() {
  if (
    normalizePlatform(selectedPlatform) !== "steam-official" ||
    !isNonEmptyString(selectedConfig)
  ) {
    return;
  }

  const safeName = sanitizeConfigName(selectedConfig);
  if (!safeName) return;
  const cfgFile = resolveConfigJsonPath(configsDir, selectedConfig);
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  } catch {
    return;
  }

  const appid = String(config?.appid || "");
  const statsDir = config?.save_path || "";
  const userBin =
    statsDir && appid
      ? pickConfiguredSteamOfficialUserBin(statsDir, appid, cachedPreferences)
      : null;

  achievementsFilePath = userBin || null;
  if (!userBin || !fs.existsSync(userBin)) {
    await monitorAchievementsFile(null);
    achievementsFilePath = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("achievements-missing", {
        configName: selectedConfig,
        reason: "no-usergamestats",
      });
      mainWindow.webContents.send("refresh-achievements-table", selectedConfig);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("load-overlay-data", selectedConfig);
      overlayWindow.webContents.send("set-language", {
        language: selectedLanguage,
        uiLanguage: selectedUiLanguage,
      });
    }
    return;
  }

  clearPendingMissingAchievementFile(selectedConfig);
  await monitorAchievementsFile(userBin);
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
}

async function clearActiveConfigSelection(options = {}) {
  if (options?.preserveUpdateGeneration !== true) {
    activeConfigUpdateGeneration += 1;
  }
  const reason =
    typeof options?.reason === "string" && options.reason
      ? options.reason
      : "unspecified";
  const requestedConfig = isNonEmptyString(options?.configName)
    ? options.configName
    : "";
  const previousConfig = isNonEmptyString(selectedConfig) ? selectedConfig : "";
  const previousMonitorPath =
    currentAchievementsFilePath || achievementsFilePath || null;
  const matchedTarget =
    !!requestedConfig &&
    sanitizeConfigName(requestedConfig) === sanitizeConfigName(previousConfig);

  appLogger.info("active-config:clear:start", {
    reason,
    requestedConfig: requestedConfig || null,
    activeConfig: previousConfig || null,
    matchedTarget,
    monitorPath: previousMonitorPath,
  });

  try {
    stopEpicOfficialActivePoll("clear-active-config", {
      reason,
      activeConfig: previousConfig || null,
    });
    stopXboxPcActivePoll("clear-active-config", {
      reason,
      activeConfig: previousConfig || null,
    });
    await monitorAchievementsFile(null);
  } catch (err) {
    appLogger.warn("active-config:clear:monitor-stop-failed", {
      reason,
      activeConfig: previousConfig || null,
      error: err?.message || String(err),
    });
  }

  achievementsFilePath = null;
  fullAchievementsConfigPath = null;
  selectedConfigPath = null;
  selectedConfig = null;
  selectedPlatform = null;
  selectedConfigMode = "none";
  currentAppId = null;
  clearPendingMissingAchievementFile(previousConfig);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("load-overlay-data", null);
    overlayWindow.webContents.send("set-language", {
      language: selectedLanguage,
      uiLanguage: selectedUiLanguage,
    });
  }

  appLogger.info("active-config:clear:complete", {
    reason,
    previousConfig: previousConfig || null,
    monitorPath: previousMonitorPath,
  });

  return {
    previousConfig: previousConfig || null,
    monitorPath: previousMonitorPath,
  };
}

ipcMain.handle("config:clear-active", async (_event, payload = {}) => {
  try {
    const result = await clearActiveConfigSelection({
      reason: payload?.reason || "renderer-invoke",
      configName: payload?.configName || "",
    });
    return { success: true, ...result };
  } catch (error) {
    appLogger.error("active-config:clear:error", {
      reason: payload?.reason || "renderer-invoke",
      configName: payload?.configName || null,
      error: error?.message || String(error),
    });
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
});

ipcMain.handle("config:get-active-selection", () => ({
  configName: isNonEmptyString(selectedConfig) ? selectedConfig : null,
  platform: normalizePlatform(selectedPlatform) || null,
  appid: currentAppId != null ? String(currentAppId) : null,
  mode: selectedConfigMode,
}));

ipcMain.on(
  "update-config",
  async (
    event,
    { configName, preset, position, platform, allowBlacklistedSelection },
  ) => {
    const updateGeneration = ++activeConfigUpdateGeneration;
    const safeName = configName ? sanitizeConfigName(configName) : null;

    if (!safeName) {
      await clearActiveConfigSelection({
        reason: "update-config:null",
        preserveUpdateGeneration: true,
      });
      return;
    }

    const cfgFile = resolveConfigJsonPath(configsDir, configName);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
    } catch (err) {
      notifyError(
        tUi("main.notify.configPath.readFailed", { error: err.message }),
      );
      return;
    }

    const normalizedPlatform =
      normalizePlatform(config?.platform) || normalizePlatform(platform) || null;
    const appIdString =
      config?.appid != null ? String(config.appid).trim() : "";
    const isBlacklisted =
      appIdString && isAppIdBlacklisted(appIdString, config?.platform);
    if (isBlacklisted && allowBlacklistedSelection !== true) {
      ipcLogger.info("update-config:ignored-blacklisted", {
        configName: configName || null,
        appid: appIdString,
        platform: normalizedPlatform,
      });
      return;
    }

    const targetMode = isBlacklisted ? "view-only" : "active";
    const currentSafeName = sanitizeConfigName(selectedConfig || "");
    const currentPlatform = normalizePlatform(selectedPlatform) || null;
    const requiresTransition =
      currentSafeName !== safeName ||
      currentPlatform !== normalizedPlatform ||
      selectedConfigMode !== targetMode;

    if (requiresTransition) {
      await clearActiveConfigSelection({
        reason: `update-config:transition:${targetMode}`,
        configName: selectedConfig || null,
        preserveUpdateGeneration: true,
      });
      if (updateGeneration !== activeConfigUpdateGeneration) return;
    }

    selectedPreset = preset || "default";
    selectedPosition = position || "center-bottom";
    selectedConfig = safeName;
    selectedPlatform = normalizedPlatform;
    selectedConfigMode = targetMode;
    selectedConfigPath = isNonEmptyString(config.config_path)
      ? config.config_path
      : null;
    fullAchievementsConfigPath = isNonEmptyString(config.config_path)
      ? path.join(config.config_path, "achievements.json")
      : null;
    ipcLogger.info("update-config:selected", {
      configName: safeName,
      platform: selectedPlatform,
      appid: appIdString || null,
      mode: selectedConfigMode,
      transitioned: requiresTransition,
    });

    if (isBlacklisted) {
      currentAppId = appIdString || null;
      achievementsFilePath = null;
      stopEpicOfficialActivePoll("blacklisted-selection", {
        configName: safeName,
        appid: appIdString,
      });
      clearEpicOfficialRuntimeState("blacklisted-selection", {
        configName: safeName,
        appid: appIdString,
      });
      stopXboxPcActivePoll("blacklisted-selection", {
        configName: safeName,
        appid: appIdString,
      });
      monitorAchievementsFile(null);
      pendingMissingAchievementFiles.delete(safeName);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      ipcLogger.info("update-config:selection-only-blacklisted", {
        configName: safeName,
        appid: appIdString,
        platform: normalizedPlatform,
      });
      return;
    }

    if (normalizedPlatform !== "epic-official") {
      stopEpicOfficialActivePoll("config-switch", {
        nextConfig: safeName,
        nextPlatform: normalizedPlatform || null,
      });
      clearEpicOfficialRuntimeState("config-switch", {
        nextConfig: safeName,
        nextPlatform: normalizedPlatform || null,
      });
    }
    if (normalizedPlatform !== "xbox-pc") {
      stopXboxPcActivePoll("config-switch", {
        nextConfig: safeName,
        nextPlatform: normalizedPlatform || null,
      });
    }
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
    if (normalizedPlatform === "xbox-pc") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      achievementsFilePath = null;
      monitorAchievementsFile(null);
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      startXboxPcActivePoll(safeName, "update-config");
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
      const progressPath = resolvePs4ProgressPathForConfig(config);
      const trophyDir = resolvePs4TrophyDirForConfig(config);
      const xmlMain = trophyDir ? path.join(trophyDir, "Xml", "TROP.XML") : "";
      achievementsFilePath =
        progressPath && fs.existsSync(progressPath)
          ? progressPath
          : xmlMain && fs.existsSync(xmlMain)
            ? xmlMain
            : null;
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
        statsDir && appid
          ? pickConfiguredSteamOfficialUserBin(
              statsDir,
              appid,
              cachedPreferences,
            )
          : null;
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

    if (normalizedPlatform === "epic-official") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      achievementsFilePath = null;
      monitorAchievementsFile(null);
      if (isNonEmptyString(configName)) {
        pendingMissingAchievementFiles.delete(configName);
      }
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("load-overlay-data", selectedConfig);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      startEpicOfficialActivePoll(safeName, "update-config");
      return;
    }

    if (normalizedPlatform === "gog-official") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const resolved = resolveGogOfficialGameplayDbForConfig(config);
      achievementsFilePath = resolved?.gameplayDbPath || null;
      if (
        resolved &&
        (config.save_path !== resolved.gameplayDir ||
          (config.gog_client_id || "") !== (resolved.clientId || "") ||
          (config.gog_user_id || "") !== (resolved.userId || "") ||
          (config.gog_gameplay_db || "") !== (resolved.gameplayDbPath || ""))
      ) {
        config.save_path = resolved.gameplayDir || config.save_path || "";
        config.gog_client_id = resolved.clientId || config.gog_client_id || "";
        config.gog_user_id = resolved.userId || config.gog_user_id || "";
        config.gog_gameplay_db =
          resolved.gameplayDbPath || config.gog_gameplay_db || "";
        try {
          fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
        } catch {}
      }
      if (!achievementsFilePath || !fs.existsSync(achievementsFilePath)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-gameplay-db",
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

    if (normalizedPlatform === "ubisoft-official") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const resolved = resolveUbisoftOfficialSpoolFileForConfig(config);
      achievementsFilePath = resolved?.spoolFilePath || null;
      if (
        resolved &&
        (config.save_path !== resolved.spoolDir ||
          (config.ubisoft_user_id || "") !== (resolved.userId || "") ||
          (config.ubisoft_spool_file || "") !== (resolved.spoolFilePath || ""))
      ) {
        config.save_path = resolved.spoolDir || config.save_path || "";
        config.ubisoft_user_id =
          resolved.userId || config.ubisoft_user_id || "";
        config.ubisoft_spool_file =
          resolved.spoolFilePath || config.ubisoft_spool_file || "";
        try {
          fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
        } catch {}
      }
      if (!achievementsFilePath || !fs.existsSync(achievementsFilePath)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-spool-file",
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

    if (normalizedPlatform === "ea-official") {
      const appid = String(config.appid || "");
      currentAppId = appid || null;
      const resolved = resolveEaOfficialVerboseLogForConfig(config);
      const parsed =
        resolved?.logFilePath && fs.existsSync(resolved.logFilePath)
          ? readEaDesktopVerboseLog(resolved.logFilePath)
          : null;
      const entry =
        appid && resolved?.logFilePath
          ? resolveEaOfficialAchievementSetForAppId(appid, {
              achievementSet: config?.ea_achievement_set || "",
              savePath: resolved.logsRoot || config.save_path || "",
              logFilePath: resolved.logFilePath,
              parsedLog: parsed,
            })
          : null;
      achievementsFilePath = resolved?.logFilePath || null;
      if (
        resolved &&
        (config.save_path !== (resolved.logsRoot || config.save_path || "") ||
          (config.ea_log_file || "") !== (resolved.logFilePath || "") ||
          (config.ea_achievement_set || "") !==
            (entry?.achievementSet || config.ea_achievement_set || "") ||
          (config.ea_offer_id || "") !==
            (entry?.offerId || config.ea_offer_id || "") ||
          (config.ea_install_path || "") !==
            (entry?.installPath || config.ea_install_path || "") ||
          (config.executable || "") !==
            (entry?.exePath || config.executable || "") ||
          !processNameValuesEqual(
            config.process_name,
            entry?.processName ||
              config.process_name ||
              (entry?.exePath ? path.basename(entry.exePath) : ""),
          ))
      ) {
        config.save_path = resolved.logsRoot || config.save_path || "";
        config.ea_log_file = resolved.logFilePath || config.ea_log_file || "";
        config.ea_achievement_set =
          entry?.achievementSet || config.ea_achievement_set || "";
        config.ea_offer_id = entry?.offerId || config.ea_offer_id || "";
        config.ea_install_path =
          entry?.installPath || config.ea_install_path || "";
        config.executable = entry?.exePath || config.executable || "";
        config.process_name = normalizeProcessNameValue(
          entry?.processName ||
            config.process_name ||
            (entry?.exePath ? path.basename(entry.exePath) : ""),
        );
        try {
          fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
        } catch {}
      }
      if (!achievementsFilePath || !fs.existsSync(achievementsFilePath)) {
        monitorAchievementsFile(null);
        achievementsFilePath = null;
        event.sender.send("achievements-missing", {
          configName,
          reason: "no-ea-log-file",
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
      const progressPath = resolvePs4ProgressPathForConfig(config);
      const trophyDir = resolvePs4TrophyDirForConfig(config);
      const xmlMain = trophyDir ? path.join(trophyDir, "Xml", "TROP.XML") : "";
      achievementsFilePath =
        progressPath && fs.existsSync(progressPath)
          ? progressPath
          : xmlMain && fs.existsSync(xmlMain)
            ? xmlMain
            : null;
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
      ofxStats: onlineFixStatsPath,
      bin: binPath,
    } = resolveSaveSidecarPaths(saveBase, appid);

    if (fs.existsSync(saveJsonPath)) achievementsFilePath = saveJsonPath;
    else if (tenokeIniPath) achievementsFilePath = tenokeIniPath;
    else if (onlineFixIniPath) achievementsFilePath = onlineFixIniPath;
    else if (onlineFixStatsPath) achievementsFilePath = onlineFixStatsPath;
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
    let configPath = resolveConfigJsonPath(configsDir, name);
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

    try {
      const mapping = data?.appid
        ? uplayToSteam.get(String(data.appid).trim())
        : null;
      const inferredPlatform =
        inferOfficialPlatformFromMarkers(data) ||
        inferPlatformAndSteamId({ config: data, mapping }).platform;
      const normalizedInferredPlatform = normalizePlatform(inferredPlatform);
      if (
        normalizedInferredPlatform &&
        data.platform !== normalizedInferredPlatform
      ) {
        data.platform = normalizedInferredPlatform;
        try {
          fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
        } catch {}
      }
    } catch {}

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

ipcMain.handle("config:set-custom-cover-path", async (_event, payload = {}) => {
  const safeName = sanitizeConfigName(payload?.configName || "");
  if (!safeName) {
    return { success: false, error: "Invalid config name." };
  }
  const configPath = resolveConfigJsonPath(configsDir, payload?.configName);
  if (!fs.existsSync(configPath)) {
    return { success: false, error: "Config not found." };
  }

  const coverPathRaw = String(payload?.coverPath || "").trim();
  const nextCoverPath = isNonEmptyString(coverPathRaw) ? coverPathRaw : "";

  if (nextCoverPath) {
    try {
      await fs.promises.access(nextCoverPath, fs.constants.R_OK);
    } catch (err) {
      return {
        success: false,
        error: `Custom cover file is not readable: ${err?.message || String(err)}`,
      };
    }
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const previousManagedCoverPath = isManagedCustomCoverPath(
      config?.custom_cover_path,
    )
      ? String(config.custom_cover_path).trim()
      : "";
    if (nextCoverPath) {
      const buffer = await fs.promises.readFile(nextCoverPath);
      const detectedMime = detectImageMimeFromBuffer(buffer);
      const extension = getCoverExtensionFromMeta({
        extension: path.extname(nextCoverPath),
        contentType: detectedMime,
        sourceUrl: nextCoverPath,
      });
      const managedDir = getManagedCustomCoverDir();
      fs.mkdirSync(managedDir, { recursive: true });
      const managedCoverPath = path.join(managedDir, `${safeName}${extension}`);
      removeManagedCustomCoverVariants(safeName, managedCoverPath);
      fs.writeFileSync(managedCoverPath, buffer);
      config.custom_cover_path = managedCoverPath;
      config.custom_cover_source_path = nextCoverPath;
    } else {
      delete config.custom_cover_path;
      delete config.custom_cover_source_path;
    }
    if (
      previousManagedCoverPath &&
      previousManagedCoverPath !== config.custom_cover_path
    ) {
      try {
        if (fs.existsSync(previousManagedCoverPath)) {
          fs.unlinkSync(previousManagedCoverPath);
        }
      } catch {}
      removeManagedCustomCoverVariants(
        safeName,
        config.custom_cover_path || "",
      );
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    notifyConfigsChanged();
    broadcastToAll("update-image", {
      appid: String(config?.appid || ""),
      platform: normalizePlatform(config?.platform) || null,
      configName: safeName,
      custom: !!nextCoverPath,
    });
    ipcLogger.info("config:set-custom-cover-path", {
      configName: safeName,
      appid: config?.appid || null,
      custom: !!nextCoverPath,
    });
    return {
      success: true,
      configName: safeName,
      coverPath: String(config?.custom_cover_path || "").trim() || null,
      sourceCoverPath:
        String(config?.custom_cover_source_path || "").trim() || null,
    };
  } catch (err) {
    ipcLogger.error("config:set-custom-cover-path:error", {
      configName: safeName,
      error: err?.message || String(err),
    });
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
});

ipcMain.handle("renameAndSaveConfig", async (event, oldName, newConfig) => {
  let progressJob = null;
  try {
    const safeOld = sanitizeConfigName(oldName);
    const safeNew = sanitizeConfigName(newConfig.name);

    const oldConfigPath = resolveConfigJsonPath(configsDir, oldName);
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
      process_name: hasProcessNameValue(newConfig.process_name, {
        splitString: true,
      })
        ? normalizeProcessNameValue(newConfig.process_name, {
            splitString: true,
          })
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
    if (isAppIdBlacklisted(sanitizedAppId, payload.platform)) {
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
    const oldScopedCachePaths = listScopedAchievementCachePaths(
      safeOld,
      prevPlatform || "steam",
    );
    const ensureRenameProgressJob = () => {
      if (progressJob) return progressJob;
      progressJob = createGenerationProgressJob({
        kind: "config-generate",
        scope: "single",
        status: "running",
        itemName: String(
          payload.displayName || payload.name || payload.appid || "",
        ).trim(),
        appid: String(payload.appid || ""),
        phase: "preparing",
        detail: "Preparing config generation",
        current: 0,
        total: 0,
        percent: 5,
      });
      return progressJob;
    };
    const updateRenameSchemaProgress = (progress = {}) => {
      ensureRenameProgressJob().update({
        itemName:
          progress?.itemName ||
          payload.displayName ||
          payload.name ||
          payload.appid,
        appid: progress?.appid || payload.appid,
        phase: progress?.phase || "generatingSchema",
        detail: progress?.detail || "",
        current:
          Number.isFinite(Number(progress?.current)) &&
          Number(progress.current) >= 0
            ? Number(progress.current)
            : 0,
        total:
          Number.isFinite(Number(progress?.total)) &&
          Number(progress.total) >= 0
            ? Number(progress.total)
            : 0,
        percent: clampGenerationPercent(progress?.percent, 5),
      });
    };

    // missing config_path, generate and set path
    if (
      !payload.config_path &&
      sanitizeAppIdForPlatform(payload.appid, payload.platform)
    ) {
      try {
        global.mainWindow = BrowserWindow.fromWebContents(event.sender);
      } catch {}
      try {
        updateRenameSchemaProgress({
          phase: "generatingSchema",
          detail: "Starting schema generation",
          percent: 12,
        });
        const res = await ensureSchemaForApp(payload.appid, payload.platform, {
          ...payload,
          onGenerationProgress: updateRenameSchemaProgress,
        });
        if (res && res.dir) {
          payload.config_path = res.dir;
          if (nextPlatform === "epic-official") {
            if (res.productId) payload.epic_product_id = res.productId;
            if (res.sandboxId) payload.epic_namespace = res.sandboxId;
          }
        }
      } catch (err) {
        progressJob?.fail({
          phase: "failed",
          detail: err?.message || "Schema generation failed",
        });
        throw err;
      }
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
        sanitizeAppIdForPlatform(payload.appid, payload.platform)
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
    const prevCachePlatform = normalizePlatform(prevPlatform);
    const nextCachePlatform = normalizePlatform(nextPlatform);
    if (
      prevCachePlatform === nextCachePlatform &&
      (nextCachePlatform === "steam-official" ||
        nextCachePlatform === "epic-official")
    ) {
      const oldPrefix = `${sanitizeConfigName(safeOld || "")}_${nextCachePlatform}`;
      const newPrefix = `${sanitizeConfigName(safeNew || "")}_${nextCachePlatform}`;
      for (const scopedOldPath of oldScopedCachePaths) {
        if (!scopedOldPath || !fs.existsSync(scopedOldPath)) continue;
        const baseName = path.basename(scopedOldPath);
        if (
          baseName === path.basename(oldCachePath) ||
          !baseName.startsWith(oldPrefix)
        ) {
          continue;
        }
        const scopedNewPath = path.join(
          cacheDir,
          `${newPrefix}${baseName.slice(oldPrefix.length)}`,
        );
        try {
          fs.renameSync(scopedOldPath, scopedNewPath);
        } catch {}
      }
    }

    const managesSchemaPath = isManagedSchemaPath(prevConfig?.config_path);
    if (
      prevPlatform &&
      prevPlatform !== nextPlatform &&
      managesSchemaPath &&
      sanitizeAppIdForPlatform(payload.appid, nextPlatform)
    ) {
      ipcLogger.info("config:platform-change", {
        name: safeNew,
        appid: payload.appid,
        from: prevPlatform,
        to: nextPlatform,
      });
      try {
        updateRenameSchemaProgress({
          phase: "generatingSchema",
          detail: "Starting schema generation",
          percent: 12,
        });
        const res = await ensureSchemaForApp(payload.appid, nextPlatform, {
          ...payload,
          onGenerationProgress: updateRenameSchemaProgress,
        });
        if (res?.dir) {
          const current = JSON.parse(fs.readFileSync(newConfigPath, "utf8"));
          if (current.config_path !== res.dir) {
            current.config_path = res.dir;
          }
          if (nextPlatform === "epic-official") {
            if (res.productId) current.epic_product_id = res.productId;
            if (res.sandboxId) current.epic_namespace = res.sandboxId;
          }
          fs.writeFileSync(newConfigPath, JSON.stringify(current, null, 2));
        }
        progressJob?.succeed({
          phase: "completed",
          detail: "Config updated",
          percent: 100,
        });
      } catch (err) {
        progressJob?.fail({
          phase: "failed",
          detail: err?.message || "Schema generation failed",
        });
        ipcLogger.warn("renameConfig:schema-sync-failed", {
          appid: payload.appid,
          error: err?.message || String(err),
        });
      }
    }

    if (progressJob && generationProgressJobs.has(progressJob.id)) {
      progressJob.succeed({
        phase: "completed",
        detail: "Config updated",
        percent: 100,
      });
    }

    pendingMissingAchievementFiles.delete(safeOld);
    pendingMissingAchievementFiles.delete(safeNew);

    notifyConfigsChanged();
    return {
      success: true,
      message: tUi("main.message.configRenameSuccess", { name: oldName }),
    };
  } catch (error) {
    progressJob?.fail({
      phase: "failed",
      detail: error?.message || "Config update failed",
    });
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
  overlayNavigationRendererReadyWebContentsId = null;
  overlayWindow.webContents.on("did-start-loading", () => {
    overlayNavigationRendererReadyWebContentsId = null;
    if (pendingOverlayNotificationNavigation) {
      delete pendingOverlayNotificationNavigation.dispatchedWebContentsId;
      delete pendingOverlayNotificationNavigation.dispatchedAt;
    }
  });
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
    flushPendingOverlayNotificationNavigation();
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
    try {
      overlayControllerService?.notifyOverlayPresentationChanged?.(
        false,
        "overlay-window:closed",
      );
    } catch {}
    clearOverlayVisibilityAckTimeout();
    clearOverlayTopmostBoostTimer();
    stopOverlayGlobalDrag();
    overlayWindow = null;
    pendingOverlayNotificationNavigation = null;
    overlayNavigationRendererReadyWebContentsId = null;
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
    try {
      overlayControllerService?.notifyOverlayPresentationChanged?.(
        true,
        "overlay-window:show",
      );
    } catch {}
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
    try {
      overlayControllerService?.notifyOverlayPresentationChanged?.(
        false,
        "overlay-window:hide",
      );
    } catch {}
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

ipcMain.handle("selectExecutable", async (_event, currentPath) => {
  const requestedPath = String(currentPath || "").trim();
  let initialDirectory = "";
  let initialFileName = "";
  try {
    if (requestedPath && fs.existsSync(requestedPath)) {
      const currentStat = fs.statSync(requestedPath);
      initialDirectory = currentStat.isDirectory()
        ? requestedPath
        : path.dirname(requestedPath);
      initialFileName = currentStat.isFile() ? path.basename(requestedPath) : "";
    }
  } catch {}
  if (!initialDirectory) {
    initialDirectory = app.getPath("desktop");
  }

  let selectedPath = "";
  if (process.platform === "win32") {
    try {
      const selection = await pickWindowsExecutableOrShortcut({
        initialDirectory,
        fileName: initialFileName,
      });
      if (selection.canceled) return null;
      selectedPath = selection.filePath;
    } catch (err) {
      ipcLogger.warn("executable:windows-picker-failed", {
        error: err?.message || String(err),
      });
    }
  }
  if (!selectedPath) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      defaultPath: initialFileName ? requestedPath : initialDirectory,
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) return null;
    selectedPath = filePaths[0];
  }
  const fallback = {
    selectedPath,
    executable: selectedPath,
    arguments: "",
    processName: path.basename(selectedPath),
    workingDirectory: path.dirname(selectedPath),
    shortcutPath: "",
    isShortcut: false,
  };
  if (
    process.platform !== "win32" ||
    path.extname(selectedPath).toLowerCase() !== ".lnk"
  ) {
    return fallback;
  }
  try {
    const details = shell.readShortcutLink(selectedPath);
    const target = String(details?.target || "").trim();
    if (!target) {
      return {
        ...fallback,
        shortcutPath: selectedPath,
        isShortcut: true,
        shortcutReadFailed: true,
      };
    }
    return {
      selectedPath,
      executable: target,
      arguments: String(details?.args || "").trim(),
      processName: path.basename(target),
      workingDirectory:
        String(details?.cwd || "").trim() || path.dirname(target),
      shortcutPath: selectedPath,
      isShortcut: true,
    };
  } catch (err) {
    ipcLogger.warn("executable:shortcut-read-failed", {
      shortcutPath: selectedPath,
      error: err?.message || String(err),
    });
    return {
      ...fallback,
      shortcutPath: selectedPath,
      isShortcut: true,
      shortcutReadFailed: true,
    };
  }
});

ipcMain.handle(
  "launchExecutable",
  async (_event, exePath, argsString, workingDirectory) => {
  try {
    if (!exePath) {
      notifyError(tUi("main.notify.executable.pathMissing"));
      return;
    }
    const args = splitArgsString(argsString);
    const isAppsFolderTarget = /^shell:AppsFolder\\/i.test(
      String(exePath || "").trim(),
    );
    const requestedCwd = String(workingDirectory || "").trim();
    const cwd =
      requestedCwd && fs.existsSync(requestedCwd)
        ? requestedCwd
        : isAppsFolderTarget
          ? undefined
          : path.dirname(exePath);
    const launchExecutable = isAppsFolderTarget ? "explorer.exe" : exePath;
    const launchArgs = isAppsFolderTarget ? [exePath] : args;
    const child = spawn(launchExecutable, launchArgs, {
      cwd,
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
const EPIC_OFFICIAL_ACTIVE_POLL_INITIAL_MS = 45000;
const EPIC_OFFICIAL_ACTIVE_POLL_INTERVAL_MS = 3000;
const EPIC_OFFICIAL_ACTIVE_POLL_ERROR_DELAYS_MS = [30000, 60000, 120000];
let epicOfficialActivePollTimer = null;
let epicOfficialActivePollInFlight = null;
let epicOfficialActivePollState = null;
let epicOfficialActivePollGeneration = 0;
const XBOX_PC_ACTIVE_POLL_INITIAL_MS = 45000;
const XBOX_PC_ACTIVE_POLL_INTERVAL_MS = 5000;
let xboxPcActivePollTimer = null;
let xboxPcActivePollState = null;
let xboxPcActivePollInFlight = null;
let xboxPcActivePollGeneration = 0;

function isEpicOfficialBackgroundWorkBootReady() {
  if (
    global.bootDone !== true ||
    global.bootUiReady !== true ||
    global.bootManualSeedComplete !== true
  ) {
    return false;
  }
  return autoSelectProcessPollerStarted === true;
}

function isEpicOfficialPrioritySyncTarget(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  if (isEpicOfficialConfigActiveForPolling(safeName)) return true;
  const activeState = getEpicOfficialActivePollState();
  return sanitizeConfigName(activeState?.configName || "") === safeName;
}

function isEpicOfficialConfigBlacklisted(configName, config = null) {
  const resolvedConfig =
    config && typeof config === "object"
      ? config
      : readConfigForAchievementCache(configName);
  if (!resolvedConfig || typeof resolvedConfig !== "object") return false;
  const appid = String(
    resolvedConfig?.appid ||
      resolvedConfig?.epic_product_id ||
      resolvedConfig?.epicProductId ||
      "",
  ).trim();
  if (!appid) return false;
  return isAppIdBlacklisted(appid, "epic-official");
}

function isEpicOfficialConfigActiveForPolling(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  if (isEpicOfficialConfigSelectedForPolling(safeName)) {
    return true;
  }
  if (sanitizeConfigName(detectedConfigName || "") === safeName) return true;
  for (const activeName of activePlaytimeConfigs) {
    if (sanitizeConfigName(activeName || "") === safeName) return true;
  }
  return false;
}

function isEpicOfficialConfigSelectedForPolling(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (
    selectedConfigMode !== "active" ||
    !safeName ||
    sanitizeConfigName(selectedConfig || "") !== safeName
  ) {
    return false;
  }
  if (normalizePlatform(selectedPlatform) === "epic-official") return true;
  const config = readConfigForAchievementCache(safeName);
  return normalizePlatform(config?.platform) === "epic-official";
}

function shouldLogEpicOfficialCacheOnly(configName, cacheCount) {
  pruneEpicOfficialRuntimeState();
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  const now = Date.now();
  const previous = epicOfficialCacheOnlyLogState.get(safeName);
  if (
    previous &&
    previous.cacheCount === cacheCount &&
    now - previous.loggedAt < EPIC_OFFICIAL_CACHE_ONLY_LOG_TTL_MS
  ) {
    return false;
  }
  epicOfficialCacheOnlyLogState.set(safeName, {
    cacheCount,
    loggedAt: now,
  });
  return true;
}

function clearEpicOfficialActivePollTimer() {
  if (!epicOfficialActivePollTimer) return;
  clearTimeout(epicOfficialActivePollTimer);
  epicOfficialActivePollTimer = null;
}

function getEpicOfficialActivePollState() {
  return epicOfficialActivePollState &&
    typeof epicOfficialActivePollState === "object"
    ? epicOfficialActivePollState
    : null;
}

function stopEpicOfficialActivePoll(reason = "manual", meta = {}) {
  const state = getEpicOfficialActivePollState();
  clearEpicOfficialActivePollTimer();
  epicOfficialActivePollGeneration += 1;
  epicOfficialActivePollState = null;
  epicOfficialActivePollInFlight = null;
  if (!state) return;
  epicOfficialLogger.info("epic-official:poll:stopped", {
    reason,
    configName: state.configName || null,
    accountId: state.accountId || null,
    productId: state.productId || null,
    ...meta,
  });
}

function stopEpicOfficialActivePollIfMatches(
  configName,
  reason = "manual",
  meta = {},
) {
  const state = getEpicOfficialActivePollState();
  if (!state) return;
  if (
    sanitizeConfigName(state.configName || "") !==
    sanitizeConfigName(configName || "")
  ) {
    return;
  }
  if (
    reason === "process-exit" &&
    isEpicOfficialConfigSelectedForPolling(state.configName)
  ) {
    epicOfficialLogger.debug?.("epic-official:poll:keep-selected", {
      reason,
      configName: state.configName || null,
      accountId: state.accountId || null,
      productId: state.productId || null,
      ...meta,
    });
    return;
  }
  stopEpicOfficialActivePoll(reason, meta);
}

function scheduleEpicOfficialActivePoll(delayMs, reason = "reschedule") {
  const state = getEpicOfficialActivePollState();
  if (!state) return;
  clearEpicOfficialActivePollTimer();
  const safeDelay = Math.max(1000, Number(delayMs) || 0);
  state.nextDelayMs = safeDelay;
  epicOfficialLogger.debug?.("epic-official:poll:scheduled", {
    reason,
    configName: state.configName || null,
    delayMs: safeDelay,
    errorCount: state.errorCount || 0,
  });
  epicOfficialActivePollTimer = setTimeout(() => {
    epicOfficialActivePollTimer = null;
    void runEpicOfficialActivePoll("timer");
  }, safeDelay);
}

function markEpicOfficialRecentLoadSync(
  configName,
  accountId,
  productId,
  result,
) {
  pruneEpicOfficialRuntimeState();
  const syncKey = buildEpicOfficialLoadSyncKey(
    configName,
    accountId,
    productId,
  );
  const nextEntry = {
    timestamp: Date.now(),
    result,
  };
  epicOfficialRecentLoadSync.set(syncKey, nextEntry);
  epicOfficialPassiveLoadSync.set(syncKey, nextEntry);
}

function getEpicOfficialUnlockedDelta(
  previousSnapshot = {},
  nextSnapshot = {},
) {
  const unlockedKeys = [];
  let changed = false;
  const allKeys = new Set([
    ...Object.keys(previousSnapshot || {}),
    ...Object.keys(nextSnapshot || {}),
  ]);
  for (const key of allKeys) {
    const prev = previousSnapshot?.[key] || {};
    const next = nextSnapshot?.[key] || {};
    const prevEarned = Boolean(prev?.earned);
    const nextEarned = Boolean(next?.earned);
    const prevEarnedTime = Number(prev?.earned_time || 0);
    const nextEarnedTime = Number(next?.earned_time || 0);
    if (prevEarned !== nextEarned || prevEarnedTime !== nextEarnedTime) {
      changed = true;
    }
    if (nextEarned && !prevEarned) {
      unlockedKeys.push(key);
    }
  }
  return { changed, unlockedKeys };
}

function countEpicOfficialEarnedAchievements(snapshot = {}) {
  let count = 0;
  for (const entry of Object.values(snapshot || {})) {
    if (entry && typeof entry === "object" && entry.earned === true) {
      count += 1;
    }
  }
  return count;
}

function preserveEpicOfficialEarnedStateFromCache(
  nextSnapshot = {},
  cachedSnapshot = {},
) {
  const nextEntries =
    nextSnapshot && typeof nextSnapshot === "object" ? nextSnapshot : {};
  const cachedEntries =
    cachedSnapshot && typeof cachedSnapshot === "object" ? cachedSnapshot : {};
  let changed = false;
  let preservedEarnedCount = 0;
  const merged = { ...nextEntries };
  for (const [key, cachedEntry] of Object.entries(cachedEntries)) {
    if (!cachedEntry || typeof cachedEntry !== "object") continue;
    if (cachedEntry.earned !== true) continue;
    const nextEntry = merged[key];
    if (
      !nextEntry ||
      typeof nextEntry !== "object" ||
      nextEntry.earned !== true
    ) {
      merged[key] = {
        ...(nextEntry && typeof nextEntry === "object" ? nextEntry : {}),
        ...cachedEntry,
        earned: true,
        earned_time:
          Number(cachedEntry.earned_time || 0) || cachedEntry.earned_time || 0,
      };
      changed = true;
      preservedEarnedCount += 1;
      continue;
    }
    const nextEarnedTime = Number(nextEntry.earned_time || 0);
    const cachedEarnedTime = Number(cachedEntry.earned_time || 0);
    if (nextEarnedTime <= 0 && cachedEarnedTime > 0) {
      merged[key] = {
        ...nextEntry,
        earned: true,
        earned_time: cachedEntry.earned_time,
      };
      changed = true;
      preservedEarnedCount += 1;
    }
  }
  return {
    snapshot: changed ? merged : nextEntries,
    changed,
    preservedEarnedCount,
  };
}

function notifyEpicOfficialUnlocks(config, schemaAchievements, unlockedKeys) {
  if (!Array.isArray(schemaAchievements) || !schemaAchievements.length) return;
  if (!Array.isArray(unlockedKeys) || !unlockedKeys.length) return;
  const schemaMap = new Map();
  for (const entry of schemaAchievements) {
    const key = String(entry?.name || entry?.api || "").trim();
    if (!key) continue;
    schemaMap.set(key, entry);
  }
  for (const key of unlockedKeys) {
    const achievementConfig = schemaMap.get(String(key || "").trim());
    if (!achievementConfig) continue;
    queueAchievementNotification({
      name: achievementConfig.name || achievementConfig.api || key,
      displayName: achievementConfig.displayName,
      description: achievementConfig.description,
      icon: achievementConfig.icon,
      icon_gray: achievementConfig.icon_gray || achievementConfig.icongray,
      appid: config?.appid || currentAppId || null,
      platform: normalizePlatform(config?.platform) || null,
      config_path: config?.config_path || selectedConfigPath || "",
      configName: config?.name || "",
      rarityPct: achievementConfig.rarityPct,
      raritySource: achievementConfig.raritySource,
      trophyType: achievementConfig.trophyType || achievementConfig.trophy_type,
      preset: selectedPreset,
      position: selectedPosition,
      sound: getUserPreferredSound() || "mute",
    });
  }
}

function notifyXboxPcProgress(
  config,
  configName,
  schemaAchievements,
  snapshot,
  progressKeys,
) {
  if (!Array.isArray(schemaAchievements) || !schemaAchievements.length) return 0;
  if (!Array.isArray(progressKeys) || !progressKeys.length) return 0;
  const schemaMap = new Map();
  for (const entry of schemaAchievements) {
    const key = String(entry?.name || entry?.api || "").trim();
    if (key) schemaMap.set(key, entry);
  }
  let queued = 0;
  for (const key of progressKeys) {
    const normalizedKey = String(key || "").trim();
    const achievementConfig = schemaMap.get(normalizedKey);
    const current = snapshot?.[key];
    if (!achievementConfig || !current || current.earned === true) continue;
    queueProgressNotification({
      name: achievementConfig.name || achievementConfig.api || normalizedKey,
      displayName: getSafeLocalizedText(
        achievementConfig.displayName,
        selectedLanguage,
      ),
      icon: achievementConfig.icon,
      progress: current.progress,
      max_progress: current.max_progress,
      progress_is_float:
        current.progress_is_float ||
        (!Number.isInteger(Number(current.progress)) ? true : undefined),
      appid: config?.appid || currentAppId || null,
      platform: "xbox-pc",
      config_path: config?.config_path || selectedConfigPath || "",
      configName,
    });
    queued += 1;
  }
  return queued;
}

function isXboxPcConfigActiveForPolling(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  if (isXboxPcConfigBlacklisted(safeName)) return false;
  if (
    selectedConfigMode === "active" &&
    sanitizeConfigName(selectedConfig || "") === safeName
  ) {
    return true;
  }
  if (sanitizeConfigName(detectedConfigName || "") === safeName) return true;
  for (const activeName of activePlaytimeConfigs) {
    if (sanitizeConfigName(activeName || "") === safeName) return true;
  }
  return false;
}

function isXboxPcConfigBlacklisted(configName, config = null) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  const resolvedConfig =
    config && typeof config === "object"
      ? config
      : readConfigForAchievementCache(safeName);
  if (
    !resolvedConfig ||
    normalizePlatform(resolvedConfig?.platform) !== "xbox-pc"
  ) {
    return false;
  }
  const titleId = String(
    resolvedConfig?.xbox_title_id || resolvedConfig?.appid || "",
  ).trim();
  return titleId ? isAppIdBlacklisted(titleId, "xbox-pc") : false;
}

function markXboxPcRecentSync(syncKey) {
  const key = String(syncKey || "").trim();
  if (!key) return;
  xboxPcRecentLoadSync.set(key, Date.now());
  if (xboxPcRecentLoadSync.size <= XBOX_PC_RECENT_SYNC_MAX_ENTRIES) return;
  const entries = [...xboxPcRecentLoadSync.entries()].sort(
    (left, right) => Number(left[1] || 0) - Number(right[1] || 0),
  );
  for (
    let index = 0;
    index < entries.length - XBOX_PC_RECENT_SYNC_MAX_ENTRIES;
    index += 1
  ) {
    xboxPcRecentLoadSync.delete(entries[index][0]);
  }
}

function stopXboxPcActivePoll(reason = "manual", meta = {}) {
  if (xboxPcActivePollTimer) {
    clearTimeout(xboxPcActivePollTimer);
    xboxPcActivePollTimer = null;
  }
  const previous = xboxPcActivePollState;
  xboxPcActivePollGeneration += 1;
  xboxPcActivePollState = null;
  xboxPcActivePollInFlight = null;
  if (previous) {
    xboxPcLogger.info("xbox-pc:poll-stopped", {
      reason,
      configName: previous.configName || null,
      ...meta,
    });
  }
}

function scheduleXboxPcActivePoll(delayMs, reason = "reschedule") {
  if (!xboxPcActivePollState) return;
  if (xboxPcActivePollTimer) clearTimeout(xboxPcActivePollTimer);
  const safeDelay = Math.max(5000, Number(delayMs) || 0);
  xboxPcActivePollTimer = setTimeout(() => {
    xboxPcActivePollTimer = null;
    void runXboxPcActivePoll("timer");
  }, safeDelay);
  xboxPcLogger.debug?.("xbox-pc:poll-scheduled", {
    reason,
    configName: xboxPcActivePollState.configName || null,
    delayMs: safeDelay,
  });
}

async function runXboxPcActivePoll(trigger = "manual") {
  const state = xboxPcActivePollState;
  if (!state || xboxPcActivePollInFlight) return;
  if (!isXboxPcConfigActiveForPolling(state.configName)) {
    stopXboxPcActivePoll("inactive", { trigger });
    return;
  }
  const safeName = sanitizeConfigName(state.configName || "");
  const configPath = path.join(configsDir, `${safeName}.json`);
  if (!safeName || !fs.existsSync(configPath)) {
    stopXboxPcActivePoll("config-missing", { trigger });
    return;
  }
  const generation = xboxPcActivePollGeneration;
  const job = (async () => {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (normalizePlatform(config?.platform) !== "xbox-pc") {
      stopXboxPcActivePoll("platform-changed", { trigger });
      return;
    }
    if (isXboxPcConfigBlacklisted(safeName, config)) {
      stopXboxPcActivePoll("blacklisted", {
        trigger,
        appid: config?.xbox_title_id || config?.appid || null,
      });
      return;
    }
    const cached =
      (await loadPreviousAchievements(safeName, "xbox-pc")) || {};
    const synced = await syncXboxPcAchievements(config, {
      userDataDir: app.getPath("userData"),
      timeoutMs: 15000,
    });
    if (generation !== xboxPcActivePollGeneration) return;
    const preserved = preserveEpicOfficialEarnedStateFromCache(
      synced.snapshot || {},
      cached,
    );
    const snapshot = mergeEarnedTimeFromCached(
      preserved.snapshot || {},
      cached,
    );
    const delta = getXboxPcSnapshotDelta(cached, snapshot);
    const snapshotChanged = !deepEqual(cached || {}, snapshot || {});
    const hadCachedSnapshot = Object.keys(cached || {}).length > 0;
    savePreviousAchievements(safeName, snapshot, "xbox-pc");
    markXboxPcRecentSync(
      `${synced.xuid || config.xbox_xuid}:${synced.titleId || config.appid}`,
    );
    if (config.save_path) {
      try {
        fs.mkdirSync(config.save_path, { recursive: true });
        fs.writeFileSync(
          path.join(config.save_path, "achievements.json"),
          JSON.stringify(snapshot, null, 2),
        );
      } catch (error) {
        xboxPcLogger.warn("xbox-pc:poll-state-write-failed", {
          configName: safeName,
          error: error?.message || String(error),
        });
      }
    }
    if (snapshotChanged) {
      let schemaAchievements = [];
      try {
        const schemaPath = resolveAchievementsSchemaPath(config);
        schemaAchievements = schemaPath
          ? JSON.parse(fs.readFileSync(schemaPath, "utf8"))
          : [];
      } catch {}
      if (hadCachedSnapshot && delta.unlockedKeys.length) {
        notifyEpicOfficialUnlocks(
          config,
          schemaAchievements,
          delta.unlockedKeys,
        );
        xboxPcLogger.info("xbox-pc:poll-unlocks-detected", {
          configName: safeName,
          unlockedCount: delta.unlockedKeys.length,
        });
      }
      if (hadCachedSnapshot && delta.progressKeys.length) {
        const progressCount = notifyXboxPcProgress(
          config,
          safeName,
          schemaAchievements,
          snapshot,
          delta.progressKeys,
        );
        if (progressCount > 0) {
          xboxPcLogger.info("xbox-pc:poll-progress-detected", {
            configName: safeName,
            progressCount,
          });
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("refresh-achievements-table", safeName);
      }
      if (
        overlayWindow &&
        !overlayWindow.isDestroyed() &&
        sanitizeConfigName(selectedConfig || "") === safeName
      ) {
        overlayWindow.webContents.send("load-overlay-data", safeName);
        overlayWindow.webContents.send("set-language", {
          language: selectedLanguage,
          uiLanguage: selectedUiLanguage,
        });
      }
      broadcastToAll("achievements:file-updated", {
        appid: config.appid || null,
        configName: safeName,
      });
    }
    state.errorCount = 0;
    xboxPcLogger.debug?.("xbox-pc:poll-success", {
      trigger,
      configName: safeName,
      changed: snapshotChanged,
      unlockedCount: delta.unlockedKeys.length,
    });
    scheduleXboxPcActivePoll(XBOX_PC_ACTIVE_POLL_INTERVAL_MS, "success");
  })()
    .catch((error) => {
      if (!xboxPcActivePollState) return;
      state.errorCount = (state.errorCount || 0) + 1;
      const retryMs = Math.min(
        5 * 60 * 1000,
        30000 * 2 ** Math.min(state.errorCount, 4),
      );
      xboxPcLogger.warn("xbox-pc:poll-failed", {
        trigger,
        configName: safeName,
        error: error?.message || String(error),
        retryInMs: retryMs,
      });
      scheduleXboxPcActivePoll(retryMs, "error-backoff");
    })
    .finally(() => {
      if (xboxPcActivePollInFlight === job) {
        xboxPcActivePollInFlight = null;
      }
    });
  xboxPcActivePollInFlight = job;
  await job;
}

function startXboxPcActivePoll(configName, reason = "active-config") {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  if (!isXboxPcConfigActiveForPolling(safeName)) return false;
  if (xboxPcActivePollState?.configName === safeName) return true;
  stopXboxPcActivePoll("restart", { nextConfig: safeName });
  xboxPcActivePollState = { configName: safeName, errorCount: 0 };
  xboxPcLogger.info("xbox-pc:poll-started", {
    reason,
    configName: safeName,
    intervalMs: XBOX_PC_ACTIVE_POLL_INTERVAL_MS,
  });
  scheduleXboxPcActivePoll(XBOX_PC_ACTIVE_POLL_INITIAL_MS, reason);
  return true;
}

function filterRecentEpicOfficialUnlockNotificationKeys(
  configName,
  accountId,
  productId,
  unlockedKeys,
) {
  if (!Array.isArray(unlockedKeys) || !unlockedKeys.length) return [];
  const now = Date.now();
  if (epicOfficialRecentUnlockNotificationState.size > 1000) {
    for (const [key, timestamp] of epicOfficialRecentUnlockNotificationState) {
      if (now - timestamp > EPIC_OFFICIAL_UNLOCK_NOTIFY_DEDUPE_MS) {
        epicOfficialRecentUnlockNotificationState.delete(key);
      }
    }
  }
  const scope = buildEpicOfficialLoadSyncKey(configName, accountId, productId);
  const nextKeys = [];
  for (const unlockKey of unlockedKeys) {
    const normalizedUnlockKey = String(unlockKey || "").trim();
    if (!normalizedUnlockKey) continue;
    const dedupeKey = `${scope}::${normalizedUnlockKey}`;
    const previous = epicOfficialRecentUnlockNotificationState.get(dedupeKey);
    if (previous && now - previous <= EPIC_OFFICIAL_UNLOCK_NOTIFY_DEDUPE_MS) {
      continue;
    }
    epicOfficialRecentUnlockNotificationState.set(dedupeKey, now);
    nextKeys.push(normalizedUnlockKey);
  }
  return nextKeys;
}

function handleEpicOfficialSnapshotDelta({
  source = "poll",
  trigger = "manual",
  config,
  configName,
  schemaAchievements,
  snapshot,
  delta,
  hadCachedSnapshot,
  accountId,
  productId,
} = {}) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName || !delta?.changed) return false;

  const suppressFromSilentSeed =
    hadCachedSnapshot &&
    shouldSuppressEpicOfficialUnlocksFromSilentSeed(
      safeName,
      accountId,
      productId,
      snapshot,
      delta,
    );

  if (
    hadCachedSnapshot &&
    Array.isArray(delta.unlockedKeys) &&
    delta.unlockedKeys.length &&
    !suppressFromSilentSeed
  ) {
    const notificationKeys = filterRecentEpicOfficialUnlockNotificationKeys(
      safeName,
      accountId,
      productId,
      delta.unlockedKeys,
    );
    notifyEpicOfficialUnlocks(config, schemaAchievements, notificationKeys);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("refresh-achievements-table", safeName);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("load-overlay-data", selectedConfig);
    overlayWindow.webContents.send("set-language", {
      language: selectedLanguage,
      uiLanguage: selectedUiLanguage,
    });
  }
  broadcastToAll("achievements:file-updated", {
    appid: currentAppId || config?.appid || null,
    configName: safeName,
  });
  const logEvent =
    source === "active-poll"
      ? "epic-official:poll:new-achievements"
      : "load-saved-achievements:epic-official:new-achievements";
  epicOfficialLogger.info(logEvent, {
    source,
    trigger,
    configName: safeName,
    accountId: accountId || null,
    productId: productId || null,
    unlockedCount: Array.isArray(delta.unlockedKeys)
      ? delta.unlockedKeys.length
      : 0,
    changed: true,
  });
  return true;
}

async function runEpicOfficialActivePoll(trigger = "manual") {
  const state = getEpicOfficialActivePollState();
  if (!state) return;
  if (epicOfficialActivePollInFlight) {
    epicOfficialLogger.debug?.("epic-official:poll:skip-inflight", {
      trigger,
      configName: state.configName || null,
    });
    return;
  }
  if (!isEpicOfficialConfigActiveForPolling(state.configName)) {
    stopEpicOfficialActivePoll("process-exit", {
      trigger,
      configName: state.configName || null,
    });
    return;
  }

  const generation = epicOfficialActivePollGeneration;
  const job = (async () => {
    const safeName = sanitizeConfigName(state.configName || "");
    if (!safeName) {
      stopEpicOfficialActivePoll("invalid-config-name", { trigger });
      return;
    }
    const cfgPath = path.join(configsDir, `${safeName}.json`);
    if (!fs.existsSync(cfgPath)) {
      stopEpicOfficialActivePoll("config-missing", {
        trigger,
        configName: safeName,
      });
      return;
    }
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (error) {
      epicOfficialLogger.warn("epic-official:poll:config-read-failed", {
        trigger,
        configName: safeName,
        error: error?.message || String(error),
      });
      scheduleEpicOfficialActivePoll(
        EPIC_OFFICIAL_ACTIVE_POLL_ERROR_DELAYS_MS[
          Math.min(
            state.errorCount || 0,
            EPIC_OFFICIAL_ACTIVE_POLL_ERROR_DELAYS_MS.length - 1,
          )
        ],
        "config-read-failed",
      );
      state.errorCount = (state.errorCount || 0) + 1;
      return;
    }
    if (normalizePlatform(config?.platform) !== "epic-official") {
      stopEpicOfficialActivePoll("platform-changed", {
        trigger,
        configName: safeName,
        platform: config?.platform || null,
      });
      return;
    }
    if (isEpicOfficialConfigBlacklisted(safeName, config)) {
      stopEpicOfficialActivePoll("blacklisted", {
        trigger,
        configName: safeName,
        appid:
          String(
            config?.appid ||
              config?.epic_product_id ||
              config?.epicProductId ||
              "",
          ).trim() || null,
      });
      return;
    }

    const schemaPath = resolveAchievementsSchemaPath(config);
    let schemaAchievements = [];
    if (schemaPath && fs.existsSync(schemaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        if (Array.isArray(parsed)) schemaAchievements = parsed;
      } catch {}
    }
    let productId = String(
      config?.epic_product_id || config?.epicProductId || config?.appid || "",
    ).trim();
    if (schemaPath) {
      try {
        const sidecarPath = path.join(
          path.dirname(schemaPath),
          "achievementpercentages.json",
        );
        if (fs.existsSync(sidecarPath)) {
          const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
          if (sidecar?.appid) productId = String(sidecar.appid).trim();
        }
      } catch {}
    }
    const token = await ensureEpicAccessToken(
      getEpicAuthRequestOptions({
        timeoutMs: 15000,
      }),
    );
    const accountId = resolvePreferredEpicOfficialAccountId(config, token);
    const cached =
      (await loadPreviousAchievements(safeName, "epic-official", {
        accountId,
      })) || {};

    epicOfficialLogger.debug?.("epic-official:poll:start", {
      trigger,
      configName: safeName,
      accountId: accountId || null,
      productId: productId || null,
    });

    const synced = await syncEpicOfficialAchievements(
      config,
      getEpicAuthRequestOptions({
        token,
        accountId,
        productId,
        schemaAchievements,
        timeoutMs: 15000,
      }),
    );
    if (generation !== epicOfficialActivePollGeneration) return;

    const preservedSnapshot = preserveEpicOfficialEarnedStateFromCache(
      synced.snapshot || {},
      cached,
    );
    const snapshot = mergeEarnedTimeFromCached(
      preservedSnapshot.snapshot || {},
      cached,
    );
    const result = {
      achievements: snapshot || {},
      save_path: config.save_path || "",
    };
    const nextAccountId = synced.accountId || accountId || "";
    const nextProductId = synced.productId || productId || "";
    const delta = getEpicOfficialUnlockedDelta(cached, snapshot);
    const hadCachedSnapshot = Object.keys(cached || {}).length > 0;
    const cachedEarnedCount = countEpicOfficialEarnedAchievements(cached);
    const nextEarnedCount = countEpicOfficialEarnedAchievements(snapshot);
    if (!hadCachedSnapshot && Number(synced.totalUnlocked || 0) > 0) {
      markEpicOfficialSilentSeed(safeName, nextAccountId, nextProductId, {
        expectedUnlocked: synced.totalUnlocked || 0,
        reason: "active-poll",
      });
    }

    if (preservedSnapshot.changed) {
      epicOfficialLogger.warn("epic-official:poll:regression-preserved", {
        trigger,
        configName: safeName,
        accountId: nextAccountId || null,
        productId: nextProductId || null,
        cachedEarnedCount,
        nextEarnedCount,
        preservedEarnedCount: preservedSnapshot.preservedEarnedCount || 0,
        reportedTotalUnlocked: Number(synced.totalUnlocked || 0) || 0,
      });
    }

    if (!deepEqual(cached || {}, snapshot || {})) {
      savePreviousAchievements(safeName, snapshot, "epic-official", {
        accountId: nextAccountId,
      });
    }
    markEpicOfficialRecentLoadSync(
      safeName,
      nextAccountId,
      nextProductId,
      result,
    );

    if (
      nextAccountId !== (config?.epic_account_id || "") ||
      nextProductId !== (config?.epic_product_id || "")
    ) {
      config.epic_account_id = nextAccountId;
      config.epic_product_id = nextProductId;
      try {
        fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      } catch {}
    }

    state.accountId = nextAccountId;
    state.productId = nextProductId;
    state.errorCount = 0;

    if (delta.changed) {
      handleEpicOfficialSnapshotDelta({
        source: "active-poll",
        trigger,
        config,
        configName: safeName,
        schemaAchievements,
        snapshot,
        delta,
        hadCachedSnapshot,
        accountId: nextAccountId || null,
        productId: nextProductId || null,
      });
    } else {
      epicOfficialLogger.debug?.("epic-official:poll:no-change", {
        trigger,
        configName: safeName,
        accountId: nextAccountId || null,
        productId: nextProductId || null,
      });
    }

    epicOfficialLogger.debug?.("epic-official:poll:success", {
      trigger,
      configName: safeName,
      accountId: nextAccountId || null,
      productId: nextProductId || null,
      snapshotCount: Object.keys(snapshot || {}).length,
      unlockedCount: delta.unlockedKeys.length,
      changed: delta.changed,
    });
    scheduleEpicOfficialActivePoll(
      EPIC_OFFICIAL_ACTIVE_POLL_INTERVAL_MS,
      "success",
    );
  })()
    .catch((error) => {
      const currentState = getEpicOfficialActivePollState();
      if (!currentState) return;
      currentState.errorCount = (currentState.errorCount || 0) + 1;
      const delayMs =
        EPIC_OFFICIAL_ACTIVE_POLL_ERROR_DELAYS_MS[
          Math.min(
            currentState.errorCount - 1,
            EPIC_OFFICIAL_ACTIVE_POLL_ERROR_DELAYS_MS.length - 1,
          )
        ];
      epicOfficialLogger.warn("epic-official:poll:error", {
        trigger,
        configName: currentState.configName || null,
        error: error?.message || String(error),
        status: Number(error?.status || error?.response?.status || 0) || null,
        code: error?.code || null,
        endpoint: error?.endpoint || error?.url || null,
        retryInMs: delayMs,
        errorCount: currentState.errorCount,
      });
      scheduleEpicOfficialActivePoll(delayMs, "error-backoff");
    })
    .finally(() => {
      if (generation === epicOfficialActivePollGeneration) {
        epicOfficialActivePollInFlight = null;
      }
    });

  epicOfficialActivePollInFlight = job;
  await job;
}

function startEpicOfficialActivePoll(configName, reason = "active-config") {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return false;
  if (isEpicOfficialConfigBlacklisted(safeName)) {
    stopEpicOfficialActivePoll("blacklisted", {
      reason,
      configName: safeName,
    });
    epicOfficialLogger.debug?.("epic-official:poll:skip-blacklisted", {
      reason,
      configName: safeName,
    });
    return false;
  }
  if (!isEpicOfficialConfigActiveForPolling(safeName)) {
    stopEpicOfficialActivePoll("inactive-config", {
      reason,
      configName: safeName,
    });
    return false;
  }
  const existing = getEpicOfficialActivePollState();
  if (existing?.configName === safeName) {
    epicOfficialLogger.debug?.("epic-official:poll:already-active", {
      reason,
      configName: safeName,
    });
    return true;
  }
  stopEpicOfficialActivePoll("restart", {
    reason,
    nextConfig: safeName,
  });
  epicOfficialActivePollState = {
    configName: safeName,
    accountId: "",
    productId: "",
    errorCount: 0,
    nextDelayMs: EPIC_OFFICIAL_ACTIVE_POLL_INITIAL_MS,
  };
  epicOfficialLogger.info("epic-official:poll:started", {
    reason,
    configName: safeName,
    delayMs: EPIC_OFFICIAL_ACTIVE_POLL_INITIAL_MS,
  });
  scheduleEpicOfficialActivePoll(EPIC_OFFICIAL_ACTIVE_POLL_INITIAL_MS, reason);
  return true;
}

ipcMain.on("toggle-overlay", (_event, selectedConfig) => {
  if (isBootOnboardingGatePending() || global.bootOnboardingRequired) return;
  const requestedConfig = isNonEmptyString(selectedConfig)
    ? sanitizeConfigName(selectedConfig)
    : null;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow(requestedConfig);
  } else {
    overlayWindow.webContents.send("load-overlay-data", requestedConfig);
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
  initializeNativeWindowsActivationHandler();
  try {
    await ensureSchemaParseRuntimeReady({
      userDataDir: app.getPath("userData"),
      refreshTopOwners: true,
      reason: "boot",
    });
  } catch (err) {
    appLogger.warn("schema-parse:boot-init-failed", {
      error: err?.message || String(err),
    });
  }
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
      processPoller.setEnabled(true);
      processPoller.setEventWatcherEnabled(isProcessNameWatcherEnabled(prefs));
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
  void pruneAppUpdatePendingCache({ trigger: "startup" });

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow({ forceShow: !!pendingAppNavigationRoute });
  } else if (pendingAppNavigationRoute) {
    showMainWindowForNavigation();
  }
  syncOverlayControllerSupportState("app-ready", cachedPreferences);
  scheduleAutoSelectProcessPollerAfterBoot();
  mainWindow.hide();
  schedulePostBootUiInitialization();
  initializeStartupAppUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("will-quit", () => {
  activeNativeAchievementNotifications.releaseAll("app-will-quit");
  overlayControllerService?.shutdown?.("app:will-quit");
  clearOverlayShortcutRegistration();
  clearOverlayInteractShortcut();
  clearOverlayGlobalDragHookRegistration();
  overlayShortcutManager.shutdown();
});

function showProgressNotification(data) {
  const scale = normalizeNotificationScale(
    data?.scale ?? cachedPreferences?.notificationScale ?? 1,
  ).scale;
  windowLogger.info("create-progress-window:start", {
    displayName: data?.displayName || "",
    config: data?.config_path || null,
    scale,
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
  const {
    x: ax,
    y: ay,
    width: aw,
    height: ah,
  } = screen.getPrimaryDisplay().workArea;
  const scaledProgressWidth = Math.ceil(
    progressWidth * (scale > 1 ? scale : 1),
  );
  const scaledProgressContentHeight = Math.ceil(
    progressHeight * (scale > 1 ? scale : 1),
  );
  const progressAnimationPaddingY = Math.ceil(36 * (scale > 1 ? scale : 1));
  const scaledProgressHeight =
    scaledProgressContentHeight + progressAnimationPaddingY;
  const position =
    String(
      data?.position ||
        cachedPreferences?.progressPosition ||
        DEFAULT_PREFERENCES.progressPosition ||
        "bottom-left",
    ).trim() || "bottom-left";
  const gapX = 20;
  const gapY = 10;
  const centeredPaddingOffsetY = Math.floor(progressAnimationPaddingY / 2);
  let x = ax + gapX;
  let y =
    ay + ah - scaledProgressContentHeight - gapY - centeredPaddingOffsetY;
  switch (position) {
    case "center-top":
      x = ax + Math.floor((aw - scaledProgressWidth) / 2);
      y = ay + gapY - centeredPaddingOffsetY;
      break;
    case "top-right":
      x = ax + aw - scaledProgressWidth - gapX;
      y = ay + gapY - centeredPaddingOffsetY;
      break;
    case "bottom-right":
      x = ax + aw - scaledProgressWidth - gapX;
      y =
        ay +
        ah -
        scaledProgressContentHeight -
        gapY -
        centeredPaddingOffsetY;
      break;
    case "middle-right":
      x = ax + aw - scaledProgressWidth - gapX;
      y = ay + Math.floor((ah - scaledProgressHeight) / 2);
      break;
    case "top-left":
      x = ax + gapX;
      y = ay + gapY - centeredPaddingOffsetY;
      break;
    case "bottom-left":
      x = ax + gapX;
      y =
        ay +
        ah -
        scaledProgressContentHeight -
        gapY -
        centeredPaddingOffsetY;
      break;
    case "middle-left":
      x = ax + gapX;
      y = ay + Math.floor((ah - scaledProgressHeight) / 2);
      break;
    case "center-bottom":
    default:
      x = ax + Math.floor((aw - scaledProgressWidth) / 2);
      y =
        ay +
        ah -
        scaledProgressContentHeight -
        gapY -
        centeredPaddingOffsetY;
      break;
  }
  const progressWindow = new BrowserWindow({
    width: scaledProgressWidth,
    height: scaledProgressHeight,
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
    size: { width: scaledProgressWidth, height: scaledProgressHeight },
    baseSize: { width: progressWidth, height: progressHeight },
    contentSize: {
      width: scaledProgressWidth,
      height: scaledProgressContentHeight,
    },
    animationPaddingY: progressAnimationPaddingY,
    position: { x, y },
    durationMs: progressDurationMs,
    progressHtmlPath,
    scale,
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
    progressWindow.webContents.send("show-progress", { ...data, scale });
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
let lastRandomNotificationHeaderPath = "";

function getNotificationFallbackHeaderPath() {
  const candidates = [
    path.join(app.getAppPath(), "assets", "achievements-wallpaper.png"),
    path.join(app.getAppPath(), "assets", "achievements-logo.png"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return candidates[0];
}

function getRandomLocalHeaderImagePath({ fallbackToDefault = true } = {}) {
  const imagesRoot = path.join(app.getPath("userData"), "images");
  const headers = [];
  const pendingDirs = [imagesRoot];

  while (pendingDirs.length) {
    const currentDir = pendingDirs.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== "header.jpg") {
        continue;
      }
      try {
        if (fs.statSync(entryPath).size > 0) headers.push(entryPath);
      } catch {}
    }
  }

  let selectedPath = "";
  if (headers.length) {
    const candidates =
      headers.length > 1
        ? headers.filter((item) => item !== lastRandomNotificationHeaderPath)
        : headers;
    selectedPath = candidates[crypto.randomInt(candidates.length)];
    lastRandomNotificationHeaderPath = selectedPath;
  } else if (fallbackToDefault) {
    selectedPath = getNotificationFallbackHeaderPath();
  }

  return selectedPath;
}

function getRandomTestPlaytimeHeaderUrl() {
  const selectedPath = getRandomLocalHeaderImagePath({
    fallbackToDefault: true,
  });
  return selectedPath
    ? require("url").pathToFileURL(selectedPath).toString()
    : "";
}

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
  const scale = normalizeNotificationScale(p.scale).scale;
  return { ...p, displayName, description, scale, holdMs };
}

function getPlaytimeNotificationScale(prefs = {}) {
  return normalizeNotificationScale(prefs.playtimeNotificationScale ?? 1).scale;
}

ipcMain.on("show-playtime", (_event, playData) => {
  let prefsSnapshot = {};
  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    prefsSnapshot = cur && typeof cur === "object" ? cur : {};
    if (cur.disablePlaytime === true || global.disablePlaytime === true) {
      if (playtimeWindow && !playtimeWindow.isDestroyed())
        playtimeWindow.close();
      return;
    }
  } catch (e) {
    if (global.disablePlaytime === true) return;
  }

  const normalized = normalizePlayPayload({
    ...(playData || {}),
    scale: getPlaytimeNotificationScale(prefsSnapshot),
  });
  if (isDuplicatePlay(normalized)) return;
  createPlaytimeWindow(normalized);
});

ipcMain.on("show-test-progress-notification", (_event, options = {}) => {
  const maxProgress = 50;
  const progress = crypto.randomInt(1, maxProgress + 1);
  const position =
    String(
      options?.position ||
        cachedPreferences?.progressPosition ||
        DEFAULT_PREFERENCES.progressPosition ||
        "bottom-left",
    ).trim() || "bottom-left";

  queueProgressNotification({
    name: "TEST_PROGRESS_NOTIFICATION",
    displayName: tUi(
      "progress.testAchievementName",
      {},
      "Test Progress",
    ),
    progress,
    max_progress: maxProgress,
    position,
    icon: "",
    config_path: "",
    isTestProgress: true,
  });
});

ipcMain.on("show-test-playtime-notification", () => {
  createPlaytimeWindow({
    phase: "start",
    displayName: "Achievements",
    description: tUi("playtime.descStart", {}, "Playtime starting!"),
    headerUrl: getRandomTestPlaytimeHeaderUrl(),
    isTestPlaytime: true,
  });
});

function createPlaytimeWindow(playData = {}) {
  windowLogger.info("create-playtime-window:start", {
    displayName: playData?.displayName || playData?.name || null,
    phase: playData?.phase || "start",
  });
  const phase = playData.phase || "start";
  const isTestPlaytime = playData.isTestPlaytime === true;

  try {
    const cur = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    if (
      !isTestPlaytime &&
      (cur.disablePlaytime === true || global.disablePlaytime === true)
    ) {
      return;
    }
  } catch (e) {
    if (!isTestPlaytime && global.disablePlaytime === true) return;
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
  let playtimeScale = 1;
  try {
    const prefs = fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
    playtimeScale = getPlaytimeNotificationScale(prefs);
  } catch {}
  const scaledWinWidth = Math.ceil(
    winWidth * (playtimeScale > 1 ? playtimeScale : 1),
  );
  const scaledWinHeight = Math.ceil(
    winHeight * (playtimeScale > 1 ? playtimeScale : 1),
  );
  const x = Math.floor(ax + (aw - scaledWinWidth) / 2),
    y = Math.floor(ay + 40);

  playtimeWindow = new BrowserWindow({
    width: scaledWinWidth,
    height: scaledWinHeight,
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
    size: { width: scaledWinWidth, height: scaledWinHeight },
    baseSize: { width: winWidth, height: winHeight },
    scale: playtimeScale,
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
      const scale = getPlaytimeNotificationScale(prefs);
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

  const closePlaytimeWindowHandler = () => {
    const next = pendingPlayData;
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.close();
      playtimeAlreadyClosing = false;
    }
    if (next) {
      pendingPlayData = null;
      createPlaytimeWindow(next);
    }
  };
  ipcMain.once("close-playtime-window", closePlaytimeWindowHandler);

  const localWindow = playtimeWindow;
  localWindow.on("closed", () => {
    windowLogger.info("create-playtime-window:closed");
    ipcMain.removeListener(
      "close-playtime-window",
      closePlaytimeWindowHandler,
    );
    if (playtimeWindow === localWindow) {
      playtimeWindow = null;
      playtimeAlreadyClosing = false;
    }
    pendingPlayData = null;
  });
}

ipcMain.on("queue-achievement-notification", async (_event, payload) => {
  try {
    if (payload?.isTest === true) {
      queueAchievementNotification(payload);
      return;
    }

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
      const config = readConfigForAchievementCache(configName);
      const platform =
        normalizePlatform(payload?.platform) ||
        normalizePlatform(config?.platform) ||
        normalizePlatform(selectedPlatform) ||
        "steam";
      const prev = (await loadPreviousAchievements(configName, platform)) || {};
      const prevEntry = prev[achKey];
      const incomingProg = Number(payload.progress);
      const prevProg = Number(prevEntry?.progress);
      const prevMax = Number(prevEntry?.max_progress);
      const maxProg = Number(payload.max_progress);
      if (prevEntry?.earned === true || prevEntry?.earned === 1) {
        notificationLogger.info("queue-progress:skip-earned", {
          config: configName,
          achievement: achKey,
          source: payload?.source || null,
        });
        return;
      }
      if (
        Number.isFinite(incomingProg) &&
        Number.isFinite(prevProg) &&
        incomingProg <= prevProg &&
        (Number.isNaN(maxProg) || maxProg === prevMax)
      ) {
        notificationLogger.info("queue-progress:skip-stale", {
          config: configName,
          achievement: achKey,
          incomingProgress: incomingProg,
          cachedProgress: prevProg,
          source: payload?.source || null,
        });
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

const processPoller = require("./utils/process-poller");
const {
  readWindowsProcessCommandLines,
} = require("./utils/windows-process-command-line");

const autoSelectIndex = {
  built: false,
  buildPromise: null,
  lastBuildAt: 0,
  exeToConfigs: new Map(), // exeLower -> Set(configName)
  configEntries: new Map(), // configName -> { name, exeLower, exeLowers, appid, data }
};
const autoSelectIndexTimers = new Map(); // configName -> timeout
const AUTO_SELECT_INDEX_UPSERT_DEBOUNCE_MS = 120;
const AUTO_SELECT_INDEX_BUILD_CONCURRENCY = 16;
const PROCESS_COMMAND_LINE_FAILURE_TTL_MS = 10 * 1000;
const PROCESS_COMMAND_LINE_CACHE_MAX_ENTRIES = 256;
const processCommandLineCache = new Map();
let processCommandLineWarnLastAt = 0;
let processMatchAmbiguityWarnLastAt = 0;

function getConfigNameFromConfigFilePath(filePath) {
  try {
    if (!filePath) return "";
    return path.basename(String(filePath), ".json");
  } catch {
    return "";
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
  const exeLowers = Array.isArray(existing?.exeLowers)
    ? existing.exeLowers
    : existing?.exeLower
      ? [existing.exeLower]
      : [];
  for (const exeLower of exeLowers) {
    const set = autoSelectIndex.exeToConfigs.get(exeLower);
    if (!set) continue;
    set.delete(safeName);
    if (set.size === 0) autoSelectIndex.exeToConfigs.delete(exeLower);
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

  if (
    normalizePlatform(data?.platform) === "epic-official" &&
    !hasProcessNameValue(data?.process_name)
  ) {
    const localInstall = resolveEpicLocalInstallation({
      namespace: data?.epic_namespace,
      catalogItemId: data?.epic_catalog_item_id,
      appName: data?.epic_app_name,
    });
    if (localInstall) {
      const nextData = {
        ...data,
        save_path: data?.save_path || localInstall.installLocation || "",
        executable: data?.executable || localInstall.executablePath || "",
        arguments: data?.arguments || localInstall.additionalCommandArgs || "",
        process_name: data?.process_name || localInstall.processName || "",
      };
      const shouldPersist =
        nextData.save_path !== (data?.save_path || "") ||
        nextData.executable !== (data?.executable || "") ||
        nextData.arguments !== (data?.arguments || "") ||
        nextData.process_name !== (data?.process_name || "");
      data = nextData;
      if (shouldPersist) {
        try {
          await fs.promises.writeFile(
            filePath,
            JSON.stringify(nextData, null, 2),
            "utf8",
          );
        } catch {}
      }
    }
  }

  const exeLowers = getProcessExecutableNames(data?.process_name);
  if (!exeLowers.length) {
    removeAutoSelectIndexEntry(safeName);
    return;
  }

  const appid = normalizeConfigAppIdValue(data);
  if (!data.name) data.name = safeName;

  removeAutoSelectIndexEntry(safeName);

  autoSelectIndex.configEntries.set(safeName, {
    name: safeName,
    exeLower: exeLowers[0],
    exeLowers,
    appid,
    data,
  });
  for (const exeLower of exeLowers) {
    if (!autoSelectIndex.exeToConfigs.has(exeLower)) {
      autoSelectIndex.exeToConfigs.set(exeLower, new Set());
    }
    autoSelectIndex.exeToConfigs.get(exeLower).add(safeName);
  }
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
  try {
    processPoller.setEnabled(true);
    processPoller.setEventWatcherEnabled(
      isProcessNameWatcherEnabled(cachedPreferences),
    );
  } catch {}
  autoSelectProcessPollerStarted = true;
  ensureAutoSelectIndexReady().catch(() => {});
  autoSelectProcessPollerUnsubscribe = processPoller.subscribe((list) => {
    autoSelectRunningGameConfig(list);
  });
  appLogger.info("process-poller:auto-select-started", {
    delayMs: AUTO_SELECT_AFTER_BOOT_DELAY_MS,
  });
  try {
    broadcastToAll("epic-official:background-ready", {
      reason: "process-poller-started",
    });
  } catch {}
}

function scheduleAutoSelectProcessPollerAfterBoot() {
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
let autoSelectPendingProcesses = null;

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

async function enrichProcessCommandLinesForAutoSelect(procsByExe) {
  const now = Date.now();
  const detectionMode = String(
    processPoller.getStatus()?.processDetectionMode || "",
  );
  const requireCommandLineForArguments = detectionMode === "hybrid";
  const livePids = new Set();
  for (const procs of procsByExe.values()) {
    for (const proc of Array.isArray(procs) ? procs : []) {
      const pid = Math.floor(Number(proc?.pid));
      if (Number.isFinite(pid) && pid > 0) livePids.add(pid);
    }
  }
  for (const [pid, cached] of processCommandLineCache) {
    if (!livePids.has(pid) || Number(cached?.expiresAt || 0) <= now) {
      processCommandLineCache.delete(pid);
    }
  }

  const pendingByPid = new Map();
  for (const [exe, procs] of procsByExe) {
    const configNames = autoSelectIndex.exeToConfigs.get(exe);
    if (!configNames?.size) continue;
    const requiresArguments = Array.from(configNames).some((configName) => {
      const entry = autoSelectIndex.configEntries.get(configName);
      return getConfigProcessArgTokens(entry?.data).length > 0;
    });
    if (!requiresArguments) continue;

    for (const proc of Array.isArray(procs) ? procs : []) {
      const pid = Math.floor(Number(proc?.pid));
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!requireCommandLineForArguments) continue;
      if (normalizeProcessCmdLine(proc)) continue;

      const processName = String(proc?.name || "").trim().toLowerCase();
      const cached = processCommandLineCache.get(pid);
      if (
        cached &&
        cached.processName === processName &&
        Number(cached.expiresAt || 0) > now
      ) {
        if (cached.cmd) proc.cmd = cached.cmd;
        continue;
      }
      pendingByPid.set(pid, { proc, processName });
    }
  }

  if (!pendingByPid.size) return;

  let resolved = new Map();
  try {
    resolved = await readWindowsProcessCommandLines(
      Array.from(pendingByPid.keys()),
      { timeoutMs: 2000, maxPids: 64 },
    );
  } catch (err) {
    if (now - processCommandLineWarnLastAt >= 30000) {
      processCommandLineWarnLastAt = now;
      appLogger.warn("process-command-line:resolve-failed", {
        count: pendingByPid.size,
        error: err?.message || String(err),
      });
    }
  }

  for (const [pid, pending] of pendingByPid) {
    const cmd = String(resolved.get(pid) || "").trim();
    processCommandLineCache.set(pid, {
      processName: pending.processName,
      cmd,
      expiresAt:
        cmd
          ? Number.POSITIVE_INFINITY
          : Date.now() + PROCESS_COMMAND_LINE_FAILURE_TTL_MS,
    });
    if (cmd) pending.proc.cmd = cmd;
  }
  while (processCommandLineCache.size > PROCESS_COMMAND_LINE_CACHE_MAX_ENTRIES) {
    const oldestPid = processCommandLineCache.keys().next().value;
    if (oldestPid === undefined) break;
    processCommandLineCache.delete(oldestPid);
  }
}

function getProcessConfigMatchKind(proc, configData, configName) {
  if (!proc || !proc.name || !hasProcessNameValue(configData?.process_name)) {
    return PROCESS_CONFIG_MATCH.NONE;
  }
  const exeNames = getProcessExecutableNames(configData.process_name);
  if (!exeNames.length) return PROCESS_CONFIG_MATCH.NONE;
  const mapped = manualLaunchPidMap.get(proc.pid);
  const argTokens = getConfigProcessArgTokens(configData);
  return classifyProcessConfigMatch({
    processName: proc.name,
    executableNames: exeNames,
    argumentTokens: argTokens,
    commandLine: normalizeProcessCmdLine(proc),
    mappedConfigName: mapped || null,
    configName,
  });
}

function processMatchesConfig(proc, configData, configName) {
  return (
    getProcessConfigMatchKind(proc, configData, configName) !==
    PROCESS_CONFIG_MATCH.NONE
  );
}

async function autoSelectRunningGameConfigOnce(processes) {
  try {
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return;
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
    await enrichProcessCommandLinesForAutoSelect(procsByExe);

    const getEntry = (name) => {
      const safe = sanitizeConfigName(name || "");
      if (!safe) return null;
      return autoSelectIndex.configEntries.get(safe) || null;
    };

    const isBlacklisted = (entry) => {
      const id = String(entry?.appid || "").trim();
      if (!id) return false;
      return isAppIdBlacklisted(id, entry?.data?.platform || null);
    };

    const isEntryRunning = (entry, configName) => {
      const exeLowers = Array.isArray(entry?.exeLowers)
        ? entry.exeLowers
        : entry?.exeLower
          ? [entry.exeLower]
          : [];
      if (
        !exeLowers.length ||
        !hasProcessNameValue(entry?.data?.process_name)
      ) {
        return false;
      }
      return exeLowers.some((exeLower) => {
        const procs = procsByExe.get(exeLower) || [];
        if (!procs.length) return false;
        return procs.some((p) =>
          processMatchesConfig(p, entry.data, configName),
        );
      });
    };

    if (manualLaunchInProgress) {
      const entry = getEntry(detectedConfigName);
      if (!entry) {
        stopEpicOfficialActivePollIfMatches(
          detectedConfigName,
          "entry-missing",
          {
            configName: detectedConfigName || null,
            source: "manual-launch",
          },
        );
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
          stopEpicOfficialActivePollIfMatches(
            entry?.name || detectedConfigName,
            "process-exit",
            {
              configName: entry?.name || detectedConfigName || null,
              source: "manual-launch",
            },
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
        stopEpicOfficialActivePollIfMatches(
          detectedConfigName,
          "entry-missing",
          {
            configName: detectedConfigName || null,
            source: "detected-config",
          },
        );
        detectedConfigName = null;
      } else {
        const isStillRunning = isEntryRunning(entry, detectedConfigName);
        if (!isStillRunning) {
          notifyInfo(
            tUi("main.notify.config.closed", {
              name: entry?.data?.name || entry?.name || detectedConfigName,
            }),
          );
          stopEpicOfficialActivePollIfMatches(
            entry?.name || detectedConfigName,
            "process-exit",
            {
              configName: entry?.name || detectedConfigName || null,
              source: "detected-config",
            },
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
        stopEpicOfficialActivePollIfMatches(activeName, "entry-missing", {
          configName: activeName || null,
          source: "active-playtime-set",
        });
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
        stopEpicOfficialActivePollIfMatches(
          entry?.name || activeName,
          "process-exit",
          {
            configName: entry?.name || activeName || null,
            source: "active-playtime-set",
          },
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

      const activeCandidateStillRunning = Array.from(candidates).some(
        (configName) => {
          if (!activePlaytimeConfigs.has(configName)) return false;
          const activeEntry = getEntry(configName);
          return (
            !!activeEntry &&
            (Array.isArray(procs) ? procs : []).some((processInfo) =>
              processMatchesConfig(
                processInfo,
                activeEntry.data,
                activeEntry.name,
              ),
            )
          );
        },
      );
      if (activeCandidateStillRunning) continue;

      const matchingCandidates = [];
      for (const configName of Array.from(candidates)) {
        if (activePlaytimeConfigs.has(configName)) continue;

        const entry = getEntry(configName);
        if (!entry) continue;
        if (isBlacklisted(entry)) continue;

        const processMatches = (Array.isArray(procs) ? procs : [])
          .map((processInfo) => ({
            processInfo,
            matchKind: getProcessConfigMatchKind(
              processInfo,
              entry.data,
              entry.name,
            ),
          }))
          .filter(
            ({ matchKind }) => matchKind !== PROCESS_CONFIG_MATCH.NONE,
          );
        if (!processMatches.length) continue;
        processMatches.sort(
          (a, b) =>
            getProcessConfigMatchRank(b.matchKind) -
            getProcessConfigMatchRank(a.matchKind),
        );
        const bestProcessMatch = processMatches[0];
        matchingCandidates.push({
          configName,
          entry,
          matchKind: bestProcessMatch.matchKind,
          processInfo: bestProcessMatch.processInfo,
        });
      }

      if (!matchingCandidates.length) continue;
      const candidateSelection = selectBestProcessConfigCandidate(
        matchingCandidates,
      );
      const detectionMode = String(
        processPoller.getStatus()?.processDetectionMode || "",
      );
      if (candidateSelection.ambiguous) {
        if (Date.now() - processMatchAmbiguityWarnLastAt >= 30000) {
          processMatchAmbiguityWarnLastAt = Date.now();
          appLogger.warn("process-poller:ambiguous-executable-match", {
            executable: exe,
            detectionMode,
            matchRank: candidateSelection.matchRank,
            candidates: candidateSelection.bestCandidates.map((candidate) => ({
              config: sanitizeConfigName(candidate.configName),
              matchKind: candidate.matchKind,
            })),
          });
        }
        continue;
      }

      const selectedCandidate = candidateSelection.selected;
      if (!selectedCandidate) continue;
      if (
        selectedCandidate.matchKind ===
          PROCESS_CONFIG_MATCH.EXECUTABLE_ARGUMENTS_MISMATCH ||
        selectedCandidate.matchKind ===
          PROCESS_CONFIG_MATCH.EXECUTABLE_COMMAND_LINE_UNAVAILABLE
      ) {
        appLogger.info("process-poller:executable-fallback-match", {
          executable: exe,
          detectionMode,
          config: sanitizeConfigName(selectedCandidate.configName),
          reason: selectedCandidate.matchKind,
          candidateCount: candidateSelection.candidates.length,
        });
      }

      const entry = selectedCandidate.entry;
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
  } catch (err) {
    notifyError(
      tUi("main.notify.autoSelect.error", {
        error: err?.message || String(err),
      }),
    );
  }
}

async function autoSelectRunningGameConfig(processes) {
  autoSelectPendingProcesses = Array.isArray(processes) ? processes : [];
  if (autoSelectRunningGameConfigInFlight) return;

  autoSelectRunningGameConfigInFlight = true;
  try {
    while (autoSelectPendingProcesses !== null) {
      const nextProcesses = autoSelectPendingProcesses;
      autoSelectPendingProcesses = null;
      await autoSelectRunningGameConfigOnce(nextProcesses);
    }
  } finally {
    autoSelectRunningGameConfigInFlight = false;
    if (autoSelectPendingProcesses !== null) {
      const trailingProcesses = autoSelectPendingProcesses;
      autoSelectPendingProcesses = null;
      autoSelectRunningGameConfig(trailingProcesses).catch((err) => {
        appLogger.warn("auto-select:pending-snapshot-failed", {
          error: err?.message || String(err),
        });
      });
    }
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
  generateConfigsForAppIds,
  generateConfigForAppId,
} = require("./utils/auto-config-generator");
const {
  loadAchievementsFromSaveFile,
  getSafeLocalizedText,
  buildCrcNameMap,
  resolveConfigSchemaPath,
} = require("./utils/achievement-data");
const {
  EXOPHASE_LANG_MAP,
  EXOPHASE_RARITY_SOURCE,
  buildExophaseSlugVariants,
  fetchExophaseAchievementsMultiLang,
} = require("./utils/exophase-scraper");
const {
  buildGogOfficialRarityEntries,
  buildGogOfficialSnapshot,
  ensureGogOfficialSchema,
  readGogGameplayDb,
  resolveGogOfficialGameplayDbForConfig,
} = require("./utils/gog-galaxy-local");
const {
  buildUbisoftOfficialSnapshot,
  ensureUbisoftOfficialSchema,
  readUbisoftSpoolFile,
  resolveUbisoftOfficialSpoolFileForConfig,
  resolveUbisoftSteamAppId,
} = require("./utils/ubisoft-connect-local");
const {
  EA_VERBOSE_LOG_NAME,
  buildEaOfficialSnapshot,
  ensureEaOfficialSchema,
  readEaDesktopVerboseLog,
  resolveEaOfficialAchievementSetForAppId,
  resolveEaOfficialVerboseLogForConfig,
} = require("./utils/ea-desktop-local");
const {
  EPIC_LAUNCHER_USER_AGENT,
  authenticateEpicWithCode,
  buildEpicLoginUrl,
  clearEpicTokens,
  ensureEpicAccessToken,
  getEpicAuthStatus,
  normalizeEpicAccountId,
} = require("./utils/epic-auth");
const {
  ensureEpicOfficialSchema,
  importEpicOfficialLibrary,
  syncEpicOfficialAchievements,
} = require("./utils/epic-official");
const {
  resolveEpicLocalInstallation,
} = require("./utils/epic-local-installations");
const {
  XBOX_PC_CLIENT_ID,
  buildXboxDirectAuthorizeUrl,
  clearXboxDirectAuth,
  completeXboxDirectAuthentication,
  extractXboxDirectAuthResult,
  getXboxPcAuthErrorInfo,
  getXboxPcStatus,
  fetchXboxAchievementRarityPercentages,
  getXboxPcSnapshotDelta,
  importXboxPcLibrary,
  syncXboxPcAchievements,
} = require("./utils/xbox-pc");

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
  if (files.length > 0) {
    broadcastBootCacheProgress("generation:progress:start", {
      phase: "loadingCache",
      current: 0,
      total: files.length,
      percent: 0,
    });
  }
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

    if (platform === "shadps4") {
      try {
        const ps4Trophy = require("./utils/shadps4-trophy");
        const progressPath = resolvePs4ProgressPathForConfig(config);
        const trophyDir = resolvePs4TrophyDirForConfig(config);
        const npcommid = String(config?.shadps4_npcommid || "").trim();
        const shadPs4Root = resolveShadPs4RootForConfig(config);
        const progressFiles =
          shadPs4Root && npcommid
            ? collectPs4ProgressFilesForConfig(
                shadPs4Root,
                npcommid,
                String(config?.shadps4_user_id || "").trim(),
              )
            : [];
        if (
          progressPath &&
          fs.existsSync(progressPath) &&
          !progressFiles.some(
            (entry) =>
              path.normalize(entry.progressPath).toLowerCase() ===
              path.normalize(progressPath).toLowerCase(),
          )
        ) {
          progressFiles.unshift({
            userId: getPs4UserIdFromProgressPath(progressPath),
            progressPath,
          });
        }
        let snapshot = null;
        let fallbackPs4CacheOptions = null;
        let seededAnyPs4User = false;
        for (const progressFile of progressFiles) {
          const currentProgressPath = progressFile?.progressPath || "";
          if (!currentProgressPath || !fs.existsSync(currentProgressPath)) {
            continue;
          }
          const ps4CacheOptions = {
            appid: config?.appid || "",
            filePath: currentProgressPath,
            savePath: currentProgressPath,
            shadps4UserId:
              progressFile?.userId ||
              getPs4UserIdFromProgressPath(currentProgressPath),
          };
          const previous =
            (await loadPreviousAchievements(
              configFileName,
              platform,
              ps4CacheOptions,
            )) || {};
          const userSnapshot = ps4Trophy.buildSnapshotFromPs4ProgressFile(
            currentProgressPath,
            previous,
          );
          if (userSnapshot && Object.keys(userSnapshot).length) {
            seedCacheFromSnapshot(
              configFileName,
              userSnapshot,
              platform,
              ps4CacheOptions,
            );
            updateAchCacheMetaEntry(
              configFileName,
              platform,
              currentProgressPath,
              String(config?.appid || ""),
            );
            seededAnyPs4User = true;
            bumpCacheBatchStat("seeded");
          }
        }
        if (!seededAnyPs4User && trophyDir && fs.existsSync(trophyDir)) {
          const schemaFile = path.join(trophyDir, "Xml", "TROP.XML");
          fallbackPs4CacheOptions = {
            appid: config?.appid || "",
            filePath: schemaFile,
            savePath: trophyDir || config?.save_path || "",
            shadps4UserId: String(config?.shadps4_user_id || "").trim(),
            allowNonProgressSeed: true,
          };
          const parsed = ps4Trophy.parsePs4TrophySetDir(trophyDir);
          parsed.appid = String(config?.appid || parsed.appid || "");
          const previous =
            (await loadPreviousAchievements(
              configFileName,
              platform,
              fallbackPs4CacheOptions,
            )) || {};
          snapshot = ps4Trophy.buildSnapshotFromPs4(parsed, previous);
          if (fs.existsSync(schemaFile)) {
            updateAchCacheMetaEntry(
              configFileName,
              platform,
              schemaFile,
              String(config?.appid || ""),
            );
          }
        }
        if (
          fallbackPs4CacheOptions &&
          snapshot &&
          Object.keys(snapshot).length
        ) {
          seedCacheFromSnapshot(
            configFileName,
            snapshot,
            platform,
            fallbackPs4CacheOptions,
          );
          if (seedKey) bootSeededCacheKeys.add(seedKey);
          bumpCacheBatchStat("seeded");
        }
        if (seededAnyPs4User && seedKey) bootSeededCacheKeys.add(seedKey);
      } catch {
        bumpCacheBatchStat("errors");
      }
      return;
    }

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

  let processedBootCacheFiles = 0;
  const emitBootCacheSeedProgress = (force = false) => {
    if (files.length <= 0) return;
    const current = Math.min(processedBootCacheFiles, files.length);
    const percent =
      files.length > 0 ? Math.round((current / files.length) * 100) : 0;
    updateBootCacheProgress(
      {
        phase: "loadingCache",
        current,
        total: files.length,
        percent,
      },
      { force },
    );
  };

  await runWithConcurrency(
    files,
    BOOT_MANUAL_SEED_CONCURRENCY,
    async (file) => {
      try {
        await processFile(file);
      } finally {
        processedBootCacheFiles++;
        emitBootCacheSeedProgress(processedBootCacheFiles >= files.length);
      }
    },
  );
  if (files.length > 0) {
    broadcastBootCacheProgress("generation:progress:end", {
      phase: "completed",
      current: files.length,
      total: files.length,
      percent: 100,
    });
  }
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
  inferOfficialPlatformFromMarkers,
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
const runtimeSeededJsonStatePath = path.join(
  app.getPath("userData"),
  ".seeded-json-state.json",
);

function computeFileContentVersion(filePath, prefix) {
  const tag = String(prefix || "file").trim() || "file";
  try {
    if (!filePath || !fs.existsSync(filePath)) return `${tag}-missing`;
    const hash = crypto.createHash("sha256");
    hash.update(`${tag}\0`, "utf8");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0", "utf8");
    return `${tag}-${hash.digest("hex").slice(0, 16)}`;
  } catch (err) {
    ipcLogger.warn("seeded-json:version-failed", {
      filePath: filePath || null,
      error: err?.message || String(err),
    });
    return `${tag}-error`;
  }
}

function readSeededJsonState() {
  try {
    if (!fs.existsSync(runtimeSeededJsonStatePath)) return {};
    const raw = fs.readFileSync(runtimeSeededJsonStatePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeSeededJsonState(nextState) {
  try {
    fs.mkdirSync(path.dirname(runtimeSeededJsonStatePath), { recursive: true });
    fs.writeFileSync(
      runtimeSeededJsonStatePath,
      JSON.stringify(nextState || {}, null, 2),
      "utf8",
    );
  } catch (err) {
    ipcLogger.warn("seeded-json:state-write-failed", {
      error: err?.message || String(err),
    });
  }
}

function syncSeededRuntimeJson({
  key,
  assetPath,
  runtimePath,
  emptyValue = "[]",
}) {
  const state = readSeededJsonState();
  const assetVersion = computeFileContentVersion(assetPath, key);
  const appliedVersion = String(state?.[key] || "").trim();
  const runtimeExists = !!(runtimePath && fs.existsSync(runtimePath));
  const shouldSync = !runtimeExists || assetVersion !== appliedVersion;

  if (!shouldSync) return;

  try {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    if (assetPath && fs.existsSync(assetPath)) {
      fs.copyFileSync(assetPath, runtimePath);
    } else {
      fs.writeFileSync(runtimePath, emptyValue, "utf8");
    }
    state[key] = assetVersion;
    writeSeededJsonState(state);
    ipcLogger.info("seeded-json:runtime-synced", {
      key,
      runtimePath,
      version: assetVersion,
    });
  } catch (err) {
    ipcLogger.warn("seeded-json:sync-failed", {
      key,
      runtimePath,
      error: err?.message || String(err),
    });
  }
}

function ensureRuntimeSteamDb() {
  syncSeededRuntimeJson({
    key: "steamdb",
    assetPath: defaultSteamDbPath,
    runtimePath: runtimeSteamDbPath,
    emptyValue: "[]",
  });
}

function getRuntimeUplayMappingEnv() {
  return {
    ...process.env,
    STEAM_DB_PATH: runtimeSteamDbPath,
  };
}

function ensureRuntimeUplayMap() {
  syncSeededRuntimeJson({
    key: "uplay-steam",
    assetPath: defaultUplaySteamMapPath,
    runtimePath: runtimeUplaySteamMapPath,
    emptyValue: "[]",
  });
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
    normalizedPlatform === "steam-official" ||
    normalizedPlatform === "epic-official" ||
    normalizedPlatform === "gog-official" ||
    normalizedPlatform === "ubisoft-official" ||
    normalizedPlatform === "ea-official" ||
    normalizedPlatform === "xbox-pc"
  ) {
    const sanitizedSpecial = sanitizeAppIdForPlatform(
      payload.appid || payload.appId || payload.steamAppId,
      normalizedPlatform,
    );
    if (sanitizedSpecial) {
      payload.appid = sanitizedSpecial;
    }
    payload.platform = normalizedPlatform;
    if (normalizedPlatform === "ubisoft-official") {
      const mappedSteamAppId =
        sanitizeAppId(payload.steamAppId) ||
        resolveUbisoftSteamAppId(payload.appid || sanitizedSpecial || "");
      if (mappedSteamAppId) payload.steamAppId = mappedSteamAppId;
      else delete payload.steamAppId;
    } else if (payload.steamAppId) {
      delete payload.steamAppId;
    }
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
  "ubisoft-official",
  "ea-official",
  "gog",
  "gog-official",
  "epic",
  "epic-official",
  "xbox-pc",
  "xenia",
  "rpcs3",
  "shadps4",
];

function normalizeStoragePlatform(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === "steam-official") return "steam-official";
  if (normalized === "uplay") return "uplay";
  if (normalized === "ubisoft-official") return "ubisoft-official";
  if (normalized === "ea-official") return "ea-official";
  if (normalized === "gog") return "gog";
  if (normalized === "gog-official") return "gog-official";
  if (normalized === "epic") return "epic";
  if (normalized === "epic-official") return "epic-official";
  if (normalized === "xbox-pc") return "xbox-pc";
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
    const order = /^\d+$/.test(key)
      ? [
          "steam",
          "steam-official",
          "ea-official",
          "ubisoft-official",
          "uplay",
          "gog",
          "epic",
          "epic-official",
          "xenia",
          "rpcs3",
          "shadps4",
        ]
      : [
          "epic-official",
          "epic",
          "gog-official",
          "steam",
          "steam-official",
          "ea-official",
          "ubisoft-official",
          "uplay",
          "gog",
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

function getImagePlatformCandidates(appid, platform) {
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  const rawAppId = String(appid || "").trim();
  const candidates = [normalizedPlatform];
  const isLikelyEpicId = !!rawAppId && !/^\d+$/.test(rawAppId);
  if (isLikelyEpicId) {
    if (normalizedPlatform === "epic-official") {
      candidates.push("epic", "steam");
    } else if (normalizedPlatform === "epic") {
      candidates.push("epic-official", "steam");
    }
  }
  return Array.from(
    new Set(
      candidates.map((value) => normalizePlatform(value) || "").filter(Boolean),
    ),
  );
}

const SUPPORTED_LOCAL_COVER_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".jpe",
  ".jfif",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
];

const LOCAL_COVER_MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpe": "image/jpeg",
  ".jfif": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

function detectImageMimeFromBuffer(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  const hasPrefix = (bytes, offset = 0) =>
    bytes.every((value, index) => buffer[offset + index] === value);

  if (hasPrefix([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasPrefix([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (hasPrefix([0x42, 0x4d])) return "image/bmp";
  if (
    hasPrefix([0x52, 0x49, 0x46, 0x46]) &&
    hasPrefix([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  const ftyp = buffer.toString("ascii", 4, 12);
  if (
    ftyp.startsWith("ftypavif") ||
    ftyp.startsWith("ftypavis") ||
    ftyp.startsWith("ftypmif1")
  ) {
    return "image/avif";
  }
  return "";
}

function normalizeCoverExtension(extension) {
  const safe = String(extension || "")
    .trim()
    .toLowerCase();
  if (!safe) return "";
  const normalized = safe.startsWith(".") ? safe : `.${safe}`;
  return SUPPORTED_LOCAL_COVER_EXTENSIONS.includes(normalized)
    ? normalized
    : "";
}

function getCoverExtensionFromMeta(meta = {}) {
  const direct = normalizeCoverExtension(meta?.extension || meta?.ext);
  if (direct) return direct;
  const contentType = String(meta?.contentType || meta?.mimeType || "")
    .trim()
    .toLowerCase();
  if (contentType) {
    const byType = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/pjpeg": ".jpg",
      "image/jfif": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/bmp": ".bmp",
      "image/x-ms-bmp": ".bmp",
      "image/avif": ".avif",
    };
    const mapped = normalizeCoverExtension(byType[contentType] || "");
    if (mapped) return mapped;
  }
  const sourceUrl = String(meta?.sourceUrl || meta?.url || "").trim();
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const fromPath = normalizeCoverExtension(
        path.extname(parsed.pathname || ""),
      );
      if (fromPath) return fromPath;
    } catch {}
  }
  return ".jpg";
}

function getCoverImageCandidatePaths(baseDir, appid) {
  const safeBaseDir = String(baseDir || "").trim();
  const safeAppId = String(appid || "").trim();
  if (!safeBaseDir || !safeAppId) return [];
  return SUPPORTED_LOCAL_COVER_EXTENSIONS.map((extension) =>
    path.join(safeBaseDir, `${safeAppId}${extension}`),
  );
}

function pickExistingCoverImagePath(baseDir, appid) {
  for (const candidate of getCoverImageCandidatePaths(baseDir, appid)) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        return candidate;
      }
    } catch {}
  }
  return "";
}

function removeSiblingCoverImageFormats(baseDir, appid, keepPath = "") {
  const keepResolved = String(keepPath || "").trim();
  for (const candidate of getCoverImageCandidatePaths(baseDir, appid)) {
    if (
      keepResolved &&
      path.resolve(candidate) === path.resolve(keepResolved)
    ) {
      continue;
    }
    try {
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch {}
  }
}

function getManagedCustomCoverDir() {
  return path.join(app.getPath("userData"), "custom-covers");
}

function isManagedCustomCoverPath(filePath) {
  const safePath = String(filePath || "").trim();
  if (!safePath) return false;
  try {
    const managedDir = path.resolve(getManagedCustomCoverDir());
    const target = path.resolve(safePath);
    return (
      target === managedDir || target.startsWith(`${managedDir}${path.sep}`)
    );
  } catch {
    return false;
  }
}

function removeManagedCustomCoverVariants(configName, keepPath = "") {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return;
  const dir = getManagedCustomCoverDir();
  const keepResolved = String(keepPath || "").trim();
  for (const extension of SUPPORTED_LOCAL_COVER_EXTENSIONS) {
    const candidate = path.join(dir, `${safeName}${extension}`);
    if (
      keepResolved &&
      path.resolve(candidate) === path.resolve(keepResolved)
    ) {
      continue;
    }
    try {
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    } catch {}
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

  const topLevelPlatformDirs = new Set(SCHEMA_PLATFORM_DIRS);
  const isLegacyImageAppId = (name) =>
    /^[A-Za-z0-9][A-Za-z0-9._:]{0,127}$/.test(String(name || ""));
  const entries = fs.readdirSync(imagesRoot, { withFileTypes: true });

  // Repair accidental nesting like images/steam/steam-official/... back to images/steam-official/...
  try {
    const steamRoot = path.join(imagesRoot, "steam");
    if (fs.existsSync(steamRoot) && fs.statSync(steamRoot).isDirectory()) {
      const nested = fs.readdirSync(steamRoot, { withFileTypes: true });
      for (const entry of nested) {
        if (!entry.isDirectory()) continue;
        if (!topLevelPlatformDirs.has(String(entry.name || "").trim()))
          continue;
        const srcDir = path.join(steamRoot, entry.name);
        const destDir = path.join(imagesRoot, entry.name);
        try {
          fs.mkdirSync(destDir, { recursive: true });
          const children = fs.readdirSync(srcDir);
          for (const child of children) {
            const src = path.join(srcDir, child);
            const dest = path.join(destDir, child);
            if (!fs.existsSync(dest)) {
              fs.renameSync(src, dest);
            }
          }
          try {
            const remaining = fs.readdirSync(srcDir);
            if (!remaining.length) {
              fs.rmdirSync(srcDir);
            }
          } catch {}
        } catch (err) {
          ipcLogger?.warn?.("images:repair-platform-nesting-failed", {
            platform: entry.name,
            error: err?.message || String(err),
          });
        }
      }
    }
  } catch (err) {
    ipcLogger?.warn?.("images:repair-platform-nesting-root-failed", {
      error: err?.message || String(err),
    });
  }

  // Covers: images/<appid>.jpg -> images/<platform>/<appid>/<appid>.jpg
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const m = entry.name.match(/^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.jpg$/i);
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
    if (topLevelPlatformDirs.has(String(appid || "").trim())) continue;
    if (!isLegacyImageAppId(appid)) continue;
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

ipcMain.handle("select-image-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Images",
        extensions: SUPPORTED_LOCAL_COVER_EXTENSIONS.map((ext) =>
          ext.replace(/^\./, ""),
        ),
      },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("read-local-image-data-url", async (_event, filePath) => {
  const safePath = String(filePath || "").trim();
  if (!safePath) {
    return { success: false, error: "Invalid image path." };
  }
  try {
    await fs.promises.access(safePath, fs.constants.R_OK);
    const buffer = await fs.promises.readFile(safePath);
    const ext = normalizeCoverExtension(path.extname(safePath).toLowerCase());
    const detectedMime = detectImageMimeFromBuffer(buffer);
    const mime =
      detectedMime ||
      LOCAL_COVER_MIME_BY_EXTENSION[ext] ||
      "application/octet-stream";
    return {
      success: true,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      mime,
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
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
  const progressJob = createGenerationProgressJob({
    kind: "config-generate",
    scope: "batch",
    status: "running",
    phase: "preparing",
    detail: "Preparing config generation",
    percent: 0,
    current: 0,
    total: 0,
  });
  try {
    ensureSteamApiKeyFileFromPrefs();
    const result = await generateGameConfigs(folderPath, outputDir, {
      onSeedCache: ({ appid, configName, snapshot, platform, savePath }) => {
        try {
          seedCacheFromSnapshot(configName, snapshot, platform || "steam", {
            appid,
            savePath: savePath || null,
          });
        } catch (e) {
          console.warn(
            `[seed-cache] ${configName} (${appid}) failed: ${e.message}`,
          );
        }
      },
      onGenerationProgress: (progress) => {
        progressJob.update({
          itemName: progress?.itemName || progress?.name || "",
          appid: progress?.appid || "",
          phase: progress?.phase || "",
          detail: progress?.detail || "",
          current:
            Number.isFinite(Number(progress?.current)) &&
            Number(progress.current) >= 0
              ? Number(progress.current)
              : 0,
          total:
            Number.isFinite(Number(progress?.total)) &&
            Number(progress.total) >= 0
              ? Number(progress.total)
              : 0,
          percent: clampGenerationPercent(progress?.percent, 0),
        });
      },
    });
    if (!result || result.processed === 0) {
      progressJob.fail({
        phase: "failed",
        detail: tUi("main.message.autoConfigsNoAppId"),
        current: 0,
        total: 0,
        percent: 0,
      });
      return {
        success: false,
        message: tUi("main.message.autoConfigsNoAppId"),
      };
    }
    progressJob.succeed({
      phase: "completed",
      detail: "Config generation completed",
      current: result.processed,
      total: result.processed,
      percent: 100,
    });
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
    progressJob.fail({
      phase: "failed",
      detail: error?.message || "Config generation failed",
    });
    return { success: false, message: error.message };
  }
});

ipcMain.handle("generation:progress:get-active", async () => {
  return getLatestActiveGenerationProgress();
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
  const argList = stripAppNavigationArgs(process.argv.slice(1)).map(quoteForCmd);
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
      platform === "ubisoft-official" ||
      platform === "epic" ||
      platform === "epic-official" ||
      platform === "gog" ||
      platform === "gog-official" ||
      platform === "xbox-pc" ||
      platform === "xenia" ||
      platform === "rpcs3" ||
      platform === "shadps4";

    if (!supportedPlatform) {
      return {
        success: false,
        code: "unsupported-platform",
        message: `Rarity refresh is supported only for Steam/Uplay/Ubisoft Official/Epic/Epic Official/GOG/Xbox PC/Xenia/RPCS3/ShadPS4 configs (current: ${platform}).`,
      };
    }

    if (platform === "xbox-pc") {
      const titleId = String(
        config?.xbox_title_id || config?.appid || "",
      ).trim();
      const xuid = String(config?.xbox_xuid || "").trim();
      if (!/^\d{1,20}$/.test(titleId)) {
        return {
          success: false,
          code: "invalid-xbox-title-id",
          message: "Xbox Title ID for rarity refresh is invalid.",
        };
      }
      if (!/^\d{8,20}$/.test(xuid)) {
        return {
          success: false,
          code: "invalid-xbox-xuid",
          message: "Xbox account ID for rarity refresh is invalid.",
        };
      }
      const source = RARITY_SOURCES.xboxNetwork;
      rarityLogger.info("rarity:manual-refresh:start", {
        configName: config?.name || safeName,
        platform,
        appid: titleId,
        source,
      });
      try {
        const fetchedMap = await fetchXboxAchievementRarityPercentages(
          xuid,
          titleId,
          {
            userDataDir: app.getPath("userData"),
            timeoutMs: 15000,
            locale: "en-US,en",
          },
        );
        const entries = buildRarityEntriesForSchema(
          fetchedMap,
          schemaAchievements,
          {
            normalizeName: (name) => String(name || "").trim(),
          },
        );
        const sidecarPath = writeAchievementPercentagesSidecar(
          path.dirname(schemaPath),
          titleId,
          entries,
          { source },
        );
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid: titleId,
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
          appid: titleId,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid: titleId,
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

    if (platform === "xenia" || platform === "rpcs3" || platform === "shadps4") {
      const appid = config?.appid != null ? String(config.appid).trim() : "";
      if (!appid) {
        return {
          success: false,
          code: "invalid-exophase-appid",
          message: "AppID for Exophase rarity refresh is invalid.",
        };
      }
      const source = EXOPHASE_RARITY_SOURCE;
      rarityLogger.info("rarity:manual-refresh:start", {
        configName: config?.name || safeName,
        platform,
        appid,
        source,
      });
      try {
        const refreshed = await refreshExophaseRarityForConfig(
          config,
          platform,
          schemaAchievements,
        );
        const sidecarPath = writeAchievementPercentagesSidecar(
          path.dirname(schemaPath),
          appid,
          refreshed.entries,
          { source },
        );
        if (refreshed.updated) {
          fs.writeFileSync(
            schemaPath,
            JSON.stringify(schemaAchievements, null, 2),
            "utf8",
          );
        }
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid,
          source,
          sidecarPath,
          slug: refreshed.usedSlug,
          baseUrl: refreshed.baseUrl,
          fetchedCount: refreshed.fetchedCount,
          matchedCount: refreshed.matched,
          schemaUpdated: refreshed.updated,
        });
        broadcastToAll("refresh-achievements-table", config?.name || safeName);
        return {
          success: true,
          configName: config?.name || safeName,
          platform,
          appid,
          sidecarPath,
          fetchedCount: refreshed.fetchedCount,
          matchedCount: refreshed.matched,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid,
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

    if (platform === "gog-official") {
      const productId =
        config?.appid != null ? String(config.appid).trim() : "";
      if (!productId) {
        return {
          success: false,
          code: "invalid-gog-product-id",
          message: "GOG Product ID for rarity refresh is invalid.",
        };
      }
      const resolved = resolveGogOfficialGameplayDbForConfig(config);
      const gameplayDbPath = resolved?.gameplayDbPath || "";
      if (!gameplayDbPath || !fs.existsSync(gameplayDbPath)) {
        return {
          success: false,
          code: "gameplay-db-missing",
          message: "GOG Galaxy gameplay.db was not found for this config.",
        };
      }
      try {
        const parsed = readGogGameplayDb(gameplayDbPath);
        const entries = buildGogOfficialRarityEntries(
          parsed?.achievements || [],
        );
        const sidecarPath = writeAchievementPercentagesSidecar(
          path.dirname(schemaPath),
          productId,
          entries,
          { source: RARITY_SOURCES.gogGameplay },
        );
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source: RARITY_SOURCES.gogGameplay,
          sidecarPath,
          matchedCount: entries.length,
        });
        broadcastToAll("refresh-achievements-table", config?.name || safeName);
        return {
          success: true,
          configName: config?.name || safeName,
          platform,
          appid: productId,
          sidecarPath,
          fetchedCount: entries.length,
          matchedCount: entries.length,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid: productId,
          source: RARITY_SOURCES.gogGameplay,
          error: err?.message || String(err),
        });
        return {
          success: false,
          code: "fetch-failed",
          message: `Rarity refresh failed: ${err?.message || String(err)}`,
        };
      }
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

    if (platform === "epic" || platform === "epic-official") {
      const rarityTargetId =
        platform === "epic-official"
          ? config?.epic_namespace != null
            ? String(config.epic_namespace).trim()
            : ""
          : config?.epic_product_id != null
            ? String(config.epic_product_id).trim()
            : config?.epic_namespace != null
              ? String(config.epic_namespace).trim()
              : config?.appid != null
                ? String(config.appid).trim()
                : "";
      if (!rarityTargetId) {
        return {
          success: false,
          code:
            platform === "epic-official"
              ? "invalid-epic-namespace"
              : "invalid-epic-product-id",
          message:
            platform === "epic-official"
              ? "Epic Namespace for rarity refresh is invalid."
              : "Epic Product ID for rarity refresh is invalid.",
        };
      }
      const source = RARITY_SOURCES.epicPublic;
      rarityLogger.info("rarity:manual-refresh:start", {
        configName: config?.name || safeName,
        platform,
        appid: rarityTargetId,
        source,
      });
      try {
        const fetchedMap = await fetchEpicGlobalAchievementPercentages(
          rarityTargetId,
          {
            locale: "en",
            timeoutMs: 15000,
          },
        );
        if (!fetchedMap.size) {
          rarityLogger.warn("rarity:epic:empty", {
            appid: rarityTargetId,
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
          rarityTargetId,
          entries,
          { source },
        );
        rarityLogger.info("rarity:manual-refresh:written", {
          configName: config?.name || safeName,
          platform,
          appid: rarityTargetId,
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
          appid: rarityTargetId,
          sidecarPath,
          fetchedCount: fetchedMap.size,
          matchedCount: entries.length,
        };
      } catch (err) {
        rarityLogger.warn("rarity:manual-refresh:failed", {
          configName: config?.name || safeName,
          platform,
          appid: rarityTargetId,
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

ipcMain.handle("ea-app:open", async (_evt, payload = {}) => {
  const rawLaunchId = String(
    payload && typeof payload === "object"
      ? payload?.launchId || payload?.contentId || payload?.offerId
      : payload,
  ).trim();
  try {
    if (!/^[A-Za-z0-9:._,-]+$/.test(rawLaunchId)) {
      throw new Error("invalid-ea-launch-id");
    }
    const url = `origin2://game/launch/?offerIds=${encodeURIComponent(
      rawLaunchId,
    )}`;
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    ipcLogger.warn("ea-app:open-failed", {
      launchId: rawLaunchId || null,
      error: err?.message || String(err),
    });
    return { success: false, error: err?.message || String(err) };
  }
});

function isGogCatalogLandingUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/g, "").toLowerCase();
    return pathname === "/games" || pathname === "/en/games";
  } catch {
    return true;
  }
}

async function resolveValidGogProductUrl(candidateUrl) {
  const raw = String(candidateUrl || "").trim();
  if (!raw) return "";
  let currentUrl;
  try {
    currentUrl = new URL(raw, "https://www.gog.com").toString();
  } catch {
    return "";
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isGogCatalogLandingUrl(currentUrl)) return "";
    const res = await axios.get(currentUrl, {
      maxRedirects: 0,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json",
        "User-Agent": "Achievements",
      },
    });
    if (res.status >= 200 && res.status < 300) {
      return isGogCatalogLandingUrl(currentUrl) ? "" : currentUrl;
    }
    const location = String(res.headers?.location || "").trim();
    if (!location) return "";
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      return "";
    }
  }
  return "";
}

function buildGogProductUrlCandidates(product = {}) {
  const links = product?.links || {};
  const candidates = [];
  const directUrl = String(links.product_card || "").trim();
  if (directUrl) candidates.push(directUrl);

  const purchaseLink = String(links.purchase_link || "").trim();
  try {
    const purchaseUrl = new URL(purchaseLink, "https://www.gog.com");
    const match = purchaseUrl.pathname.match(/\/checkout\/manual\/([^/?#]+)/i);
    const purchaseSlug = match ? decodeURIComponent(match[1] || "").trim() : "";
    if (purchaseSlug) {
      candidates.push(`https://www.gog.com/en/game/${purchaseSlug}`);
    }
  } catch {}

  const slug = String(product?.slug || "").trim();
  if (slug) {
    if (/_game$/i.test(slug)) {
      candidates.push(`https://www.gog.com/en/game/${slug.replace(/_game$/i, "")}`);
    }
    candidates.push(`https://www.gog.com/en/game/${slug}`);
    candidates.push(`https://www.gog.com/game/${slug}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

ipcMain.handle("gog:store-url", async (_evt, payload = {}) => {
  const appid = String(
    payload && typeof payload === "object" ? payload?.appid : payload,
  ).trim();
  try {
    if (!/^\d+$/.test(appid)) {
      throw new Error("invalid-gog-appid");
    }
    const res = await axios.get(
      `https://api.gog.com/products/${encodeURIComponent(appid)}`,
      {
        timeout: 10000,
        headers: {
          Accept: "application/json",
          "User-Agent": "Achievements",
        },
      },
    );
    const product = res?.data || {};
    const slug = String(product?.slug || "").trim();
    let url = "";
    for (const candidate of buildGogProductUrlCandidates(product)) {
      try {
        url = await resolveValidGogProductUrl(candidate);
      } catch {}
      if (url) break;
    }
    if (!url) {
      throw new Error("gog-product-url-missing");
    }
    return {
      ok: true,
      url,
      title: String(product?.title || "").trim(),
      slug,
    };
  } catch (err) {
    return {
      ok: false,
      message: String(err?.message || err),
    };
  }
});

const PLAYSTATION_STORE_SEARCH_LOCALES = [
  "en-us",
  "en-gb",
  "en-au",
  "en-ca",
  "ja-jp",
  "en-hk",
  "fr-fr",
  "de-de",
  "es-es",
  "it-it",
];

function normalizePlayStationCusa(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  return /^CUSA\d{5}$/.test(raw) ? raw : "";
}

function normalizePlayStationContentId(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}\d{4}-CUSA\d{5}_00-[A-Z0-9_]+$/.test(raw) ? raw : "";
}

function getPlayStationStoreLocaleForContentId(contentId) {
  const prefix = String(contentId || "").slice(0, 2).toUpperCase();
  if (prefix === "EP") return "en-gb";
  if (prefix === "JP") return "ja-jp";
  if (prefix === "HP") return "en-hk";
  if (prefix === "UP") return "en-us";
  return "en-us";
}

function buildPlayStationStoreProductUrl(contentId, locale = "") {
  const normalizedContentId = normalizePlayStationContentId(contentId);
  if (!normalizedContentId) return "";
  const resolvedLocale =
    String(locale || "").trim().toLowerCase() ||
    getPlayStationStoreLocaleForContentId(normalizedContentId);
  return `https://store.playstation.com/${resolvedLocale}/product/${encodeURIComponent(
    normalizedContentId,
  )}`;
}

function normalizePlayStationSearchTitle(value) {
  return String(value || "")
    .replace(/\s*\((?:PS4|shadps4)\)\s*$/i, "")
    .trim();
}

function normalizePlayStationComparableTitle(value) {
  return normalizePlayStationSearchTitle(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPlayStationNextData(html) {
  const match = String(html || "").match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractPlayStationProductsFromSearchHtml(html) {
  const nextData = extractPlayStationNextData(html);
  const apolloState = nextData?.props?.apolloState || {};
  return Object.values(apolloState)
    .filter((entry) => entry && entry.__typename === "Product")
    .map((product) => ({
      id: String(product.id || "").trim(),
      name: String(product.name || "").trim(),
      npTitleId: String(product.npTitleId || "").trim(),
      storeDisplayClassification: String(
        product.storeDisplayClassification || "",
      ).trim(),
      localizedStoreDisplayClassification: String(
        product.localizedStoreDisplayClassification || "",
      ).trim(),
      platforms: Array.isArray(product.platforms) ? product.platforms : [],
    }))
    .filter((product) => product.id);
}

function scorePlayStationProductMatch(product, cusa, searchName) {
  const productId = String(product?.id || "").toUpperCase();
  const npTitleId = String(product?.npTitleId || "").toUpperCase();
  const classification = String(
    product?.storeDisplayClassification || "",
  ).toUpperCase();
  const platforms = Array.isArray(product?.platforms)
    ? product.platforms.map((item) => String(item || "").toUpperCase())
    : [];
  let score = 0;
  if (npTitleId === `${cusa}_00`) score += 500;
  else if (npTitleId.startsWith(cusa)) score += 450;
  if (productId.includes(cusa)) score += 400;
  if (classification === "FULL_GAME") score += 120;
  if (classification === "BUNDLE") score += 40;
  if (["LEVEL", "COSTUME", "ADD_ON", "VIRTUAL_CURRENCY"].includes(classification)) {
    score -= 200;
  }
  if (platforms.includes("PS4")) score += 30;
  const expectedName = normalizePlayStationComparableTitle(searchName);
  const productName = normalizePlayStationComparableTitle(product?.name || "");
  if (expectedName && productName) {
    if (productName === expectedName) score += 35;
    else if (productName.includes(expectedName) || expectedName.includes(productName)) {
      score += 15;
    }
  }
  return score;
}

async function fetchPlayStationStoreSearchProducts(searchTerm, locale) {
  const url = `https://store.playstation.com/${encodeURIComponent(
    locale,
  )}/search/${encodeURIComponent(searchTerm)}`;
  const res = await axios.get(url, {
    timeout: 12000,
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Achievements",
    },
  });
  return extractPlayStationProductsFromSearchHtml(res?.data || "");
}

async function resolvePlayStationStoreProductByCusa(cusa, searchTerm) {
  const cleanSearchTerm = normalizePlayStationSearchTitle(searchTerm);
  if (!cusa || !cleanSearchTerm) return null;
  const batches = [
    PLAYSTATION_STORE_SEARCH_LOCALES.slice(0, 4),
    PLAYSTATION_STORE_SEARCH_LOCALES.slice(4),
  ];
  let best = null;
  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map(async (locale) => {
        const products = await fetchPlayStationStoreSearchProducts(
          cleanSearchTerm,
          locale,
        );
        return products
          .filter((product) => {
            const productId = String(product?.id || "").toUpperCase();
            const npTitleId = String(product?.npTitleId || "").toUpperCase();
            return productId.includes(cusa) || npTitleId.startsWith(cusa);
          })
          .map((product) => ({
            ...product,
            locale,
            score: scorePlayStationProductMatch(product, cusa, cleanSearchTerm),
          }));
      }),
    );
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const candidate of result.value || []) {
        if (!best || candidate.score > best.score) {
          best = candidate;
        }
      }
    }
    if (best && best.score >= 900) break;
  }
  return best;
}

function persistPlayStationStoreMetadata(configName, contentId, storeUrl) {
  const safeName = String(configName || "").trim();
  if (!safeName || !contentId || !storeUrl) return false;
  const configPath = path.join(configsDir, `${safeName}.json`);
  try {
    if (!fs.existsSync(configPath)) return false;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (normalizePlatform(raw?.platform) !== "shadps4") return false;
    const next = {
      ...raw,
      ps_content_id: contentId,
      ps_store_url: storeUrl,
    };
    if (
      raw?.ps_content_id === next.ps_content_id &&
      raw?.ps_store_url === next.ps_store_url
    ) {
      return false;
    }
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
    ipcLogger.info("playstation:store-url:persisted", {
      configName: safeName,
      contentId,
      url: storeUrl,
    });
    return true;
  } catch (err) {
    ipcLogger.warn("playstation:store-url:persist-failed", {
      configName: safeName,
      error: err?.message || String(err),
    });
    return false;
  }
}

ipcMain.handle("playstation:store-url", async (_evt, payload = {}) => {
  const cusa = normalizePlayStationCusa(
    payload?.appid || payload?.cusa || payload?.titleId || "",
  );
  const rawContentId = normalizePlayStationContentId(
    payload?.ps_content_id ||
      payload?.psContentId ||
      payload?.content_id ||
      payload?.contentId ||
      payload?.playstation_content_id ||
      payload?.playstationContentId ||
      "",
  );
  const explicitUrl = String(
    payload?.ps_store_url ||
      payload?.psStoreUrl ||
      payload?.playstation_store_url ||
      payload?.playstationStoreUrl ||
      "",
  ).trim();
  const configName = String(payload?.configName || payload?.name || "").trim();
  try {
    if (/^https:\/\/store\.playstation\.com\//i.test(explicitUrl)) {
      return { ok: true, url: explicitUrl, source: "config-url" };
    }
    if (rawContentId) {
      const url = buildPlayStationStoreProductUrl(rawContentId);
      persistPlayStationStoreMetadata(configName, rawContentId, url);
      return {
        ok: true,
        url,
        contentId: rawContentId,
        source: "config-content-id",
      };
    }
    if (!cusa) throw new Error("invalid-playstation-cusa");
    const searchName = normalizePlayStationSearchTitle(
      payload?.displayName || payload?.title || payload?.name || "",
    );
    if (!searchName) throw new Error("playstation-search-term-required");
    const product = await resolvePlayStationStoreProductByCusa(cusa, searchName);
    const contentId = normalizePlayStationContentId(product?.id || "");
    if (!product || !contentId) {
      throw new Error("playstation-product-not-found");
    }
    const url = buildPlayStationStoreProductUrl(contentId, product.locale);
    const persisted = persistPlayStationStoreMetadata(configName, contentId, url);
    return {
      ok: true,
      url,
      contentId,
      title: product.name || "",
      locale: product.locale || "",
      source: "store-search-cusa",
      persisted,
    };
  } catch (err) {
    ipcLogger.warn("playstation:store-url:failed", {
      appid: cusa || null,
      configName: configName || null,
      error: err?.message || String(err),
    });
    return {
      ok: false,
      message: String(err?.message || err),
    };
  }
});

function normalizeStoreSearchTitle(value) {
  return String(value || "")
    .replace(/\s*\((?:Epic|Epic Official)\)\s*$/i, "")
    .trim();
}

function normalizeStoreComparableTitle(value) {
  return normalizeStoreSearchTitle(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickEpicStorePageSlug(element) {
  const mappings = Array.isArray(element?.catalogNs?.mappings)
    ? element.catalogNs.mappings
    : [];
  const productHome =
    mappings.find(
      (mapping) =>
        String(mapping?.pageType || "").toLowerCase() === "producthome" &&
        String(mapping?.pageSlug || "").trim(),
    ) || mappings.find((mapping) => String(mapping?.pageSlug || "").trim());
  return String(
    productHome?.pageSlug || element?.productSlug || element?.urlSlug || "",
  ).trim();
}

ipcMain.handle("epic:store-url", async (_evt, payload = {}) => {
  const rawName = normalizeStoreSearchTitle(
    payload?.displayName || payload?.name || payload?.configName || "",
  );
  const namespace = String(
    payload?.namespace || payload?.epic_namespace || payload?.epicNamespace || "",
  )
    .trim()
    .toLowerCase();
  try {
    if (!rawName) throw new Error("epic-search-term-required");
    const query = `query searchStoreQuery($allowCountries: String, $category: String, $count: Int, $country: String!, $keywords: String, $locale: String, $namespace: String, $itemNs: String, $sortBy: String, $sortDir: String, $start: Int, $tag: String, $releaseDate: String) {
  Catalog {
    searchStore(allowCountries: $allowCountries, category: $category, count: $count, country: $country, keywords: $keywords, locale: $locale, namespace: $namespace, itemNs: $itemNs, sortBy: $sortBy, sortDir: $sortDir, releaseDate: $releaseDate, start: $start, tag: $tag) {
      elements {
        title
        id
        namespace
        productSlug
        urlSlug
        url
        catalogNs { mappings(pageType: "productHome") { pageSlug pageType } }
      }
    }
  }
}`;
    const res = await axios.post(
      "https://store.epicgames.com/graphql",
      {
        query,
        variables: {
          count: 5,
          category: "games/edition/base|bundles/games|editors",
          allowCountries: "US",
          country: "US",
          keywords: rawName,
          locale: "en-US",
          namespace: "",
          itemNs: "",
          sortBy: "relevancy",
          sortDir: "DESC",
          start: 0,
          tag: "",
          releaseDate: null,
        },
      },
      {
        timeout: 10000,
        validateStatus: (status) => status >= 200 && status < 500,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Achievements",
        },
      },
    );
    if (res.status >= 400) {
      throw new Error(`epic-store-search-${res.status}`);
    }
    const elements =
      res?.data?.data?.Catalog?.searchStore?.elements || [];
    if (!Array.isArray(elements) || !elements.length) {
      throw new Error("epic-store-search-empty");
    }
    const expectedTitle = normalizeStoreComparableTitle(rawName);
    const picked =
      (namespace &&
        elements.find(
          (element) =>
            String(element?.namespace || "").trim().toLowerCase() === namespace &&
            pickEpicStorePageSlug(element),
        )) ||
      elements.find(
        (element) =>
          normalizeStoreComparableTitle(element?.title) === expectedTitle &&
          pickEpicStorePageSlug(element),
      ) ||
      elements.find((element) => pickEpicStorePageSlug(element));
    const slug = pickEpicStorePageSlug(picked);
    if (!slug) throw new Error("epic-store-slug-missing");
    return {
      ok: true,
      url: `https://store.epicgames.com/en-US/p/${encodeURIComponent(slug)}`,
      slug,
      title: String(picked?.title || "").trim(),
    };
  } catch (err) {
    return {
      ok: false,
      message: String(err?.message || err),
    };
  }
});

const {
  fetchSteamDbLibraryCover,
  fetchSteamGridDbImage,
} = require("./utils/game-cover");
const {
  resolveSteamProductAssetUrls,
} = require("./utils/steam-product-assets");

function resolveSteamProductAssetConfigPath(payload = {}) {
  const explicit = String(
    payload?.configPath || payload?.config_path || "",
  ).trim();
  if (explicit) return explicit;

  const configName = sanitizeConfigName(payload?.configName || "");
  if (configName) {
    try {
      const configFile = path.join(configsDir, `${configName}.json`);
      if (fs.existsSync(configFile)) {
        const config = readJsonWithRetries(configFile, 4, 30);
        const configPath = String(config?.config_path || "").trim();
        if (configPath) return configPath;
      }
    } catch {}
  }

  const appid = sanitizeAppId(payload?.appid || payload?.steamAppId);
  if (appid) {
    try {
      return resolveSchemaDirForPlatform(appid, payload?.platform || "steam");
    } catch {}
  }
  return "";
}

ipcMain.handle("covers:steam-product-assets", async (_evt, payload = {}) => {
  try {
    const appid = sanitizeAppId(payload?.steamAppId || payload?.appid);
    const configPath = resolveSteamProductAssetConfigPath(payload);
    const result = resolveSteamProductAssetUrls({
      appid,
      configPath,
      productInfoPath: payload?.productInfoPath || "",
      purpose: payload?.purpose || "portrait",
      language: cachedPreferences?.language || "english",
    });
    return result;
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      urls: [],
      message: String(err?.message || err),
    };
  }
  },
);

ipcMain.handle("covers:steamdb", async (_evt, payload) => {
  try {
    const rawAppId =
      payload && typeof payload === "object" ? payload?.appid : payload;
    const appid = String(rawAppId || "").trim();
    const platform =
      payload && typeof payload === "object"
        ? normalizePlatform(payload?.platform)
        : "";
    const explicitSteamAppId =
      payload && typeof payload === "object"
        ? sanitizeAppId(payload?.steamAppId)
        : "";
    let steamAppId = appid;

    if (platform === "steam" || platform === "steam-official") {
      steamAppId = appid;
    } else if (platform === "uplay" || platform === "ubisoft-official") {
      if (explicitSteamAppId && explicitSteamAppId !== appid) {
        steamAppId = explicitSteamAppId;
      } else {
        const mapping = uplayToSteam.get(appid);
        steamAppId = mapping?.steam_appid ? String(mapping.steam_appid) : appid;
      }
    } else {
      const mapping = uplayToSteam.get(appid);
      steamAppId = mapping?.steam_appid ? String(mapping.steam_appid) : appid;
    }

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
  generateConfigsForAppIds,
  generateConfigForAppId,
  notifyWarn: (m) => console.warn(m),
  requestDashboardRefresh,
  onSeedCache: ({ appid, configName, snapshot, platform, savePath }) => {
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
      seedCacheFromSnapshot(configName, snapshot, plat, {
        appid,
        savePath: savePath || null,
      });
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
  getCachedSnapshot: (configName, platform = "steam", options = null) => {
    try {
      const cachePath = getCachePath(
        configName,
        normalizePlatform(platform) || "steam",
        options,
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
    selectedConfigMode === "active" &&
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
  const result = readJsonWithBackupSync(preferencesPath, {
    backup: true,
    fallback: {},
  });
  if (result.source === "backup") {
    prefsLogger.warn("read-preferences:recovered-backup", {
      path: preferencesPath,
      error: result.error?.message || null,
    });
  } else if (result.error) {
    prefsLogger.error("read-preferences:error", {
      path: preferencesPath,
      error: result.error.message,
      backupError: result.backupError?.message || null,
    });
  }
  return result.value && typeof result.value === "object" ? result.value : {};
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

function resolveManualAchievementCacheContext(configName) {
  const safeName = sanitizeConfigName(configName || "");
  if (!safeName) return null;
  const configPath = path.join(configsDir, `${safeName}.json`);
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const platform = normalizePlatform(config?.platform) || "steam";
  const options = {
    appid: config?.appid || "",
    savePath: config?.save_path || "",
  };
  if (platform === "steam-official") {
    options.statsDir = config?.save_path || "";
    options.preferences = cachedPreferences;
  } else if (platform === "epic-official") {
    const accountId = resolveEpicOfficialCacheAccountId(
      safeName,
      platform,
      null,
    );
    if (accountId) options.accountId = accountId;
  } else if (platform === "shadps4") {
    const progressPath = resolvePs4ProgressPathForConfig(config);
    options.progressPath = progressPath || "";
    options.filePath = progressPath || "";
    options.shadps4UserId =
      getPs4UserIdFromProgressPath(progressPath) ||
      config?.shadps4_user_id ||
      "";
  }
  return { safeName, config, platform, options };
}

ipcMain.handle("achievement:manual-state", async (_event, payload = {}) => {
  const configName = String(payload?.configName || "").trim();
  const achievementNames = Array.from(
    new Set(
      [
        ...(Array.isArray(payload?.achievementNames)
          ? payload.achievementNames
          : []),
        payload?.achievementName,
      ]
        .map((name) => String(name || "").trim())
        .filter(Boolean),
    ),
  );
  const action = String(payload?.action || "").trim();
  if (!configName || !achievementNames.length) {
    return {
      success: false,
      error: "configName and achievementName are required",
    };
  }
  if (action !== "mark-unlocked" && action !== "clear-manual") {
    return { success: false, error: "unsupported manual achievement action" };
  }
  try {
    const context = resolveManualAchievementCacheContext(configName);
    if (!context) {
      return { success: false, error: "config not found" };
    }
    const cached =
      (await loadPreviousAchievements(
        context.safeName,
        context.platform,
        context.options,
      )) || {};
    const next = { ...(cached && typeof cached === "object" ? cached : {}) };
    let updatedCount = 0;

    for (const achievementName of achievementNames) {
      const existing =
        next[achievementName] && typeof next[achievementName] === "object"
          ? next[achievementName]
          : {};

      if (action === "mark-unlocked") {
        next[achievementName] = {
          ...existing,
          earned: true,
          earned_time: Number(existing.earned_time || 0) || Date.now(),
          manual: true,
        };
        updatedCount += 1;
        continue;
      }

      if (action === "clear-manual" && existing.manual === true) {
        const cleared = { ...existing };
        delete cleared.manual;
        cleared.earned = false;
        cleared.earned_time = 0;
        next[achievementName] = cleared;
        updatedCount += 1;
      }
    }

    if (!updatedCount) {
      return {
        success: true,
        changed: false,
        updatedCount,
        achievements: next,
      };
    }

    const changed = savePreviousAchievements(
      context.safeName,
      next,
      context.platform,
      action === "clear-manual"
        ? { ...context.options, skipManualMerge: true }
        : context.options,
    );
    persistenceLogger.info("manual-achievement-state", {
      config: context.safeName,
      achievement:
        achievementNames.length === 1 ? achievementNames[0] : undefined,
      achievements: achievementNames.length > 1 ? achievementNames : undefined,
      updatedCount,
      action,
      platform: context.platform,
      changed: changed !== false,
    });
    broadcastToAll("refresh-achievements-table", {
      configName: context.safeName,
      skipPlatinumCheck: true,
      reason: "manual-achievement-state",
    });
    requestDashboardRefresh("manual-achievement-state");
    return {
      success: true,
      changed: changed !== false,
      updatedCount,
      achievements: next,
    };
  } catch (error) {
    persistenceLogger.error("manual-achievement-state:error", {
      config: configName,
      achievements: achievementNames,
      action,
      error: error?.message || String(error),
    });
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
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
