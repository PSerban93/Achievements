"use strict";

const DASHBOARD_REFRESH_MODES = new Set(["targeted", "summary", "full"]);
const DASHBOARD_REFRESH_MODE_RANK = Object.freeze({
  targeted: 1,
  summary: 2,
  full: 3,
});
const DASHBOARD_REFRESH_TARGET_LIMIT = 32;

function normalizeDashboardRefreshConfigNames(values) {
  const source = Array.isArray(values) ? values : values == null ? [] : [values];
  const names = [];
  const seen = new Set();
  for (const value of source) {
    const name = String(value || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function normalizeDashboardRefreshRequest(request, fallbackMode = "full") {
  const safeFallbackMode = DASHBOARD_REFRESH_MODES.has(fallbackMode)
    ? fallbackMode
    : "full";
  let payload = {};
  if (request && typeof request === "object" && !Array.isArray(request)) {
    payload = request;
  } else if (typeof request === "string") {
    const value = request.trim();
    payload = DASHBOARD_REFRESH_MODES.has(value)
      ? { mode: value }
      : { reason: value };
  }

  let mode = String(payload.mode || "").trim().toLowerCase();
  if (!DASHBOARD_REFRESH_MODES.has(mode)) mode = safeFallbackMode;
  let configNames = normalizeDashboardRefreshConfigNames(
    payload.configNames ?? payload.configName,
  );
  // A targeted request without an identity cannot safely refresh anything.
  // Preserve the legacy full-refresh behavior instead of silently dropping it.
  if (mode === "targeted" && configNames.length === 0) mode = "full";
  if (
    mode === "targeted" &&
    configNames.length > DASHBOARD_REFRESH_TARGET_LIMIT
  ) {
    mode = "summary";
    configNames = [];
  }

  return {
    mode,
    reason: String(payload.reason || "").trim(),
    configNames,
  };
}

function mergeDashboardRefreshRequests(current, incoming) {
  if (!current) return normalizeDashboardRefreshRequest(incoming);
  if (!incoming) return normalizeDashboardRefreshRequest(current);
  const left = normalizeDashboardRefreshRequest(current);
  const right = normalizeDashboardRefreshRequest(incoming);
  let mode =
    DASHBOARD_REFRESH_MODE_RANK[right.mode] >
    DASHBOARD_REFRESH_MODE_RANK[left.mode]
      ? right.mode
      : left.mode;
  let configNames = normalizeDashboardRefreshConfigNames([
    ...left.configNames,
    ...right.configNames,
  ]);
  if (
    mode === "targeted" &&
    configNames.length > DASHBOARD_REFRESH_TARGET_LIMIT
  ) {
    mode = "summary";
    configNames = [];
  } else if (
    mode === "summary" &&
    configNames.length > DASHBOARD_REFRESH_TARGET_LIMIT
  ) {
    configNames = [];
  }
  return {
    mode,
    reason: right.reason || left.reason,
    // Keep targeted identities even when a summary refresh wins. The renderer
    // can apply the cheap snapshot first, then re-read only these changed games.
    configNames,
  };
}

module.exports = {
  DASHBOARD_REFRESH_MODES,
  DASHBOARD_REFRESH_TARGET_LIMIT,
  mergeDashboardRefreshRequests,
  normalizeDashboardRefreshConfigNames,
  normalizeDashboardRefreshRequest,
};
