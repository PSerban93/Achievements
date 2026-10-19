"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const state = require("./x360-recomp-state");

function watchConfig(config, callbacks = {}) {
  const observeSince = Math.floor(Date.now() / 1000);
  let closed = false, closing = false, operation = Promise.resolve(), closePromise;
  const watchers = [], pending = new Map(), known = new Map();
  config.__x360RecompClosed = false;
  // A replacement watcher adopts schema additions silently. The current one
  // keeps its definitions until closed, so previously unknown IDs do not turn
  // into new unlocks merely because a rescan wrote a larger schema.
  const ids = (() => {
    const entries = JSON.parse(fs.readFileSync(path.join(config.config_path, "achievements.json"), "utf8"));
    if (!Array.isArray(entries)) throw new Error("Invalid recomp schema");
    return new Set(entries.map((entry) => String(entry.name)));
  })();
  const supported = (snapshot) => {
    return Object.fromEntries(Object.entries(snapshot).filter(([id]) => ids.has(id)));
  };
  const seed = (profile, snapshot) => {
    known.set(profile, snapshot);
    callbacks.onSeed?.(profile, snapshot);
  };
  for (const profile of Object.keys(config.x360_recomp_profiles || {})) {
    const descriptor = config.x360_recomp_progress?.[profile];
    let target = state.progressPath(config, profile);
    const waitingTsv = descriptor?.format === "tsv-directory";
    const directory = waitingTsv ? descriptor.directory : target && path.dirname(target);
    if (!directory) continue;
    const tsvProfileFiles = /\.tsv$/i.test(target) || waitingTsv;
    const matchingTsv = (file) => tsvProfileFiles && state.samePath(path.dirname(file), directory) && /^[a-f0-9]{16}\.tsv$/i.test(path.basename(file));
    if (waitingTsv) {
      const files = (() => { try { return fs.readdirSync(directory).filter((name) => /^[a-f0-9]{16}\.tsv$/i.test(name)); } catch { return []; } })();
      if (files.length === 1) {
        const candidate = path.join(directory, files[0]);
        if (state.readSnapshot(candidate, {}, { titleId: config.appid }).valid) target = candidate;
      }
      if (target) config.x360_recomp_progress[profile] = { ...descriptor, file: target };
    }
    const cached = callbacks.getCached?.(profile) || {};
    const baseline = state.readSnapshot(target, cached, { titleId: config.appid, descriptor });
    if (baseline.valid) {
      const snapshot = supported(baseline.snapshot);
      const since = Number(callbacks.notifyInitialSince);
      const newlyDiscovered = profile === config.x360_recomp_profile && state.samePath(target, callbacks.notifyDiscoveredFile);
      const historical = newlyDiscovered && since > 0 ? Object.fromEntries(Object.entries(snapshot).filter(([, entry]) =>
        entry.earned_time > 0 && entry.earned_time < since)) : {};
      seed(profile, newlyDiscovered ? { ...historical, ...cached } : since > 0 && profile === config.x360_recomp_profile ? Object.fromEntries(Object.entries(snapshot).filter(([id, entry]) =>
        cached[id]?.earned || !entry.earned_time || entry.earned_time < since || entry.earned_time > observeSince + 5)) : snapshot);
    }
    else if (baseline.missing) seed(profile, cached);
    // A file already present but unreadable at attachment is historical data,
    // not a newly created unlock. Its first successful read seeds silently.
    else { known.set(profile, cached); pending.set(profile, true); callbacks.onError?.(baseline.error); }
    let anchor = directory;
    while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
    const ancestry = (candidate) => {
      const relative = path.relative(candidate, directory);
      return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    const watcher = chokidar.watch(anchor, {
      ignoreInitial: true, ignorePermissionErrors: true, followSymlinks: false,
      depth: path.relative(anchor, directory).split(path.sep).filter(Boolean).length + 1,
      ignored: (candidate) => !ancestry(candidate) && !state.samePath(candidate, target) && !matchingTsv(candidate),
      awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 75 },
    });
    const hit = (file, flush = false) => {
      if ((closing && flush !== true) || closed) return;
      if (matchingTsv(file) && !state.samePath(file, target)) {
        if (target) { if (!closing) callbacks.onDiscovery?.(file); return; }
        // First profile created after attachment: bind only this file, notify
        // its new unlock, then let discovery persist its real profile ID.
        if (!state.readSnapshot(file, {}, { titleId: config.appid }).valid) return;
        target = file;
        config.x360_recomp_progress[profile] = { ...descriptor, file: target };
      }
      if (!state.samePath(file, target)) return;
      operation = operation.then(async () => {
        if (closed) return;
        const current = state.readSnapshot(target, known.get(profile) || {}, { titleId: config.appid, descriptor });
        if (!current.valid) { if (!current.missing) callbacks.onError?.(current.error); return; }
        const snapshot = supported(current.snapshot);
        const unknown = Object.keys(current.snapshot).filter((id) => !Object.hasOwn(snapshot, id));
        if (unknown.length) callbacks.onPending?.(profile, unknown);
        if (pending.has(profile) || profile !== config.x360_recomp_profile) {
          pending.delete(profile); seed(profile, snapshot); return;
        }
        await callbacks.onEvent?.(profile, target, snapshot);
        if (!closed) known.set(profile, snapshot);
        if (waitingTsv && !closing) callbacks.onDiscovery?.(file);
      }).catch((error) => callbacks.onError?.(error.message));
    };
    watcher.on("add", hit).on("change", hit).on("error", (error) => callbacks.onError?.(error.message));
    let resolveReady;
    const reread = (flush = false) => {
      if (waitingTsv && !target) {
        try {
          const files = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{16}\.tsv$/i.test(name));
          if (files.length === 1) { hit(path.join(directory, files[0]), flush); return; }
        } catch {}
      }
      hit(target, flush);
    };
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
      watcher.once("ready", () => {
        callbacks.onWatching?.({ profile, selected: profile === config.x360_recomp_profile, file: target || null, directory, anchor });
        reread();
        if (tsvProfileFiles) void fs.promises.readdir(directory).then((files) => {
          if (!closing && !closed) for (const name of files) {
            const file = path.join(directory, name);
            if (matchingTsv(file) && !state.samePath(file, target)) callbacks.onDiscovery?.(file);
          }
        }).catch(() => {});
        resolve(true);
      });
      watcher.once("error", () => resolve(false));
      watcher.once("close", () => resolve(false));
    });
    watchers.push({ watcher, ready, resolveReady, flush: () => reread(true) });
  }
  if (config.x360_recomp_adapter === "reblue") {
    const profileRoot = path.join(config.x360_recomp_install_root, "profiles");
    const watcher = chokidar.watch(profileRoot, { ignoreInitial: false, followSymlinks: false, depth: 3,
      ignorePermissionErrors: true, awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 75 } });
    watcher.on("add", (file) => {
      if (!closing && !closed && path.basename(file).toUpperCase() === `${config.appid}.TOML` &&
          path.basename(path.dirname(file)).toLowerCase() === "achievements") callbacks.onDiscovery?.(file);
    });
    watcher.on("error", (error) => callbacks.onError?.(error.message));
    watchers.push({ watcher, ready: Promise.resolve(true), resolveReady: () => {}, flush: () => {} });
  }
  const readyPromise = Promise.all(watchers.map((item) => item.ready))
    .then((results) => results.every((ready) => ready === true));
  return { appid: config.appid, meta: config, observeSince, readyPromise, close: () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      for (const item of watchers) item.resolveReady(false);
      await Promise.all(watchers.map((item) => item.watcher.close()));
      for (const item of watchers) item.flush();
      // Finish observed changes before reseeding a replacement watcher. Closing
      // during its debounce must not turn an unlock into silent historical data.
      await operation;
      closed = true; config.__x360RecompClosed = true;
    })();
    return closePromise;
  } };
}

module.exports = { watchConfig };
