"use strict";

function selectRecentGames(lastPlayed, { readConfig, isBlacklisted = () => false, isValidName = () => true, limit = 5 }) {
  const count = Math.max(0, Math.min(5, Math.trunc(Number(limit) || 0)));
  if (!count) return [];
  const recent = [];
  const ordered = Object.entries(lastPlayed || {})
    .filter(([name, timestamp]) => isValidName(name) && Number.isFinite(Number(timestamp)) && Number(timestamp) > 0)
    .sort(([left, a], [right, b]) => Number(b) - Number(a) || (left < right ? -1 : left > right ? 1 : 0));
  for (const [configName, timestamp] of ordered) {
    const config = readConfig(configName);
    if (!config || typeof config !== "object" || Array.isArray(config) || isBlacklisted(config.appid, config.platform)) continue;
    recent.push({ configName, name: typeof config.name === "string" && config.name.trim() ? config.name.trim() : configName,
      lastPlayedAt: Number(timestamp), config });
    if (recent.length >= count) break;
  }
  return recent;
}

module.exports = { selectRecentGames };
