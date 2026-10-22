"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./x360-recomp-state");
const { readDeclarations, expandPath, readPortConfig, argumentPaths, pathArguments } = require("./x360-recomp-paths");
const { NAME: MANIFEST_NAME, readManifest } = require("./x360-recomp-manifest");
const { readImports } = require("./x360-recomp-pe");

// Specific native-port executables; generic launcher.exe is never a signature.
const PORTS = [
  { id: "53450812", title: "Sonic Unleashed", names: ["unleashedrecomp.exe"], adapter: "unleashed", format: "unleashed" },
  { id: "454108CF", title: "Dante's Inferno", names: ["dantes_inferno.exe", "dantes_inferno_native.exe", "dantesinferno.exe"], app: "dantes_inferno" },
  { id: "5752084B", title: "LEGO Dimensions", names: ["legodimensions.exe"], app: "legodimensions" },
  { id: "545407F8", title: "Midnight Club: Los Angeles", names: ["midnightclubla.exe"], app: "midnightclubla" },
  { id: "545407F8", title: "Midnight Club: Los Angeles", names: ["mcla.exe"], app: "mcla" },
  { id: "545407F8", title: "Midnight Club: Los Angeles", names: ["larecomp.exe"], app: "larecomp" },
  { id: "415608B2", title: "Spider-Man: Edge of Time", names: ["spidermaneot.exe"], app: "spider_man_edge_of_time", format: "tsv" },
  { id: "4D5307DF", title: "Blue Dragon (re:Blue)", names: ["reblue.exe"], app: "reblue", adapter: "reblue" },
  { id: "4D5307FA", title: "Lost Odyssey", names: ["lostodysseyrecomp.exe"], adapter: "ini-earned", format: "ini-earned",
    gamePathFile: "game-path.txt", gameFolders: ["game/disc1", "game", "disc1"], progressFile: "profile/achievements.ini" },
  { id: "58410847", ids: ["58410847", "5841089D"], title: "Castlevania: Symphony of the Night", names: ["nocturnerecomp.exe"], app: "nocturnerecomp", saveLayout: true },
  { id: "4B4E0823", title: "Silent Hill: Downpour", names: ["downpour.exe"], app: "downpour", userFolder: "user", gameFolders: ["assets"], saveLayout: true },
  { id: "4D5607D1", title: "Deadly Premonition", names: ["deadlyprem.exe"], app: "deadlyprem", userFolder: "userdata", cliAlwaysOverrides: true, gameFolders: ["assets"], saveLayout: true },
  { id: "494F07D4", title: "Deadly Premonition", names: ["deadlyprem_usa.exe"], app: "deadlyprem", userFolder: "userdata", cliAlwaysOverrides: true, gameFolders: ["assets"], saveLayout: true },
  { id: "4D5307F1", title: "Fable II", names: ["fable_2.exe"], app: "fable_2", userFolder: "saves", forceUserFolder: true, saveLayout: true },
  { id: "464F07D8", title: "Naughty Bear (ReStuff)", names: ["restuff.exe"], app: "restuff", gameFolders: ["assets"], saveLayout: true },
  { id: "534507EF", title: "Condemned 2: Bloodshot", names: ["condemned2recomp.exe"], app: "condemned2recomp", userFolder: "UserData", gameFolders: ["Assets"], saveLayout: true },
  { id: "4D5307F9", title: "Project Gotham Racing 4", names: ["pgr4_recomp.exe"], app: "pgr4_recomp", saveLayout: true },
  { id: "4D5307F9", title: "Project Gotham Racing 4", names: ["pgr4_recompiled.exe"], app: "pgr4_recompiled", saveLayout: true },
  { id: "4D5308BC", title: "Crackdown 2", names: ["crackdown2.exe"], app: "crackdown2", saveLayout: true },
  { id: "4D5307ED", title: "Banjo-Kazooie: Nuts & Bolts (reNut)", names: ["renut.exe"], app: "renut", pathConfig: "renut.cfg", saveLayout: true },
  // The verified 2.0.2 SDK acknowledges unlocks but does not persist them.
  // Import its metadata without inventing a TOML progress source. An observed
  // supported state or an explicit manifest can still enable a later build/mod.
  { id: "454108E6", title: "Skate 3", names: ["skate3.exe"], app: "skate3", roaming: true, progressUnavailable: true },
];
const RUNTIMES = ["rexruntime.dll", "rexruntimerd.dll"];
const acceptsTitle = (port, id) => port.id === id || port.ids?.includes(id);
const safeProfile = (name) => state.validProfile(name) && !["__proto__", "constructor", "prototype"].includes(name);
function portableHint(root, entries, blocked) {
  const has = (name, type) => entries.some(entry => entry.name.toLowerCase() === name && entry[type]() &&
    !entry.isSymbolicLink() && !blocked(path.join(root, entry.name)));
  return has("game-path.txt", "isFile") && (has("settings.ini", "isFile") || has("profile", "isDirectory")) &&
    entries.some(entry => entry.isFile() && /\.exe$/i.test(entry.name) && !blocked(path.join(root, entry.name)) && isPeFile(path.join(root, entry.name)));
}

// Only installations with native-port evidence enter early discovery. A save
// file, XEX alone, or a generic launcher name cannot claim a watched root.
function hasInstallationHint(root, options = {}) {
  if (options.isBlocked?.(root)) return false;
  const entries = filesAt(root);
  return portableHint(root, entries, options.isBlocked || (() => false)) || entries.some((entry) => entry.isFile() && !entry.isSymbolicLink() &&
    !options.isBlocked?.(path.join(root, entry.name)) &&
    (entry.name.toLowerCase() === MANIFEST_NAME ||
      PORTS.some((port) => port.names.includes(entry.name.toLowerCase())) && isPeFile(path.join(root, entry.name)) ||
      RUNTIMES.includes(entry.name.toLowerCase()) && isPeFile(path.join(root, entry.name), true)));
}

function validateKnownInstallation(config, options = {}) {
  const root = config?.x360_recomp_install_root;
  if (!root || config.x360_recomp_source_only === true || options.isBlocked?.(root)) return false;
  const executable = config.executable;
  const titleId = String(config.appid || "").toUpperCase();
  const xex = config.x360_recomp_xex_path;
  if (xex && (options.isBlocked?.(xex) || readXexTitle(xex) !== titleId)) return false;
  if (config.x360_recomp_generic === true && xex) {
    return !!genericNativePort(root, filesAt(root), titleId, options.isBlocked || (() => false));
  }
  if (!executable || options.isBlocked?.(executable) || !isPeFile(executable)) return false;
  const namedPort = PORTS.some((port) => acceptsTitle(port, titleId) &&
    port.names.includes(path.basename(executable).toLowerCase()) && inside(root, executable));
  if (namedPort) return true;
  if (!xex) return false;
  return filesAt(path.dirname(executable)).some((entry) => entry.isFile() && !entry.isSymbolicLink() &&
    RUNTIMES.includes(entry.name.toLowerCase()) && !options.isBlocked?.(path.join(path.dirname(executable), entry.name)) &&
    isPeFile(path.join(path.dirname(executable), entry.name), true));
}
// Wizard paths are already validated absolute literals; '$' and '%' can be
// actual folder characters and must not be treated as launcher variables.
const declarationPath = (entry, key, options) => entry.kind === "port-config" ?
  entry.runtime[key] || "" : entry.kind === "config-launch" ? entry.runtime[key] || "" : expandPath(entry.runtime[key], entry.base, options);

function launchFor(game, options) {
  if (game.manifest || !game.native?.names) return null;
  const prior = (options.existingConfigs || []).find((cfg) => cfg.platform === "x360recomp" && cfg.appid === game.titleId &&
    state.samePath(cfg.x360_recomp_install_root, game.installRoot));
  const executable = prior?.executable || game.executable;
  if (!executable) return null;
  const requestedBase = prior?.working_directory || path.dirname(executable);
  const base = fs.existsSync(requestedBase) ? requestedBase : path.dirname(executable);
  const defaults = prior?.x360_recomp_generated_launch;
  const edited = prior && (String(prior.arguments || "") !== String(defaults?.arguments || "") ||
    defaults && !state.samePath(executable, defaults.executable) ||
    defaults && !state.samePath(requestedBase, defaults.workingDirectory) ||
    !defaults && prior.working_directory && !state.samePath(prior.working_directory, path.dirname(executable)) ||
    !state.samePath(executable, game.executable));
  if (edited) return { executable, arguments: prior.arguments || "", workingDirectory: requestedBase,
    runtime: argumentPaths(prior.arguments, base, options), source: "config-launch" };
  const scripts = (game.declarations || []).filter((entry) => entry.kind === "launcher" && state.samePath(entry.executable, executable));
  const unique = scripts.filter((entry, i) => scripts.findIndex((other) => JSON.stringify(other.runtime) === JSON.stringify(entry.runtime) &&
    state.samePath(other.base, entry.base)) === i);
  if (unique.length > 1) return { executable, arguments: prior?.arguments || "", workingDirectory: base, runtime: {}, ambiguous: true };
  const selected = unique[0], runtime = { ...(selected?.runtime || {}) };
  // Runtime TOML remains a metadata/path hint. Do not turn ignored settings
  // into new CLI overrides that could move an existing game's saves.
  // A wizard owns game/user paths. Do not copy conflicting script overrides.
  if (game.native.pathConfig) {
    for (const key of ["game_data_root", "user_data_root"]) delete runtime[key];
  } else if (game.adapter === "rexglue" && !runtime.game_data_root) {
    const xex = game.xexPath || prior?.x360_recomp_xex_path;
    if (xex && !options.isBlocked?.(xex)) runtime.game_data_root = path.dirname(xex);
  }
  return { executable, arguments: pathArguments(runtime), workingDirectory: selected?.base || base, runtime, source: "auto" };
}

function filesAt(root) { try { return fs.readdirSync(root, { withFileTypes: true }); } catch { return []; } }
function inside(root, file) {
  if (!root || !file) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isPeFile(file, dll = false) {
  let fd;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
    fd = fs.openSync(file, "r");
    const stat = fs.fstatSync(fd), dos = Buffer.alloc(64), pe = Buffer.alloc(24);
    if (!stat.isFile() || stat.size < 88 || fs.readSync(fd, dos, 0, 64, 0) !== 64 || dos.toString("ascii", 0, 2) !== "MZ") return false;
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > 8 * 1024 * 1024 || offset > stat.size - pe.length ||
        fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length || pe.readUInt32LE(0) !== 0x4550) return false;
    const flags = pe.readUInt16LE(22);
    return !!(flags & 2) && !!(flags & 0x2000) === dll;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function genericNativePort(root, entries, id, blocked, declarations = []) {
  if (!id) return null;
  const runtime = entries.find((entry) => entry.isFile() && !entry.isSymbolicLink() && RUNTIMES.includes(entry.name.toLowerCase()) &&
    !blocked(path.join(root, entry.name)) && isPeFile(path.join(root, entry.name), true));
  if (!runtime && !portableHint(root, entries, blocked)) return null;
  const executables = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.exe$/i.test(entry.name) &&
    !/^(?:launcher|setup|install|uninstall|unins\d*|crashpad_handler|crashreporter)\.exe$/i.test(entry.name) &&
    !blocked(path.join(root, entry.name)) && isPeFile(path.join(root, entry.name)));
  if (!executables.length) return null;
  const imported = runtime ? executables.filter(entry => readImports(path.join(root, entry.name)).includes(runtime.name.toLowerCase())) : [];
  const declared = executables.filter(entry => declarations.some(declaration => declaration.kind === "launcher" &&
    state.samePath(declaration.executable, path.join(root, entry.name))));
  const selected = declared.length === 1 ? declared : imported.length === 1 ? imported : executables.length === 1 ? executables : [];
  // The native executable/runtime plus the actual XEX establish an installation.
  // An app/save path cannot be deduced from an arbitrary executable filename.
  return { id, title: path.basename(root).replace(/_/g, " "), names: selected.map(entry => entry.name.toLowerCase()), generic: true,
    adapter: runtime ? "rexglue" : "native-port" };
}

function localProfile(installRoot, file, format, fallback = "default") {
  if (format === "tsv" || !inside(installRoot, file)) return fallback;
  const parts = path.relative(installRoot, file).split(path.sep);
  return parts[0]?.toLowerCase() === "profiles" && parts.length >= 3 && safeProfile(parts[1]) ? parts[1] : fallback;
}
function readXexTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) !== 24 || head.toString("ascii", 0, 4) !== "XEX2") return "";
    const size = head.readUInt32BE(8), count = head.readUInt32BE(20);
    if (size < 24 || size > 16 * 1024 * 1024 || count > 4096 || 24 + count * 8 > size) return "";
    const header = Buffer.alloc(size);
    if (fs.readSync(fd, header, 0, size, 0) !== size) return "";
    for (let i = 0; i < count; i++) {
      const at = 24 + i * 8;
      if (header.readUInt32BE(at) !== 0x00040006) continue;
      const info = header.readUInt32BE(at + 4);
      if (info + 16 > size) return "";
      return state.titleId(header.readUInt32BE(info + 12).toString(16).padStart(8, "0"));
    }
  } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  return "";
}

function statesAt(root, blocked, errors) {
  if (blocked(root)) return [];
  const found = [];
  for (const entry of filesAt(root)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name);
    if (blocked(file)) continue;
    if (/^[a-f0-9]{8}\.toml$/i.test(entry.name) && path.basename(root).toLowerCase() === "achievements") {
      const id = state.titleId(entry.name.slice(0, 8));
      if (!id) continue;
      const parsed = state.readSnapshot(file);
      if (parsed.valid) found.push({ id, format: "toml", file, userRoot: path.dirname(root), profile: "default" });
      else if (!parsed.missing) errors.push({ file, error: parsed.error });
    } else if (/^[a-f0-9]{16}\.tsv$/i.test(entry.name) && /^[a-f0-9]{8}$/i.test(path.basename(root)) &&
        path.basename(path.dirname(root)).toLowerCase() === "achievements") {
      try {
        const parsed = state.parseTsv(file, path.basename(root));
        found.push({ id: parsed.titleId, format: "tsv", file, userRoot: root, profile: parsed.profile });
      } catch (error) { errors.push({ file, error: error.message }); }
    } else if (entry.name.toUpperCase() === "ACH-DATA") {
      const parsed = state.readSnapshot(file, {}, { titleId: "53450812", descriptor: { format: "unleashed" } });
      if (parsed.valid) found.push({ id: "53450812", format: "unleashed", file, userRoot: root, profile: "default", title: "Sonic Unleashed" });
      else errors.push({ file, error: parsed.error });
    } else if (entry.name.toLowerCase() === "achievements.ini" && (path.basename(root).toLowerCase() === "profile" ||
        path.basename(path.dirname(root)).toLowerCase() === "profiles" && safeProfile(path.basename(root)))) {
      const parsed = state.readSnapshot(file, {}, { descriptor: { format: "ini-earned" } });
      if (parsed.valid) found.push({ id: "", format: "ini-earned", file, userRoot: root, profile: "default" });
    } else if (entry.name.toLowerCase() === "achievements.json" && (["savedata", "save", "profile"].includes(path.basename(root).toLowerCase()) ||
        path.basename(path.dirname(root)).toLowerCase() === "profiles" && safeProfile(path.basename(root)))) {
      try {
        const parsed = state.parseJsonState(file);
        const gearGame = path.dirname(root), installRoot = path.dirname(gearGame);
        // Hollow's supplied JSON has no TitleID: require the named Gears 2
        // installation AND GearGame structure, not the JSON filename alone.
        const hollow = path.basename(gearGame).toLowerCase() === "geargame" && /gears[ _-]*of[ _-]*war[ _-]*2/i.test(installRoot);
        found.push({ id: parsed.titleId || (hollow ? "4D53082D" : ""), format: "json", file, userRoot: root, profile: "default",
          installRoot: hollow ? installRoot : "", title: parsed.title || (hollow ? "Gears of War 2 (Hollow)" : "") });
      } catch (error) { errors.push({ file, error: error.message }); }
    }
  }
  return found;
}

function progressStatesAt(userRoot, ids, blocked, errors) {
  if (!userRoot || blocked(userRoot)) return [];
  const found = [];
  for (const directory of filesAt(userRoot)) {
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.name.toLowerCase() !== "achievements") continue;
    const root = path.join(userRoot, directory.name);
    if (blocked(root)) continue;
    found.push(...statesAt(root, blocked, errors).filter((item) => ids.has(item.id)));
    for (const child of filesAt(root)) if (child.isDirectory() && !child.isSymbolicLink() && ids.has(child.name.toUpperCase())) {
      found.push(...statesAt(path.join(root, child.name), blocked, errors));
    }
  }
  return found;
}

// LEGO rewrites runtime paths after a portable installation is moved, without
// requiring the user to edit its TOML. Mirror that rule only for this port.
function relocatedDeclarations(declarations, native, installRoot, blocked, options) {
  const gameFolder = path.join(installRoot, "game");
  if (native?.id !== "5752084B" || blocked(gameFolder) || !filesAt(installRoot).some((entry) => entry.name.toLowerCase() === "game" && entry.isDirectory() && !entry.isSymbolicLink())) return declarations;
  return declarations.map((entry) => {
    const oldGame = expandPath(entry.runtime.game_data_root, entry.base, options);
    if (!oldGame || blocked(oldGame) || fs.existsSync(oldGame)) return entry;
    const oldRoot = path.dirname(oldGame);
    if (oldRoot === path.dirname(oldRoot)) return entry;
    const runtime = { ...entry.runtime };
    for (const key of ["game_data_root", "user_data_root", "metadata_root"]) {
      const value = expandPath(runtime[key], entry.base, options);
      if (value && inside(oldRoot, value)) runtime[key] = path.join(installRoot, path.relative(oldRoot, value));
    }
    return { ...entry, runtime };
  });
}

// These Midnight Club builds can leave their executable under out/build while
// locating the disc data in an ancestor. Use the same bounded lookup, requiring
// the actual XEX TitleID, so that the build directory is not a second install.
function midnightInstallation(native, root, blocked) {
  if (native?.id !== "545407F8") return null;
  let candidateRoot = root;
  for (let level = 0; level < 5; level++) {
    if (blocked(candidateRoot)) break;
    const folders = native.app === "larecomp" ? ["MCLA_Game_Files", "game", "assets", ""] : ["game", "assets", ""];
    for (const folder of folders) {
      const xexPath = path.join(candidateRoot, folder, "default.xex");
      if (!blocked(xexPath) && readXexTitle(xexPath) === native.id) return { installRoot: candidateRoot, xexPath };
    }
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) break;
    candidateRoot = parent;
  }
  return null;
}

// A portable port can remember an imported disc folder outside its install.
// This is data-path resolution only; do not turn it into ReXGlue CLI flags.
function importedGameXex(native, root, blocked, errors) {
  if (!native?.gamePathFile) return "";
  const pointer = path.join(root, native.gamePathFile);
  if (blocked(pointer)) return "";
  let configured = "";
  try {
    if (fs.lstatSync(pointer).isSymbolicLink()) throw new Error("Linked game-data pointer");
    configured = state.readStateText(pointer).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].trim();
    if (configured.includes("\0")) throw new Error("Invalid game-data pointer");
  } catch (error) { if (error.code !== "ENOENT") errors.push({ file: pointer, error: error.message }); }
  const roots = configured ? [path.resolve(root, configured)] : [];
  const candidates = roots.flatMap((candidate) => path.basename(candidate).toLowerCase() === "default.xex" ? [candidate] :
    [path.join(candidate, "default.xex"), path.join(candidate, "disc1", "default.xex")]);
  candidates.push(...native.gameFolders.map((folder) => path.join(root, folder, "default.xex")), path.join(root, "default.xex"));
  return candidates.find((file) => !blocked(file) && readXexTitle(file)) || "";
}

function documentStates(documentsPath, ids, blocked, errors) {
  const found = [];
  if (!documentsPath || blocked(documentsPath) || !ids.size) return found;
  // Only direct children of Documents, known formats and requested TitleIDs.
  for (const entry of filesAt(documentsPath).slice(0, 1000)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    found.push(...progressStatesAt(path.join(documentsPath, entry.name), ids, blocked, errors));
  }
  return found;
}

// Registered save layouts take precedence over unrelated historical state.
// Fable always forces exe/saves; reNut's path wizard owns both selected roots.
// The verified SDK resolves these paths before loading TOML. Only an actual
// launcher override changes them; a path string in TOML is not sufficient.
function registeredPaths(game, options) {
  const port = game.native;
  if (port?.generic) return null;
  const executableRoot = game.launch?.executable ? path.dirname(game.launch.executable) : game.installRoot;
  if (!port?.saveLayout) {
    if (game.adapter === "rexglue" && !port?.format && !port?.progressUnavailable && game.launch?.runtime.user_data_root) {
      return { root: game.launch.runtime.user_data_root, source: "declared" };
    }
    if (port?.app && !port.format && !port.progressUnavailable && game.launch?.source === "config-launch" && options.documentsPath) {
      return { root: path.join(options.documentsPath, port.app), source: "declared" };
    }
    return null;
  }
  if (port.forceUserFolder) return { root: path.join(executableRoot, port.userFolder), source: "port-fixed" };
  if (game.launch?.ambiguous || game.launchInvalid) return { root: "", source: "pending", reason: "ambiguous-port-path" };
  const declarations = (game.declarations || []).filter((entry) => entry.runtime.user_data_root);
  const selected = port.pathConfig ? declarations.filter((entry) => entry.kind === "port-config") :
    game.launch ? (game.launch.runtime.user_data_root ? [{ runtime: game.launch.runtime, kind: "config-launch" }] : []) :
    declarations.filter((entry) => entry.kind === "launcher");
  const roots = selected.map((entry) => declarationPath(entry, "user_data_root", options)).filter(Boolean);
  const unique = roots.filter((value, i) => roots.findIndex((other) => state.samePath(value, other)) === i);
  if (unique.length > 1) return { root: "", source: "pending", reason: "ambiguous-port-path" };
  if (port.pathConfig) return unique.length === 1 ? { root: unique[0], source: "port-config" } :
    { root: "", source: "pending", reason: "port-path-not-configured" };
  const documentsRoot = options.documentsPath ? path.join(options.documentsPath, port.app) : "";
  if (unique.length === 1 && (port.cliAlwaysOverrides || !port.userFolder || !documentsRoot || !state.samePath(unique[0], documentsRoot))) {
    return { root: unique[0], source: "declared" };
  }
  return { root: port.userFolder ? path.join(executableRoot, port.userFolder) : documentsRoot, source: "registered-port" };
}

async function discoverGames(root, options = {}) {
  const blocked = options.isBlocked || (() => false), games = new Map(), unclaimedXex = new Map(), states = [], errors = [], ambiguousFiles = new Set();
  const fileKey = (file) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const queue = [{ root: path.resolve(root), depth: 0 }];
  const keyOf = (game) => `${process.platform === "win32" ? path.resolve(game.installRoot).toLowerCase() : path.resolve(game.installRoot)}\0${game.titleId}`;
  const add = (game) => {
    const key = keyOf(game), old = games.get(key);
    if (old) {
      if (game.xexPath) old.xexPath = game.xexPath;
      old.metadataPaths = [...new Set([...old.metadataPaths, ...game.metadataPaths])];
      old.pathConfigFiles = [...new Set([...(old.pathConfigFiles || []), ...(game.pathConfigFiles || [])])];
      old.declarations = [...(old.declarations || []), ...(game.declarations || [])]
        .filter((entry, i, all) => all.findIndex((other) => other.file === entry.file && JSON.stringify(other.runtime) === JSON.stringify(entry.runtime)) === i);
      old.native ||= game.native;
      old.installationConfirmed ||= game.installationConfirmed;
      old.executable ||= game.executable;
      if (game.sourceOnly === false) old.sourceOnly = false;
      return old;
    }
    games.set(key, game); return game;
  };
  let visited = 0;
  while (queue.length && visited++ < 3000) {
    if (visited % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    const current = queue.shift();
    if (blocked(current.root)) continue;
    const entries = filesAt(current.root), names = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));
    const manifestEntry = entries.find((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase() === MANIFEST_NAME);
    if (manifestEntry) {
      const file = path.join(current.root, manifestEntry.name);
      try {
        if (blocked(file)) continue;
        const manifest = readManifest(file, { ...options, isBlocked: blocked });
        if (manifest.xexPath && readXexTitle(manifest.xexPath) !== manifest.titleId) throw new Error("Manifest XEX TitleID mismatch or unreadable XEX");
        add({ appid: manifest.titleId, titleId: manifest.titleId, title: manifest.title, installRoot: current.root,
          adapter: manifest.adapter, manifest, xexPath: manifest.xexPath, metadataPaths: [file, ...manifest.metadata],
          declarations: [{ file, kind: "manifest", runtime: {}, base: current.root }], sourceOnly: false });
      } catch (error) { errors.push({ file, error: error.message }); }
      // An explicit declaration owns this installation. Never create guessed
      // secondary configs from its child save/game-data directories.
      continue;
    }
    states.push(...statesAt(current.root, blocked, errors));
    let installRoot = current.root;
    if (["assets", "game", "content", "base", "metadata", "game-info"].includes(path.basename(current.root).toLowerCase()) ||
        path.basename(current.root).toLowerCase() === "patched" && filesAt(path.dirname(current.root)).some((entry) => entry.isFile() && entry.name.toLowerCase() === "unleashedrecomp.exe")) installRoot = path.dirname(current.root);
    let installEntries = state.samePath(installRoot, current.root) ? entries : filesAt(installRoot);
    const nativeMatches = PORTS.filter((port) => port.names.some((name) => installEntries.some((e) => e.isFile() && !e.isSymbolicLink() && e.name.toLowerCase() === name &&
      (!(port.saveLayout || port.progressFile) || !blocked(path.join(installRoot, e.name)) && isPeFile(path.join(installRoot, e.name))))));
    let native = nativeMatches.length === 1 ? nativeMatches[0] : null;
    if (native?.adapter === "unleashed") {
      // The game's installer already creates a complete patched XEX. Read it
      // directly instead of treating the update's delta file as an executable.
      const patched = path.join(installRoot, "patched", "default.xex");
      if (!blocked(patched) && readXexTitle(patched) === native.id) {
        // Resolve through the same add() path below; child scans cannot replace
        // the chosen updated metadata with the older base executable.
        native = { ...native, preferredXex: patched };
      }
    }
    const midnight = midnightInstallation(native, installRoot, blocked);
    const executableRoot = installRoot, executableEntries = installEntries;
    if (midnight) { installRoot = midnight.installRoot; installEntries = filesAt(installRoot); }
    if (!native && /gears[ _-]*of[ _-]*war[ _-]*2/i.test(installRoot) &&
        installEntries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "geargame") &&
        ["Binaries/GearGame.exe", "Binaries/Win32/GearGame.exe", "GearGame/Binaries/GearGame.exe"].some((file) => fs.existsSync(path.join(installRoot, file)))) {
      native = { id: "4D53082D", title: "Gears of War 2 (Hollow)", format: "json", adapter: "hollow-json" };
    }
    const declarations = readDeclarations(installRoot, installEntries, options);
    if (!state.samePath(executableRoot, installRoot)) {
      const nearExecutable = readDeclarations(executableRoot, executableEntries, options);
      declarations.declarations.push(...nearExecutable.declarations); declarations.errors.push(...nearExecutable.errors);
    }
    errors.push(...declarations.errors);
    if (nativeMatches.length) declarations.declarations = declarations.declarations.filter((entry) => entry.kind !== "launcher" ||
      nativeMatches.some((port) => port.names.includes(path.basename(entry.executable || "").toLowerCase())) &&
      state.samePath(path.dirname(entry.executable), executableRoot));
    const pathConfigFiles = [];
    if (native?.gamePathFile) pathConfigFiles.push(path.join(installRoot, native.gamePathFile));
    if (native?.pathConfig) {
      const priorLaunch = (options.existingConfigs || []).find((cfg) => cfg.platform === "x360recomp" &&
        state.samePath(cfg.x360_recomp_install_root, installRoot) && acceptsTitle(native, cfg.appid) &&
        native.names.includes(path.basename(cfg.executable || "").toLowerCase()));
      const configRoot = priorLaunch?.executable ? path.dirname(priorLaunch.executable) : installRoot;
      const configEntries = state.samePath(configRoot, installRoot) ? installEntries : filesAt(configRoot);
      const entry = configEntries.find((item) => item.name.toLowerCase() === native.pathConfig);
      const file = path.join(configRoot, entry?.name || native.pathConfig);
      pathConfigFiles.push(file);
      try {
        const configured = readPortConfig(file, options);
        // The path wizard runs after runtime configuration and overrides it.
        declarations.declarations = [configured];
      } catch (error) {
        declarations.declarations = [];
        if (error.code !== "ENOENT") errors.push({ root: installRoot, file, error: error.message });
      }
    }
    const priorCandidates = (options.existingConfigs || []).filter((cfg) => cfg.platform === "x360recomp" &&
      state.samePath(cfg.x360_recomp_install_root, installRoot));
    if (priorCandidates.length === 1 && !native?.pathConfig) {
      const cfg = priorCandidates[0], defaults = cfg.x360_recomp_generated_launch;
      const requestedBase = cfg.working_directory || (cfg.executable ? path.dirname(cfg.executable) : installRoot);
      const base = fs.existsSync(requestedBase) ? requestedBase : cfg.executable ? path.dirname(cfg.executable) : installRoot;
      const edited = String(cfg.arguments || "") !== String(defaults?.arguments || "") ||
        defaults && (!state.samePath(cfg.executable, defaults.executable) || !state.samePath(requestedBase, defaults.workingDirectory)) ||
        !defaults && cfg.working_directory && !state.samePath(requestedBase, cfg.executable ? path.dirname(cfg.executable) : installRoot);
      if (edited) {
        try {
          const runtime = argumentPaths(cfg.arguments, base, options);
          declarations.declarations = [{ file: "", kind: "config-launch", runtime, base },
            ...declarations.declarations.filter((entry) => entry.kind !== "launcher")];
        } catch (error) { errors.push({ root: installRoot, error: error.message }); }
      }
    }
    declarations.declarations = relocatedDeclarations(declarations.declarations, native, installRoot, blocked, options);
    const explicitData = declarations.declarations.filter((entry) => ["port-config", "config-launch", "launcher"].includes(entry.kind) && entry.runtime.game_data_root);
    const explicitRoots = explicitData.map((entry) => declarationPath(entry, "game_data_root", options)).filter(Boolean)
      .filter((value, i, all) => all.findIndex((other) => state.samePath(value, other)) === i);
    if (explicitRoots.length > 1) errors.push({ root: installRoot, error: "Multiple explicit game-data locations; select launch arguments or a manifest" });
    let xexPath = explicitRoots.length === 1 ? path.join(explicitRoots[0], "default.xex") :
      !explicitRoots.length && names.has("default.xex") ? path.join(current.root, names.get("default.xex")) : "";
    if (xexPath && blocked(xexPath)) xexPath = "";
    let id = xexPath ? readXexTitle(xexPath) : "";
    // Unknown ports use the same bounded imported-data layouts. Runtime or
    // portable-launcher evidence is still required before accepting an XEX.
    if (!native && !nativeMatches.length && !explicitRoots.length && hasInstallationHint(installRoot, { isBlocked: blocked })) {
      const hasPointer = installEntries.some(entry => entry.isFile() && entry.name.toLowerCase() === "game-path.txt");
      const folders = ["game/disc1", "game", "disc1", "assets", "base", "content"];
      let candidate = "";
      if (hasPointer) candidate = importedGameXex({ gamePathFile: "game-path.txt", gameFolders: folders }, installRoot, blocked, errors);
      else if (!id) {
        const candidates = folders.map(folder => path.join(installRoot, folder, "default.xex")).filter(file => !blocked(file) && readXexTitle(file));
        if (new Set(candidates.map(readXexTitle)).size === 1) candidate = candidates[0];
        else if (candidates.length) errors.push({ root: installRoot, error: "Multiple generic game-data identities; explicit game location required" });
      }
      if (candidate) { xexPath = candidate; id = readXexTitle(candidate); }
      if (hasPointer) pathConfigFiles.push(path.join(installRoot, "game-path.txt"));
    }
    if (native?.gamePathFile && !explicitRoots.length) {
      const imported = importedGameXex(native, installRoot, blocked, errors);
      if (imported) { xexPath = imported; id = readXexTitle(imported); }
    }
    if (native?.preferredXex && !explicitRoots.length) { xexPath = native.preferredXex; id = native.id; }
    if (!id && !explicitRoots.length && names.has("achievements.toml")) {
      try {
        id = state.readMetadataFile(path.join(current.root, names.get("achievements.toml"))).titleId;
      } catch (error) { errors.push({ root: current.root, error: error.message }); }
    }
    for (const declaration of declarations.declarations) if (!id && !explicitRoots.length && declaration.runtime.game_data_root) {
      const gameRoot = declarationPath(declaration, "game_data_root", options);
      const candidate = gameRoot && path.join(gameRoot, "default.xex");
      if (!candidate || blocked(candidate)) continue;
      const title = readXexTitle(candidate);
      if (title) { id = title; xexPath = candidate; }
    }
    // These shipped layouts keep the game data beside the native executable.
    // Resolve it before choosing a regional executable in a combined package.
    for (const folder of [...new Set(nativeMatches.flatMap((port) => port.gameFolders ||
        (port.saveLayout ? ["assets", "game", "content", "base"] : [])))]) if (!id && !explicitRoots.length) {
      const candidate = path.join(installRoot, folder, "default.xex");
      if (blocked(candidate)) continue;
      const title = readXexTitle(candidate);
      if (title && nativeMatches.some((port) => acceptsTitle(port, title))) { id = title; xexPath = candidate; }
    }
    if (native?.ids && !id) {
      const prior = (options.existingConfigs || []).find((cfg) => cfg.platform === "x360recomp" &&
        state.samePath(cfg.x360_recomp_install_root, installRoot) && acceptsTitle(native, cfg.appid));
      if (prior) { id = prior.appid; native = { ...native, id }; }
      else {
        errors.push({ root: installRoot, error: "Regional TitleID requires the installed game XEX or a manifest" });
        native = null;
      }
    }
    if (!xexPath && !explicitRoots.length && midnight && (!id || id === native.id)) { id ||= native.id; xexPath = midnight.xexPath; }
    if (nativeMatches.length > 1) {
      const compatible = nativeMatches.filter((port) => id && acceptsTitle(port, id));
      if (compatible.length === 1) native = compatible[0];
      else {
        const prior = (options.existingConfigs || []).find((cfg) => cfg.platform === "x360recomp" &&
          state.samePath(cfg.x360_recomp_install_root, installRoot) && (!id || cfg.appid === id));
        const selected = compatible.filter((port) => port.names.includes(path.basename(prior?.executable || "").toLowerCase()));
        if (selected.length === 1) native = selected[0];
        else errors.push({ root: installRoot, error: "Multiple native game executables; matching game data or a manifest required" });
      }
    }
    if (native && id && acceptsTitle(native, id) && native.id !== id) native = { ...native, id };
    if (!native && nativeMatches.length === 0 && xexPath && id) native = genericNativePort(installRoot, installEntries, id, blocked, declarations.declarations);
    if (native && id && native.id !== id) errors.push({ root: installRoot, error: "Native executable / XEX TitleID mismatch" });
    else {
      id = id || native?.id || "";
      const applicable = declarations.declarations.filter((entry) => {
        const dataRoot = declarationPath(entry, "game_data_root", options);
        const declaredId = dataRoot && !blocked(dataRoot) ? readXexTitle(path.join(dataRoot, "default.xex")) : "";
        return !declaredId || declaredId === id;
      });
      if ((nativeMatches.length <= 1 || native) && id) {
        const executableCandidates = native?.names ? executableEntries.filter((entry) =>
          entry.isFile() && !entry.isSymbolicLink() && native.names.includes(entry.name.toLowerCase()) &&
          !blocked(path.join(executableRoot, entry.name)) && isPeFile(path.join(executableRoot, entry.name)))
          .map((entry) => path.join(executableRoot, entry.name)) : native?.adapter === "hollow-json" ?
          ["Binaries/GearGame.exe", "Binaries/Win32/GearGame.exe", "GearGame/Binaries/GearGame.exe"]
            .map((file) => path.join(installRoot, file)).filter((file) => !blocked(file) && isPeFile(file)) : [];
        if (executableCandidates.length > 1) errors.push({ root: installRoot, error: "Multiple game executables; choose the executable manually" });
        const game = { appid: id, titleId: id, installRoot,
          executable: executableCandidates.length === 1 ? executableCandidates[0] : "",
          adapter: native?.adapter || "rexglue", native, installationConfirmed: !!native,
          declarations: applicable, pathConfigFiles, xexPath, metadataPaths: [],
          title: native?.title || path.basename(installRoot).replace(/_/g, " "), sourceOnly: false };
        if (native || applicable.some((entry) => entry.runtime.game_data_root || entry.runtime.user_data_root)) add(game);
        else if (xexPath) unclaimedXex.set(keyOf(game), game);
      }
    }
    if (current.depth < 6) for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || /^(node_modules|\.git|cache|shader_cache|img)$/i.test(entry.name)) continue;
      queue.push({ root: path.join(current.root, entry.name), depth: current.depth + 1 });
    }
  }
  // A generic runtime signature cannot associate one native executable with
  // several unrelated XEX titles. Require a manifest for that layout.
  const genericRoots = new Map();
  for (const game of games.values()) if (game.native?.generic) {
    const rootKey = fileKey(game.installRoot);
    if (!genericRoots.has(rootKey)) genericRoots.set(rootKey, new Set());
    genericRoots.get(rootKey).add(game.titleId);
  }
  for (const [key, game] of games) if (game.native?.generic && genericRoots.get(fileKey(game.installRoot)).size > 1) {
    games.delete(key);
    errors.push({ root: game.installRoot, error: "Multiple XEX titles for one native executable; manifest required" });
  }
  const known = (options.existingConfigs || []).filter((cfg) => cfg.platform === "x360recomp" && cfg.x360_recomp_install_root &&
    cfg.x360_recomp_source_only !== true && !(cfg.x360_recomp_source_only === undefined && cfg.x360_recomp_adapter !== "reblue" &&
      !cfg.x360_recomp_xex_path && Object.values(cfg.x360_recomp_profiles || {}).some((value) => state.samePath(value, cfg.x360_recomp_install_root))) &&
    !blocked(cfg.x360_recomp_install_root));
  const ids = new Set([...games.values()].map((game) => game.titleId));
  for (const cfg of known) if (inside(root, cfg.x360_recomp_install_root)) ids.add(cfg.appid);
  for (const game of games.values()) {
    try { game.launch = launchFor(game, options); }
    catch (error) { game.launchInvalid = true; errors.push({ root: game.installRoot, error: error.message }); }
    if (game.launch) {
      const effective = relocatedDeclarations([{ file: "", kind: "config-launch", runtime: game.launch.runtime, base: game.launch.workingDirectory }],
        game.native, game.installRoot, blocked, options)[0];
      game.launch.runtime = effective.runtime;
      game.declarations = (game.declarations || []).filter((entry) => entry.kind !== "launcher" && entry.kind !== "config-launch");
      game.declarations.unshift({ file: "", kind: "config-launch", runtime: game.launch.runtime, base: game.launch.workingDirectory });
    }
    if (game.launch?.ambiguous || game.launchInvalid) game.ambiguousSource = true;
    game.portPaths = registeredPaths(game, options);
    if (game.portPaths?.root) states.push(...progressStatesAt(game.portPaths.root, new Set([game.titleId]), blocked, errors));
    else if (game.portPaths) errors.push({ root: game.installRoot, error: game.portPaths.reason || "Port save location is unavailable" });
  }
  states.push(...documentStates(options.documentsPath, ids, blocked, errors));
  // Include declared external sources in the same association/ambiguity pass
  // as local state. This also lets save-only configs retain their identity.
  for (const game of games.values()) for (const entry of game.declarations || []) {
    const userRoot = declarationPath(entry, "user_data_root", options);
    if (userRoot) states.push(...progressStatesAt(userRoot, new Set([game.titleId]), blocked, errors));
  }
  for (const game of games.values()) if (game.adapter === "unleashed") {
    const portable = fs.existsSync(path.join(game.installRoot, "portable.txt"));
    const roaming = options.appDataPath || process.env.APPDATA;
    const userRoot = portable ? game.installRoot : roaming ? path.join(roaming, "UnleashedRecomp") : "";
    if (userRoot) states.push(...statesAt(path.join(userRoot, "save"), blocked, errors));
  }
  const dedup = new Map(states.map((item) => [fileKey(item.file), item]));
  // An unknown executable does not exclude a port with both a recognized
  // native save format and matching XEX identity. Plain Xenia XEX folders,
  // without such state or a runtime declaration, remain unclaimed.
  for (const item of dedup.values()) {
    if (item.format === "ini-earned") continue; // Its rows carry no game identity.
    const local = [...unclaimedXex.values()].filter((game) => (!item.id || game.titleId === item.id) && inside(game.installRoot, item.file));
    if (!local.length) continue;
    const nearest = local.filter((game) => !local.some((other) => !state.samePath(game.installRoot, other.installRoot) && inside(game.installRoot, other.installRoot)));
    if (nearest.length === 1) add(nearest[0]);
    else { ambiguousFiles.add(fileKey(item.file)); errors.push({ file: item.file, error: "Multiple local XEX identities for achievement state" }); }
  }
  for (const item of dedup.values()) {
    if (ambiguousFiles.has(fileKey(item.file))) continue;
    const localOwners = [...games.values()].filter(game => game.native?.generic && inside(game.installRoot, item.file));
    if (item.id && localOwners.length && !localOwners.some(game => game.titleId === item.id)) {
      errors.push({ file: item.file, error: "Local progress TitleID differs from its native installation" });
      continue;
    }
    let candidates = [...games.values()].filter((game) => item.id ? game.titleId === item.id :
      inside(game.installRoot, item.file) && (item.format !== "ini-earned" || game.native?.generic && game.installationConfirmed));
    if (!item.id && candidates.length > 1) candidates = candidates.filter(game =>
      !candidates.some(other => !state.samePath(game.installRoot, other.installRoot) && inside(game.installRoot, other.installRoot)));
    // A known port's current path rule is stronger than a stale save from
    // another build. Do not create a second, state-only config for that file.
    if (candidates.length && candidates.every((game) => game.portPaths &&
        (!game.portPaths.root || !state.samePath(game.portPaths.root, item.userRoot)))) continue;
    candidates = candidates.filter((game) => !game.portPaths || state.samePath(game.portPaths.root, item.userRoot));
    const saved = known.filter((cfg) => cfg.appid === item.id && !candidates.some((game) => state.samePath(game.installRoot, cfg.x360_recomp_install_root)));
    const strong = candidates.filter((game) => game.portPaths && state.samePath(game.portPaths.root, item.userRoot) || inside(game.installRoot, item.file) ||
      game.manifest && Object.values(game.manifest.progress).some((source) => state.samePath(source.file, item.file)) ||
      game.declarations?.some((entry) => state.samePath(declarationPath(entry, "user_data_root", options),
        item.format === "tsv" ? path.dirname(path.dirname(item.userRoot)) : item.userRoot)));
    if (strong.length === 1) candidates = strong;
    else if (!strong.length && candidates.length + saved.length === 1 && !candidates.length) {
      const cfg = saved[0];
      candidates = [add({ appid: cfg.appid, titleId: cfg.appid, installRoot: cfg.x360_recomp_install_root,
        adapter: cfg.x360_recomp_adapter || "rexglue", xexPath: cfg.x360_recomp_xex_path || "", metadataPaths: cfg.x360_recomp_metadata_paths || [],
        title: cfg.displayName || cfg.name, declarations: [], sourceOnly: false, prior: cfg })];
    } else if (strong.length > 1 || !strong.length && candidates.length + saved.length > 1) {
      for (const candidate of candidates) candidate.ambiguousSource = true;
      ambiguousFiles.add(fileKey(item.file));
      errors.push({ file: item.file, error: "Ambiguous installation for achievement state" }); continue;
    }
    let game = candidates.length === 1 ? candidates[0] : null;
    item.id ||= game?.titleId || "";
    if (!item.id) { if (item.format !== "ini-earned") errors.push({ file: item.file, error: "Achievement state has no established TitleID" }); continue; }
    if (!game) {
      const reblue = item.id === "4D5307DF" && path.basename(path.dirname(item.userRoot)).toLowerCase() === "profiles" &&
        fs.existsSync(path.join(item.userRoot, "reblue.toml"));
      game = add({ appid: item.id, titleId: item.id, installRoot: reblue ? path.dirname(path.dirname(item.userRoot)) : item.installRoot || item.userRoot,
        adapter: reblue ? "reblue" : "rexglue", title: reblue ? "Blue Dragon (re:Blue)" : item.title || path.basename(item.installRoot || item.userRoot).replace(/_/g, " "),
        xexPath: reblue ? path.join(path.dirname(path.dirname(item.userRoot)), "base", "default.xex") : "", metadataPaths: [], declarations: [], sourceOnly: !reblue });
    }
    if (game.native?.generic) item.profile = localProfile(game.installRoot, item.file, item.format, item.profile);
    (game.states ||= []).push(item);
  }
  for (const game of games.values()) {
    game.profiles = {}; game.progress = {}; game.searchRoots = []; game.stateAliases = [];
    if (game.manifest) {
      game.profiles = { ...game.manifest.profiles }; game.progress = { ...game.manifest.progress };
      game.stateAliases.push(...Object.values(game.profiles), ...(game.states || []).map((item) => item.userRoot));
      for (const entry of Object.values(game.progress)) {
        if (entry.format === "toml") game.stateAliases.push(path.dirname(path.dirname(entry.file)));
        if (entry.format === "tsv") game.stateAliases.push(path.dirname(entry.file));
      }
      game.searchRoots.push(...Object.values(game.profiles));
    } else if (game.adapter === "unleashed" && !game.sourceOnly) {
      const portable = fs.existsSync(path.join(game.installRoot, "portable.txt"));
      const roaming = options.appDataPath || process.env.APPDATA;
      const userRoot = portable ? game.installRoot : roaming ? path.join(roaming, "UnleashedRecomp") : "";
      const sources = [...new Map((game.states || []).filter((item) => item.format === "unleashed").map((item) => [fileKey(item.file), item])).values()];
      const defaultShared = !portable && [...games.values(), ...known.map((cfg) => ({ titleId: cfg.appid, installRoot: cfg.x360_recomp_install_root, sourceOnly: false }))]
        .some((other) => other.titleId === game.titleId && !other.sourceOnly && !state.samePath(other.installRoot, game.installRoot));
      if (!game.ambiguousSource && sources.length === 1) {
        game.profiles.default = sources[0].userRoot;
        game.progress.default = { format: "unleashed", file: sources[0].file, source: "existing-state" };
        game.stateAliases.push(sources[0].userRoot);
      } else if (!game.ambiguousSource && !sources.length && userRoot && !defaultShared) {
        game.profiles.default = path.join(userRoot, "save");
        game.progress.default = { format: "unleashed", file: path.join(userRoot, "save", "ACH-DATA"), source: portable ? "unleashed-portable" : "unleashed-appdata" };
      } else {
        game.profiles.default = game.installRoot; game.progress.default = { format: "pending", file: "", source: "pending" };
        errors.push({ root: game.installRoot, error: "Unleashed save path is unavailable or ambiguous; manifest required" });
      }
      game.searchRoots.push(...Object.values(game.profiles));
    } else if (game.adapter === "reblue") {
      const profileRoot = path.join(game.installRoot, "profiles");
      for (const entry of filesAt(profileRoot)) if (entry.isDirectory() && !entry.isSymbolicLink() && state.validProfile(entry.name)) game.profiles[entry.name] = path.join(profileRoot, entry.name);
      game.profiles.default ||= path.join(profileRoot, "default");
      for (const [profile, userRoot] of Object.entries(game.profiles)) game.progress[profile] = { format: "toml", file: path.join(userRoot, "achievements", `${game.titleId}.toml`), source: "reblue-profile" };
    } else if (game.native?.progressFile) {
      const file = path.join(game.installRoot, game.native.progressFile), userRoot = path.dirname(file);
      const descriptor = { format: game.native.format, file, source: "port-fixed" };
      const parsed = blocked(file) ? null : state.readSnapshot(file, {}, { titleId: game.titleId, descriptor });
      if (parsed && !parsed.valid && !parsed.missing) errors.push({ file, error: parsed.error });
      game.profiles.default = userRoot;
      game.progress.default = { ...descriptor, confirmed: parsed?.valid === true };
      game.searchRoots.push(userRoot);
      game.stateAliases.push(userRoot);
    } else if (game.portPaths) {
      const { root: userRoot, source, reason } = game.portPaths;
      if (userRoot && !game.ambiguousSource) {
        game.profiles.default = userRoot;
        game.progress.default = { format: "toml", file: path.join(userRoot, "achievements", `${game.titleId}.toml`), source };
        game.stateAliases.push(userRoot);
        game.searchRoots.push(path.join(userRoot, "achievements"));
      } else {
        game.profiles.default = game.installRoot;
        game.progress.default = { format: "pending", file: "", source: "pending", reason: reason || "ambiguous-port-path" };
      }
    } else {
      const ambiguousProfiles = new Set();
      for (const item of game.states || []) {
        if (ambiguousProfiles.has(item.profile)) continue;
        if (Object.hasOwn(game.progress, item.profile) && !state.samePath(game.progress[item.profile].file, item.file)) {
          errors.push({ file: item.file, error: "Multiple achievement files for the same profile; confirmed config path required" });
          delete game.profiles[item.profile]; delete game.progress[item.profile];
          ambiguousProfiles.add(item.profile); continue;
        }
        game.profiles[item.profile] = item.userRoot;
        game.progress[item.profile] = { format: item.format, file: item.file, source: "existing-state" };
        game.stateAliases.push(item.userRoot);
      }
      const roots = (game.declarations || []).filter((entry) => entry.runtime.user_data_root)
        .map((entry) => expandPath(entry.runtime.user_data_root, entry.base, options)).filter(Boolean);
      const uniqueRoots = roots.filter((value, i) => roots.findIndex((other) => state.samePath(value, other)) === i);
      if (uniqueRoots.length > 1) errors.push({ root: game.installRoot, error: "Multiple declared user-data locations; existing state required" });
      const declaredRoot = uniqueRoots.length === 1 ? uniqueRoots[0] : "";
      const config = (game.declarations || []).find((entry) => entry.kind === "config");
      const appName = game.native?.app || (config && path.basename(config.file).replace(/\.toml$/i, ""));
      const documentsRoot = appName && options.documentsPath ? path.join(options.documentsPath, appName) : "";
      const roaming = options.appDataPath || process.env.APPDATA;
      const roamingRoot = game.native?.roaming && appName && roaming ? path.join(roaming, appName) : "";
      const installations = [...games.values(), ...known.map((cfg) => ({ titleId: cfg.appid, installRoot: cfg.x360_recomp_install_root }))]
        .filter((entry) => entry.titleId === game.titleId && !entry.sourceOnly);
      const hasOtherInstallation = installations.some((entry) => !state.samePath(entry.installRoot, game.installRoot));
      const candidates = [declaredRoot, game.installRoot, path.join(game.installRoot, "user"), path.join(game.installRoot, "user-data"),
        path.join(game.installRoot, "content"), documentsRoot, roamingRoot].filter(Boolean);
      if (game.native?.generic) game.searchRoots.push(...candidates, path.join(game.installRoot, "profile"), path.join(game.installRoot, "profiles"));
      for (const candidate of candidates) {
        game.searchRoots.push(path.join(candidate, "achievements"));
        const local = progressStatesAt(candidate, new Set([game.titleId]), blocked, errors).filter((item) => !ambiguousFiles.has(fileKey(item.file)));
        for (const item of local) if (!ambiguousProfiles.has(item.profile) && !Object.hasOwn(game.progress, item.profile)) {
          game.profiles[item.profile] = item.userRoot; game.progress[item.profile] = { format: item.format, file: item.file, source: "existing-state" };
          game.stateAliases.push(item.userRoot);
        }
      }
      if (!Object.keys(game.profiles).length) {
        if (uniqueRoots.length > 1 || ambiguousProfiles.size || game.ambiguousSource || !declaredRoot && hasOtherInstallation && documentsRoot) {
          game.profiles.default = game.installRoot;
          game.progress.default = { format: "pending", file: "", source: "pending", reason: "ambiguous-progress-source" };
        } else if (game.native?.generic) {
          // A runtime's general user-data root does not declare an achievement
          // format. Discover the first actual supported state before binding.
          game.profiles.default = game.installRoot;
          game.progress.default = { format: "pending", file: "", source: "pending" };
        } else if (game.native?.format === "json") {
          game.profiles.default = path.join(game.installRoot, "GearGame", "SaveData");
          game.progress.default = { format: "json", file: path.join(game.profiles.default, "Achievements.json"), source: "registered-port" };
        } else if (game.native?.format === "tsv" && documentsRoot) {
          const directory = path.join(declaredRoot || documentsRoot, "Achievements", game.titleId);
          game.profiles.default = directory;
          game.progress.default = { format: "tsv-directory", file: "", directory, source: declaredRoot ? "declared" : "registered-port" };
        } else if (game.native?.progressUnavailable) {
          game.profiles.default = declaredRoot || roamingRoot || game.installRoot;
          game.progress.default = { format: "pending", file: "", source: "pending", reason: "port-does-not-persist" };
        } else if (declaredRoot || game.native && !game.native.generic && documentsRoot) {
          const userRoot = declaredRoot || documentsRoot;
          game.profiles.default = userRoot;
          game.progress.default = { format: "toml", file: path.join(userRoot, "achievements", `${game.titleId}.toml`), source: declaredRoot ? "declared" : "registered-port" };
        } else {
          game.profiles.default = game.installRoot;
          game.progress.default = { format: "pending", file: "", source: "pending" };
        }
      }
    }
    // Keep confirmed sources and profile identities through temporary missing
    // files. Observed state, explicit declarations and verified port path
    // rules may replace a previously inferred location.
    const prior = (options.existingConfigs || []).find((cfg) => cfg.platform === "x360recomp" && cfg.appid === game.titleId && state.samePath(cfg.x360_recomp_install_root, game.installRoot));
    if (prior) {
      const oldProfiles = prior.x360_recomp_profiles || {};
      if (Object.keys(oldProfiles).length && game.progress.default?.format === "pending" && !Object.hasOwn(oldProfiles, "default")) {
        delete game.profiles.default; delete game.progress.default;
      }
      for (const [profile, userRoot] of Object.entries(oldProfiles)) {
        if (!state.validProfile(profile) || typeof userRoot !== "string" || !userRoot) continue;
        const current = game.progress[profile];
        if (current?.source === "existing-state" || current?.source === "declared" || current?.source === "manifest" || game.manifest ||
            game.portPaths?.root && ["port-fixed", "port-config", "registered-port"].includes(current?.source)) continue;
        const old = prior.x360_recomp_progress?.[profile] || { format: "toml", file: state.progressPath(prior, profile), source: "existing-config" };
        if (old.format === "pending") continue;
        // A TSV directory is a discovery placeholder, not a player profile.
        // Once this installation has real TSV profiles, do not restore the
        // placeholder, even when its inferred directory was incorrect.
        if (old.format === "tsv-directory" && Object.values(game.progress).some((entry) => entry.format === "tsv" && entry.file)) continue;
        game.profiles[profile] = userRoot; game.progress[profile] = { ...old };
      }
      if (prior.x360_recomp_source_only === false) game.sourceOnly = false;
      if (!game.xexPath) game.xexPath = prior.x360_recomp_xex_path || "";
      game.metadataPaths.push(...(prior.x360_recomp_metadata_paths || []).filter((file) => typeof file === "string" && fs.existsSync(file)));
    }
    if (Object.values(game.progress).some((entry) => entry.format === "tsv" && entry.file)) {
      for (const profile of Object.keys(game.profiles)) {
        if (["pending", "tsv-directory"].includes(game.progress[profile]?.format)) {
          delete game.profiles[profile]; delete game.progress[profile];
        }
      }
    }
    for (const candidate of [path.join(game.installRoot, "achievements.toml"), path.join(game.installRoot, "metadata", "achievements.toml"),
      path.join(game.installRoot, "game-info", "achievements.toml")]) if (!blocked(candidate) && fs.existsSync(candidate)) game.metadataPaths.push(candidate);
    for (const entry of game.declarations || []) if (entry.runtime.metadata_root) {
      const metadataRoot = expandPath(entry.runtime.metadata_root, entry.base, options), candidate = metadataRoot && path.join(metadataRoot, "achievements.toml");
      if (candidate && !blocked(candidate) && fs.existsSync(candidate)) game.metadataPaths.push(candidate);
    }
    game.metadataPaths = [...new Set(game.metadataPaths)].filter((file) => !blocked(file));
    if (game.xexPath && blocked(game.xexPath)) game.xexPath = "";
    for (const profile of Object.keys(game.profiles)) {
      const descriptor = game.progress[profile];
      if (blocked(game.profiles[profile]) || descriptor.file && blocked(descriptor.file) || descriptor.directory && blocked(descriptor.directory)) { delete game.profiles[profile]; delete game.progress[profile]; }
    }
    game.searchRoots = [...new Set(game.searchRoots)].filter((candidate) => !blocked(candidate));
    game.progressPending = Object.values(game.progress).some((entry) => entry.format === "pending");
  }
  // Explicit declarations and registered port defaults must not start two
  // notification watchers for a shared file. Preserve existing installations
  // outside this scan, and leave conflicting newly discovered sources pending.
  const claims = new Map();
  for (const game of games.values()) for (const [profile, descriptor] of Object.entries(game.progress)) {
    if (!descriptor.file) continue;
    const key = fileKey(descriptor.file);
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push({ game, profile });
  }
  for (const [file, owners] of claims) {
    const currentRoots = new Set(owners.map(({ game }) => fileKey(game.installRoot)));
    const existingOwner = known.some((cfg) => !currentRoots.has(fileKey(cfg.x360_recomp_install_root)) &&
      Object.keys(cfg.x360_recomp_profiles || {}).some((profile) => fileKey(state.progressPath(cfg, profile) || cfg.x360_recomp_install_root) === file));
    if (currentRoots.size < 2 && !existingOwner) continue;
    for (const { game, profile } of owners) if (game.manifest || game.adapter === "unleashed" || game.portPaths || game.native?.progressFile) {
      game.progress[profile] = { format: "pending", file: "", source: "ambiguous-installation" };
      game.progressPending = true;
      errors.push({ root: game.installRoot, file, error: "Achievement file claimed by multiple installations; distinct sources required" });
    }
  }
  return { games: [...games.values()].filter((game) => Object.keys(game.profiles).length), errors, truncated: queue.length > 0 };
}

function isDiscoveryMarker(file) {
  const name = path.basename(file).toLowerCase();
  return /(?:default\.xex|\.toml|\.bat|\.cmd|\.ps1|\.spa|\.xdbf)$/.test(name) ||
    PORTS.some((port) => port.names.includes(name)) || name === MANIFEST_NAME || name === "ach-data" || name === "portable.txt" ||
    name === "achievements.json" || /^[a-f0-9]{16}\.tsv$/.test(name) || RUNTIMES.includes(name) || name === "renut.cfg" ||
    name === "game-path.txt" ||
    /\.exe$/i.test(name) && RUNTIMES.some((runtime) => fs.existsSync(path.join(path.dirname(file), runtime)));
}

module.exports = { discoverGames, readXexTitle, filesAt, inside, isDiscoveryMarker, hasInstallationHint, validateKnownInstallation, localProfile,
  readProgressCandidate: (file) => statesAt(path.dirname(file), () => false, []).find((item) => state.samePath(item.file, file)) || null };
