"use strict";

const fs = require("fs");
const path = require("path");

const MAX_INITIAL_LINES = 1000;
const MAX_INITIAL_BYTES = 512 * 1024;
const MAX_APPEND_BYTES = 1024 * 1024;

const KNOWN_LOG_SOURCES = Object.freeze({
  app: "Application",
  notifications: "Achievement Notifications",
  watcher: "Folder & Save Watchers",
  achschema: "Schema Generation",
  autoconfig: "Automatic Config Generation",
  records: "Achievement Records",
  overlay: "Overlay",
  windows: "Application Windows",
  execution: "Game Execution",
  covers: "Covers & Images",
  rarity: "Achievement Rarity",
  "epic-official": "Epic Games",
  "xbox-pc": "Xbox PC",
  retroachievements: "RetroAchievements",
  controller: "Controller",
  updates: "Application Updates",
  preferences: "Preferences",
  persistence: "Cache & Persistence",
  "uplay-mapping": "Ubisoft Mapping",
  "schema-parse": "Steam Schema Parser",
  ui: "User Interface",
  ipc: "IPC Errors",
});

function normalizeSourceId(value) {
  const sourceId = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(sourceId) ? sourceId : "";
}

function defaultSourceLabel(sourceId) {
  if (KNOWN_LOG_SOURCES[sourceId]) return KNOWN_LOG_SOURCES[sourceId];
  return sourceId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveLogFile(logDir, sourceId) {
  const safeId = normalizeSourceId(sourceId);
  if (!safeId) return null;
  const root = path.resolve(logDir);
  const filePath = path.resolve(root, `${safeId}.log`);
  return path.dirname(filePath) === root ? filePath : null;
}

async function fileIdentity(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      identity: `${String(stat.ino || "")}:${Math.trunc(stat.birthtimeMs || 0)}`,
    };
  } catch {
    return null;
  }
}

async function readRange(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readTail(logDir, sourceId, options = {}) {
  const filePath = resolveLogFile(logDir, sourceId);
  if (!filePath) throw new Error("Invalid log source");
  const info = await fileIdentity(filePath);
  if (!info) {
    return { sourceId, lines: [], offset: 0, identity: "", exists: false };
  }
  const maxLines = Math.min(
    MAX_INITIAL_LINES,
    Math.max(1, Number(options.maxLines) || 500),
  );
  const start = Math.max(0, info.size - MAX_INITIAL_BYTES);
  const text = (await readRange(filePath, start, info.size - start)).toString(
    "utf8",
  );
  let lines = text.split(/\r?\n/);
  if (start > 0) lines.shift();
  if (lines.at(-1) === "") lines.pop();
  lines = lines.slice(-maxLines);
  return {
    sourceId,
    lines,
    offset: info.size,
    identity: info.identity,
    exists: true,
  };
}

async function listSources(logDir) {
  const ids = new Set(Object.keys(KNOWN_LOG_SOURCES));
  try {
    for (const entry of await fs.promises.readdir(logDir, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".log")) continue;
      const id = normalizeSourceId(entry.name.slice(0, -4));
      if (id) ids.add(id);
    }
  } catch {}
  return Array.from(ids)
    .sort((left, right) =>
      defaultSourceLabel(left).localeCompare(defaultSourceLabel(right)),
    )
    .map((id) => ({
      id,
      label: defaultSourceLabel(id),
      exists: fs.existsSync(resolveLogFile(logDir, id)),
    }));
}

function createLogViewerService(options = {}) {
  const logDir = path.resolve(String(options.logDir || ""));
  const logger = options.logger || null;
  const subscriptions = new Map();
  const subscriptionVersions = new Map();
  const destroyedBindings = new Set();
  let directoryWatcher = null;
  let debounceTimer = null;
  let pollTimer = null;

  fs.mkdirSync(logDir, { recursive: true });

  const stopWatcherIfIdle = () => {
    if (subscriptions.size) return;
    if (directoryWatcher) {
      directoryWatcher.close();
      directoryWatcher = null;
    }
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const send = (subscription, payload) => {
    const webContents = subscription.webContents;
    if (!webContents || webContents.isDestroyed?.()) return false;
    try {
      webContents.send("settings:logs:append", payload);
      return true;
    } catch {
      return false;
    }
  };

  const updateSubscription = async (subscription) => {
    const filePath = resolveLogFile(logDir, subscription.sourceId);
    if (!filePath) return;
    const info = await fileIdentity(filePath);
    if (!info) return;
    const replaced =
      (subscription.identity && subscription.identity !== info.identity) ||
      info.size < subscription.offset;
    if (replaced) {
      const snapshot = await readTail(logDir, subscription.sourceId, {
        maxLines: subscription.maxLines,
      });
      subscription.offset = snapshot.offset;
      subscription.identity = snapshot.identity;
      subscription.remainder = "";
      send(subscription, {
        sourceId: subscription.sourceId,
        reset: true,
        lines: snapshot.lines,
      });
      return;
    }
    if (info.size <= subscription.offset) return;
    let start = subscription.offset;
    let reset = false;
    if (info.size - start > MAX_APPEND_BYTES) {
      start = Math.max(0, info.size - MAX_APPEND_BYTES);
      subscription.remainder = "";
      reset = true;
    }
    const text =
      subscription.remainder +
      (await readRange(filePath, start, info.size - start)).toString("utf8");
    const lines = text.split(/\r?\n/);
    subscription.remainder = lines.pop() || "";
    subscription.offset = info.size;
    subscription.identity = info.identity;
    if (lines.length || reset) {
      send(subscription, {
        sourceId: subscription.sourceId,
        reset,
        lines: lines.slice(-subscription.maxLines),
      });
    }
  };

  const flush = async () => {
    debounceTimer = null;
    for (const [key, subscription] of subscriptions) {
      if (subscription.webContents?.isDestroyed?.()) {
        subscriptions.delete(key);
        continue;
      }
      try {
        await updateSubscription(subscription);
      } catch (error) {
        logger?.warn?.("logs-viewer:update-failed", {
          sourceId: subscription.sourceId,
          error: error?.message || String(error),
        });
      }
    }
    stopWatcherIfIdle();
  };

  const scheduleFlush = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void flush(), 100);
  };

  const ensureWatcher = () => {
    if (!directoryWatcher) {
      try {
        directoryWatcher = fs.watch(logDir, scheduleFlush);
      } catch (error) {
        logger?.warn?.("logs-viewer:watch-failed", {
          error: error?.message || String(error),
        });
        directoryWatcher = null;
      }
      directoryWatcher?.on("error", (error) => {
        logger?.warn?.("logs-viewer:watch-failed", {
          error: error?.message || String(error),
        });
        directoryWatcher?.close();
        directoryWatcher = null;
      });
    }
    if (!pollTimer) {
      pollTimer = setInterval(scheduleFlush, 1000);
      pollTimer.unref?.();
    }
  };

  async function subscribe(webContents, sourceId, options = {}) {
    const safeId = normalizeSourceId(sourceId);
    if (!safeId) throw new Error("Invalid log source");
    const key = String(webContents.id);
    const version = (subscriptionVersions.get(key) || 0) + 1;
    subscriptionVersions.set(key, version);
    subscriptions.delete(key);
    stopWatcherIfIdle();
    const allowed = await listSources(logDir);
    if (subscriptionVersions.get(key) !== version) {
      return {
        sourceId: safeId,
        lines: [],
        offset: 0,
        identity: "",
        exists: false,
        superseded: true,
      };
    }
    if (!allowed.some((entry) => entry.id === safeId)) {
      throw new Error("Unknown log source");
    }
    const snapshot = await readTail(logDir, safeId, options);
    if (subscriptionVersions.get(key) !== version) {
      return { ...snapshot, superseded: true };
    }
    subscriptions.set(key, {
      webContents,
      sourceId: safeId,
      offset: snapshot.offset,
      identity: snapshot.identity,
      remainder: "",
      maxLines: Math.min(
        MAX_INITIAL_LINES,
        Math.max(100, Number(options.maxLines) || 1000),
      ),
    });
    if (!destroyedBindings.has(key)) {
      destroyedBindings.add(key);
      webContents.once?.("destroyed", () => {
        subscriptions.delete(key);
        subscriptionVersions.delete(key);
        destroyedBindings.delete(key);
        stopWatcherIfIdle();
      });
    }
    ensureWatcher();
    return snapshot;
  }

  function unsubscribe(webContents) {
    if (!webContents) return false;
    const key = String(webContents.id);
    subscriptionVersions.set(key, (subscriptionVersions.get(key) || 0) + 1);
    const removed = subscriptions.delete(key);
    stopWatcherIfIdle();
    return removed;
  }

  function close() {
    subscriptions.clear();
    subscriptionVersions.clear();
    destroyedBindings.clear();
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearInterval(pollTimer);
    pollTimer = null;
    directoryWatcher?.close();
    directoryWatcher = null;
  }

  return {
    close,
    listSources: () => listSources(logDir),
    subscribe,
    unsubscribe,
  };
}

module.exports = {
  KNOWN_LOG_SOURCES,
  createLogViewerService,
  defaultSourceLabel,
  normalizeSourceId,
  readTail,
};
