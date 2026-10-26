"use strict";

// Process-local source revisions invalidate reads begun before an explicit
// edit. No polling, filesystem discovery or persistent second cache.
const path = require("path");
const updates = new Map();
let sequence = 0;
const key = file => process.platform === "win32" ? path.resolve(String(file || ".")).toLowerCase() : path.resolve(String(file || "."));
function revision(file) { return updates.get(key(file))?.at(-1)?.revision || 0; }
function publish(files, changes) {
  const value = ++sequence;
  for (const file of files) {
    const history = updates.get(key(file)) || [];
    history.push({ revision: value, changes: structuredClone(changes) });
    updates.set(key(file), history);
  }
  return value;
}
function rebase(snapshot, file, after = 0) {
  const history = updates.get(key(file));
  if (!history || history.at(-1).revision <= after) return snapshot;
  const next = { ...snapshot };
  for (const update of history) if (update.revision > after) {
    for (const [id, entry] of Object.entries(update.changes)) next[id] = { ...entry };
  }
  return next;
}
module.exports = { revision, publish, rebase };
