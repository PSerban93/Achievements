const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const crypto = require("crypto");

const DEFAULT_RECORDER_TIMINGS = Object.freeze({
  preMs: 10_000,
  postMs: 10_000,
  segmentMs: 2_000,
  fps: 30,
  hdrToneMapping: false,
});

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
    this.ready = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = null;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.stopping = false;
    this.stopPromise = null;
    this.pendingOutputs = new Map();
  }

  get status() {
    return {
      enabled: this.enabled,
      running: !!this.child && !this.child.killed,
      ready: this.ready,
      pid: this.child?.pid || null,
    };
  }

  updateTimings(nextTimings = {}) {
    const normalized = {
      preMs: Math.max(1_000, Number(nextTimings.preMs) || this.timings.preMs),
      postMs: Math.max(1_000, Number(nextTimings.postMs) || this.timings.postMs),
      segmentMs: Math.max(
        1_000,
        Number(nextTimings.segmentMs) || this.timings.segmentMs,
      ),
      fps: [30, 60].includes(Number(nextTimings.fps))
        ? Number(nextTimings.fps)
        : this.timings.fps,
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
      const previous = { ...this.timings };
      this.timings = normalized;
      this.emit("timings-changed", { previous, current: { ...normalized } });
    }
    return changed;
  }

  async restart(reason = "configuration-changed") {
    if (!this.enabled) return false;
    await this.stopChild(reason);
    return this.enabled ? this.ensureStarted(`${reason}:restart`) : false;
  }

  setEnabled(enabled, reason = "unknown") {
    this.enabled = enabled === true;
    if (!this.enabled) {
      this.restartAttempt = 0;
      return this.stop(reason);
    }
    if (this.stopping && this.stopPromise) {
      return this.stopPromise.then(() =>
        this.enabled ? this.ensureStarted(`${reason}:after-stop`) : false,
      );
    }
    return this.ensureStarted(reason);
  }

  ensureStarted(reason = "unknown") {
    if (!this.enabled) return Promise.resolve(false);
    if (this.ready && this.child && !this.child.killed) {
      return Promise.resolve(true);
    }
    if (this.startPromise) return this.startPromise;

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
    const child = this.spawnProcess(helper, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.emit("starting", { reason, helper, pid: child.pid || null });

    const output = readline.createInterface({ input: child.stdout });
    output.on("line", (line) => {
      try {
        const message = parseRecorderProtocolLine(line);
        if (!message) return;
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
    child.once("error", (error) => {
      this.rejectStart(error);
      this.emit("recorder-error", error);
    });
    child.once("exit", (code, signal) => {
      output.close();
      const wasStopping = this.stopping;
      const wasReady = this.ready;
      this.ready = false;
      this.child = null;
      const error = new Error(
        `Achievement recorder exited (code=${code}, signal=${signal || ""})${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      );
      error.code = "recorder-exited";
      this.rejectStart(error);
      this.emit("exit", { code, signal, wasReady, expected: wasStopping });
      this.cleanupPendingOutputs("helper-exit");
      this.stopping = false;
      if (this.enabled && !wasStopping) this.scheduleRestart();
    });
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
    if (message.type === "ready") {
      this.ready = true;
      this.restartAttempt = 0;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      const resolve = this.startResolve;
      this.clearStartPromise();
      resolve?.(true);
      this.emit("ready", message);
      return;
    }
    if (message.type === "fatal") {
      const error = new Error(message.error || "Achievement recorder failed");
      error.code = "recorder-fatal";
      this.emit("recorder-error", error);
      return;
    }
    if (message.type === "saved" || message.type === "failed") {
      const id = String(message.id || "").trim();
      if (id) this.pendingOutputs.delete(id);
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
    if (this.restartTimer || !this.enabled) return;
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
    if (!this.enabled) {
      const error = new Error("Achievement recorder is disabled");
      error.code = "recorder-disabled";
      throw error;
    }
    await this.ensureStarted("achievement-trigger");
    const outputPath = String(payload.outputPath || "").trim();
    if (!outputPath) {
      throw new TypeError("Achievement recorder output path is required");
    }
    const id = String(payload.id || crypto.randomUUID());
    const command = JSON.stringify({ type: "trigger", id, outputPath });
    if (!this.child?.stdin?.writable) {
      const error = new Error("Achievement recorder input is unavailable");
      error.code = "recorder-input-unavailable";
      throw error;
    }
    this.pendingOutputs.set(id, outputPath);
    this.child.stdin.write(`${command}\n`);
    return { id, outputPath };
  }

  cleanupPendingOutputs(reason = "unknown") {
    for (const [id, outputPath] of this.pendingOutputs) {
      try {
        const stat = fs.statSync(outputPath);
        if (stat.isFile() && stat.size === 0) fs.rmSync(outputPath, { force: true });
      } catch {}
      this.emit("cancelled", { id, outputPath, reason });
    }
    this.pendingOutputs.clear();
  }

  forceStop(reason = "unknown") {
    this.enabled = false;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    this.cleanupPendingOutputs(reason);
    if (!child) {
      this.ready = false;
      return false;
    }
    this.emit("stopping", { reason, pid: child.pid || null, forced: true });
    try {
      if (child.stdin?.writable) {
        child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      }
    } catch {}
    try {
      child.kill();
    } catch {}
    return true;
  }

  stop(reason = "unknown") {
    this.enabled = false;
    return this.stopChild(reason);
  }

  stopChild(reason = "unknown") {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const child = this.child;
    if (this.stopPromise) return this.stopPromise;
    if (!child) {
      this.ready = false;
      this.rejectStart(new Error("Achievement recorder stopped"));
      this.cleanupPendingOutputs(reason);
      return Promise.resolve(false);
    }
    this.stopping = true;
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
      child.once("exit", finish);
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish();
      }, 4_000);
      timer.unref?.();
    });
    return this.stopPromise;
  }
}

module.exports = {
  AchievementRecorderController,
  DEFAULT_RECORDER_TIMINGS,
  parseRecorderProtocolLine,
  resolveAchievementRecorderHelper,
};
