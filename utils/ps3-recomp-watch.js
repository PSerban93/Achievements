"use strict";
const state = require("./ps3-recomp");

// A single serialized, small JSON read per second. No asset-directory watcher,
// metadata rescans, or reliance on Windows file metadata being refreshed.
function watchConfig(config, callbacks = {}) {
  let closed = false, busy = false, pending = false, lastError = "", timer;
  let known = callbacks.getCached?.() || {}, baseline = true;
  const names = state.schemaNames(config);
  config.__ps3RecompClosed = false;
  const read = async () => {
    if (closed) return;
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const parsed = state.loadConfigSnapshot(config, known, { names });
      if (closed) return;
      if (!parsed.valid && !parsed.missing) {
        if (lastError !== parsed.error) callbacks.onError?.(parsed.error);
        lastError = parsed.error; return;
      }
      lastError = "";
      if (baseline) {
        baseline = false;
        known = parsed.snapshot;
        callbacks.onSeed?.(known);
      } else if (parsed.valid && JSON.stringify(parsed.snapshot) !== JSON.stringify(known)) {
        await callbacks.onEvent?.(state.progressPath(config), parsed.snapshot);
        if (!closed) known = parsed.snapshot;
      }
    } catch (error) { callbacks.onError?.(error.message); }
    finally { busy = false; if (pending && !closed) { pending = false; void read(); } }
  };
  const readyPromise = read().then(() => !closed);
  timer = setInterval(read, 1000); timer.unref?.();
  return { appid: config.appid, meta: config, readyPromise, close: async () => {
    closed = true; config.__ps3RecompClosed = true; clearInterval(timer);
  } };
}
module.exports = { watchConfig };
