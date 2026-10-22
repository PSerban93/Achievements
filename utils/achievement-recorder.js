const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { normalizeAchievementRecordFps } = require("./achievement-record-settings");

const DEFAULT_RECORDER_TIMINGS = Object.freeze({
  preMs: 10_000,
  postMs: 10_000,
  segmentMs: 5_000,
  fps: 30,
  hdrToneMapping: false,
});
// Native shutdown allows 3s for encoder drain and 60s for queued MP4 writes.
// Keep the hard process kill outside that window.
const DEFAULT_FORCE_STOP_GRACE_MS = 70_000;

function getSafeOutputToken(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80) || crypto.randomUUID();
}

function getStagingOutputPath(outputPath, id) {
  const parsed = path.parse(outputPath);
  const extension = parsed.ext || ".mp4";
  return path.join(
    parsed.dir,
    `.${parsed.name}.${getSafeOutputToken(id)}.partial${extension}`,
  );
}

function removeEmptyFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size === 0) fs.rmSync(filePath, { force: true });
  } catch {}
}

function preserveInterruptedOutput(outputPath, stagingPath, id) {
  let partialPath = null;
  try {
    const stat = fs.statSync(stagingPath);
    if (stat.isFile() && stat.size === 0) {
      fs.rmSync(stagingPath, { force: true });
    } else if (stat.isFile()) {
      const parsed = path.parse(outputPath);
      const token = getSafeOutputToken(id);
      let destination = path.join(
        parsed.dir,
        `${parsed.name}.recovered-${token}${parsed.ext || ".mp4"}`,
      );
      let suffix = 1;
      while (fs.existsSync(destination)) {
        destination = path.join(
          parsed.dir,
          `${parsed.name}.recovered-${token}-${suffix}${parsed.ext || ".mp4"}`,
        );
        suffix += 1;
      }
      fs.renameSync(stagingPath, destination);
      partialPath = destination;
    }
  } catch {
    if (fs.existsSync(stagingPath)) partialPath = stagingPath;
  }
  removeEmptyFile(outputPath);
  return partialPath;
}

function resolveAchievementRecorderHelper(options = {}) {
  const executableName = "achievements-recorder.exe";
  const appDir = String(options.appDir || __dirname);
  const resourcesPath = String(options.resourcesPath || process.resourcesPath || "");
  const unpackedAppDir = appDir.replace(
    /app\.asar(?=[\\/]|$)/i,
    "app.asar.unpacked",
  );
  const isAsarPath = unpackedAppDir !== appDir;
  const candidates = isAsarPath
    ? [
        path.join(unpackedAppDir, "native", executableName),
        path.join(appDir, "native", executableName),
      ]
    : [path.join(appDir, "native", executableName)];
  if (resourcesPath) {
    candidates.push(
      path.join(
        resourcesPath,
        "app.asar.unpacked",
        "utils",
        "native",
        executableName,
      ),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function parseRecorderProtocolLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Recorder protocol message must be an object");
  }
  const type = String(parsed.type || "").trim();
  if (!type) throw new TypeError("Recorder protocol message has no type");
  return { ...parsed, type };
}

class AchievementRecorderController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.appDir = options.appDir || __dirname;
    this.resourcesPath = options.resourcesPath || process.resourcesPath || "";
    this.bufferDir = String(options.bufferDir || "").trim();
    this.timings = {
      ...DEFAULT_RECORDER_TIMINGS,
      ...(options.timings || {}),
    };
    this.spawnProcess = options.spawnProcess || spawn;
    this.enabled = false;
    this.child = null;
    this.exitedChild = null;
    this.childClosePromise = null;
    this.exitDrainTimeoutMs = Math.max(100, Number(options.exitDrainTimeoutMs) || 2_000);
    this.ready = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = null;
    this.restartTimer = null;
    this.activityTimer = null;
    this.nativeDrainUntil = 0;
    this.activityTimeoutMs = Math.max(100, Number(options.activityTimeoutMs) || 15_000);
    this.restartAttempt = 0;
    this.restartBlockedError = null;
    this.stopping = false;
    this.stopPromise = null;
    this.stopReason = null;
    this.pendingOutputs = new Map();
    this.monitorId = "";
    this.activeMonitorId = "";
    this.monitorMode = "";
    this.activeMonitorMode = "";
    this.monitorChangePromise = null;
    this.forceStopGraceMs = Math.max(
      100,
      Number(options.forceStopGraceMs) || DEFAULT_FORCE_STOP_GRACE_MS,
    );
  }

  get status() {
    return {
      enabled: this.enabled,
      running: !!this.child && !this.child.killed && this.exitedChild !== this.child,
      closing: !!this.child && this.exitedChild === this.child,
      ready: this.ready,
      pid: this.child?.pid || null,
      stopping: this.stopping,
      pendingOutputs: this.pendingOutputs.size,
      restartBlocked: !!this.restartBlockedError,
    };
  }

  clearActivityWatchdog() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    this.activityTimer = null;
  }

  armActivityWatchdog() {
    this.clearActivityWatchdog();
    const child = this.child;
    if (!child || !this.ready || this.stopping) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      if (this.child !== child || this.stopping || !this.enabled) return;
      const error = new Error("Achievement recorder stopped reporting progress");
      error.code = "recorder-unresponsive";
      this.emit("recorder-error", error);
      // A driver call can block the native worker itself. Process termination
      // is the bounded fallback; the existing exit handler preserves partial
      // files and performs the normal restart with backoff.
      try { child.kill(); } catch {}
    }, Math.max(this.activityTimeoutMs, this.nativeDrainUntil - Date.now()));
    this.activityTimer.unref?.();
  }

  updateTimings(nextTimings = {}) {
    const normalized = {
      preMs: Math.max(1_000, Number(nextTimings.preMs) || this.timings.preMs),
      postMs: Math.max(1_000, Number(nextTimings.postMs) || this.timings.postMs),
      segmentMs: Math.max(
        1_000,
        Number(nextTimings.segmentMs) || this.timings.segmentMs,
      ),
      fps: normalizeAchievementRecordFps(
        nextTimings.fps === "unlocked" ? "unlocked" : Number(nextTimings.fps),
        this.timings.fps,
      ),
      hdrToneMapping: Object.prototype.hasOwnProperty.call(
        nextTimings,
        "hdrToneMapping",
      )
        ? nextTimings.hdrToneMapping === true
        : this.timings.hdrToneMapping,
    };
    const changed = Object.keys(normalized).some(
      (key) => normalized[key] !== this.timings[key],
    );
    if (changed) {
      this.restartBlockedError = null;
      const previous = { ...this.timings };
      this.timings = normalized;
      this.emit("timings-changed", { previous, current: { ...normalized } });
    }
    return changed;
  }

  async restart(reason = "configuration-changed") {
    if (!this.enabled) return false;
    this.restartAttempt = 0;
    await this.stopChild(reason);
    return this.enabled ? this.ensureStarted(`${reason}:restart`) : false;
  }

  setMonitor(monitorId, mode = "") {
    const id = String(monitorId || "");
    if (id === this.monitorId && mode === this.monitorMode) return this.monitorChangePromise || Promise.resolve(false);
    this.monitorId = id;
    this.monitorMode = mode;
    this.restartBlockedError = null;
    if (this.monitorChangePromise) return this.monitorChangePromise;
    if (!this.enabled || !this.child) return Promise.resolve(false);
    // Keep the old source alive until its clips finish; new requests wait for
    // the new source so a clip can never contain frames from two monitors.
    this.monitorChangePromise = (async () => {
      while (this.enabled && (this.activeMonitorId !== this.monitorId || this.activeMonitorMode !== this.monitorMode)) {
        while (this.enabled && this.pendingOutputs.size) await new Promise(resolve => setTimeout(resolve, 100));
        if (!this.enabled) return false;
        await this.restart("monitor-changed");
      }
      return true;
    })().finally(() => { this.monitorChangePromise = null; });
    return this.monitorChangePromise;
  }

  setEnabled(enabled, reason = "unknown") {
    const wasEnabled = this.enabled;
    this.enabled = enabled === true;
    if (this.enabled && !wasEnabled) this.restartBlockedError = null;
    if (!this.enabled) {
      this.restartAttempt = 0;
      return this.stop(reason);
    }
    if (!wasEnabled) this.restartAttempt = 0;
    if (this.stopping && this.stopPromise) {
      return this.stopPromise.then(() =>
        this.enabled ? this.ensureStarted(`${reason}:after-stop`) : false,
      );
    }
    return this.ensureStarted(reason);
  }

  ensureStarted(reason = "unknown") {
    if (!this.enabled) return Promise.resolve(false);
    if (this.restartBlockedError) return Promise.reject(this.restartBlockedError);
    if (this.child && this.exitedChild === this.child) {
      return this.childClosePromise.then(() => this.ensureStarted(`${reason}:after-close`));
    }
    if (this.stopping && this.stopPromise) {
      return this.stopPromise.then(() =>
        this.enabled ? this.ensureStarted(`${reason}:after-stop`) : false,
      );
    }
    if (this.ready && this.child && !this.child.killed) {
      return Promise.resolve(true);
    }
    if (this.startPromise) return this.startPromise;
    this.clearActivityWatchdog();
    this.nativeDrainUntil = 0;

    const helper = resolveAchievementRecorderHelper({
      appDir: this.appDir,
      resourcesPath: this.resourcesPath,
    });
    if (!helper) {
      const error = new Error("Bundled achievement recorder helper was not found");
      error.code = "recorder-helper-missing";
      this.emit("recorder-error", error);
      return Promise.reject(error);
    }
    if (!this.bufferDir) {
      const error = new Error("Achievement recorder buffer directory is missing");
      error.code = "recorder-buffer-missing";
      this.emit("recorder-error", error);
      return Promise.reject(error);
    }

    fs.mkdirSync(this.bufferDir, { recursive: true });
    this.stopping = false;
    this.ready = false;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    const args = [
      "--buffer-dir",
      this.bufferDir,
      "--pre-ms",
      String(this.timings.preMs),
      "--post-ms",
      String(this.timings.postMs),
      "--segment-ms",
      String(this.timings.segmentMs),
      "--fps",
      String(this.timings.fps),
      "--hdr-tone-map",
      String(this.timings.hdrToneMapping === true),
    ];
    if (this.monitorId && !this.monitorId.startsWith("electron:")) args.push("--monitor-id", this.monitorId);
    const child = this.spawnProcess(helper, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeMonitorId = this.monitorId;
    this.activeMonitorMode = this.monitorMode;
    this.child = child;
    this.exitedChild = null;
    let resolveClosed;
    this.childClosePromise = new Promise((resolve) => { resolveClosed = resolve; });
    this.emit("starting", { reason, helper, pid: child.pid || null });

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      try {
        const message = parseRecorderProtocolLine(line);
        if (!message || this.child !== child) return;
        this.handleMessage(message);
      } catch (error) {
        this.emit("protocol-error", {
          error: error?.message || String(error),
          line: String(line).slice(0, 1000),
        });
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.stdin?.on("error", (error) => {
      if (this.child === child && this.exitedChild !== child && !this.stopping) {
        this.emit("recorder-error", error);
      }
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.rejectStart(error);
      this.emit("recorder-error", error);
    });
    let exitDetails = null;
    let drainTimer = null;
    let finalized = false;
    const finishClose = (code, signal) => {
      if (finalized) return;
      finalized = true;
      if (drainTimer) clearTimeout(drainTimer);
      output.close();
      const isCurrentChild = this.child === child;
      code = exitDetails?.code ?? code;
      signal = exitDetails?.signal ?? signal;
      const wasStopping = (exitDetails?.wasStopping ?? false) || (isCurrentChild && this.stopping);
      const wasReady = exitDetails?.wasReady ?? (isCurrentChild ? this.ready : false);
      const error = new Error(
        `Achievement recorder exited (code=${code}, signal=${signal || ""})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
      error.code = "recorder-exited";
      // Exit code 2 is also authoritative if Windows delivers process exit
      // before the last stdout protocol line has been consumed.
      if (isCurrentChild && !wasStopping && code === 2 && !this.restartBlockedError) {
        error.code = "recorder-unsupported-profile";
        this.restartBlockedError = error;
        this.emit("recorder-error", error);
      }
      if (isCurrentChild) {
        this.clearActivityWatchdog();
        this.nativeDrainUntil = 0;
        const pendingReason = wasStopping
          ? this.stopReason || "helper-exit"
          : "helper-exit";
        this.stopReason = null;
        this.ready = false;
        this.child = null;
        this.exitedChild = null;
        this.rejectStart(error);
        this.cleanupPendingOutputs(pendingReason);
        this.stopping = false;
        if (this.enabled && !wasStopping && !this.restartBlockedError) this.scheduleRestart();
      }
      this.emit("exit", {
        code,
        signal,
        wasReady,
        expected: wasStopping || !isCurrentChild,
        stale: !isCurrentChild,
      });
      resolveClosed(true);
    };
    child.once("exit", (code, signal) => {
      exitDetails = { code, signal, wasStopping: this.stopping, wasReady: this.ready };
      if (this.child === child) {
        this.exitedChild = child;
        this.ready = false;
        this.clearActivityWatchdog();
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
      }
      // Process exit can precede the last stdout bytes. Retain pending jobs and
      // accept their terminal messages until close, with a bounded pipe fallback.
      drainTimer = setTimeout(() => {
        this.emit("protocol-error", { error: "Recorder output streams did not close after exit",
          code: "recorder-output-drain-timeout" });
        child.stdout.destroy?.();
        child.stderr.destroy?.();
        finishClose(code, signal);
      }, this.exitDrainTimeoutMs);
      drainTimer.unref?.();
    });
    child.once("close", finishClose);
    this.startTimer = setTimeout(() => {
      const error = new Error("Achievement recorder did not become ready in time");
      error.code = "recorder-start-timeout";
      this.rejectStart(error);
      this.emit("recorder-error", error);
      try {
        child.kill();
      } catch {}
    }, 15_000);
    this.startTimer.unref?.();
    return this.startPromise;
  }

  handleMessage(message) {
    if (message.type === "save-draining") {
      // The capture worker may already be unwinding after an encoder error.
      // Its heartbeats stop, but the MP4 writer still has a bounded drain window.
      this.nativeDrainUntil = Date.now()
        + Math.min(60_000, Math.max(0, Number(message.timeoutMs) || 0)) + 5_000;
    }
    if (this.ready && this.exitedChild !== this.child) this.armActivityWatchdog();
    if (message.type === "ready") {
      if (this.child && this.exitedChild === this.child) return;
      if (this.ready) {
        this.emit("duplicate-ready", message);
        return;
      }
      this.ready = true;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      const resolve = this.startResolve;
      this.clearStartPromise();
      resolve?.(true);
      this.emit("ready", message);
      this.armActivityWatchdog();
      return;
    }
    if (message.type === "fatal") {
      this.clearActivityWatchdog();
      if (this.stopping) return;
      const error = new Error(message.error || "Achievement recorder failed");
      error.code = message.errorCode || "recorder-fatal";
      if (message.retryable === false) {
        this.restartBlockedError = error;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.rejectStart(error);
      this.emit("recorder-error", error);
      return;
    }
    const stableReplay = message.type === "capture-stats"
      && message.pipeline === "continuous-encoded-replay"
      && message.uptimeMs >= 5_000 && message.encodedFrames > 0
      && message.pipelineStalled !== true;
    if ((message.type === "segment-finalized" || stableReplay) && this.restartAttempt > 0) {
      const previousAttempt = this.restartAttempt;
      this.restartAttempt = 0;
      this.emit("restart-stabilized", {
        previousAttempt,
        reason: stableReplay ? "continuous-encoding-stable" : "first-segment-finalized",
      });
    }
    if (message.type === "saved" || message.type === "failed") {
      const id = String(message.id || "").trim();
      const pending = this.pendingOutputs.get(id);
      if (!id || !pending) {
        this.emit("protocol-error", {
          error: `Recorder returned ${message.type} for an unknown output`,
          id: id || null,
        });
        return;
      }

      if (message.type === "saved") {
        try {
          if (
            path.resolve(String(message.outputPath || "")) !==
            path.resolve(pending.stagingPath)
          ) {
            throw new Error("Recorder returned an unexpected staging path");
          }
          fs.renameSync(pending.stagingPath, pending.outputPath);
          this.pendingOutputs.delete(id);
          const saved = { ...message, outputPath: pending.outputPath };
          this.emit("saved", saved);
          this.emit("message", saved);
        } catch (error) {
          const partialPath = preserveInterruptedOutput(
            pending.outputPath,
            pending.stagingPath,
            id,
          );
          this.pendingOutputs.delete(id);
          const failed = {
            id,
            outputPath: pending.outputPath,
            error: `Could not commit rendered recording: ${error.message}`,
            partialPath,
          };
          this.emit("failed", failed);
          this.emit("message", { type: "failed", ...failed });
        }
        return;
      }

      const partialPath = preserveInterruptedOutput(pending.outputPath, pending.stagingPath, id);
      this.pendingOutputs.delete(id);
      const failed = { ...message, outputPath: pending.outputPath, partialPath };
      this.emit("failed", failed);
      this.emit("message", failed);
      return;
    }
    this.emit(message.type, message);
    this.emit("message", message);
  }

  clearStartPromise() {
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
  }

  rejectStart(error) {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const reject = this.startReject;
    this.clearStartPromise();
    reject?.(error);
  }

  scheduleRestart() {
    if (this.restartTimer || !this.enabled || this.restartBlockedError) return;
    const delays = [5_000, 15_000, 30_000, 60_000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
    this.restartAttempt += 1;
    this.emit("restart-scheduled", { delay, attempt: this.restartAttempt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.enabled) return;
      this.ensureStarted("automatic-restart").catch(() => {});
    }, delay);
    this.restartTimer.unref?.();
  }

  async trigger(payload = {}) {
    let eventAtUnixMs = Number.isFinite(payload.eventAtUnixMs)
      ? payload.eventAtUnixMs
      : Date.now();
    if (!this.enabled) {
      const error = new Error("Achievement recorder is disabled");
      error.code = "recorder-disabled";
      throw error;
    }
    let waitedForMonitor = false;
    do {
      if (this.monitorChangePromise) { waitedForMonitor = true; await this.monitorChangePromise; }
      await this.ensureStarted("achievement-trigger");
    } while (this.monitorChangePromise);
    // An old timestamp can be outside the new monitor's replay buffer. Record
    // from the new source's ready point rather than creating an empty clip.
    if (waitedForMonitor) eventAtUnixMs = Math.max(eventAtUnixMs, Date.now());
    if (!this.enabled || this.stopping || (this.child && this.exitedChild === this.child)) {
      const error = new Error("Achievement recorder stopped before accepting the trigger");
      error.code = "recorder-disabled";
      throw error;
    }
    const outputPath = String(payload.outputPath || "").trim();
    if (!outputPath) {
      throw new TypeError("Achievement recorder output path is required");
    }
    const id = String(payload.id || crypto.randomUUID());
    if (!this.child?.stdin?.writable) {
      const error = new Error("Achievement recorder input is unavailable");
      error.code = "recorder-input-unavailable";
      throw error;
    }
    const stagingPath = getStagingOutputPath(outputPath, id);
    const stagingFd = fs.openSync(stagingPath, "wx");
    fs.closeSync(stagingFd);
    const command = JSON.stringify({ type: "trigger", id, outputPath: stagingPath, eventAtUnixMs });
    this.pendingOutputs.set(id, { outputPath, stagingPath });
    try {
      this.child.stdin.write(`${command}\n`);
    } catch (error) {
      this.pendingOutputs.delete(id);
      try {
        fs.rmSync(stagingPath, { force: true });
      } catch {}
      removeEmptyFile(outputPath);
      throw error;
    }
    return { id, outputPath };
  }

  cleanupPendingOutputs(reason = "unknown") {
    for (const [id, pending] of this.pendingOutputs) {
      const partialPath = preserveInterruptedOutput(
        pending.outputPath,
        pending.stagingPath,
        id,
      );
      this.emit("cancelled", {
        id,
        outputPath: pending.outputPath,
        partialPath,
        reason,
      });
    }
    this.pendingOutputs.clear();
  }

  forceStop(reason = "unknown") {
    this.clearActivityWatchdog();
    this.enabled = false;
    this.restartAttempt = 0;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    if (!child) {
      this.stopReason = null;
      this.cleanupPendingOutputs(reason);
      this.ready = false;
      return false;
    }
    this.stopReason = reason;
    this.emit("stopping", { reason, pid: child.pid || null, forced: true });
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
    } catch {}
    // Give the native helper time to finalize its capture pipeline and remove
    // the per-process buffer directory. A hard kill is retained as a bounded
    // fallback for a helper that no longer responds to the protocol command.
    const killTimer = setTimeout(() => {
      if (this.child !== child || child.killed) return;
      try {
        child.kill();
      } catch {}
    }, this.forceStopGraceMs);
    killTimer.unref?.();
    child.once("exit", () => clearTimeout(killTimer));
    return true;
  }

  stop(reason = "unknown") {
    this.enabled = false;
    this.restartAttempt = 0;
    return this.stopChild(reason);
  }

  stopChild(reason = "unknown") {
    this.clearActivityWatchdog();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    if (this.stopPromise) return this.stopPromise;
    if (!child) {
      this.stopReason = null;
      this.ready = false;
      this.rejectStart(new Error("Achievement recorder stopped"));
      this.cleanupPendingOutputs(reason);
      return Promise.resolve(false);
    }
    this.stopping = true;
    this.stopReason = reason;
    this.emit("stopping", { reason, pid: child.pid || null });
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
    } catch {}
    this.stopPromise = new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.stopPromise = null;
        resolve(true);
      };
      this.childClosePromise.then(finish);
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
      }, this.forceStopGraceMs);
      timer.unref?.();
    });
    return this.stopPromise;
  }
}

module.exports = {
  AchievementRecorderController,
  DEFAULT_FORCE_STOP_GRACE_MS,
  DEFAULT_RECORDER_TIMINGS,
  parseRecorderProtocolLine,
  resolveAchievementRecorderHelper,
};
