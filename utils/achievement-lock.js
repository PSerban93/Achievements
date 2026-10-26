"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const formats = require("./achievement-lock-formats");
const data = require("./achievement-data");
const x360 = require("./x360-recomp-state");
const kyty = require("./kytyps5-trophy");
const PLATFORMS = new Set(["steam", "uplay", "gog", "epic", "rpcs3", "shadps4", "xenia", "kytyps5", "x360recomp"]);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const key = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid achievement state file");
  const bytes = fs.readFileSync(file), after = fs.statSync(file);
  if (after.size !== bytes.length || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw new Error("Achievement state changed during read");
  return bytes;
}
function existing(file) { try { return !!file && fs.statSync(file).isFile(); } catch { return false; } }
function named(dir, name, depth = 0) {
  if (!dir || !fs.existsSync(dir)) return "";
  const found = [];
  let visited = 0;
  function walk(folder, level) {
    if (++visited > 128) throw new Error("Achievement source directory is too broad");
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) found.push(path.join(folder, entry.name));
      else if (entry.isDirectory() && level < depth) walk(path.join(folder, entry.name), level + 1);
    }
  }
  walk(dir, 0);
  if (found.length > 1) throw new Error("Ambiguous achievement source");
  return found[0] || "";
}
function sources(config, resolved = {}) {
  const platform = String(config.platform || "").toLowerCase();
  if (!PLATFORMS.has(platform) || /lumaplay|markerpatch|madnesspatch|xlivelessness/i.test(String(config.emu || "")) || config.ff7_achievement_dat) throw new Error("Unsupported achievement source");
  const source = (file, kind, extra = {}) => ({ file: path.resolve(file), kind, ...extra });
  if (platform === "x360recomp") {
    if (x360.progressStatus(config).pending) throw new Error("Achievement source has not been confirmed");
    const file = x360.progressPath(config), descriptor = config.x360_recomp_progress?.[config.x360_recomp_profile || "default"] || {};
    const parsed = x360.readSnapshot(file, {}, { descriptor, titleId: config.appid });
    if (!parsed.valid) throw new Error(parsed.error || "Achievement source is unavailable");
    const kind = descriptor.format === "json" ? "x360-json" : descriptor.format === "gpd" ? "gpd" : descriptor.format === "tsv-directory" ? "tsv" : descriptor.format || (/\.tsv$/i.test(file) ? "tsv" : /\.json$/i.test(file) ? "x360-json" : "toml");
    if (!["x360-json", "gpd", "tsv", "toml", "ini-earned", "unleashed"].includes(kind)) throw new Error("Unsupported recomp state format");
    return [source(file, kind, { descriptor })];
  }
  if (platform === "kytyps5") return kyty.resolveProgressPaths(config).filter(existing).map(file => source(file, "kyty-json", { serviceLabel: kyty.parseProgressPath(file).serviceLabel }));
  if (platform === "xenia") {
    const file = resolved.gpdPath || config.gpd_path || path.join(config.save_path, `${config.appid}.gpd`);
    if (!config.gpd_path && path.basename(file, path.extname(file)).toUpperCase() !== String(config.appid).replace(/^0x/i, "").toUpperCase()) throw new Error("GPD title identity is ambiguous");
    return [source(file, "gpd")];
  }
  if (platform === "rpcs3") return [source(resolved.tropusrPath || path.join(config.trophy_path || config.trophy_dir || config.save_path, "TROPUSR.DAT"), "rpcs3")];
  if (platform === "shadps4") {
    const progress = resolved.ps4ProgressPath || config.shadps4_progress_path || (/\.xml$/i.test(config.save_path || "") ? config.save_path : "");
    if (existing(progress)) {
      const parts = path.resolve(progress).split(path.sep), user = parts.at(-3);
      if (parts.at(-2).toLowerCase() === "trophy" && config.shadps4_user_id && user !== String(config.shadps4_user_id)) throw new Error("Selected trophy profile is unavailable");
      if (config.shadps4_npcommid && /^NPWR/i.test(path.basename(progress)) &&
          path.basename(progress, path.extname(progress)).toUpperCase() !== String(config.shadps4_npcommid).toUpperCase()) throw new Error("Trophy set identity mismatch");
      return [source(progress, "xml")];
    }
    const root = resolved.ps4TrophyDir || config.shadps4_schema_path || config.trophy_path || config.save_path;
    const xmlDir = path.join(root, "Xml");
    return fs.readdirSync(xmlDir).filter(name => /^TROP(?:_\d{2})?\.XML$/i.test(name)).map(name => source(path.join(xmlDir, name), "xml"));
  }
  const base = existing(config.save_path) ? path.dirname(config.save_path) : config.save_path;
  if (!base) throw new Error("Achievement save path is missing");
  if (platform === "uplay" && data.isRuneUplayConfig(config)) return [source(path.join(base, "achievements.cfg"), "rune")];
  const json = data.resolveSaveFilePath(base, config.appid);
  if (existing(json)) return [source(json, "json")];
  const tenoke = named(base, "user_stats.ini") || named(path.join(base, "SteamData"), "user_stats.ini");
  if (tenoke) return [source(tenoke, "ini")];
  const stats = path.basename(base).toLowerCase() === "stats" ? base : path.join(base, "Stats");
  const online = named(stats, "achievements.ini", 2);
  const ini = online || named(base, "achievements.ini", 2);
  if (ini) return [source(ini, "ini")];
  const bin = named(base, "stats.bin");
  if (bin) return [source(bin, "stats-bin")];
  throw new Error("No supported achievement state file was found");
}
function identity(configName, config, files) {
  return hash(JSON.stringify([configName, config.platform, String(config.appid), config.config_path,
    config.x360_recomp_profile, config.kytyps5_user_id, config.shadps4_user_id, files.map(s => key(s.file)).sort()]));
}
function locked(snapshot, ids) {
  const next = structuredClone(snapshot || {});
  for (const id of ids) {
    const entry = { ...next[id], earned: false, earned_time: 0 };
    if (Object.hasOwn(entry, "progress")) entry.progress = 0;
    delete entry.manual; delete entry.manualForced;
    next[id] = entry;
  }
  return next;
}
function prepare({ configName, config, schema, achievementNames, cached = {}, resolved = {}, schemaPath }) {
  if (!Array.isArray(schema) || !schema.length) throw new Error("Achievement schema is unavailable");
  const schemaIds = new Set(schema.map(entry => String(entry.name))), ids = [...new Set(achievementNames.map(String))];
  if (!ids.length || ids.some(id => !schemaIds.has(id))) throw new Error("Unknown achievement ID");
  const allFiles = sources(config, resolved), matched = new Set();
  const scope = identity(configName, config, allFiles);
  const files = allFiles.filter(file => file.kind !== "kyty-json" || ids.some(id => {
    const row = schema.find(entry => String(entry.name) === id);
    return Number(row.kytyps5_service_label ?? config.kytyps5_service_label ?? 0) === file.serviceLabel;
  }));
  if (!files.length || files.length > 64) throw new Error("Achievement source is unavailable or too broad");
  const definition = schemaPath && fs.statSync(schemaPath, { bigint: true });
  let total = 0;
  for (const file of files) {
    const stat = fs.statSync(file.file, { bigint: true });
    if (definition && definition.ino === stat.ino && definition.dev === stat.dev) throw new Error("Achievement definitions cannot be edited as progress");
    file.before = read(file.file);
    total += file.before.length;
    if (total > 32 * 1024 * 1024) throw new Error("Achievement edit is too large");
    let own = ids;
    if (file.kind === "kyty-json") own = ids.filter(id => {
      const row = schema.find(e => String(e.name) === id);
      return Number(row.kytyps5_service_label ?? config.kytyps5_service_label ?? 0) === file.serviceLabel;
    });
    const actual = own.map(id => file.kind === "kyty-json" ? String(schema.find(e => String(e.name) === id).kytyps5_trophy_id ?? id) : id);
    const result = formats.edit(file.before, { ...file, ids: actual, config, schema });
    file.after = result.bytes;
    for (let i = 0; i < actual.length; i++) if (result.matched.has(actual[i])) matched.add(own[i]);
    file.beforeHash = hash(file.before);
  }
  for (const id of ids) if (!matched.has(id) && cached[id]?.manual !== true) throw new Error(`Achievement record not found: ${id}`);
  return { configName, config: structuredClone(config), identity: scope, files,
    ids, cached: structuredClone(cached), snapshot: locked(cached, ids), createdAt: Date.now() };
}
function replace(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.achievement-write`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" }); fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function verifyUnchanged(plan) {
  for (const file of plan.files) if (hash(read(file.file)) !== file.beforeHash) throw new Error("Achievement state changed; reopen the menu and try again");
}
function commit(plan, backupRoot, persist, options = {}) {
  verifyUnchanged(plan);
  const id = `${Date.now()}-${crypto.randomUUID()}`, folder = path.join(backupRoot, plan.identity, id);
  fs.mkdirSync(folder, { recursive: true });
  const manifest = { version: 1, identity: plan.identity, configName: plan.configName, platform: plan.config.platform,
    at: Date.now(), ids: plan.ids, cached: plan.cached, files: [] };
  // Every backup must finish before the first source is changed.
  plan.files.forEach((file, n) => {
    const stored = `${n}.bin`; fs.writeFileSync(path.join(folder, stored), file.before, { flag: "wx" });
    manifest.files.push({ file: file.file, stored, hash: file.beforeHash });
  });
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
  const write = options.write || replace, modified = [];
  try {
    verifyUnchanged(plan);
    for (const file of plan.files) {
      if (file.before.equals(file.after)) continue;
      if (hash(read(file.file)) !== file.beforeHash) throw new Error("Achievement state changed during edit");
      modified.push(file); write(file.file, file.after);
      if (!read(file.file).equals(file.after)) throw new Error("Achievement write verification failed");
    }
    persist(plan.snapshot);
    manifest.complete = true;
    fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { backupId: id, backupPath: folder, updatedCount: plan.ids.length, snapshot: plan.snapshot };
  } catch (error) {
    const failures = [];
    for (const file of modified.reverse()) {
      try {
        const current = hash(read(file.file));
        if (current === file.beforeHash) continue;
        if (current !== hash(file.after)) throw new Error(`File changed externally: ${file.file}`);
        replace(file.file, file.before);
      } catch (rollbackError) { failures.push(rollbackError.message); }
    }
    try { persist(plan.cached); } catch (rollbackError) { failures.push(rollbackError.message); }
    error.message += failures.length ? `; restore from ${folder}: ${failures.join("; ")}` : "";
    throw error;
  }
}
function latestBackup(backupRoot, scope) {
  const root = path.join(backupRoot, scope);
  if (!fs.existsSync(root)) return null;
  const ids = fs.readdirSync(root).filter(id => /^\d+-[a-f0-9-]{36}$/i.test(id)).sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
  for (const id of ids) {
    try {
      const folder = path.join(root, id), manifest = JSON.parse(read(path.join(folder, "manifest.json")));
      if (manifest.complete && manifest.version === 1 && manifest.identity === scope) return { id, folder, manifest };
    } catch { /* An unfinished operation is not offered as a successful backup. */ }
  }
  return null;
}
function prepareRestore({ configName, config, resolved, backupRoot, schemaPath, cached }) {
  const allFiles = sources(config, resolved), scope = identity(configName, config, allFiles), backup = latestBackup(backupRoot, scope);
  if (!backup || !Array.isArray(backup.manifest.files) || !backup.manifest.files.length) throw new Error("No matching achievement backup");
  const files = allFiles.filter(file => backup.manifest.files.some(entry => key(entry.file) === key(file.file)));
  if (files.length !== backup.manifest.files.length) throw new Error("Achievement backup identity mismatch");
  for (const file of files) {
    const entry = backup.manifest.files.find(e => key(e.file) === key(file.file));
    if (!entry || !/^\d+\.bin$/.test(entry.stored) || schemaPath && key(file.file) === key(schemaPath)) throw new Error("Achievement backup identity mismatch");
    file.before = read(file.file); file.beforeHash = hash(file.before); file.after = read(path.join(backup.folder, entry.stored));
    if (hash(file.after) !== entry.hash) throw new Error("Achievement backup verification failed");
  }
  return { configName, config, files, identity: scope, ids: backup.manifest.ids, cached,
    snapshot: backup.manifest.cached, restore: true, createdAt: Date.now() };
}
module.exports = { PLATFORMS, prepare, prepareRestore, commit, latestBackup, sources, identity, locked, hash, replace };
