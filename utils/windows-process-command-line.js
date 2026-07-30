"use strict";

const {
  readCommandLines,
} = require("./windows-process-native-provider");

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_PIDS = 64;

function normalizeProcessIds(values, maxPids = DEFAULT_MAX_PIDS) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).slice(0, Math.max(1, Number(maxPids) || DEFAULT_MAX_PIDS));
}

function readWindowsProcessCommandLines(processIds, options = {}) {
  if (process.platform !== "win32") return Promise.resolve(new Map());
  const maxPids = Math.max(
    1,
    Number(options.maxPids) || DEFAULT_MAX_PIDS,
  );
  const pids = normalizeProcessIds(processIds, maxPids);
  if (!pids.length) return Promise.resolve(new Map());
  return readCommandLines(pids, {
    timeoutMs: Math.max(
      250,
      Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
    ),
    maxPids,
  });
}

module.exports = {
  readWindowsProcessCommandLines,
  normalizeProcessIds,
};
