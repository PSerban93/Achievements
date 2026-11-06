"use strict";

// Optional presentation data only. Never a source for achievement state,
// platform identity, executable selection or account credentials.
const fs = require("fs"), path = require("path");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const logger = require("./logger").createLogger("game-details");
// Name lookups can run before a schema directory exists. Keep their optional
// response in memory until a caller supplies the actual schema directory.
const pending = new Map();
const pendingKey = (root, platform, appid, language) => JSON.stringify([root ? path.resolve(root) : "", platform, String(appid), language]);
const text = value => {
  if (typeof value !== "string") return "";
  const $ = require("cheerio").load(value.slice(0, 80000));
  $("script,style,iframe,object").remove();
  $("br").replaceWith("\n"); $("p,li,h1,h2,h3").append("\n");
  return $.root().text().replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim().slice(0, 12000);
};
// GamesDB localizes both scalar fields and names inside genre/company lists.
const localized = value => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return ["en-US", "en", "english", "*"].map(key => value[key]).find(item => typeof item === "string" && item.trim()) || "";
};
const words = value => [...new Set((Array.isArray(value) ? value : value ? [value] : [])
  .map(item => text(localized(item?.name || item?.description || item))).filter(Boolean))].slice(0, 24);
const description = value => text(localized(value)).replace(/\bproduct_(?:description|feature)(?:_\d+)?\b/gi, "").trim();
const firstDescription = (...values) => values.map(description).find(Boolean) || "";
const url = value => { try { const u = new URL(typeof value === "string" && value.startsWith("//") ? "https:" + value : value); return u.protocol === "https:" ? u.href : ""; } catch { return ""; } };
const gogImage = value => url(typeof value === "string" ? value : value?.url_format?.replace("{formatter}", "").replace("{ext}", "jpg"));
const safeId = value => /^[\p{L}\p{N}_.:-]{1,180}$/u.test(String(value || "")) ? String(value) : "";
function release(value) {
  if (/^\d{10,13}$/.test(String(value))) {
    const date = new Date(Number(value) < 1e12 ? Number(value) * 1000 : Number(value));
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970 ? date.toISOString().slice(0, 10) : "";
  }
  const result = text(typeof value === "number" ? String(value) : value);
  const iso = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(result);
  if (iso) {
    const date = new Date(iso[1] + "T00:00:00Z");
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso[1] ? iso[1] : "";
  }
  return /\b(19|20)\d{2}\b/.test(result) && !/coming|soon|TBA|TBD/i.test(result) ? result.slice(0, 80) : "";
}
function normalize({ kind, payload = {}, appid, language = "english", sourcePlatform, externalId }) {
  let title = "", description = "", developers = [], publishers = [], genres = [], releaseDate = "", artwork = {}, sourceId = String(appid || "");
  if (kind === "steam") {
    const d = payload?.[sourceId]?.data || payload?.data || payload?.details || payload;
    const product = payload.product || {}, common = product.common || {}, extended = product.extended || {};
    const actual = d.steam_appid || product.appid || common.gameid;
    if (actual && String(actual) !== sourceId) return null;
    title = d.name || common.name; description = d.short_description || d.about_the_game || d.detailed_description;
    developers = words(d.developers || extended.developer); publishers = words(d.publishers || extended.publisher);
    genres = words(d.genres); releaseDate = release(d.release_date?.date || common.original_release_date || common.steam_release_date);
    artwork = { hero: url(d.background_raw), header: url(d.header_image), cover: url(d.capsule_image) };
  } else if (kind === "epic") {
    const pages = Array.isArray(payload.pages) ? payload.pages.map(page => page.data || page) : [];
    const about = payload.about || pages.find(page => page.about)?.about || {};
    const hero = payload.hero || pages.find(page => page.hero)?.hero || {};
    const meta = payload.meta || pages.find(page => page.meta)?.meta || {};
    title = payload.productName?.value || payload.productName || payload.title || hero.title;
    description = about.shortDescription || about.description;
    developers = words(about.developerAttribution); publishers = words(about.publisherAttribution);
    genres = words(about.genres || payload.genres || meta.genres); releaseDate = release(about.releaseDate || meta.releaseDate || meta.customReleaseDate);
    artwork = { hero: url(hero.backgroundImageUrl), cover: url(hero.portraitBackgroundImageUrl), logo: url(hero.logoImage?.src) };
  } else if (kind === "gog" || kind === "gamesdb" || kind === "gamesdb-game") {
    const game = payload.game || payload;
    if (kind === "gamesdb-game" && (!/^\d{1,24}$/.test(String(externalId)) || String(payload.id) !== String(externalId) || payload.game)) return null;
    if (kind === "gamesdb" && (payload.platform_id !== sourcePlatform || String(payload.external_id) !== String(externalId))) return null;
    if (kind === "gog" && ((payload.platform_id && payload.platform_id !== "gog") || (payload.external_id && String(payload.external_id) !== sourceId) || (payload.id && !payload.external_id && String(payload.id) !== sourceId))) return null;
    title = localized(payload.title) || localized(game.title);
    description = firstDescription(payload.summary, game.summary, payload.description?.lead, payload.description?.full, payload.description, payload.overview);
    developers = words(game.developers || payload.developer); publishers = words(game.publishers || payload.publisher); genres = words(game.genres);
    releaseDate = release(payload.first_release_date || game.first_release_date || payload.release_date);
    artwork = { hero: gogImage(game.background || game.horizontal_artwork || payload.images?.background),
      cover: gogImage(game.vertical_cover || game.cover), logo: gogImage(payload.logo || game.logo || payload.images?.logo) };
  } else if (kind === "retroachievements") {
    title = payload.title; developers = words(payload.developer); publishers = words(payload.publisher);
    genres = words(payload.genre); releaseDate = release(payload.released);
    artwork = { hero: url(payload.imageIngame), header: url(payload.imageTitle || payload.imageIngame), cover: url(payload.imageBoxArt || payload.imageIcon) };
  } else return null;
  const result = { version: 1, source: kind === "gamesdb-game" ? "gamesdb" : kind, sourceId, language: safeId(language.toLowerCase()) || "english", title: text(title),
    description: firstDescription(description), developers, publishers, genres, releaseDate,
    artwork: Object.fromEntries(Object.entries(artwork).filter(([, value]) => value)) };
  return result.title || result.description || developers.length || publishers.length ? result : null;
}
function legacyFileFor(root, platform, appid, language) {
  return root && safeId(platform) && safeId(appid) && safeId(language)
    ? path.join(root, "game-metadata", encodeURIComponent(platform), `${encodeURIComponent(appid)}.${language}.json`) : "";
}
function present(data) {
  return { version: 1, source: String(data.source || ""), sourceId: String(data.sourceId || ""), platform: String(data.platform || ""),
    language: String(data.language || "english"), title: text(data.title), description: firstDescription(data.description),
    updatedAt: Number(data.updatedAt) || null,
    ...(/^\d{1,24}$/.test(String(data.gamesDbMatch?.gameId || "")) ? { gamesDbMatch: {
      gameId: String(data.gamesDbMatch.gameId), query: text(data.gamesDbMatch.query).slice(0, 240),
      platform: safeId(data.gamesDbMatch.platform), alternatePlatform: data.gamesDbMatch.alternatePlatform === true } } : {}),
    developers: words(data.developers), publishers: words(data.publishers), genres: words(data.genres), releaseDate: release(data.releaseDate),
    artwork: Object.fromEntries(Object.entries(data.artwork && typeof data.artwork === "object" ? data.artwork : {}).filter(([key]) => ["hero", "header", "cover", "logo"].includes(key)).map(([key, value]) => [key, url(value)]).filter(([, value]) => value)) };
}
function store(options) {
  try {
    const data = normalize(options); if (!data) return null;
    return storeNormalized({ ...options, data });
  } catch { return null; }
}
function merge(primary, fallback) {
  if (!primary) return fallback;
  if (!fallback) return primary;
  const value = { ...primary };
  for (const key of ["title", "description", "developers", "publishers", "genres", "releaseDate"])
    if (!value[key]?.length) value[key] = fallback[key] || value[key];
  value.artwork = { ...fallback.artwork, ...primary.artwork };
  if (!value.gamesDbMatch && fallback.gamesDbMatch) value.gamesDbMatch = fallback.gamesDbMatch;
  return value;
}
function storeNormalized(options) {
  try {
    const data = present(options.data);
    if (!safeId(data.sourceId) || !safeId(options.platform) || !safeId(data.language)) return null;
    let value = { ...data, platform: options.platform };
    if (!options.directory) {
      if (!options.userDataDir || !safeId(options.appid)) return null;
      const key = pendingKey(options.userDataDir, options.platform, options.appid, data.language);
      value = merge(value, pending.get(key));
      if (pending.size >= 256 && !pending.has(key)) pending.delete(pending.keys().next().value);
      pending.set(key, value);
      return value;
    }
    const file = path.join(options.directory, "game-details.json");
    let previous; try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    // A title-only response must not erase previously obtained detail fields.
    if (previous?.sourceId === value.sourceId && previous?.source === value.source && previous?.language === value.language) {
      value = merge(value, present(previous));
    }
    const content = entry => { if (!entry) return ""; const copy = { ...entry }; delete copy.updatedAt; return JSON.stringify(copy); };
    if (content(previous) !== content(value)) {
      value.updatedAt = Date.now();
      fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomicSync(file, value);
      logger.info("game-details:saved", { platform: options.platform, appid: options.appid || value.sourceId, path: file, source: value.source });
    } else value.updatedAt = previous.updatedAt || null;
    return value;
  } catch (error) {
    logger.warn("game-details:save-failed", { platform: options.platform, appid: options.appid,
      path: options.directory ? path.join(options.directory, "game-details.json") : null, error: error.message });
    return null;
  } // Presentation must never fail schema generation.
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function read({ userDataDir, config, language = "english" }) {
  const platform = String(config.platform || "steam").toLowerCase(), appid = String(config.appid || "");
  const steamId = ["steam", "steam-official", "markerpatch", "madnesspatch"].includes(platform) ? appid
    : String(config.steamAppId || config.steam_appid || config.steam_app_id || "");
  const lang = safeId(language.toLowerCase()) || "english";
  const candidates = [[platform, appid], ...(["gog", "gog-official"].includes(platform) ? [["gog", appid], ["gog-official", appid]] : []),
    ...(/^\d+$/.test(steamId) ? [["steam", steamId], ["steam-official", steamId]] : [])];
  let canonical = null;
  if (config.config_path) {
    const data = readJson(path.join(config.config_path, "game-details.json"));
    if (data?.version === 1 && ((data.platform === platform && data.sourceId === appid) ||
        (data.source === "steam" && /^\d+$/.test(steamId) && data.sourceId === steamId)) && [lang, "english"].includes(data.language || "english")) canonical = present(data);
  }
  let supplemental = null;
  for (const [sourcePlatform, sourceId] of candidates) for (const l of [...new Set([lang, "english"])]) {
    const remembered = pending.get(pendingKey(userDataDir, sourcePlatform, sourceId, l));
    // Read old caches only for compatibility. New data is never written here.
    const data = remembered || readJson(legacyFileFor(userDataDir, sourcePlatform, sourceId, l));
    if (data?.version === 1 && data.platform === sourcePlatform && data.sourceId === sourceId) {
      supplemental = merge(supplemental, present(data));
    }
  }
  if (supplemental && config.config_path) {
    const stored = storeNormalized({ directory: config.config_path, platform, appid, data: merge(canonical, supplemental) });
    // The schema file is authoritative even if adopting an old cache fails.
    if (stored) return stored;
  }
  if (canonical) return canonical;
  if (config.config_path) {
    // Old schemas can already carry product info. Read it locally without
    // regenerating schemas or rewriting configs just to show a description.
    if (/^\d+$/.test(steamId)) {
      const product = readJson(path.join(config.config_path, "steam_misc/app_info/app_product_info.json"));
      if (product && String(product.appid || product.common?.gameid || "") === steamId)
        return normalize({ kind: "steam", appid: steamId, language: "english", payload: { product } });
    }
  }
  return null;
}
function captureSteamOutput(appid, appOutputDir, outDir) {
  try {
    const pick = candidates => candidates.map(file => readJson(path.join(appOutputDir, file))).find(Boolean);
    const product = pick(["info/product_info.json", "steam_misc/app_info/app_product_info.json"]);
    const details = pick(["info/app_details.json", "steam_misc/app_info/app_details.json"]);
    const data = details?.[String(appid)]?.data || details?.data || {};
    return store({ directory: outDir, platform: "steam", appid, kind: "steam", payload: { details: data, product } });
  } catch { return null; }
}
function inherit(sourceDir, previousDir) {
  try {
    const fresh = readJson(path.join(sourceDir, "game-details.json")), old = readJson(path.join(previousDir, "game-details.json"));
    if (!fresh || !old || fresh.sourceId !== old.sourceId || fresh.source !== old.source || fresh.platform !== old.platform || fresh.language !== old.language) return;
    storeNormalized({ directory: sourceDir, platform: fresh.platform, appid: fresh.sourceId, data: merge(present(fresh), present(old)) });
  } catch {} // Optional fields must not prevent a safe schema replacement.
}
module.exports = { store, storeNormalized, read, normalize, captureSteamOutput, release, merge, inherit };
