const net = require("net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");

const DEFAULT_PIPE_NAME = "LOCAL\\AchievementsJokerVerseGameBar";
const STORE_WIDGET_PACKAGE_FAMILY_NAME =
  "JokerVerse.AchievementsOverlaybyJokerVerse_f9ec2k87k0hx8";
const DEVELOPMENT_WIDGET_PACKAGE_FAMILY_NAME =
  "AchievementsGameBarWidget_h9wsctf767mk6";
const DEFAULT_WIDGET_PACKAGE_FAMILY_NAME =
  STORE_WIDGET_PACKAGE_FAMILY_NAME;
const MAX_REQUEST_BYTES = 16 * 1024;
const PUSH_DEBOUNCE_MS = 200;
const WORKER_RESTART_DELAYS_MS = [750, 2000, 5000, 15000, 30000];
const WORKER_STABLE_RESET_MS = 30000;
const PUSH_WRITE_TIMEOUT_MS = 15000;
const PACKAGE_RECHECK_INTERVAL_MS = 30000;
const SUBSCRIBER_DISCONNECTED_EXIT_CODE = 12;
const GAMEBAR_NOTIFICATION_CAPABILITY = "gamebar-native-notifications";
const MAX_PENDING_NOTIFICATIONS = 100;
// Heartbeats carry no achievement data. Besides keeping the connection
// observable, they let the native pipe worker detect a closed Game Bar page
// quickly enough for a newly opened widget to reconnect.
const SUBSCRIBER_HEARTBEAT_MS = 1000;

function normalizeKnownRevision(value) {
  const revision = String(value || "").trim();
  return revision.length <= 128 ? revision : "";
}

function normalizeImageCacheDirectory(value) {
  const directory = String(value || "").trim();
  return directory.length <= 2048 ? directory : "";
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const capabilities = [];
  for (const item of value) {
    const capability = String(item || "").trim().toLowerCase();
    if (!capability || capability.length > 96 || seen.has(capability)) continue;
    seen.add(capability);
    capabilities.push(capability);
  }
  return capabilities.slice(0, 16);
}

function normalizeRequest(raw) {
  const request = raw && typeof raw === "object" ? raw : {};
  return {
    type: String(request.type || "").trim().toLowerCase(),
    protocolVersion: Number(request.protocolVersion) || 0,
    knownRevision: normalizeKnownRevision(request.knownRevision),
    imageCacheDirectory: normalizeImageCacheDirectory(
      request.imageCacheDirectory,
    ),
    capabilities: normalizeCapabilities(request.capabilities),
  };
}

function createGameBarWidgetBridge({
  getSnapshot,
  prepareNotification = null,
  logger = null,
  pipeName = DEFAULT_PIPE_NAME,
  widgetPackageFamilyName = DEFAULT_WIDGET_PACKAGE_FAMILY_NAME,
  useWidgetAppContainerNamespace = null,
  lazyStartWhenPackageMissing = null,
  enforceClientIdentity = null,
} = {}) {
  if (typeof getSnapshot !== "function") {
    throw new TypeError("getSnapshot must be a function");
  }

  const normalizedPipeName = String(pipeName || DEFAULT_PIPE_NAME)
    .replace(/^\\\\\.\\pipe\\/i, "")
    .trim();
  const pipePath = `\\\\.\\pipe\\${normalizedPipeName}`;
  const shouldUseWidgetAppContainerNamespace =
    useWidgetAppContainerNamespace == null
      ? normalizedPipeName.toLowerCase() === DEFAULT_PIPE_NAME.toLowerCase()
      : useWidgetAppContainerNamespace === true;
  const normalizedWidgetPackageFamilyName = String(
    widgetPackageFamilyName || DEFAULT_WIDGET_PACKAGE_FAMILY_NAME,
  ).trim();
  const shouldLazyStart =
    lazyStartWhenPackageMissing == null
      ? shouldUseWidgetAppContainerNamespace
      : lazyStartWhenPackageMissing === true;
  const shouldEnforceClientIdentity =
    enforceClientIdentity == null
      ? shouldUseWidgetAppContainerNamespace
      : enforceClientIdentity === true;
  const packagesRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Packages")
    : "";
  const widgetPackageDirectory = packagesRoot
    ? path.join(packagesRoot, normalizedWidgetPackageFamilyName)
    : "";
  const shutdownToken = crypto.randomBytes(24).toString("hex");
  let worker = null;
  let stopping = false;
  let stopFallbackTimer = null;
  let workerRestartTimer = null;
  let workerRecoveryRequested = false;
  let workerRecoveryReason = "";
  let workerRestartAttempt = 0;
  let workerReadyAt = 0;
  let subscriberConnected = false;
  let subscriberRevision = "";
  let subscriberImageCacheDirectory = "";
  let subscriberCapabilities = new Set();
  let publishTimer = null;
  let publishInFlight = false;
  let publishPending = false;
  let publishReason = "";
  let heartbeatTimer = null;
  let pushWriteTimer = null;
  let activePushId = 0;
  let nextPushId = 1;
  let activeWorkerPush = null;
  let pendingSnapshotPush = null;
  let pendingHeartbeatPush = null;
  const pendingNotificationPushes = [];
  let notificationPublishQueue = Promise.resolve();
  let packageWatcher = null;
  let packageRecheckTimer = null;
  let bridgeStarted = false;
  let packageAvailable = false;
  let activeWorkerPipePath = pipePath;

  const log = (level, message, meta) => {
    try {
      logger?.[level]?.(message, meta);
    } catch {}
  };

  async function buildResponse(request) {
    const normalized = normalizeRequest(request);
    const isLegacySnapshotRequest = normalized.type === "get-snapshot";
    const isSubscriptionRequest = normalized.type === "subscribe";
    if (!isLegacySnapshotRequest && !isSubscriptionRequest) {
      return {
        protocolVersion: 1,
        status: "error",
        error: "unsupported-request",
      };
    }

    if (
      (isLegacySnapshotRequest && normalized.protocolVersion !== 1) ||
      (isSubscriptionRequest && normalized.protocolVersion !== 2)
    ) {
      return {
        protocolVersion: 1,
        status: "error",
        error: "unsupported-protocol-version",
      };
    }

    try {
      const response = await getSnapshot({
        knownRevision: normalized.knownRevision,
        imageCacheDirectory: normalized.imageCacheDirectory,
      });
      return {
        ...(response && typeof response === "object" ? response : {}),
        protocolVersion: isSubscriptionRequest ? 2 : 1,
        ...(isSubscriptionRequest
          ? { serverCapabilities: [GAMEBAR_NOTIFICATION_CAPABILITY] }
          : {}),
      };
    } catch (error) {
      log("warn", "gamebar-widget:request-failed", {
        error: error?.message || String(error),
      });
      return {
        protocolVersion: 1,
        status: "error",
        error: "snapshot-failed",
      };
    }
  }

  function clearHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function settleNotificationPush(entry, result) {
    if (entry?.kind !== "notification" || typeof entry.resolve !== "function") {
      return;
    }
    const resolve = entry.resolve;
    entry.resolve = null;
    resolve(result);
  }

  function clearPushState(reason = "subscriber-disconnected") {
    if (pushWriteTimer) {
      clearTimeout(pushWriteTimer);
      pushWriteTimer = null;
    }
    settleNotificationPush(activeWorkerPush, {
      status: "transport-error",
      reason,
    });
    for (const entry of pendingNotificationPushes.splice(0)) {
      settleNotificationPush(entry, {
        status: "unavailable",
        reason,
      });
    }
    activePushId = 0;
    activeWorkerPush = null;
    pendingSnapshotPush = null;
    pendingHeartbeatPush = null;
  }

  function clearSubscriberState() {
    subscriberConnected = false;
    subscriberRevision = "";
    subscriberImageCacheDirectory = "";
    subscriberCapabilities = new Set();
    clearHeartbeat();
    clearPushState("subscriber-disconnected");
  }

  function clearWorkerRecoveryTimers() {
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
  }

  function recycleDisconnectedWorker() {
    if (stopping || !worker || workerRecoveryRequested) return;
    const affectedWorker = worker;
    workerRecoveryRequested = true;
    workerRecoveryReason = "subscriber-disconnected";
    log("info", "gamebar-widget:bridge-recovery-requested", {
      reason: "subscriber-disconnected",
      pid: affectedWorker.pid || null,
    });
    clearSubscriberState();
    // The helper exits with a dedicated code after releasing the native pipe
    // handle. Restart only from its real `exit` event so a replacement cannot
    // race the old process for the same endpoint.
  }

  function scheduleWorkerRestart(reason = "unexpected-exit") {
    if (stopping || !bridgeStarted || worker || workerRestartTimer) return;
    if (shouldLazyStart && !isWidgetPackageInstalled()) {
      packageAvailable = false;
      log("info", "gamebar-widget:bridge-dormant", {
        reason: "package-missing",
        widgetPackageFamilyName: normalizedWidgetPackageFamilyName,
      });
      return;
    }
    const delayMs =
      WORKER_RESTART_DELAYS_MS[
        Math.min(workerRestartAttempt, WORKER_RESTART_DELAYS_MS.length - 1)
      ];
    workerRestartAttempt += 1;
    workerRestartTimer = setTimeout(() => {
      workerRestartTimer = null;
      if (stopping || worker) return;
      log("info", "gamebar-widget:bridge-restarting", { reason });
      try {
        startWorker();
      } catch (error) {
        log("error", "gamebar-widget:bridge-restart-failed", {
          reason,
          error: error?.message || String(error),
        });
        scheduleWorkerRestart("restart-failed");
      }
    }, delayMs);
    workerRestartTimer.unref?.();
    log("info", "gamebar-widget:bridge-restart-scheduled", {
      reason,
      delayMs,
      attempt: workerRestartAttempt,
    });
  }

  function sendToWorker(message, callback = null) {
    const targetWorker = worker;
    if (!targetWorker?.connected) return false;
    try {
      const accepted = targetWorker.send(message, (error) => {
        callback?.(error || null);
      });
      if (!accepted) {
        log("warn", "gamebar-widget:ipc-backpressure", {
          type: message?.type || null,
        });
      }
      return true;
    } catch (error) {
      callback?.(error);
      return false;
    }
  }

  function recycleWorkerAfterPushFailure(reason) {
    const affectedWorker = worker;
    if (!affectedWorker || stopping) return;
    clearSubscriberState();
    workerRecoveryRequested = true;
    workerRecoveryReason = String(reason || "push-failed");
    try {
      affectedWorker.kill();
    } catch {}
    log("warn", "gamebar-widget:bridge-recovery-requested", {
      reason,
      pid: affectedWorker.pid || null,
    });
  }

  function dispatchWorkerPush(entry) {
    if (!entry || activePushId || !subscriberConnected || stopping || !worker) {
      return false;
    }
    const pushId = nextPushId++;
    activePushId = pushId;
    activeWorkerPush = entry;
    log("debug", "gamebar-widget:push-started", {
      pushId,
      reason: entry.reason,
      status: entry.response?.status || null,
      kind: entry.kind || "snapshot",
    });
    const sent = sendToWorker(
      { type: "push-response", pushId, response: entry.response },
      (error) => {
        if (!error || activePushId !== pushId) return;
        log("warn", "gamebar-widget:push-failed", {
          pushId,
          reason: entry.reason,
          error: error?.message || String(error),
        });
        recycleWorkerAfterPushFailure("ipc-send-failed");
      },
    );
    if (!sent) {
      activePushId = 0;
      activeWorkerPush = null;
      settleNotificationPush(entry, {
        status: "transport-error",
        reason: "ipc-send-unavailable",
      });
      recycleWorkerAfterPushFailure("ipc-send-unavailable");
      return false;
    }
    pushWriteTimer = setTimeout(() => {
      if (activePushId !== pushId) return;
      log("warn", "gamebar-widget:push-failed", {
        pushId,
        reason: entry.reason,
        error: "write-timeout",
      });
      recycleWorkerAfterPushFailure("push-write-timeout");
    }, PUSH_WRITE_TIMEOUT_MS);
    pushWriteTimer.unref?.();
    return true;
  }

  function dispatchNextWorkerPush() {
    if (activePushId || !subscriberConnected || stopping || !worker) {
      return false;
    }
    const entry =
      pendingNotificationPushes.shift() ||
      pendingSnapshotPush ||
      pendingHeartbeatPush;
    if (!entry) return false;
    if (entry === pendingSnapshotPush) pendingSnapshotPush = null;
    if (entry === pendingHeartbeatPush) pendingHeartbeatPush = null;
    return dispatchWorkerPush(entry);
  }

  function queueWorkerPush(
    response,
    reason = "state-changed",
    kind = "snapshot",
  ) {
    if (!subscriberConnected || stopping || !worker) return false;
    const entry = { response, reason, kind };
    if (kind === "heartbeat") {
      if (
        activeWorkerPush?.kind === "notification" ||
        pendingNotificationPushes.length ||
        pendingSnapshotPush
      ) {
        return true;
      }
      pendingHeartbeatPush = entry;
    } else {
      pendingSnapshotPush = entry;
      pendingHeartbeatPush = null;
    }
    dispatchNextWorkerPush();
    return true;
  }

  function completeWorkerPush(pushId, error = null, result = null) {
    if (!pushId || pushId !== activePushId) return;
    if (pushWriteTimer) {
      clearTimeout(pushWriteTimer);
      pushWriteTimer = null;
    }
    const completedEntry = activeWorkerPush;
    activePushId = 0;
    activeWorkerPush = null;
    log(
      error ? "warn" : "debug",
      error ? "gamebar-widget:push-failed" : "gamebar-widget:push-complete",
      { pushId, error: error || null },
    );
    if (error) {
      settleNotificationPush(completedEntry, {
        status: "transport-error",
        reason: error,
      });
      recycleWorkerAfterPushFailure("native-write-failed");
      return;
    }
    settleNotificationPush(
      completedEntry,
      result && typeof result === "object"
        ? result
        : { status: "success" },
    );
    dispatchNextWorkerPush();
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!subscriberConnected || stopping) return;
      queueWorkerPush(
        {
          protocolVersion: 2,
          status: "heartbeat",
          revision: subscriberRevision,
        },
        "heartbeat",
        "heartbeat",
      );
    }, SUBSCRIBER_HEARTBEAT_MS);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  async function flushPublishedSnapshot() {
    publishTimer = null;
    if (!subscriberConnected || stopping || !worker) {
      publishPending = false;
      publishReason = "";
      return;
    }
    if (publishInFlight) {
      publishPending = true;
      return;
    }
    publishInFlight = true;
    const reason = publishReason || "state-changed";
    publishReason = "";
    try {
      const snapshotResponse = await getSnapshot({
        knownRevision: subscriberRevision,
        imageCacheDirectory: subscriberImageCacheDirectory,
      });
      const response = {
        ...(snapshotResponse && typeof snapshotResponse === "object"
          ? snapshotResponse
          : {}),
        protocolVersion: 2,
      };
      if (!subscriberConnected || stopping || !worker) return;
      if (response?.status === "not-modified") return;
      if (queueWorkerPush(response, reason)) {
        subscriberRevision = String(response?.revision || subscriberRevision);
        log("debug", "gamebar-widget:snapshot-pushed", {
          reason,
          status: response?.status || null,
          revision: response?.revision || null,
        });
      }
    } catch (error) {
      log("warn", "gamebar-widget:push-failed", {
        reason,
        error: error?.message || String(error),
      });
    } finally {
      publishInFlight = false;
      if (publishPending && subscriberConnected && !stopping) {
        publishPending = false;
        publishSnapshot("pending-state-change");
      }
    }
  }

  function publishSnapshot(reason = "state-changed") {
    if (!subscriberConnected || stopping || !worker) return false;
    publishReason = String(reason || "state-changed");
    if (publishInFlight) {
      publishPending = true;
      return true;
    }
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      void flushPublishedSnapshot();
    }, PUSH_DEBOUNCE_MS);
    if (typeof publishTimer.unref === "function") publishTimer.unref();
    return true;
  }

  async function publishNotificationInternal(notification = {}) {
    if (!subscriberConnected || stopping || !worker) {
      return { status: "unavailable", reason: "subscriber-disconnected" };
    }
    if (!subscriberCapabilities.has(GAMEBAR_NOTIFICATION_CAPABILITY)) {
      return { status: "unsupported", reason: "widget-capability-missing" };
    }
    if (pendingNotificationPushes.length >= MAX_PENDING_NOTIFICATIONS) {
      log("warn", "gamebar-widget:notification-dropped", {
        reason: "queue-full",
        pending: pendingNotificationPushes.length,
      });
      return { status: "unavailable", reason: "notification-queue-full" };
    }

    let prepared = notification;
    try {
      if (typeof prepareNotification === "function") {
        prepared = await prepareNotification(notification, {
          imageCacheDirectory: subscriberImageCacheDirectory,
        });
      }
    } catch (error) {
      log("warn", "gamebar-widget:notification-prepare-failed", {
        error: error?.message || String(error),
      });
      return { status: "error", reason: "notification-prepare-failed" };
    }

    if (!subscriberConnected || stopping || !worker) {
      return { status: "unavailable", reason: "subscriber-disconnected" };
    }
    if (!subscriberCapabilities.has(GAMEBAR_NOTIFICATION_CAPABILITY)) {
      return { status: "unsupported", reason: "widget-capability-missing" };
    }

    const notificationId = String(
      prepared?.notificationId || crypto.randomUUID(),
    ).slice(0, 128);
    const response = {
      protocolVersion: 2,
      status: "notification",
      notification: {
        ...(prepared && typeof prepared === "object" ? prepared : {}),
        notificationId,
      },
    };
    return new Promise((resolve) => {
      pendingNotificationPushes.push({
        response,
        reason: `notification:${notificationId}`,
        kind: "notification",
        resolve,
      });
      log("debug", "gamebar-widget:notification-queued", {
        notificationId,
        type: response.notification.type || null,
        pending: pendingNotificationPushes.length,
      });
      dispatchNextWorkerPush();
    });
  }

  function publishNotification(notification = {}) {
    const queued = notificationPublishQueue
      .catch(() => {})
      .then(() => publishNotificationInternal(notification));
    notificationPublishQueue = queued.catch(() => {});
    return queued;
  }

  function wakeWorkerForShutdown() {
    const socket = net.connect(activeWorkerPipePath || pipePath);
    socket.on("connect", () => {
      socket.end(
        `${JSON.stringify({
          type: "bridge-shutdown",
          token: shutdownToken,
        })}\n`,
      );
    });
    socket.on("error", () => {});
  }

  function isWidgetPackageInstalled() {
    if (!shouldLazyStart || !widgetPackageDirectory) return true;
    try {
      return fs.statSync(widgetPackageDirectory).isDirectory();
    } catch {
      return false;
    }
  }

  function ensurePackageMonitor() {
    if (!shouldLazyStart || packageWatcher || packageRecheckTimer) return;
    const recheck = () => {
      if (!bridgeStarted || stopping) return;
      const installed = isWidgetPackageInstalled();
      if (installed === packageAvailable) return;
      packageAvailable = installed;
      if (installed) {
        log("info", "gamebar-widget:package-detected", {
          widgetPackageFamilyName: normalizedWidgetPackageFamilyName,
        });
        startWorker();
        return;
      }
      log("info", "gamebar-widget:package-removed", {
        widgetPackageFamilyName: normalizedWidgetPackageFamilyName,
      });
      const currentWorker = worker;
      if (currentWorker) {
        clearSubscriberState();
        try {
          currentWorker.kill();
        } catch {}
      }
    };
    try {
      if (packagesRoot && fs.existsSync(packagesRoot)) {
        packageWatcher = fs.watch(packagesRoot, { persistent: false }, recheck);
        packageWatcher.on("error", () => {
          try {
            packageWatcher?.close();
          } catch {}
          packageWatcher = null;
        });
      }
    } catch {}
    packageRecheckTimer = setInterval(recheck, PACKAGE_RECHECK_INTERVAL_MS);
    packageRecheckTimer.unref?.();
  }

  function clearPackageMonitor() {
    try {
      packageWatcher?.close();
    } catch {}
    packageWatcher = null;
    if (packageRecheckTimer) clearInterval(packageRecheckTimer);
    packageRecheckTimer = null;
  }

  function startWorker() {
    if (worker || process.platform !== "win32") return false;
    if (!bridgeStarted || stopping) return false;
    if (shouldLazyStart && !isWidgetPackageInstalled()) return false;
    if (workerRestartTimer) {
      clearTimeout(workerRestartTimer);
      workerRestartTimer = null;
    }
    activeWorkerPipePath = pipePath;
    const bundledWorkerPath = path.join(
      __dirname,
      "gamebar-widget-pipe-worker.js",
    );
    const unpackedWorkerPath = bundledWorkerPath.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    const workerPath = fs.existsSync(unpackedWorkerPath)
      ? unpackedWorkerPath
      : bundledWorkerPath;
    const processWorkerData = {
      pipePath,
      shutdownToken,
      maxRequestBytes: MAX_REQUEST_BYTES,
      koffiModulePath: require.resolve("koffi"),
      widgetPackageFamilyName: normalizedWidgetPackageFamilyName,
      useWidgetAppContainerNamespace:
        shouldUseWidgetAppContainerNamespace,
      enforceClientIdentity: shouldEnforceClientIdentity,
    };
    worker = fork(workerPath, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GAMEBAR_WIDGET_WORKER_DATA: JSON.stringify(processWorkerData),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const spawnedWorker = worker;
    log("debug", "gamebar-widget:bridge-helper-started", {
      pid: spawnedWorker.pid || null,
    });
    spawnedWorker.on("message", (message) => {
      if (worker !== spawnedWorker) return;
      if (!message || typeof message !== "object") return;
      if (message.type === "ready") {
        workerReadyAt = Date.now();
        activeWorkerPipePath = String(message.pipePath || pipePath);
        log("info", "gamebar-widget:bridge-started", {
          pipeName: normalizedPipeName,
          endpoint: activeWorkerPipePath,
          transport: "native-secured-worker",
          runtime: message.runtime || null,
          security: "world+widget-package-sid+low-integrity",
          widgetPackageFamilyName:
            message.widgetPackageFamilyName || null,
          widgetPackageSid: message.widgetPackageSid || null,
        });
        return;
      }
      if (message.type === "endpoint-waiting") {
        activeWorkerPipePath = String(message.pipePath || pipePath);
        log("info", "gamebar-widget:waiting-for-package-namespace", {
          endpoint: activeWorkerPipePath,
          widgetPackageFamilyName:
            message.widgetPackageFamilyName || null,
          widgetPackageSid: message.widgetPackageSid || null,
        });
        return;
      }
      if (message.type === "request") {
        void buildResponse(message.request).then((response) => {
          try {
            spawnedWorker.send({
              type: "snapshot-response",
              requestId: message.requestId,
              response,
            });
          } catch {}
        });
        return;
      }
      if (message.type === "subscriber-connected") {
        subscriberConnected = true;
        subscriberRevision = String(message.revision || "");
        subscriberImageCacheDirectory = normalizeImageCacheDirectory(
          message.imageCacheDirectory,
        );
        subscriberCapabilities = new Set(
          normalizeCapabilities(message.capabilities),
        );
        startHeartbeat();
        log("info", "gamebar-widget:subscriber-connected", {
          revision: subscriberRevision || null,
          imageCacheDirectory: subscriberImageCacheDirectory || null,
          capabilities: [...subscriberCapabilities],
        });
        publishSnapshot("subscriber-ready");
        return;
      }
      if (message.type === "subscriber-disconnected") {
        clearSubscriberState();
        log("info", "gamebar-widget:subscriber-disconnected");
        recycleDisconnectedWorker();
        return;
      }
      if (message.type === "push-complete") {
        completeWorkerPush(
          Number(message.pushId) || 0,
          null,
          message.result,
        );
        return;
      }
      if (message.type === "push-failed") {
        completeWorkerPush(
          Number(message.pushId) || 0,
          message.error || "native-write-failed",
        );
        return;
      }
      if (message.type === "client-rejected") {
        log("warn", "gamebar-widget:client-rejected", {
          pid: Number(message.pid) || null,
          packageFamilyName: message.packageFamilyName || null,
          error: message.error || null,
        });
        return;
      }
      if (message.type === "client-error") {
        const errorText = message.error || "unknown-error";
        log("warn", "gamebar-widget:client-error", {
          error: errorText,
        });
        return;
      }
      if (message.type === "endpoint-busy") {
        activeWorkerPipePath = String(message.pipePath || pipePath);
        log("warn", "gamebar-widget:endpoint-busy", {
          endpoint: activeWorkerPipePath,
          retryDelayMs: Number(message.retryDelayMs) || null,
          widgetPackageFamilyName:
            message.widgetPackageFamilyName || null,
          widgetPackageSid: message.widgetPackageSid || null,
        });
        return;
      }
      if (message.type === "fatal") {
        log("error", "gamebar-widget:bridge-error", {
          pipeName: normalizedPipeName,
          error: message.error || "unknown-error",
        });
      }
    });
    spawnedWorker.on("error", (error) => {
      if (worker !== spawnedWorker) return;
      log("error", "gamebar-widget:bridge-error", {
        pipeName: normalizedPipeName,
        error: error?.message || String(error),
      });
    });
    spawnedWorker.on("exit", (code, signal) => {
      if (worker !== spawnedWorker) return;
      if (stopFallbackTimer) {
        clearTimeout(stopFallbackTimer);
        stopFallbackTimer = null;
      }
      worker = null;
      activeWorkerPipePath = pipePath;
      clearSubscriberState();
      if (!stopping) {
        const recoveryRequested =
          workerRecoveryRequested ||
          code === SUBSCRIBER_DISCONNECTED_EXIT_CODE;
        const recoveryReason =
          workerRecoveryReason ||
          (code === SUBSCRIBER_DISCONNECTED_EXIT_CODE
            ? "subscriber-disconnected"
            : "unexpected-exit");
        workerRecoveryRequested = false;
        workerRecoveryReason = "";
        log(recoveryRequested ? "info" : "warn", "gamebar-widget:bridge-exited", {
          code,
          signal: signal || null,
          recoveryRequested,
        });
        if (
          workerReadyAt > 0 &&
          Date.now() - workerReadyAt >= WORKER_STABLE_RESET_MS
        ) {
          workerRestartAttempt = 0;
        }
        workerReadyAt = 0;
        scheduleWorkerRestart(
          recoveryRequested ? recoveryReason : "unexpected-exit",
        );
      }
    });
    // Keep the helper referenced so IPC exit/restart events are always
    // delivered. The application explicitly stops it during shutdown; the
    // isolated process is also terminated automatically if its parent exits.
    return true;
  }

  function start() {
    if (process.platform !== "win32") return false;
    bridgeStarted = true;
    stopping = false;
    ensurePackageMonitor();
    packageAvailable = isWidgetPackageInstalled();
    if (!packageAvailable) {
      log("info", "gamebar-widget:bridge-dormant", {
        reason: "package-missing",
        widgetPackageFamilyName: normalizedWidgetPackageFamilyName,
      });
      return true;
    }
    return startWorker();
  }

  function stop() {
    stopping = true;
    bridgeStarted = false;
    clearPackageMonitor();
    clearWorkerRecoveryTimers();
    workerRecoveryRequested = false;
    workerRecoveryReason = "";
    clearSubscriberState();
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    publishPending = false;
    const currentWorker = worker;
    if (currentWorker) {
      try {
        currentWorker.send({ type: "stop" });
      } catch {}
      wakeWorkerForShutdown();
      stopFallbackTimer = setTimeout(() => {
        if (worker !== currentWorker) return;
        try {
          currentWorker.kill();
        } catch {}
      }, 1500);
      if (typeof stopFallbackTimer.unref === "function") {
        stopFallbackTimer.unref();
      }
    }
    log("info", "gamebar-widget:bridge-stopped");
  }

  return {
    pipeName: normalizedPipeName,
    start,
    stop,
    publishSnapshot,
    publishNotification,
  };
}

module.exports = {
  DEFAULT_PIPE_NAME,
  DEFAULT_WIDGET_PACKAGE_FAMILY_NAME,
  STORE_WIDGET_PACKAGE_FAMILY_NAME,
  DEVELOPMENT_WIDGET_PACKAGE_FAMILY_NAME,
  GAMEBAR_NOTIFICATION_CAPABILITY,
  createGameBarWidgetBridge,
  normalizeRequest,
};
