// playtime-log-watcher.js
const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { preferencesPath } = require("./paths");
const { pathToFileURL } = require("url");
const { accumulatePlaytime, sanitizeConfigName } = require("./playtime-store");
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

async function cacheHeaderImage(userDataDir, appid, headerUrl, options = {}) {
  const platform = normalizePlatform(options?.platform) || "steam";
  const preferLocalOnly =
    platform === "gog" ||
    platform === "gog-official" ||
    platform === "epic" ||
    platform === "epic-official" ||
    platform === "ea-official" ||
    platform === "xbox-pc";
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
      /\s*\((?:steam|steam[-\s]?official|epic|epic[-\s]?official|ubisoft|ubisoft[-\s]?official|ea|ea[-\s]?official|xenia|rpcs3|ps4|shadps4)\)\s*$/i;
    while (rx.test(out)) out = out.replace(rx, "").trim();
    return out;
  };
  const coverName = stripCoverSuffix(fallbackName) || fallbackName;
  const fallbackSize = STEAMGRID_GRID_LANDSCAPE_DIMENSIONS;
  const fallbackSizes = [fallbackSize].filter(Boolean);
  const downloadToLocal = async (url) => {
    await downloadImage(url, headerPath);
    coverLogger.info("header:source-hit", {
      appid: String(appid),
      platform,
      source: activeHeaderSource || "remote",
      url,
    });
    return { headerUrl: localUrl() };
  };
  let activeHeaderSource = "";
  const tryHeaderUrls = async (source, urls = []) => {
    const unique = [...new Set(urls.map((url) => String(url || "").trim()).filter(Boolean))];
    for (const url of unique) {
      try {
        activeHeaderSource = source;
        return await downloadToLocal(url);
      } catch (error) {
        coverLogger.warn("header:source-miss", {
          appid: String(appid),
          platform,
          source,
          url,
          error: error?.message || String(error),
        });
      }
    }
    return null;
  };
  try {
    const productAssets = resolveSteamProductAssetUrls({
      appid: options?.steamAppId || appid,
      configPath:
        options?.configPath ||
        options?.configData?.config_path ||
        options?.configData?.configPath ||
        "",
      purpose: "header",
    });
    const productResult = await tryHeaderUrls(
      "steam-product-assets",
      productAssets.urls || [],
    );
    if (productResult) return productResult;
  } catch {
    // fallthrough to the regular Steam CDN and SteamGridDB fallbacks
  }
  if (!preferLocalOnly && headerUrl) {
    const directResult = await tryHeaderUrls("platform-header", [headerUrl]);
    if (directResult) return directResult;
  }
  if (platform === "epic" || platform === "epic-official") {
    try {
      const epicHeaderUrl = await fetchEpicStoreHeaderUrl(
        appid,
        options?.configData || null,
      );
      if (epicHeaderUrl) {
        const epicResult = await tryHeaderUrls("epic-store", [epicHeaderUrl]);
        if (epicResult) return epicResult;
      }
    } catch {
      // The catalog remains available when the Store request fails.
    }
    try {
      const catalogImages = await resolveEpicCatalogImageUrls(appid, {
        catalogItemId:
          options?.configData?.epic_catalog_item_id ||
          options?.configData?.epicCatalogItemId,
        namespace:
          options?.configData?.epic_namespace ||
          options?.configData?.epicNamespace,
      });
      const catalogResult = await tryHeaderUrls(
        "epic-catalog",
        catalogImages.headerUrls,
      );
      if (catalogResult) return catalogResult;
    } catch (error) {
      coverLogger.warn("header:epic-catalog-failed", {
        appid: String(appid),
        platform,
        error: error?.message || String(error),
      });
    }
  }
  const mappedSteamAppId =
    String(options?.steamAppId || "").trim() ||
    lookupSteamDbAppIdByName(coverName, { userDataDir });
  if (/^\d+$/.test(mappedSteamAppId)) {
    const steamFallbackResult = await tryHeaderUrls("steam-title-match", [
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${mappedSteamAppId}/header.jpg`,
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${mappedSteamAppId}/header.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${mappedSteamAppId}/header.jpg`,
      `https://cdn.steamstatic.com/steam/apps/${mappedSteamAppId}/header.jpg`,
    ]);
    if (steamFallbackResult) return steamFallbackResult;
  }
  if (coverName) {
    for (const size of fallbackSizes) {
      try {
        const gridUrl = await fetchSteamGridDbImage(coverName, {
          size,
          assetType: "grids",
        });
        try {
          activeHeaderSource = "steamgriddb";
          return await downloadToLocal(gridUrl);
        } catch {
          return { headerUrl: gridUrl };
        }
      } catch (gridErr) {
        if (size === fallbackSizes[fallbackSizes.length - 1]) {
          console.warn(
            `steamgriddb header fallback failed for ${appid}:`,
            gridErr.message || gridErr,
          );
        }
      }
    }
  }
  coverLogger.warn("header:all-sources-failed", {
    appid: String(appid),
    platform,
    gameName: coverName || null,
    mappedSteamAppId: mappedSteamAppId || null,
  });
  return { headerUrl };
}

async function redownloadHeaderImage(userDataDir, appid, options = {}) {
  const platform = normalizePlatform(options.platform) || "steam";
  const configData = options.configData || null;
  const gameName = String(options.gameName || "")
    .replace(/\s*\((?:steam|steam-official|epic|epic-official|uplay|ubisoft|ubisoft-official|ea|ea-official|gog|gog-official|xbox-pc|retroachievements|xenia|rpcs3|ps4|shadps4|markerpatch|madnesspatch|xlivelessness)\)\s*$/i, "")
    .trim();
  const imageDir = path.join(userDataDir, "images", platform, String(appid));
  const headerPath = path.join(imageDir, "header.jpg");
  const sources = [];
  const addSource = (id, resolveUrls, imageKind = "header") =>
    sources.push({ id, resolveUrls, imageKind });
  const writeLandscapeSource = async (imageKind) => {
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
  };
  const primarySteamPlatform = [
    "steam",
    "steam-official",
    "markerpatch",
    "madnesspatch",
  ].includes(platform);
  const mappedSteamPlatform = ["uplay", "ubisoft-official"].includes(platform);
  const explicitSteamId = String(options.steamAppId || "").trim();
  const steamId = primarySteamPlatform
    ? (/^\d+$/.test(explicitSteamId) ? explicitSteamId : String(appid))
    : mappedSteamPlatform &&
        /^\d+$/.test(explicitSteamId) &&
        explicitSteamId !== String(appid)
      ? explicitSteamId
      : "";

  if (/^\d+$/.test(steamId)) {
    addSource("steam-product-header", async () => {
      const assets = resolveSteamProductAssetUrls({
        appid: steamId,
        configPath: configData?.config_path || configData?.configPath || "",
        purpose: "header",
      });
      return assets.urls || [];
    });
    addSource("steam-cdn-header", async () => [
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`,
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${steamId}/header.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${steamId}/header.jpg`,
      `https://cdn.steamstatic.com/steam/apps/${steamId}/header.jpg`,
    ]);
    addSource("steam-store-header", async () => {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${steamId}`,
      );
      const url = String(data?.[steamId]?.data?.header_image || "").trim();
      return url ? [url] : [];
    });
  }

  if (platform === "epic" || platform === "epic-official") {
    addSource("epic-store-header", async () => {
      const url = await fetchEpicStoreHeaderUrl(appid, configData, {
        landscapeOnly: true,
      });
      return url ? [url] : [];
    });
    addSource("epic-catalog-header", async () => {
      const images = await resolveEpicCatalogImageUrls(appid, {
        catalogItemId:
          configData?.epic_catalog_item_id || configData?.epicCatalogItemId,
        namespace: configData?.epic_namespace || configData?.epicNamespace,
      });
      return images.headerUrls || [];
    });
  }

  if (platform === "xbox-pc") {
    addSource("xbox-title-header", async () => {
      try {
        const saved = JSON.parse(
          await fs.promises.readFile(path.join(imageDir, "sources.json"), "utf8"),
        );
        const url = String(saved?.headerUrl || "").trim();
        return url ? [url] : [];
      } catch {
        return [];
      }
    });
  }

  let matchedSteamId = "";
  if (gameName) {
    try {
      matchedSteamId = String(
        lookupSteamDbAppIdByName(gameName, { userDataDir }) || "",
      ).trim();
    } catch {}
  }
  if (/^\d+$/.test(matchedSteamId) && matchedSteamId !== steamId) {
    addSource("steam-title-header", async () => [
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${matchedSteamId}/header.jpg`,
      `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${matchedSteamId}/header.jpg`,
      `https://cdn.akamai.steamstatic.com/steam/apps/${matchedSteamId}/header.jpg`,
    ]);
  }
  if (gameName) {
    addSource("steamgriddb-landscape-grid", async () => [
      await fetchSteamGridDbImage(gameName, {
        size: STEAMGRID_GRID_LANDSCAPE_DIMENSIONS,
        assetType: "grids",
        appid: `${platform}:${appid}:redownload-header`,
      }),
    ]);
    addSource(
      "steamgriddb-hero",
      async () => [
        await fetchSteamGridDbImage(gameName, {
          size: STEAMGRID_HERO_DIMENSIONS,
          assetType: "heroes",
          appid: `${platform}:${appid}:redownload-hero`,
        }),
      ],
      "hero",
    );
  }

  const lastSourceId = String(options.lastSourceId || "").trim();
  const lastIndex = sources.findIndex((source) => source.id === lastSourceId);
  const startIndex = lastIndex < 0 ? 0 : (lastIndex + 1) % sources.length;
  await fs.promises.mkdir(imageDir, { recursive: true });
  for (let offset = 0; offset < sources.length; offset += 1) {
    const source = sources[(startIndex + offset) % sources.length];
    try {
      const urls = [...new Set(await source.resolveUrls())]
        .map((url) => String(url || "").trim())
        .filter((url) => /^https:\/\//i.test(url));
      for (const url of urls) {
        const tempPath =
          source.imageKind === "hero"
            ? ""
            : path.join(
                imageDir,
                `.header-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`,
              );
        try {
          if (source.imageKind === "hero") {
            const heroPath = await downloadGameCoverHero(url, imageDir);
            await writeLandscapeSource("hero");
            coverLogger.info("header:redownload:source-hit", {
              appid: String(appid),
              platform,
              source: source.id,
              url,
            });
            return { success: true, sourceId: source.id, path: heroPath };
          }
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
          await fs.promises.rename(tempPath, headerPath);
          await writeLandscapeSource("header");
          coverLogger.info("header:redownload:source-hit", {
            appid: String(appid),
            platform,
            source: source.id,
            url,
          });
          return { success: true, sourceId: source.id, path: headerPath };
        } catch (error) {
          coverLogger.warn("header:redownload:source-miss", {
            appid: String(appid),
            platform,
            source: source.id,
            url,
            error: error?.message || String(error),
          });
        } finally {
          if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
        }
      }
    } catch (error) {
      coverLogger.warn("header:redownload:source-miss", {
        appid: String(appid),
        platform,
        source: source.id,
        error: error?.message || String(error),
      });
    }
  }
  return { success: false, error: "no-header-source" };
}

function sendPlaytimeNotification(playData) {
  try {
    ipcMain.emit("show-playtime", null, playData);
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
function startPlaytimeLogWatcher(configData) {
  const appid = String(configData?.appid || "").trim();
  const processNames = normalizeProcessNameList(configData?.process_name);
  const platform = normalizePlatform(configData?.platform) || "steam";
  const isSteamGridOnly =
    platform === "xenia" || platform === "rpcs3" || platform === "shadps4";
  const launchPid =
    Number.isFinite(Number(configData?.__launchPid)) &&
    Number(configData.__launchPid) > 0
      ? Number(configData.__launchPid)
      : null;
  const normalizedProcessNames = getProcessExecutableNames(processNames);
  const processNameSignature = getProcessNameSignature(processNames);
  const existing = activeWatchers.get(appid);
  if (existing) {
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
  const logoFallbackPath = path.join(
    __dirname,
    "..",
    "assets",
    "achievements-logo.png",
  );
  const headerPathLocal = path.join(
    userDataDir,
    "images",
    platform,
    String(appid),
    "header.jpg",
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
  const startGraceUntil = Date.now() + 15000;
  const tracker = {
    playtimeKey:
      configData?.__playtimeKey ||
      sanitizeConfigName(configData?.name || configData?.displayName || appid),
    cleanup: () => {},
    processNameSignature,
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
    let savedTotalMs = null;
    try {
      savedTotalMs = accumulatePlaytime(key, playedMs);
    } catch (error) {
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
    }
    if (savedTotalMs !== null) {
      try {
        ipcMain.emit("playtime:session-ended", null, {
          configName: key,
          appid: String(appid),
          totalMs: savedTotalMs,
        });
      } catch (error) {
        playtimeLogger.warn("playtime:update-notification-failed", {
          appid: String(appid),
          configName: key,
          error: error?.message || String(error),
        });
      }
    }

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
    platform,
    configData,
    steamAppId: effectiveAppId,
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
    const running = list.some((p) => {
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
            "header.jpg",
          );
          const headerPathLegacy = path.join(
            userDataDir,
            "images",
            String(appid),
            "header.jpg",
          );
          let headerLocal =
            remoteHeaderUrl || lastHeaderUrl || fallbackHeaderUrl;
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

module.exports = {
  startPlaytimeLogWatcher,
  cacheHeaderImage,
  redownloadHeaderImage,
};
