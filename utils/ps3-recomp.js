"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parse: parseToml } = require("smol-toml");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");
const { schemaHasNativePlatinum } = require("./platinum-summary");
const trophies = require("./ps3-recomp-trophies");
const SET_ID = /^NPWR\d{5}_\d{2}$/;
const key = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
function samePath(a, b) { return !!a && !!b && key(a) === key(b); }
function inside(root, file) {
  const relative = path.relative(key(root), key(file));
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function regular(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function bounded(file, max = 1024 * 1024) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error(`Invalid PS3 port file: ${file}`);
  return fs.readFileSync(file);
}
function readSfo(file) {
  const b = bounded(file);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46535000) throw new Error("Invalid PS3 PARAM.SFO");
  const keys = b.readUInt32LE(8), values = b.readUInt32LE(12), count = b.readUInt32LE(16), out = {};
  if (count > 256 || 20 + count * 16 > keys || keys > values || values > b.length) throw new Error("Invalid SFO directory");
  for (let i = 0; i < count; i++) {
    const at = 20 + i * 16, k = keys + b.readUInt16LE(at), v = values + b.readUInt32LE(at + 12), length = b.readUInt32LE(at + 4);
    const end = b.indexOf(0, k);
    if (k >= values || end < k || end >= values || v + length > b.length) throw new Error("Invalid SFO entry");
    const name = b.subarray(k, end).toString("ascii");
    if (["TITLE", "TITLE_ID"].includes(name)) out[name] = b.subarray(v, v + length).toString("utf8").replace(/\0.*$/s, "");
  }
  if (!/^[A-Z]{4}\d{5}$/.test(out.TITLE_ID || "")) throw new Error("PS3 title identity missing");
  return out;
}

// Read declarations as data. Never execute a launcher/script to discover paths.
function launchContract(root) {
  const file = path.join(root, "installer", "launch.txt");
  if (!regular(file)) return null;
  const contract = { file, arguments: [], env: {}, cwd: root };
  const resolve = (p) => path.resolve(root, p);
  for (const line of bounded(file).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const name = line.slice(0, at), value = line.slice(at + 1);
    if (name === "exe") contract.executable = resolve(value);
    if (name === "cwd") contract.cwd = resolve(value);
    if (name === "arg") contract.arguments.push(resolve(value));
    if (name === "env") {
      const split = value.indexOf("=");
      if (split > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, split))) contract.env[value.slice(0, split)] = value.slice(split + 1);
    }
  }
  if (!contract.executable || !/\.exe$/i.test(contract.executable) || !regular(contract.executable)) return null;
  return contract;
}
function gameRootFor(file) {
  let directory = path.dirname(file);
  for (let i = 0; i < 4; i++, directory = path.dirname(directory)) {
    if (regular(path.join(directory, "PARAM.SFO")) && fs.existsSync(path.join(directory, "TROPDIR"))) return directory;
    if (regular(path.join(directory, "PS3_GAME", "PARAM.SFO"))) return path.join(directory, "PS3_GAME");
  }
  return "";
}
function detectGames(root, options = {}) {
  root = path.resolve(root);
  if (options.isBlocked?.(root)) return [];
  const launch = launchContract(root), candidates = new Set(), settings = [];
  for (const file of launch?.arguments || []) {
    if (/\.(?:elf|bin)$/i.test(file)) { const candidate = gameRootFor(file); if (candidate) candidates.add(candidate); }
  }
  // Generic project declarations used by the toolkit, independent of game names.
  for (const relative of ["config.toml", "ps3recomp.toml"]) {
    const file = path.join(root, relative);
    if (!regular(file)) continue;
    const doc = parseToml(bounded(file).toString("utf8"));
    const input = doc.input?.sfo_path || doc.input?.elf_path;
    if (typeof input === "string") {
      const candidate = gameRootFor(path.resolve(root, input));
      if (candidate) { candidates.add(candidate); settings.push(file); }
    }
  }
  const runtimeEvidence = regular(path.join(root, "ps3recomp", "libs", "network", "sceNpTrophy.c"));
  if (!launch && !runtimeEvidence) return [];
  if (!candidates.size && runtimeEvidence) {
    for (const directory of [root, path.join(root, "game"), path.join(root, "gamedata", "dev_bdvd")]) {
      if (regular(path.join(directory, "PS3_GAME", "PARAM.SFO"))) candidates.add(path.join(directory, "PS3_GAME"));
    }
  }
  if (candidates.size !== 1) return []; // No title guessing across installations/collections.
  const gameRoot = [...candidates][0];
  if (options.isBlocked?.(gameRoot)) return [];
  const identity = readSfo(path.join(gameRoot, "PARAM.SFO"));
  const trophyRoot = path.join(gameRoot, "TROPDIR");
  const sets = fs.readdirSync(trophyRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && SET_ID.test(e.name))
    .map((e) => ({ id: e.name, file: path.join(trophyRoot, e.name, "TROPHY.TRP") }))
    .filter((e) => regular(e.file) && !options.isBlocked?.(e.file));
  // Runtime saves only commId.data, omitting its numeric suffix. Never map two
  // distinct packs to one JSON if that runtime would make them collide.
  const counts = new Map();
  for (const set of sets) counts.set(set.id.slice(0, 9), (counts.get(set.id.slice(0, 9)) || 0) + 1);
  const cwd = launch?.cwd || root;
  const dataRoot = launch?.env.PS3_GAMEDATA_ROOT || process.env.PS3_GAMEDATA_ROOT;
  const storage = path.resolve(cwd, dataRoot || "gamedata");
  return sets.filter((set) => counts.get(set.id.slice(0, 9)) === 1).map((set) => ({
    appid: set.id, title: identity.TITLE || identity.TITLE_ID, titleId: identity.TITLE_ID,
    installRoot: root, gameRoot, trophyFile: set.file, platform: "ps3recomp", launch,
    settingsFiles: [...settings, ...(launch ? [launch.file] : [])],
    progressFile: path.join(storage, "trophies", `${set.id.slice(0, 9)}.json`),
  })).filter((game) => !options.isBlocked?.(game.progressFile));
}
async function discoverGames(root, options = {}) {
  const queue = [{ directory: path.resolve(root), depth: 0 }], games = [], errors = [];
  let visited = 0;
  while (queue.length && visited++ < 160) {
    const { directory, depth } = queue.shift();
    if (options.isBlocked?.(directory)) continue;
    try {
      const found = detectGames(directory, options);
      if (found.length) { games.push(...found); continue; }
      if (depth >= 2) continue;
      for (const e of fs.readdirSync(directory, { withFileTypes: true })) {
        if (e.isDirectory() && !e.isSymbolicLink() && !/^(?:\.git|node_modules|ps3recomp|gamedata|PS3_GAME|shadercache|build|installer)$/i.test(e.name)) {
          queue.push({ directory: path.join(directory, e.name), depth: depth + 1 });
        }
      }
    } catch (error) { if (error.code !== "ENOENT") errors.push({ root: directory, error: error.message }); }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { games, errors, truncated: queue.length > 0 };
}
function progressPath(config) { return String(config?.save_path || config?.ps3_recomp_progress_file || ""); }
function cacheOptions(config) {
  return { ps3RecompSource: typeof config.ps3_recomp_cache_source === "string" && config.ps3_recomp_cache_source
    ? config.ps3_recomp_cache_source : `${key(config.ps3_recomp_install_root)}|${key(progressPath(config))}` };
}
function cacheScope(config, options = {}) {
  return crypto.createHash("sha256").update(options.ps3RecompSource || cacheOptions(config).ps3RecompSource).digest("hex").slice(0, 16);
}
function schema(config) {
  const entries = JSON.parse(bounded(path.join(config.config_path, "achievements.json"), 8 * 1024 * 1024).toString("utf8"));
  if (!Array.isArray(entries) || !entries.length || entries.some((e) => !/^\d+$/.test(e?.name))) throw new Error("Invalid PS3 Recomp schema");
  return entries;
}
function readSnapshot(file, previous = {}, options = {}) {
  try {
    const doc = JSON.parse(bounded(file).toString("utf8").replace(/^\uFEFF/, ""));
    if (!doc || !Array.isArray(doc.trophies) || doc.trophies.length > 10000) throw new Error("Invalid PS3 Recomp trophy state");
    const expected = new Set(options.names || []), seen = new Set();
    const snapshot = Object.fromEntries([...expected].map((id) => [id, previous[id]?.earned ? previous[id] : { earned: false, earned_time: 0 }]));
    for (const row of doc.trophies) {
      if (!Number.isSafeInteger(row?.id) || row.id < 0 || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > 253402300799 || seen.has(row.id)) {
        throw new Error("Invalid or duplicate PS3 trophy record");
      }
      seen.add(row.id);
      const id = String(row.id);
      if (expected.size && !expected.has(id)) continue;
      snapshot[id] = { earned: true, earned_time: row.timestamp || previous[id]?.earned_time || 0 };
    }
    return { valid: true, snapshot };
  } catch (error) { return { valid: false, missing: error.code === "ENOENT", snapshot: previous, error: error.message }; }
}
function schemaNames(config) { return schema(config).map((e) => e.name); }
function loadConfigSnapshot(config, previous = {}, options = {}) {
  try {
    if (!SET_ID.test(config?.appid || "") || path.basename(progressPath(config)).toUpperCase() !== `${config.appid.slice(0, 9)}.JSON`) {
      throw new Error("PS3 Recomp progress file does not match its trophy set");
    }
    return readSnapshot(progressPath(config), previous, { names: options.names || schemaNames(config) });
  }
  catch (error) { return { valid: false, snapshot: previous, error: error.message }; }
}
function changedWrite(file, doc) {
  try { if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(doc)) return false; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  writeJsonAtomicSync(file, doc); return true;
}
function validSchema(config) { try { return schema(config).every((e) => !e.icon || regular(path.join(config.config_path, e.icon))); } catch { return false; } }
function matchesProcess(config, entry) {
  const executable = require("./ps4-recomp-executables").commandExecutable(entry);
  return !!config?.executable && samePath(config.executable, executable) &&
    path.basename(config.executable).toLowerCase() === String(entry.name || "").toLowerCase();
}
function gameFromConfig(config) {
  return { appid: config.appid, platform: "ps3recomp", title: config.displayName || config.name,
    titleId: config.ps3_recomp_title_id, installRoot: config.ps3_recomp_install_root,
    gameRoot: config.ps3_recomp_game_root, trophyFile: config.ps3_recomp_trophy_file,
    progressFile: progressPath(config), settingsFiles: config.ps3_recomp_settings_files || [], launch: config.ps3_recomp_launch };
}
const imports = new Map();
function progressConfig(game, previous = {}) {
  const original = previous.ps3_recomp_progress_file || previous.save_path;
  // Preserve a manually selected save file; follow launcher changes when the
  // config still uses its previously generated location.
  const savePath = previous.save_path && original && !samePath(previous.save_path, original)
    ? previous.save_path : game.progressFile;
  const config = { save_path: savePath, ps3_recomp_game_root: game.gameRoot, ps3_recomp_title_id: game.titleId,
    ps3_recomp_progress_file: game.progressFile, ps3_recomp_trophy_file: game.trophyFile,
    ps3_recomp_settings_files: game.settingsFiles, ps3_recomp_launch: game.launch };
  if (previous.ps3_recomp_install_root && progressPath(previous) && !samePath(progressPath(previous), savePath)) {
    // Relocating this installation's saves must keep its existing ach_cache.
    config.ps3_recomp_cache_source = cacheOptions(previous).ps3RecompSource;
  }
  return config;
}
async function generateConfig(game, configsDir, options = {}) {
  // A library folder and its child can be added concurrently. Serialize only
  // this installation/set so the second importer reuses the first config.
  const identity = `${key(configsDir)}|${key(game.installRoot)}|${game.appid}`;
  const previous = imports.get(identity) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => generateConfigImpl(game, configsDir, options));
  imports.set(identity, operation);
  try { return await operation; }
  finally { if (imports.get(identity) === operation) imports.delete(identity); }
}
async function generateConfigImpl(game, configsDir, options = {}) {
  const cancel = () => { if (options.isCancelled?.()) throw new Error("PS3 Recomp import cancelled"); };
  cancel(); fs.mkdirSync(configsDir, { recursive: true });
  const existing = fs.readdirSync(configsDir).filter((n) => n.endsWith(".json")).map((name) => {
    try { return { name: path.basename(name, ".json"), data: JSON.parse(fs.readFileSync(path.join(configsDir, name), "utf8")) }; } catch { return null; }
  }).find((e) => e?.data.platform === "ps3recomp" && e.data.appid === game.appid && samePath(e.data.ps3_recomp_install_root, game.installRoot));
  if (existing && !options.force) {
    if (!validSchema(existing.data)) throw new Error("PS3 Recomp schema needs repair; use Folders → Rescan");
    const config = { ...existing.data, ...progressConfig(game, existing.data) };
    cancel();
    const configUpdated = changedWrite(path.join(configsDir, `${existing.name}.json`), config);
    return { ...config, config, name: existing.name, created: false, schemaUpdated: false, configUpdated };
  }
  options.onProgress?.({ phase: "generatingSchema", percent: 15, appid: game.appid, itemName: game.title });
  const meta = await trophies.metadata(game.trophyFile, game.appid); cancel();
  const scope = cacheScope({ ps3_recomp_install_root: game.installRoot, save_path: game.progressFile });
  const schemaDir = existing?.data.config_path || path.join(configsDir, "schema", "ps3recomp", game.appid, scope);
  fs.mkdirSync(path.join(schemaDir, "img"), { recursive: true });
  for (const [name, raw] of meta.images) {
    const file = path.join(schemaDir, "img", name), bytes = Buffer.from(raw);
    if (!regular(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
  }
  const previous = existing?.data || {};
  const old = new Map((validSchema(previous) ? schema(previous) : []).map((e) => [e.name, e]));
  const entries = meta.entries.map((e) => ({ ...e, ...(Number.isFinite(old.get(e.name)?.rarityPct) ?
    { rarityPct: old.get(e.name).rarityPct, raritySource: old.get(e.name).raritySource } : {}) }));
  const schemaUpdated = changedWrite(path.join(schemaDir, "achievements.json"), entries);
  let name = existing?.name || sanitizeConfigName(`${meta.title || game.title} (PS3 Recomp)`);
  if (!existing) { const base = name; let suffix = 2; while (regular(path.join(configsDir, `${name}.json`))) name = `${base} [${suffix++}]`; }
  const config = { ...previous, name, displayName: meta.title || game.title, appid: game.appid, platform: "ps3recomp",
    config_path: schemaDir, native_platinum: schemaHasNativePlatinum(entries),
    ps3_recomp_install_root: game.installRoot, ...progressConfig(game, previous), executable: previous.executable || game.launch?.executable || "",
    process_name: previous.process_name || (game.launch?.executable ? path.basename(game.launch.executable) : ""),
    arguments: previous.arguments || "", language: previous.language || "english" };
  cancel(); options.onProgress?.({ phase: "finalizingConfig", percent: 90, appid: game.appid, itemName: game.title });
  const configUpdated = changedWrite(path.join(configsDir, `${name}.json`), config);
  return { ...config, config, schemaDir, created: !existing, schemaUpdated, configUpdated };
}
module.exports = { detectGames, discoverGames, generateConfig, launchContract, readSfo, validSchema, schemaNames, matchesProcess, gameFromConfig,
  readSnapshot, loadConfigSnapshot, progressPath, cacheScope, cacheOptions, samePath, inside };
