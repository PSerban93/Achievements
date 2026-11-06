"use strict";
const fs = require("fs");
const path = require("path");
const { writeJsonAtomicSync } = require("./atomic-json-store");

// UI preferences belong beside the resolved schema, not in achievement sources.
function createStore({ resolveSchema, write = writeJsonAtomicSync }) {
  const identity = (name, config) => ({ configName: name, platform: String(config.platform || "steam").toLowerCase(), appid: String(config.appid ?? "") });
  const matches = (a, b) => a.configName === b.configName && a.platform === b.platform && a.appid === b.appid;
  const earned = entry => entry?.earned === true || entry?.earned === 1 || entry?.manual === true;
  function location(config) {
    const schema = resolveSchema(config);
    return schema ? path.join(path.dirname(schema), "achievement-pins.json") : null;
  }
  function document(file) {
    if (!file || !fs.existsSync(file)) return { version: 1, configs: [] };
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.configs) || data.configs.some(entry =>
      !entry || typeof entry.configName !== "string" || typeof entry.platform !== "string" || typeof entry.appid !== "string" ||
      !Array.isArray(entry.ids) || entry.ids.some(id => typeof id !== "string"))) {
      throw new Error("Invalid achievement pins file; existing data was preserved");
    }
    return data;
  }
  const presentation = (entry, name, config) => ({ ids: [...(entry?.ids || [])], revision: Number(entry?.revision) || 0,
    scope: JSON.stringify([location(config), identity(name, config)]) });
  function read(name, config) {
    const data = document(location(config)), key = identity(name, config);
    return presentation(data.configs.find(entry => matches(entry, key)), name, config);
  }
  function edit(name, config, transform) {
    const file = location(config);
    if (!file) throw new Error("Achievement schema is unavailable");
    const data = document(file), key = identity(name, config);
    let entry = data.configs.find(value => matches(value, key));
    const previous = entry?.ids || [], ids = [...new Set(transform(previous))];
    if (JSON.stringify(previous) === JSON.stringify(ids)) return { ...presentation(entry, name, config), changed: false };
    if (!entry) { entry = { ...key, ids: [] }; data.configs.push(entry); }
    entry.ids = ids;
    entry.revision = Math.max(Date.now(), (Number(entry.revision) || 0) + 1);
    write(file, data);
    return { ...presentation(entry, name, config), changed: true };
  }
  function reconcile(name, config, snapshot) {
    if (!location(config) || !fs.existsSync(location(config))) return { ...presentation(null, name, config), changed: false };
    // Missing/partial snapshots never remove pins. Only confirmed unlocks do.
    return edit(name, config, ids => ids.filter(id => !earned(snapshot?.[id])));
  }
  function update(name, config, { ids, pinned, schema, snapshot }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== "string" || !id) || typeof pinned !== "boolean") {
      throw new Error("Invalid achievement pin selection");
    }
    if (!Array.isArray(schema)) throw new Error("Achievement schema is unavailable");
    const known = new Set(schema.map(entry => String(entry.name)));
    if (ids.some(id => !known.has(id))) throw new Error("Unknown achievement in pin selection");
    return edit(name, config, previous => {
      const next = new Set(previous.filter(id => known.has(id) && !earned(snapshot?.[id])));
      for (const id of ids) {
        if (pinned && !earned(snapshot?.[id])) next.add(id);
        else next.delete(id);
      }
      return [...next];
    });
  }
  function remove(name, config) {
    const file = location(config);
    if (!file || !fs.existsSync(file)) return;
    const data = document(file), key = identity(name, config);
    const next = data.configs.filter(entry => !matches(entry, key));
    if (next.length !== data.configs.length) write(file, { ...data, configs: next });
  }
  function move(oldName, oldConfig, newName, newConfig) {
    const oldFile = location(oldConfig), newFile = location(newConfig);
    if (!oldFile || !newFile || !fs.existsSync(oldFile)) return;
    const data = document(oldFile), key = identity(oldName, oldConfig);
    const entry = data.configs.find(value => matches(value, key));
    if (!entry || (oldFile === newFile && matches(entry, identity(newName, newConfig)))) return;
    const nextKey = identity(newName, newConfig);
    const destination = oldFile === newFile ? data : document(newFile);
    if (destination.configs.some(value => value !== entry && matches(value, nextKey))) throw new Error("Destination already has achievement pins");
    destination.configs = destination.configs.filter(value => value !== entry);
    destination.configs.push({ ...entry, ...nextKey });
    write(newFile, destination);
    if (oldFile !== newFile) remove(oldName, oldConfig);
  }
  return { read, update, reconcile, remove, move };
}
module.exports = { createStore };
