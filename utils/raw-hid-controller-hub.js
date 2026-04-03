const path = require("path");
const { Worker } = require("node:worker_threads");

function createNoopHub() {
  return {
    get available() {
      return false;
    },
    poll() {
      return null;
    },
    setActive() {},
    shutdown() {},
  };
}

function createRawHidControllerHub(options = {}) {
  const logger = options.logger || {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  const onGuideButtonChanged =
    typeof options.onGuideButtonChanged === "function"
      ? options.onGuideButtonChanged
      : null;
  const rediscoveryIntervalMs = Math.max(
    500,
    Number(options.rediscoveryIntervalMs) || 1500,
  );
  const idleRediscoveryIntervalMs = Math.max(
    rediscoveryIntervalMs,
    Number(options.idleRediscoveryIntervalMs) || 5000,
  );
  const debugLoggingEnabled = options.debugLoggingEnabled === true;

  let latestSnapshot = null;
  let available = false;
  let worker = null;
  let active = false;
  let shutdownTimer = null;

  try {
    worker = new Worker(path.join(__dirname, "raw-hid-controller-worker.js"), {
      workerData: {
        rediscoveryIntervalMs,
        idleRediscoveryIntervalMs,
        debugLoggingEnabled,
      },
    });
  } catch (err) {
    logger.warn("controller:raw-hid:worker-create-failed", {
      error: err?.message || String(err),
    });
    return createNoopHub();
  }

  const handleMessage = (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      available = Number(message.readers || 0) > 0;
      if (!available) latestSnapshot = null;
      logger.info("controller:raw-hid:ready", {
        reason: String(message.reason || "worker"),
        readers: Number(message.readers || 0),
        products: Array.isArray(message.products) ? message.products : [],
      });
      return;
    }
    if (message.type === "connected") {
      logger.info("controller:raw-hid:connected", {
        reason: String(message.reason || "worker"),
        deviceKey: message.deviceKey || null,
        product: message.product || null,
        vid: Number(message.vid) >>> 0,
        pid: Number(message.pid) >>> 0,
        profileId: message.profileId || null,
      });
      return;
    }
    if (message.type === "disconnected") {
      if (
        latestSnapshot &&
        String(latestSnapshot.deviceKey || "") === String(message.deviceKey || "")
      ) {
        latestSnapshot = null;
      }
      logger.info("controller:raw-hid:disconnected", {
        reason: String(message.reason || "worker"),
        deviceKey: message.deviceKey || null,
        product: message.product || null,
        vid: Number(message.vid) >>> 0,
        pid: Number(message.pid) >>> 0,
      });
      return;
    }
    if (message.type === "snapshot") {
      latestSnapshot = message.snapshot || null;
      return;
    }
    if (message.type === "guide-button") {
      try {
        onGuideButtonChanged?.({
          source: "raw-hid",
          deviceKey: message.deviceKey || null,
          product: message.product || null,
          pressed: message.pressed === true,
          packetNumber: Number(message.packetNumber || 0) >>> 0,
        });
      } catch {}
      return;
    }
    if (message.type === "warn") {
      logger.warn(message.event || "controller:raw-hid:warn", {
        ...(message.payload && typeof message.payload === "object"
          ? message.payload
          : {}),
      });
    }
  };

  worker.on("message", handleMessage);
  worker.on("error", (err) => {
    logger.warn("controller:raw-hid:worker-error", {
      error: err?.message || String(err),
    });
  });
  worker.on("exit", (code) => {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    if (code !== 0) {
      logger.warn("controller:raw-hid:worker-exit", { code });
    }
    worker = null;
    available = false;
  });

  return {
    get available() {
      return available;
    },
    poll() {
      return latestSnapshot;
    },
    setActive(next) {
      active = next === true;
      try {
        worker?.postMessage({ type: "set-active", active });
      } catch {}
    },
    shutdown() {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      try {
        worker?.postMessage({ type: "shutdown" });
      } catch {}
      if (worker) {
        shutdownTimer = setTimeout(() => {
          const currentWorker = worker;
          if (!currentWorker) return;
          try {
            currentWorker.terminate();
          } catch {}
          shutdownTimer = null;
        }, 1500);
        if (typeof shutdownTimer.unref === "function") shutdownTimer.unref();
      }
      worker = null;
      latestSnapshot = null;
      available = false;
      active = false;
    },
  };
}

module.exports = {
  createRawHidControllerHub,
};
