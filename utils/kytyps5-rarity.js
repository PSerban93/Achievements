"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { normalizeRarityPercent } = require("./achievement-rarity");
const trophy = require("./kytyps5-trophy");
const { packageFingerprint } = require("./kytyps5-game-source");
const {
  EXOPHASE_RARITY_SOURCE,
  fetchExophaseAchievementsMultiLang,
} = require("./exophase-scraper");

function localizedText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return value && typeof value === "object" ? String(value.english || "").trim() : "";
}

function matchText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function matchKey(title, description) {
  const normalizedTitle = matchText(title);
  return normalizedTitle ? `${normalizedTitle}|${matchText(description)}` : "";
}

function exophaseTitle(config) {
  const title = (localizedText(config.displayName) || config.name || "")
    .replace(/\s*\((?:PS5|kytyps5)\)\s*$/i, "").replace(/[™®©]/g, "").trim();
  if (!title || /^PPSA\d+$/i.test(title)) throw new Error("PS5 game title is required for Exophase");
  return title;
}

function readSchema(schemaPath) {
  const entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  if (!Array.isArray(entries) || !entries.length) throw new Error("PS5 trophy schema is empty or invalid");
  return entries;
}

function uniqueMap(rows, keyForRow) {
  const map = new Map();
  for (const row of rows) {
    const rawKeys = keyForRow(row);
    for (const key of Array.isArray(rawKeys) ? rawKeys : [rawKeys]) {
      if (key) map.set(key, map.has(key) && map.get(key) !== row ? null : row);
    }
  }
  return map;
}

function englishMatchVariants(entry) {
  const variants = entry.kytyps5_english_variants || {};
  const english = {
    locale: "en-US", title: localizedText(entry.displayName),
    description: localizedText(entry.description),
  };
  const result = [english];
  // Preserve the displayed English text, but also recognise original US text
  // if the schema's display text was manually customised.
  for (const locale of ["en-US", "en-GB"]) {
    const variant = variants[locale];
    if (typeof variant?.displayName === "string" && variant.displayName.trim()) {
      result.push({ locale, title: variant.displayName,
        description: typeof variant.description === "string" ? variant.description : "" });
    }
  }
  return result;
}

function fillMissingEnglishVariants(config, entries, logger) {
  const missing = entries.filter((entry) => !entry.kytyps5_english_variants);
  if (!missing.length) return false;
  const labels = [...new Set(missing.map((entry) => Number(entry.kytyps5_service_label ?? 0)))];
  let updated = false;
  for (const label of labels) {
    try {
      const gamePath = config.kytyps5_game_path || config.game_path;
      if (!gamePath) throw new Error("PS5 game source is unavailable for regional text");
      const file = `trophy${String(label).padStart(2, "0")}.ucp`;
      const savedSet = config.kytyps5_trophy_sets?.find((set) => set.serviceLabel === label);
      if (savedSet?.fingerprint && savedSet.fingerprint !== packageFingerprint(gamePath, file)) {
        throw new Error("PS5 trophy package changed; rescan the game before rarity refresh");
      }
      const parsed = trophy.parseTrophyPackage(gamePath, label);
      if (parsed.titleId !== String(config.appid).toUpperCase()) throw new Error("PS5 game source title ID mismatch");
      const byId = new Map(parsed.trophies.map((entry) => [entry.kytyps5_trophy_id, entry]));
      for (const entry of missing) {
        if (Number(entry.kytyps5_service_label ?? 0) !== label) continue;
        const original = byId.get(String(entry.kytyps5_trophy_id ?? entry.name));
        if (!original) continue;
        entry.kytyps5_english_variants = original.kytyps5_english_variants;
        updated = true;
      }
    } catch (error) {
      // Existing configs still match their displayed US text if the game was moved.
      logger?.warn("kytyps5:exophase:regional-text-unavailable", {
        appid: config.appid, serviceLabel: label, error: error.message,
      });
    }
  }
  return updated;
}

async function refreshKytySchemaRarity(config, options = {}) {
  if (config?.platform !== "kytyps5" || !/^PPSA\d+$/i.test(String(config.appid || "")) || !config.config_path) {
    throw new Error("Invalid KytyPS5 config for Exophase rarity");
  }
  const schemaPath = path.join(config.config_path, "achievements.json");
  const initialEntries = readSchema(schemaPath);
  if (options.onlyMissing && initialEntries.every((entry) => normalizeRarityPercent(entry.rarityPct) !== null)) {
    return { skipped: true, updated: false, reason: "rarity-complete" };
  }
  const title = exophaseTitle(config);
  options.logger?.info("kytyps5:exophase:start", { appid: config.appid, title });
  const fetched = await fetchExophaseAchievementsMultiLang({
    title, platform: "kytyps5", schemaAchievements: initialEntries,
    langKeys: ["english"], logger: options.logger,
  });
  if (options.isCancelled?.()) return { skipped: true, updated: false, reason: "cancelled" };

  // Re-read after the network request: another import or refresh may have updated a set.
  const entries = readSchema(schemaPath);
  let updated = fillMissingEnglishVariants(config, entries, options.logger);
  const items = Array.isArray(fetched.items) ? fetched.items : [];
  const remoteKeys = uniqueMap(items, (item) => matchKey(item.titles?.english, item.descriptions?.english));
  const remoteTitles = uniqueMap(items, (item) => matchText(item.titles?.english));
  // UK aliases must not make an existing unique US match ambiguous.
  const localKeys = {}, localTitles = {};
  for (const locale of ["en-US", "en-GB"]) {
    localKeys[locale] = uniqueMap(entries, (entry) => englishMatchVariants(entry)
      .filter((variant) => variant.locale === locale)
      .map((variant) => matchKey(variant.title, variant.description)));
    localTitles[locale] = uniqueMap(entries, (entry) => englishMatchVariants(entry)
      .filter((variant) => variant.locale === locale)
      .map((variant) => matchText(variant.title)));
  }
  let matched = 0;
  let matchedUk = 0;
  const assignments = new Map(), usedItems = new Set();
  // Resolve every US match before UK fallback, so an alias cannot take a
  // remote trophy already associated with another local trophy's US text.
  for (const locale of ["en-US", "en-GB"]) {
    for (const entry of entries) {
      if (assignments.has(entry)) continue;
      for (const variant of englishMatchVariants(entry).filter((value) => value.locale === locale)) {
        const key = matchKey(variant.title, variant.description);
        let item = key && localKeys[locale].get(key) === entry ? remoteKeys.get(key) : null;
        const titleKey = matchText(variant.title);
        if (!item && titleKey && localTitles[locale].get(titleKey) === entry) item = remoteTitles.get(titleKey);
        const percent = normalizeRarityPercent(item?.rarityPct);
        if (percent === null || (locale === "en-GB" && usedItems.has(item))) continue;
        assignments.set(entry, { percent, locale });
        usedItems.add(item);
        break;
      }
    }
  }
  for (const entry of entries) {
    const assignment = assignments.get(entry);
    if (!assignment) continue;
    const { percent, locale } = assignment;
    if (locale === "en-GB") matchedUk += 1;
    matched += 1;
    if (entry.rarityPct !== percent || entry.raritySource !== EXOPHASE_RARITY_SOURCE) {
      entry.rarityPct = percent;
      entry.raritySource = EXOPHASE_RARITY_SOURCE;
      updated = true;
    }
  }
  if (!matched) throw new Error("No PS5 trophies could be matched to Exophase rarity");
  // Keep names scoped by service label (e.g. s1_11), including previously matched sets.
  const percentages = entries.filter((entry) => normalizeRarityPercent(entry.rarityPct) !== null)
    .map((entry) => ({ name: String(entry.name), percent: normalizeRarityPercent(entry.rarityPct) }));
  if (updated) writeJsonAtomicSync(schemaPath, entries, { backup: true });
  const sidecarPath = path.join(config.config_path, "achievementpercentages.json");
  writeJsonAtomicSync(sidecarPath, {
    appid: String(config.appid), source: EXOPHASE_RARITY_SOURCE,
    updatedAt: new Date().toISOString(), achievements: percentages,
  }, { backup: true });
  const result = {
    updated, matched, matchedUk, sidecarPath, baseUrl: fetched.baseUrl,
    fetchedCount: items.filter((item) => normalizeRarityPercent(item.rarityPct) !== null).length,
  };
  options.logger?.info("kytyps5:exophase:merged", { appid: config.appid, ...result });
  return result;
}

module.exports = { refreshKytySchemaRarity };
