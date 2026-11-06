"use strict";
(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DashboardExperienceSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const flags = [
    ["dashboardPreviewEnabled", "preview", "Game preview", false],
    ["dashboardPreviewAlwaysVisible", "previewAlwaysVisible", "Show Game Preview all the time", false],
    ["dashboardPreviewOnSelect", "previewOnSelect", "Open Game Preview on selection", false],
    ["dashboardPreviewOnHover", "previewOnHover", "Update Game Preview on hover", false],
    ["dashboardContextBackground", "background", "Contextual background", false],
    ["dashboardControllerHints", "hints", "Controller hints", false],
    ["dashboardCustomDensity", "density", "Custom card layout", false],
  ];
  const numbers = [
    ["dashboardPortraitCardWidth", "portraitWidth", "Portrait card width", 160, 140, 360, 10, "px"],
    ["dashboardLandscapeCardWidth", "landscapeWidth", "Landscape card width", 300, 220, 520, 10, "px"],
    ["dashboardMinCardsPerRow", "minCardsPerRow", "Minimum cards per row", 1, 1, 24, 1, ""],
    ["dashboardMaxCardsPerRow", "maxCardsPerRow", "Maximum cards per row (0 = Auto)", 0, 0, 24, 1, ""],
    ["dashboardCardSpacing", "spacing", "Column spacing", 16, 8, 40, 1, "px"],
    ["dashboardRowSpacing", "rowSpacing", "Row spacing", 16, 0, 60, 1, "px"],
    ["dashboardCardTitleLines", "titleLines", "Title lines", 1, 1, 2, 1, ""],
  ];
  const sectionNumbers = [
    ["dashboardRecentPlayedLimit", "lastPlayed", "Recently played", 5, 1, Number.MAX_SAFE_INTEGER, 1, ""],
    ["dashboardRecentUnlocksLimit", "recentUnlocks", "Recent unlocks", 5, 1, Number.MAX_SAFE_INTEGER, 1, ""],
    ["dashboardAlmostCompletedLimit", "almostComplete", "Almost completed", 5, 1, Number.MAX_SAFE_INTEGER, 1, ""],
  ];
  const defaults = Object.freeze({ ...Object.fromEntries([...flags, ...numbers, ...sectionNumbers].map(([key, , , value]) => [key, value])), dashboardCollapsedSections: [], dashboardPreviewSize: {} });
  function normalizePreviewSize(value) {
    const result = {};
    for (const mode of ["compact", "expanded"]) {
      const size = value?.[mode];
      if (size && [size.width, size.height].every(n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 16384))
        result[mode] = { width: Math.round(size.width), height: Math.round(size.height) };
    }
    return result;
  }
  function normalize(prefs = {}) {
    const result = {};
    for (const [key, , , value] of flags) result[key] = typeof prefs[key] === "boolean" ? prefs[key] : value;
    for (const [key, , , value, min, max, step] of [...numbers, ...sectionNumbers]) {
      const raw = prefs[key], n = typeof raw === "number" && Number.isFinite(raw) ? raw : value;
      result[key] = min + Math.round((Math.min(max, Math.max(min, n)) - min) / step) * step;
    }
    if (!Number.isFinite(prefs.dashboardRowSpacing)) result.dashboardRowSpacing = result.dashboardCardSpacing;
    if (result.dashboardMaxCardsPerRow > 0) result.dashboardMinCardsPerRow = Math.min(result.dashboardMinCardsPerRow, result.dashboardMaxCardsPerRow);
    result.dashboardCollapsedSections = Array.isArray(prefs.dashboardCollapsedSections)
      ? [...new Set(prefs.dashboardCollapsedSections.filter(key => ["lastPlayed", "almostComplete", "recentUnlocks"].includes(key)))] : [];
    result.dashboardPreviewSize = normalizePreviewSize(prefs.dashboardPreviewSize);
    return result;
  }
  return { flags, numbers, sectionNumbers, defaults, normalize, normalizePreviewSize };
});
