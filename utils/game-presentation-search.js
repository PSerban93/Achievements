"use strict";

// Catalog lookup for presentation only. A different store's release never
// becomes the config's AppID, achievement source or launch identity.
const localized = value => typeof value === "string" ? value :
  value && typeof value === "object" ? [value["en-US"], value["*"], value.en].find(item => typeof item === "string") || "" : "";
const titleKey = value => localized(value).normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[™®©]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const suffix = /\s*\((?:Steam(?: Official)?|Epic(?: Games| Official)?|GOG(?: Official)?|Uplay|Ubisoft(?: Official)?|EA(?: Official)?|Xbox PC|Xbox 360 Recomp|X360 Recomp|Xenia|RPCS3|PS3 Recomp|PS4 Recomp|PS5|shadPS4|KytyPS5|RetroAchievements|XLiveLessNess|PC Ports?)\)\s*$/i;
function searchTitle(config, fallback = "") {
  const platform = String(config.platform).toLowerCase();
  const collection = platform === "ps4recomp" &&
    require("./ps4-recomp-collections").collection(config.ps4_recomp_port);
  const portTitle = platform === "x360recomp" && require("./x360-recomp-discovery")
    .knownTitleForId(config.x360_recomp_title_id || config.appid);
  let title = String(collection && config.ps4_recomp_title || portTitle || config.displayName || config.name || fallback || "").trim();
  for (let i = 0; i < 4; i++) title = title.replace(/\s*\[\d+\]\s*$/, "").replace(suffix, "").trim();
  title = title.replace(/[™®©]/g, "").trim();
  if (title.length > 240 || !titleKey(title) || /^\d+$/.test(title) || /^(?:NPWR\d{5}_\d{2}|(?:CUSA|PPSA)\d{5}|[A-F\d]{8,32})$/i.test(title)) return "";
  return title;
}
function preferredPlatforms(config) {
  const platform = String(config.platform || "").toLowerCase();
  if (["steam", "steam-official", "markerpatch", "madnesspatch"].includes(platform)) return ["steam"];
  if (["epic", "epic-official"].includes(platform)) return ["epic"];
  if (["gog", "gog-official"].includes(platform)) return ["gog"];
  if (["uplay", "ubisoft-official"].includes(platform)) return ["uplay"];
  if (["ea", "ea-official"].includes(platform)) return ["origin"];
  if (["rpcs3", "ps3recomp", "ps4recomp", "shadps4", "kytyps5"].includes(platform)) return ["psn"];
  if (["xbox-pc", "xenia", "x360recomp", "xlivelessness"].includes(platform)) return ["xboxone"];
  if (platform === "retroachievements") {
    // Use the console name already saved by import; a RetroAchievements game
    // number is not a store ID. Unknown consoles still allow a unique fallback.
    const consoles = { playstation: "psx", playstation2: "ps2", playstationportable: "psp", psp: "psp",
      nintendo64: "n64", nintendoentertainmentsystem: "nes", nes: "nes",
      supernintendoentertainmentsystem: "snes", supernintendo: "snes", snes: "snes",
      segagenesis: "segag", megadrive: "segag", genesismegadrive: "segag", dreamcast: "dc", segasaturn: "saturn" };
    const match = consoles[titleKey(config.retroachievements_console_name || "")];
    return match ? [match] : [];
  }
  return [];
}
const releases = game => (Array.isArray(game?.releases) ? game.releases : []).filter(release =>
  release && /^[a-z0-9_-]{1,40}$/.test(release.platform_id || "") && release.external_id != null);
const usablePlatforms = game => [...new Set(releases(game).map(release => release.platform_id)
  .filter(platform => !["test", "generic"].includes(platform)))];
function nativeMatch(game, config, preferred) {
  if (usablePlatforms(game).some(platform => preferred.includes(platform))) return true;
  // Some PS3 serials are misclassified in GamesDB. Count them as conflicting
  // PS3 evidence too, so a wrong PSN association cannot win among homonyms.
  return ["rpcs3", "ps3recomp"].includes(String(config.platform).toLowerCase()) && releases(game)
    .some(release => /^(?:BC|BL|NP)[A-Z]{2}\d{5}(?:_\d{2})?$/i.test(String(release.external_id)));
}
function choose(items, config, title) {
  const exact = new Map();
  for (const game of Array.isArray(items) ? items : []) {
    if (!game || !/^\d{1,24}$/.test(String(game.id)) || titleKey(game.title) !== titleKey(title) || !usablePlatforms(game).length) continue;
    if (!exact.has(String(game.id))) exact.set(String(game.id), game);
    else {
      const previous = exact.get(String(game.id));
      exact.set(String(game.id), { ...previous, releases: [...releases(previous), ...releases(game)] });
    }
  }
  const candidates = [...exact.values()], preferred = preferredPlatforms(config);
  const native = candidates.filter(game => nativeMatch(game, config, preferred));
  const pool = native.length ? native : candidates;
  if (pool.length !== 1) return { code: pool.length ? "ambiguous" : "not-found", candidates: pool.slice(0, 20).map(game => String(game.id)) };
  const game = pool[0], platforms = usablePlatforms(game);
  const platform = preferred.find(value => platforms.includes(value)) ||
    ["steam", "gog", "epic", "uplay", "origin", "psn", "xboxone", "psp", "ps2", "psx"].find(value => platforms.includes(value)) || platforms[0];
  return { code: "selected", game, platform, alternatePlatform: !native.length };
}
function createNameLookup({ getJson }) {
  const cache = new Map();
  const json = (url, profile, force) => {
    const key = JSON.stringify([profile || "", url]), old = cache.get(key);
    if (old && (old.pending || !force && old.expires > Date.now())) return old.promise;
    const entry = { pending: true, expires: 0 };
    entry.promise = Promise.resolve().then(() => getJson(url)).then(data => {
      entry.pending = false; entry.expires = Date.now() + 600000; return data;
    }, error => {
      entry.pending = false; entry.expires = Date.now() + 120000; throw error;
    });
    // Eviction never discards in-flight requests and breaks coalescing.
    if (cache.size >= 256) {
      const idle = [...cache].find(([, value]) => !value.pending);
      if (idle) cache.delete(idle[0]);
    }
    if (cache.size < 256 || cache.has(key)) cache.set(key, entry);
    return entry.promise;
  };
  return async ({ config, userDataDir, force = false, fallbackTitle = "", previousMatch }) => {
    const title = searchTitle(config, fallbackTitle);
    if (!title) return { code: "not-applicable" };
    if (previousMatch && /^\d{1,24}$/.test(String(previousMatch.gameId)) && titleKey(previousMatch.query) === titleKey(title)) {
      try {
        const payload = await json(`https://gamesdb.gog.com/games/${previousMatch.gameId}`, userDataDir, force);
        if (String(payload?.id) === String(previousMatch.gameId) && titleKey(payload?.title) === titleKey(title) &&
            usablePlatforms(payload).includes(previousMatch.platform))
          return { code: "selected", payload, query: title, gameId: String(previousMatch.gameId),
            platform: previousMatch.platform, alternatePlatform: previousMatch.alternatePlatform === true, reused: true };
      } catch (error) {
        if (error.response?.status !== 404 && error.status !== 404) throw error;
      }
    }
    const response = await json(`https://gamesdb.gog.com/games?title=${encodeURIComponent(title)}`, userDataDir, force);
    if (!Array.isArray(response?.items)) throw new Error("GamesDB title search returned an invalid response");
    const selection = choose(response.items, config, title);
    if (!selection.game) return { ...selection, query: title };
    const id = String(selection.game.id);
    const payload = await json(`https://gamesdb.gog.com/games/${id}`, userDataDir, force);
    if (!payload || String(payload.id) !== id || titleKey(payload.title) !== titleKey(title))
      throw new Error("GamesDB title search details do not match the selected game");
    // A fresh detail response must still contain the chosen platform association.
    if (!usablePlatforms(payload).includes(selection.platform))
      throw new Error("GamesDB title search details changed platform association");
    return { code: "selected", payload, query: title, gameId: id, platform: selection.platform,
      alternatePlatform: selection.alternatePlatform };
  };
}
module.exports = { createNameLookup, searchTitle, preferredPlatforms, choose };
