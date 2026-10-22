"use strict";

const fs = require("fs").promises;
const path = require("path");
const chokidar = require("chokidar");
const { Worker } = require("node:worker_threads");
const state = require("./x360-recomp-state");
const { inside } = require("./x360-recomp-discovery");

// One discovery watcher for all imported games awaiting a source. It does not
// generate configs or invoke the generic Steam/Uplay/GOG/Epic cascade.
function createProgressDiscovery(options) {
  const records = new Map(), requests = new Map(), inFlight = new Map();
  let watcher, worker, anchors = new Set(), serial = Promise.resolve(), requestId = 0, stopped = false;
  const key = (file) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const blocked = (file) => options.isBlocked?.(file) === true;
  const unresolved = () => [...records.values()].filter((record) => !state.hasConfirmedProgress(record.config) &&
    !/ambiguous/i.test(record.config.x360_recomp_progress_reason || ""));
  const rootsFor = (record) => [record.config.x360_recomp_install_root, options.documentsPath,
    ...(record.config.x360_recomp_discovery_roots || []),
    ...Object.values(record.config.x360_recomp_progress || {}).flatMap((entry) =>
      [entry.directory, entry.file && path.dirname(entry.file)])].filter((file) => file && !blocked(file));
  const cachePath = (file) => [...records.values()].some(({ config }) => {
    const root = config.x360_recomp_install_root;
    return root && inside(root, file) && /(?:^|[\\/])(?:cache|shader_cache|shaders)(?:[\\/]|$)/i.test(path.relative(root, file));
  });
  const relevantFile = (file) => /^(?:[a-f0-9]{8}\.toml|[a-f0-9]{16}\.tsv|achievements\.json|ach-data)$/i.test(path.basename(file)) ||
    path.basename(file).toLowerCase() === "achievements.ini" && unresolved().some(({ config }) =>
      config.x360_recomp_generic === true && inside(config.x360_recomp_install_root, file)) ||
    unresolved().some(({ config }) => Object.values(config.x360_recomp_progress || {}).some((entry) => state.samePath(entry.file, file)));
  function failRequests(error) {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error); }
    requests.clear();
  }
  function request(payload, timeout = 15000) {
    if (stopped) return Promise.reject(new Error("Recomp discovery closed"));
    if (!worker) {
      const active = worker = new Worker(path.join(__dirname, "x360-recomp-progress-worker.js"));
      active.unref();
      active.on("message", (message) => {
        const request = requests.get(message.requestId);
        if (!request) return;
        requests.delete(message.requestId); clearTimeout(request.timer);
        if (message.discoveryError) request.reject(new Error(message.error));
        else request.resolve(message.discovery || message.item);
      });
      active.on("error", failRequests);
      active.on("exit", () => { if (worker === active) worker = null; failRequests(new Error("Recomp progress reader exited")); });
    }
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error("Recomp progress validation timed out")); }, timeout);
      timer.unref?.();
      requests.set(id, { resolve, reject, timer });
      worker.postMessage({ requestId: id, ...payload });
    });
  }
  async function readCandidate(file, configName, live = true) {
    if (stopped || blocked(file)) return;
    const candidates = configName ? [records.get(configName)].filter(Boolean) : unresolved();
    if (!candidates.length) return;
    try {
      const declarations = candidates.flatMap(({ config }) => Object.entries(config.x360_recomp_progress || {}).filter(([, entry]) =>
        state.samePath(entry.file, file)).map(([profile, descriptor]) => ({ titleId: config.appid, profile, descriptor })));
      const local = candidates.filter(({ config }) => config.x360_recomp_generic === true && inside(config.x360_recomp_install_root, file));
      const owners = local.filter(({ config }) => !local.some(other =>
        !state.samePath(config.x360_recomp_install_root, other.config.x360_recomp_install_root) &&
        inside(config.x360_recomp_install_root, other.config.x360_recomp_install_root)));
      const implicitOwner = owners.length === 1 ? { titleId: owners[0].config.appid, installRoot: owners[0].config.x360_recomp_install_root } : null;
      const item = await request({ file, explicit: declarations.length === 1 ? declarations[0] : null, implicitOwner });
      if (!item || stopped || blocked(file)) return;
      let matches = candidates.filter(({ config }) => config.appid === item.id &&
        (configName || rootsFor({ config }).some((root) => inside(root, file))));
      // Multiple installations with the same TitleID require concrete path
      // ownership. A save somewhere in Documents alone cannot disambiguate.
      if (matches.length > 1) matches = matches.filter(({ config }) => inside(config.x360_recomp_install_root, file) ||
        Object.values(config.x360_recomp_progress || {}).some((entry) => state.samePath(entry.file, file) || entry.directory && inside(entry.directory, file)));
      if (matches.length !== 1) {
        if (matches.length > 1) options.onError?.("Ambiguous recomp progress source; manual Rescan required", { file });
        return;
      }
      const record = matches[0];
      if (records.get(record.config.name) !== record) return;
      if (record.config.x360_recomp_adapter === "reblue" && item.format === "toml") {
        const relative = path.relative(path.join(record.config.x360_recomp_install_root, "profiles"), file).split(path.sep);
        if (relative.length !== 3 || relative[1].toLowerCase() !== "achievements" || !state.validProfile(relative[0])) return;
        item.profile = relative[0]; item.userRoot = path.dirname(path.dirname(file));
      }
      const initialUnlock = Object.values(item.snapshot || {}).some((entry) => entry.earned_time >= record.since && entry.earned_time <= Date.now() / 1000 + 5);
      await options.onCandidate?.({ configName: record.config.name, item, since: record.since,
        live: live && item.mtimeMs >= record.since * 1000 || initialUnlock });
    } catch (error) { if (!stopped) options.onError?.(error.message, { file }); }
  }
  function consider(file, configName, live = true) {
    const fileKey = key(file);
    if (inFlight.has(fileKey)) return inFlight.get(fileKey);
    const operation = readCandidate(file, configName, live).finally(() => inFlight.delete(fileKey));
    inFlight.set(fileKey, operation);
    return operation;
  }
  async function reconcile() {
    if (stopped) return;
    const wanted = new Set();
    for (const record of unresolved()) for (const target of rootsFor(record)) {
      let anchor = target;
      while (true) {
        try { const stat = await fs.lstat(anchor); if (stat.isDirectory() && !stat.isSymbolicLink()) wanted.add(anchor); break; }
        catch (error) { if (error.code !== "ENOENT") break; }
        const parent = path.dirname(anchor);
        if (parent === anchor) break;
        anchor = parent;
      }
    }
    if (stopped) return;
    if (!wanted.size) {
      const previous = watcher; watcher = null; anchors.clear();
      if (previous) await previous.close();
      return;
    }
    if (!watcher) {
      const active = watcher = chokidar.watch([...wanted], {
        ignoreInitial: false, ignorePermissionErrors: true, followSymlinks: false, depth: 8,
        awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 75 },
        ignored: (file, stat) => {
          if (blocked(file) || cachePath(file) || /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/i.test(file)) return true;
          const pending = unresolved();
          const allowed = pending.flatMap(rootsFor).some((root) => inside(root, file) || inside(file, root));
          if (stat?.isDirectory() && options.documentsPath && inside(options.documentsPath, file)) {
            const parts = path.relative(options.documentsPath, file).split(path.sep).filter(Boolean);
            const explicit = pending.flatMap((record) => rootsFor(record).filter((root) => !state.samePath(root, options.documentsPath)))
              .some((root) => inside(root, file) || inside(file, root));
            if (!explicit && parts.length > 1 && !["achievements", "profiles", "save", "savedata", "geargame"].includes(parts[1].toLowerCase())) return true;
            if (!explicit && parts[1]?.toLowerCase() === "achievements" && parts.length > 2 &&
                !pending.some(({ config }) => parts[2].toUpperCase() === config.appid)) return true;
          }
          return !allowed || stat?.isFile() && !relevantFile(file);
        },
      });
      let ready = false;
      active.on("add", (file) => { void consider(file, null, ready); });
      active.on("change", (file) => { void consider(file, null, true); });
      active.on("error", (error) => options.onError?.(error.message, {}));
      active.once("ready", () => { ready = true; options.onWatching?.({ roots: [...wanted], pending: unresolved().length }); });
    } else {
      for (const anchor of anchors) if (!wanted.has(anchor)) await watcher.unwatch(anchor);
      const added = [...wanted].filter((anchor) => !anchors.has(anchor));
      if (added.length) watcher.add(added);
    }
    anchors = wanted;
  }
  function schedule() { serial = serial.catch(() => {}).then(reconcile).catch((error) => options.onError?.(error.message, {})); }
  return {
    register(config) {
      if (stopped || blocked(config.x360_recomp_install_root)) return;
      if (!state.hasConfirmedProgress(config) && options.isActive?.(config) === false) {
        if (records.delete(config.name)) schedule();
        return;
      }
      const old = records.get(config.name);
      const signature = JSON.stringify([config.x360_recomp_progress, config.x360_recomp_discovery_roots]);
      if (old?.signature === signature) { old.config = config; return; }
      records.set(config.name, { config, signature, since: old?.since || Math.floor(Date.now() / 1000) });
      schedule();
    },
    remove(name) { records.delete(name); schedule(); },
    prune(names) {
      const allowed = new Set(names);
      let changed = false;
      for (const name of records.keys()) if (!allowed.has(name)) { records.delete(name); changed = true; }
      if (changed) schedule();
    },
    consider: (file, configName) => consider(file, configName, true),
    isCachePath: cachePath,
    discover: (root, configs, blockedPaths, skipExisting) => request({ root, configs, blockedPaths, skipExisting,
      explicit: { documentsPath: options.documentsPath, appDataPath: options.appDataPath } }, 120000),
    isCandidate(file) {
      return [...records.values()].some(({ config }) => {
        const base = path.basename(file).toUpperCase();
        return base === `${config.appid}.TOML` && path.basename(path.dirname(file)).toLowerCase() === "achievements" ||
          /^[A-F0-9]{16}\.TSV$/.test(base) && path.basename(path.dirname(file)).toUpperCase() === config.appid &&
            path.basename(path.dirname(path.dirname(file))).toLowerCase() === "achievements" ||
          Object.values(config.x360_recomp_progress || {}).some((entry) => state.samePath(entry.file, file));
      });
    },
    ownsFile(file) {
      return [...records.values()].some(({ config }) => state.hasConfirmedProgress(config) &&
        Object.values(config.x360_recomp_progress || {}).some((entry) => state.hasConfirmedProgress({ x360_recomp_progress: { entry } }) &&
          (state.samePath(entry.file, file) || entry.format === "tsv" && state.samePath(path.dirname(entry.file), path.dirname(file)) && /^[a-f0-9]{16}\.tsv$/i.test(path.basename(file)))));
    },
    ownsDirectory(directory) {
      return [...records.values()].some(({ config }) => state.hasConfirmedProgress(config) &&
        Object.values(config.x360_recomp_progress || {}).some((entry) => entry.file && entry.format === "tsv" &&
          state.samePath(path.dirname(entry.file), directory) && path.basename(directory).toUpperCase() === config.appid &&
          path.basename(path.dirname(directory)).toLowerCase() === "achievements"));
    },
    async inspectDirectory(directory) {
      const relevant = [...records.values()].some(({ config }) => path.basename(directory).toUpperCase() === config.appid &&
        path.basename(path.dirname(directory)).toLowerCase() === "achievements");
      if (!relevant || blocked(directory)) return false;
      try {
        for (const name of await fs.readdir(directory)) {
          const file = path.join(directory, name);
          if (relevantFile(file)) await consider(file, null, true);
        }
      } catch {}
      return this.ownsDirectory(directory);
    },
    async close() {
      stopped = true; records.clear();
      failRequests(new Error("Recomp progress discovery closed"));
      if (worker) await worker.terminate();
      await serial;
      if (watcher) await watcher.close();
    },
  };
}

module.exports = { createProgressDiscovery };
