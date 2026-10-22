(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlaytimeDuration = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function formatInput(totalMs) {
    const seconds = Math.floor(Math.max(0, Number(totalMs) || 0) / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, "0")).join(":");
  }
  function parseInput(value) {
    const match = /^(\d{1,10}):([0-5]?\d):([0-5]?\d)$/.exec(String(value || "").trim());
    if (!match) return null;
    const millis = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
    return Number.isSafeInteger(millis) ? millis : null;
  }
  return { formatInput, parseInput };
});
