"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const state = require("./pc-ports");

function watchConfig(config, callbacks = {}) {
  const target = state.progressPath(config), directory = path.dirname(target);
  const names = JSON.parse(fs.readFileSync(path.join(config.config_path, "achievements.json"), "utf8")).map((entry) => entry.name);
  let closed = false, closing = false, operation = Promise.resolve(), resetTimer, closePromise;
  let known = callbacks.getCached?.() || {};
  config.__pcPortsClosed = false;
  const baseline = state.readSnapshot(target, known, { names });
  let pendingBaseline = !baseline.valid && !baseline.missing;
  const seed = (snapshot) => { known = snapshot; callbacks.onSeed?.(snapshot); };
  if (baseline.valid) seed(baseline.snapshot);
  else if (baseline.missing) seed(fs.existsSync(directory) ? {} : known);
  else callbacks.onError?.(baseline.error);
  let anchor = directory;
  while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
  const watcher = chokidar.watch(anchor, {
    ignoreInitial: true, ignorePermissionErrors: true, followSymlinks: false,
    depth: path.relative(anchor, directory).split(path.sep).filter(Boolean).length + 1,
    ignored: (candidate) => !state.inside(candidate, directory) && !state.samePath(candidate, target),
    awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 75 },
  });
  const hit = (file, flush = false) => {
    if (closed || closing && !flush || !state.samePath(file, target)) return;
    clearTimeout(resetTimer);
    operation = operation.then(async () => {
      const parsed = state.readSnapshot(target, known, { names, observedTime: Date.now() });
      if (!parsed.valid) { if (!parsed.missing) callbacks.onError?.(parsed.error); return; }
      if (pendingBaseline) { pendingBaseline = false; seed(parsed.snapshot); return; }
      // A reset can be followed by another unlock before the unlink grace
      // period ends. Previously earned records turning false prove a reset;
      // compare this new run against locked records, not the previous run.
      if (names.some((name) => known[name]?.earned && !parsed.snapshot[name]?.earned)) {
        seed(Object.fromEntries(names.map((name) => [name, { earned: false, earned_time: 0 }])));
        for (const entry of Object.values(parsed.snapshot)) if (entry.earned) entry.earned_time = Date.now();
      }
      await callbacks.onEvent?.(target, parsed.snapshot);
      known = parsed.snapshot;
    }).catch((error) => callbacks.onError?.(error.message));
  };
  watcher.on("add", hit).on("change", hit).on("error", (error) => callbacks.onError?.(error.message));
  watcher.on("unlink", (file) => {
    if (closing || !state.samePath(file, target)) return;
    clearTimeout(resetTimer);
    // Saving replaces the old file; an actual game Reset leaves it absent.
    resetTimer = setTimeout(() => {
      if (closed || closing || fs.existsSync(target) || !fs.existsSync(directory)) return;
      operation = operation.then(async () => {
        if (closed || fs.existsSync(target) || !fs.existsSync(directory)) return;
        const snapshot = Object.fromEntries(names.map((name) => [name, { earned: false, earned_time: 0 }]));
        await callbacks.onEvent?.(target, snapshot);
        known = snapshot;
      }).catch((error) => callbacks.onError?.(error.message));
    }, 1200);
  });
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
    watcher.once("ready", () => { hit(target); resolve(true); });
    watcher.once("error", () => resolve(false));
  });
  return { appid: config.appid, meta: config, readyPromise, close: () => {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(resetTimer); resolveReady(false);
    closePromise = (async () => {
      await watcher.close(); hit(target, true); await operation;
      closed = true; config.__pcPortsClosed = true;
    })();
    return closePromise;
  } };
}

module.exports = { watchConfig };
