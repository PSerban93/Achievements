"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./atomic-json-store");

// Only PS4 Recomp opts into this writer. Normal writes remain synchronous;
// Windows sharing violations retry on timers instead of sleeping in Electron's
// main thread. Each destination owns at most one pending document and timer.
function createAchievementCacheWriter({ write = writeJsonAtomicSync,
  delays = [100, 250, 500, 1000, 2000, 4000], now = Date.now,
  schedule = setTimeout, unschedule = clearTimeout } = {}) {
  const pending = new Map();
  let closed = false;
  const keyFor = (file) => path.resolve(file).toLowerCase();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const retryable = (error) => ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
  function cancel(file) {
    const key = keyFor(file), entry = pending.get(key);
    if (!entry) return;
    unschedule(entry.timer);
    pending.delete(key);
  }
  function valid(entry) {
    return entry.options.stillValid() && (!entry.existed || fs.existsSync(entry.file));
  }
  function attempt(entry, finishing = false) {
    if (pending.get(entry.key) !== entry) return false;
    entry.timer = null;
    let document;
    try {
      if (!valid(entry)) { cancel(entry.file); return false; }
      document = entry.options.prepare(entry.document);
      write(entry.file, document, { attempts: finishing ? 6 : 1 });
    } catch (error) {
      entry.lastError = error;
      if (!finishing && retryable(error) && entry.attempt < delays.length) {
        const delayMs = delays[entry.attempt++];
        entry.options.onRetry?.(error, { attempt: entry.attempt, delayMs });
        entry.timer = schedule(() => attempt(entry), delayMs);
        entry.timer?.unref?.();
        return true; // Accepted for retry; do not report a completed disk write.
      }
      entry.exhaustedAt = now();
      if (!entry.reported) {
        entry.reported = true;
        entry.options.onError?.(error);
      }
      // Retain the latest progress in memory. A later unlock can supersede it;
      // unchanged callers cannot restart a tight loop against a locked file.
      return false;
    }
    pending.delete(entry.key);
    entry.options.onSaved?.(document);
    return true;
  }
  function save(file, document, options) {
    if (closed) return false;
    const key = keyFor(file);
    let entry = pending.get(key);
    if (entry && !valid(entry)) { cancel(file); entry = null; }
    const next = clone(entry ? options.merge(document, entry.document) : document);
    if (entry) {
      const same = options.equal(next, entry.document);
      entry.document = next;
      entry.options = options;
      if (entry.timer !== null) return true;
      if (same && entry.exhaustedAt !== undefined && now() - entry.exhaustedAt < 30_000) return false;
      entry.attempt = 0;
      delete entry.exhaustedAt;
    } else {
      entry = { key, file, document: next, options, existed: fs.existsSync(file), attempt: 0, timer: null, reported: false };
      pending.set(key, entry);
    }
    return attempt(entry);
  }
  function close() {
    closed = true;
    for (const entry of [...pending.values()]) {
      unschedule(entry.timer);
      attempt(entry, true);
    }
    pending.clear();
  }
  return { save, cancel, close };
}

module.exports = { createAchievementCacheWriter };
