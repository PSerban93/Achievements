"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OverlayOpacity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function normalize(value) {
    const number = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.round(Math.min(100, Math.max(10, number))) : 100;
  }
  function normalizeTransparency(value) {
    const number = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.round(Math.min(100, Math.max(0, number))) : 0;
  }
  return { normalize, ratio: value => normalize(value) / 100, normalizeTransparency };
});
