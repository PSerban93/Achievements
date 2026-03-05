const path = require("path");
const { spawnSync, spawn } = require("child_process");
const { getNameIndexFromConfigPath } = require("./achievement-data");
const { subscribeLumaPlayRegistryEvents } = require("./process-event-watcher");

const LUMAPLAY_ROOT_KEY = "HKCU\\SOFTWARE\\LumaPlay";

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

function resolvePowerShellPath() {
  if (process.env.SystemRoot) {
    return path.join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  }
  return "powershell.exe";
}

function buildLumaPlayRegistryWatchScript(sourceIdentifier) {
  const source = String(sourceIdentifier || "").trim() || "lumaplay-watch";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$rootPath = \"$sid\\\\Software\\\\LumaPlay\"",
    "$escapedRootPath = $rootPath -replace '\\\\', '\\\\\\\\'",
    `$source = '${source}'`,
    "$query = \"SELECT * FROM RegistryTreeChangeEvent WHERE Hive='HKEY_USERS' AND RootPath='$escapedRootPath'\"",
    "try {",
    "  Register-WmiEvent -Namespace root/default -Query $query -SourceIdentifier $source | Out-Null",
    "  [Console]::WriteLine('__LUMAPLAY_WATCH_READY__')",
    "  while ($true) {",
    "    $event = Wait-Event -SourceIdentifier $source -Timeout 3600",
    "    if ($event) {",
    "      [Console]::WriteLine('__LUMAPLAY_CHANGE__')",
    "      Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue",
    "    }",
    "  }",
    "} catch {",
    "  [Console]::Error.WriteLine(\"__LUMAPLAY_WATCH_ERROR__:$($_.Exception.Message)\")",
    "  exit 1",
    "} finally {",
    "  Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue",
    "  Remove-Event -SourceIdentifier $source -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");
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
  const useUnifiedHost = process.env.ACH_UNIFIED_EVENT_HOST !== "0";
  if (useUnifiedHost) {
    const subscription = subscribeLumaPlayRegistryEvents({
      restartDelayMs: options.restartDelayMs,
      onReady: options.onReady,
      onWarn: options.onWarn,
      onChange: options.onChange,
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
  const onChange =
    typeof options.onChange === "function" ? options.onChange : () => {};
  const onReady =
    typeof options.onReady === "function" ? options.onReady : () => {};
  const onWarn =
    typeof options.onWarn === "function" ? options.onWarn : () => {};
  const restartDelayMs = Math.max(
    500,
    Number(options.restartDelayMs) || 1500,
  );

  const sourceIdentifier = `lumaplay-watch-${process.pid}-${Date.now()}`;
  const script = buildLumaPlayRegistryWatchScript(sourceIdentifier);
  const powershellPath = resolvePowerShellPath();
  let watcherProcess = null;
  let stopped = false;
  let restartTimer = null;
  let launching = false;

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const parseStream = (stream, isError = false) => {
    if (!stream || typeof stream.on !== "function") return;
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += String(chunk || "");
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = String(part || "").trim();
        if (!line) continue;
        if (line === "__LUMAPLAY_WATCH_READY__") {
          onReady();
          continue;
        }
        if (line === "__LUMAPLAY_CHANGE__") {
          onChange();
          continue;
        }
        if (line.startsWith("__LUMAPLAY_WATCH_ERROR__:")) {
          const msg = line.replace("__LUMAPLAY_WATCH_ERROR__:", "").trim();
          onWarn(msg || "LumaPlay registry watcher error");
          continue;
        }
        if (isError) {
          onWarn(line);
        }
      }
    });
  };

  const scheduleRestart = () => {
    if (stopped) return;
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      launch();
    }, restartDelayMs);
  };

  function launch() {
    if (stopped || launching) return;
    launching = true;
    clearRestartTimer();
    try {
      watcherProcess = spawn(
        powershellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      launching = false;
      onWarn(err?.message || String(err));
      scheduleRestart();
      return;
    }
    parseStream(watcherProcess.stdout, false);
    parseStream(watcherProcess.stderr, true);
    watcherProcess.on("error", (err) => {
      onWarn(err?.message || String(err));
    });
    watcherProcess.on("exit", () => {
      watcherProcess = null;
      launching = false;
      scheduleRestart();
    });
    launching = false;
  }

  launch();

  return {
    stop() {
      stopped = true;
      clearRestartTimer();
      if (watcherProcess) {
        try {
          watcherProcess.kill();
        } catch {}
      }
      watcherProcess = null;
    },
    isRunning() {
      return !!watcherProcess && !watcherProcess.killed;
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

  const resolved = resolveLumaPlayAchievementsKey(appid, preferredUser);
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

function scanLumaPlayRegistryEntries() {
  if (process.platform !== "win32") return [];
  const byAppId = new Map();
  const users = listLumaPlayUsers();
  for (const user of users) {
    const appids = listLumaPlayAppIdsForUser(user);
    for (const appid of appids) {
      if (byAppId.has(appid)) continue;
      const keyPath = `${LUMAPLAY_ROOT_KEY}\\${user}\\${appid}\\Achievements`;
      const query = runRegQuery([keyPath]);
      if (!query.ok) continue;
      byAppId.set(appid, {
        appid,
        user,
        keyPath,
      });
    }
  }
  return Array.from(byAppId.values());
}

module.exports = {
  LUMAPLAY_ROOT_KEY,
  listLumaPlayUsers,
  listLumaPlayAppIdsForUser,
  resolveLumaPlayAchievementsKey,
  readLumaPlayAchievementsSnapshot,
  scanLumaPlayRegistryEntries,
  startLumaPlayRegistryEventWatcher,
};
