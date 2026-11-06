"use strict";
const fs = require("fs");
const { writeJsonAtomicSync } = require("./atomic-json-store");

// Config creation history is independent of progress, schema refresh and file rewrites.
function createStore(file, { write = writeJsonAtomicSync } = {}) {
  let entries = null;
  const validTime = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  function load() {
    if (entries) return entries;
    let data = { version: 1, entries: {} };
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) {
      throw new Error("Invalid config creation history; existing file was preserved");
    }
    entries = new Map(Object.entries(data.entries).map(([name, time]) => [name, validTime(time)]).filter(([, time]) => time));
    return entries;
  }
  function save(next) {
    write(file, { version: 1, entries: Object.fromEntries(next) });
    entries = next;
  }
  function observe(configs) {
    const previous = load(), next = new Map(previous), names = new Set(configs.map(config => config.name));
    for (const config of configs) {
      if (!next.has(config.name)) next.set(config.name, validTime(config.addedAt) || Date.now());
    }
    for (const name of next.keys()) if (!names.has(name)) next.delete(name);
    if (JSON.stringify([...previous]) !== JSON.stringify([...next])) save(next);
    return configs.map(config => ({ ...config, addedAt: next.get(config.name) }));
  }
  function move(oldName, newName, fallback = 0) {
    if (oldName === newName) return;
    const previous = load(), next = new Map(previous);
    const time = next.get(oldName) || validTime(fallback);
    if (!time) return;
    next.delete(oldName); next.set(newName, time); save(next);
  }
  function remove(name) {
    const previous = load();
    if (!previous.has(name)) return;
    const next = new Map(previous); next.delete(name); save(next);
  }
  return { observe, move, remove };
}
module.exports = { createStore };
