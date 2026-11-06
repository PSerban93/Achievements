"use strict";

const fs = require("fs");
const path = require("path");
const finder = require("./game-executable-finder");
const { writeJsonAtomicSync } = require("./atomic-json-store");

// Registration is deliberately separate from discovery so the same read-only
// finder can be audited with copied configs under plain Node, outside the app.
function registerExecutableFinder({ ipcMain, dialog, configsDir, getWindow, t, logger, changed, write = writeJsonAtomicSync }) {
  let active = null;
  const allowed = (event) => event.sender === getWindow()?.webContents && event.senderFrame === event.sender.mainFrame;
  const configFile = (name) => {
    if (typeof name !== "string" || !name || path.basename(name) !== name || /[\\/\x00]/.test(name)) throw new Error("Invalid config name");
    const file = path.join(configsDir, name + ".json");
    if (!fs.existsSync(file)) throw new Error("Config not found");
    return file;
  };
  const read = (name) => JSON.parse(fs.readFileSync(configFile(name), "utf8"));
  function persist(name, original, candidate) {
    // Re-read immediately before the atomic write: AE's own exporter or the
    // config editor may have filled the field while discovery was in progress.
    const file = configFile(name), latest = read(name);
    if (String(latest.executable || "").trim()) return false;
    if (String(latest.appid) !== String(original.appid) || latest.platform !== original.platform || latest.save_path !== original.save_path) return false;
    finder.applyCandidate(latest, candidate);
    write(file, latest, { attempts: 1 });
    logger.info("executable-finder:saved", { configName: name, executable: latest.executable, source: candidate.source });
    changed(); return true;
  }
  function begin(event, mode) {
    if (!allowed(event)) throw new Error("Invalid sender");
    if (active) return null;
    const job = { controller: new AbortController(), sender: event.sender, mode, startedAt: Date.now() };
    active = job; return job;
  }
  const send = (job, value) => { if (!job.sender.isDestroyed()) job.sender.send("executable-finder:progress", value); };
  async function search(config, options, mode, configName) {
    const result = await finder.findExecutable(config, options);
    const level = result.truncated || result.diagnostics?.issues?.length ? "warn" : "info";
    logger[level]("executable-finder:search", { configName: configName || config.name || "", mode,
      status: result.status, source: result.candidate?.source || null, candidates: result.candidates?.length || 0,
      processNames: config.process_name || null,
      candidatePaths: (result.candidates || []).slice(0, 10).map(row => row.executable),
      truncated: !!result.truncated, diagnostics: result.diagnostics || null });
    return result;
  }
  ipcMain.handle("executable-finder:cancel", (event) => {
    if (!allowed(event)) throw new Error("Invalid sender");
    logger.info("executable-finder:cancel-requested", { active: !!active, mode: active?.mode || null, alreadyCancelled: !!active?.controller.signal.aborted });
    active?.controller.abort(); return true;
  });
  ipcMain.handle("executable-finder:one", async (event, payload = {}) => {
    const job = begin(event, "one"); if (!job) return { status: "busy" };
    try {
      const original = payload.name ? read(payload.name) : {};
      const config = payload.persist ? original : { ...original, ...payload.draft };
      if (String(config.executable || "").trim()) return { status: "existing" };
      let lastProgressAt = 0;
      const onProgress = p => {
        const now = Date.now();
        if (now - lastProgressAt >= 100) { lastProgressAt = now; send(job, { ...p, mode: "one" }); }
      };
      // Interactive Find should reach the folder picker promptly. Regeneration
      // and Find All retain their own budgets; a chosen folder gets a fresh one.
      let context = finder.createSearchContext({ signal: job.controller.signal, timeLimitMs: 5_000, onProgress });
      let result = await search(config, { context, extended: true }, "one", payload.name);
      const canChooseFolder = String(config.platform).toLowerCase() !== "epic-official";
      const chooseCandidate = async (value, offerFolder) => {
        if (!value.candidates?.length || !["ambiguous", "incomplete"].includes(value.status)) return {};
        context.check();
        const rows = value.candidates.slice(0, 10);
        const buttons = [t("cancel"), ...rows.map((r, i) => `${i + 1}. ${path.basename(r.executable)}`)];
        if (offerFolder && canChooseFolder) buttons.push(t("executableFinder.chooseFolder"));
        const choice = await dialog.showMessageBox(getWindow(), { type: "question", title: t("executableFinder.title"),
          message: t("executableFinder.choose"), detail: rows.map((r, i) => `${i + 1}. ${r.executable}`).join("\n\n"),
          buttons, cancelId: 0, defaultId: 0 });
        context.check();
        if (!Number.isInteger(choice.response) || choice.response <= 0) return { cancelled: true };
        if (choice.response <= rows.length) return { candidate: rows[choice.response - 1] };
        return offerFolder && canChooseFolder && choice.response === rows.length + 1 ? { folder: true } : { cancelled: true };
      };
      let choice = await chooseCandidate(result, true);
      if (choice.cancelled) return { status: "cancelled" };
      let candidate = result.candidate || choice.candidate;
      if (!candidate && canChooseFolder && (choice.folder || ["not-found", "incomplete"].includes(result.status))) {
        context.check();
        logger.info("executable-finder:folder-prompt", { configName: payload.name || config.name || "",
          elapsedMs: Date.now() - job.startedAt, searchStatus: result.status, truncated: !!result.truncated });
        const selection = await dialog.showOpenDialog(getWindow(), { title: t("executableFinder.chooseFolder"), properties: ["openDirectory"] });
        context.check();
        if (selection.canceled || !selection.filePaths[0]) return { status: "cancelled" };
        context = finder.createSearchContext({ signal: job.controller.signal, timeLimitMs: 20_000, onProgress });
        result = await search(config, { context, folder: selection.filePaths[0] }, "folder", payload.name);
        choice = await chooseCandidate(result, false);
        if (choice.cancelled) return { status: "cancelled" };
        candidate = result.candidate || choice.candidate;
      }
      context.check();
      if (!candidate) return { status: result.status === "ambiguous" ? "cancelled" : result.truncated ? "error" : result.status,
        truncated: result.truncated, ...(result.truncated ? { reason: "incomplete-search" } : {}) };
      const saved = payload.persist ? persist(payload.name, original, candidate) : false;
      return { status: payload.persist && !saved ? "existing" : "found", candidate, saved };
    } catch (error) {
      if (error.code === "ABORT_ERR") return { status: "cancelled" };
      logger.warn("executable-finder:failed", { error: error.message });
      return { status: "error", error: error.message };
    } finally { if (active === job) active = null; }
  });
  ipcMain.handle("executable-finder:all", async (event) => {
    const job = begin(event, "all"); if (!job) return { status: "busy" };
    const result = { status: "complete", checked: 0, updated: 0, ambiguous: 0, missing: 0, errors: 0, ambiguousConfigs: [], errorConfigs: [] };
    const recordError = (name, code) => { result.errors++; result.errorConfigs.push({ name, code: code || "SEARCH_ERROR" }); };
    try {
      const configs = fs.readdirSync(configsDir).filter(f => f.toLowerCase().endsWith(".json")).flatMap(file => {
        const name = file.slice(0, -5);
        try {
          const c = read(name);
          if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Invalid config");
          return !String(c.executable || "").trim() && finder.supported(c) ? [{ name, config: c }] : [];
        } catch (error) {
          recordError(name, error.code || "CONFIG_READ_ERROR"); result.checked++;
          logger.warn("executable-finder:config-failed", { configName: name, error: error.message });
          return [];
        }
      });
      result.total = configs.length + result.checked;
      const readErrors = [...result.errorConfigs], outcomes = new Map();
      let refreshTruncated = false;
      const totals = () => {
        result.checked = readErrors.length + outcomes.size;
        result.updated = 0; result.ambiguous = 0; result.missing = 0;
        result.errors = readErrors.length; result.ambiguousConfigs = []; result.errorConfigs = [...readErrors];
        for (const [name, outcome] of outcomes) {
          if (outcome.kind === "updated") result.updated++;
          else if (outcome.kind === "ambiguous") { result.ambiguous++; result.ambiguousConfigs.push(name); }
          else if (outcome.kind === "missing") result.missing++;
          else if (outcome.kind === "error") { result.errors++; result.errorConfigs.push({ name, code: outcome.code }); }
        }
        result.truncated = refreshTruncated || [...outcomes.values()].some(value => value.truncated);
      };
      const accept = (item, found) => {
        let outcome;
        if (found.truncated) {
          const budgetLimited = found.diagnostics?.limits?.some(reason => reason !== "unreadable-path");
          outcome = { kind: "error", truncated: true, code: budgetLimited ? "INCOMPLETE_SEARCH" : found.diagnostics?.issues?.[0]?.code || "INCOMPLETE_SEARCH" };
        } else if (found.status === "found") outcome = { kind: persist(item.name, item.config, found.candidate) ? "updated" : "existing" };
        else outcome = { kind: found.status === "ambiguous" ? "ambiguous" : "missing" };
        outcomes.set(item.name, outcome); totals();
      };
      let currentConfigName = "";
      const context = finder.createSearchContext({ signal: job.controller.signal, timeLimitMs: 180_000, maxDirectories: 10000,
        reuseFilesystemIndex: true, batchSnapshot: true, filesystemRetries: 3, filesystemTimeLimitMs: 180_000,
        onVolumeUnavailable: progress => logger.warn("executable-finder:volume-unavailable", { mode: "all", ...progress }),
        onFilesystemRetry: progress => logger.info("executable-finder:retry", { configName: currentConfigName, mode: "all", ...progress }) });
      for (const item of configs) {
        context.check();
        currentConfigName = item.name;
        // Detailed lists are returned once at completion, not copied on every
        // progress update as a large batch accumulates results.
        send(job, { mode: "all", status: result.status, checked: result.checked, updated: result.updated,
          ambiguous: result.ambiguous, missing: result.missing, errors: result.errors, total: result.total, name: item.name });
        try {
          const found = await search(item.config, { context, extended: true }, "all", item.name);
          context.check();
          accept(item, found);
        } catch (error) {
          if (error.code === "ABORT_ERR") throw error;
          outcomes.set(item.name, { kind: "error", code: error.code || "SEARCH_ERROR" }); totals();
          logger.warn("executable-finder:config-failed", { configName: item.name, error: error.message });
        }
      }
      const pending = configs.filter(item => ["missing", "ambiguous"].includes(outcomes.get(item.name)?.kind) || outcomes.get(item.name)?.truncated);
      if (pending.length && context.refreshBatch) {
        currentConfigName = "";
        send(job, { mode: "all", name: t("executableFinder.searching"), checked: result.checked, total: result.total + 1 });
        const started = Date.now(), refresh = await context.refreshBatch(); context.check();
        logger.info("executable-finder:batch-revalidation", { elapsedMs: Date.now() - started, ...refresh });
        refreshTruncated = !!refresh.truncated;
        const retry = pending.filter(item => refresh.changed || finder.hasExecutableHints(item.config));
        let rechecked = 0;
        for (const item of retry) {
          context.check(); currentConfigName = item.name;
          send(job, { mode: "all", name: item.name, checked: result.total + rechecked++, total: result.total + retry.length });
          try {
            if (!fs.existsSync(path.join(configsDir, item.name + ".json"))) { outcomes.set(item.name, { kind: "existing" }); totals(); continue; }
            const latest = read(item.name);
            const edited = ["name", "displayName", "appid", "platform", "save_path", "process_name", "launch_metadata",
              "install_root", "install_path", "arguments", "working_directory", "steamAppId", "epic_namespace", "epic_catalog_item_id", "epic_app_name"]
              .some(field => JSON.stringify(latest[field]) !== JSON.stringify(item.config[field]));
            if (edited || String(latest.executable || "").trim() || !finder.supported(latest)) { outcomes.set(item.name, { kind: "existing" }); totals(); continue; }
            const found = await search(latest, { context, extended: true }, "all-recheck", item.name); context.check();
            accept({ name: item.name, config: latest }, found);
          } catch (error) {
            if (error.code === "ABORT_ERR") throw error;
            outcomes.set(item.name, { kind: "error", code: error.code || "SEARCH_ERROR" });
            logger.warn("executable-finder:config-failed", { configName: item.name, phase: "recheck", error: error.message });
          }
        }
        if (context.hasCompleteInventory) refreshTruncated = false;
        totals();
      }
    } catch (error) { result.status = error.code === "ABORT_ERR" ? "cancelled" : "error"; if (result.status === "error") { result.errors++; result.errorCode = error.code || "SEARCH_ERROR"; } }
    finally { if (active === job) active = null; send(job, { mode: "all", ...result, done: true }); }
    logger.info("executable-finder:batch-finished", result); return result;
  });
  return { cancel: () => active?.controller.abort() };
}
module.exports = { registerExecutableFinder };
