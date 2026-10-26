"use strict";

// File-format discovery is scoped to one installation's resolved user/log
// directories. It never searches Documents/AppData for a game or a title.
const fs = require("fs");
const path = require("path");
const { regular, directory } = require("./ps4-recomp-installation");
const { collection } = require("./ps4-recomp-collections");

function listing(folder) {
  if (!directory(folder)) return [];
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  if (entries.length > 512) throw new Error("PS4 Recomp progress directory exceeds its discovery limit");
  return entries.filter((entry) => !entry.isSymbolicLink());
}
function snapshotFolder(config) {
  return /^NPWR\d{5}_\d{2}$/i.test(config.ps4_recomp_npcommid || "")
    ? path.join(config.ps4_recomp_user_root, "trophy", config.ps4_recomp_npcommid.toUpperCase()) : "";
}
function timestampSource(name) { return /^(?:trophies\.log|unlocked\.txt|progress_user\d+\.txt)$/i.test(path.basename(name)); }
function snapshotSource(name) { return /^progress_user\d+\.txt$/i.test(path.basename(name)); }
function bitsetSource(name) { return /^trophies\.dat$/i.test(path.basename(name)); }
function binarySource(name) { return bitsetSource(name) || /^CUSA\d{5}-user\d+\.bin$/i.test(path.basename(name)); }
function decodeBitset(data, schema) {
  if (data.length !== 16) throw new Error(data.length < 16 ? "Incomplete PS4 Recomp binary progress" : "Invalid PS4 Recomp binary progress size");
  const ids = new Set(Array.isArray(schema) ? schema.map((entry) => Number(entry.name)) : []);
  if (!ids.size || [...ids].some((id) => !Number.isInteger(id) || id < 0 || id >= 128)) throw new Error("PS4 Recomp schema is incompatible with 128-bit progress");
  const unlocked = [];
  for (let id = 0; id < 128; id++) if (data.readUInt32LE(Math.floor(id / 32) * 4) & (1 << (id % 32))) {
    if (!ids.has(id)) throw new Error("PS4 Recomp binary progress contains a trophy outside its schema");
    unlocked.push(id);
  }
  return unlocked;
}
function profileUser(name) { return path.basename(name).match(/(?:progress_user|CUSA\d{5}-user)(\d+)\.(?:txt|bin)$/i)?.[1] || ""; }
function binaryProfiles(config, user) {
  const title = config.ps4_recomp_title_id;
  if (!/^CUSA\d{5}$/.test(title || "")) return [];
  const roots = [...new Map([path.join(user, "trophies"), path.join(config.ps4_recomp_install_root, "bin", "user", "trophies")]
    .map((root) => [path.resolve(root).toLowerCase(), root])).values()];
  const found = roots.flatMap((root) => listing(root).filter((entry) => entry.isFile() && binarySource(entry.name) && entry.name.startsWith(title + "-user"))
    .map((entry) => path.join(root, entry.name)));
  const id = String(config.ps4_recomp_user_id || "");
  if (id && !/^\d+$/.test(id)) throw new Error("Invalid PS4 Recomp progress user ID");
  const selected = id ? found.filter((file) => path.basename(file) === `${title}-user${id}.bin`) : found;
  if (selected.length > 1) {
    if (id) {
      const exact = selected.find((file) => typeof config.save_path === "string" && path.resolve(file).toLowerCase() === path.resolve(config.save_path).toLowerCase());
      if (exact) return [exact];
    }
    throw new Error("Multiple PS4 Recomp binary progress sources; configure the intended user and progress location");
  }
  const saved = typeof config.save_path === "string" && binarySource(config.save_path) && path.basename(config.save_path).startsWith(title + "-user") &&
    roots.some((root) => path.resolve(root).toLowerCase() === path.resolve(path.dirname(config.save_path)).toLowerCase()) ? config.save_path : "";
  if (!selected.length && saved) return [id ? path.join(path.dirname(saved), `${title}-user${id}.bin`) : saved];
  if (id && found.length && !selected.length) return [path.join(roots[0], `${title}-user${id}.bin`)];
  return selected;
}
function files(config) {
  const user = config.ps4_recomp_user_root || path.dirname(config.save_path || "");
  const logRoot = config.ps4_recomp_log_root || user;
  // Collection ownership still comes from the existing session router.
  if (collection(config.ps4_recomp_port)) return [path.join(logRoot, "last_run.log")];
  const binary = binaryProfiles(config, user);
  if (binary.length) return binary;
  const pending = [];
  const folder = snapshotFolder({ ...config, ps4_recomp_user_root: user });
  if (folder) {
    const profiles = listing(folder).filter((entry) => entry.isFile() && snapshotSource(entry.name));
    const id = String(config.ps4_recomp_user_id || "");
    if (id && !/^\d+$/.test(id)) throw new Error("Invalid PS4 Recomp progress user ID");
    if (profiles.length > 1 && !id) throw new Error("Multiple PS4 Recomp progress users; select a user ID in the config before monitoring");
    if (id) {
      const selected = path.join(folder, `progress_user${id}.txt`);
      if (regular(selected)) return [selected];
      pending.push(selected);
      // Never substitute another user's snapshot or shared runtime log.
      return pending;
    }
    if (profiles.length === 1) return [path.join(folder, profiles[0].name)];
  }
  if (/^CUSA\d{5}$/.test(config.ps4_recomp_title_id || "")) {
    const unlocked = path.join(user, "trophies", config.ps4_recomp_title_id, "unlocked.txt");
    if (regular(unlocked)) return [unlocked];
    pending.push(unlocked);
  }
  // This convention has no title/profile header. Bind it only to the resolved
  // single-game user root, after the existing explicitly identified sources.
  // Keep a selected source through deletion/truncation; the reader retries it
  // without interpreting an unrelated log as a replacement save.
  const bitset = path.join(user, "trophies.dat");
  if (!config.ps4_recomp_user_id && (regular(bitset) || typeof config.save_path === "string" &&
      path.resolve(config.save_path).toLowerCase() === path.resolve(bitset).toLowerCase())) return [bitset];
  const persistent = path.join(user, "trophies.log");
  if (regular(persistent)) return [persistent];
  pending.push(persistent);
  const exact = path.join(logRoot, "last_run.log");
  const sessions = [];
  const add = (file) => {
    if (!regular(file)) return;
    const stat = fs.statSync(file);
    sessions.push({ file, time: Math.max(stat.birthtimeMs, stat.mtimeMs) });
  };
  add(exact);
  for (const file of config.ps4_recomp_log_files || []) {
    if (typeof file === "string" && path.isAbsolute(file) && /\.log$/i.test(file)) add(file);
  }
  const roots = config.ps4_recomp_log_directories || [path.join(config.ps4_recomp_install_root, "logs"), path.join(user, "logs")];
  for (const root of [...new Set(roots)]) {
    if (typeof root !== "string" || !path.isAbsolute(root)) continue;
    for (const entry of listing(root)) {
      if (entry.isFile() && !/^server[-_]/i.test(entry.name) && /^(?:last_run|game|(?:launcher-)?run[-_].+|[\w.-]*\d{4}[-_]?\d{2}[-_]?\d{2}[-_][\w.-]+)\.log$/i.test(entry.name)) add(path.join(root, entry.name));
      // A dated session folder may contain game.log. No asset recursion.
      if (entry.isDirectory() && /^\d{4}[-_]\d{2}[-_]\d{2}[-_][\w.-]+$/.test(entry.name)) add(path.join(root, entry.name, "game.log"));
    }
  }
  sessions.sort((a, b) => b.time - a.time || a.file.localeCompare(b.file));
  return sessions.length ? [sessions[0].file] : [...pending, ...(config.ps4_recomp_log_files || []), exact];
}
function preferred(config) {
  const candidates = files(config), existing = candidates.find(regular);
  if (existing) {
    if (bitsetSource(existing) && config.config_path) {
      // Validate a bounded read against the generated schema before exposing
      // this candidate as Save Path. Live reads use the same decoder.
      const bytes = Buffer.alloc(17);
      const fd = fs.openSync(existing, "r");
      try { decodeBitset(bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)),
        JSON.parse(fs.readFileSync(path.join(config.config_path, "achievements.json"), "utf8"))); }
      finally { fs.closeSync(fd); }
    }
    return existing;
  }
  if (candidates.length === 1 && bitsetSource(candidates[0])) return candidates[0];
  if (config.ps4_recomp_progress_format === "title-unlocks") return candidates.find((file) => path.basename(file) === "unlocked.txt") || candidates[0];
  const declared = candidates.find((file) => (config.ps4_recomp_log_files || []).includes(file));
  if (declared) return declared;
  return candidates.find((file) => path.basename(file) === "last_run.log") || candidates[0];
}
module.exports = { files, preferred, timestampSource, snapshotSource, bitsetSource, binarySource, decodeBitset, profileUser };
