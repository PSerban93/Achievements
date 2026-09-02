"use strict";

const fs = require("fs");
const path = require("path");

const { writeJsonAtomic } = require("./atomic-json-store");

const DASHBOARD_SUMMARY_VERSION = 2;
const DEFAULT_WRITE_DELAY_MS = 300;

function clampNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeFingerprintPart(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const filePath = String(raw.path || "").trim().slice(0, 32768);
  const mtimeMs = clampNumber(raw.mtimeMs, 0, Number.MAX_SAFE_INTEGER);
  const size = Math.floor(clampNumber(raw.size, 0, Number.MAX_SAFE_INTEGER));
  if (!filePath) return null;
  return { path: filePath, mtimeMs, size };
}

function normalizeFingerprint(raw = null) {
  if (!raw || typeof raw !== "object") return null;
  const config = normalizeFingerprintPart(raw.config);
  const schema = normalizeFingerprintPart(raw.schema);
  const cache = normalizeFingerprintPart(raw.cache);
  if (!config || !schema) return null;
  return { config, schema, cache };
}

function normalizeDashboardSummaryEntry(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const total = Math.floor(clampNumber(raw.total, 0, Number.MAX_SAFE_INTEGER));
  const unlocked = Math.floor(
    clampNumber(raw.unlocked, 0, total > 0 ? total : Number.MAX_SAFE_INTEGER),
  );
  const pct = clampNumber(
    raw.pct,
    0,
    100,
    total > 0 ? Math.round((unlocked / total) * 100) : 0,
  );
  const updated = Math.floor(
    clampNumber(raw.updated, 0, Number.MAX_SAFE_INTEGER),
  );
  const observedAt = Math.floor(
    clampNumber(raw.observedAt, 0, Number.MAX_SAFE_INTEGER),
  );
  const platform = String(raw.platform || "").trim().slice(0, 64);
  const appid = String(raw.appid || "").trim().slice(0, 256);
  const source = String(raw.source || "dashboard-compute")
    .trim()
    .slice(0, 64);

  const entry = {
    platform: platform || null,
    appid: appid || null,
    pct,
    unlocked,
    total,
    updated,
    observedAt,
    verified: raw.verified === true,
    source: source || "dashboard-compute",
  };
  const fingerprint = normalizeFingerprint(raw.fingerprint);
  if (fingerprint) entry.fingerprint = fingerprint;
  if (typeof raw.platinum === "boolean") entry.platinum = raw.platinum;
  if (Object.prototype.hasOwnProperty.call(raw, "nativePlatinum")) {
    entry.nativePlatinum = raw.nativePlatinum === true;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "platinumSynced")) {
    entry.platinumSynced = raw.platinumSynced === true;
  }
  const platinumBasis = (() => {
    if (!raw.platinumBasis || typeof raw.platinumBasis !== "object") return null;
    const basisTotal = Math.floor(
      clampNumber(raw.platinumBasis.total, 0, Number.MAX_SAFE_INTEGER),
    );
    if (basisTotal <= 0) return null;
    return {
      unlocked: Math.floor(
        clampNumber(raw.platinumBasis.unlocked, 0, basisTotal),
      ),
      total: basisTotal,
    };
  })();
  if (platinumBasis) entry.platinumBasis = platinumBasis;
  const platinumConfigFingerprint = normalizeFingerprintPart(
    raw.platinumConfigFingerprint,
  );
  if (platinumConfigFingerprint) {
    entry.platinumConfigFingerprint = platinumConfigFingerprint;
  }
  if (Object.prototype.hasOwnProperty.call(raw, "platinumCompletedTotal")) {
    entry.platinumCompletedTotal = Math.floor(
      clampNumber(raw.platinumCompletedTotal, 0, Number.MAX_SAFE_INTEGER),
    );
  }
  if (Object.prototype.hasOwnProperty.call(raw, "platinumSyncedAt")) {
    entry.platinumSyncedAt = Math.floor(
      clampNumber(raw.platinumSyncedAt, 0, Number.MAX_SAFE_INTEGER),
    );
  }
  return entry;
}

const PLATINUM_METADATA_KEYS = [
  "platinum",
  "nativePlatinum",
  "platinumSynced",
  "platinumBasis",
  "platinumConfigFingerprint",
  "platinumCompletedTotal",
  "platinumSyncedAt",
];

function preservePlatinumMetadata(current, incoming) {
  if (!current || !incoming) return incoming;
  const next = { ...incoming };
  for (const key of PLATINUM_METADATA_KEYS) {
    if (
      !Object.prototype.hasOwnProperty.call(next, key) &&
      Object.prototype.hasOwnProperty.call(current, key)
    ) {
      next[key] = current[key];
    }
  }
  return next;
}

function normalizeDashboardConfigName(raw) {
  const name = String(raw ?? "").trim();
  if (!name || name === "." || name === ".." || name.length > 260) return "";
  if (name !== path.basename(name)) return "";
  if (/[\/\\:*?"<>|\u0000-\u001f]/.test(name)) return "";
  return name;
}

function getSummarySourcePriority(source) {
  switch (String(source || "")) {
    case "achievement-cache":
      return 3;
    case "dashboard-compute":
      return 2;
    case "localStorage-migration":
      return 1;
    default:
      return 0;
  }
}

function normalizeEntries(rawEntries = {}) {
  const out = new Map();
  if (!rawEntries || typeof rawEntries !== "object") return out;

  const sourceEntries = Array.isArray(rawEntries)
    ? rawEntries.map((entry) => [entry?.name, entry])
    : Object.entries(rawEntries);

  for (const [rawName, rawEntry] of sourceEntries) {
    const name = normalizeDashboardConfigName(rawName);
    if (!name) continue;
    const entry = normalizeDashboardSummaryEntry(rawEntry);
    if (!entry) continue;
    out.set(name, entry);
  }
  return out;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch (error) {
    return { __readError: error };
  }
}

function createDashboardSummaryStore(options = {}) {
  const rawFilePath = String(options.filePath || "").trim();
  if (!rawFilePath) {
    throw new TypeError("A dashboard summary path is required.");
  }
  const filePath = path.resolve(rawFilePath);

  const backupPath = String(options.backupPath || `${filePath}.bak`);
  const writeDelayMs = Math.max(
    0,
    Number(options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS) || 0,
  );
  const logger = options.logger || null;
  const entries = new Map();
  const removalTombstones = new Map();
  let initialized = false;
  let initializePromise = null;
  let dirty = false;
  let writeTimer = null;
  let writePromise = Promise.resolve();
  let updatedAt = 0;
  let loadSource = "empty";

  const log = (level, message, meta = undefined) => {
    try {
      logger?.[level]?.(message, meta);
    } catch {}
  };

  const serialize = () => ({
    version: DASHBOARD_SUMMARY_VERSION,
    updatedAt: updatedAt || Date.now(),
    entries: Object.fromEntries(entries),
  });

  const applyDocument = (document) => {
    const normalized = normalizeEntries(document?.entries || document);
    entries.clear();
    for (const [name, entry] of normalized) entries.set(name, entry);
    updatedAt = Math.floor(
      clampNumber(document?.updatedAt, 0, Number.MAX_SAFE_INTEGER),
    );
  };

  const initialize = async () => {
    if (initialized) return;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      let primary = null;
      if (fs.existsSync(filePath)) primary = await readJsonFile(filePath);
      if (primary && !primary.__readError) {
        applyDocument(primary);
        loadSource = "primary";
        if (Number(primary.version) !== DASHBOARD_SUMMARY_VERSION) {
          dirty = true;
        }
      } else {
        let backup = null;
        if (fs.existsSync(backupPath)) backup = await readJsonFile(backupPath);
        if (backup && !backup.__readError) {
          applyDocument(backup);
          loadSource = "backup";
          dirty = true;
          log("warn", "dashboard-summary:recovered-from-backup", {
            filePath,
            primaryError: primary?.__readError?.message || null,
          });
        } else {
          loadSource = "empty";
          if (primary?.__readError || backup?.__readError) {
            log("warn", "dashboard-summary:read-failed", {
              filePath,
              primaryError: primary?.__readError?.message || null,
              backupError: backup?.__readError?.message || null,
            });
          }
        }
      }
      initialized = true;
      if (dirty) scheduleWrite();
      log("info", "dashboard-summary:loaded", {
        source: loadSource,
        entries: entries.size,
      });
    })().finally(() => {
      initializePromise = null;
    });
    return initializePromise;
  };

  const flush = async () => {
    await initialize();
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (!dirty) return false;
    dirty = false;
    const payload = serialize();
    writePromise = writePromise.then(async () => {
      try {
        await writeJsonAtomic(filePath, payload, {
          backup: true,
          trailingNewline: true,
        });
        log("info", "dashboard-summary:saved", {
          entries: Object.keys(payload.entries).length,
        });
        return true;
      } catch (error) {
        dirty = true;
        log("warn", "dashboard-summary:save-failed", {
          error: error?.message || String(error),
        });
        return false;
      }
    });
    const result = await writePromise;
    if (dirty && !writeTimer) scheduleWrite();
    return result;
  };

  function scheduleWrite() {
    // Reconcile and renderer hydration arrive in waves. A trailing debounce
    // lets the whole wave share one atomic replacement of the summary file.
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      flush().catch(() => {});
    }, writeDelayMs);
    writeTimer.unref?.();
  }

  const markDirty = () => {
    dirty = true;
    updatedAt = Date.now();
    scheduleWrite();
  };

  const getSnapshot = async () => {
    await initialize();
    return { ...serialize(), source: loadSource };
  };

  const getEntry = async (name) => {
    await initialize();
    const entry = entries.get(String(name || "").trim());
    return entry ? JSON.parse(JSON.stringify(entry)) : null;
  };

  const bootstrap = async (rawEntries, options = {}) => {
    await initialize();
    const allowedNames =
      options.allowedNames instanceof Set ? options.allowedNames : null;
    const incoming = normalizeEntries(rawEntries);
    const changed = {};
    for (const [name, rawEntry] of incoming) {
      if (allowedNames && !allowedNames.has(name)) continue;
      const current = entries.get(name);
      if (current?.verified === true) continue;
      const entry = {
        ...rawEntry,
        verified: false,
        source: "localStorage-migration",
      };
      if (JSON.stringify(current) === JSON.stringify(entry)) continue;
      entries.set(name, entry);
      changed[name] = entry;
    }
    if (Object.keys(changed).length) markDirty();
    return changed;
  };

  const upsertMany = async (rawEntries, options = {}) => {
    await initialize();
    const allowedNames =
      options.allowedNames instanceof Set ? options.allowedNames : null;
    const incoming = normalizeEntries(rawEntries);
    const changed = {};
    for (const [name, entry] of incoming) {
      if (allowedNames && !allowedNames.has(name)) continue;
      const removedAt = Number(removalTombstones.get(name)) || 0;
      const incomingObservedAt = Number(entry.observedAt) || 0;
      if (removedAt > 0 && incomingObservedAt <= removedAt) continue;
      const current = entries.get(name);
      if (current?.verified === true && entry.verified !== true) continue;
      if (current && entry.verified === true) {
        const currentObservedAt = Number(current.observedAt) || 0;
        const incomingObservedAt = Number(entry.observedAt) || 0;
        // A newer renderer calculation must not downgrade an authoritative
        // cache entry. Explicit invalidation sets `verified` to false and is
        // the only path that permits a lower-priority replacement.
        if (
          current.verified === true &&
          getSummarySourcePriority(entry.source) <
            getSummarySourcePriority(current.source)
        ) {
          continue;
        }
        if (
          currentObservedAt > 0 &&
          incomingObservedAt < currentObservedAt
        ) {
          continue;
        }
        if (
          incomingObservedAt === currentObservedAt &&
          getSummarySourcePriority(entry.source) <
            getSummarySourcePriority(current.source)
        ) {
          continue;
        }
      }
      const withPlatinumMetadata = preservePlatinumMetadata(current, entry);
      const nextEntry =
        current?.fingerprint && !entry.fingerprint
          ? { ...withPlatinumMetadata, fingerprint: current.fingerprint }
          : withPlatinumMetadata;
      if (JSON.stringify(current) === JSON.stringify(nextEntry)) continue;
      entries.set(name, nextEntry);
      removalTombstones.delete(name);
      changed[name] = nextEntry;
    }
    if (Object.keys(changed).length) markDirty();
    return changed;
  };

  const remove = async (name) => {
    await initialize();
    const safeName = normalizeDashboardConfigName(name);
    if (!safeName) return false;
    removalTombstones.set(safeName, Date.now());
    if (!entries.delete(safeName)) return false;
    markDirty();
    return true;
  };

  const invalidate = async (name, source = "invalidated") => {
    await initialize();
    const safeName = normalizeDashboardConfigName(name);
    const current = entries.get(safeName);
    if (!safeName || !current || current.verified !== true) return null;
    const next = {
      ...current,
      verified: false,
      platinumSynced: false,
      source: String(source || "invalidated").slice(0, 64),
      observedAt: Date.now(),
    };
    entries.set(safeName, next);
    markDirty();
    return next;
  };

  const updatePlatinumState = async (name, state = {}) => {
    await initialize();
    const safeName = normalizeDashboardConfigName(name);
    const current = entries.get(safeName);
    if (!safeName || !current || current.verified !== true) return null;
    if (typeof state.platinum !== "boolean") return null;

    const expectedObservedAt = Math.max(
      0,
      Number(state.expectedObservedAt) || 0,
    );
    if (
      expectedObservedAt > 0 &&
      Number(current.observedAt || 0) !== expectedObservedAt
    ) {
      return null;
    }

    const basisTotal = Math.floor(
      clampNumber(state?.basis?.total, 0, Number.MAX_SAFE_INTEGER),
    );
    const basisUnlocked = Math.floor(
      clampNumber(state?.basis?.unlocked, 0, basisTotal || 0),
    );
    if (
      basisTotal <= 0 ||
      basisTotal !== current.total ||
      basisUnlocked !== current.unlocked
    ) {
      return null;
    }

    const configFingerprint = normalizeFingerprintPart(
      state.configFingerprint,
    );
    if (!configFingerprint) return null;

    const next = {
      ...current,
      platinum: state.platinum,
      nativePlatinum: state.nativePlatinum === true,
      platinumSynced: true,
      platinumBasis: {
        unlocked: basisUnlocked,
        total: basisTotal,
      },
      platinumConfigFingerprint: configFingerprint,
      platinumCompletedTotal: Math.floor(
        clampNumber(
          state.platinumCompletedTotal,
          0,
          Number.MAX_SAFE_INTEGER,
        ),
      ),
      platinumSyncedAt: Math.max(0, Number(current.platinumSyncedAt) || 0),
    };
    if (current.fingerprint) {
      next.fingerprint = {
        ...current.fingerprint,
        config: configFingerprint,
      };
    }
    if (JSON.stringify(current) === JSON.stringify(next)) {
      return JSON.parse(JSON.stringify(current));
    }
    next.platinumSyncedAt = Date.now();
    entries.set(safeName, next);
    markDirty();
    return JSON.parse(JSON.stringify(next));
  };

  const removeByPlatform = async (platform) => {
    await initialize();
    const normalizedPlatform = String(platform || "").trim().toLowerCase();
    if (!normalizedPlatform) return [];
    const removed = [];
    for (const [name, entry] of entries) {
      if (
        String(entry?.platform || "")
          .trim()
          .toLowerCase() !== normalizedPlatform
      ) {
        continue;
      }
      entries.delete(name);
      removalTombstones.set(name, Date.now());
      removed.push(name);
    }
    if (removed.length) markDirty();
    return removed;
  };

  const prune = async (allowedNames) => {
    await initialize();
    if (!(allowedNames instanceof Set)) return [];
    const removed = [];
    for (const name of entries.keys()) {
      if (allowedNames.has(name)) continue;
      entries.delete(name);
      removalTombstones.set(name, Date.now());
      removed.push(name);
    }
    if (removed.length) markDirty();
    return removed;
  };

  const hasVerified = async (name) => {
    await initialize();
    return entries.get(String(name || "").trim())?.verified === true;
  };

  const close = async () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    await flush();
    await writePromise;
  };

  return {
    bootstrap,
    close,
    filePath,
    flush,
    getEntry,
    getSnapshot,
    hasVerified,
    initialize,
    invalidate,
    prune,
    remove,
    removeByPlatform,
    updatePlatinumState,
    upsertMany,
  };
}

module.exports = {
  DASHBOARD_SUMMARY_VERSION,
  createDashboardSummaryStore,
  normalizeDashboardConfigName,
  normalizeDashboardSummaryEntry,
};
