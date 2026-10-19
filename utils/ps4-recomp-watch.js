"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const state = require("./ps4-recomp");
const groups = new Map();

function watchConfig(config, callbacks = {}) {
  const key = path.resolve(config.ps4_recomp_install_root).toLowerCase() + "|" + state.cacheScope(config);
  let group = groups.get(key);
  if (!group) {
    group = { clients: new Set(), operation: Promise.resolve(), watchers: [],
      since: Date.now(), closed: false, readPending: false, readQueued: false };
    groups.set(key, group);
    const enqueue = () => {
      if (group.closed) return group.operation;
      group.readPending = true;
      if (group.readQueued) return group.operation;
      group.readQueued = true;
      group.operation = group.operation.then(async () => {
        group.readPending = false;
        if (group.closed) return;
        const clients = [...group.clients].filter((client) => !client.closed);
        if (!clients.length) return;
        // Read from zero once per shared source, even when Windows has not
        // delivered a directory event or refreshed its cached metadata.
        const logRead = await state.readProgressLogs(clients[0].config);
        if (group.closed) return;
        const live = clients.some((client) => !client.baseline);
        for (const client of clients) {
          if (client.closed) continue;
          const parsed = state.loadConfigSnapshot(client.config, client.known,
            { observe: true, live, since: group.since, logRead });
          if (!parsed.valid) {
            if (client.lastError !== parsed.error) client.callbacks.onError?.(parsed.error);
            client.lastError = parsed.error;
            continue; // Keep the baseline and retry through the same one-second cycle.
          }
          client.lastError = "";
          if (parsed.pendingContext && !client.waitingContext) client.callbacks.onPendingContext?.();
          client.waitingContext = parsed.pendingContext === true;
          if (client.baseline) {
            client.known = parsed.snapshot;
            client.callbacks.onSeed?.(parsed.snapshot);
            client.baseline = false;
            continue;
          }
          const historical = (parsed.historicalIds || []).filter((id) => !client.known[id]?.earned && parsed.snapshot[id]?.earned);
          if (historical.length) {
            client.known = { ...client.known };
            for (const id of historical) client.known[id] = parsed.snapshot[id];
            client.callbacks.onSeed?.(client.known);
            client.callbacks.onRefresh?.();
          }
          if (JSON.stringify(parsed.snapshot) === JSON.stringify(client.known)) {
            // Log replacement/routing can change without a new unlock. Persist
            // that checkpoint in this client's cache, never in a side journal.
            if (parsed.cacheChanged) client.callbacks.onCheckpoint?.(parsed.snapshot);
            client.known = parsed.snapshot;
            continue;
          }
          await client.callbacks.onEvent?.(state.progressPath(client.config), parsed.snapshot);
          if (!client.closed) client.known = parsed.snapshot;
        }
      }).catch((error) => {
        for (const client of group.clients) {
          if (client.lastError !== error.message) client.callbacks.onError?.(error.message);
          client.lastError = error.message;
        }
      }).finally(() => {
        group.readQueued = false;
        if (group.readPending && !group.closed) enqueue();
      });
      return group.operation;
    };
    // This is the sole periodic source reader. The initial pass also imports
    // existing history quietly before live comparisons start.
    group.readyPromise = Promise.resolve().then(async () => { await enqueue(); return !group.closed; });
    group.progressTimer = setInterval(enqueue, 1000);
    group.progressTimer.unref?.();
    group.stopRuntime = state.subscribeRuntimeProcesses(() => {
      // Routing can finish once an earlier observed process is enriched with
      // its command line. Use the same serialized reader, never another watcher.
      if ([...group.clients].some((client) => client.waitingContext)) enqueue();
    });
    if (config.ps4_recomp_settings_file) {
      // Launcher settings are independent of progress. Only this JSON file
      // retains native event monitoring and its short write-stability delay.
      const target = config.ps4_recomp_settings_file, directory = path.dirname(target);
      let anchor = directory, settingsTimer;
      while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
      const watcher = chokidar.watch(anchor, { ignoreInitial: true, followSymlinks: false, ignorePermissionErrors: true,
        depth: path.relative(anchor, directory).split(path.sep).filter(Boolean).length + 1,
        ignored: (candidate) => !state.inside(candidate, target) && !state.samePath(candidate, target),
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 } });
      const onSettings = (file) => {
        if (group.closed || !state.samePath(file, target)) return;
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(() => {
          const client = [...group.clients].find((entry) => !entry.closed);
          Promise.resolve(client?.callbacks.onSettingsChange?.()).catch((error) => client?.callbacks.onError?.(error.message));
        }, 400);
      };
      watcher.on("add", onSettings).on("change", onSettings).on("unlink", onSettings)
        .on("error", (error) => { for (const client of group.clients) client.callbacks.onError?.(error.message); });
      group.watchers.push(watcher);
      group.stopSettingsTimer = () => clearTimeout(settingsTimer);
    }
    group.enqueue = enqueue;
  }
  config.__ps4RecompClosed = false;
  const releaseSource = state.observeSource(config);
  const client = { config, callbacks, known: callbacks.getCached?.() || {}, closed: false, baseline: true };
  group.clients.add(client);
  // A joining collection config gets its own quiet baseline. Existing clients
  // keep their snapshots and continue receiving live deltas.
  if (group.clients.size > 1) group.enqueue();
  let closing;
  return { appid: config.appid, meta: config, readyPromise: group.readyPromise, close: () => {
    if (closing) return closing;
    client.closed = true; config.__ps4RecompClosed = true; group.clients.delete(client);
    closing = (async () => {
      if (!group.clients.size) {
        group.closed = true; group.stopSettingsTimer?.(); group.stopRuntime?.(); clearInterval(group.progressTimer);
        if (groups.get(key) === group) groups.delete(key);
        await Promise.all(group.watchers.map((watcher) => watcher.close()));
        await group.operation;
      }
      releaseSource();
    })();
    return closing;
  } };
}
module.exports = { watchConfig };
