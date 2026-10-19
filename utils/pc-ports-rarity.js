"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { normalizeRarityPercent } = require("./achievement-rarity");
const { EXOPHASE_RARITY_SOURCE, fetchExophaseAchievementsMultiLang } = require("./exophase-scraper");

// LADXHD adapted this set from the GBC game. These percentages describe
// Exophase's Retro/GBC players, not a population of PC-port players.
const LADXHD_SLUG = "legend-of-zelda-links-awakening-dx-the";

function supportsConfig(config) {
  return config?.platform === "pcports" && config.appid === "ladxhd" && config.pc_port_game === "ladxhd";
}

function english(value) {
  return typeof value === "string" ? value : String(value?.english || "");
}

function matchText(value) {
  return english(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function matchIdentity(entry) {
  // The port calls the Color Dungeon boss Hardhit Beetle; the GBC set calls
  // it Evil Orb. BossHardhitBeetle.cs awards ID 42 for the same damageless win.
  // Scope this reviewed alias to its ID and original text, not a fuzzy rename.
  if (entry.name === "achievement42" && matchText(entry.displayName) === "hardhit obliterator" &&
      matchText(entry.description) === "defeat hardhit beetle without being harmed") {
    return { title: "orb obliterator", description: "defeat evil orb without being harmed" };
  }
  return { title: matchText(entry.displayName), description: matchText(entry.description) };
}

function uniqueMap(rows, keyForRow) {
  const map = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    if (key) map.set(key, map.has(key) ? null : row);
  }
  return map;
}

function readSchema(schemaPath) {
  const entries = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const names = new Set();
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => {
    const name = String(entry?.name || "");
    const invalid = !/^achievement(?:[0-9]|[1-9][0-9]|10[0-9])$/.test(name) || names.has(name);
    names.add(name);
    return invalid;
  })) throw new Error("Invalid LADXHD achievement schema");
  return entries;
}

async function refreshPcPortSchemaRarity(config, options = {}) {
  if (!supportsConfig(config) || !config.config_path) throw new Error("Unsupported PC port for Exophase rarity");
  const schemaPath = path.join(config.config_path, "achievements.json");
  const initialEntries = readSchema(schemaPath);
  const cancelled = () => options.isCancelled?.() === true;
  const complete = (rows) => rows.every((entry) => normalizeRarityPercent(entry.rarityPct) !== null);
  if (cancelled()) return { skipped: true, updated: false, reason: "cancelled" };
  if (options.onlyMissing && complete(initialEntries)) {
    return { skipped: true, updated: false, reason: "rarity-complete" };
  }
  options.logger?.info("pcports:exophase:start", { appid: config.appid, onlyMissing: options.onlyMissing === true });
  const fetched = await fetchExophaseAchievementsMultiLang({
    slug: LADXHD_SLUG, platform: "retro", langKeys: ["english"], logger: options.logger,
  });
  if (cancelled()) return { skipped: true, updated: false, reason: "cancelled" };
  // Re-read after fetching so a concurrent rescan's definitions are preserved.
  const entries = readSchema(schemaPath);
  if (options.onlyMissing && complete(entries)) {
    return { skipped: true, updated: false, reason: "rarity-complete" };
  }
  const items = Array.isArray(fetched.items) ? fetched.items : [];
  const title = (entry) => matchIdentity(entry).title;
  const pair = (entry) => `${title(entry)}|${matchIdentity(entry).description}`;
  const remoteTitle = (item) => matchText(item.titles?.english);
  const remotePair = (item) => `${remoteTitle(item)}|${matchText(item.descriptions?.english)}`;
  const localPairs = uniqueMap(entries, pair), localTitles = uniqueMap(entries, title);
  const remotePairs = uniqueMap(items, remotePair), remoteTitles = uniqueMap(items, remoteTitle);
  const used = new Set(), matchedNames = new Set();
  let matched = 0, titleOnlyMatched = 0, updated = false;
  for (const entry of entries) {
    if (options.onlyMissing && normalizeRarityPercent(entry.rarityPct) !== null) continue;
    if (!title(entry)) continue;
    let item = localPairs.get(pair(entry)) === entry ? remotePairs.get(pair(entry)) : null;
    let titleOnly = false;
    // Descriptions can differ because the port adapted unlock conditions.
    // A fallback title must be unique on both sides; never match by row order.
    if (!item && localTitles.get(title(entry)) === entry) {
      item = remoteTitles.get(title(entry));
      titleOnly = true;
    }
    const percent = normalizeRarityPercent(item?.rarityPct);
    if (!item || used.has(item) || percent === null) continue;
    used.add(item); matchedNames.add(entry.name); matched += 1;
    if (titleOnly) titleOnlyMatched += 1;
    if (entry.rarityPct !== percent || entry.raritySource !== EXOPHASE_RARITY_SOURCE) {
      entry.rarityPct = percent;
      entry.raritySource = EXOPHASE_RARITY_SOURCE;
      updated = true;
    }
  }
  if (!matched) throw new Error("No LADXHD achievements could be matched to Exophase rarity");
  if (cancelled()) return { skipped: true, updated: false, reason: "cancelled" };
  if (updated) writeJsonAtomicSync(schemaPath, entries, { backup: true });
  const sidecarPath = path.join(config.config_path, "achievementpercentages.json");
  writeJsonAtomicSync(sidecarPath, {
    appid: config.appid, source: EXOPHASE_RARITY_SOURCE, sourcePlatform: "retro",
    sourceGame: "The Legend of Zelda: Link's Awakening DX (GBC)", baseUrl: fetched.baseUrl,
    updatedAt: new Date().toISOString(),
    achievements: entries.filter((entry) => normalizeRarityPercent(entry.rarityPct) !== null)
      .map((entry) => ({ name: entry.name, percent: normalizeRarityPercent(entry.rarityPct) })),
  }, { backup: true });
  const result = { updated, matched, titleOnlyMatched, sidecarPath, baseUrl: fetched.baseUrl,
    fetchedCount: items.filter((item) => normalizeRarityPercent(item.rarityPct) !== null).length };
  options.logger?.info("pcports:exophase:matched", { appid: config.appid, ...result,
    unmatched: entries.filter((entry) => options.onlyMissing
      ? normalizeRarityPercent(entry.rarityPct) === null : !matchedNames.has(entry.name)).map((entry) => entry.name) });
  return result;
}

module.exports = { supportsConfig, refreshPcPortSchemaRarity };
