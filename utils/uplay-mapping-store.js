"use strict";

const fs = require("fs");
const path = require("path");

const defaultAssetPath = path.join(__dirname, "..", "assets", "uplay-steam.json");

let runtimePath = "";
let assetPath = defaultAssetPath;
let snapshotRows = [];
const snapshotByUplayId = new Map();
let snapshotSource = "none";
let snapshotVersion = 0;
let readyPromise = Promise.resolve({
  ok: true,
  source: snapshotSource,
  entries: 0,
  version: snapshotVersion,
});
let refreshGeneration = 0;

function normalizeRows(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("Uplay mapping must be a JSON array.");
  }
  return value.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return String(row.uplay_id || "").trim().length > 0;
  });
}

function readRows(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return normalizeRows(parsed);
}

function replaceSnapshot(rows, source = "memory") {
  const normalized = normalizeRows(rows);
  snapshotRows = normalized;
  snapshotByUplayId.clear();
  for (const row of normalized) {
    snapshotByUplayId.set(String(row.uplay_id).trim(), row);
  }
  snapshotSource = source;
  snapshotVersion += 1;
  return {
    ok: true,
    source: snapshotSource,
    entries: snapshotByUplayId.size,
    version: snapshotVersion,
  };
}

function configure(options = {}) {
  const nextRuntimePath = String(options.runtimePath || "").trim();
  const nextAssetPath = String(options.assetPath || "").trim();
  if (nextRuntimePath) runtimePath = path.resolve(nextRuntimePath);
  if (nextAssetPath) assetPath = path.resolve(nextAssetPath);
  return { runtimePath, assetPath };
}

function reloadSnapshot(options = {}) {
  const preserveLastValid = options.preserveLastValid !== false;
  const candidates = [
    { filePath: runtimePath, source: "runtime" },
    { filePath: assetPath, source: "asset" },
  ];
  let lastError = null;
  for (const candidate of candidates) {
    if (!candidate.filePath || !fs.existsSync(candidate.filePath)) continue;
    try {
      const rows = readRows(candidate.filePath);
      if (rows) return replaceSnapshot(rows, candidate.source);
    } catch (error) {
      lastError = error;
      if (candidate.source === "runtime" && preserveLastValid && snapshotVersion > 0) {
        return {
          ok: false,
          preserved: true,
          source: snapshotSource,
          entries: snapshotByUplayId.size,
          version: snapshotVersion,
          error,
        };
      }
    }
  }
  if (preserveLastValid && snapshotVersion > 0) {
    return {
      ok: false,
      preserved: true,
      source: snapshotSource,
      entries: snapshotByUplayId.size,
      version: snapshotVersion,
      error: lastError,
    };
  }
  return replaceSnapshot([], "empty");
}

function trackRefresh(refreshWork) {
  const generation = ++refreshGeneration;
  const tracked = Promise.resolve(refreshWork)
    .then((refreshResult) => {
      const snapshotResult = reloadSnapshot({ preserveLastValid: true });
      return { ...snapshotResult, refreshResult, generation };
    })
    .catch((error) => {
      const snapshotResult = reloadSnapshot({ preserveLastValid: true });
      return {
        ...snapshotResult,
        ok: false,
        refreshError: error,
        generation,
      };
    });
  readyPromise = tracked;
  return tracked;
}

function waitUntilReady() {
  return readyPromise;
}

function lookup(uplayId) {
  const id = String(uplayId || "").trim();
  return id ? snapshotByUplayId.get(id) || null : null;
}

function getMap() {
  return snapshotByUplayId;
}

function getRows() {
  return snapshotRows.slice();
}

function getStatus() {
  return {
    source: snapshotSource,
    entries: snapshotByUplayId.size,
    version: snapshotVersion,
    refreshGeneration,
  };
}

function resetForTests() {
  runtimePath = "";
  assetPath = defaultAssetPath;
  snapshotRows = [];
  snapshotByUplayId.clear();
  snapshotSource = "none";
  snapshotVersion = 0;
  refreshGeneration = 0;
  readyPromise = Promise.resolve({
    ok: true,
    source: snapshotSource,
    entries: 0,
    version: snapshotVersion,
  });
}

module.exports = {
  configure,
  getMap,
  getRows,
  getStatus,
  lookup,
  reloadSnapshot,
  replaceSnapshot,
  resetForTests,
  trackRefresh,
  waitUntilReady,
};
