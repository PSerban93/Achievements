// playtime-log-watcher.js
const { ipcMain, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { preferencesPath } = require("./paths");
const { pathToFileURL } = require("url");
const { accumulatePlaytime, accumulatePlaytimeAsync, sanitizeConfigName } = require("./playtime-store");
const {
  fetchSteamGridDbImage,
  STEAMGRID_GRID_LANDSCAPE_DIMENSIONS,
  STEAMGRID_HERO_DIMENSIONS,
} = require("./game-cover");
const {
  downloadGameCoverHero,
  GAME_COVER_LANDSCAPE_SOURCE_FILENAME,
} = require("./game-cover-hero");
const { normalizePlatform } = require("./config-platform-migrator");
const { resolveSteamProductAssetUrls } = require("./steam-product-assets");
const { resolveEpicCatalogImageUrls } = require("./epic-game-identity");
const { lookupSteamDbAppIdByName } = require("./local-game-name-cache");
const { createLogger } = require("./logger");
const uplayMappingStore = require("./uplay-mapping-store");
const processPoller = require("./process-poller");
const { performance } = require("perf_hooks");
const coverLogger = createLogger("covers");
const playtimeLogger = createLogger("playtime");
const {
  getProcessExecutableNames,
  getProcessNameSignature,
  normalizeProcessNameList,
} = require("./process-name-utils");

const defaultUplaySteamMapPath = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json",
);
const runtimeUplaySteamMapPath = path.join(
  path.dirname(preferencesPath),
  "uplay-steam.json",
);

uplayMappingStore.configure({
  runtimePath: runtimeUplaySteamMapPath,
  assetPath: defaultUplaySteamMapPath,
});
uplayMappingStore.reloadSnapshot({ preserveLastValid: true });
function loadUplaySteamMap() {
  return uplayMappingStore.getMap();
}

function resolveSteamAppId(appid) {
  const key = String(appid || "").trim();
  if (!key) return null;
  const lookup = loadUplaySteamMap();
  const entry = lookup.get(key);
  return entry?.steam_appid ? String(entry.steam_appid) : null;
}

function artworkSteamAppId(config) {
  const declared = String(config.platform || "").trim().toLowerCase();
  const platform = normalizePlatform(declared) || declared || "steam";
  const explicit = require("./game-presentation-sources").steamId({ ...config, platform });
  if (explicit) return explicit;
  return ["uplay", "ubisoft-official"].includes(platform) ? resolveSteamAppId(config.appid) || "" : "";
}

const playtimeStartMap = new Map();
const activeWatchers = new Map();

function getActiveLastPlayed() {
  const entries = new Map();
  for (const tracker of activeWatchers.values()) {
    if (!tracker.lastPlayedAt) continue;
    const key = sanitizeConfigName(tracker.playtimeKey);
    entries.set(key, Math.max(entries.get(key) || 0, tracker.lastPlayedAt));
  }
  return Object.fromEntries(entries);
}

function rebasePlaytimeSession(configName, timestamp = Date.now()) {
  const key = sanitizeConfigName(configName);
  for (const [appid, tracker] of activeWatchers) {
    if (sanitizeConfigName(tracker.playtimeKey) === key && playtimeStartMap.has(appid)) tracker.persistedSince = timestamp;
  }
}

// Synchronous persistence finishes before Electron exits. Keep trackers alive
// if another quit handler cancels the exit; their next save starts here.
function flushPlaytimeSessions() {
  for (const tracker of activeWatchers.values()) tracker.flush?.();
}

function notifyError(message) {
  try {
    const { webContents } = require("electron");
    const all = webContents.getAllWebContents();
    all.forEach((wc) => {
      try {
        wc.send("notify", { message: String(message), color: "#f44336" });
      } catch {}
    });
  } catch (e) {
    console.error("notifyError:", message);
  }
}

let playtimePreferencesProvider = null;
let fallbackPreferences = null;
function configurePlaytimePreferences(provider) {
  playtimePreferencesProvider = typeof provider === "function" ? provider : null;
  fallbackPreferences = null;
}
function readPrefsSafe() {
  if (playtimePreferencesProvider) {
    const value = playtimePreferencesProvider();
    return value && typeof value === "object" ? value : {};
  }
  if (fallbackPreferences) return fallbackPreferences;
  try {
    if (fs.existsSync(preferencesPath)) {
      fallbackPreferences = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    }
  } catch {}
  return fallbackPreferences || (fallbackPreferences = {});
}

const UI_LOCALE_DIR = path.join(__dirname, "..", "assets", "locales");
const uiLocaleCache = new Map();

function normalizeUiLanguage(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "english";
  return raw === "latam" || raw === "es-419" ? "latam" : raw;
}

function getUiLanguage() {
  const prefs = readPrefsSafe();
  return normalizeUiLanguage(prefs.uiLanguage || prefs.language || "english");
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

function isPlaytimeDisabled() {
  try {
    const prefs = readPrefsSafe();
    return !!prefs.disablePlaytime || global.disablePlaytime === true;
  } catch {
    return global.disablePlaytime === true;
  }
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    // Validate before opening the temporary file; Xbox's official fallback
    // includes HTTP as well as HTTPS.
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === "https:" ? https : parsedUrl.protocol === "http:" ? http : null;
    if (!transport) { reject(new Error("Unsupported header image URL protocol")); return; }
    let settled = false;
    let failing = false;
    let response = null;
    const finalize = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const handleError = (err) => {
      if (settled || failing) return;
      failing = true;
      try {
        if (response && typeof response.destroy === "function") {
          response.destroy();
        }
      } catch {}
      // The caller removes the temporary file after rejection. Wait for the
      // stream to close first so Windows no longer holds an open file handle.
      if (file.closed) finalize(err);
      else {
        file.once("close", () => finalize(err));
        file.destroy();
      }
    };

    const file = fs.createWriteStream(dest);
    file.on("error", handleError);
    transport
      .get(parsedUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        response = res;
        if (res.statusCode !== 200) {
          res.resume();
          handleError(new Error(`Failed to download image: ${res.statusCode}`));
          return;
        }
        res.on("error", handleError);
        res.on("aborted", () => handleError(new Error("Image download aborted")));
        let receivedBytes = 0;
        res.on("data", (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > 20 * 1024 * 1024) {
            handleError(new Error("Header image exceeds size limit"));
          }
        });
        res.pipe(file);
        file.on("finish", () => file.close(() => { if (!failing) finalize(); }));
      })
      .on("error", handleError)
      .setTimeout(15000, function () {
        this.destroy(new Error("Download timed out"));
      });
  });
}

async function downloadHeaderImageAtomic(url, headerPath) {
  const tempPath = path.join(
    path.dirname(headerPath),
    `.header-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await downloadImage(url, tempPath);
    const stat = await fs.promises.stat(tempPath);
    if (stat.size < 12 || stat.size > 20 * 1024 * 1024) {
      throw new Error("Invalid header image size");
    }
    const handle = await fs.promises.open(tempPath, "r");
    let signature;
    try {
      signature = Buffer.alloc(12);
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    const isJpeg = signature[0] === 0xff && signature[1] === 0xd8;
    const isPng = signature.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const isWebp =
      signature.toString("ascii", 0, 4) === "RIFF" &&
      signature.toString("ascii", 8, 12) === "WEBP";
    const isGif = ["GIF87a", "GIF89a"].includes(
      signature.toString("ascii", 0, 6),
    );
    if (!isJpeg && !isPng && !isWebp && !isGif) {
      throw new Error("Invalid header image format");
    }
    // nativeImage guarantees decoding for PNG/JPEG. Preserve Chromium's
    // WebP/GIF support without treating a native decoder limitation as corruption.
    if ((isJpeg || isPng) && nativeImage.createFromBuffer(await fs.promises.readFile(tempPath)).isEmpty()) {
      throw new Error("Unreadable header image");
    }
    await fs.promises.rename(tempPath, headerPath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function writeLandscapeSourceAtomic(imageDir, imageKind) {
  const sourcePath = path.join(
    imageDir,
    GAME_COVER_LANDSCAPE_SOURCE_FILENAME,
  );
  const tempPath = path.join(
    imageDir,
    `.landscape-source-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.promises.writeFile(tempPath, imageKind, { flag: "wx" });
    await fs.promises.rename(tempPath, sourcePath);
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

let epicProductMapCache = null;
let epicProductMapExpiresAt = 0;
let epicProductMapPromise = null;
const EPIC_PRODUCT_MAP_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const EPIC_PRODUCT_MAP_FAILURE_TTL_MS = 5 * 60 * 1000;
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .setTimeout(15000, function () {
        this.destroy(new Error("Request timed out"));
      });
    req.on("error", reject);
  });
}

async function loadEpicProductMap() {
  if (epicProductMapCache && epicProductMapExpiresAt > Date.now()) {
    return epicProductMapCache;
  }
  if (epicProductMapPromise) return epicProductMapPromise;
  epicProductMapPromise = (async () => {
    try {
      const data = await fetchJson(
        "https://store-content.ak.epicgames.com/api/content/productmapping/",
      );
      if (
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        Object.keys(data).length > 0
      ) {
        epicProductMapCache = data;
        epicProductMapExpiresAt = Date.now() + EPIC_PRODUCT_MAP_SUCCESS_TTL_MS;
        return epicProductMapCache;
      }
    } catch {}
    epicProductMapCache = {};
    epicProductMapExpiresAt = Date.now() + EPIC_PRODUCT_MAP_FAILURE_TTL_MS;
    return epicProductMapCache;
  })();
  try {
    return await epicProductMapPromise;
  } finally {
    epicProductMapPromise = null;
  }
}

function extractEpicHero(data) {
  return (
    data?.hero ||
    (Array.isArray(data?.pages)
      ? data.pages
          .map((page) => page?.data?.hero || page?.hero)
          .find(
            (hero) =>
              hero &&
              (hero.portraitBackgroundImageUrl ||
                hero.backgroundImageUrl ||
                hero.title),
          )
      : null) ||
    null
  );
}

function buildEpicSlugCandidates(appid, configData = null) {
  return [
    configData?.epic_store_slug,
    configData?.epicStoreSlug,
    appid,
    configData?.appid,
    configData?.appId,
    configData?.epic_product_id,
    configData?.epicProductId,
    configData?.epic_app_name,
    configData?.epicAppName,
    configData?.appName,
    configData?.epic_catalog_item_id,
    configData?.epicCatalogItemId,
    configData?.catalogItemId,
    configData?.epic_namespace,
    configData?.epicNamespace,
    configData?.namespace,
  ]
    .map((value) => String(value || "").trim())
    .filter((value, index, array) => value && array.indexOf(value) === index);
}

async function resolveEpicStoreSlug(appid, configData = null) {
  const explicitSlug = String(
    configData?.epic_store_slug || configData?.epicStoreSlug || "",
  ).trim();
  if (explicitSlug) return explicitSlug;
  const map = await loadEpicProductMap();
  for (const candidate of buildEpicSlugCandidates(appid, configData)) {
    const slug = map?.[candidate] || map?.[candidate.toLowerCase()] || null;
    if (slug) return slug;
  }
  return "";
}

async function fetchEpicStoreHeaderUrl(
  appid,
  configData = null,
  options = {},
) {
  const slug = await resolveEpicStoreSlug(appid, configData);
  if (!slug) return "";
  try {
    const data = await fetchJson(
      `https://store-content.ak.epicgames.com/api/en-US/content/products/${encodeURIComponent(
        slug,
      )}`,
    );
    const hero = extractEpicHero(data);
    return String(
      hero?.backgroundImageUrl ||
        (options.landscapeOnly ? "" : hero?.portraitBackgroundImageUrl) ||
        "",
    ).trim();
  } catch {
    return "";
  }
}

function notifyHeaderImageUpdated(appid, platform) {
  // Publish only after the image and its source selection have been saved.
  // Consumers resolve the current local file, including custom image priority.
  try {
    ipcMain.emit("game-header:updated", null, {
      appid: String(appid), platform, variant: "landscape",
    });
  } catch (error) {
    coverLogger.warn("header:image:update-failed", {
      appid: String(appid), platform, error: error.message,
    });
  }
}

async function cacheHeaderImage(userDataDir, appid, headerUrl, options = {}) {
  const config = { ...(options.configData || {}), appid: String(appid), platform: normalizePlatform(options.platform) || "steam",
    config_path: options.configPath || options.configData?.config_path, displayName: options.gameName || options.configData?.displayName || "",
    ...(options.steamAppId ? { steamAppId: String(options.steamAppId) } : {}) };
  const response = await require("./game-artwork-service").get().ensure({ userDataDir, config }, { type: "header", force: options.forceDownload === true, repair: options.forceDownload === true });
  const image = response.results[0];
  if (image.ok && image.path) { notifyHeaderImageUpdated(appid, config.platform); return { headerUrl: pathToFileURL(image.path).href }; }
  return { headerUrl };
}

async function redownloadHeaderImage(userDataDir, appid, options = {}) {
  const config = { ...(options.configData || {}), appid: String(appid), platform: normalizePlatform(options.platform) || "steam",
    displayName: options.gameName || options.configData?.displayName || "", ...(options.steamAppId ? { steamAppId: String(options.steamAppId) } : {}) };
  const response = await require("./game-artwork-service").get().ensure({ userDataDir, config }, { type: "header", source: options.source || "automatic", manual: true });
  const result = response.results[0];
  if (result.ok) notifyHeaderImageUpdated(appid, config.platform);
  return { ...result, success: result.ok, sourceId: result.source };
}

function sendPlaytimeNotification(playData) {
  const startedAt = performance.now();
  try {
    ipcMain.emit("show-playtime", null, playData);
    playtimeLogger.info("playtime:notification-dispatched", {
      phase: playData?.phase,
      displayName: playData?.displayName,
      dispatchMs: Math.round(performance.now() - startedAt),
    });
  } catch (e) {
    notifyError(`Failed to emit playtime: ${e.message}`);
  }
}

function formatDuration(ms) {
  const prefix = tUi("playtime.duration.prefix", {}, "You played for");
  const formatUnit = (count, unit, fallback) => {
    const key = `playtime.duration.${unit}.${count === 1 ? "one" : "other"}`;
    return tUi(key, { count }, fallback);
  };
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    const sec = totalSeconds;
    const label = formatUnit(
      sec,
      "seconds",
      `${sec} second${sec !== 1 ? "s" : ""}`,
    );
    return `${prefix} ${label}`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    const mins = totalMinutes;
    const parts = [
      formatUnit(mins, "minutes", `${mins} minute${mins !== 1 ? "s" : ""}`),
    ];
    if (seconds) {
      parts.push(
        formatUnit(
          seconds,
          "seconds",
          `${seconds} second${seconds !== 1 ? "s" : ""}`,
        ),
      );
    }
    return `${prefix} ${parts.join(" ")}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [
    formatUnit(hours, "hours", `${hours} hour${hours !== 1 ? "s" : ""}`),
  ];
  if (minutes) {
    parts.push(
      formatUnit(
        minutes,
        "minutes",
        `${minutes} minute${minutes !== 1 ? "s" : ""}`,
      ),
    );
  }
  if (!minutes && seconds) {
    parts.push(
      formatUnit(
        seconds,
        "seconds",
        `${seconds} second${seconds !== 1 ? "s" : ""}`,
      ),
    );
  }
  return `${prefix} ${parts.join(" ")}`;
}

/* ----------------- Main watcher ----------------- */
/**
 * @param {{appid:number|string, name?:string, displayName?:string, process_name?:string|string[]}} configData
 * @returns {() => void}
 */
function startPlaytimeLogWatcher(configData, options = {}) {
  const appid = String(configData?.appid || "").trim();
  const processNames = normalizeProcessNameList(configData?.process_name);
  const platform = normalizePlatform(configData?.platform) || "steam";
  const requiresPs4Runtime = platform === "ps4recomp";
  const isSteamGridOnly =
    platform === "ps3recomp" || platform === "ps4recomp" || platform === "pcports" || platform === "x360recomp" || platform === "xenia" || platform === "rpcs3" || platform === "shadps4" || platform === "kytyps5";
  const launchPid =
    Number.isFinite(Number(configData?.__launchPid)) &&
    Number(configData.__launchPid) > 0
      ? Number(configData.__launchPid)
      : null;
  const normalizedProcessNames = getProcessExecutableNames(processNames);
  const processNameSignature = getProcessNameSignature(processNames);
  const watcherKey = platform === "ps3recomp" ? `ps3recomp:${configData.__playtimeKey || configData.name}:${require("./ps3-recomp").cacheScope(configData)}` : appid;
  const ps3Pids = new Set();
  if (launchPid) ps3Pids.add(launchPid);
  const existing = activeWatchers.get(watcherKey);
  if (existing?.stopping) {
    // The old session owns its queued final write, not the next runtime.
    activeWatchers.delete(watcherKey);
    playtimeStartMap.delete(watcherKey);
  } else if (existing) {
    if (configData?.__playtimeKey) {
      existing.playtimeKey = configData.__playtimeKey;
    }
    if (processNameSignature === existing.processNameSignature) {
      return existing.cleanup;
    }
    existing.cleanup();
  }
  const gameName =
    configData?.displayName || configData?.name || "Unknown Game";

  if (!appid) {
    notifyError("🚨 Missing appid in configData!");
    return () => {};
  }
  if (!processNames.length) {
    notifyError(`⚠️ Missing executable for app ${appid}`);
    return () => {};
  }

  if (!requiresPs4Runtime && !playtimeStartMap.has(watcherKey)) {
    playtimeStartMap.set(watcherKey, Date.now());
  }

  const { preferencesPath } = require("./paths");
  const userDataDir = path.dirname(preferencesPath);

  // Header URLs
  const effectiveAppId = artworkSteamAppId(configData);
  const remoteHeaderUrl = isSteamGridOnly || !effectiveAppId
    ? ""
    : `https://cdn.steamstatic.com/steam/apps/${effectiveAppId}/header.jpg`;
  const logoFallbackPath = path.join(
    __dirname,
    "..",
    "assets",
    "achievements-logo.png",
  );
  const localHeaderIfExists = () => {
    const storage = require("./game-artwork-storage"), dir = path.join(userDataDir, "images", platform, String(appid));
    let preferHero = false;
    try { preferHero = fs.readFileSync(path.join(dir, "landscape-source.txt"), "utf8").trim() === "hero"; } catch {}
    const file = (preferHero ? storage.existingAt(dir, "game-cover-hero") : "") || storage.existingAt(dir, "header") || storage.existingAt(dir, "game-cover-hero");
    return file ? pathToFileURL(file).href : null;
  };
  const fallbackHeaderUrl =
    platform === "gog" ||
    platform === "gog-official" ||
    platform === "epic" ||
    platform === "epic-official" ||
    platform === "ea-official" ||
    platform === "xbox-pc" ||
    isSteamGridOnly
      ? pathToFileURL(logoFallbackPath).toString()
      : remoteHeaderUrl;

  let unsubscribe = null;
  let closed = false;
  let startNotified = false;
  let lastHeaderUrl = null;
  let seenRunning = false;
  let stopping = false;
  const startGraceUntil = Date.now() + 15000;
  const tracker = {
    playtimeKey:
      configData?.__playtimeKey ||
      sanitizeConfigName(configData?.name || configData?.displayName || appid),
    cleanup: () => {},
    processNameSignature,
  };
  activeWatchers.set(watcherKey, tracker);
  const cleanup = () => {
    closed = true;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {}
      unsubscribe = null;
    }
    if (activeWatchers.get(watcherKey) === tracker) {
      playtimeStartMap.delete(watcherKey);
      activeWatchers.delete(watcherKey);
    }
  };
  tracker.cleanup = cleanup;

  const markSessionStarted = () => {
    if (tracker.lastPlayedAt) return;
    tracker.lastPlayedAt = Date.now();
    ipcMain.emit("playtime:session-started", null, {
      configName: tracker.playtimeKey,
      startedAt: tracker.lastPlayedAt,
    });
  };

  const sendStart = (headerUrl) => {
    if (startNotified) return;
    startNotified = true;
    if (!playtimeStartMap.has(watcherKey)) {
      playtimeStartMap.set(watcherKey, Date.now());
    }
    if (requiresPs4Runtime) playtimeLogger.info("ps4recomp:session:start", { configName: tracker.playtimeKey, appid });
    lastHeaderUrl = headerUrl || lastHeaderUrl || null;
    if (!isPlaytimeDisabled()) {
      const desc = tUi("playtime.descStart", {}, "Start Playtime!");
      sendPlaytimeNotification({
        phase: "start",
        displayName: gameName,
        description: desc,
        headerUrl: headerUrl || fallbackHeaderUrl,
      });
    }
  };

  const persistSession = (endedAt, asyncWrite = false) => {
    if (!seenRunning || !playtimeStartMap.has(watcherKey)) return null;
    const startedAt = playtimeStartMap.get(watcherKey);
    const unsavedMs = () => Math.max(0, endedAt - Math.max(startedAt, tracker.persistedSince || startedAt));
    const key = tracker.playtimeKey;
    const committed = (savedTotalMs) => {
      tracker.persistedSince = Math.max(startedAt, tracker.persistedSince || startedAt, endedAt);
      return savedTotalMs;
    };
    const failed = (error) => {
      playtimeLogger.error("playtime:save-failed", {
        appid: String(appid),
        configName: key,
        error: error?.message || String(error),
      });
      notifyError(
        tUi(
          "playtime.saveFailed",
          { error: error?.message || String(error) },
          "Could not save playtime: {error}",
        ),
      );
      return null;
    };
    if (asyncWrite) return accumulatePlaytimeAsync(key, unsavedMs, endedAt).then(committed, failed);
    try { return committed(accumulatePlaytime(key, unsavedMs())); }
    catch (error) { return failed(error); }
  };
  tracker.flush = () => {
    if (!closed) persistSession(Date.now());
  };

  const sendStop = async (headerUrlLocal) => {
    const startedAt = playtimeStartMap.get(watcherKey) || Date.now();
    const endedAt = Date.now();
    const playedMs = Math.max(0, endedAt - startedAt);
    const key = tracker.playtimeKey;
    if (requiresPs4Runtime) playtimeLogger.info("ps4recomp:session:stop", { configName: key, appid, playedMs });
    const persistenceStartedAt = performance.now();
    const savedTotalMs = await persistSession(endedAt, true);
    playtimeLogger.info("playtime:session-persisted", {
      configName: key,
      persistenceMs: Math.round(performance.now() - persistenceStartedAt),
      ok: savedTotalMs !== null,
    });
    if (savedTotalMs !== null) {
      try {
        ipcMain.emit("playtime:session-ended", null, {
          configName: key,
          appid: String(appid),
          totalMs: savedTotalMs,
          updatedAt: endedAt,
        });
      } catch (error) {
        playtimeLogger.warn("playtime:update-notification-failed", {
          appid: String(appid),
          configName: key,
          error: error?.message || String(error),
        });
      }
    }

    if (activeWatchers.get(watcherKey) === tracker) playtimeStartMap.delete(watcherKey);
    const desc = formatDuration(playedMs);
    if (!isPlaytimeDisabled()) {
      sendPlaytimeNotification({
        phase: "stop",
        displayName: gameName,
        description: desc,
        headerUrl: headerUrlLocal || lastHeaderUrl || fallbackHeaderUrl,
      });
    }
  };

  const immediateLocal = localHeaderIfExists();
  const initialHeader =
    immediateLocal ||
    (platform === "steam" ||
    platform === "uplay" ||
    platform === "ubisoft-official"
      ? remoteHeaderUrl
      : fallbackHeaderUrl);

  cacheHeaderImage(userDataDir, appid, remoteHeaderUrl, {
    gameName,
    platform,
    configData,
    steamAppId: effectiveAppId,
  })
    .then(({ headerUrl }) => {
      if (closed || stopping) return;
      lastHeaderUrl = headerUrl || initialHeader || fallbackHeaderUrl;
      if (!requiresPs4Runtime || seenRunning && !stopping) sendStart(lastHeaderUrl);
    })
    .catch((err) => {
      notifyError(`Header cache failed: ${err.message}`);
      if (!closed && !stopping && (!requiresPs4Runtime || seenRunning)) {
        sendStart(initialHeader || fallbackHeaderUrl);
      }
    });

  const handleSnapshot = (processes) => {
    if (closed || stopping) return;
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return;
    if (platform === "ps3recomp") for (const pid of ps3Pids) { if (!list.some((p) => p.pid === pid)) ps3Pids.delete(pid); }
    const running = list.some((p) => {
      if (platform === "ps3recomp") {
        if (require("./ps3-recomp").matchesProcess(configData, p)) ps3Pids.add(p.pid);
        return ps3Pids.has(p.pid) && normalizedProcessNames.includes(String(p.name || "").toLowerCase());
      }
      if (platform === "ps4recomp") return require("./ps4-recomp").matchesProcess(configData, p);
      if (launchPid && p.pid === launchPid) return true;
      if (!normalizedProcessNames.length) return false;
      if (
        !normalizedProcessNames.includes(String(p.name || "").toLowerCase())
      ) {
        return false;
      }
      return true;
    });

    if (!running) {
      if (requiresPs4Runtime && !seenRunning) return;
      if (!seenRunning && Date.now() < startGraceUntil) {
        return;
      }
      stopping = true;
      tracker.stopping = true;
      (async () => {
        try {
          const storage = require("./game-artwork-storage");
          const legacy = storage.existingAt(path.join(userDataDir, "images", String(appid)), "header");
          const headerLocal = localHeaderIfExists() || (legacy ? pathToFileURL(legacy).href : "") || lastHeaderUrl || remoteHeaderUrl || fallbackHeaderUrl;
          await sendStop(headerLocal);
        } catch {
          await sendStop(remoteHeaderUrl);
        } finally {
          cleanup();
        }
      })();
    }
    if (running) {
      seenRunning = true;
      markSessionStarted();
      if (requiresPs4Runtime) sendStart(lastHeaderUrl || initialHeader || fallbackHeaderUrl);
    }
  };

  if (requiresPs4Runtime) {
    const onRuntimeProcesses = (_event, list) => handleSnapshot(list);
    ipcMain.on("ps4recomp:runtime-processes", onRuntimeProcesses);
    unsubscribe = () => ipcMain.removeListener("ps4recomp:runtime-processes", onRuntimeProcesses);
    if (Array.isArray(options.initialProcesses)) handleSnapshot(options.initialProcesses);
  } else {
    const initialSnapshot = processPoller.getSnapshot();
    if (initialSnapshot && initialSnapshot.length) {
      handleSnapshot(initialSnapshot);
    }
    unsubscribe = processPoller.subscribe(handleSnapshot);
  }

  return cleanup;
}

module.exports = {
  startPlaytimeLogWatcher,
  configurePlaytimePreferences,
  flushPlaytimeSessions,
  rebasePlaytimeSession,
  getActiveLastPlayed,
  cacheHeaderImage,
  redownloadHeaderImage,
  artworkSteamAppId,
};
