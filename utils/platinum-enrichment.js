"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { compareAchievements, normalizeTitle, cleanExophaseTitle } = require("./exophase-catalog");
const { resolveAchievementLanguage, normalizeAchievementLanguage } = require("./achievement-language");

const COMPLETION_ID = "__ACHIEVEMENTS_COMPLETION_PLATINUM__";
const FILE = "platinum.json";
const SEARCH_PLATFORMS = new Set([
  "steam", "steam-official", "uplay", "ubisoft-official", "gog", "gog-official",
  "epic", "epic-official", "ea-official", "xenia", "x360recomp",
]);
function isSearchSupported(config) {
  return SEARCH_PLATFORMS.has(String(config?.platform || "").trim().toLowerCase());
}
const pending = new Map();
const tasks = [];
let running = false;
const english = value => typeof value === "string" ? value : value?.english || value?.English || "";
const normalized = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const platinum = entry => /^(p|platinum)$/i.test(String(entry?.trophyType || entry?.trophy_type || "").trim());
function schemaPath(config) {
  const root = config?.config_path;
  if (!root) return null;
  return [path.join(root, "steam_settings", "achievements.json"), path.join(root, "achievements.json"),
    path.join(root, String(config.appid || ""), "achievements.json")].find(file => fs.existsSync(file)) || null;
}
function fingerprint(schema) {
  return crypto.createHash("sha256").update(JSON.stringify(schema.map(entry => [String(entry.name),
    english(entry.displayName), english(entry.description)]))).digest("hex");
}
function readMetadata(config, schema) {
  if (!isSearchSupported(config)) return null;
  try {
    const file = schemaPath(config); if (!file) return null;
    schema ||= JSON.parse(fs.readFileSync(file, "utf8"));
    const data = JSON.parse(fs.readFileSync(path.join(path.dirname(file), FILE), "utf8"));
    if (data.version !== 1 || data.schemaHash !== fingerprint(schema) || !data.achievement?.name) return null;
    if (data.kind === "native") {
      const native = schema.filter(platinum);
      if (native.length !== 1 || native[0].name !== data.achievement.name) return null;
    } else if (data.kind === "completion") {
      if (schema.some(platinum) || config.native_platinum === true) return null;
      if (data.achievement.name !== COMPLETION_ID || !fs.existsSync(path.join(path.dirname(file), data.achievement.icon || ""))) return null;
    } else return null;
    return data;
  } catch { return null; }
}
function completionSnapshot(schema, saved, entry) {
  const real = schema.filter(item => item.name !== COMPLETION_ID);
  const complete = real.length > 0 && real.every(item => saved?.[item.name]?.earned === true || saved?.[item.name]?.earned === 1);
  return { ...saved, [entry.name]: { earned: complete,
    earned_time: complete ? Math.max(0, ...real.map(item => Number(saved[item.name]?.earned_time) || 0)) : 0,
    synthetic_platinum: true } };
}
function augmentSchema(config, schema) {
  const metadata = readMetadata(config, schema);
  return metadata?.kind === "completion" && config.platinum_achievement?.kind === "completion" &&
    config.platinum_achievement.name === metadata.achievement.name && !schema.some(entry => entry.name === metadata.achievement.name)
    ? [...schema, { ...metadata.achievement, synthetic_platinum: true }] : schema;
}
function augmentSnapshot(config, saved) {
  if (!isSearchSupported(config)) return saved;
  const file = schemaPath(config); if (!file) return saved;
  try {
    const schema = JSON.parse(fs.readFileSync(file, "utf8")), metadata = readMetadata(config, schema);
    return metadata?.kind === "completion" && config.platinum_achievement?.kind === "completion" &&
      config.platinum_achievement.name === metadata.achievement.name ? completionSnapshot(schema, saved, metadata.achievement) : saved;
  } catch { return saved; }
}
function matchEquivalent(schema, remote) {
  const title = normalized(english(remote.titles || remote.displayName));
  if (!title) return { entry: null, rule: "" };
  const goal = value => normalized(value).replace(/\b(?:collect|obtain|earn|unlock)\b/g, "obtain")
    .replace(/\b(?:every|all)\b/g, "all").replace(/\b(?:trophies|trophy|achievements)\b/g, "achievement")
    .replace(/\bother\b/g, "").replace(/\s+/g, " ").trim();
  const description = goal(english(remote.descriptions || remote.description));
  const sameTitle = schema.filter(entry => normalized(english(entry.displayName)) === title);
  const candidates = sameTitle.filter(entry => description && goal(english(entry.description)) === description);
  if (candidates.length === 1) return { entry: candidates[0], rule: "title-description" };
  if (sameTitle.length === 1) return { entry: sameTitle[0], rule: "title" };
  return { entry: null, rule: "" };
}
function selectEquivalent(schema, remote) {
  return matchEquivalent(schema, remote).entry;
}
function searchQueries(config, configFile) {
  const platform = String(config.platform || "").trim().toLowerCase();
  const raw = (platform === "x360recomp" && config.x360_recomp_catalog_title) ||
    config.displayName || config.name || path.basename(configFile, ".json");
  const title = cleanExophaseTitle(String(raw)
    .replace(/\s*\((?:Steam(?: Official)?|Epic(?: Official)?|GOG(?: Official)?|Uplay|Ubisoft(?: Official)?|EA(?: Official)?|Xbox(?: PC)?)\)(?:\s*\[\d+\])?\s*$/i, ""));
  const queries = [{ title, prefix: false }];
  // Xbox catalogs can abbreviate subtitles. Broader searches remain confined
  // to Xbox sources and still require the verified local achievement set.
  const prefix = title.includes(":") ? title.split(":")[0].trim() : "";
  if (["xenia", "x360recomp"].includes(platform) && prefix.length >= 4 && normalizeTitle(prefix) !== normalizeTitle(title)) {
    queries.push({ title: prefix, prefix: true });
  }
  return queries;
}
function findForConfig(configFile, options = {}) {
  const key = path.resolve(configFile);
  if (pending.has(key)) return pending.get(key);
  let resolve, reject;
  const task = new Promise((yes, no) => { resolve = yes; reject = no; });
  const job = async () => { try { resolve(await enrich(key, options)); } catch (error) { reject(error); } };
  if (options.force) tasks.unshift(job); else tasks.push(job);
  pending.set(key, task);
  void drain();
  return task.finally(() => { if (pending.get(key) === task) pending.delete(key); });
}
async function drain() {
  if (running) return;
  running = true;
  try { while (tasks.length) await tasks.shift()(); }
  finally { running = false; }
}
function writeIfChanged(file, value) {
  try { if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(value)) return; } catch {}
  writeJsonAtomicSync(file, value, { backup: true });
}
function mergeCompletionLanguages(entry, previous) {
  if (!previous || normalized(english(entry.displayName)) !== normalized(english(previous.displayName)) ||
      normalized(english(entry.description)) !== normalized(english(previous.description))) return entry;
  const dictionary = value => typeof value === "string" ? { english: value } : value || {};
  return { ...entry, displayName: { ...dictionary(previous.displayName), ...dictionary(entry.displayName) },
    description: { ...dictionary(previous.description), ...dictionary(entry.description) } };
}
async function enrich(configFile, { force = false, logger, fetchMetadata, downloadIcon, languages = ["english"] } = {}) {
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (!isSearchSupported(config)) return { success: false, skipped: true, code: "platform-unsupported" };
  const file = schemaPath(config);
  if (!file) return { success: false, code: "schema-missing" };
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(schema) || !schema.length) return { success: false, code: "schema-missing" };
  const hash = fingerprint(schema), cached = readMetadata(config, schema);
  const cacheConfigMatches = cached && config.platinum_achievement?.name === cached.achievement.name &&
    config.platinum_achievement?.kind === cached.kind && config.native_platinum === (cached.kind === "native");
  if (!force && cacheConfigMatches && (cached.kind !== "completion" || cached.translations?.version === 1)) return { success: true, kind: cached.kind, cached: true };
  const native = schema.filter(platinum);
  if (native.length > 1) return { success: false, code: "ambiguous" };
  let entry = native[0], kind = "native", source = "schema", sourceUrl = "", remote, translations;
  if (entry && config.platinum_achievement?.name === entry.name) {
    source = config.platinum_achievement.source || cached?.source || "schema";
    sourceUrl = config.platinum_achievement.sourceUrl || cached?.sourceUrl || "";
  } else if (entry && cached?.kind === "native") {
    source = cached.source;
    sourceUrl = cached.sourceUrl;
  }
  if (!entry) {
    const scraper = require("./exophase-scraper");
    const fetcher = fetchMetadata || scraper.fetchExophaseAchievementsMultiLang;
    let lastError;
    lookup: for (const query of searchQueries(config, configFile)) for (const platform of ["ps5", "ps4", "ps3"]) {
      try {
        const result = await fetcher({ title: query.title, platform, schemaAchievements: schema, selectionPurpose: "platinum",
          langKeys: [...new Set(["english", ...scraper.EXOPHASE_LANG_KEYS, resolveAchievementLanguage(config, languages[0]),
            ...languages.map(language => normalizeAchievementLanguage(language)).filter(Boolean)])], logger });
        const comparison = compareAchievements(schema, result.items.map(item => ({
          title: english(item.titles), description: english(item.descriptions) })));
        const wanted = normalizeTitle(query.title), found = normalizeTitle(result.gameTitle);
        const titleMatches = wanted && (found === wanted || (query.prefix && found.startsWith(`${wanted} `)));
        if (!comparison.valid || comparison.matches / comparison.compared < 0.9 || !titleMatches) continue;
        const candidates = result.items.filter(platinum);
        if (!candidates.length) logger?.info("platinum:list-without-platinum", { configName: config.name,
          appid: config.appid, platform, sourceUrl: result.baseUrl, count: result.items.length });
        if (candidates.length !== 1) continue;
        remote = candidates[0]; sourceUrl = result.baseUrl; translations = result.platinumLanguages || { version: 1 };
        if (query.prefix) logger?.info("platinum:xbox-title-resolved", { configName: config.name, appid: config.appid,
          query: query.title, title: result.gameTitle, matches: comparison.matches, compared: comparison.compared });
        break lookup;
      } catch (error) {
        lastError = error;
        if (/NETWORK|TIMEOUT|HTTP/.test(String(error.code || ""))) return { success: false, code: "network" };
        if (error.code === "EXOPHASE_AMBIGUOUS") return { success: false, code: "ambiguous" };
      }
    }
    if (!remote) {
      logger?.info("platinum:not-found", { configName: config.name, appid: config.appid, code: lastError?.code || "no-match" });
      return { success: false, code: lastError?.code === "EXOPHASE_AMBIGUOUS" ? "ambiguous" : "not-found" };
    }
    const equivalent = matchEquivalent(schema, remote);
    entry = equivalent.entry;
    if (entry) logger?.info("platinum:equivalent-selected", { configName: config.name, appid: config.appid,
      achievementId: entry.name, rule: equivalent.rule });
    if (!entry && schema.some(item => normalized(english(item.displayName)) === normalized(english(remote.titles)))) {
      return { success: false, code: "ambiguous" };
    }
    source = "exophase";
    if (!entry) {
      if (schema.some(item => item.name === COMPLETION_ID)) return { success: false, code: "id-conflict" };
      kind = "completion";
      const relativeIcon = `img/platinum-${hash.slice(0, 16)}.png`;
      const destination = path.join(path.dirname(file), relativeIcon);
      const download = downloadIcon || (async (url, target) => {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.hostname !== "m.exophase.com") return false;
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")) return false;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 4 * 1024 * 1024) return false;
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return true;
      });
      if (!fs.existsSync(destination) && !await download(remote.icon_url, destination)) return { success: false, code: "image-failed" };
      entry = { name: COMPLETION_ID, displayName: remote.titles, description: remote.descriptions,
        icon: relativeIcon, icon_gray: relativeIcon, hidden: 0, trophyType: "platinum", synthetic_platinum: true,
        ...(typeof remote.rarityPct === "number" && Number.isFinite(remote.rarityPct) && remote.rarityPct >= 0 && remote.rarityPct <= 100
          ? { rarityPct: remote.rarityPct, raritySource: remote.raritySource || "exophase" } : {}) };
    }
  }
  // Re-read after network I/O: never resurrect deleted configs or overwrite a
  // different game/schema, launch settings, or rarity refreshed meanwhile.
  const currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (currentConfig.appid !== config.appid || currentConfig.platform !== config.platform ||
      currentConfig.config_path !== config.config_path || schemaPath(currentConfig) !== file) return { success: false, code: "superseded" };
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  if (fingerprint(current) !== hash) return { success: false, code: "superseded" };
  // Trophy grades may be restored independently of the text/rarity. An
  // authoritative Platinum arriving during the search wins over its result.
  const currentNative = current.filter(platinum);
  if (JSON.stringify(currentNative.map(item => String(item.name))) !== JSON.stringify(native.map(item => String(item.name))) ||
      (currentConfig.native_platinum === true && config.native_platinum !== true)) {
    return { success: false, code: "superseded" };
  }
  if (kind === "native") {
    const match = current.find(item => item.name === entry.name);
    if (!match) return { success: false, code: "superseded" };
    if (!platinum(match)) { match.trophyType = "platinum"; match.platinum_source = source; writeJsonAtomicSync(file, current, { backup: true }); }
    entry = match;
  } else {
    // Re-read after network I/O so translations obtained by another lookup are
    // not lost when a language page fails or falls back to English this time.
    const previous = readMetadata(currentConfig, current);
    if (previous?.kind === "completion") entry = mergeCompletionLanguages(entry, previous.achievement);
  }
  const metadata = { version: 1, schemaHash: hash, kind, source, sourceUrl, achievement: entry,
    ...(kind === "completion" ? { translations } : {}) };
  writeIfChanged(path.join(path.dirname(file), FILE), metadata);
  currentConfig.platinum_achievement = { name: entry.name, kind, source, sourceUrl };
  currentConfig.native_platinum = kind === "native";
  writeIfChanged(configFile, currentConfig);
  logger?.info("platinum:updated", { configName: currentConfig.name, appid: currentConfig.appid, kind, achievementId: entry.name, sourceUrl,
    languages: Object.keys(typeof entry.displayName === "object" ? entry.displayName : { english: entry.displayName }),
    ...(translations ? { translationFailures: translations.failed || [] } : {}) });
  return { success: true, kind, achievementId: entry.name, sourceUrl };
}

module.exports = { findForConfig, readMetadata, augmentSchema, augmentSnapshot, schemaPath, fingerprint, selectEquivalent, completionSnapshot, isSearchSupported, COMPLETION_ID };
