// auto-config-generator.js
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { fork, execFileSync } = require("child_process");
const ini = require("ini");
const CRC32 = require("crc-32");
const { loadAchievementsFromSaveFile } = require("./achievement-data");
const { createLogger } = require("./logger");
const autoConfigLogger = createLogger("autoconfig");
const {
  normalizePlatform,
  inferPlatformAndSteamId,
  sanitizeAppId,
} = require("./config-platform-migrator");
const userDataDir = app?.getPath("userData")
  ? app.getPath("userData")
  : path.join(os.tmpdir(), "Achievements");
let preferencesPath = path.join(userDataDir, "preferences.json");
const BLACKLIST_PREF_KEY = "blacklistedAppIds";
const defaultUplaySteamMapPath = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json"
);
let uplaySteamMapPath = path.join(userDataDir, "uplay-steam.json");
function ensureUplayMappingFile() {
  try {
    if (fs.existsSync(uplaySteamMapPath)) return;
    const source =
      fs.existsSync(defaultUplaySteamMapPath) &&
      fs.statSync(defaultUplaySteamMapPath).isFile()
        ? defaultUplaySteamMapPath
        : null;
    fs.mkdirSync(path.dirname(uplaySteamMapPath), { recursive: true });
    if (source) {
      fs.copyFileSync(source, uplaySteamMapPath);
    } else {
      fs.writeFileSync(uplaySteamMapPath, "[]", "utf8");
    }
    autoConfigLogger.info("uplay-mapping:initialized", {
      path: uplaySteamMapPath,
      source: source || null,
    });
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:init-failed", {
      error: err?.message || String(err),
      target: uplaySteamMapPath,
    });
  }
}
ensureUplayMappingFile();
function loadUplayMapping() {
  try {
    const raw = fs.readFileSync(uplaySteamMapPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:load-failed", {
      error: err?.message || String(err),
    });
    return [];
  }
}
const uplaySteamMap = loadUplayMapping();
const uplayToSteam = new Map(
  uplaySteamMap.map((row) => [String(row.uplay_id), row])
);
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
const gogNameFallbackAppIds = new Set();
function reloadUplayMappingFromDisk() {
  try {
    const refreshed = JSON.parse(fs.readFileSync(uplaySteamMapPath, "utf8"));
    uplaySteamMap.length = 0;
    refreshed.forEach((row) => uplaySteamMap.push(row));
    uplayToSteam.clear();
    refreshed.forEach((row) => {
      uplayToSteam.set(String(row.uplay_id), row);
    });
    return true;
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:reload-failed", {
      error: err?.message || String(err),
    });
    return false;
  }
}
function refreshMappingViaScript() {
  try {
    execFileSync(process.execPath, [
      "--run-as-node",
      path.join(__dirname, "match-uplay-steam.js"),
      `--output=${uplaySteamMapPath}`,
    ]);
    reloadUplayMappingFromDisk();
  } catch (err) {
    autoConfigLogger.warn("uplay-mapping:script-failed", {
      error: err?.message || String(err),
    });
  }
}

function loadConfigVariantIndex(outputDir) {
  const map = new Map();
  try {
    if (!fs.existsSync(outputDir)) return map;
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
    for (const file of files) {
      const full = path.join(outputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const appid = sanitizeAppId(
          data?.appid || data?.appId || data?.steamAppId
        );
        if (!appid) continue;
        const platform = normalizePlatform(data?.platform) || "steam";
        const name = data?.name || path.basename(file, ".json");
        if (!map.has(appid)) map.set(appid, new Map());
        map.get(appid).set(platform, { filePath: full, name });
      } catch {}
    }
  } catch (err) {
    autoConfigLogger.warn("config-index:build-failed", {
      error: err?.message || String(err),
    });
  }
  return map;
}

function registerConfigVariant(index, appid, platform, info) {
  const key = sanitizeAppId(appid);
  if (!key || !info?.filePath) return;
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  if (!index.has(key)) index.set(key, new Map());
  index.get(key).set(normalizedPlatform, {
    filePath: info.filePath,
    name: info.name,
  });
}

function resolveExistingVariant(index, appid, platform) {
  const key = sanitizeAppId(appid);
  if (!key) return null;
  const bucket = index.get(key);
  if (!bucket) return null;
  const normalizedPlatform = normalizePlatform(platform) || "steam";
  return bucket.get(normalizedPlatform) || null;
}

function resolveConfigTarget({ outputDir, baseName, appid, platform, index }) {
  const existing = resolveExistingVariant(index, appid, platform);
  if (existing) {
    return {
      filePath: existing.filePath,
      name: existing.name || baseName,
      reused: true,
    };
  }
  const platformLabel =
    platform === "uplay"
      ? "Uplay"
      : platform === "gog"
      ? "GOG"
      : platform === "epic"
      ? "Epic"
      : "Steam";
  let candidateName = baseName;
  let candidatePath = path.join(outputDir, `${candidateName}.json`);
  let suffix = 1;
  while (fs.existsSync(candidatePath)) {
    const label = suffix === 1 ? platformLabel : `${platformLabel} ${suffix}`;
    candidateName = `${baseName} (${label})`;
    candidatePath = path.join(outputDir, `${candidateName}.json`);
    suffix++;
  }
  return { filePath: candidatePath, name: candidateName, reused: false };
}

function resolvePlatformMetadata({ appid, mapping, forcePlatform }) {
  const normalizedForce = normalizePlatform(forcePlatform) || "";
  const sanitizedMappingSteamId = mapping?.steam_appid
    ? sanitizeAppId(mapping.steam_appid)
    : "";
  const mappingForInference =
    normalizedForce === "steam" || normalizedForce === "epic" ? null : mapping;
  const seed = {
    appid,
    platform: normalizedForce || undefined,
    steamAppId: sanitizedMappingSteamId || undefined,
  };
  const { platform, steamAppId } = inferPlatformAndSteamId({
    config: seed,
    mapping: mappingForInference,
  });
  return {
    platform: platform || normalizedForce || "steam",
    steamAppId: steamAppId || "",
  };
}
function stripAchievementPrefix(name) {
  if (typeof name !== "string") return name;
  const match = name.match(/Ach_(.+)$/i);
  if (match && match[1]) return match[1];
  return name;
}
function normalizeAchievementName(name, shouldStrip = false) {
  if (typeof name !== "string") return name;
  let result = name.trim();
  if (shouldStrip) {
    result = stripAchievementPrefix(result);
    const m = result.match(/^(.*)_(\d+)$/);
    if (m && m[1] && /[A-Za-z]/.test(m[1])) {
      result = m[2];
    }
  }
  return result;
}
function readPrefsSafe() {
  try {
    return fs.existsSync(preferencesPath)
      ? JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
      : {};
  } catch {
    return {};
  }
}

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

function resolveSchemaLanguagesForGenerator(candidate = undefined) {
  const source =
    candidate !== undefined ? candidate : readPrefsSafe()?.schemaLanguages;
  const normalized = normalizeSchemaLanguageList(source);
  if (normalized.length) return normalized;
  if (candidate !== undefined || source !== undefined) return ["english"];
  return [...SCHEMA_LANGUAGE_VALUES];
}
function getBlacklistedAppIdsSet() {
  const prefs = readPrefsSafe();
  const list = Array.isArray(prefs[BLACKLIST_PREF_KEY])
    ? prefs[BLACKLIST_PREF_KEY]
    : [];
  return new Set(
    list
      .map((id) => String(id || "").trim())
      .filter((id) => /^[0-9a-fA-F]+$/.test(id))
  );
}
function readJsonSafe(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}
function normalizeSavePath(p) {
  if (!p) return "";
  return String(p)
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}
function findExistingConfigBySavePath(index, appid, expectedSavePath) {
  const key = sanitizeAppId(appid);
  if (!key) return null;
  const normalizedExpected = normalizeSavePath(expectedSavePath);
  if (!normalizedExpected) return null;
  const bucket = index.get(key);
  if (!bucket) return null;
  for (const entry of bucket.values()) {
    if (!entry?.filePath) continue;
    const cfg = readJsonSafe(entry.filePath);
    if (!cfg) continue;
    const cfgSavePath = normalizeSavePath(
      cfg.save_path || cfg.savePath || ""
    );
    if (cfgSavePath && cfgSavePath === normalizedExpected) {
      return {
        filePath: entry.filePath,
        name: cfg.name || entry.name || null,
        config: cfg,
      };
    }
  }
  return null;
}
async function maybeSeedAchCache({
  appid,
  configName,
  save_path,
  config_path,
  onSeedCache,
}) {
  if (typeof onSeedCache !== "function" || !save_path) return;
  const id = String(appid);
  const meta = { appid: id, config_path };
  const candidates = [
    path.join(save_path, "achievements.json"),
    path.join(save_path, id, "achievements.json"),
    path.join(save_path, "steam_settings", id, "achievements.json"),
    path.join(save_path, "achievements.ini"),
    path.join(save_path, "SteamData", "user_stats.ini"),
    path.join(save_path, id, "SteamData", "user_stats.ini"),
    path.join(save_path, "Stats", "achievements.ini"),
    path.join(save_path, id, "achievements.ini"),
    path.join(save_path, "stats.bin"),
    path.join(save_path, id, "stats.bin"),
  ];
  let snapshot = null;
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const cur = loadAchievementsFromSaveFile(
        path.dirname(fp),
        {},
        { configMeta: meta }
      );
      if (cur && Object.keys(cur).length) {
        snapshot = { ...(snapshot || {}), ...cur };
      }
    } catch (err) {
      autoConfigLogger.warn("seed-cache:candidate-failed", {
        appid: id,
        configName,
        path: fp,
        error: err?.message || String(err),
      });
    }
  }
  if (snapshot && Object.keys(snapshot).length) {
    try {
      onSeedCache({ appid: id, configName, snapshot });
      autoConfigLogger.info("seed-cache:success", {
        appid: id,
        configName,
        entries: Object.keys(snapshot).length,
      });
    } catch (err) {
      autoConfigLogger.error("seed-cache:handler-error", {
        appid: id,
        configName,
        error: err?.message || String(err),
      });
    }
  }
}
function sanitizeFilename(name) {
  return name.replace(/[\/\\:*?"<>|]/g, "");
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36";
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function cleanText(x) {
  return decodeHtml(String(x || "").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}
function isBadName(name) {
  const n = (name || "").trim();
  return !n || /^steam hunters$/i.test(n);
}
function extractNameFromSteamHuntersHtml(html) {
  const H = String(html || "");
  // 1) Banner: <span.flex-link-underline> din <h1><a>…</a></h1>
  //    (not “Steam Hunters”, second)
  let m =
    /<main[\s\S]*?<div[^>]*class="[^"]*\bbanner\b[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*\bmedia-body\b[^"]*"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<a[^>]*>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>[\s\S]*?<\/span>\s*<span[^>]*class="[^"]*\bflex-link-underline\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }
  // 2) Breadcrumb: <span class="text-ellipsis app-name after">
  m =
    /<header[\s\S]*?<span[^>]*class="[^"]*\btext-ellipsis\b[^"]*\bapp-name\b[^"]*(?:\bafter\b)?[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
      H
    );
  if (m && m[1]) {
    const name = cleanText(m[1]);
    if (!isBadName(name)) return name;
  }
  return null;
}
async function getGameNameFromSteamHunters(appid) {
  try {
    const url = `https://steamhunters.com/apps/${appid}/achievements`;
    const res = await axios.get(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;
    const name = extractNameFromSteamHuntersHtml(res.data || "");
    if (!name) {
      autoConfigLogger.warn("steam-hunters:name-missing", { appid });
    }
    return name || null;
  } catch (e) {
    autoConfigLogger.warn("steam-hunters:request-failed", {
      appid,
      error: e?.message || String(e),
    });
    return null;
  }
}

async function getGameNameFromGogDb(appid) {
  try {
    const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${appid}`;
    const res = await axios.get(url, { timeout: 15000 });
    const payload = res.data;
    let title = "";
    if (payload) {
      if (typeof payload === "string") {
        title = payload;
      } else if (Array.isArray(payload)) {
        title =
          payload.find((entry) => entry && entry.title)?.title ||
          payload[0]?.title ||
          "";
      } else if (typeof payload === "object") {
        const rawTitle =
          payload.title ||
          payload.name ||
          payload.productTitle ||
          payload.game?.title ||
          payload.product?.title ||
          "";
        if (rawTitle && typeof rawTitle === "object" && rawTitle["*"]) {
          title = rawTitle["*"];
        } else if (typeof rawTitle === "string") {
          title = rawTitle;
        } else if (payload.title && payload.title.value) {
          title = payload.title.value;
        }
      }
    }
    if (title) {
      gogNameFallbackAppIds.add(String(appid));
      autoConfigLogger.info("gog-db:name-resolved", { appid, title });
      return title;
    }
    autoConfigLogger.warn("gog-db:title-missing", { appid });
    return null;
  } catch (err) {
    autoConfigLogger.warn("gog-db:request-failed", {
      appid,
      error: err?.message || String(err),
    });
    return null;
  }
}

// Epic name resolution helpers
let epicProductMap = null;
const epicEgdataTitleCache = new Map();
async function loadEpicProductMap() {
  if (epicProductMap) return epicProductMap;
  try {
    const url =
      "https://store-content.ak.epicgames.com/api/content/productmapping/";
    const res = await axios.get(url, { timeout: 20000 });
    if (res.data && typeof res.data === "object") {
      epicProductMap = res.data;
      return epicProductMap;
    }
  } catch (err) {
    autoConfigLogger.warn("epic-productmap:fetch-failed", {
      error: err?.message || String(err),
    });
  }
  epicProductMap = {};
  return epicProductMap;
}

async function getEpicSlug(appid) {
  const map = await loadEpicProductMap();
  const key = String(appid || "");
  return map?.[key] || map?.[key.toLowerCase()] || null;
}

async function getEpicTitle(appid) {
  const slug = await getEpicSlug(appid);
  if (!slug) return null;
  try {
    const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;
    const res = await axios.get(url, { timeout: 15000 });
    const data = res.data || {};
    const candidates = [];
    if (typeof data.productName === "string") candidates.push(data.productName);
    else if (data.productName && typeof data.productName.value === "string")
      candidates.push(data.productName.value);
    // cache cover assets for epic
    const hero =
      data.hero ||
      (Array.isArray(data.pages)
        ? data.pages
            .map((p) => p?.data?.hero || p?.hero)
            .find(
              (h) =>
                h &&
                (h.portraitBackgroundImageUrl ||
                  h.backgroundImageUrl ||
                  h.title)
            )
        : null);
    if (hero) {
      if (typeof hero.title === "string") candidates.push(hero.title);
      try {
        const imagesRoot = path.join(
          userDataDir,
          "images",
          "epic",
          String(appid)
        );
        fs.mkdirSync(imagesRoot, { recursive: true });
        const downloadIf = async (url, fileName) => {
          if (!url) return;
          try {
            const resp = await axios.get(url, {
              responseType: "arraybuffer",
              timeout: 20000,
            });
            fs.writeFileSync(path.join(imagesRoot, fileName), resp.data);
          } catch (e) {
            autoConfigLogger.warn("epic:cover-download-failed", {
              appid,
              url,
              error: e?.message || String(e),
            });
          }
        };
        await downloadIf(hero.portraitBackgroundImageUrl, `${appid}.jpg`);
        await downloadIf(hero.backgroundImageUrl, "header.jpg");
      } catch (e) {
        autoConfigLogger.warn("epic:cover-save-failed", {
          appid,
          error: e?.message || String(e),
        });
      }
    }
    const title = candidates.find((t) => t && t.trim()) || "";
    if (title) {
      autoConfigLogger.info("epic:name-resolved", { appid, slug, title });
      return title.trim();
    }
  } catch (err) {
    autoConfigLogger.warn("epic:name-fetch-failed", {
      appid,
      slug,
      error: err?.message || String(err),
    });
  }
  return null;
}

function cleanEpicPageTitle(rawTitle) {
  return decodeHtml(String(rawTitle || ""))
    .replace(/\s*-\s*Achievements\s*\|\s*Sandbox\s*$/i, "")
    .replace(/\s*\|\s*EGDATA(?:\.APP)?\s*$/i, "")
    .replace(/\s*-\s*EGDATA(?:\.APP)?\s*$/i, "")
    .trim();
}

function extractMetaContentByKey(html, key) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  const wanted = String(key || "")
    .trim()
    .toLowerCase();
  for (const tag of tags) {
    const attrs = {};
    const re = /([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m;
    while ((m = re.exec(tag))) {
      const attrKey = String(m[1] || "").toLowerCase();
      attrs[attrKey] = m[2] ?? m[3] ?? m[4] ?? "";
    }
    const lookup = String(attrs.name || attrs.property || "")
      .trim()
      .toLowerCase();
    if (lookup === wanted && attrs.content) {
      return cleanEpicPageTitle(attrs.content);
    }
  }
  return null;
}

function extractEpicTitleFromHtml(html) {
  const source = String(html || "");
  const headMatch = source.match(/<head[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (headMatch && headMatch[1]) {
    const headTitle = cleanEpicPageTitle(
      String(headMatch[1]).replace(/<[^>]*>/g, "")
    );
    if (headTitle) return headTitle;
  }
  const ogTitle = extractMetaContentByKey(source, "og:title");
  if (ogTitle) return ogTitle;
  const twitterTitle = extractMetaContentByKey(source, "twitter:title");
  if (twitterTitle) return twitterTitle;
  return null;
}

async function getEpicTitleFromEgdata(appid) {
  const id = String(appid || "").trim();
  if (!id) return null;
  if (epicEgdataTitleCache.has(id)) {
    return epicEgdataTitleCache.get(id);
  }
  const pageUrl = `https://egdata.app/sandboxes/${id}/achievements`;
  try {
    const res = await axios.get(pageUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400 || typeof res.data !== "string") {
      autoConfigLogger.warn("epic:name-egdata-http-failed", {
        appid: id,
        status: res.status,
      });
      epicEgdataTitleCache.set(id, null);
      return null;
    }
    const title = extractEpicTitleFromHtml(res.data);
    if (title) {
      autoConfigLogger.info("epic:name-resolved-egdata", {
        appid: id,
        title,
      });
      epicEgdataTitleCache.set(id, title);
      return title;
    }
    autoConfigLogger.warn("epic:name-egdata-missing", { appid: id });
  } catch (err) {
    autoConfigLogger.warn("epic:name-egdata-fetch-failed", {
      appid: id,
      error: err?.message || String(err),
    });
  }
  epicEgdataTitleCache.set(id, null);
  return null;
}

async function getGameName(appid, opts = {}, retries = 2) {
  const platformHint = normalizePlatform(opts?.platform);
  const preferredName = (opts?.preferredName || "").trim();
  if (preferredName && platformHint === "gog") {
    return preferredName;
  }
  const hasHex = /[a-f]/i.test(String(appid || ""));
  if (hasHex) {
    const epicName = await getEpicTitle(appid);
    if (epicName) return epicName;
    const egdataTitle = await getEpicTitleFromEgdata(appid);
    if (egdataTitle) return egdataTitle;
    // For Epic IDs, do not fall back to Steam/GOG
    return null;
  }
  if (platformHint === "gog") {
    const gogName = await getGameNameFromGogDb(appid);
    if (gogName) return gogName;
    return preferredName || null;
  }

  let nameFromStore = null;
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}`;
    const res = await axios.get(url, { timeout: 15000 });
    const entry = res.data?.[String(appid)];
    if (entry?.success && entry?.data?.name) {
      nameFromStore = entry.data.name;
    } else {
      autoConfigLogger.warn("store-api:name-missing", {
        appid,
        success: entry?.success ?? null,
      });
    }
  } catch (err) {
    if (err.response && err.response.status === 429 && retries > 0) {
      autoConfigLogger.warn("store-api:rate-limit", { appid, retries });
      await new Promise((r) => setTimeout(r, 2000));
      return getGameName(appid, opts, retries - 1);
    }
    autoConfigLogger.error("store-api:request-failed", {
      appid,
      error: err?.message || String(err),
    });
  }
  if (nameFromStore) return nameFromStore;
  // Fallback SteamHunters
  autoConfigLogger.info("fallback:steam-hunters", { appid });
  const shName = await getGameNameFromSteamHunters(appid);
  if (shName) return shName;
  autoConfigLogger.warn("fallback:steam-hunters-failed", { appid });
  autoConfigLogger.info("fallback:gog-db", { appid });
  const gogName = await getGameNameFromGogDb(appid);
  if (gogName) return gogName;
  autoConfigLogger.warn("fallback:gog-db-failed", { appid });
  return null;
}
// run generate_achievements_schema.js
function runAchievementsGenerator(
  appid,
  schemaBaseDir,
  userDataDir,
  opts = {}
) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "generate_achievements_schema.js");
    const isElectron = !!process.versions.electron;
    const nodeBin = isElectron
      ? process.platform === "win32"
        ? "node.exe"
        : "node"
      : process.execPath;
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
    const logDir = path.join(app.getPath("userData"), "logs");
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {}
    autoConfigLogger.info("achgen:spawn", {
      appid,
      args,
      script,
    });
    const cp = fork(script, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        LOGGER_DIR: logDir,
        LOGGER_SUPPRESS_CLEAR: "1",
      },
      windowsHide: true,
    });
    // IPC messages
    cp.on("message", (msg) => {
      if (msg && msg.type === "achgen:log") {
        const suppressUi = shouldSuppressAchgenMessageInUi(msg.message);
        if (global.mainWindow && !suppressUi) {
          global.mainWindow.webContents.send("achgen:log", msg);
        }
        const level =
          msg.level === "error"
            ? "error"
            : msg.level === "warn"
            ? "warn"
            : "info";
        const payload = {
          appid,
          message: msg.message,
        };
        try {
          autoConfigLogger[level]?.("achgen:child-log", payload);
        } catch {
          autoConfigLogger.info("achgen:child-log", payload);
        }
      }
    });
    cp.stdout.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stdout", line);
      process.stdout.write(line);
    });
    cp.stderr.on("data", (buf) => {
      const line = buf.toString();
      if (global.mainWindow)
        global.mainWindow.webContents.send("achgen:stderr", line);
      process.stderr.write(line);
    });
    cp.on("error", (err) => {
      autoConfigLogger.error("achgen:process-error", {
        appid,
        error: err?.message || String(err),
      });
      reject(err);
    });
    cp.on("close", (code) => {
      if (code === 0) {
        autoConfigLogger.info("achgen:process-exit", { appid, code });
        resolve();
      } else {
        autoConfigLogger.error("achgen:process-exit", { appid, code });
        reject(new Error(`Code: ${code}`));
      }
    });
  });
}
async function generateGameConfigs(folderPath, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  const forcedPlatform = normalizePlatform(opts.forcePlatform) || null;
  const schemaLanguages = resolveSchemaLanguagesForGenerator(opts.schemaLanguages);
  if (forcedPlatform) {
    autoConfigLogger.info("generate:forced-platform", {
      targetPlatform: forcedPlatform,
      folderPath,
    });
  }
  const configVariantIndex = loadConfigVariantIndex(outputDir);
  if (!folderPath || !fs.existsSync(folderPath)) {
    throw new Error("Folder is not valid.");
  }
  autoConfigLogger.info("scan:start", {
    inputDir: folderPath,
    outputDir,
  });
  const dirents = fs.readdirSync(folderPath, { withFileTypes: true });
  const folders = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  const appidFolders = folders.filter((f) => /^[0-9a-fA-F]+$/.test(f));
  const blacklist = getBlacklistedAppIdsSet();
  // nothing found
  if (appidFolders.length === 0) {
    autoConfigLogger.warn("scan:no-appids", { folderPath });
    return {
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      outputDir,
    };
  }
  // <outputDir>/schema/<platform>/<appid>
  const schemaBase = path.join(outputDir, "schema");
  if (!fs.existsSync(schemaBase)) fs.mkdirSync(schemaBase, { recursive: true });
  let processed = 0,
    created = 0,
    updated = 0,
    skipped = 0,
    failed = 0;
  for (const appid of appidFolders) {
    processed++;
    if (blacklist.has(String(appid))) {
      autoConfigLogger.info("scan:skip-blacklisted", { appid });
      skipped++;
      continue;
    }
    const uplayId = String(appid);
    let mapping = uplayToSteam.get(uplayId);
    const isHexId = /[a-f]/i.test(uplayId);
    let mappingForRun =
      !forcedPlatform || forcedPlatform === "uplay" ? mapping : null;
    const nameSourceId = isHexId
      ? appid
      : mappingForRun?.steam_appid && mappingForRun.steam_appid !== uplayId
      ? String(mapping.steam_appid)
      : appid;
    let gameSaveDir =
      opts.savePathOverride && opts.savePathOverride.trim()
        ? opts.savePathOverride
        : path.join(folderPath);
    const maybeRemote = path.join(folderPath, "remote", appid);
    if (
      folderPath.toLowerCase().includes("empress") &&
      fs.existsSync(maybeRemote)
    ) {
      gameSaveDir = maybeRemote;
    }
    const existingByPath = findExistingConfigBySavePath(
      configVariantIndex,
      uplayId,
      gameSaveDir
    );
    let name = existingByPath?.name || null;
    autoConfigLogger.info("scan:processing-appid", {
      appid,
      nameAppId: nameSourceId,
    });
    if (name) {
      autoConfigLogger.info("scan:skip-name-lookup", {
        appid: uplayId,
        savePath: gameSaveDir,
        configName: name,
      });
    } else {
      name = await getGameName(nameSourceId, {
        platform: forcedPlatform,
        preferredName: opts.preferredName || "",
      });
    }
    const effectiveSteamId =
      mappingForRun?.steam_appid && mappingForRun.steam_appid !== uplayId
        ? String(mapping.steam_appid)
        : null;
    if (!name) {
      autoConfigLogger.warn("scan:missing-game-name", { effectiveSteamId });
      skipped++;
      continue;
    }
    let safeName = sanitizeFilename(name);
    const platformMeta = resolvePlatformMetadata({
      appid: uplayId,
      mapping: mappingForRun,
      forcePlatform: forcedPlatform,
    });
    const existingPlatform = normalizePlatform(existingByPath?.config?.platform);
    if (existingPlatform && !forcedPlatform) {
      platformMeta.platform = existingPlatform;
      if (existingByPath?.config?.steamAppId && !platformMeta.steamAppId) {
        platformMeta.steamAppId = String(existingByPath.config.steamAppId);
      }
    }
    if (isHexId && !forcedPlatform) {
      platformMeta.platform = "epic";
      platformMeta.steamAppId = "";
    } else {
      const preferGogPlatform =
        gogNameFallbackAppIds.has(String(nameSourceId)) ||
        gogNameFallbackAppIds.has(uplayId);
      if (preferGogPlatform && !forcedPlatform) {
        platformMeta.platform = "gog";
        platformMeta.steamAppId = "";
      }
    }
    autoConfigLogger.info("generate:platform-selected", {
      appid: uplayId,
      platform: platformMeta.platform,
      steamAppId: platformMeta.steamAppId || null,
      forced: !!forcedPlatform,
    });
    const targetInfo = resolveConfigTarget({
      outputDir,
      baseName: safeName,
      appid: uplayId,
      platform: platformMeta.platform,
      index: configVariantIndex,
    });
    safeName = targetInfo.name;
    const filePath = targetInfo.filePath;
    const storagePlatform =
      platformMeta.platform === "uplay"
        ? "uplay"
        : platformMeta.platform === "gog"
        ? "gog"
        : platformMeta.platform === "epic"
        ? "epic"
        : "steam";
    const destSchemaDir = path.join(schemaBase, storagePlatform, String(appid));
    const destAchievementsJson = path.join(destSchemaDir, "achievements.json");
    if (!fs.existsSync(destSchemaDir))
      fs.mkdirSync(destSchemaDir, { recursive: true });
    const ensureSchema = async () => {
      try {
        if (!fs.existsSync(destAchievementsJson)) {
          const userDataDir = app.getPath("userData");
          const attemptPlatforms = (() => {
            if (platformMeta.platform === "steam") return ["steam"];
            if (platformMeta.platform === "uplay") return ["uplay"];
            if (platformMeta.platform === "gog") return ["gog"];
            if (platformMeta.platform === "epic") return ["epic"];
            return mappingForRun?.steam_appid &&
              mappingForRun.steam_appid !== uplayId
              ? ["uplay"]
              : ["uplay", "auto"];
          })();
          let generated = false;
          let lastError = null;
          for (const platformMode of attemptPlatforms) {
            try {
              await runAchievementsGenerator(uplayId, schemaBase, userDataDir, {
                platform: platformMode,
                langs: schemaLanguages,
              });
              if (
                platformMode === "uplay" &&
                (!mappingForRun || !mappingForRun.steam_appid)
              ) {
                if (reloadUplayMappingFromDisk()) {
                  mapping = uplayToSteam.get(uplayId) || mapping;
                  mappingForRun =
                    !forcedPlatform || forcedPlatform === "uplay"
                      ? mapping
                      : null;
                }
              }
              generated = true;
              break;
            } catch (err) {
              lastError = err;
              autoConfigLogger.warn("achgen:attempt-failed", {
                appid: uplayId,
                platform: platformMode,
                error: err?.message || String(err),
              });
            }
          }
          if (!generated) {
            throw lastError || new Error("achievements-generator failed");
          }
        } else {
          const displayId = effectiveSteamId || appid;
          const txt = `⏭ [${displayId}] Achievements schema exists. Skip generating!`;
          if (global.mainWindow) {
            global.mainWindow.webContents.send("achgen:log", {
              type: "achgen:log",
              level: "info",
              message: txt,
            });
            global.mainWindow.webContents.send(
              "achgen:stdout",
              `[achgen] ${txt}\n`
            );
          }
          autoConfigLogger.info("achgen:schema-exists", {
            appid,
            path: destAchievementsJson,
          });
        }
        if (mapping?.steam_appid) {
          try {
            const fileRaw = fs.readFileSync(destAchievementsJson, "utf8");
            const parsed = JSON.parse(fileRaw);
            const entries = Array.isArray(parsed)
              ? parsed
              : Array.isArray(parsed?.achievements)
              ? parsed.achievements
              : null;
            if (entries) {
              const normalized = entries.map((ach) => ({
                ...ach,
                name: normalizeAchievementName(ach.name, true),
              }));
              if (Array.isArray(parsed)) {
                fs.writeFileSync(
                  destAchievementsJson,
                  JSON.stringify(normalized, null, 2)
                );
              } else {
                parsed.achievements = normalized;
                fs.writeFileSync(
                  destAchievementsJson,
                  JSON.stringify(parsed, null, 2)
                );
              }
            }
          } catch (err) {
            autoConfigLogger.warn("schema:strip-prefix-failed", {
              appid: uplayId,
              error: err?.message || String(err),
            });
          }
        }
      } catch (e) {
        autoConfigLogger.error("achgen:schema-failed", {
          appid,
          error: e?.message || String(e),
        });
        failed++;
        // continue
      }
    };
    if (fs.existsSync(filePath)) {
      // if config exist, complete only
      await ensureSchema();
      try {
        const curr = JSON.parse(fs.readFileSync(filePath, "utf8"));
        let changed = false;
        if (curr.platform !== platformMeta.platform) {
          curr.platform = platformMeta.platform;
          changed = true;
        }
        const nextSteamId = platformMeta.steamAppId || "";
        if (nextSteamId) {
          if (curr.steamAppId !== nextSteamId) {
            curr.steamAppId = nextSteamId;
            changed = true;
          }
        } else if (curr.steamAppId) {
          delete curr.steamAppId;
          changed = true;
        }
        if (!curr.config_path) {
          curr.config_path = destSchemaDir;
          changed = true;
        }
        if (opts.savePathOverride) {
          if (curr.save_path !== opts.savePathOverride) {
            curr.save_path = opts.savePathOverride;
            changed = true;
          }
        } else if (!curr.save_path) {
          curr.save_path = gameSaveDir;
          changed = true;
        }
        if (opts.emu && curr.emu !== opts.emu) {
          curr.emu = opts.emu;
          changed = true;
        }
        if (changed) {
          fs.writeFileSync(filePath, JSON.stringify(curr, null, 2));
          autoConfigLogger.info("config:updated", {
            filePath,
            appid,
            name: safeName,
          });
          updated++;
        } else {
          skipped++;
        }
        registerConfigVariant(
          configVariantIndex,
          uplayId,
          platformMeta.platform,
          {
            filePath,
            name: curr.name || safeName,
          }
        );
        await maybeSeedAchCache({
          appid,
          configName: safeName,
          save_path: curr.save_path || gameSaveDir,
          config_path: curr.config_path || destSchemaDir,
          onSeedCache,
        });
      } catch (e) {
        autoConfigLogger.error("config:update-failed", {
          appid,
          error: e?.message || String(e),
        });
        failed++;
      }
      continue;
    }
    // generate schema if missing
    await ensureSchema();
    const gameData = {
      name: safeName,
      appid,
      platform: platformMeta.platform,
      steamAppId: platformMeta.steamAppId || undefined,
      // IMPORTANT: set path, if achievements.json missing
      config_path: destSchemaDir,
      save_path: gameSaveDir,
      executable: "",
      arguments: "",
      process_name: "",
    };
    if (!platformMeta.steamAppId) delete gameData.steamAppId;
    if (opts.savePathOverride) {
      gameData.save_path = opts.savePathOverride;
    }
    if (opts.emu) {
      gameData.emu = opts.emu;
    }
    fs.writeFileSync(filePath, JSON.stringify(gameData, null, 2));
    registerConfigVariant(configVariantIndex, uplayId, platformMeta.platform, {
      filePath,
      name: safeName,
    });
    autoConfigLogger.info("config:saved", {
      filePath,
      appid,
      name: safeName,
    });
    created++;
    await maybeSeedAchCache({
      appid,
      configName: safeName,
      save_path: gameSaveDir,
      config_path: destSchemaDir,
      onSeedCache,
    });
  }
  if (processed > 0) {
    autoConfigLogger.info("scan:complete", {
      processed,
      created,
      updated,
      skipped,
      failed,
      outputDir,
    });
  } else {
    autoConfigLogger.warn("scan:no-configs-generated", { outputDir });
  }
  return { processed, created, updated, skipped, failed, outputDir };
}
async function generateConfigForAppId(appid, outputDir, opts = {}) {
  const onSeedCache = opts.onSeedCache || null;
  appid = String(appid);
  if (!/^[0-9a-fA-F]+$/.test(appid)) {
    autoConfigLogger.error("generate-single:invalid-appid", { appid });
    throw new Error(`Invalid appid: ${appid}`);
  }
  autoConfigLogger.info("generate-single:start", { appid, outputDir });
  const appDir = opts?.appDir || null;
  const tmpRoot = path.join(
    os.tmpdir(),
    `ach_single_root_${appid}_${Date.now()}`
  );
  const tmpAppDir = path.join(tmpRoot, appid);
  fs.mkdirSync(tmpAppDir, { recursive: true });
  autoConfigLogger.debug("generate-single:tmp-created", {
    appid,
    tmpRoot,
  });
  await generateGameConfigs(tmpRoot, outputDir, {
    onSeedCache,
    forcePlatform: opts.forcePlatform || null,
    emu: opts.emu || null,
    savePathOverride: opts.savePathOverride || null,
    preferredName: opts.preferredName || null,
    schemaLanguages: opts.schemaLanguages,
  });
  autoConfigLogger.debug("generate-single:batch-generated", {
    appid,
    tmpRoot,
    outputDir,
  });
  const desiredPlatform = normalizePlatform(opts.forcePlatform) || null;
  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));
  let targetFile = null;
  for (const f of files) {
    try {
      const full = path.join(outputDir, f);
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      const id = String(
        data?.appid || data?.appId || data?.steamAppId || ""
      ).trim();
      if (id === appid) {
        const platform = normalizePlatform(data?.platform) || "steam";
        if (desiredPlatform && platform !== desiredPlatform) {
          continue;
        }
        targetFile = full;
        break;
      }
    } catch (err) {
      autoConfigLogger.warn("generate-single:list-parse-failed", {
        appid,
        file: path.join(outputDir, f),
        error: err?.message || String(err),
      });
    }
  }
  if (!targetFile && desiredPlatform) {
    for (const f of files) {
      try {
        const full = path.join(outputDir, f);
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const id = String(
          data?.appid || data?.appId || data?.steamAppId || ""
        ).trim();
        if (id === appid) {
          targetFile = full;
          break;
        }
      } catch {}
    }
  }
  if ((opts.savePathOverride || opts.emu) && targetFile) {
    try {
      const data = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      if (opts.savePathOverride) data.save_path = opts.savePathOverride;
      if (opts.emu) data.emu = opts.emu;
      fs.writeFileSync(targetFile, JSON.stringify(data, null, 2));
      autoConfigLogger.info("generate-single:override-config", {
        appid,
        targetFile,
        save_path: opts.savePathOverride || data.save_path || null,
        emu: data.emu || null,
      });
    } catch (err) {
      autoConfigLogger.warn("generate-single:override-config-failed", {
        appid,
        targetFile,
        error: err?.message || String(err),
      });
    }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    autoConfigLogger.debug("generate-single:tmp-cleaned", { appid, tmpRoot });
  } catch (err) {
    autoConfigLogger.warn("generate-single:tmp-clean-failed", {
      appid,
      tmpRoot,
      error: err?.message || String(err),
    });
  }
  if (!targetFile) {
    autoConfigLogger.warn("generate-single:target-missing", { appid });
    return;
  }
  if (appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      const fixPath = (p) => {
        if (!p || typeof p !== "string") return p;
        if (p.startsWith(tmpRoot)) {
          const rel = path.relative(tmpRoot, p);
          return path.join(appDir, rel.replace(/^(\d+[\\/])?/, ""));
        }
        return p;
      };
      if (cfg.config_path) cfg.config_path = fixPath(cfg.config_path);
      if (cfg.save_path) cfg.save_path = fixPath(cfg.save_path);
      if (cfg.executable) cfg.executable = fixPath(cfg.executable);
      fs.writeFileSync(targetFile, JSON.stringify(cfg, null, 2));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        onSeedCache,
      });
      autoConfigLogger.info("generate-single:completed", {
        appid,
        targetFile,
        appDir,
      });
    } catch (err) {
      autoConfigLogger.error("generate-single:repath-failed", {
        appid,
        error: err?.message || String(err),
      });
    }
  }
  if (!appDir) {
    try {
      const cfg = JSON.parse(fs.readFileSync(targetFile, "utf8"));
      await maybeSeedAchCache({
        appid,
        configName: cfg.name || path.basename(targetFile, ".json"),
        save_path: cfg.save_path,
        config_path: cfg.config_path,
        onSeedCache,
      });
      autoConfigLogger.info("generate-single:seeded", {
        appid,
        targetFile,
      });
    } catch (err) {
      autoConfigLogger.warn("generate-single:seed-failed", {
        appid,
        error: err?.message || String(err),
      });
    }
  }
  autoConfigLogger.info("generate-single:finish", {
    appid,
    targetFile,
    appDir: appDir || null,
  });
}
module.exports = { generateGameConfigs, generateConfigForAppId };
