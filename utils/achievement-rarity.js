const fs = require("fs");
const path = require("path");
const axios = require("axios");

const RARITY_SOURCES = Object.freeze({
  steamGlobal: "steam-global-achievement-percentages",
  epicPublic: "epic-public-achievement-percentages",
  gogGameplay: "gog-gameplay-achievement-percentages",
  xboxNetwork: "xbox-network",
});

const DEFAULT_SOURCE = RARITY_SOURCES.steamGlobal;

function normalizeRarityPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
  }
  if (typeof value === "string") {
    const normalized = value.replace(",", ".").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : null;
  }
  return null;
}

async function fetchSteamGlobalAchievementPercentages(appid, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${encodeURIComponent(
    appid,
  )}`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  const rows = Array.isArray(res?.data?.achievementpercentages?.achievements)
    ? res.data.achievementpercentages.achievements
    : [];
  const out = new Map();
  for (const row of rows) {
    const name =
      typeof row?.name === "string" || typeof row?.name === "number"
        ? String(row.name).trim()
        : "";
    if (!name) continue;
    const percent = normalizeRarityPercent(row?.percent);
    if (percent === null) continue;
    out.set(name, percent);
  }
  return out;
}

function parseEpicRarityEntry(row) {
  const achievement = row?.achievement || row || {};
  const name =
    typeof achievement?.name === "string" || typeof achievement?.name === "number"
      ? String(achievement.name).trim()
      : typeof achievement?.id === "string" || typeof achievement?.id === "number"
        ? String(achievement.id).trim()
        : typeof achievement?.apiName === "string" ||
            typeof achievement?.apiName === "number"
          ? String(achievement.apiName).trim()
          : "";
  if (!name) return null;
  const percent = normalizeRarityPercent(
    achievement?.rarity?.percent ?? row?.rarity?.percent,
  );
  if (percent === null) return null;
  return { name, percent };
}

async function fetchEpicGlobalAchievementPercentages(productId, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const locale = String(options?.locale || "en").trim() || "en";
  const safeProductId = String(productId || "").trim();
  if (!safeProductId) throw new Error("productId-required");
  const url = `https://api.epicgames.dev/epic/achievements/v1/public/achievements/product/${encodeURIComponent(
    safeProductId,
  )}/locale/${encodeURIComponent(locale)}?includeAchievements=true`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
  });
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  const rows = Array.isArray(res?.data?.achievements) ? res.data.achievements : [];
  const out = new Map();
  for (const row of rows) {
    const parsed = parseEpicRarityEntry(row);
    if (!parsed) continue;
    out.set(parsed.name, parsed.percent);
  }
  return out;
}

function parseGogRarityEntry(row) {
  const name =
    typeof row?.achievement_key === "string" ||
    typeof row?.achievement_key === "number"
      ? String(row.achievement_key).trim()
      : typeof row?.achievement_id === "string" ||
          typeof row?.achievement_id === "number"
        ? String(row.achievement_id).trim()
        : "";
  if (!name) return null;
  const percent = normalizeRarityPercent(row?.rarity);
  if (percent === null) return null;
  return { name, percent };
}

function buildGogGlobalAchievementPercentagesMap(items) {
  const rows = Array.isArray(items) ? items : [];
  const out = new Map();
  for (const row of rows) {
    const parsed = parseGogRarityEntry(row);
    if (!parsed) continue;
    out.set(parsed.name, parsed.percent);
  }
  return out;
}

async function fetchGogGlobalAchievementPercentages(productId, options = {}) {
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? Number(options.timeoutMs)
      : 15000;
  const safeProductId = String(productId || "").trim();
  const safeUserId = String(options?.userId || "").trim();
  const safeAccessToken = String(options?.accessToken || "").trim();
  if (!safeProductId) throw new Error("productId-required");
  if (!safeUserId) throw new Error("userId-required");
  if (!safeAccessToken) throw new Error("accessToken-required");
  const url = `https://gameplay.gog.com/clients/${encodeURIComponent(
    safeProductId,
  )}/users/${encodeURIComponent(safeUserId)}/achievements`;
  const res = await axios.get(url, {
    timeout: timeoutMs,
    responseType: "json",
    validateStatus: (status) => status >= 200 && status < 500,
    headers: {
      Authorization: `Bearer ${safeAccessToken}`,
      "Accept-Language": String(options?.lang || "en-US"),
    },
  });
  if (res.status === 404) {
    return new Map();
  }
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}`);
  }
  const rows = Array.isArray(res?.data?.items) ? res.data.items : [];
  return buildGogGlobalAchievementPercentagesMap(rows);
}

function extractRowsFromRarityPayload(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.achievements)) return parsed.achievements;
  if (Array.isArray(parsed?.achievementpercentages?.achievements)) {
    return parsed.achievementpercentages.achievements;
  }
  return [];
}

function readAchievementPercentagesMap(filePath) {
  const fileExists = !!filePath && fs.existsSync(filePath);
  if (!fileExists) {
    return {
      map: new Map(),
      fileExists: false,
      totalRows: 0,
      source: DEFAULT_SOURCE,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const rows = extractRowsFromRarityPayload(parsed);
  const source =
    typeof parsed?.source === "string" && parsed.source.trim()
      ? parsed.source.trim()
      : DEFAULT_SOURCE;
  const map = new Map();
  for (const row of rows) {
    const name =
      typeof row?.name === "string" || typeof row?.name === "number"
        ? String(row.name).trim()
        : "";
    if (!name) continue;
    const percent = normalizeRarityPercent(row?.percent);
    if (percent === null) continue;
    map.set(name, percent);
  }
  return { map, fileExists: true, totalRows: rows.length, source };
}

function buildRarityEntriesForSchema(rawMap, schemaAchievements, options = {}) {
  const normalizeName =
    typeof options?.normalizeName === "function"
      ? options.normalizeName
      : (value) => value;
  const schemaNames = new Set(
    (Array.isArray(schemaAchievements) ? schemaAchievements : [])
      .map((item) =>
        typeof item?.name === "string" || typeof item?.name === "number"
          ? String(item.name).trim()
          : "",
      )
      .filter(Boolean),
  );
  const seen = new Set();
  const out = [];

  for (const [rawName, percent] of rawMap.entries()) {
    const normalized = normalizeName(rawName);
    const name =
      typeof normalized === "string" || typeof normalized === "number"
        ? String(normalized).trim()
        : "";
    if (!name || !schemaNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      percent: Number(percent.toFixed(4)),
    });
  }

  out.sort((a, b) =>
    String(a.name).localeCompare(String(b.name), undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
  return out;
}

function writeAchievementPercentagesSidecar(
  outDir,
  appid,
  achievements,
  options = {},
) {
  const source = String(options?.source || DEFAULT_SOURCE);
  const payload = {
    appid: String(appid),
    source,
    updatedAt: new Date().toISOString(),
    achievements: Array.isArray(achievements) ? achievements : [],
  };
  const filePath = path.join(outDir, "achievementpercentages.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function mergeRarityIntoAchievements(achievements, rarityByName, options = {}) {
  const source = String(options?.source || DEFAULT_SOURCE);
  if (!Array.isArray(achievements) || !(rarityByName instanceof Map)) {
    return { achievements, matched: 0 };
  }
  if (!rarityByName.size) return { achievements, matched: 0 };
  let matched = 0;
  const merged = achievements.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const key =
      typeof entry?.name === "string" || typeof entry?.name === "number"
        ? String(entry.name).trim()
        : "";
    if (!key || !rarityByName.has(key)) return entry;
    matched += 1;
    return {
      ...entry,
      rarityPct: rarityByName.get(key),
      raritySource: source,
    };
  });
  return { achievements: merged, matched };
}

module.exports = {
  RARITY_SOURCES,
  normalizeRarityPercent,
  fetchSteamGlobalAchievementPercentages,
  fetchEpicGlobalAchievementPercentages,
  fetchGogGlobalAchievementPercentages,
  buildGogGlobalAchievementPercentagesMap,
  buildRarityEntriesForSchema,
  writeAchievementPercentagesSidecar,
  readAchievementPercentagesMap,
  mergeRarityIntoAchievements,
};
