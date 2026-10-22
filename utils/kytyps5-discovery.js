"use strict";

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { EventEmitter } = require("events");
const { readGameIdentity, parseProgressPath } = require("./kytyps5-trophy");
const { isArchivePath, listTrophyPackages } = require("./kytyps5-game-source");

const MAX_GAME_DISCOVERY_DEPTH = 8;
const rootEvidence = new Map();
const lastValidSettings = new Map();
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

function relativeInside(parent, candidate) {
  const relative = path.relative(pathKey(parent), pathKey(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)) ? relative : null;
}

function excludedSources(options = {}) {
  return [...new Map((options.getExcludedRoots?.() || options.excludedRoots || [])
    .filter((source) => typeof source === "string" && path.isAbsolute(source))
    .map((source) => [pathKey(source), source])).values()];
}

function isGameSourceActive(root, settings, candidate, options = {}) {
  return !excludedSources(options).some((source) => relativeInside(source, candidate) != null) &&
    [root, ...settings.gameRoots].some((source) => relativeInside(source, candidate) != null);
}

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
  // Per-game settings are indexed by their exact source path. They are not
  // launcher library roots and can outlive a moved or removed installation.
  const result = { filePath, gameRoots: [...new Map(gameRoots.map((source) => [pathKey(source), source])).values()], configuredGamePaths,
    gameSettings, userId: String(Number(configuredUser)), valid: true };
  lastValidSettings.set(pathKey(root), result);
  return result;
}

function resolveGameUserId(settings, gamePath) {
  return settings.gameSettings?.[pathKey(gamePath)]?.userId || settings.userId;
}

async function discoverGames(root, shouldSkip = () => false, options = {}) {
  const settings = readSettings(root);
  const excluded = excludedSources(options);
  // Process explicit launcher sources first. If both a directory and an
  // archive contain the same PPSA, choose one complete source, never merge them.
  const stack = [root, ...settings.gameRoots.slice().reverse()].map((dir) => ({ dir, depth: 0 }));
  const seen = new Set(), games = new Map(), errors = [];
  let visited = 0;
  while (stack.length && visited < 20000) {
    const { dir, depth } = stack.pop();
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key) || excluded.some((source) => relativeInside(source, dir) != null) || shouldSkip(dir)) continue;
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

function createDiscoveryWatcher(root, onScan, onError, shouldSkip = () => false, options = {}) {
  const settingsPaths = [path.join(root, "Kyty.ini"),
    path.join(process.env.ProgramData || "C:\\ProgramData", "Kyty", "Kyty.ini")];
  const trophies = path.join(root, "_Trophies"), saveData = path.join(root, "_SaveData");
  // Keep a stable handle for watched-folders while replacing the underlying
  // watcher. Unwatching an ancestor in place can also suppress retained children.
  const watcher = new EventEmitter();
  let active = null, closed = false, timer = null, refreshDiscovery = false, closing = null;
  let desired = null, operation = Promise.resolve(), signature = "";
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

  function makePolicy(games, settings) {
    const excluded = excludedSources(options);
    const roots = [...new Map([root, ...settings.gameRoots]
      .filter((source) => !excluded.some((other) => relativeInside(other, source) != null) && !shouldSkip(source))
      .map((source) => [pathKey(source), source])).values()];
    const activeGames = [...games.values()].filter((game) =>
      roots.some((source) => relativeInside(source, game.gamePath) != null) &&
      !excluded.some((other) => relativeInside(other, game.gamePath) != null));
    const gameDirectories = new Set(activeGames.filter((game) => {
      try { return fs.lstatSync(game.gamePath).isDirectory(); }
      catch { return !isArchivePath(game.gamePath); }
    }).map((game) => pathKey(game.gamePath)));
    const archives = new Set(activeGames.filter((game) => !gameDirectories.has(pathKey(game.gamePath)))
      .map((game) => pathKey(game.gamePath)));
    const checkedDirectories = new Map(), checkedMarkers = new Map();
    const remember = (cache, key, value) => {
      if (cache.size >= 20000 && !cache.has(key)) cache.delete(cache.keys().next().value);
      cache.set(key, value); return value;
    };
    const blockedDirectory = (directory) => {
      const key = pathKey(directory);
      return checkedDirectories.has(key) ? checkedDirectories.get(key)
        : remember(checkedDirectories, key, shouldSkip(directory));
    };
    const hasMetadataDirectory = (directory) => {
      const key = pathKey(directory);
      if (!checkedMarkers.has(key)) {
        let found = false;
        try { const stat = fs.lstatSync(path.join(directory, "sce_sys")); found = stat.isDirectory() && !stat.isSymbolicLink(); } catch {}
        remember(checkedMarkers, key, found);
      }
      if (checkedMarkers.get(key)) gameDirectories.add(key);
    };
    for (const source of roots) hasMetadataDirectory(source);
    const metadataMember = (relative) => /^(?:sce_sys|sce_sys\/param\.json|sce_sys\/trophy2|sce_sys\/trophy2\/trophy\d{2}\.ucp)$/i.test(relative.split(path.sep).join("/"));
    const runtimeMember = (candidate, stat) => {
      const relative = relativeInside(root, candidate);
      if (relative == null) return null;
      const parts = relative.split(path.sep);
      if (/^_savedata$/i.test(parts[0])) {
        return parts.length === 1 || parts.length === 2 && /^PPSA\d+$/i.test(parts[1]) && !stat?.isFile();
      }
      if (/^_trophies$/i.test(parts[0])) {
        return parts.length === 1 || parts.length === 2 && /^PPSA\d+$/i.test(parts[1]) && !stat?.isFile() ||
          parts.length === 3 && !!parseProgressPath(candidate) && !stat?.isDirectory();
      }
      return null;
    };
    const sourceCandidate = (candidate, stat) => {
      const key = pathKey(candidate);
      for (const source of roots) {
        const relative = relativeInside(source, candidate);
        if (relative == null) continue;
        if (!relative) return true;
        const parts = relative.split(path.sep);
        if (parts.some((part) => /^(?:[._]|node_modules$|dist$|data$)/i.test(part))) continue;
        // Only directory admission probes sce_sys, once per directory. Rejected
        // files never perform filesystem checks on all of their ancestors.
        for (let depth = 0; depth < parts.length; depth++) {
          if (gameDirectories.has(pathKey(path.join(source, ...parts.slice(0, depth))))) {
            return metadataMember(parts.slice(depth).join(path.sep));
          }
        }
        if (stat?.isFile()) return isArchivePath(candidate) && parts.length <= MAX_GAME_DISCOVERY_DEPTH;
        if (parts.length > MAX_GAME_DISCOVERY_DEPTH) continue;
        if (stat?.isDirectory()) {
          if (path.basename(candidate).toLowerCase() === "sce_sys") {
            gameDirectories.add(pathKey(path.dirname(candidate)));
          } else { hasMetadataDirectory(candidate); }
        }
        return true;
      }
      return false;
    };
    const ignored = (candidate, stat) => {
      if (closed || stat?.isSymbolicLink?.()) return true;
      // Cheap lexical ownership and file-type filters precede physical path
      // resolution. In particular another port's shader cache is pruned here.
      if (excluded.some((source) => relativeInside(source, candidate) != null)) return true;
      const settingsMember = settingsPaths.some((file) => relativeInside(candidate, file) != null);
      const runtime = runtimeMember(candidate, stat);
      let wanted = settingsMember || runtime === true || archives.has(pathKey(candidate));
      if (runtime === false) return true;
      if (!wanted) {
        // Chokidar also needs the ancestor corridor for a missing declared root.
        wanted = !stat?.isFile() && roots.some((source) => relativeInside(candidate, source) != null) ||
          sourceCandidate(candidate, stat);
      }
      if (!wanted) return true;
      if (!stat) return false; // Chokidar will call again with the actual type.
      if (stat.isDirectory()) return blockedDirectory(candidate);
      return blockedDirectory(path.dirname(candidate)) || shouldSkip(candidate);
    };
    const invalidate = (candidate, event) => {
      for (const directory of [candidate, path.dirname(candidate)]) {
        checkedDirectories.delete(pathKey(directory)); checkedMarkers.delete(pathKey(directory));
      }
      if (path.basename(candidate).toLowerCase() === "sce_sys") {
        const parent = pathKey(path.dirname(candidate));
        if (event === "unlinkDir") gameDirectories.delete(parent);
        else gameDirectories.add(parent);
      }
    };
    // Attach to an existing ancestor for a library that has not been created
    // yet. The predicate admits only its corridor, never sibling subtrees.
    let depth = MAX_GAME_DISCOVERY_DEPTH + 3;
    const anchors = [...new Map(roots.map((source) => {
      let anchor = source;
      while (!fs.existsSync(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
      depth = Math.max(depth, path.relative(anchor, source).split(path.sep).filter(Boolean).length + MAX_GAME_DISCOVERY_DEPTH + 3);
      return [pathKey(anchor), anchor];
    })).values()];
    const sources = [...anchors.filter((source, index) => !anchors.some((other, otherIndex) =>
      index !== otherIndex && relativeInside(other, source) != null)), ...settingsPaths];
    return { ignored, invalidate, sources, depth,
      signature: JSON.stringify([roots.map(pathKey).sort(), sources.map(pathKey).sort(), [...archives].sort(),
        activeGames.map((game) => pathKey(game.gamePath)).sort(), excluded.map(pathKey).sort(), options.getPolicyKey?.() || ""]) };
  }

  function schedule(candidate, event, policy) {
    if (closed) return;
    const settingsEvent = typeof candidate === "string" && settingsPaths.some((file) => pathKey(file) === pathKey(candidate));
    if (typeof candidate === "string") {
      if (event === "addDir" || event === "unlinkDir") policy.invalidate(candidate, event);
      if (!settingsEvent && policy.ignored(candidate)) return;
      const relative = relativeInside(root, candidate);
      const runtimeEvent = relative != null && /^(?:_SaveData|_Trophies)(?:$|[\\/])/i.test(relative);
      if (!runtimeEvent) refreshDiscovery = true;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const refresh = refreshDiscovery;
      refreshDiscovery = false;
      if (!closed) Promise.resolve(onScan({ refreshDiscovery: refresh })).catch(onError);
    }, 400);
  }

  function start(policy) {
    const inner = chokidar.watch(policy.sources, {
      ignoreInitial: true, depth: policy.depth,
      ignorePermissionErrors: true, followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 }, ignored: policy.ignored,
    });
    let finish;
    const ready = new Promise((resolve) => { finish = resolve; });
    const current = { inner, policy, ready, finish: (value) => finish(value) };
    active = current;
    for (const event of ["add", "change", "addDir", "unlink", "unlinkDir"]) {
      inner.on(event, (candidate) => {
        if (closed || active !== current) return;
        schedule(candidate, event, policy); watcher.emit(event, candidate);
      });
    }
    inner.on("error", (error) => {
      finish(false);
      if (closed || active !== current) return;
      resolveReady(false);
      onError(error);
    });
    inner.once("close", () => finish(false));
    inner.once("ready", () => {
      finish(true);
      if (closed || active !== current) return;
      resolveReady(true); watcher.emit("ready");
    });
    return current;
  }

  const initial = makePolicy(new Map(), readSettings(root));
  signature = initial.signature;
  start(initial);
  const updateGameSources = (games, settings = readSettings(root)) => {
    if (closed || !settings.valid) return operation;
    const next = makePolicy(games, settings);
    if (next.signature === (desired?.signature || signature)) return operation;
    desired = next;
    operation = operation.catch(onError).then(async () => {
      while (desired && !closed) {
        const policy = desired; desired = null;
        const previous = active; active = null;
        previous?.finish(false);
        await previous?.inner.close();
        if (closed) return;
        signature = policy.signature;
        const current = start(policy);
        const ready = await current.ready;
        // Reconcile once after attachment: files can appear during replacement.
        if (ready && !closed && active === current) {
          refreshDiscovery = true;
          schedule();
        }
      }
    });
    return operation;
  };
  watcher.getWatched = () => active?.inner.getWatched() || {};
  watcher.close = () => {
    if (closing) return closing;
    closed = true; clearTimeout(timer); resolveReady(false);
    const current = active; active = null; current?.finish(false);
    closing = (async () => {
      await current?.inner.close();
      await operation.catch(() => {});
      watcher.removeAllListeners();
    })();
    return closing;
  };
  return { watcher, readyPromise, trophies, saveData, updateGameSources };
}

module.exports = { isKytyRoot, emulatorRootForFolder, readSettings, discoverGames,
  resolveGameUserId, listTrophyTitles, listSaveDataTitles, listProgress, createDiscoveryWatcher, isGameSourceActive };
