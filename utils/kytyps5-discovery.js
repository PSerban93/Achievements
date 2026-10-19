"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { readGameIdentity, parseProgressPath } = require("./kytyps5-trophy");
const { isArchivePath, listTrophyPackages } = require("./kytyps5-game-source");

const MAX_GAME_DISCOVERY_DEPTH = 8;
const rootEvidence = new Map();
const lastValidSettings = new Map();
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

function validUserId(value) {
  return /^\d+$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0 && Number(value) <= 0x7fffffff && ![0xfe, 0xff].includes(Number(value));
}

function isKytyRoot(root) {
  if (typeof root !== "string" || !root.trim()) return false;
  root = emulatorRootForFolder(root);
  try {
    if (!fs.statSync(path.join(root, "kyty_emulator.exe")).isFile()) return false;
    // Check the actual runtime, not the release folder's name. U59 has no
    // _Trophies storage marker and is outside this integration's scope.
    const exe = path.join(root, "kyty_emulator.exe");
    const stat = fs.statSync(exe);
    const key = `${exe}:${stat.size}:${stat.mtimeMs}`;
    if (rootEvidence.has(key)) return rootEvidence.get(key);
    const fd = fs.openSync(exe, "r");
    let found = false, tail = Buffer.alloc(0);
    try {
      const block = Buffer.alloc(1024 * 1024);
      let bytes;
      while ((bytes = fs.readSync(fd, block, 0, block.length, null)) > 0) {
        const chunk = Buffer.concat([tail, block.subarray(0, bytes)]);
        if (chunk.includes(Buffer.from("_Trophies"))) { found = true; break; }
        tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - 32)));
      }
    } finally { fs.closeSync(fd); }
    rootEvidence.set(key, found);
    return found;
  } catch { return false; }
}

function emulatorRootForFolder(root) {
  return ["_trophies", "_savedata"].includes(path.basename(root).toLowerCase())
    ? path.dirname(root) : root;
}

function readSettings(root) {
  const local = path.join(root, "Kyty.ini");
  const shared = path.join(process.env.ProgramData || "C:\\ProgramData", "Kyty", "Kyty.ini");
  const filePath = fs.existsSync(local) ? local : shared;
  const values = {};
  let readError = null;
  try {
    let section = "";
    for (const line of fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
      const heading = /^\[([^\]]+)\]/.exec(line);
      if (heading) { section = heading[1]; continue; }
      const pair = /^([^=]+)=(.*)$/.exec(line);
      if (pair) values[`${section}/${pair[1].trim()}`] = pair[2].trim();
    }
  } catch (error) { readError = error; }
  const previous = lastValidSettings.get(pathKey(root));
  const configuredUser = values["GlobalConfiguration/user_id"];
  if (readError || !validUserId(configuredUser)) {
    return { ...(previous || { filePath, gameRoots: [], configuredGamePaths: [], gameSettings: {}, userId: null }),
      valid: false, pendingFilePath: filePath, error: readError?.message || "Incomplete Kyty settings" };
  }
  // QSettings uses a comma-separated QStringList, quoting paths containing commas.
  const paths = (values["Launcher/game_dirs"] || "").match(/"(?:\\.|[^"\\])*"|[^,]+/g) || [];
  const gameRoots = paths.map((value) => value.trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\"))
    .filter((value) => value && !value.startsWith("@"))
    .map((value) => path.resolve(root, value));
  const configuredGamePaths = [];
  const gameSettings = {};
  const size = Number(values["GameConfigurations/size"] || 0);
  let incomplete = !Number.isInteger(size) || size < 0 || size > 20000 ||
    (values["GameConfigurations/size"] != null && !/^\d+$/.test(values["GameConfigurations/size"])) ||
    (values["GameConfigurations/size"] == null &&
      (previous?.configuredGamePaths?.length > 0 ||
       Object.keys(values).some((key) => key.startsWith("GameConfigurations/"))));
  for (let index = 1; !incomplete && index <= size; index += 1) {
    const prefix = `GameConfigurations/${index}\\`;
    const value = values[`${prefix}game_path`] || values[`${prefix}basedir`];
    const user = values[`${prefix}user_id`];
    if (!value || value.startsWith("@") || !validUserId(user)) { incomplete = true; break; }
    const sourcePath = path.resolve(root, value.replace(/^"|"$/g, "").replace(/\\\\/g, "\\"));
    configuredGamePaths.push(sourcePath);
    // Kyty loads every persisted GameConfigurations entry into its custom
    // settings map; the runtime resolves it by game_path, not the global user.
    gameSettings[pathKey(sourcePath)] = { userId: String(Number(user)), sourcePath };
  }
  if (incomplete) return { ...(previous || { filePath, gameRoots: [], configuredGamePaths: [], gameSettings: {}, userId: null }),
    valid: false, pendingFilePath: filePath, error: "Incomplete Kyty game settings" };
  const result = { filePath, gameRoots: [...new Set([...gameRoots, ...configuredGamePaths])], configuredGamePaths,
    gameSettings, userId: String(Number(configuredUser)), valid: true };
  lastValidSettings.set(pathKey(root), result);
  return result;
}

function resolveGameUserId(settings, gamePath) {
  return settings.gameSettings?.[pathKey(gamePath)]?.userId || settings.userId;
}

async function discoverGames(root, shouldSkip = () => false) {
  const settings = readSettings(root);
  // Process explicit launcher sources first. If both a directory and an
  // archive contain the same PPSA, choose one complete source, never merge them.
  const stack = [root, ...settings.gameRoots.slice().reverse(),
    ...settings.configuredGamePaths.slice().reverse()].map((dir) => ({ dir, depth: 0 }));
  const seen = new Set(), games = new Map(), errors = [];
  let visited = 0;
  while (stack.length && visited < 20000) {
    const { dir, depth } = stack.pop();
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key) || shouldSkip(dir)) continue;
    seen.add(key); visited += 1;
    let candidate = false;
    try {
      const stat = await fs.promises.stat(dir);
      candidate = stat.isFile() && isArchivePath(dir);
      if (candidate || (stat.isDirectory() && fs.existsSync(path.join(dir, "sce_sys", "param.json")))) {
        candidate = true;
        const identity = readGameIdentity(dir);
        if (listTrophyPackages(dir).length) {
          // Prefer the first discovered copy; do not merge packages across game roots.
          if (!games.has(identity.titleId)) games.set(identity.titleId, identity);
        }
        continue; // Never recurse through all game assets.
      }
      if (!stat.isDirectory() || depth >= MAX_GAME_DISCOVERY_DEPTH) continue;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      // Reverse the stable order for the LIFO stack; discovery stays repeatable.
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries.reverse()) {
        if (entry.isSymbolicLink() ||
            (!entry.isDirectory() && !(entry.isFile() && isArchivePath(entry.name))) ||
            /^(?:[._]|node_modules$|dist$|sce_sys$|data$)/i.test(entry.name)) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    } catch (error) {
      if (candidate) errors.push({ gamePath: dir, error: error.message });
    }
  }
  return { ...settings, games, errors };
}

async function listRuntimeTitles(root, directory) {
  const base = path.join(root, directory);
  let titles = [];
  try { titles = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return []; }
  // Preserve the directory's spelling for case-sensitive hosts. Only immediate
  // PPSA directories identify games; do not inspect save contents or users.
  return titles.filter((title) => title.isDirectory() && /^PPSA\d+$/i.test(title.name))
    .map((title) => title.name);
}

function listTrophyTitles(root) {
  return listRuntimeTitles(root, "_Trophies");
}

function listSaveDataTitles(root) {
  return listRuntimeTitles(root, "_SaveData");
}

async function listProgress(root, trophyTitles) {
  const results = [];
  const base = path.join(root, "_Trophies");
  const titles = trophyTitles || await listTrophyTitles(root);
  for (const title of titles) {
    let files = [];
    try { files = await fs.promises.readdir(path.join(base, title)); } catch { continue; }
    for (const file of files) {
      const entry = parseProgressPath(path.join(base, title, file));
      if (entry) results.push(entry);
    }
  }
  return results;
}

function createDiscoveryWatcher(root, onScan, onError, shouldSkip = () => false) {
  const settingsPaths = [path.join(root, "Kyty.ini"),
    path.join(process.env.ProgramData || "C:\\ProgramData", "Kyty", "Kyty.ini")];
  const trophies = path.join(root, "_Trophies");
  const saveData = path.join(root, "_SaveData");
  const archivePaths = new Map();
  const archiveParents = new Set();
  const packageDirectories = new Map();
  const gameDirectories = new Set();
  const gameRoots = new Map([root, ...readSettings(root).gameRoots]
    .filter((source) => !shouldSkip(source)).map((source) => [pathKey(source), source]));
  let watchedSources = new Map(gameRoots);
  const relativeInside = (parent, candidate) => {
    const relative = path.relative(pathKey(parent), pathKey(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)) ? relative : null;
  };
  const isGameSourceCandidate = (candidate, stat) => {
    for (const sourceRoot of gameRoots.values()) {
      const relative = relativeInside(sourceRoot, candidate);
      if (relative == null) continue;
      if (!relative) return true;
      if (stat?.isSymbolicLink?.()) continue;
      const parts = relative.split(path.sep);
      if (parts.some((part) => /^(?:[._]|node_modules$|dist$|data$)/i.test(part))) continue;
      // Traverse launcher containers, but stop at a game's metadata directory.
      // Game assets/save data are not watched or read on every change.
      for (let depth = 0; depth < parts.length && depth <= MAX_GAME_DISCOVERY_DEPTH; depth++) {
        const gamePath = path.join(sourceRoot, ...parts.slice(0, depth));
        const gameKey = pathKey(gamePath);
        if (!gameDirectories.has(gameKey) && fs.existsSync(path.join(gamePath, "sce_sys"))) {
          gameDirectories.add(gameKey);
        }
        if (gameDirectories.has(gameKey)) {
          const member = parts.slice(depth).join("/");
          return /^(?:sce_sys|sce_sys\/param\.json|sce_sys\/trophy2|sce_sys\/trophy2\/trophy\d{2}\.ucp)$/i.test(member);
        }
      }
      if (stat?.isFile()) return isArchivePath(candidate) && parts.length <= MAX_GAME_DISCOVERY_DEPTH;
      if (parts.length <= MAX_GAME_DISCOVERY_DEPTH) return true;
    }
    return false;
  };
  // Watching the root detects first creation of _Trophies and _SaveData.
  const watcher = chokidar.watch([...gameRoots.values(), ...settingsPaths], {
    // A source at discovery depth 8 still needs sce_sys/trophy2/trophyXX.ucp.
    // ignored() prunes game assets and keeps runtime storage shallow.
    ignoreInitial: true, depth: MAX_GAME_DISCOVERY_DEPTH + 3, ignorePermissionErrors: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 },
    ignored: (candidate, stat) => {
      if (shouldSkip(candidate)) return true;
      if (archivePaths.has(pathKey(candidate)) || archiveParents.has(pathKey(candidate))) return false;
      for (const directory of packageDirectories.values()) {
        const relative = path.relative(directory, candidate);
        if (!relative || (!relative.includes(path.sep) && /^trophy\d{2}\.ucp$/i.test(relative))) return false;
      }
      if (path.relative(root, candidate) === "" || settingsPaths.some((filePath) => {
        const relative = path.relative(candidate, filePath);
        return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
      })) return false;
      const relative = path.relative(root, candidate);
      if (relative.toLowerCase() === "kyty.ini") return false;
      const parts = relative.split(path.sep);
      if (parts[0].toLowerCase() === "_savedata") {
        // Only the storage root and immediate title directories matter for
        // discovery. Frequent save writes and their nested directories do not.
        return parts.length > 2 || (parts.length === 2 &&
          (!/^PPSA\d+$/i.test(parts[1]) || stat?.isFile() === true));
      }
      if (relative === "_Trophies" || relative.startsWith(`_Trophies${path.sep}`)) {
        return parts.length > 3 || (stat?.isFile() === true && !parseProgressPath(candidate));
      }
      return !isGameSourceCandidate(candidate, stat);
    },
  });
  let timer = null, closed = false, refreshDiscovery = false;
  const schedule = (candidate) => {
    if (typeof candidate === "string") {
      const relative = path.relative(root, candidate);
      const runtimeEvent = /^(?:_SaveData|_Trophies)(?:$|[\\/])/i.test(relative);
      const settingsEvent = settingsPaths.some((file) => pathKey(file) === pathKey(candidate));
      const packageEvent = [...packageDirectories.values()].some((directory) => {
        const member = relativeInside(directory, candidate);
        return member != null && (!member || /^trophy\d{2}\.ucp$/i.test(member));
      });
      const sourceEvent = archivePaths.has(pathKey(candidate)) || packageEvent ||
        (!runtimeEvent && isGameSourceCandidate(candidate));
      if (!runtimeEvent && !settingsEvent && !sourceEvent) return;
      if (settingsEvent || sourceEvent) refreshDiscovery = true;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const refresh = refreshDiscovery;
      refreshDiscovery = false;
      if (!closed) Promise.resolve(onScan({ refreshDiscovery: refresh })).catch(onError);
    }, 400);
  };
  watcher.on("add", schedule).on("change", schedule).on("addDir", schedule)
    .on("unlink", schedule).on("unlinkDir", schedule).on("error", onError);
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
    watcher.once("ready", () => resolve(true));
    watcher.once("error", () => resolve(false));
    watcher.once("close", () => resolve(false));
  });
  const close = watcher.close.bind(watcher);
  watcher.close = async () => { closed = true; clearTimeout(timer); resolveReady(false); await close(); };
  const updateGameSources = (games, settings = readSettings(root)) => {
    if (closed) return;
    const next = new Map([...games.values()].filter((game) => isArchivePath(game.gamePath))
      .map((game) => [pathKey(game.gamePath), game.gamePath]));
    archivePaths.clear();
    archiveParents.clear();
    for (const [key, value] of next) {
      archivePaths.set(key, value);
      // Allow the immediate parent for Chokidar's file replacement handling;
      // its other files/subdirectories remain ignored.
      archiveParents.add(pathKey(path.dirname(value)));
    }
    const nextDirectories = new Map([...games.values()].filter((game) => !isArchivePath(game.gamePath))
      .map((game) => { const directory = path.join(game.gamePath, "sce_sys", "trophy2"); return [pathKey(directory), directory]; }));
    packageDirectories.clear();
    for (const [key, value] of nextDirectories) packageDirectories.set(key, value);
    gameDirectories.clear();
    for (const game of games.values()) {
      if (!isArchivePath(game.gamePath)) gameDirectories.add(pathKey(game.gamePath));
    }
    gameRoots.clear();
    for (const source of [root, ...settings.gameRoots]) {
      if (!shouldSkip(source)) gameRoots.set(pathKey(source), source);
    }
    const nextSources = new Map([...gameRoots, ...archivePaths, ...packageDirectories]);
    // Do not unwatch a known archive/package that is still covered by a launcher
    // root: it must remain observable when removed or replaced during a copy.
    const removedSources = [...watchedSources].filter(([key, source]) =>
      !nextSources.has(key) && ![...nextSources.values()].some((nextSource) =>
        relativeInside(nextSource, source) != null || relativeInside(source, nextSource) != null))
      .map(([, source]) => source);
    const addedSources = [...nextSources].filter(([key]) => !watchedSources.has(key))
      .map(([, source]) => source);
    watchedSources = nextSources;
    if (removedSources.length) watcher.unwatch(removedSources);
    if (addedSources.length) watcher.add(addedSources);
    // Detect switching between portable and shared settings without a restart.
    watcher.add(settingsPaths);
  };
  return { watcher, readyPromise, trophies, saveData, updateGameSources };
}

module.exports = { isKytyRoot, emulatorRootForFolder, readSettings, discoverGames,
  resolveGameUserId, listTrophyTitles, listSaveDataTitles, listProgress, createDiscoveryWatcher };
