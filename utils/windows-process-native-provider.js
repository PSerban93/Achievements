"use strict";

const fs = require("fs");
const path = require("path");
const { fork: forkNodeProcess } = require("child_process");

const DEFAULT_RESTART_DELAY_MS = 1500;
const MAX_RESTART_DELAY_MS = 30000;
const RESTART_WINDOW_MS = 60000;
const RESTART_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const STABLE_RESET_MS = 10 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 15000;
const WATCHDOG_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 2500;
const COMMAND_LINE_TIMEOUT_MS = 2000;
const MAX_COMMAND_LINE_PIDS = 64;
const WARN_DEDUP_MS = 5000;

const state = {
  subscriptions: new Set(),
  child: null,
  childRuntime: "",
  stoppingChild: null,
  suppressRestart: false,
  restartTimer: null,
  circuitTimer: null,
  stableTimer: null,
  watchdogTimer: null,
  forceStopTimer: null,
  ready: false,
  lastMessageAt: 0,
  generation: 0,
  restartCount: 0,
  consecutiveFailures: 0,
  restartTimestamps: [],
  circuitOpenUntil: 0,
  startedAt: 0,
  nextRequestId: 1,
  pendingRequests: new Map(),
  warnCache: new Map(),
  restartDelayMs: DEFAULT_RESTART_DELAY_MS,
};

function resolveHostPath() {
  const regularPath = path.join(__dirname, "process-native-host.js");
  const unpackedPath = regularPath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
  if (unpackedPath !== regularPath && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return regularPath;
}

function getElectronUtilityProcess() {
  try {
    const electron = require("electron");
    if (
      electron &&
      typeof electron === "object" &&
      electron.utilityProcess &&
      typeof electron.utilityProcess.fork === "function" &&
      electron.app?.isReady?.()
    ) {
      return electron.utilityProcess;
    }
  } catch {}
  return null;
}

function notifyLifecycle(event = {}) {
  const payload = {
    state: String(event.state || "unknown"),
    pid: Number(event.pid) || 0,
    generation: Number(event.generation) || state.generation || 0,
    restartCount: Number(event.restartCount) || state.restartCount || 0,
    consecutiveFailures:
      Number(event.consecutiveFailures) || state.consecutiveFailures || 0,
    circuitOpenUntil:
      Number(event.circuitOpenUntil) || state.circuitOpenUntil || 0,
    startedAt: Number(event.startedAt) || state.startedAt || 0,
    reason: String(event.reason || ""),
    exitCode:
      event.exitCode === null || event.exitCode === undefined
        ? null
        : Number(event.exitCode),
    signal: String(event.signal || ""),
    runtime: state.childRuntime,
    at: Date.now(),
  };
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      subscription.onLifecycle?.(payload);
    } catch {}
  }
}

function notifyStatus(status = {}) {
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      subscription.onStatus?.(status);
    } catch {}
  }
}

function enrichStatusWithElectronMetrics(status) {
  if (state.childRuntime !== "electron-utility") return status;
  try {
    const electron = require("electron");
    const childPid = Number(state.child?.pid) || Number(state.child?.__achPid) || 0;
    const metric = electron.app
      ?.getAppMetrics?.()
      ?.find((entry) => Number(entry?.pid) === childPid);
    if (!metric?.memory) return status;
    const workingSetKb = Number(metric.memory.workingSetSize);
    const privateBytesKb = Number(metric.memory.privateBytes);
    return {
      ...status,
      workingSetMb:
        Number.isFinite(workingSetKb) && workingSetKb >= 0
          ? Number((workingSetKb / 1024).toFixed(1))
          : status.workingSetMb,
      privateMemoryMb:
        Number.isFinite(privateBytesKb) && privateBytesKb >= 0
          ? Number((privateBytesKb / 1024).toFixed(1))
          : status.privateMemoryMb,
      memoryMetricSource: "electron-app-metrics",
    };
  } catch {
    return status;
  }
}

function pruneWarnCache(now) {
  for (const [message, timestamp] of state.warnCache) {
    if (now - timestamp >= WARN_DEDUP_MS) state.warnCache.delete(message);
  }
  while (state.warnCache.size > 128) {
    state.warnCache.delete(state.warnCache.keys().next().value);
  }
}

function notifyWarn(message) {
  const normalized = String(message || "native process provider warning").trim();
  const now = Date.now();
  if (now - Number(state.warnCache.get(normalized) || 0) < WARN_DEDUP_MS) {
    return;
  }
  state.warnCache.set(normalized, now);
  pruneWarnCache(now);
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      subscription.onWarn?.(normalized);
    } catch {}
  }
}

function notifyReady() {
  if (state.ready) return;
  state.ready = true;
  clearTimeout(state.stableTimer);
  state.stableTimer = setTimeout(() => {
    state.consecutiveFailures = 0;
    state.restartTimestamps = [];
    state.circuitOpenUntil = 0;
    notifyLifecycle({
      state: "stable",
      pid: Number(state.child?.pid) || Number(state.child?.__achPid) || 0,
      reason: "stable-window-complete",
    });
  }, STABLE_RESET_MS);
  notifyLifecycle({ state: "ready", pid: Number(state.child?.pid) || 0 });
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      subscription.onReady?.();
    } catch {}
  }
}

function emitEvents(events, meta = {}) {
  const normalized = (Array.isArray(events) ? events : [])
    .map((entry) => {
      const pid = Math.floor(Number(entry?.pid));
      const type = String(entry?.type || "").toLowerCase();
      if (!Number.isFinite(pid) || pid <= 0) return null;
      if (type === "stop") return { type, pid };
      if (type !== "start") return null;
      const name = String(entry?.name || "").trim();
      if (!name) return null;
      const result = { type, pid, name };
      const ppid = Math.floor(Number(entry?.ppid));
      if (Number.isFinite(ppid) && ppid > 0) result.ppid = ppid;
      return result;
    })
    .filter(Boolean);
  if (!normalized.length) return;
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      if (subscription.onBatch) {
        subscription.onBatch(normalized, meta);
      } else {
        for (const event of normalized) subscription.onEvent?.(event);
      }
    } catch {}
  }
}

function notifyResync(meta = {}) {
  for (const subscription of Array.from(state.subscriptions)) {
    try {
      subscription.onResync?.(meta);
    } catch {}
  }
}

function rejectPendingRequests(error) {
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pendingRequests.clear();
}

function handleResponse(message) {
  const requestId = String(message?.requestId || "");
  const pending = state.pendingRequests.get(requestId);
  if (!pending) return;
  state.pendingRequests.delete(requestId);
  clearTimeout(pending.timer);
  if (message?.error) {
    pending.reject(new Error(String(message.error)));
    return;
  }
  const result = new Map();
  for (const entry of Array.isArray(message?.entries) ? message.entries : []) {
    const pid = Math.floor(Number(entry?.pid));
    const cmd = String(entry?.cmd || "").trim();
    if (Number.isFinite(pid) && pid > 0 && cmd) result.set(pid, cmd);
  }
  pending.resolve(result);
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  state.lastMessageAt = Date.now();
  const kind = String(message.kind || "").toLowerCase();
  if (kind === "events") {
    emitEvents(message.events, {
      queueDepth: Number(message.queueDepth) || 0,
      capacityLimited: message.capacityLimited === true,
    });
    return;
  }
  if (kind === "status") {
    const status = enrichStatusWithElectronMetrics({
      ...message,
      processEnabled: message.processEnabled === true,
      provider: String(message.provider || "windows-process-tree"),
    });
    delete status.kind;
    notifyStatus(status);
    if (status.type === "ready") notifyReady();
    if (status.type === "capacity-limit") {
      notifyResync({
        reason: "snapshot-capacity",
        processCount: Number(status.processCount) || 0,
        capacity: Number(status.capacity) || 1024,
      });
    }
    return;
  }
  if (kind === "response") {
    handleResponse(message);
    return;
  }
  if (kind === "resync") {
    notifyResync(message);
    return;
  }
  if (kind === "fatal") {
    notifyWarn(
      `${String(message.reason || "native-provider-failed")}: ${String(
        message.error || "",
      )}`.trim(),
    );
    state.ready = false;
    notifyLifecycle({
      state: "restarting",
      pid: Number(state.child?.pid) || 0,
      reason: String(message.reason || "native-provider-failed"),
    });
    try {
      state.child?.kill();
    } catch {}
  }
}

function sendToChild(message) {
  const child = state.child;
  if (!child) throw new Error("Native process provider is not running");
  if (state.childRuntime === "electron-utility") {
    child.postMessage(message);
  } else if (child.connected) {
    child.send(message);
  } else {
    throw new Error("Native process provider IPC is disconnected");
  }
}

function clearRuntimeTimers() {
  clearTimeout(state.restartTimer);
  clearTimeout(state.circuitTimer);
  clearTimeout(state.stableTimer);
  clearTimeout(state.forceStopTimer);
  clearInterval(state.watchdogTimer);
  state.restartTimer = null;
  state.circuitTimer = null;
  state.stableTimer = null;
  state.forceStopTimer = null;
  state.watchdogTimer = null;
}

function startWatchdog(child) {
  clearInterval(state.watchdogTimer);
  state.lastMessageAt = Date.now();
  state.watchdogTimer = setInterval(() => {
    if (state.child !== child) return;
    const silenceMs = Date.now() - state.lastMessageAt;
    if (silenceMs < WATCHDOG_TIMEOUT_MS) return;
    notifyWarn(`Native process provider unresponsive for ${silenceMs}ms`);
    state.ready = false;
    notifyLifecycle({
      state: "restarting",
      pid: Number(child.pid) || 0,
      reason: "watchdog-timeout",
    });
    try {
      child.kill();
    } catch {}
  }, WATCHDOG_INTERVAL_MS);
}

function scheduleRestart(reason) {
  if (!state.subscriptions.size || state.suppressRestart) return;
  clearTimeout(state.restartTimer);
  clearTimeout(state.stableTimer);
  const now = Date.now();
  state.restartTimestamps = state.restartTimestamps.filter(
    (timestamp) => now - timestamp <= RESTART_WINDOW_MS,
  );
  state.restartTimestamps.push(now);
  state.consecutiveFailures += 1;
  if (state.restartTimestamps.length >= RESTART_THRESHOLD) {
    state.circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
    notifyLifecycle({ state: "circuit-open", reason });
    state.circuitTimer = setTimeout(() => {
      state.circuitTimer = null;
      state.circuitOpenUntil = 0;
      state.restartTimestamps = [];
      notifyLifecycle({ state: "circuit-half-open", reason: "cooldown-complete" });
      launch();
    }, CIRCUIT_COOLDOWN_MS);
    return;
  }
  const delayMs = Math.min(
    MAX_RESTART_DELAY_MS,
    state.restartDelayMs * 2 ** Math.max(0, state.consecutiveFailures - 1),
  );
  notifyLifecycle({ state: "restart-scheduled", reason });
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    launch();
  }, delayMs);
}

function handleExit(child, code, signal = "") {
  if (state.child !== child && state.stoppingChild !== child) return;
  const wasCurrent = state.child === child;
  const suppressed = state.suppressRestart || !state.subscriptions.size;
  if (wasCurrent) state.child = null;
  if (state.stoppingChild === child) state.stoppingChild = null;
  clearInterval(state.watchdogTimer);
  clearTimeout(state.forceStopTimer);
  clearTimeout(state.stableTimer);
  state.watchdogTimer = null;
  state.forceStopTimer = null;
  state.stableTimer = null;
  state.ready = false;
  state.lastMessageAt = 0;
  state.startedAt = 0;
  rejectPendingRequests(new Error("Native process provider exited"));
  notifyLifecycle({
    state: suppressed ? "stopped" : "exited",
    pid: Number(child.__achPid) || 0,
    reason: suppressed ? "stop-requested" : "unexpected-exit",
    exitCode: code,
    signal,
  });
  if (!suppressed) scheduleRestart("unexpected-exit");
}

function launch() {
  if (process.platform !== "win32") return;
  if (!state.subscriptions.size || state.child || state.stoppingChild) return;
  if (state.circuitOpenUntil > Date.now()) return;

  state.suppressRestart = false;
  state.ready = false;
  notifyLifecycle({
    state: "starting",
    reason: state.generation ? "restart" : "initial-start",
  });

  const hostPath = resolveHostPath();
  const env = {
    ...process.env,
    ACH_NATIVE_PARENT_PID: String(process.pid),
  };
  let child;
  try {
    const utilityProcess = getElectronUtilityProcess();
    if (utilityProcess) {
      state.childRuntime = "electron-utility";
      child = utilityProcess.fork(hostPath, [], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        serviceName: "Achievements Process Watcher",
      });
      child.on("message", handleMessage);
      child.on("spawn", () => {
        child.__achPid = Number(child.pid) || 0;
        notifyLifecycle({ state: "spawned", pid: child.__achPid });
      });
      child.on("exit", (code) => handleExit(child, code, ""));
      child.on("error", (type, location) => {
        notifyWarn(`Native utility process error: ${type} ${location}`.trim());
      });
    } else {
      state.childRuntime = "node-fork-test";
      child = forkNodeProcess(hostPath, [], {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.on("message", handleMessage);
      child.on("spawn", () => {
        child.__achPid = Number(child.pid) || 0;
        notifyLifecycle({ state: "spawned", pid: child.__achPid });
      });
      child.on("close", (code, signal) => handleExit(child, code, signal));
      child.on("error", (error) => {
        notifyWarn(`Native provider process error: ${error?.message || error}`);
      });
    }
  } catch (error) {
    notifyWarn(`Native process provider launch failed: ${error?.message || error}`);
    notifyLifecycle({ state: "failed", reason: "spawn-failed" });
    scheduleRestart("spawn-failed");
    return;
  }

  child.__achPid = Number(child.pid) || 0;
  state.child = child;
  state.generation += 1;
  if (state.generation > 1) state.restartCount += 1;
  state.startedAt = Date.now();
  startWatchdog(child);

  const handleOutput = (stream) => {
    if (!stream?.on) return;
    stream.on("data", (chunk) => {
      const message = String(chunk || "").trim();
      if (message) notifyWarn(`Native provider output: ${message.slice(0, 500)}`);
    });
  };
  handleOutput(child.stderr);
}

function stop(reason = "no-subscribers") {
  clearRuntimeTimers();
  state.suppressRestart = true;
  state.ready = false;
  state.circuitOpenUntil = 0;
  state.restartTimestamps = [];
  state.consecutiveFailures = 0;
  rejectPendingRequests(new Error("Native process provider stopped"));
  const child = state.child || state.stoppingChild;
  if (!child) return;
  state.child = null;
  state.stoppingChild = child;
  notifyLifecycle({
    state: "stopping",
    pid: Number(child.pid) || Number(child.__achPid) || 0,
    reason,
  });
  try {
    if (state.childRuntime === "electron-utility") {
      child.postMessage({ type: "stop", reason });
    } else if (child.connected) {
      child.send({ type: "stop", reason });
    }
  } catch {}
  state.forceStopTimer = setTimeout(() => {
    if (state.stoppingChild !== child) return;
    notifyLifecycle({
      state: "force-stopping",
      pid: Number(child.pid) || Number(child.__achPid) || 0,
      reason,
    });
    try {
      child.kill();
    } catch {}
  }, STOP_TIMEOUT_MS);
}

function subscribe(options = {}) {
  if (process.platform !== "win32") {
    return { stop() {}, isRunning: () => false };
  }
  const subscription = {
    onEvent: typeof options.onEvent === "function" ? options.onEvent : null,
    onBatch: typeof options.onBatch === "function" ? options.onBatch : null,
    onResync: typeof options.onResync === "function" ? options.onResync : null,
    onStatus: typeof options.onStatus === "function" ? options.onStatus : null,
    onLifecycle:
      typeof options.onLifecycle === "function" ? options.onLifecycle : null,
    onReady: typeof options.onReady === "function" ? options.onReady : null,
    onWarn: typeof options.onWarn === "function" ? options.onWarn : null,
  };
  state.restartDelayMs = Math.max(
    500,
    Number(options.restartDelayMs) || DEFAULT_RESTART_DELAY_MS,
  );
  state.subscriptions.add(subscription);
  state.suppressRestart = false;
  launch();
  if (state.ready) {
    try {
      subscription.onReady?.();
    } catch {}
  }
  return {
    stop() {
      state.subscriptions.delete(subscription);
      if (!state.subscriptions.size) stop("no-subscribers");
    },
    isRunning() {
      return !!state.child;
    },
  };
}

function readCommandLines(processIds, options = {}) {
  const maxPids = Math.max(
    1,
    Math.min(MAX_COMMAND_LINE_PIDS, Number(options.maxPids) || MAX_COMMAND_LINE_PIDS),
  );
  const pids = Array.from(
    new Set(
      (Array.isArray(processIds) ? processIds : [])
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).slice(0, maxPids);
  if (!pids.length) return Promise.resolve(new Map());
  if (!state.child || !state.ready) {
    return Promise.reject(new Error("Native process provider is not ready"));
  }
  const timeoutMs = Math.max(
    250,
    Number(options.timeoutMs) || COMMAND_LINE_TIMEOUT_MS,
  );
  const requestId = `${process.pid}-${Date.now()}-${state.nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(requestId);
      reject(new Error(`Native command-line request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    state.pendingRequests.set(requestId, { resolve, reject, timer });
    try {
      sendToChild({ type: "command-lines", requestId, pids });
    } catch (error) {
      clearTimeout(timer);
      state.pendingRequests.delete(requestId);
      reject(error);
    }
  });
}

function getStatus() {
  return {
    ready: state.ready,
    running: !!state.child,
    pid: Number(state.child?.pid) || Number(state.child?.__achPid) || 0,
    runtime: state.childRuntime,
    generation: state.generation,
    restartCount: state.restartCount,
    consecutiveFailures: state.consecutiveFailures,
    circuitOpenUntil: state.circuitOpenUntil,
    pendingRequests: state.pendingRequests.size,
  };
}

module.exports = {
  subscribe,
  readCommandLines,
  getStatus,
};
