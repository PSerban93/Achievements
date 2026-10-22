// utils/playtime-store.js
const path = require("path");
const { preferencesPath } = require("./paths");
const {
  readJsonWithBackupSync,
  writeJsonAtomicSync,
} = require("./atomic-json-store");

const STORE_PATH = path.join(
  path.dirname(preferencesPath),
  "playtime-totals.json"
);

function sanitizeKey(raw) {
  const s = String(raw || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const base = s || "config";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)
    ? `_${base}`
    : base;
}

function readStore() {
  const result = readJsonWithBackupSync(STORE_PATH, {
    backup: true,
    fallback: {},
  });
  return result.value && typeof result.value === "object" ? result.value : {};
}

function writeStore(data) {
  writeJsonAtomicSync(STORE_PATH, data, { backup: true });
}

function accumulatePlaytime(configName, millis) {
  const key = sanitizeKey(configName);
  if (!Number.isFinite(millis) || millis <= 0)
    return readStore()[key]?.totalMs || 0;

  const store = readStore();
  const current = Number(store[key]?.totalMs) || 0;
  const totalMs = current + millis;

  store[key] = {
    totalMs,
    updatedAt: Date.now(),
  };
  writeStore(store);
  return totalMs;
}

function getPlaytimeTotal(configName) {
  const info = getPlaytimeInfo(configName);
  return info.totalMs;
}

function getPlaytimeInfo(configName) {
  const key = sanitizeKey(configName);
  const store = readStore();
  const entry = store[key] || {};
  return {
    totalMs: Number(entry.totalMs) || 0,
    updatedAt: Number(entry.updatedAt) || 0,
  };
}

function getLastPlayedSnapshot() {
  return Object.fromEntries(Object.entries(readStore()).map(([name, entry]) => {
    const timestamp = Number(entry?.updatedAt);
    return [name, Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0];
  }));
}

function setPlaytimeTotal(configName, totalMs) {
  if (!Number.isSafeInteger(totalMs) || totalMs < 0) throw new Error("Invalid playtime total");
  const key = sanitizeKey(configName), store = readStore();
  const previous = Object.hasOwn(store, key) ? store[key] : {};
  // A correction is not a new play session: retain the Last Played timestamp.
  const updatedAt = Number(previous?.updatedAt) || 0;
  Object.defineProperty(store, key, { value: { ...previous, totalMs, updatedAt }, enumerable: true, configurable: true, writable: true });
  writeStore(store);
  return { totalMs, updatedAt };
}

module.exports = {
  accumulatePlaytime,
  getPlaytimeTotal,
  getPlaytimeInfo,
  getLastPlayedSnapshot,
  setPlaytimeTotal,
  sanitizeConfigName: sanitizeKey,
};
