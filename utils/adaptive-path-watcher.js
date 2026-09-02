"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

function normalizePath(value) {
  if (!value) return "";
  let resolved = "";
  try {
    resolved = path.resolve(String(value));
  } catch {
    return "";
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathHasExpectedType(targetPath, targetType, fsImpl = fs) {
  try {
    const stat = fsImpl.statSync(targetPath);
    return targetType === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function createAdaptivePathWatcher(options = {}) {
  const rawTargetPath = String(options.targetPath || "").trim();
  if (!rawTargetPath) {
    throw new TypeError("targetPath is required for an adaptive path watcher");
  }
  const targetPath = path.resolve(rawTargetPath);
  const targetType = options.targetType === "directory" ? "directory" : "file";
  const fsImpl = options.fs || fs;
  const chokidarImpl = options.chokidar || chokidar;
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || 1000);
  const targetKey = normalizePath(targetPath);
  const parentPath = path.dirname(targetPath);
  const parentKey = normalizePath(parentPath);
  const initialTargetExists = pathHasExpectedType(
    targetPath,
    targetType,
    fsImpl,
  );
  const watcherOptions = {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignorePermissionErrors: true,
    ...(options.watcherOptions || {}),
  };

  let closed = false;
  let mode = "none";
  let currentWatcher = null;
  let generation = 0;
  let reconcileRunning = false;
  let reconcileQueued = false;
  let available = false;
  let availabilityCount = 0;
  let targetWatchReady = false;
  let initialReadySettled = false;
  let resolveInitialReady = null;
  const readyPromise = new Promise((resolve) => {
    resolveInitialReady = resolve;
  });

  const settleInitialReady = (ready) => {
    if (initialReadySettled) return;
    initialReadySettled = true;
    const resolve = resolveInitialReady;
    resolveInitialReady = null;
    resolve?.(ready === true);
  };

  const reportError = (error, phase) => {
    try {
      options.onError?.(error, { phase, targetPath, targetType });
    } catch {}
  };

  const closeCurrentWatcher = async () => {
    const watcher = currentWatcher;
    currentWatcher = null;
    mode = "none";
    targetWatchReady = false;
    generation += 1;
    if (!watcher) return;
    try {
      await watcher.close();
    } catch (error) {
      reportError(error, "close");
    }
  };

  const emitEvent = (event, eventPath) => {
    if (closed) return;
    try {
      options.onEvent?.(event, eventPath, { targetPath, targetType });
    } catch (error) {
      reportError(error, "event-callback");
    }
  };

  const emitAvailable = () => {
    if (closed || available) return;
    available = true;
    const initial = availabilityCount === 0 && initialTargetExists;
    availabilityCount += 1;
    try {
      options.onAvailable?.(targetPath, {
        initial,
        reappeared: availabilityCount > 1,
        targetType,
      });
    } catch (error) {
      reportError(error, "available-callback");
    }
  };

  const emitUnavailable = (reason) => {
    if (closed || !available) return;
    available = false;
    try {
      options.onUnavailable?.(targetPath, {
        reason: String(reason || "missing"),
        targetType,
      });
    } catch (error) {
      reportError(error, "unavailable-callback");
    }
  };

  const queueReconcile = () => {
    if (closed) return;
    if (reconcileRunning) {
      reconcileQueued = true;
      return;
    }
    setTimeout(() => {
      reconcile().catch((error) => reportError(error, "reconcile"));
    }, 0);
  };

  const attachTargetWatcher = () => {
    const localGeneration = generation;
    const watchOptions = { ...watcherOptions };
    if (targetType === "directory" && watchOptions.depth === undefined) {
      watchOptions.depth = 2;
    }
    const watcher = chokidarImpl.watch(targetPath, watchOptions);
    currentWatcher = watcher;
    mode = "target";

    watcher
      .on("ready", () => {
        if (closed || localGeneration !== generation) return;
        targetWatchReady = true;
        emitAvailable();
        settleInitialReady(true);
      })
      .on("add", (eventPath) => emitEvent("add", eventPath))
      .on("change", (eventPath) => emitEvent("change", eventPath))
      .on("addDir", (eventPath) => emitEvent("addDir", eventPath))
      .on("unlink", (eventPath) => {
        emitEvent("unlink", eventPath);
        if (
          targetType === "file" &&
          normalizePath(eventPath) === targetKey &&
          localGeneration === generation
        ) {
          emitUnavailable("unlink");
          queueReconcile();
        }
      })
      .on("unlinkDir", (eventPath) => {
        emitEvent("unlinkDir", eventPath);
        if (
          targetType === "directory" &&
          normalizePath(eventPath) === targetKey &&
          localGeneration === generation
        ) {
          emitUnavailable("unlinkDir");
          queueReconcile();
        }
      })
      .on("error", (error) => {
        if (!closed && localGeneration === generation) {
          settleInitialReady(false);
        }
        reportError(error, "target-watch");
      });

  };

  const attachParentWatcher = () => {
    const localGeneration = generation;
    const watcher = chokidarImpl.watch(parentPath, {
      ...watcherOptions,
      depth: 0,
    });
    currentWatcher = watcher;
    mode = "parent";

    const maybeTargetChanged = (_event, eventPath) => {
      const eventKey = normalizePath(eventPath);
      if (eventKey === targetKey || eventKey === parentKey) queueReconcile();
    };
    watcher
      .on("ready", () => {
        if (closed || localGeneration !== generation) return;
        settleInitialReady(true);
      })
      .on("add", (eventPath) => maybeTargetChanged("add", eventPath))
      .on("change", (eventPath) => maybeTargetChanged("change", eventPath))
      .on("addDir", (eventPath) => maybeTargetChanged("addDir", eventPath))
      .on("unlink", (eventPath) => maybeTargetChanged("unlink", eventPath))
      .on("unlinkDir", (eventPath) =>
        maybeTargetChanged("unlinkDir", eventPath),
      )
      .on("error", (error) => {
        if (!closed && localGeneration === generation) {
          settleInitialReady(false);
        }
        reportError(error, "parent-watch");
      });
  };

  async function reconcile() {
    if (closed) return;
    if (reconcileRunning) {
      reconcileQueued = true;
      return;
    }
    reconcileRunning = true;
    try {
      do {
        reconcileQueued = false;
        const targetExists = pathHasExpectedType(
          targetPath,
          targetType,
          fsImpl,
        );
        if (targetExists) {
          if (mode !== "target") {
            await closeCurrentWatcher();
            if (!closed) attachTargetWatcher();
          } else if (targetWatchReady) {
            emitAvailable();
          }
          continue;
        }

        emitUnavailable("missing");
        let parentExists = false;
        try {
          parentExists = fsImpl.statSync(parentPath).isDirectory();
        } catch {}
        if (parentExists) {
          if (mode !== "parent") {
            await closeCurrentWatcher();
            if (!closed) attachParentWatcher();
          }
        } else if (mode !== "none") {
          await closeCurrentWatcher();
        } else {
          // There is nothing to enumerate yet. The polling fallback remains
          // active and will attach a real watcher when the path appears.
          settleInitialReady(true);
        }
      } while (reconcileQueued && !closed);
    } finally {
      reconcileRunning = false;
    }
  }

  const timer = setInterval(queueReconcile, pollIntervalMs);
  timer.unref?.();
  queueReconcile();

  return {
    targetPath,
    targetType,
    readyPromise,
    get available() {
      return available;
    },
    async refresh() {
      await reconcile();
      return available;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      settleInitialReady(false);
      await closeCurrentWatcher();
    },
  };
}

module.exports = {
  createAdaptivePathWatcher,
  normalizePath,
  pathHasExpectedType,
};
