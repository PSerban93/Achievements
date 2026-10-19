"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const { readJsonWithBackupSync, writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");
const { schemaHasNativePlatinum } = require("./platinum-summary");
const trophies = require("./ps4-recomp-trophies");
const { samePath, inside } = require("./pc-ports");
const { getProcessExecutableNames } = require("./process-name-utils");
const runtimeListeners = new Set();
let runtimeProcesses = null;
const runtimeFirstSeen = new Map();
let runtimeFingerprint = "";
let latestRuntimeInput = null;
// Legacy launcher-location hints are optional. Only Uncharted defines a collection.
const PORTS = [
  { port: "bloodborne", launcher: "Bloodborne.exe", settings: "bbport-launcher", env: "BB", marker: "bloodborne" },
  { port: "uncharted", launcher: "Uncharted.exe", settings: "uncharted-launcher", env: "BB", marker: "uncharted", games: [
    ["u1", "Uncharted: Drake's Fortune Remastered", 0], ["u2", "Uncharted 2: Among Thieves Remastered", 1], ["u3", "Uncharted 3: Drake's Deception Remastered", 2]] },
  { port: "gow3", launcher: "God of War III.exe", settings: "gow3-launcher", env: "GOW3", marker: "gow3" },
  { port: "medievil", launcher: "MediEvil.exe", settings: "medievil-launcher", env: "GOW3", marker: "medievil" },
];
function json(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return fallback; } }
function settingsFile(port) {
  if (port.settingsFile) return port.settingsFile;
  return port.settings ? path.join(process.env.APPDATA || path.join(require("os").homedir(), ".config"), port.settings, "settings.json") : "";
}
function settings(port) {
  try {
    const file = settingsFile(port);
    if (!file) return {};
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid PS4 Recomp launcher settings");
    const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Invalid PS4 Recomp launcher settings");
    return value;
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
function scriptPathDefault(script, key, bases) {
  // Accept only a literal Path expression, e.g. PORT.parent / 'Game' or data / 'user'.
  // Computed expressions stay unresolved; launcher scripts are never evaluated.
  const raw = script.match(new RegExp(`(?:env|os\\.environ)\\.get\\(\\s*['"]${key}['"]\\s*,\\s*([^\\r\\n)]+)\\)`))?.[1]?.trim();
  if (!raw) return "";
  const expression = /^([A-Za-z_]\w*)((?:\.parent)*)(\s*(?:\/\s*(?:'[^'\r\n]*'|"[^"\r\n]*")\s*)*)$/.exec(raw);
  if (!expression || !bases[expression[1]]) return "";
  let result = bases[expression[1]];
  for (const _ of expression[2].matchAll(/\.parent/g)) result = path.dirname(result);
  for (const part of expression[3].matchAll(/['"]([^'"]*)['"]/g)) result = path.resolve(result, part[1]);
  return result;
}
function environment(port, root, cfg = settings(port)) {
  const env = { ...process.env };
  // Same KEY=VALUE tokens accepted by the launchers; never execute their contents.
  for (const match of String(cfg.extra_env || "").matchAll(/(?:^|\s)([A-Za-z_][\w]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) env[match[1]] = match[2] ?? match[3] ?? match[4];
  const resolve = (value) => value ? path.resolve(root, value) : "";
  const script = port.port === "generic" ? runScript(root) : "";
  const data = resolve(env[`${port.env}_DATA_DIR`] || cfg.data_dir) || scriptPathDefault(script, `${port.env}_DATA_DIR`, { PORT: root }) || root;
  const explicitUser = resolve(env[`${port.env}_USER_DIR`] || cfg.user_dir) ||
    scriptPathDefault(script, `${port.env}_USER_DIR`, { PORT: root, data });
  const rootLogs = ["trophies.log", "last_run.log"].some((name) => regularFile(path.join(data, name)));
  return { gameRoot: resolve(env[`${port.env}_GAME_DIR`] || cfg.game_dir) || scriptPathDefault(script, `${port.env}_GAME_DIR`, { PORT: root, data }),
    userRoot: explicitUser || (port.port === "generic" && rootLogs ? data : path.join(data, "user")), env };
}
function gameIdentity(root) {
  if (!root) return {};
  try {
    const file = path.join(root, "sce_sys", "param.sfo"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return {};
    const bytes = fs.readFileSync(file);
    if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46535000) return {};
    const keys = bytes.readUInt32LE(8), values = bytes.readUInt32LE(12), count = bytes.readUInt32LE(16), result = {};
    if (count > 1024 || 20 + count * 16 > bytes.length) return {};
    for (let index = 0; index < count; index++) {
      const at = 20 + index * 16, keyAt = keys + bytes.readUInt16LE(at), length = bytes.readUInt32LE(at + 4), valueAt = values + bytes.readUInt32LE(at + 12);
      if (keyAt >= bytes.length || valueAt + length > bytes.length) return {};
      const keyEnd = bytes.indexOf(0, keyAt);
      if (keyEnd < keyAt || keyEnd - keyAt > 128) return {};
      const key = bytes.subarray(keyAt, keyEnd).toString("ascii");
      if (["TITLE_ID", "CONTENT_ID", "TITLE"].includes(key)) result[key] = bytes.subarray(valueAt, valueAt + length).toString("utf8").replace(/\0.*$/s, "");
    }
    return { ...(result.TITLE ? { ps4_recomp_title: result.TITLE } : {}),
      ...( /^CUSA\d{5}$/.test(result.TITLE_ID || "") ? { ps4_recomp_title_id: result.TITLE_ID } : {}),
      ...( /^[A-Z]{2}\d{4}-CUSA\d{5}_\d{2}-[A-Z0-9]{16}$/.test(result.CONTENT_ID || "") ? { ps_content_id: result.CONTENT_ID } : {}) };
  } catch { return {}; }
}
function regularFile(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function runScript(root) {
  const file = path.join(root, "run.py");
  if (!regularFile(file)) return "";
  const stat = fs.statSync(file);
  if (stat.size > 512 * 1024) return "";
  return fs.readFileSync(file, "utf8");
}
function identityFiles(port) {
  const files = ["settings.json", "launcher/settings.json"];
  return !port.marker ? files : files.concat(["png", "ico"].map((extension) => `launcher/${port.marker}.${extension}`),
    [`launcher/${port.marker}_launcher.py`, `launcher/${port.marker}_launcher_win.py`, `launcher/${port.marker}_launcher_windows.py`]);
}
function localSettingsFile(root) {
  const files = [path.join(root, "settings.json"), path.join(root, "launcher", "settings.json")].filter(regularFile);
  if (files.length > 1) throw new Error("Multiple local launcher settings files found; keep one source for the PS4 Recomp installation");
  return files[0] || "";
}
function installationProfile(port, root) {
  if (port.port === "uncharted") return port;
  const file = localSettingsFile(root);
  return file ? { ...port, settingsFile: file } : port;
}
function genericPort(root, script) {
  // Recognize the shared PS4 runner contract, without game titles or exe names.
  if (!/boot-linked\.bin|--app0/.test(script)) return null;
  const prefixes = [...new Set([...script.matchAll(/\b([A-Z][A-Z0-9_]*)_GAME_DIR\b/g)].map((match) => match[1]))];
  if (prefixes.length > 1) return null;
  let file = localSettingsFile(root);
  if (!file) {
    // Only inspect bounded launcher sources for a literal settings directory.
    // Do not search arbitrary AppData folders or execute the launcher's code.
    let declarations = script;
    const directory = path.join(root, "launcher");
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory).filter((name) => /\.py$/i.test(name)).slice(0, 32)) {
      const source = path.join(directory, name);
      if (regularFile(source) && fs.statSync(source).size <= 256 * 1024) declarations += "\n" + fs.readFileSync(source, "utf8");
    }
    const hints = [...new Set([...declarations.matchAll(/['"]([a-z0-9][a-z0-9._-]*[-_]launcher)['"]/gi)].map((match) => match[1]))];
    const candidates = hints.map((settings) => settingsFile({ settings })).filter(regularFile);
    if (candidates.length > 1) throw new Error("Ambiguous PS4 Recomp launcher settings location");
    file = candidates[0] || "";
  }
  if (!prefixes.length && !file && !regularFile(path.join(root, "sce_sys", "param.sfo"))) return null;
  return { port: "generic", env: prefixes[0] || "", launcher: "", settingsFile: file };
}
function installation(root) {
  try {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const script = runScript(root);
    if (!script) return null;
    // Port-owned assets retain existing launcher-location hints. An inherited
    // game name in a runner comment must not select another port's settings.
    const assets = PORTS.filter((port) => identityFiles(port).some((relative) => !relative.endsWith("settings.json") && regularFile(path.join(root, relative))));
    const identified = assets;
    if (identified.length === 1) return installationProfile(identified[0], root);
    // Older scripts may not identify the port. An existing named launcher is
    // optional supporting evidence, never the only installation signature.
    const names = fs.readdirSync(root);
    const launchers = PORTS.filter((port) => (!identified.length || identified.includes(port)) &&
      port.launcher &&
      names.some((name) => name.toLowerCase() === port.launcher.toLowerCase() && regularFile(path.join(root, name))));
    if (launchers.length === 1) return installationProfile(launchers[0], root);
    if (/big2-ps4_Shipping\.elf/.test(script) && /big3-ps4_Shipping\.elf/.test(script)) {
      return PORTS.find((port) => port.port === "uncharted");
    }
    return genericPort(root, script);
  } catch { return null; }
}
function runtimeProcessName(root, env) {
  const script = runScript(root);
  // Read a literal declaration, not arbitrary Python expressions or helpers.
  const expression = script.match(/^\s*probe\s*=\s*([^\r\n]+)/m)?.[1] || "";
  const overrideKey = expression.match(/(?:env|os\.environ)\[['"]([A-Z][A-Z0-9_]*_PROBE)['"]\]/)?.[1];
  if (overrideKey && env[overrideKey]) return path.basename(env[overrideKey]);
  const literal = expression.match(/find_executable\(\s*['"]([a-z0-9_.-]+)['"]\s*(\+\s*EXE_SUFFIX)?\s*\)/i);
  if (!literal) return "";
  return literal[1] + (literal[2] && process.platform === "win32" ? ".exe" : "");
}
function discoveryRootForFile(file) {
  const name = path.basename(file).toLowerCase(), parent = path.dirname(file);
  if (name === "run.py" || name === "settings.json" && regularFile(path.join(parent, "run.py")) ||
      PORTS.some((port) => port.launcher.toLowerCase() === name)) return parent;
  if (path.basename(parent).toLowerCase() === "launcher" && (name === "settings.json" || /\.py$/i.test(name) || PORTS.some((port) =>
    identityFiles(port).some((relative) => path.basename(relative).toLowerCase() === name)))) return path.dirname(parent);
  return "";
}
function nativeGameRoot(root, isBlocked = () => false) {
  const queue = [{ directory: root, depth: 0 }], found = [];
  let visited = 0;
  while (queue.length && visited++ < 128) {
    const { directory, depth } = queue.shift();
    if (isBlocked(directory)) continue;
    if (regularFile(path.join(directory, "sce_sys", "param.sfo"))) { found.push(directory); continue; }
    if (depth < 2) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !/^(?:bin|out|_internal|launcher|user|node_modules|\.git|sce_sys)$/i.test(entry.name)) {
        queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    }
  }
  if (queue.length || found.length > 1) throw new Error("PS4 Recomp game data is ambiguous; set game_dir in the launcher settings");
  return found[0] || "";
}
function detectGames(root, options = {}) {
  const port = installation(root);
  if (!port) return [];
  const cfg = settings(port), resolved = environment(port, root, cfg);
  if (options.isBlocked?.(resolved.userRoot) || resolved.gameRoot && options.isBlocked?.(resolved.gameRoot)) return [];
  const executable = port.launcher && fs.readdirSync(root).find((name) => name.toLowerCase() === port.launcher.toLowerCase() && regularFile(path.join(root, name))) || "";
  const processName = runtimeProcessName(root, resolved.env);
  if (port.port === "uncharted") return port.games.map(([game, title, trophySet]) => ({ platform: "ps4recomp", appid: game, game, title, name: title,
    port: port.port, installRoot: root, gameRoot: resolved.gameRoot, userRoot: resolved.userRoot,
    executable, processName, settingsFile: settingsFile(port), trophySet }));
  const gameRoot = resolved.gameRoot || nativeGameRoot(root, options.isBlocked);
  if (!gameRoot || options.isBlocked?.(gameRoot)) return [];
  const set = trophies.nativeSet(gameRoot, root), identity = gameIdentity(gameRoot);
  if (!set) throw new Error("PS4 Recomp trophy data missing; configure the original game folder and rescan");
  const appid = (set.npcommid || identity.ps4_recomp_title_id || "").toLowerCase();
  if (!appid) throw new Error("PS4 Recomp native identity missing: provide npbind.dat or param.sfo");
  const title = identity.ps4_recomp_title || set.npcommid || identity.ps4_recomp_title_id;
  return [{ ...identity, platform: "ps4recomp", appid, game: appid, title, name: title, npcommid: set.npcommid,
    port: port.port, installRoot: root, gameRoot, userRoot: resolved.userRoot, executable, processName,
    settingsFile: settingsFile(port), trophySet: set.trophySet }];
}
async function discoverGames(root, options = {}) {
  const queue = [{ directory: path.resolve(root), depth: 0 }], games = [], errors = [];
  let visited = 0;
  while (queue.length && visited++ < 400) {
    const { directory, depth } = queue.shift();
    if (options.isBlocked?.(directory)) continue;
    try {
      const detected = detectGames(directory, options);
      if (detected.length) { games.push(...detected); continue; }
      if (depth < 3) for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && !/^(?:bin|_internal|node_modules|\.git|user|sce_sys|out)$/i.test(entry.name)) queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
      }
    } catch (error) { errors.push({ root: directory, error: error.message }); }
    if (visited % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { games, errors, truncated: queue.length > 0 };
}
function source(config) { return config.ps4_recomp_user_root || path.dirname(config.save_path || ""); }
function progressFiles(config) {
  // Collections require session context; keep their existing log routing.
  return config.ps4_recomp_port === "uncharted" ? ["last_run.log"] : ["trophies.log", "last_run.log"];
}
function progressPath(config) {
  const root = source(config), names = progressFiles(config);
  const existing = names.find((name) => regularFile(path.join(root, name)));
  const saved = path.basename(config.save_path || "");
  return path.join(root, existing || (names.includes(saved) ? saved : "last_run.log"));
}
function cacheOptions(config) { return { ps4RecompSource: source(config) }; }
function hash(value) { return crypto.createHash("sha256").update(path.resolve(value).toLowerCase()).digest("hex").slice(0, 16); }
function cacheScope(config, options = {}) { return hash(options.ps4RecompSource || source(config)); }
function validSchema(config) {
  const schema = json(path.join(config.config_path || "", "achievements.json"));
  return Array.isArray(schema) && schema.length > 0 && schema.every((entry) => /^\d+$/.test(entry.name) && entry.trophyType && fs.existsSync(path.join(config.config_path, entry.icon)));
}
function changedWrite(file, value) {
  if (JSON.stringify(json(file)) === JSON.stringify(value)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomicSync(file, value, { backup: true }); return true;
}
function launchArguments(value, port) {
  // Only Uncharted opens the launcher without the former implicit --play.
  // Other ports retain their original default and configured arguments.
  if (port === "uncharted") return typeof value === "string" && value.trim() !== "--play" ? value : "";
  return typeof value === "string" ? value : "--play";
}
function reuseGameIdentity(game, configs) {
  const candidates = configs.filter((config) => config?.platform === "ps4recomp" && samePath(config.ps4_recomp_install_root, game.installRoot));
  let existing = candidates.find((config) => config.appid === game.appid);
  if (!existing && game.port !== "uncharted") {
    const matches = candidates.filter((config) => {
      if (config.ps4_recomp_port === "uncharted") return false;
      if (config.ps4_recomp_npcommid && game.npcommid) return config.ps4_recomp_npcommid === game.npcommid;
      if (config.ps4_recomp_title_id && game.ps4_recomp_title_id) return config.ps4_recomp_title_id === game.ps4_recomp_title_id;
      return samePath(config.ps4_recomp_game_root, game.gameRoot);
    });
    if (matches.length > 1) throw new Error("Multiple existing PS4 Recomp configs match this installation; identity cannot be migrated automatically");
    existing = matches[0];
  }
  return existing ? { ...game, appid: existing.appid, game: existing.ps4_recomp_game || existing.appid } : game;
}
async function generateConfig(game, configsDir, options = {}) {
  if (options.isCancelled?.()) throw new Error("PS4 Recomp import cancelled");
  fs.mkdirSync(configsDir, { recursive: true });
  const configs = fs.readdirSync(configsDir).filter((name) => name.endsWith(".json")).map((file) => ({ file, data: json(path.join(configsDir, file)) }));
  game = reuseGameIdentity(game, configs.map((entry) => entry.data));
  const previousEntry = configs
    .find(({ data }) => data?.platform === "ps4recomp" && data.appid === game.appid && samePath(data.ps4_recomp_install_root, game.installRoot));
  // New single-game names come from decrypted native metadata. Reuse this read
  // below, and keep collection titles and existing config filenames stable.
  let imported;
  if (!previousEntry && game.port !== "uncharted") {
    imported = await trophies.metadata(game);
    if (imported.title) game = { ...game, title: imported.title, name: imported.title };
  }
  const previous = previousEntry?.data || {}, name = previousEntry ? path.basename(previousEntry.file, ".json") : sanitizeConfigName(`${game.title} (PS4 Recomp)`);
  let finalName = name, suffix = 2;
  if (!previousEntry) while (fs.existsSync(path.join(configsDir, `${finalName}.json`))) finalName = `${name} [${suffix++}]`;
  const schemaDir = previous.config_path || path.join(configsDir, "schema", "ps4recomp", game.appid, hash(game.installRoot));
  let schemaUpdated = false;
  if (!validSchema(previous) || options.force) {
    options.onProgress?.({ phase: "generatingSchema", percent: 20, appid: game.appid, itemName: game.title });
    const { entries, icons } = imported || await trophies.metadata(game);
    const old = new Map((json(path.join(schemaDir, "achievements.json"), []) || []).map((entry) => [entry.name, entry]));
    if (options.isCancelled?.()) throw new Error("PS4 Recomp import cancelled");
    fs.mkdirSync(path.join(schemaDir, "img"), { recursive: true });
    const writeImage = (relative, bytes) => {
      const target = path.join(schemaDir, relative);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) fs.writeFileSync(target, bytes);
    };
    const schema = entries.map((entry) => {
      let icon, iconGray;
      const nativeIcon = icons.get(entry.name);
      if (nativeIcon) {
        // A content version prevents stale renderer images after manual Rescan.
        const version = crypto.createHash("sha256").update(nativeIcon).digest("hex").slice(0, 16);
        icon = `img/trop${entry.name.padStart(3, "0")}-${version}.png`;
        writeImage(icon, nativeIcon);
        // As with the native console imports, use the original icon for both states.
        iconGray = icon;
      } else {
        icon = `img/${entry.trophyType}.png`;
        iconGray = `img/${entry.trophyType}-gray.png`;
        writeImage(icon, trophies.trophyPng(entry.trophyType));
        writeImage(iconGray, trophies.trophyPng(entry.trophyType, true));
      }
      return { ...entry, ...(Number.isFinite(old.get(entry.name)?.rarityPct) ? { rarityPct: old.get(entry.name).rarityPct, raritySource: old.get(entry.name).raritySource } : {}),
        icon, icon_gray: iconGray };
    });
    if (options.isCancelled?.()) throw new Error("PS4 Recomp import cancelled");
    schemaUpdated = changedWrite(path.join(schemaDir, "achievements.json"), schema);
  }
  const nativePlatinum = schemaHasNativePlatinum(json(path.join(schemaDir, "achievements.json")));
  const config = { ...previous, ...gameIdentity(game.gameRoot), name: finalName, displayName: game.title, appid: game.appid, platform: "ps4recomp", native_platinum: nativePlatinum,
    config_path: schemaDir, save_path: progressPath({ ps4_recomp_port: game.port, ps4_recomp_user_root: game.userRoot, save_path: previous.save_path }),
    ps4_recomp_game: game.game, ps4_recomp_port: game.port, ps4_recomp_install_root: game.installRoot,
    ps4_recomp_game_root: game.gameRoot, ps4_recomp_user_root: game.userRoot, ps4_recomp_settings_file: game.settingsFile,
    ps4_recomp_npcommid: game.npcommid || previous.ps4_recomp_npcommid || "",
    ps4_recomp_trophy_set: game.trophySet,
    executable: previous.executable || (game.executable ? path.join(game.installRoot, game.executable) : ""),
    arguments: launchArguments(previous.arguments, game.port),
    process_name: previous.process_name && previous.process_name !== "bb-probe.exe" ? previous.process_name :
      game.processName || previous.process_name || "", language: previous.language || "english" };
  delete config.ps4_recomp_cache_root;
  options.onProgress?.({ phase: "finalizingConfig", percent: 90, appid: game.appid, itemName: game.title });
  const configUpdated = changedWrite(path.join(configsDir, `${finalName}.json`), config);
  return { ...config, config, schemaDir, created: !previousEntry, schemaUpdated, configUpdated };
}
function gameFromText(text) {
  if (/big2(?:-ps4_Shipping\.elf|[\\/].*boot-linked\.bin)/i.test(text)) return "u2";
  if (/big3(?:-ps4_Shipping\.elf|[\\/].*boot-linked\.bin)/i.test(text)) return "u3";
  if (/(?:eboot\.bin|[\\/]eboot[\\/].*boot-linked\.bin)/i.test(text)) return "u1";
  return "";
}
function matchesProcess(config, entry) {
  if (!config.ps4_recomp_install_root) return false;
  const root = path.resolve(config.ps4_recomp_install_root).toLowerCase();
  const cmd = String(entry.cmd || entry.command || "").toLowerCase();
  const user = /(?:^|\s)--user\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd);
  if (!getProcessExecutableNames(config.process_name).includes(String(entry.name || "").toLowerCase()) || !cmd.includes(root + path.sep) ||
      !user || !samePath(user[1] || user[2] || user[3], source(config))) return false;
  return config.ps4_recomp_port !== "uncharted" || gameFromText(cmd) === config.ps4_recomp_game;
}
function observeRuntimeProcesses(processes) {
  const list = Array.isArray(processes) ? processes : [];
  latestRuntimeInput = list;
  const now = Date.now(), pids = new Set(list.map((entry) => entry.pid));
  for (const pid of runtimeFirstSeen.keys()) if (!pids.has(pid)) runtimeFirstSeen.delete(pid);
  for (const entry of list) if (!runtimeFirstSeen.has(entry.pid)) runtimeFirstSeen.set(entry.pid, now);
}
function updateRuntimeProcesses(processes) {
  const list = Array.isArray(processes) ? processes : [];
  // Command-line enrichment is asynchronous. An older result must not revive
  // a process already removed by a newer native snapshot.
  if (latestRuntimeInput !== null && latestRuntimeInput !== list) return;
  if (latestRuntimeInput === null) observeRuntimeProcesses(list);
  // Own a stable copy: the native poller can replace its name-only entries.
  runtimeProcesses = list.filter((entry) => /(?:^|\s)--user\s/.test(String(entry.cmd || entry.command || "")))
    .map((entry) => ({ ...entry, observedAt: runtimeFirstSeen.get(entry.pid) }));
  const fingerprint = JSON.stringify(runtimeProcesses.map((entry) => [entry.pid, entry.name, entry.cmd || entry.command]).sort((a, b) => a[0] - b[0]));
  if (fingerprint === runtimeFingerprint) return;
  runtimeFingerprint = fingerprint;
  for (const listener of runtimeListeners) { try { listener(); } catch {} }
}
function subscribeRuntimeProcesses(listener) {
  runtimeListeners.add(listener);
  return () => runtimeListeners.delete(listener);
}
function runtimeIdentity(config) {
  const processes = runtimeProcesses || require("./process-poller").getSnapshot();
  const matches = processes.filter((entry) => (runtimeProcesses === null || runtimeFirstSeen.has(entry.pid)) && matchesProcess({ ...config,
    ps4_recomp_game: config.ps4_recomp_port === "uncharted" ? gameFromText(String(entry.cmd || "")) : config.ps4_recomp_game }, entry));
  if (matches.length !== 1) return null;
  const entry = matches[0];
  return { game: config.ps4_recomp_port === "uncharted" ? gameFromText(entry.cmd) : config.ps4_recomp_game,
    session: `${entry.pid}:${entry.observedAt || 0}`, observedAt: entry.observedAt || Date.now() };
}
function runningGame(config) { return runtimeIdentity(config)?.game || ""; }
// Only log routing is shared between collection clients. Earned progress lives
// exclusively in each config's ordinary achievement cache.
const routingStates = new Map();
const CACHE_METADATA = Symbol("ps4-recomp-cache-metadata");
const CACHE_METADATA_KEY = "__ps4Recomp";
let cacheStorage = null;
const observers = new Map();
const parsedLogs = new Map();
const appliedLogReads = new Map();
function observerKey(config) { return `${hash(config.ps4_recomp_install_root)}:${cacheScope(config)}`; }
function observeSource(config) {
  const key = observerKey(config);
  observers.set(key, (observers.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (observers.get(key) || 1) - 1;
    if (count) observers.set(key, count); else observers.delete(key);
  };
}
function configureCacheStorage(storage) { cacheStorage = storage; }
function cacheIdentity(config) {
  return { game: String(config.ps4_recomp_game || config.appid || ""),
    installRoot: path.resolve(config.ps4_recomp_install_root), sourceRoot: path.resolve(source(config)) };
}
function validCacheMetadata(config, metadata) {
  if (!metadata || metadata.version !== 1 || metadata.game !== cacheIdentity(config).game ||
      !samePath(metadata.installRoot, config.ps4_recomp_install_root) || !samePath(metadata.sourceRoot, source(config)) ||
      !metadata.routing || !metadata.routing.sources || !metadata.routing.unassigned || !metadata.trophies ||
      !Number.isSafeInteger(metadata.routing.updatedAt) || metadata.routing.updatedAt < 0 ||
      [metadata.routing.sources, metadata.routing.unassigned, metadata.trophies].some((value) =>
        typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid PS4 Recomp cache metadata or game identity");
  return metadata;
}
function decodeCache(config, document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid PS4 Recomp achievement cache");
  const snapshot = {};
  for (const [id, entry] of Object.entries(document)) {
    if (id === CACHE_METADATA_KEY) continue;
    if (!/^\d{1,4}$/.test(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid PS4 Recomp cached trophy");
    }
    snapshot[id] = entry;
  }
  const metadata = document[CACHE_METADATA_KEY] || document[CACHE_METADATA];
  if (metadata) {
    // Symbols survive object spreads but are omitted by Object.entries/JSON.
    // Shared achievement consumers therefore never see internal log records.
    snapshot[CACHE_METADATA] = validCacheMetadata(config, metadata);
  }
  return snapshot;
}
function encodeCache(config, snapshot, previous = {}, metadataSource = snapshot) {
  const document = Object.fromEntries(Object.entries(snapshot));
  const incomingMetadata = metadataSource[CACHE_METADATA];
  const previousMetadata = previous[CACHE_METADATA];
  // A late UI/boot snapshot or empty source cannot roll back an unlock already
  // committed by the watcher. Explicit reset removes this config's cache.
  for (const [id, entry] of Object.entries(previous)) {
    if (!/^\d{1,4}$/.test(id) || !entry?.earned) continue;
    if (!document[id]?.earned) document[id] = { ...document[id], ...entry };
    else if (!document[id].earned_time && entry.earned_time) {
      document[id] = { ...document[id], earned_time: entry.earned_time };
    }
    if (previousMetadata?.trophies[id]?.timeSource === "native" &&
        incomingMetadata?.trophies[id]?.timeSource !== "native" && entry.earned_time) {
      document[id] = { ...document[id], earned_time: entry.earned_time };
    }
  }
  const metadata = incomingMetadata || previousMetadata;
  if (metadata) {
    const latest = previousMetadata && previousMetadata.routing.updatedAt > metadata.routing.updatedAt ? previousMetadata : metadata;
    const trophies = { ...previousMetadata?.trophies, ...metadata.trophies };
    for (const [id, flags] of Object.entries(previousMetadata?.trophies || {})) {
      if (flags.timeSource === "native") trophies[id] = { ...trophies[id], timeSource: "native" };
    }
    document[CACHE_METADATA_KEY] = validCacheMetadata(config, { ...latest, trophies });
  }
  return document;
}
function readStoredCache(config) {
  const file = cacheStorage.getPath(config);
  if (!fs.existsSync(file)) return {};
  return decodeCache(config, JSON.parse(fs.readFileSync(file, "utf8")));
}
function collectionConfigs(config) {
  const configs = cacheStorage.getConfigs().filter((candidate) => candidate.platform === "ps4recomp" &&
    samePath(candidate.ps4_recomp_install_root, config.ps4_recomp_install_root) && samePath(source(candidate), source(config)));
  if (!configs.some((candidate) => cacheStorage.getPath(candidate) === cacheStorage.getPath(config))) configs.push(config);
  return configs;
}
function mergeEarned(snapshot, incoming, schemaIds) {
  for (const [id, entry] of Object.entries(incoming || {})) {
    if (!schemaIds.has(id) || !entry?.earned) continue;
    const old = snapshot[id];
    const times = [Number(old?.earned_time), Number(entry.earned_time)].filter((time) => Number.isSafeInteger(time) && time > 0);
    snapshot[id] = { ...entry, ...old, earned: true, earned_time: times.length ? Math.min(...times) : 0 };
  }
  return snapshot;
}
function migrateLegacyCache(config, configs) {
  const canonical = path.join(path.dirname(cacheStorage.getPath(config)), "ps4recomp", "progress");
  const legacyRoot = config.ps4_recomp_cache_root || canonical;
  const file = path.join(legacyRoot, `${hash(config.ps4_recomp_install_root)}-${cacheScope(config)}.json`);
  if (!fs.existsSync(file) && !fs.existsSync(file + ".bak")) return;
  const loaded = readJsonWithBackupSync(file, { fallback: null });
  const legacy = loaded.value;
  if (![1, 2].includes(legacy?.version) || !legacy.games || typeof legacy.games !== "object" || Array.isArray(legacy.games)) {
    throw new Error("PS4 Recomp legacy progress could not be recovered");
  }
  migrateProgressJournal(legacy);
  const planned = new Map(), covered = new Set();
  for (const peer of configs) {
    const identity = cacheIdentity(peer), snapshot = readStoredCache(peer);
    const schema = json(path.join(peer.config_path, "achievements.json"), []);
    if (!Array.isArray(schema) || !schema.length) throw new Error("PS4 Recomp migration requires each collection game's schema");
    const ids = new Set(schema.map((entry) => entry.name));
    const trophies = { ...(snapshot[CACHE_METADATA]?.trophies || {}) };
    const keys = [identity.game];
    // Old single-game configs used the port label before native NP identities.
    if (configs.length === 1 && peer.ps4_recomp_port !== "uncharted") keys.push(peer.ps4_recomp_port);
    for (const key of new Set(keys)) {
      if (!Object.hasOwn(legacy.games, key)) continue;
      for (const [id, entry] of Object.entries(legacy.games[key])) {
        if (!entry?.earned) continue;
        if (!ids.has(id)) throw new Error("PS4 Recomp migration found a trophy outside its game's schema");
        trophies[id] = { historical: true,
          ...(entry.timeSource === "native" || trophies[id]?.timeSource === "native" ? { timeSource: "native" } : {}) };
      }
      mergeEarned(snapshot, legacy.games[key], ids);
      for (const [id, entry] of Object.entries(legacy.games[key])) {
        if (entry?.earned && entry.timeSource === "native" && Number(entry.earned_time) > 0) {
          snapshot[id].earned_time = Number(entry.earned_time);
        }
      }
      covered.add(key);
    }
    snapshot[CACHE_METADATA] = { version: 1, ...identity, trophies,
      routing: { updatedAt: Date.now(), sources: legacy.sources, unassigned: legacy.unassigned || {} } };
    const document = encodeCache(peer, snapshot);
    const target = cacheStorage.getPath(peer);
    if (planned.has(target)) throw new Error("PS4 Recomp collection cache collision");
    planned.set(target, document);
  }
  if (Object.entries(legacy.games).some(([key, entries]) => !covered.has(key) && Object.values(entries).some((entry) => entry?.earned))) {
    throw new Error("PS4 Recomp migration cannot identify the config for all legacy trophies");
  }
  // A partial migration is harmless: the journal remains until every target
  // has been written and read back. Repeating this merge is idempotent.
  for (const [target, document] of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeJsonAtomicSync(target, document);
  }
  for (const [target, document] of planned) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(target, "utf8"))) !== JSON.stringify(document)) {
      throw new Error("PS4 Recomp cache migration verification failed");
    }
  }
  // Remove backup first so an interruption cannot leave it as the only old
  // source and restore a deliberately reset cache on a future startup.
  for (const target of [file + ".bak", file]) if (fs.existsSync(target)) fs.unlinkSync(target);
}
function routing(config) {
  if (!cacheStorage) throw new Error("PS4 Recomp achievement cache storage is not configured");
  const key = observerKey(config);
  if (!routingStates.has(key)) {
    const configs = collectionConfigs(config);
    migrateLegacyCache(config, configs);
    let state = { updatedAt: 0, sources: {}, unassigned: {} };
    for (const peer of configs) {
      const metadata = readStoredCache(peer)[CACHE_METADATA];
      if (metadata && Number(metadata.routing.updatedAt) > state.updatedAt) state = metadata.routing;
    }
    routingStates.set(key, JSON.parse(JSON.stringify(state)));
  }
  return { key, state: routingStates.get(key) };
}

function logCollector(name) {
  const digest = crypto.createHash("sha256"), decoder = new StringDecoder("utf8");
  const records = [], counts = new Map(), head = Buffer.alloc(32768);
  let headLength = 0, pending = "", context = "", hasMarkers = false;
  const line = (text) => {
    text = text.replace(/\r$/, "");
    if (/^(?:Preparing |Switching to |Runtime: SystemService: load executable )/.test(text)) {
      const next = gameFromText(text);
      if (next) { context = next; hasMarkers = true; }
    }
    const match = name === "trophies.log" ? /^(\d{1,4})\s+(\d+)\s*$/.exec(text) : /Runtime: trophy (\d{1,4}) unlocked\b/.exec(text);
    if (!match) return;
    const id = String(Number(match[1])), count = (counts.get(id) || 0) + 1;
    counts.set(id, count);
    records.push({ key: `${id}:${count}`, id, context, time: name === "trophies.log" ? Number(match[2]) * 1000 : 0 });
  };
  return {
    push(bytes) {
      digest.update(bytes);
      headLength += bytes.copy(head, headLength, 0, Math.min(bytes.length, head.length - headLength));
      pending += decoder.write(bytes);
      let start = 0, end;
      while ((end = pending.indexOf("\n", start)) >= 0) { line(pending.slice(start, end)); start = end + 1; }
      pending = pending.slice(start);
      if (pending.length > 8 * 1024 * 1024) throw new Error("PS4 Recomp log contains an oversized unfinished line");
    },
    finish(target, stat) {
      // An unfinished line is deliberately omitted; the next complete read
      // will include it once its newline has been written.
      const hash = digest.digest("hex"), cached = parsedLogs.get(target);
      const result = { name, hash, size: stat.size, mtimeMs: stat.mtimeMs,
        identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
        head: head.subarray(0, headLength), hasMarkers, records: cached?.hash === hash ? cached.records : records };
      parsedLogs.set(target, result);
      return result;
    },
  };
}

async function readProgressLog(config, name) {
  const target = path.join(source(config), name);
  let handle;
  try {
    const pathStat = await fs.promises.lstat(target);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("Invalid PS4 Recomp log file");
    handle = await fs.promises.open(target, "r");
    const stat = await handle.stat(), collector = logCollector(name), buffer = Buffer.alloc(65536);
    if (!stat.isFile()) throw new Error("Invalid PS4 Recomp log file");
    // Each pass starts at zero and reads only the size captured on open.
    // A continuously growing file cannot keep this pass running forever.
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) throw new Error("PS4 Recomp log changed during reading");
      collector.push(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat(), current = await fs.promises.lstat(target);
    if (after.size < stat.size || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) {
      throw new Error("PS4 Recomp log changed during reading");
    }
    return collector.finish(target, stat);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { name, missing: true };
    return { name, error: error.message };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function readProgressLogs(config) {
  const files = await Promise.all(progressFiles(config).map((name) => readProgressLog(config, name)));
  return { files, observedAt: Date.now() };
}

function readProgressLogsSync(config) {
  // Compatibility for unmonitored UI/import reads. Live monitoring always
  // supplies the single asynchronously read source shared by its clients.
  const files = progressFiles(config).map((name) => {
    const target = path.join(source(config), name);
    let fd;
    try {
      const pathStat = fs.lstatSync(target);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("Invalid PS4 Recomp log file");
      fd = fs.openSync(target, "r");
      const stat = fs.fstatSync(fd), collector = logCollector(name), buffer = Buffer.alloc(65536);
      for (let position = 0; position < stat.size;) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!count) throw new Error("PS4 Recomp log changed during reading");
        collector.push(buffer.subarray(0, count)); position += count;
      }
      const after = fs.fstatSync(fd), current = fs.lstatSync(target);
      if (after.size < stat.size || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("PS4 Recomp log changed during reading");
      return collector.finish(target, stat);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { name, missing: true };
      return { name, error: error.message };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  return { files, observedAt: Date.now() };
}

function migrateProgressJournal(state) {
  if (state.version === 2) return;
  state.sources = {};
  for (const [name, cursor] of Object.entries(state.cursors || {})) {
    state.sources[name] = { generation: cursor.generation || crypto.randomBytes(12).toString("hex"),
      size: cursor.offset || 0, headLength: cursor.prefixLength || 0, headHash: cursor.prefixHash || "",
      defaultGame: cursor.context || "", session: cursor.session || "", records: {}, legacy: true };
  }
  // Keep unresolved entries from the old parser. They are only recovered when
  // their source generation can still be proved, never assigned to a later run.
  state.unassigned ||= {};
  delete state.cursors;
  state.version = 2;
}
function loadConfigSnapshot(config, previous = {}, options = {}) {
  try {
    const game = String(config.ps4_recomp_game || config.appid || "");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(game) || ["constructor", "prototype"].includes(game) ||
        ![config.ps4_recomp_install_root, config.config_path, source(config)].every((value) =>
          typeof value === "string" && path.isAbsolute(value))) throw new Error("Invalid PS4 Recomp progress configuration");
    const schema = json(path.join(config.config_path, "achievements.json"), []);
    if (!Array.isArray(schema) || !schema.length || schema.some((entry) => !/^\d{1,4}$/.test(entry?.name || ""))) {
      throw new Error("PS4 Recomp progress requires a valid native trophy schema");
    }
    const schemaIds = new Set(schema.map((entry) => entry.name));
    const stored = routing(config), key = stored.key, before = JSON.stringify(stored.state);
    const state = JSON.parse(before);
    const cached = readStoredCache(config);
    const earned = mergeEarned({ ...previous }, cached, schemaIds);
    const trophies = { ...(cached[CACHE_METADATA]?.trophies || {}), ...(previous[CACHE_METADATA]?.trophies || {}) };
    const collection = config.ps4_recomp_port === "uncharted";
    const remember = (id, time, key, historical, nativeTime) => {
      if (key !== game || !schemaIds.has(id)) return;
      const old = earned[id], flags = trophies[id];
      const timestamp = Number.isSafeInteger(time) && time > 0 && time <= 8640000000000000 ? time : 0;
      const earnedTime = nativeTime && timestamp && flags?.timeSource !== "native" ? timestamp
        : old?.earned_time && nativeTime && flags?.timeSource === "native" && timestamp ? Math.min(old.earned_time, timestamp)
          : old?.earned_time || timestamp;
      earned[id] = { ...old, earned: true, earned_time: earnedTime };
      trophies[id] = { ...(old?.earned ? flags?.historical ? { historical: true } : {} : historical ? { historical: true } : {}),
        ...(nativeTime && timestamp || flags?.timeSource === "native" ? { timeSource: "native" } : {}) };
    };
    // Monitored UI/cache consumers only read cached progress. The watcher supplies
    // one complete asynchronous source read shared by its collection clients.
    const canRead = !observers.has(observerKey(config)) || options.observe === true;
    const logRead = canRead ? options.logRead || readProgressLogsSync(config) : null;
    const consume = logRead && appliedLogReads.get(key) !== logRead;
    if (consume) {
      const failed = logRead.files.find((entry) => entry.error);
      if (failed) throw new Error(failed.name + ": " + failed.error);
      if (!state.sources || typeof state.sources !== "object" || Array.isArray(state.sources) ||
          !state.unassigned || typeof state.unassigned !== "object" || Array.isArray(state.unassigned)) throw new Error("Invalid PS4 Recomp progress sources");
      const identity = collection ? runtimeIdentity(config) : null;
      for (const input of logRead.files) {
        const name = input.name;
        let current = state.sources[name];
        if (input.missing) {
          if (!current) state.sources[name] = { missing: true, generation: crypto.randomBytes(12).toString("hex"), records: {}, defaultGame: "", session: "" };
          else current.missing = true;
          continue;
        }
        const changed = !current || current.missing || current.hash !== input.hash;
        const inputRecords = new Map(input.records.map((entry) => [entry.key, entry]));
        const sequenceChanged = current && Object.entries(current.records || {}).some(([key, record]) =>
          !inputRecords.has(key) || record.context !== undefined && record.context !== inputRecords.get(key).context);
        const prefixMatches = !current?.headLength || input.head.length >= current.headLength &&
          crypto.createHash("sha256").update(input.head.subarray(0, current.headLength)).digest("hex") === current.headHash;
        const replaced = current && (current.missing || current.identity && current.identity !== input.identity ||
          input.size < current.size || !prefixMatches || sequenceChanged);
        if (replaced) {
          for (const [key, record] of Object.entries(current.records || {})) if (!record.game) {
            state.unassigned[name + ":" + current.generation + ":" + key] = { ...record, source: name, generation: current.generation };
          }
          current = null;
        }
        current ||= { generation: crypto.randomBytes(12).toString("hex"), records: {}, defaultGame: "", session: "" };
        if (!current.records || typeof current.records !== "object" || Array.isArray(current.records)) throw new Error("Invalid PS4 Recomp source records");
        if (current.legacy && collection && !current.headLength) current.defaultGame = "";
        if (identity && current.session && current.session !== identity.session && current.defaultGame !== identity.game) {
          current.defaultGame = ""; current.session = "";
        }
        if (options.live && changed) current.liveChangeAt = logRead.observedAt;
        const changedDuringSession = identity && current.liveChangeAt >= (options.since || logRead.observedAt) - 2000 &&
          current.liveChangeAt >= identity.observedAt - 2000;
        const fresh = identity && (changedDuringSession || input.mtimeMs >= (options.since || logRead.observedAt) - 2000 &&
          input.mtimeMs >= identity.observedAt - 2000);
        if (fresh) { current.defaultGame = identity.game; current.session = identity.session; }
        if (!collection) current.defaultGame = game;
        // The last context in a collection log does not identify an earlier,
        // unmarked segment. Only retain an initial owner proved before a
        // transition marker was observed in this source generation.
        if (!input.hasMarkers && current.defaultGame && !current.initialGame) current.initialGame = current.defaultGame;
        for (const event of input.records) {
          let record = current.records[event.key];
          if (record && record.id !== event.id) throw new Error("PS4 Recomp log changed its recorded trophy sequence");
          if (!record) {
            const historical = !options.live || name === "trophies.log" && event.time > 0 && event.time < (options.since || 0) - 2000;
            record = { id: event.id, context: event.context, game: "", time: event.time || (historical ? 0 : logRead.observedAt),
              historical, observedAt: logRead.observedAt, session: identity?.session || current.session || "" };
            current.records[event.key] = record;
          }
          // Full rereads preserve each event's original game, even after a
          // different executable of the collection becomes active.
          if (!record.game) {
            const sameSession = !record.session || record.session === current.session;
            const observedInSession = !identity || record.observedAt >= identity.observedAt - 2000;
            const explicit = collection && event.context && (record.historical || !fresh || event.context === identity?.game) ? event.context : "";
            const defaultGame = input.hasMarkers ? current.initialGame : current.defaultGame;
            record.game = explicit || (!collection ? game : !event.context &&
              defaultGame && sameSession && observedInSession ? defaultGame : "");
          }
        }
        if (current.legacy && current.defaultGame) {
          for (const [key, pending] of Object.entries(state.unassigned)) {
            if (pending.source !== name || pending.generation !== current.generation ||
                pending.session && pending.session !== current.session) continue;
            pending.game = current.defaultGame;
          }
        }
        delete current.legacy;
        Object.assign(current, { identity: input.identity, hash: input.hash, size: input.size, missing: false,
          headLength: input.head.length, headHash: crypto.createHash("sha256").update(input.head).digest("hex") });
        state.sources[name] = current;
      }
    }
    // Each collection client projects the same routed read into its own cache.
    // The first client must not consume another game's unlock or persist it as
    // progress belonging to the selected config.
    for (const [name, input] of Object.entries(state.sources)) {
      // Routing retained in a sibling collection cache is not achievement
      // history. A missing log must never resurrect a deliberately removed
      // game's cache from those old routing records.
      if (input.missing) continue;
      for (const record of Object.values(input.records || {})) {
        if (record.game) remember(record.id, record.time, record.game, record.historical, name === "trophies.log");
      }
    }
    for (const record of Object.values(state.unassigned)) {
      const input = state.sources[record.source];
      if (record.game && input && !input.missing && input.generation === record.generation) {
        remember(record.id, record.time, record.game, record.historical, record.source === "trophies.log");
      }
    }
    if (before !== JSON.stringify(state)) {
      state.updatedAt = Math.max(Date.now(), (Number(stored.state.updatedAt) || 0) + 1);
      routingStates.set(key, state);
    }
    if (consume) appliedLogReads.set(key, logRead);
    const snapshot = Object.fromEntries(schema.map((entry) => {
      const value = earned[entry.name] || previous[entry.name] || { earned: false, earned_time: 0 };
      return [entry.name, { ...value, earned: value.earned, earned_time: value.earned_time }];
    }));
    const metadata = { version: 1, ...cacheIdentity(config), routing: state, trophies };
    snapshot[CACHE_METADATA] = metadata;
    const cacheChanged = JSON.stringify(cached[CACHE_METADATA]) !== JSON.stringify(metadata);
    const historicalIds = schema.filter((entry) => trophies[entry.name]?.historical).map((entry) => entry.name);
    const pendingContext = Object.values(state.sources || {}).some((entry) => !entry.missing &&
      Object.values(entry.records || {}).some((record) => !record.game));
    return { valid: true, snapshot, more: false, historicalIds, pendingContext, cacheChanged };
  } catch (error) { return { valid: false, snapshot: previous, error: error.message }; }
}
module.exports = { PORTS, settings, settingsFile, environment, installation, identityFiles, discoveryRootForFile, detectGames, discoverGames, generateConfig, validSchema, reuseGameIdentity,
  source, progressPath, progressFiles, cacheOptions, cacheScope, loadConfigSnapshot, observeSource, samePath, inside, runningGame, matchesProcess,
  launchArguments, observeRuntimeProcesses, updateRuntimeProcesses, subscribeRuntimeProcesses, runtimeIdentity, readProgressLogs,
  configureCacheStorage, decodeCache, encodeCache };
