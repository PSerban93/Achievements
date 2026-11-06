"use strict";

// Optional presentation fallback only. PC and console title IDs are different;
// resolve a catalog association rather than deriving one ID from the other.
const localized = value => typeof value === "string" ? value : value?.["en-US"] || value?.["*"] || "";
const titleKey = value => localized(value).normalize("NFKC").toLowerCase()
  .replace(/[™®]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
function gameTitle(config) {
  return String(config.displayName || config.name || "")
    .replace(/\s*\[\d+\]\s*$/, "").replace(/\s*\(XLiveLessNess\)\s*$/i, "").trim();
}
const matches = (payload, title) => !!titleKey(title) &&
  titleKey(payload.title || payload.game?.title) === titleKey(title) &&
  (!payload.game?.title || titleKey(payload.game.title) === titleKey(title));
const releaseUrl = id => `https://gamesdb.gog.com/platforms/xboxone/external_releases/${encodeURIComponent(id)}`;
const validRelease = (data, id) => data?.platform_id === "xboxone" && String(data.external_id) === id;

async function resolveGfwlRelease(config, nativeId, getJson, { nativeOnly = false } = {}) {
  const title = gameTitle(config);
  try {
    const payload = await getJson(releaseUrl(nativeId));
    if (validRelease(payload, nativeId) && (!title || matches(payload, title)))
      return { payload, id: nativeId, fallback: false };
  } catch (error) {
    // A temporary outage is not evidence that the native release is missing.
    if (error.response?.status !== 404 && error.status !== 404) throw error;
  }
  if (nativeOnly) return null; // The metadata service uses its common title fallback.
  if (!title) return null;
  const response = await getJson(`https://gamesdb.gog.com/games?title=${encodeURIComponent(title)}`);
  const candidates = (Array.isArray(response?.items) ? response.items : [])
    .filter(game => game && titleKey(game.title) === titleKey(title) && Array.isArray(game.releases) &&
      game.releases.some(release => release?.platform_id === "xboxone" && /^\d+$/.test(String(release.external_id))));
  const games = new Map(candidates.filter(game => game.id).map(game => [String(game.id), game]));
  if (games.size !== 1) return null; // Never resolve same-name games by first hit.
  const game = [...games.values()][0];
  const ids = [...new Set(game.releases.filter(release => release?.platform_id === "xboxone")
    .map(release => String(release.external_id)).filter(id => /^\d+$/.test(id) && id !== nativeId))].slice(0, 12);
  for (const id of ids) {
    try {
      const payload = await getJson(releaseUrl(id));
      // Search result and release must agree on the canonical game as well.
      const gameIds = [payload?.game_id, payload?.game?.id].filter(value => value != null);
      if (validRelease(payload, id) && gameIds.length && gameIds.every(value => String(value) === String(game.id)) && matches(payload, title))
        return { payload, id, fallback: true };
    } catch (error) {
      if (error.response?.status !== 404 && error.status !== 404) throw error;
    }
  }
  return null;
}
module.exports = { resolveGfwlRelease };
