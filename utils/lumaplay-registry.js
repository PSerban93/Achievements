const path = require("path");
const { spawnSync } = require("child_process");
const { getNameIndexFromConfigPath } = require("./achievement-data");
const {
  subscribeLumaPlayRegistryEvents,
} = require("./lumaplay-event-watcher");

const LUMAPLAY_ROOT_KEY = "HKCU\\SOFTWARE\\LumaPlay";
const LUMAPLAY_SHARED_READ_CACHE_TTL_MS = Math.max(
  250,
  Number(process.env.LUMAPLAY_SHARED_READ_CACHE_TTL_MS) || 1200,
);
const lumaPlayResolvedQueryCache = new Map();

function runRegQuery(args = []) {
  if (process.platform !== "win32") {
    return { ok: false, stdout: "", stderr: "unsupported-platform", code: -1 };
  }
  const regExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "reg.exe")
    : "reg.exe";
  let result;
  try {
    result = spawnSync(regExe, ["query", ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err?.message || String(err),
      code: -1,
    };
  }
  const code = typeof result.status === "number" ? result.status : -1;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    ok: code === 0,
    stdout,
    stderr,
    code,
  };
}

function normalizeLumaPlayKeyPath(value) {
  return String(value || "")
    .trim()
    .replace(/^HKEY_CURRENT_USER\\/i, "HKCU\\")
    .replace(/[\\/]+/g, "\\");
}

function extractLumaPlayUserFromKeyPath(keyPath) {
  const normalized = normalizeLumaPlayKeyPath(keyPath);
  const match = normalized.match(/^HKCU\\SOFTWARE\\LumaPlay\\([^\\]+)\\/i);
  return match && match[1] ? String(match[1]).trim() : "";
}

function getLumaPlayReadCache(cache) {
  return cache &&
    typeof cache.get === "function" &&
    typeof cache.set === "function"
    ? cache
    : null;
}

function unwrapLumaPlayReadCacheRecord(record) {
  if (record?.value?.query?.ok) {
    return {
      value: record.value,
      at: Number(record.at) || 0,
    };
  }
  if (record?.query?.ok) {
    return {
      value: record,
      at: 0,
    };
  }
  return null;
}

function buildLumaPlayReadCacheKeys({
  appid = "",
  preferredUser = "",
  preferredKeyPath = "",
} = {}) {
  const id = String(appid || "").trim().toLowerCase();
  const user = String(preferredUser || "").trim().toLowerCase();
  const keyPath = normalizeLumaPlayKeyPath(preferredKeyPath).toLowerCase();
  const keys = [];
  if (keyPath) keys.push(`path:${keyPath}`);
  if (id) {
    keys.push(`app:${id}:${user}`);
    keys.push(`app:${id}:`);
  }
  return Array.from(new Set(keys));
}

function readLumaPlayResolvedFromCache(cache, keys = []) {
  const targets = [];
  const target = getLumaPlayReadCache(cache);
  if (target) {
    targets.push({ cache: target, enforceTtl: false });
  }
  if (lumaPlayResolvedQueryCache !== target) {
    targets.push({ cache: lumaPlayResolvedQueryCache, enforceTtl: true });
  }
  const now = Date.now();
  for (const { cache: cacheTarget, enforceTtl } of targets) {
    if (!cacheTarget) continue;
    for (const key of keys) {
      if (!key) continue;
      const raw = cacheTarget.get(key);
      const record = unwrapLumaPlayReadCacheRecord(raw);
      if (!record?.value?.query?.ok) {
        if (raw !== undefined) {
          try {
            cacheTarget.delete(key);
          } catch {}
        }
        continue;
      }
      if (
        enforceTtl &&
        record.at > 0 &&
        now - record.at > LUMAPLAY_SHARED_READ_CACHE_TTL_MS
      ) {
        try {
          cacheTarget.delete(key);
        } catch {}
        continue;
      }
      return record.value;
    }
  }
  return null;
}

function primeLumaPlayReadCache(cache, resolved, hints = {}) {
  if (!resolved?.query?.ok) return resolved;
  const target = getLumaPlayReadCache(cache);
  const keys = buildLumaPlayReadCacheKeys({
    appid: resolved.appid || hints.appid || "",
    preferredUser: resolved.user || hints.preferredUser || "",
    preferredKeyPath: resolved.keyPath || hints.preferredKeyPath || "",
  });
  const record = {
    value: resolved,
    at: Date.now(),
  };
  for (const key of keys) {
    if (!key) continue;
    if (target) {
      target.set(key, record);
    }
    if (lumaPlayResolvedQueryCache !== target) {
      lumaPlayResolvedQueryCache.set(key, record);
    }
  }
  return resolved;
}

function clearLumaPlayReadCache() {
  lumaPlayResolvedQueryCache.clear();
}

function resolveLumaPlayAchievementsQuery(options = {}) {
  const appid = String(options.appid || "").trim();
  const preferredUser = String(options.preferredUser || "").trim();
  const preferredKeyPath = normalizeLumaPlayKeyPath(
    options.preferredKeyPath || options.keyPath || "",
  );
  const readCache = getLumaPlayReadCache(options.readCache || options.cache);
  const cacheKeys = buildLumaPlayReadCacheKeys({
    appid,
    preferredUser,
    preferredKeyPath,
  });
  const cached = readLumaPlayResolvedFromCache(readCache, cacheKeys);
  if (cached?.query?.ok) {
    return cached;
  }
  if (preferredKeyPath) {
    const query = runRegQuery([preferredKeyPath]);
    if (query.ok) {
      return primeLumaPlayReadCache(
        readCache,
        {
          appid,
          user: extractLumaPlayUserFromKeyPath(preferredKeyPath) || preferredUser,
          keyPath: preferredKeyPath,
          query,
        },
        {
          appid,
          preferredUser,
          preferredKeyPath,
        },
      );
    }
  }
  const resolved = resolveLumaPlayAchievementsKey(appid, preferredUser);
  if (!resolved?.query?.ok) return resolved;
  return primeLumaPlayReadCache(readCache, resolved, {
    appid,
    preferredUser,
    preferredKeyPath,
  });
}

function startLumaPlayRegistryEventWatcher(options = {}) {
  if (process.platform !== "win32") {
    return {
      stop() {},
      isRunning() {
        return false;
      },
    };
  }
  const subscription = subscribeLumaPlayRegistryEvents({
    restartDelayMs: options.restartDelayMs,
    onReady: options.onReady,
    onWarn: options.onWarn,
    onChange: options.onChange,
    onStatus: options.onStatus,
    onLifecycle: options.onLifecycle,
  });
  return {
    stop() {
      try {
        subscription.stop();
      } catch {}
    },
    isRunning() {
      try {
        return subscription.isRunning();
      } catch {
        return false;
      }
    },
  };
}

function normalizeNameKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u2026/g, "...")
    .replace(/\s/g, " ")
    .trim()
    .toLowerCase();
}

function parseNumericRegistryValue(type, rawValue) {
  const kind = String(type || "").toUpperCase();
  if (!kind.includes("DWORD") && !kind.includes("QWORD")) return null;
  const token = String(rawValue || "")
    .trim()
    .split(/\s+/)[0];
  if (!token) return null;
  if (/^0x[0-9a-f]+$/i.test(token)) {
    const parsed = Number.parseInt(token.slice(2), 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/^-?\d+$/.test(token)) {
    const parsed = Number.parseInt(token, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBooleanRegistryValue(type, rawValue) {
  const numeric = parseNumericRegistryValue(type, rawValue);
  if (numeric !== null) return numeric > 0;
  const text = String(rawValue || "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text === "true" ||
    text === "yes" ||
    text === "unlocked" ||
    text === "earned" ||
    text === "1"
  );
}

function parseRegistryValueLines(output) {
  const values = [];
  const lines = String(output || "").split(/\r?\n/);
  const valueLinePattern = /^\s{2,}(.+?)\s{2,}(REG_[A-Z0-9_]+)\s{2,}(.*)$/i;
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const match = line.match(valueLinePattern);
    if (!match) continue;
    const name = String(match[1] || "").trim();
    if (!name || /^\(default\)$/i.test(name)) continue;
    const type = String(match[2] || "").trim().toUpperCase();
    const raw = String(match[3] || "").trim();
    values.push({
      name,
      type,
      raw,
      earned: parseBooleanRegistryValue(type, raw),
    });
  }
  return values;
}

function listLumaPlayUsers() {
  const query = runRegQuery([LUMAPLAY_ROOT_KEY]);
  if (!query.ok) return [];
  const users = new Set();
  const lines = String(query.stdout || "").split(/\r?\n/);
  const userPattern = /^HKEY_CURRENT_USER\\SOFTWARE\\LumaPlay\\([^\\]+)$/i;
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const match = line.match(userPattern);
    if (!match || !match[1]) continue;
    users.add(String(match[1]).trim());
  }
  return Array.from(users);
}

function listLumaPlayAppIdsForUser(user) {
  const userName = String(user || "").trim();
  if (!userName) return [];
  const query = runRegQuery([`${LUMAPLAY_ROOT_KEY}\\${userName}`]);
  if (!query.ok) return [];
  const out = new Set();
  const escapedUser = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const appPattern = new RegExp(
    `^HKEY_CURRENT_USER\\\\SOFTWARE\\\\LumaPlay\\\\${escapedUser}\\\\([^\\\\]+)$`,
    "i",
  );
  const lines = String(query.stdout || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const match = line.match(appPattern);
    if (!match || !match[1]) continue;
    const appid = String(match[1]).trim();
    if (!/^[0-9a-fA-F]+$/.test(appid)) continue;
    out.add(appid);
  }
  return Array.from(out);
}

function resolveLumaPlayAchievementsKey(appid, preferredUser = "") {
  const id = String(appid || "").trim();
  if (!id || !/^[0-9a-fA-F]+$/.test(id)) return null;
  const candidates = [];
  const pref = String(preferredUser || "").trim();
  if (pref) candidates.push(pref);
  for (const user of listLumaPlayUsers()) {
    if (!candidates.includes(user)) candidates.push(user);
  }
  for (const user of candidates) {
    const keyPath = `${LUMAPLAY_ROOT_KEY}\\${user}\\${id}\\Achievements`;
    const query = runRegQuery([keyPath]);
    if (!query.ok) continue;
    return {
      appid: id,
      user,
      keyPath,
      query,
    };
  }
  return null;
}

function getNameCandidates(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) return [];
  const out = [raw];
  const stripped = raw.replace(/^ach_/i, "");
  if (stripped && stripped !== raw) out.push(stripped);
  const maybeNumeric = stripped.match(/^(.*)_(\d+)$/);
  if (
    maybeNumeric &&
    maybeNumeric[1] &&
    maybeNumeric[2] &&
    /[a-z]/i.test(maybeNumeric[1])
  ) {
    out.push(maybeNumeric[2]);
  }
  return Array.from(new Set(out));
}

function resolveCanonicalName(rawName, nameIndex) {
  const candidates = getNameCandidates(rawName);
  for (const candidate of candidates) {
    const key = normalizeNameKey(candidate);
    const byNameHit =
      nameIndex?.byName && typeof nameIndex.byName.get === "function"
        ? nameIndex.byName.get(key)
        : null;
    if (byNameHit) return byNameHit;
    const byDisplayHit =
      nameIndex?.byDisp && typeof nameIndex.byDisp.get === "function"
        ? nameIndex.byDisp.get(key)
        : null;
    if (byDisplayHit) return byDisplayHit;
  }
  return candidates[candidates.length - 1] || "";
}

function readLumaPlayAchievementsSnapshot(options = {}) {
  const appid = String(options.appid || "").trim();
  const configPath =
    typeof options.configPath === "string" ? options.configPath : "";
  const previousSnapshot =
    options.previousSnapshot && typeof options.previousSnapshot === "object"
      ? options.previousSnapshot
      : {};
  const preferredUser =
    typeof options.preferredUser === "string" ? options.preferredUser : "";
  const preferredKeyPath =
    typeof options.preferredKeyPath === "string"
      ? options.preferredKeyPath
      : typeof options.keyPath === "string"
        ? options.keyPath
        : "";
  const resolved =
    options.resolvedQuery?.query?.ok === true
      ? primeLumaPlayReadCache(
          options.readCache || options.cache,
          options.resolvedQuery,
          {
            appid,
            preferredUser,
            preferredKeyPath,
          },
        )
      : resolveLumaPlayAchievementsQuery({
          appid,
          preferredUser,
          preferredKeyPath,
          readCache: options.readCache || options.cache,
        });
  if (!resolved?.query?.ok) {
    return {
      found: false,
      appid,
      user: "",
      keyPath: "",
      snapshot: {},
    };
  }

  const nameIndex = getNameIndexFromConfigPath(configPath, null, appid);
  const values = parseRegistryValueLines(resolved.query.stdout);
  const snapshot = {};
  for (const entry of values) {
    const canonical = resolveCanonicalName(entry.name, nameIndex);
    if (!canonical) continue;
    const prevEntry =
      previousSnapshot && typeof previousSnapshot === "object"
        ? previousSnapshot[canonical]
        : null;
    const prevEarned = prevEntry?.earned === true || prevEntry?.earned === 1;
    const prevTime = Number(prevEntry?.earned_time) || 0;
    const earned = entry.earned === true;
    snapshot[canonical] = {
      earned,
      earned_time: earned && prevEarned && prevTime > 0 ? prevTime : 0,
    };
  }

  return {
    found: true,
    appid,
    user: resolved.user || "",
    keyPath: resolved.keyPath || "",
    snapshot,
  };
}

function scanLumaPlayRegistryEntries(options = {}) {
  if (process.platform !== "win32") return [];
  const readCache = getLumaPlayReadCache(options.cache);
  const byAppId = new Map();
  const users = listLumaPlayUsers();
  for (const user of users) {
    const appids = listLumaPlayAppIdsForUser(user);
    for (const appid of appids) {
      if (byAppId.has(appid)) continue;
      const keyPath = `${LUMAPLAY_ROOT_KEY}\\${user}\\${appid}\\Achievements`;
      const query = runRegQuery([keyPath]);
      if (!query.ok) continue;
      const resolved = {
        appid,
        user,
        keyPath,
        query,
      };
      primeLumaPlayReadCache(readCache, resolved, {
        appid,
        preferredUser: user,
        preferredKeyPath: keyPath,
      });
      byAppId.set(appid, resolved);
    }
  }
  return Array.from(byAppId.values());
}

module.exports = {
  LUMAPLAY_ROOT_KEY,
  clearLumaPlayReadCache,
  listLumaPlayUsers,
  listLumaPlayAppIdsForUser,
  resolveLumaPlayAchievementsKey,
  readLumaPlayAchievementsSnapshot,
  scanLumaPlayRegistryEntries,
  startLumaPlayRegistryEventWatcher,
};
