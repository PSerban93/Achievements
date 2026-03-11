const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { startProcessEventWatcher } = require("./process-event-watcher");
const { createLogger } = require("./logger");

const DEFAULT_INTERVAL_MS = 2000;
const WINDOWS_EVENT_FALLBACK_INTERVAL_MS = 12000;
const WINDOWS_EVENT_RESTART_DELAY_MS = 1500;
const EVENT_WATCHER_ENABLED =
  process.platform === "win32" && process.env.ACH_PROCESS_EVENT_WATCHER !== "0";
let pollerEnabled = process.env.ACH_DISABLE_PROCESS_WATCHER !== "1";
const appLogger = createLogger("app");

function parseInterval(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(250, Math.floor(next));
}

let pollIntervalMs = EVENT_WATCHER_ENABLED
  ? parseInterval(
      process.env.ACH_PROCESS_FALLBACK_POLL_MS ?? process.env.ACH_PROCESS_POLL_MS,
      WINDOWS_EVENT_FALLBACK_INTERVAL_MS,
    )
  : parseInterval(process.env.ACH_PROCESS_POLL_MS, DEFAULT_INTERVAL_MS);
let timer = null;
let inflight = false;
let lastSnapshot = [];
let lastUpdated = 0;
let lastError = null;
const subscribers = new Set();
const processByPid = new Map();
let eventWatcher = null;
let eventWatcherReady = false;

let psListModulePromise = null;
async function loadPsListModule() {
  if (psListModulePromise) return psListModulePromise;
  psListModulePromise = (async () => {
    const tryPaths = [
      path.join(__dirname, "pslist-wrapper.mjs"),
      path.join(__dirname, "utils", "pslist-wrapper.mjs"),
      path.join(
        process.resourcesPath || "",
        "app.asar.unpacked",
        "utils",
        "pslist-wrapper.mjs",
      ),
      path.join(process.resourcesPath || "", "utils", "pslist-wrapper.mjs"),
    ];

    for (const p of tryPaths) {
      try {
        await fs.promises.access(p, fs.constants.R_OK);
        return await import(pathToFileURL(p).href);
      } catch {
        /* continue */
      }
    }
    throw new Error(`pslist-wrapper.mjs not found in:\n${tryPaths.join("\n")}`);
  })();
  return psListModulePromise;
}

async function fetchProcesses() {
  const mod = await loadPsListModule();
  return mod.getProcesses();
}

function normalizeProcessEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const pid = Number(entry.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const name = String(entry.name || "").trim();
  if (!name) return null;
  const normalized = {
    pid: Math.floor(pid),
    name,
  };
  const ppid = Number(entry.ppid ?? entry.parentPid ?? 0);
  if (Number.isFinite(ppid) && ppid > 0) {
    normalized.ppid = Math.floor(ppid);
  }
  if (typeof entry.cmd === "string" && entry.cmd.trim()) {
    normalized.cmd = entry.cmd.trim();
  } else if (Array.isArray(entry.cmd)) {
    const joined = entry.cmd
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (joined) normalized.cmd = joined;
  } else if (typeof entry.command === "string" && entry.command.trim()) {
    normalized.cmd = entry.command.trim();
  }
  return normalized;
}

function mapToSnapshot() {
  return Array.from(processByPid.values());
}

function emitSnapshot(meta = {}) {
  lastSnapshot = mapToSnapshot();
  lastUpdated = Date.now();
  lastError = null;
  const payloadMeta = { updatedAt: lastUpdated, ...meta };
  for (const cb of Array.from(subscribers)) {
    try {
      cb(lastSnapshot, payloadMeta);
    } catch {}
  }
}

function updateSnapshotMapFromList(list) {
  const nextMap = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const normalized = normalizeProcessEntry(raw);
    if (!normalized) continue;
    nextMap.set(normalized.pid, normalized);
  }

  let changed = nextMap.size !== processByPid.size;
  if (!changed) {
    for (const [pid, next] of nextMap.entries()) {
      const prev = processByPid.get(pid);
      if (!prev) {
        changed = true;
        break;
      }
      if (
        String(prev.name || "") !== String(next.name || "") ||
        String(prev.cmd || "") !== String(next.cmd || "") ||
        Number(prev.ppid || 0) !== Number(next.ppid || 0)
      ) {
        changed = true;
        break;
      }
    }
  }

  processByPid.clear();
  for (const [pid, info] of nextMap.entries()) {
    processByPid.set(pid, info);
  }
  return changed;
}

function applyProcessEvent(event) {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type || "").toLowerCase();
  const pid = Number(event.pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const key = Math.floor(pid);

  if (type === "stop") {
    return processByPid.delete(key);
  }
  if (type !== "start") return false;

  const existing = processByPid.get(key);
  const next = {
    ...(existing || {}),
    pid: key,
    name: String(event.name || existing?.name || "").trim(),
  };
  if (typeof event.cmd === "string" && event.cmd.trim()) {
    next.cmd = event.cmd.trim();
  }
  const ppid = Number(event.ppid ?? 0);
  if (Number.isFinite(ppid) && ppid > 0) {
    next.ppid = Math.floor(ppid);
  }
  if (!next.name) return false;

  const changed =
    !existing ||
    String(existing.name || "") !== String(next.name || "") ||
    String(existing.cmd || "") !== String(next.cmd || "") ||
    Number(existing.ppid || 0) !== Number(next.ppid || 0);
  processByPid.set(key, next);
  return changed;
}

async function tick(source = "poll", forceEmit = false) {
  if (inflight) return;
  inflight = true;
  try {
    const list = await fetchProcesses();
    const changed = updateSnapshotMapFromList(list);
    if (changed || forceEmit || !lastUpdated) {
      emitSnapshot({ source });
    } else {
      lastError = null;
    }
  } catch (err) {
    lastError = err;
  } finally {
    inflight = false;
  }
}

function startFallbackPoller() {
  if (timer) return;
  timer = setInterval(() => {
    tick("poll").catch(() => {});
  }, pollIntervalMs);
}

function stopFallbackPoller() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function startEventWatcherIfNeeded() {
  if (!EVENT_WATCHER_ENABLED || eventWatcher) return;
  eventWatcherReady = false;
  const restartDelayMs = parseInterval(
    process.env.ACH_PROCESS_EVENT_RESTART_MS,
    WINDOWS_EVENT_RESTART_DELAY_MS,
  );
  eventWatcher = startProcessEventWatcher({
    restartDelayMs,
    onReady: () => {
      eventWatcherReady = true;
    },
    onWarn: (message) => {
      const normalizedMessage = String(
        message || "process event watcher warning",
      );
      lastError = new Error(normalizedMessage);
      appLogger.warn("process-poller:event-warning", {
        error: normalizedMessage,
      });
    },
    onEvent: (payload) => {
      const changed = applyProcessEvent(payload);
      if (changed || !lastUpdated) {
        emitSnapshot({
          source: "event",
          eventType: String(payload?.type || ""),
        });
      }
    },
  });
}

function stopEventWatcher() {
  if (!eventWatcher) return;
  try {
    eventWatcher.stop();
  } catch {}
  eventWatcher = null;
  eventWatcherReady = false;
}

function start() {
  if (!pollerEnabled) return;
  startEventWatcherIfNeeded();
  startFallbackPoller();
  tick("poll", true).catch(() => {});
}

function stop() {
  stopFallbackPoller();
  stopEventWatcher();
}

function subscribe(callback) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  start();
  if (lastUpdated) {
    try {
      callback(lastSnapshot, { updatedAt: lastUpdated });
    } catch {}
  }
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) stop();
  };
}

function getSnapshot() {
  return lastSnapshot;
}

function getStatus() {
  const eventWatcherRunning =
    !!eventWatcher && typeof eventWatcher.isRunning === "function"
      ? eventWatcher.isRunning()
      : false;
  return {
    enabled: pollerEnabled,
    running: pollerEnabled && (!!timer || eventWatcherRunning),
    mode: !pollerEnabled ? "disabled" : EVENT_WATCHER_ENABLED ? "hybrid" : "poll",
    subscribers: subscribers.size,
    updatedAt: lastUpdated,
    pollIntervalMs,
    eventWatcherRunning,
    eventWatcherReady,
    lastError: lastError ? String(lastError?.message || lastError) : "",
  };
}

function setIntervalMs(value) {
  pollIntervalMs = parseInterval(value, pollIntervalMs);
  if (timer) {
    stopFallbackPoller();
    startFallbackPoller();
  }
}

function setEnabled(value) {
  const next = value !== false;
  if (pollerEnabled === next) return;
  pollerEnabled = next;
  if (!pollerEnabled) {
    stop();
    return;
  }
  if (subscribers.size > 0) {
    start();
  }
}

function isEnabled() {
  return pollerEnabled;
}

module.exports = {
  subscribe,
  getSnapshot,
  getStatus,
  setIntervalMs,
  setEnabled,
  isEnabled,
};
