// utils/playtime-store.js
const path = require("path");
const fs = require("fs");
const { preferencesPath } = require("./paths");
const {
  readJsonWithBackupSync,
  writeJsonAtomicSync,
  writeJsonAtomic,
} = require("./atomic-json-store");

const STORE_PATH = path.join(
  path.dirname(preferencesPath),
  "playtime-totals.json"
);

// All runtime updates share one queue, including manual corrections. Each job
// reads after its predecessor committed, so two games cannot overwrite totals.
let writeTail = Promise.resolve();
let pendingWrites = 0;
function enqueueWrite(operation) {
  pendingWrites++;
  const result = writeTail.then(operation);
  writeTail = result.then(() => { pendingWrites--; }, () => { pendingWrites--; });
  return result;
}
function hasPendingPlaytimeWrites() { return pendingWrites > 0; }
async function waitForPlaytimeWrites() {
  while (pendingWrites) await writeTail;
}
async function readStoreAsync() {
  for (const file of [STORE_PATH, `${STORE_PATH}.bak`]) {
    try {
      const value = JSON.parse(await fs.promises.readFile(file, "utf8"));
      if (value && typeof value === "object") return value;
    } catch {}
  }
  return {};
}

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
  // Quit flush is synchronous only after the runtime queue has drained.
  if (pendingWrites) throw new Error("Playtime writes are still pending");
  writeJsonAtomicSync(STORE_PATH, data, { backup: true });
}

function accumulatePlaytimeAsync(configName, millis, updatedAt = Date.now()) {
  return enqueueWrite(async () => {
    const key = sanitizeKey(configName), store = await readStoreAsync();
    // Compute the delta inside the queue: an earlier manual correction may
    // have rebased the session while this update was waiting for disk access.
    const delta = typeof millis === "function" ? millis() : millis;
    const current = Number(store[key]?.totalMs) || 0;
    if (!Number.isFinite(delta) || delta <= 0) return current;
    const totalMs = current + delta;
    Object.defineProperty(store, key, { value: { totalMs, updatedAt }, enumerable: true, configurable: true, writable: true });
    await writeJsonAtomic(STORE_PATH, store, { backup: true });
    return totalMs;
  });
}

function setPlaytimeTotalAsync(configName, totalMs, onCommitted) {
  if (!Number.isSafeInteger(totalMs) || totalMs < 0) return Promise.reject(new Error("Invalid playtime total"));
  return enqueueWrite(async () => {
    const key = sanitizeKey(configName), store = await readStoreAsync();
    const previous = Object.hasOwn(store, key) ? store[key] : {};
    const updatedAt = Number(previous?.updatedAt) || 0;
    Object.defineProperty(store, key, { value: { ...previous, totalMs, updatedAt }, enumerable: true, configurable: true, writable: true });
    await writeJsonAtomic(STORE_PATH, store, { backup: true });
    onCommitted?.();
    return { totalMs, updatedAt };
  });
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
function getPlaytimeTotalsSnapshot() {
  return Object.fromEntries(Object.entries(readStore()).map(([name, entry]) => [name, {
    totalMs: Number(entry?.totalMs) || 0,
    updatedAt: Number(entry?.updatedAt) || 0,
  }]));
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
  accumulatePlaytimeAsync,
  getPlaytimeTotal,
  getPlaytimeInfo,
  getPlaytimeTotalsSnapshot,
  getLastPlayedSnapshot,
  setPlaytimeTotal,
  setPlaytimeTotalAsync,
  hasPendingPlaytimeWrites,
  waitForPlaytimeWrites,
  sanitizeConfigName: sanitizeKey,
};
