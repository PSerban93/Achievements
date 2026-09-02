"use strict";

(function exposeLibraryStats(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AchievementsLibraryStats = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createApi() {
  function normalizePlatform(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    return normalized || "unknown";
  }

  function createAccumulator(platform = null) {
    return {
      platform,
      totalConfigs: 0,
      activeConfigs: 0,
      ignoredConfigs: 0,
      trackedConfigs: 0,
      perfectGames: 0,
      notStartedGames: 0,
      inProgressGames: 0,
      totalAchievements: 0,
      unlockedAchievements: 0,
      lockedAchievements: 0,
      completionRate: 0,
    };
  }

  function finalizeAccumulator(accumulator) {
    accumulator.lockedAchievements = Math.max(
      0,
      accumulator.totalAchievements - accumulator.unlockedAchievements,
    );
    accumulator.completionRate =
      accumulator.totalAchievements > 0
        ? Math.min(
            100,
            (accumulator.unlockedAchievements /
              accumulator.totalAchievements) *
              100,
          )
        : 0;
    return accumulator;
  }

  function calculateLibraryStats(configs, snapshot = {}, options = {}) {
    const entries = snapshot?.entries || {};
    const isIgnored =
      typeof options.isIgnored === "function"
        ? options.isIgnored
        : (config) => config?.blacklisted === true;
    const uniqueConfigs = new Map();

    for (const config of Array.isArray(configs) ? configs : []) {
      const name = String(config?.name || "").trim();
      if (name && !uniqueConfigs.has(name)) uniqueConfigs.set(name, config);
    }

    const totals = createAccumulator();
    const platformGroups = new Map();

    for (const [name, config] of uniqueConfigs) {
      const entry = entries[name];
      const platform = normalizePlatform(config?.platform || entry?.platform);
      if (!platformGroups.has(platform)) {
        platformGroups.set(platform, createAccumulator(platform));
      }
      const group = platformGroups.get(platform);
      totals.totalConfigs += 1;
      group.totalConfigs += 1;

      let ignored = config?.blacklisted === true;
      if (typeof options.isIgnored === "function") {
        try {
          ignored = isIgnored(config) === true;
        } catch {
          // Fall back to metadata if a UI-specific resolver fails.
        }
      }

      if (ignored) {
        totals.ignoredConfigs += 1;
        group.ignoredConfigs += 1;
        continue;
      }

      totals.activeConfigs += 1;
      group.activeConfigs += 1;
      if (entry?.verified !== true) continue;

      const total = Math.max(0, Math.floor(Number(entry.total) || 0));
      if (total <= 0) continue;
      const unlocked = Math.min(
        total,
        Math.max(0, Math.floor(Number(entry.unlocked) || 0)),
      );

      totals.trackedConfigs += 1;
      group.trackedConfigs += 1;
      totals.totalAchievements += total;
      group.totalAchievements += total;
      totals.unlockedAchievements += unlocked;
      group.unlockedAchievements += unlocked;

      if (unlocked === 0) {
        totals.notStartedGames += 1;
        group.notStartedGames += 1;
      } else if (unlocked === total) {
        totals.perfectGames += 1;
        group.perfectGames += 1;
      } else {
        totals.inProgressGames += 1;
        group.inProgressGames += 1;
      }
    }

    finalizeAccumulator(totals);
    totals.activePlatforms = Array.from(platformGroups.values()).filter(
      (group) => group.activeConfigs > 0,
    ).length;
    totals.platformRows = Array.from(platformGroups.values()).map((group) =>
      finalizeAccumulator(group),
    );
    return totals;
  }

  return {
    calculateLibraryStats,
    normalizePlatform,
  };
});
