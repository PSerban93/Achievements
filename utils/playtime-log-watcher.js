// playtime-log-watcher.js
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { preferencesPath } = require("./paths");
const { pathToFileURL } = require("url");
const { accumulatePlaytime, sanitizeConfigName } = require("./playtime-store");
const { fetchSteamGridDbImage } = require("./game-cover");
const { normalizePlatform } = require("./config-platform-migrator");
const processPoller = require("./process-poller");

const defaultUplaySteamMapPath = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json"
);
const runtimeUplaySteamMapPath = path.join(
  path.dirname(preferencesPath),
  "uplay-steam.json"
);

let steamLookupCache = null;
function loadUplaySteamMap() {
  if (steamLookupCache) return steamLookupCache;
  steamLookupCache = new Map();
  const candidates = [runtimeUplaySteamMapPath, defaultUplaySteamMapPath];
  for (const file of candidates) {
    if (!file) continue;
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((row) => {
          if (row?.uplay_id) {
            steamLookupCache.set(String(row.uplay_id), row);
          }
        });
      }
      if (steamLookupCache.size) break;
    } catch {}
  }
  return steamLookupCache;
}

function resolveSteamAppId(appid) {
  const key = String(appid || "").trim();
  if (!key) return null;
  const lookup = loadUplaySteamMap();
  const entry = lookup.get(key);
  return entry?.steam_appid ? String(entry.steam_appid) : null;
}

const playtimeStartMap = new Map();
const activeWatchers = new Map();

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

function readPrefsSafe() {
  try {
    if (fs.existsSync(preferencesPath)) {
      return JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    }
  } catch {}
  return {};
}

const UI_LOCALE_DIR = path.join(__dirname, "..", "assets", "locales");
const uiLocaleCache = new Map();

function normalizeUiLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
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
    let settled = false;
    let response = null;
    const finalize = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const cleanupFile = () => {
      try {
        fs.unlink(dest, () => {});
      } catch {}
    };
    const handleError = (err) => {
      try {
        if (response && typeof response.destroy === "function") {
          response.destroy();
        }
      } catch {}
      try {
        file.destroy();
      } catch {}
      cleanupFile();
      finalize(err);
    };

    const file = fs.createWriteStream(dest);
    file.on("error", handleError);
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        response = res;
        if (res.statusCode !== 200) {
          res.resume();
          handleError(new Error(`Failed to download image: ${res.statusCode}`));
          return;
        }
        res.on("error", handleError);
        res.pipe(file);
        file.on("finish", () => file.close(() => finalize()));
      })
      .on("error", handleError)
      .setTimeout(15000, function () {
        this.destroy(new Error("Download timed out"));
      });
  });
}

async function cacheHeaderImage(
  userDataDir,
  appid,
  headerUrl,
  options = {}
) {
  const platform = normalizePlatform(options?.platform) || "steam";
  const preferLocalOnly =
    platform === "gog" ||
    platform === "gog-official" ||
    platform === "epic";
  const imageDir = path.join(userDataDir, "images", platform, String(appid));
  try {
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
  } catch {}
  const headerPath = path.join(imageDir, "header.jpg");
  const localUrl = () => pathToFileURL(headerPath).toString();
  try {
    if (fs.existsSync(headerPath)) {
      const stats = fs.statSync(headerPath);
      if (stats.size === 0) {
        fs.unlinkSync(headerPath);
      } else {
        return { headerUrl: localUrl() };
      }
    }
  } catch {}
  const fallbackName = String(options?.gameName || "").trim();
  const stripCoverSuffix = (name) => {
    let out = String(name || "").trim();
    if (!out) return "";
    const rx =
      /\s*\((?:steam|steam[-\s]?official|ubisoft|ubisoft[-\s]?official|xenia|rpcs3|ps4|shadps4)\)\s*$/i;
    while (rx.test(out)) out = out.replace(rx, "").trim();
    return out;
  };
  const coverName = stripCoverSuffix(fallbackName) || fallbackName;
  const fallbackSize = options?.gridSize || "460x215";
  const fallbackSizes = [fallbackSize, "920x430"].filter(
    (size, idx, arr) => size && arr.indexOf(size) === idx
  );
  const downloadToLocal = async (url) => {
    await downloadImage(url, headerPath);
    return { headerUrl: localUrl() };
  };
  try {
    if (!preferLocalOnly && headerUrl) {
      return await downloadToLocal(headerUrl);
    }
  } catch (err) {
    // fallthrough to steamgrid
  }
  if (coverName) {
    for (const size of fallbackSizes) {
      try {
        const gridUrl = await fetchSteamGridDbImage(coverName, { size });
        try {
          return await downloadToLocal(gridUrl);
        } catch {
          return { headerUrl: gridUrl };
        }
      } catch (gridErr) {
        if (size === fallbackSizes[fallbackSizes.length - 1]) {
          console.warn(
            `steamgriddb header fallback failed for ${appid}:`,
            gridErr.message || gridErr
          );
        }
      }
    }
  }
  return { headerUrl };
}

function sendPlaytimeNotification(playData) {
  try {
    ipcMain.emit("show-playtime", null, playData);
  } catch (e) {
    notifyError(`Failed to emit playtime: ${e.message}`);
  }
}

function formatDuration(ms) {
  const prefix = tUi(
    "playtime.duration.prefix",
    {},
    "You played for",
  );
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
      formatUnit(
        mins,
        "minutes",
        `${mins} minute${mins !== 1 ? "s" : ""}`,
      ),
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
 * @param {{appid:number|string, name?:string, displayName?:string, process_name?:string}} configData
 * @returns {() => void}
 */
function startPlaytimeLogWatcher(configData) {
  const appid = String(configData?.appid || "").trim();
  const processName = String(configData?.process_name || "").trim();
  const platform = normalizePlatform(configData?.platform) || "steam";
  const isSteamGridOnly =
    platform === "xenia" || platform === "rpcs3" || platform === "shadps4";
  const launchPid =
    Number.isFinite(Number(configData?.__launchPid)) &&
    Number(configData.__launchPid) > 0
      ? Number(configData.__launchPid)
      : null;
  const normalizedProcessName = path.basename(processName).toLowerCase();
  const existing = activeWatchers.get(appid);
  if (existing) {
    if (configData?.__playtimeKey) {
      existing.playtimeKey = configData.__playtimeKey;
    }
    if (normalizedProcessName === existing.processNameNormalized) {
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
  if (!processName) {
    notifyError(`⚠️ Missing executable for app ${appid}`);
    return () => {};
  }

  if (!playtimeStartMap.has(appid)) {
    playtimeStartMap.set(appid, Date.now());
  }

  const { preferencesPath } = require("./paths");
  const userDataDir = path.dirname(preferencesPath);

  // Header URLs
  const effectiveAppId = resolveSteamAppId(appid) || appid;
  const remoteHeaderUrl = isSteamGridOnly
    ? ""
    : `https://cdn.steamstatic.com/steam/apps/${effectiveAppId}/header.jpg`;
  const logoFallbackPath = path.join(__dirname, "..", "assets", "achievements-logo.png");
  const headerPathLocal = path.join(
    userDataDir,
    "images",
    platform,
    String(appid),
    "header.jpg"
  );
  const localHeaderIfExists = () => {
    try {
      if (fs.existsSync(headerPathLocal)) {
        const stats = fs.statSync(headerPathLocal);
        if (stats.size > 0) {
          return pathToFileURL(headerPathLocal).toString();
        }
        // cleanup empty file
        fs.unlinkSync(headerPathLocal);
      }
    } catch {}
    return null;
  };
  const fallbackHeaderUrl =
    platform === "gog" ||
    platform === "gog-official" ||
    platform === "epic" ||
    isSteamGridOnly
      ? pathToFileURL(logoFallbackPath).toString()
      : remoteHeaderUrl;

  let unsubscribe = null;
  let closed = false;
  let startNotified = false;
  let lastHeaderUrl = null;
  let seenRunning = false;
  const startGraceUntil = Date.now() + 15000;
  const tracker = {
    playtimeKey:
      configData?.__playtimeKey ||
      sanitizeConfigName(configData?.name || configData?.displayName || appid),
    cleanup: () => {},
    processNameNormalized: normalizedProcessName,
  };
  activeWatchers.set(appid, tracker);
  const cleanup = () => {
    closed = true;
    playtimeStartMap.delete(appid);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {}
      unsubscribe = null;
    }
    activeWatchers.delete(appid);
  };
  tracker.cleanup = cleanup;

  const sendStart = (headerUrl) => {
    if (startNotified) return;
    startNotified = true;
    if (!playtimeStartMap.has(appid)) {
      playtimeStartMap.set(appid, Date.now());
    }
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

  const sendStop = async (headerUrlLocal) => {
    const startedAt = playtimeStartMap.get(appid) || Date.now();
    const playedMs = Math.max(0, Date.now() - startedAt);
    const key = tracker.playtimeKey;
    const totalMs = accumulatePlaytime(key, playedMs);
    ipcMain.emit("playtime:session-ended", null, {
      configName: key,
      appid: String(appid),
      totalMs,
    });

    playtimeStartMap.delete(appid);
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
    gridSize: "460x215",
    platform,
  })
    .then(({ headerUrl }) => {
      if (closed) return;
      sendStart(headerUrl || initialHeader || fallbackHeaderUrl);
    })
    .catch((err) => {
      notifyError(`Header cache failed: ${err.message}`);
      if (!closed) {
        sendStart(initialHeader || fallbackHeaderUrl);
      }
    });

  const handleSnapshot = (processes) => {
    if (closed) return;
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return;
    const exeName = path.basename(processName).toLowerCase();
    const running = list.some((p) => {
      if (launchPid && p.pid === launchPid) return true;
      if (String(p.name || "").toLowerCase() !== exeName) return false;
      return true;
    });

    if (!running) {
      if (!seenRunning && Date.now() < startGraceUntil) {
        return;
      }
      (async () => {
        try {
          const headerPathNew = path.join(
            userDataDir,
            "images",
            platform,
            String(appid),
            "header.jpg"
          );
          const headerPathLegacy = path.join(
            userDataDir,
            "images",
            String(appid),
            "header.jpg"
          );
          let headerLocal = remoteHeaderUrl || lastHeaderUrl || fallbackHeaderUrl;
          if (fs.existsSync(headerPathNew)) {
            headerLocal = pathToFileURL(headerPathNew).toString();
          } else if (fs.existsSync(headerPathLegacy)) {
            headerLocal = pathToFileURL(headerPathLegacy).toString();
          }
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
    }
  };

  const initialSnapshot = processPoller.getSnapshot();
  if (initialSnapshot && initialSnapshot.length) {
    handleSnapshot(initialSnapshot);
  }
  unsubscribe = processPoller.subscribe(handleSnapshot);

  return cleanup;
}

module.exports = { startPlaytimeLogWatcher };
