(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TrophyMode = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TROPHY_MODE_GOLD_THRESHOLD_PERCENT = 20;
  const TROPHY_MODE_SILVER_THRESHOLD_PERCENT = 50;

  function normalizeTrophyModeThresholds(preferences = {}) {
    if (!preferences || typeof preferences !== "object") preferences = {};
    const read = (value, fallback) => {
      if (value === null || value === undefined || value === "") return fallback;
      if (typeof value !== "number" && typeof value !== "string") return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
    };
    const trophyModeGoldThreshold = Math.min(99, Math.max(1,
      read(preferences.trophyModeGoldThreshold, TROPHY_MODE_GOLD_THRESHOLD_PERCENT)));
    const trophyModeSilverThreshold = Math.min(100, Math.max(trophyModeGoldThreshold + 1,
      read(preferences.trophyModeSilverThreshold, TROPHY_MODE_SILVER_THRESHOLD_PERCENT)));
    return { trophyModeGoldThreshold, trophyModeSilverThreshold };
  }

  function normalizeRarityPercent(value) {
    if (value === null || value === undefined || value === "") return null;
    let normalized = value;
    if (typeof value === "string") {
      const match = value
        .replace(",", ".")
        .trim()
        .match(/-?\d+(?:\.\d+)?/);
      if (!match) return null;
      normalized = match[0];
    }
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(100, Math.max(0, parsed));
  }

  function resolveTrophyModeTier({
    rarityPct = null,
    isPlatinum = false,
    trophyModeGoldThreshold,
    trophyModeSilverThreshold,
  } = {}) {
    if (isPlatinum === true) {
      return { tier: "platinum", source: "completion" };
    }

    const rarityPercent = normalizeRarityPercent(rarityPct);
    if (rarityPercent === null) {
      return { tier: "bronze", source: "fallback" };
    }
    const thresholds = normalizeTrophyModeThresholds({
      trophyModeGoldThreshold, trophyModeSilverThreshold,
    });
    if (rarityPercent < thresholds.trophyModeGoldThreshold) {
      return { tier: "gold", source: "rarity" };
    }
    if (rarityPercent < thresholds.trophyModeSilverThreshold) {
      return { tier: "silver", source: "rarity" };
    }
    return { tier: "bronze", source: "rarity" };
  }

  function shouldUseRareNotificationProfile({
    trophyModeEnabled = false,
    isRare = false,
    isPlatinum = false,
  } = {}) {
    return isPlatinum !== true && (trophyModeEnabled === true || isRare === true);
  }

  function getRareTestRarityTiers(preferences = {}) {
    const { trophyModeEnabled = false } = preferences;
    const { trophyModeGoldThreshold: gold, trophyModeSilverThreshold: silver } =
      normalizeTrophyModeThresholds(preferences);
    return trophyModeEnabled
      ? [
          { name: "gold", min: 0.01, max: gold - 0.01 },
          { name: "silver", min: gold, max: silver - 0.01 },
          { name: "bronze", min: silver, max: 100 },
        ]
      : [
          { name: "gold", min: 0.01, max: 1 },
          { name: "silver", min: 1.01, max: 5 },
          { name: "bronze", min: 5.01, max: 10 },
        ];
  }

  return {
    TROPHY_MODE_GOLD_THRESHOLD_PERCENT,
    TROPHY_MODE_SILVER_THRESHOLD_PERCENT,
    normalizeRarityPercent,
    normalizeTrophyModeThresholds,
    resolveTrophyModeTier,
    shouldUseRareNotificationProfile,
    getRareTestRarityTiers,
  };
});
