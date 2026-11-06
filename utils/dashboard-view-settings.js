"use strict";
(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DashboardViewSettings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const keys = Object.freeze(["collections", "configs", "lastPlayed", "almostComplete", "recentUnlocks"]);
  const valid = value => typeof value === "string" && value.length > 0 && value.split(",").length <= keys.length &&
    new Set(value.split(",")).size === value.split(",").length && value.split(",").every(key => keys.includes(key));
  const normalize = value => keys.filter(key => (Array.isArray(value) ? value : String(value || "").split(",")).includes(key));
  function migrate(mode, prefs = {}) {
    if (mode !== "configs" && mode !== "collections") return [...keys];
    const sections = prefs.dashboardHomeSections ? keys.slice(2).filter((key, i) =>
      prefs[["dashboardSectionRecentlyPlayed", "dashboardSectionAlmostComplete", "dashboardSectionRecentUnlocks"][i]] !== false) : [];
    return [mode, ...sections];
  }
  function toggle(value, key) {
    const current = normalize(value);
    if (key === "all") return [...keys];
    if (!keys.includes(key)) return current;
    const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key];
    return normalize(next.length ? next : current);
  }
  return { keys, valid, normalize, migrate, toggle };
});
