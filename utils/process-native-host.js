"use strict";

const SNAPSHOT_INTERVAL_MS = parsePositiveInteger(
  process.env.ACH_PROCESS_NATIVE_SNAPSHOT_MS,
  1000,
  250,
);
const HEARTBEAT_INTERVAL_MS = parsePositiveInteger(
  process.env.ACH_PROCESS_NATIVE_HEARTBEAT_MS ||
    process.env.ACH_EVENT_HOST_HEARTBEAT_MS,
  15000,
  1000,
);
const REQUEST_STALL_TIMEOUT_MS = parsePositiveInteger(
  process.env.ACH_PROCESS_NATIVE_REQUEST_TIMEOUT_MS,
  10000,
  2000,
);
const MAX_WORKING_SET_MB = parsePositiveNumber(
  process.env.ACH_PROCESS_NATIVE_MAX_WORKING_SET_MB,
  256,
);
const RESOURCE_LIMIT_SAMPLES = parsePositiveInteger(
  process.env.ACH_PROCESS_NATIVE_RESOURCE_LIMIT_SAMPLES,
  3,
  2,
);
const PROCESS_SNAPSHOT_CAPACITY = 1024;

let windowsProcessTree;
let ProcessDataFlag;
let stopped = false;
let ready = false;
let snapshotQueued = false;
let requestInFlight = false;
let requestStartedAt = 0;
let snapshotTimer = null;
let heartbeatTimer = null;
let processedSnapshots = 0;
let resourceLimitSamples = 0;
let capacityLimitedState = false;
let previousProcesses = new Map();
const commandLineQueue = [];

function parsePositiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function send(message) {
  if (stopped) return;
  try {
    if (process.parentPort?.postMessage) {
      process.parentPort.postMessage(message);
    } else if (typeof process.send === "function" && process.connected) {
      process.send(message);
    }
  } catch {}
}

function listenForParentMessages(handler) {
  if (process.parentPort?.on) {
    process.parentPort.on("message", (event) => {
      handler(event?.data ?? event);
    });
    return;
  }
  process.on("message", handler);
}

function normalizeProcessEntry(entry, includeCommandLine = false) {
  if (!entry || typeof entry !== "object") return null;
  const pid = Math.floor(Number(entry.pid));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const name = String(entry.name || "").trim();
  if (!name) return null;
  const normalized = { pid, name };
  const ppid = Math.floor(Number(entry.ppid));
  if (Number.isFinite(ppid) && ppid > 0) normalized.ppid = ppid;
  if (includeCommandLine) {
    const commandLine = String(entry.commandLine || entry.cmd || "").trim();
    if (commandLine) normalized.cmd = commandLine;
  }
  return normalized;
}

function getAllProcesses(flags) {
  return new Promise((resolve, reject) => {
    try {
      windowsProcessTree.getAllProcesses((list) => {
        resolve(Array.isArray(list) ? list : []);
      }, flags);
    } catch (error) {
      reject(error);
    }
  });
}

function buildProcessMap(list) {
  const next = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const normalized = normalizeProcessEntry(raw, false);
    if (!normalized) continue;
    next.set(normalized.pid, normalized);
  }
  return next;
}

function diffSnapshots(previous, next) {
  const events = [];
  for (const [pid, oldProcess] of previous) {
    const newProcess = next.get(pid);
    if (!newProcess) {
      events.push({ type: "stop", pid });
      continue;
    }
    if (
      oldProcess.name !== newProcess.name ||
      Number(oldProcess.ppid || 0) !== Number(newProcess.ppid || 0)
    ) {
      events.push({ type: "stop", pid });
      events.push({ type: "start", ...newProcess });
    }
  }
  for (const [pid, processInfo] of next) {
    if (!previous.has(pid)) {
      events.push({ type: "start", ...processInfo });
    }
  }
  return events;
}

function getMemoryStatus(type, extra = {}) {
  const memory = process.memoryUsage();
  return {
    kind: "status",
    type,
    processEnabled: true,
    provider: "windows-process-tree",
    workingSetMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
    privateMemoryMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
    externalMemoryMb: Number((memory.external / 1024 / 1024).toFixed(1)),
    uptimeMs: Math.floor(process.uptime() * 1000),
    processed: processedSnapshots,
    queueDepth: commandLineQueue.length + (snapshotQueued ? 1 : 0),
    limitMb: MAX_WORKING_SET_MB,
    ...extra,
  };
}

function checkResourceLimit(status) {
  if (Number(status.workingSetMb) > MAX_WORKING_SET_MB) {
    resourceLimitSamples += 1;
  } else {
    resourceLimitSamples = 0;
  }
  if (resourceLimitSamples < RESOURCE_LIMIT_SAMPLES) return false;
  send(
    getMemoryStatus("resource-limit", {
      reason: "working-set",
      samples: resourceLimitSamples,
    }),
  );
  setTimeout(() => process.exit(75), 25);
  return true;
}

async function runSnapshot() {
  const rawList = await getAllProcesses(ProcessDataFlag.None);
  const capacityLimited = rawList.length >= PROCESS_SNAPSHOT_CAPACITY;
  const nextProcesses = buildProcessMap(rawList);
  const events = diffSnapshots(previousProcesses, nextProcesses);
  previousProcesses = nextProcesses;
  processedSnapshots += 1;

  if (events.length) {
    send({
      kind: "events",
      events,
      queueDepth: commandLineQueue.length,
      capacityLimited,
    });
  }

  if (capacityLimited) {
    if (!capacityLimitedState) {
      send(
        getMemoryStatus("capacity-limit", {
          reason: "snapshot-capacity",
          processCount: rawList.length,
          capacity: PROCESS_SNAPSHOT_CAPACITY,
          capacityLimited: true,
        }),
      );
      send({
        kind: "resync",
        reason: "snapshot-capacity",
        processCount: rawList.length,
        capacity: PROCESS_SNAPSHOT_CAPACITY,
      });
    }
    capacityLimitedState = true;
  } else if (!ready || capacityLimitedState) {
    capacityLimitedState = false;
    ready = true;
    send(
      getMemoryStatus("ready", {
        processCount: nextProcesses.size,
        capacityLimited: false,
      }),
    );
  }
}

async function runCommandLineRequest(request) {
  const rawList = await getAllProcesses(ProcessDataFlag.CommandLine);
  const requested = new Set(request.pids);
  const entries = [];
  for (const raw of rawList) {
    const normalized = normalizeProcessEntry(raw, true);
    if (!normalized || !requested.has(normalized.pid) || !normalized.cmd) {
      continue;
    }
    entries.push({ pid: normalized.pid, cmd: normalized.cmd });
  }
  send({
    kind: "response",
    type: "command-lines",
    requestId: request.requestId,
    entries,
  });
}

async function pumpQueue() {
  if (stopped || requestInFlight) return;
  const commandRequest = commandLineQueue.shift();
  if (!commandRequest && !snapshotQueued) return;

  requestInFlight = true;
  requestStartedAt = Date.now();
  if (!commandRequest) snapshotQueued = false;
  try {
    if (commandRequest) {
      await runCommandLineRequest(commandRequest);
    } else {
      await runSnapshot();
    }
  } catch (error) {
    const message = String(error?.message || error || "native request failed");
    if (commandRequest) {
      send({
        kind: "response",
        type: "command-lines",
        requestId: commandRequest.requestId,
        error: message,
        entries: [],
      });
    } else {
      send({ kind: "fatal", reason: "snapshot-failed", error: message });
      setTimeout(() => process.exit(76), 25);
    }
  } finally {
    requestInFlight = false;
    requestStartedAt = 0;
    setImmediate(pumpQueue);
  }
}

function queueSnapshot() {
  if (stopped || snapshotQueued) return;
  snapshotQueued = true;
  pumpQueue();
}

function queueCommandLineRequest(message) {
  const requestId = String(message?.requestId || "").trim();
  if (!requestId) return;
  const pids = Array.from(
    new Set(
      (Array.isArray(message?.pids) ? message.pids : [])
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  ).slice(0, 64);
  commandLineQueue.push({ requestId, pids });
  pumpQueue();
}

function stopHost() {
  if (stopped) return;
  stopped = true;
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  snapshotTimer = null;
  heartbeatTimer = null;
  setTimeout(() => process.exit(0), requestInFlight ? 100 : 0);
}

function parentIsAlive() {
  const parentPid = Math.floor(Number(process.env.ACH_NATIVE_PARENT_PID));
  if (!Number.isFinite(parentPid) || parentPid <= 0) return true;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function startHost() {
  try {
    windowsProcessTree = require("@vscode/windows-process-tree");
    ProcessDataFlag = windowsProcessTree.ProcessDataFlag;
    if (
      typeof windowsProcessTree.getAllProcesses !== "function" ||
      !ProcessDataFlag
    ) {
      throw new Error("Invalid windows-process-tree API");
    }
  } catch (error) {
    send({
      kind: "fatal",
      reason: "provider-load-failed",
      error: String(error?.message || error),
    });
    setTimeout(() => process.exit(77), 25);
    return;
  }

  listenForParentMessages((message) => {
    const type = String(message?.type || "").toLowerCase();
    if (type === "stop") {
      stopHost();
    } else if (type === "command-lines") {
      queueCommandLineRequest(message);
    } else if (type === "snapshot") {
      queueSnapshot();
    }
  });

  snapshotTimer = setInterval(queueSnapshot, SNAPSHOT_INTERVAL_MS);
  heartbeatTimer = setInterval(() => {
    if (!parentIsAlive()) {
      stopHost();
      return;
    }
    if (
      requestInFlight &&
      requestStartedAt > 0 &&
      Date.now() - requestStartedAt >= REQUEST_STALL_TIMEOUT_MS
    ) {
      send({
        kind: "fatal",
        reason: "native-request-timeout",
        error: `Native request exceeded ${REQUEST_STALL_TIMEOUT_MS}ms`,
      });
      setTimeout(() => process.exit(78), 25);
      return;
    }
    const status = getMemoryStatus("heartbeat");
    send(status);
    checkResourceLimit(status);
  }, HEARTBEAT_INTERVAL_MS);
  queueSnapshot();
}

process.on("disconnect", stopHost);
process.on("SIGTERM", stopHost);
process.on("SIGINT", stopHost);
process.on("uncaughtException", (error) => {
  send({
    kind: "fatal",
    reason: "uncaught-exception",
    error: String(error?.message || error),
  });
  setTimeout(() => process.exit(79), 25);
});
process.on("unhandledRejection", (error) => {
  send({
    kind: "fatal",
    reason: "unhandled-rejection",
    error: String(error?.message || error),
  });
  setTimeout(() => process.exit(80), 25);
});

startHost();
