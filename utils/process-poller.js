const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { startProcessEventWatcher } = require("./process-event-watcher");
const { createLogger } = require("./logger");

const DEFAULT_INTERVAL_MS = 2000;
const WINDOWS_EVENT_FALLBACK_INTERVAL_MS = 12000;
const WINDOWS_EVENT_RESTART_DELAY_MS = 1500;
const EVENT_SNAPSHOT_DEBOUNCE_MS = 100;
const EVENT_HOST_STATUS_LOG_INTERVAL_MS = 60 * 1000;
const EVENT_HOST_MEMORY_LOG_DELTA_MB = 25;
const EVENT_WATCHER_ENABLED =
  process.platform === "win32" && process.env.ACH_PROCESS_EVENT_WATCHER !== "0";
let pollerEnabled = process.env.ACH_DISABLE_PROCESS_WATCHER !== "1";
const appLogger = createLogger("app");

function parseInterval(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(250, Math.floor(next));
}

let configuredPollIntervalMs = EVENT_WATCHER_ENABLED
  ? parseInterval(
      process.env.ACH_PROCESS_FALLBACK_POLL_MS ?? process.env.ACH_PROCESS_POLL_MS,
      WINDOWS_EVENT_FALLBACK_INTERVAL_MS,
    )
  : parseInterval(process.env.ACH_PROCESS_POLL_MS, DEFAULT_INTERVAL_MS);
let pollIntervalMs = configuredPollIntervalMs;
let eventWatcherDegraded = false;
let timer = null;
let inflight = false;
let lastSnapshot = [];
let lastUpdated = 0;
let lastError = null;
const subscribers = new Set();
const processByPid = new Map();
let eventWatcher = null;
let eventWatcherReady = false;
let eventSnapshotTimer = null;
let pendingEventMeta = null;
let forcedTickPending = false;
let forcedTickSource = "event-resync";
let lastEventHostStatus = null;
let lastEventHostLifecycle = null;
let lastEventHostStatusLogAt = 0;
let lastLoggedEventHostWorkingSetMb = 0;
let eventHostResyncTimer = null;
let eventHostResyncSource = "event-host";
let runGeneration = 0;

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

function clearEventSnapshotTimer() {
  if (eventSnapshotTimer) {
    clearTimeout(eventSnapshotTimer);
    eventSnapshotTimer = null;
  }
  pendingEventMeta = null;
}

function scheduleEventSnapshot(meta = {}) {
  pendingEventMeta = {
    source: "event",
    ...(pendingEventMeta || {}),
    ...meta,
  };
  if (eventSnapshotTimer) return;
  eventSnapshotTimer = setTimeout(() => {
    eventSnapshotTimer = null;
    const nextMeta = pendingEventMeta || { source: "event" };
    pendingEventMeta = null;
    emitSnapshot(nextMeta);
  }, EVENT_SNAPSHOT_DEBOUNCE_MS);
}

function requestEventHostResync(source = "event-host") {
  eventHostResyncSource = String(source || "event-host");
  if (eventHostResyncTimer) return;
  eventHostResyncTimer = setTimeout(() => {
    eventHostResyncTimer = null;
    const nextSource = eventHostResyncSource;
    eventHostResyncSource = "event-host";
    tick(nextSource, true).catch(() => {});
  }, EVENT_SNAPSHOT_DEBOUNCE_MS);
}

function clearEventHostResyncTimer() {
  if (eventHostResyncTimer) {
    clearTimeout(eventHostResyncTimer);
    eventHostResyncTimer = null;
  }
  eventHostResyncSource = "event-host";
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
  if (inflight) {
    if (forceEmit) {
      forcedTickPending = true;
      forcedTickSource = source || "event-resync";
    }
    return;
  }
  const generation = runGeneration;
  inflight = true;
  try {
    const list = await fetchProcesses();
    if (!pollerEnabled || generation !== runGeneration) return;
    const changed = updateSnapshotMapFromList(list);
    if (changed || forceEmit || !lastUpdated) {
      clearEventSnapshotTimer();
      emitSnapshot({ source });
    } else {
      lastError = null;
    }
  } catch (err) {
    if (pollerEnabled && generation === runGeneration) {
      lastError = err;
    }
  } finally {
    inflight = false;
    if (forcedTickPending && pollerEnabled) {
      const nextSource = forcedTickSource;
      forcedTickPending = false;
      forcedTickSource = "event-resync";
      setImmediate(() => {
        tick(nextSource, true).catch(() => {});
      });
    }
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

function setEventWatcherDegraded(value, reason = "") {
  if (!EVENT_WATCHER_ENABLED) return;
  const nextDegraded = value === true;
  const nextIntervalMs = nextDegraded
    ? Math.min(DEFAULT_INTERVAL_MS, configuredPollIntervalMs)
    : configuredPollIntervalMs;
  const stateChanged = eventWatcherDegraded !== nextDegraded;
  const intervalChanged = pollIntervalMs !== nextIntervalMs;
  eventWatcherDegraded = nextDegraded;
  pollIntervalMs = nextIntervalMs;
  if (intervalChanged && timer) {
    stopFallbackPoller();
    startFallbackPoller();
  }
  if (stateChanged || intervalChanged) {
    appLogger.info("process-poller:fallback-mode-changed", {
      mode: eventWatcherDegraded ? "poll-fallback" : "hybrid",
      reason: String(reason || ""),
      pollIntervalMs,
      configuredPollIntervalMs,
    });
  }
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
      requestEventHostResync("event-warning");
    },
    onEvent: (payload) => {
      const changed = applyProcessEvent(payload);
      if (changed || !lastUpdated) {
        scheduleEventSnapshot({
          eventType: String(payload?.type || ""),
        });
      }
    },
    onBatch: (payloads, meta = {}) => {
      let changed = false;
      let lastType = "";
      for (const payload of Array.isArray(payloads) ? payloads : []) {
        if (applyProcessEvent(payload)) changed = true;
        lastType = String(payload?.type || lastType);
      }
      if (changed || !lastUpdated) {
        scheduleEventSnapshot({
          eventType: lastType,
          eventCount: Array.isArray(payloads) ? payloads.length : 0,
          queueDepth: Number(meta?.queueDepth) || 0,
        });
      }
    },
    onResync: (meta = {}) => {
      const dropped = Number(meta?.dropped) || 0;
      appLogger.warn("process-poller:event-resync", {
        dropped,
        queueDepth: Number(meta?.queueDepth) || 0,
      });
      tick("event-resync", true).catch(() => {});
    },
    onStatus: (status = {}) => {
      lastEventHostStatus = {
        ...(lastEventHostStatus || {}),
        ...status,
        updatedAt: Date.now(),
      };
      if (
        String(status?.type || "") === "ready" &&
        typeof status?.processEnabled === "boolean"
      ) {
        eventWatcherReady = status.processEnabled;
        setEventWatcherDegraded(
          status.processEnabled !== true,
          status.processEnabled === true
            ? "process-channel-ready"
            : "process-channel-unavailable",
        );
      }
      const now = Date.now();
      const workingSetMb = Number(status?.workingSetMb) || 0;
      const memoryDelta = Math.abs(
        workingSetMb - lastLoggedEventHostWorkingSetMb,
      );
      const shouldLog =
        String(status?.type || "") !== "heartbeat" ||
        now - lastEventHostStatusLogAt >= EVENT_HOST_STATUS_LOG_INTERVAL_MS ||
        memoryDelta >= EVENT_HOST_MEMORY_LOG_DELTA_MB;
      if (shouldLog) {
        lastEventHostStatusLogAt = now;
        lastLoggedEventHostWorkingSetMb = workingSetMb;
        appLogger.info("process-poller:event-host-status", {
          type: String(status?.type || ""),
          pid: Number(lastEventHostLifecycle?.pid) || 0,
          generation: Number(lastEventHostLifecycle?.generation) || 0,
          restartCount: Number(lastEventHostLifecycle?.restartCount) || 0,
          workingSetMb,
          privateMemoryMb: Number(status?.privateMemoryMb) || 0,
          handleCount: Number(status?.handleCount) || 0,
          uptimeMs: Number(status?.uptimeMs) || 0,
          processed: Number(status?.processed) || 0,
          dropped: Number(status?.dropped) || 0,
          queueDepth: Number(status?.queueDepth) || 0,
          limitMb: Number(status?.limitMb) || 0,
          privateLimitMb: Number(status?.privateLimitMb) || 0,
          handleLimit: Number(status?.handleLimit) || 0,
          reason: String(status?.reason || ""),
          watchMode: String(status?.watchMode || ""),
          processEnabled:
            typeof status?.processEnabled === "boolean"
              ? status.processEnabled
              : null,
          lumaplayEnabled:
            typeof status?.lumaplayEnabled === "boolean"
              ? status.lumaplayEnabled
              : null,
        });
      }
    },
    onLifecycle: (lifecycle = {}) => {
      const state = String(lifecycle?.state || "").trim() || "unknown";
      lastEventHostLifecycle = {
        ...lifecycle,
        state,
        updatedAt: Date.now(),
      };
      if (state === "ready") {
        eventWatcherReady = true;
        setEventWatcherDegraded(false, "event-host-ready");
      } else if (
        state === "starting" ||
        state === "spawned" ||
        state === "restarting" ||
        state === "restart-scheduled" ||
        state === "circuit-open" ||
        state === "circuit-half-open" ||
        state === "stopping" ||
        state === "force-stopping" ||
        state === "stopped" ||
        state === "exited" ||
        state === "failed"
      ) {
        eventWatcherReady = false;
        setEventWatcherDegraded(true, `event-host-${state}`);
      }
      const details = {
        state,
        pid: Number(lifecycle?.pid) || 0,
        generation: Number(lifecycle?.generation) || 0,
        restartCount: Number(lifecycle?.restartCount) || 0,
        consecutiveFailures: Number(lifecycle?.consecutiveFailures) || 0,
        circuitOpenUntil: Number(lifecycle?.circuitOpenUntil) || 0,
        reason: String(lifecycle?.reason || ""),
        exitCode:
          lifecycle?.exitCode === null ||
          lifecycle?.exitCode === undefined
            ? null
            : Number(lifecycle.exitCode),
        signal: String(lifecycle?.signal || ""),
      };
      if (
        state === "failed" ||
        state === "restarting" ||
        state === "exited" ||
        state === "circuit-open" ||
        state === "force-stopping"
      ) {
        appLogger.warn("process-poller:event-host-lifecycle", details);
      } else {
        appLogger.info("process-poller:event-host-lifecycle", details);
      }
      if (
        state === "ready" ||
        state === "restarting" ||
        state === "circuit-open" ||
        state === "circuit-half-open" ||
        state === "stopped" ||
        state === "exited" ||
        state === "failed"
      ) {
        requestEventHostResync(`event-host-${state}`);
      }
    },
  });
}

function stopEventWatcher() {
  lastEventHostStatus = null;
  lastEventHostLifecycle = null;
  lastEventHostStatusLogAt = 0;
  lastLoggedEventHostWorkingSetMb = 0;
  clearEventHostResyncTimer();
  eventWatcherDegraded = false;
  pollIntervalMs = configuredPollIntervalMs;
  if (!eventWatcher) return;
  try {
    eventWatcher.stop();
  } catch {}
  eventWatcher = null;
  eventWatcherReady = false;
}

function start() {
  if (!pollerEnabled) return;
  if (!timer && !eventWatcher) {
    runGeneration += 1;
  }
  startEventWatcherIfNeeded();
  startFallbackPoller();
  tick("poll", true).catch(() => {});
}

function stop() {
  runGeneration += 1;
  stopFallbackPoller();
  stopEventWatcher();
  clearEventSnapshotTimer();
  clearEventHostResyncTimer();
  forcedTickPending = false;
  forcedTickSource = "event-resync";
  processByPid.clear();
  lastSnapshot = [];
  lastUpdated = 0;
  lastError = null;
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
    processDetectionMode: !pollerEnabled
      ? "disabled"
      : EVENT_WATCHER_ENABLED && eventWatcherDegraded
        ? "poll-fallback"
        : EVENT_WATCHER_ENABLED
          ? "hybrid"
          : "poll",
    subscribers: subscribers.size,
    updatedAt: lastUpdated,
    pollIntervalMs,
    configuredPollIntervalMs,
    eventWatcherDegraded,
    eventWatcherRunning,
    eventWatcherReady,
    eventHostStatus: lastEventHostStatus,
    eventHostLifecycle: lastEventHostLifecycle,
    lastError: lastError ? String(lastError?.message || lastError) : "",
  };
}

function setIntervalMs(value) {
  configuredPollIntervalMs = parseInterval(value, configuredPollIntervalMs);
  pollIntervalMs =
    EVENT_WATCHER_ENABLED && eventWatcherDegraded
      ? Math.min(DEFAULT_INTERVAL_MS, configuredPollIntervalMs)
      : configuredPollIntervalMs;
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
