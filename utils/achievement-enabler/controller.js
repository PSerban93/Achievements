"use strict";

const path = require("path");
const crypto = require("crypto");
const { createEnablerStore, RELEASES_URL, ISSUES_URL } = require("./store");
const { isTerminalStatus } = require("./completion");

function createEnablerController({ app, ipcMain, dialog, shell, utilityProcess, getParent, getPreferences, getThemes, logger, storeOptions = {} }) {
  let window = null, worker = null, gameFolder = "", preparing = null;
  let run = { status: "idle", runId: "", exitCode: null, activeProcesses: 0 };
  let transcript = "", outputSequence = 0, disposed = false, operation = false;
  const ownedWorkers = new Set();
  const feature = path.join(app.getAppPath(), "utils", "achievement-enabler");
  const nativeFeature = app.getAppPath().endsWith(".asar")
    ? path.join(`${app.getAppPath()}.unpacked`, "utils", "achievement-enabler") : feature;
  const store = createEnablerStore({ userData: app.getPath("userData"), logger, ...storeOptions,
    onProgress: progress => send("download", progress) });
  const active = () => ["preparing", "running", "auxiliary"].includes(run.status);
  function snapshot() { return { ...store.snapshot(), run: { ...run }, gameFolder, operation, supported: process.platform === "win32" && process.arch === "x64" }; }
  function send(type, payload) {
    if (window && !window.isDestroyed()) window.webContents.send("achievement-enabler:event", { type, payload });
  }
  function publish() { send("state", snapshot()); }
  function updateRun(patch) {
    const previous = run.status;
    run = { ...run, ...patch };
    if (previous !== run.status) logger?.info("enabler:session-state", { runId: run.runId, status: run.status, exitCode: run.exitCode, activeProcesses: run.activeProcesses,
      completionReason: run.completionReason || "", resultReason: run.resultReason || "",
      hasWarnings: run.hasWarnings === true, hasErrors: run.hasErrors === true, cleanupPending: run.cleanupPending === true });
    publish();
  }
  function requireIdle() { if (active() || store.snapshot().downloading) throw new Error("An operation is already running."); }
  async function start() {
    requireIdle();
    if (!snapshot().supported) throw new Error("Achievement Enabler requires Windows x64.");
    if (!gameFolder) throw new Error("Select a game folder first.");
    transcript = ""; outputSequence = 0;
    run = { status: "preparing", runId: crypto.randomUUID(), exitCode: null, activeProcesses: 0 };
    preparing = new AbortController(); const pending = preparing;
    let stage = "preparing";
    publish();
    try {
      const prepared = await store.prepareGame(gameFolder, pending.signal);
      pending.signal.throwIfAborted();
      stage = "starting-worker";
      const child = utilityProcess.fork(path.join(nativeFeature, "worker.js"), [], {
        serviceName: "Achievement Enabler", stdio: "pipe",
      });
      worker = child; preparing = null;
      ownedWorkers.add(child);
      const childRunId = run.runId;
      const releaseWorker = () => { ownedWorkers.delete(child); if (worker === child) worker = null; child.kill(); };
      const finishHelpers = (error = false) => {
        if (run.runId === childRunId) updateRun({ activeProcesses: 0, cleanupPending: false,
          ...(error ? { hasErrors: true, status: run.status === "finished" ? "warning" : run.status } : {}) });
      };
      child.on("message", message => {
        if (!ownedWorkers.has(child) || message.runId !== childRunId) return;
        if (worker !== child) {
          if (message.type === "state" && message.cleanupPending === false) {
            finishHelpers(!!message.error);
            if (message.error) logger?.warn("enabler:helper-error", { runId: childRunId, error: message.error });
            else logger?.info("enabler:helpers-finished", { runId: childRunId, status: message.status, exitCode: message.exitCode });
            releaseWorker();
          } else if (message.type === "error" && message.fatal) {
            logger?.warn("enabler:helper-error", { runId: childRunId, error: message.error });
            finishHelpers(true);
            releaseWorker();
          }
          return;
        }
        if (childRunId !== run.runId) return;
        if (message.type === "output") {
          const data = String(message.data || "");
          transcript = (transcript + data).slice(-250000);
          send("output", { runId: run.runId, data, sequence: ++outputSequence });
        } else if (message.type === "state") {
          updateRun({ status: message.status, exitCode: message.exitCode ?? null, activeProcesses: message.activeProcesses || 0, error: message.error || "",
            completionReason: message.completionReason || "", cleanupPending: message.cleanupPending === true,
            resultReason: message.resultReason || "", hasWarnings: message.hasWarnings === true, hasErrors: message.hasErrors === true });
          if (isTerminalStatus(message.status)) {
            if (message.cleanupPending) worker = null;
            else releaseWorker();
          }
        } else if (message.type === "error") {
          logger?.warn("enabler:worker-error", { runId: run.runId, error: message.error });
          if (message.fatal) { updateRun({ status: "failed", error: message.error }); releaseWorker(); }
          else send("error", { error: message.error });
        }
      });
      child.on("exit", code => {
        const owned = ownedWorkers.delete(child);
        if (worker !== child) {
          if (owned && !disposed) {
            finishHelpers(true);
            logger?.warn("enabler:helper-exited", { runId: childRunId, exitCode: code });
          }
          return;
        }
        worker = null;
        if (owned && active()) updateRun({ status: "failed", error: `Runner exited (${code}).`, activeProcesses: 0 });
      });
      // Diagnostic streams are not the original script's terminal output. Do not
      // persist input/output: upstream prompts may contain authentication data.
      child.stderr?.on("data", () => {});
      child.stdout?.on("data", () => {});
      child.postMessage({ type: "start", runId: run.runId, script: prepared.script, folder: prepared.folder,
        appPath: app.getAppPath(), gatePath: path.join(nativeFeature, "gate.ps1") });
      logger?.info("enabler:session-start", { runId: run.runId, folder: prepared.folder, version: prepared.version });
      return snapshot();
    } catch (error) {
      preparing = null;
      if (!pending.signal.aborted) logger?.warn("enabler:session-start-failed", {
        runId: run.runId, stage, folder: gameFolder, code: error.code || "", syscall: error.syscall || "",
        path: error.path || "", dest: error.dest || "", error: error.message,
      });
      updateRun({ status: pending.signal.aborted ? "stopped" : "failed", error: pending.signal.aborted ? "" : error.message });
      if (pending.signal.aborted) return snapshot();
      throw error;
    }
  }
  async function executeCommand(action, payload = {}) {
    if (disposed) throw new Error("Achievement Enabler is closed.");
    switch (action) {
      case "bootstrap": {
        await store.recover();
        const prefs = getPreferences() || {};
        return { state: snapshot(), transcript, outputSequence, preferences: { uiLanguage: prefs.uiLanguage || "english", appTheme: prefs.appTheme || "dracula" }, themes: getThemes?.()?.themes || [] };
      }
      case "state": return snapshot();
      case "check": requireIdle(); await store.check(true); publish(); return snapshot();
      case "download": requireIdle(); {
        const promise = store.install(); publish();
        try { await promise; }
        catch (error) { if (error.name !== "AbortError") throw error; }
        finally { publish(); }
        return snapshot();
      }
      case "acknowledge": requireIdle(); await store.acknowledge(payload.checked !== false); publish(); return snapshot();
      case "choose-game": {
        requireIdle();
        const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"], defaultPath: gameFolder || undefined });
        if (!result.canceled && result.filePaths[0]) gameFolder = result.filePaths[0];
        publish(); return snapshot();
      }
      case "open-folder": {
        const folder = store.snapshot().folder;
        if (!folder) throw new Error("Download Achievement Enabler first.");
        const error = await shell.openPath(folder); if (error) throw new Error(error); return true;
      }
      case "instructions": await shell.openExternal(RELEASES_URL); return true;
      case "report-issue": await shell.openExternal(ISSUES_URL); return true;
      case "start": return start();
      case "input":
        if (!worker || run.status !== "running" || payload.runId !== run.runId || typeof payload.text !== "string" || payload.text.length > 4096) throw new Error("The script is not accepting input.");
        worker.postMessage({ type: "input", runId: run.runId, text: payload.text, raw: payload.raw === true }); return true;
      case "resize":
        if (worker && payload.runId === run.runId) worker.postMessage({ type: "resize", runId: run.runId, cols: payload.cols, rows: payload.rows }); return true;
      case "stop":
        store.cancelDownload();
        if (preparing) preparing.abort();
        if (worker) worker.postMessage({ type: "stop", runId: run.runId });
        return true;
      default: throw new Error("Unknown Achievement Enabler operation.");
    }
  }
  async function command(action, payload) {
    if (!["check", "download", "acknowledge", "choose-game", "start"].includes(action)) return executeCommand(action, payload);
    if (operation) throw new Error("An operation is already running.");
    requireIdle(); operation = true; publish();
    try { await executeCommand(action, payload); }
    finally { operation = false; publish(); }
    return snapshot();
  }
  ipcMain.handle("achievement-enabler:command", async (event, action, payload) => {
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) throw new Error("Invalid Achievement Enabler sender.");
    try { return { ok: true, value: await command(action, payload) }; }
    catch (error) { return { ok: false, error: error.message || String(error) }; }
  });
  function open() {
    if (disposed) return;
    const parent = getParent();
    if (!parent || parent.isDestroyed()) throw new Error("The application window is not available.");
    window = parent;
    return snapshot();
  }
  function dispose() {
    disposed = true; store.cancelDownload(); preparing?.abort();
    for (const child of ownedWorkers) child.kill();
    ownedWorkers.clear(); worker = null;
    window = null;
  }
  return { open, dispose, snapshot, command };
}

module.exports = { createEnablerController };
