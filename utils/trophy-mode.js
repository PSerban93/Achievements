"use strict";

const TROPHY_MODE_GOLD_THRESHOLD_PERCENT = 20;
const TROPHY_MODE_SILVER_THRESHOLD_PERCENT = 50;

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
} = {}) {
  if (isPlatinum === true) {
    return { tier: "platinum", source: "completion" };
  }

  const rarityPercent = normalizeRarityPercent(rarityPct);
  if (rarityPercent === null) {
    return { tier: "bronze", source: "fallback" };
  }
  if (rarityPercent < TROPHY_MODE_GOLD_THRESHOLD_PERCENT) {
    return { tier: "gold", source: "rarity" };
  }
  if (rarityPercent < TROPHY_MODE_SILVER_THRESHOLD_PERCENT) {
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

function getRareTestRarityTiers({ trophyModeEnabled = false } = {}) {
  return trophyModeEnabled
    ? [
        { name: "gold", min: 0.01, max: 19.99 },
        { name: "silver", min: 20, max: 49.99 },
        { name: "bronze", min: 50, max: 100 },
      ]
    : [
        { name: "gold", min: 0.01, max: 1 },
        { name: "silver", min: 1.01, max: 5 },
        { name: "bronze", min: 5.01, max: 10 },
      ];
}

module.exports = {
  TROPHY_MODE_GOLD_THRESHOLD_PERCENT,
  TROPHY_MODE_SILVER_THRESHOLD_PERCENT,
  normalizeRarityPercent,
  resolveTrophyModeTier,
  shouldUseRareNotificationProfile,
  getRareTestRarityTiers,
};
