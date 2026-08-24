"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Worker } = require("node:worker_threads");

const { writeJsonAtomic } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");
const {
  extractSpaFile,
  getSpaTitleName,
  parseSpaFile,
} = require("./xlivelessness-spa");

const XLIVELESSNESS_PLATFORM = "xlivelessness";
const XLIVELESSNESS_PROVIDER = "xlivelessness";
const XLIVELESSNESS_RECORD_SIZE = 16;
const XLIVELESSNESS_MAX_STATE_BYTES = 1024 * 1024;
const FILETIME_UNIX_EPOCH_MS = 11644473600000n;
const DISCOVERY_MAX_DEPTH = 5;
const DISCOVERY_MAX_DIRECTORIES = 5000;
const DISCOVERY_CACHE_TTL_MS = 10000;
const discoveryCache = new Map();
const asyncDiscoveryCache = new Map();
const asyncDiscoveryInFlight = new Map();
const executableInspectionCache = new Map();
const executableInspectionInFlight = new Map();
let discoveryCacheCleanupTimer = null;
const EXECUTABLE_CACHE_TTL_MS = 2 * 60 * 1000;
const EXECUTABLE_CACHE_MAX_ENTRIES = 8;

function scheduleDiscoveryCacheCleanup() {
  if (discoveryCacheCleanupTimer) return;
  discoveryCacheCleanupTimer = setTimeout(() => {
    discoveryCacheCleanupTimer = null;
    const staleBefore = Date.now() - DISCOVERY_CACHE_TTL_MS;
    for (const [key, entry] of discoveryCache) {
      if (entry.createdAt <= staleBefore) discoveryCache.delete(key);
    }
    for (const [key, entry] of asyncDiscoveryCache) {
      if (entry.createdAt <= staleBefore) asyncDiscoveryCache.delete(key);
    }
    const staleExecutableBefore = Date.now() - EXECUTABLE_CACHE_TTL_MS;
    for (const [key, entry] of executableInspectionCache) {
      if (entry.createdAt <= staleExecutableBefore) {
        executableInspectionCache.delete(key);
      }
    }
    if (
      discoveryCache.size > 0 ||
      asyncDiscoveryCache.size > 0 ||
      executableInspectionCache.size > 0
    ) {
      scheduleDiscoveryCacheCleanup();
    }
  }, DISCOVERY_CACHE_TTL_MS + 100);
  discoveryCacheCleanupTimer.unref?.();
}
const DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "backup",
  "backups",
  "bak",
  "old",
  "temp",
  "tmp",
  "profile",
  "remote",
  "steam_settings",
  "stats",
]);

function shouldSkipDiscoveryDirectory(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return (
    DISCOVERY_EXCLUDED_DIRECTORIES.has(normalized) ||
    /^\d{4,}$/.test(normalized) ||
    /^[0-9a-f]{8,}$/i.test(normalized)
  );
}

function normalizePathForComparison(value) {
  if (!value) return "";
  try {
    const resolved = path.resolve(String(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return "";
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

async function isFileAsync(filePath) {
  try {
    return (await fs.promises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectoryAsync(directoryPath) {
  try {
    return (await fs.promises.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

function isPathInsideRoot(rootPath, targetPath) {
  const root = normalizePathForComparison(rootPath);
  const target = normalizePathForComparison(targetPath);
  if (!root || !target) return false;
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function readDirectoryIndex(directoryPath) {
  try {
    return new Map(
      fs.readdirSync(directoryPath, { withFileTypes: true }).map((entry) => [
        entry.name.toLowerCase(),
        entry,
      ]),
    );
  } catch {
    return new Map();
  }
}

async function readDirectoryIndexAsync(directoryPath) {
  try {
    return new Map(
      (await fs.promises.readdir(directoryPath, { withFileTypes: true })).map(
        (entry) => [entry.name.toLowerCase(), entry],
      ),
    );
  } catch {
    return new Map();
  }
}

function parseTitleConfigText(text) {
  const raw = String(text || "");
  const titleMatch = raw.match(/<titleid\b[^>]*>\s*([0-9a-f]{1,8})\s*<\/titleid>/i);
  if (!titleMatch) {
    return { valid: false, reason: "title-id-missing", titleId: "" };
  }
  const titleId = titleMatch[1].toUpperCase().padStart(8, "0");
  if (!/^[0-9A-F]{8}$/.test(titleId)) {
    return { valid: false, reason: "title-id-invalid", titleId: "" };
  }
  const versionMatch = raw.match(
    /<titleversion\b[^>]*>\s*([^<]+?)\s*<\/titleversion>/i,
  );
  return {
    valid: true,
    reason: "",
    titleId,
    titleVersion: versionMatch ? versionMatch[1].trim() : "",
  };
}

function decodeTitleConfigBuffer(buffer, filePath) {
  let text = "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString("utf16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    if (swapped.length % 2 !== 0) {
      throw new Error("Invalid UTF-16BE title config length");
    }
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else if (buffer.includes(0x00)) {
    text = buffer.toString("utf16le");
  } else {
    text = buffer.toString("utf8");
  }
  return {
    ...parseTitleConfigText(text.replace(/^\uFEFF/, "")),
    filePath,
  };
}

function titleConfigReadFailure(filePath, error) {
  return {
    valid: false,
    reason: "title-config-read-failed",
    titleId: "",
    filePath,
    error: error?.message || String(error),
  };
}

function readTitleConfig(filePath) {
  try {
    return decodeTitleConfigBuffer(fs.readFileSync(filePath), filePath);
  } catch (error) {
    return titleConfigReadFailure(filePath, error);
  }
}

async function readTitleConfigAsync(filePath) {
  try {
    return decodeTitleConfigBuffer(
      await fs.promises.readFile(filePath),
      filePath,
    );
  } catch (error) {
    return titleConfigReadFailure(filePath, error);
  }
}

function deserializeWorkerSpa(serializedSpa = {}) {
  return {
    titleId: serializedSpa.titleId,
    achievements: Array.isArray(serializedSpa.achievements)
      ? serializedSpa.achievements
      : [],
    stringsByLanguage: new Map(
      (Array.isArray(serializedSpa.stringsByLanguage)
        ? serializedSpa.stringsByLanguage
        : []
      ).map(([id, strings]) => [id, new Map(strings)]),
    ),
    images: new Map(
      (Array.isArray(serializedSpa.images) ? serializedSpa.images : []).map(
        ([id, image]) => [id, Buffer.from(image)],
      ),
    ),
    titleNames: new Map(
      Array.isArray(serializedSpa.titleNames) ? serializedSpa.titleNames : [],
    ),
  };
}

function serializeWorkerSpa(parsedSpa = {}, options = {}) {
  return {
    titleId: parsedSpa.titleId,
    achievements: Array.isArray(parsedSpa.achievements)
      ? parsedSpa.achievements
      : [],
    stringsByLanguage: Array.from(
      parsedSpa.stringsByLanguage instanceof Map
        ? parsedSpa.stringsByLanguage
        : [],
      ([id, strings]) => [id, Array.from(strings)],
    ),
    images:
      options.includeImages === true
        ? Array.from(
            parsedSpa.images instanceof Map ? parsedSpa.images : [],
            ([id, image]) => [id, image],
          )
        : [],
    titleNames: Array.from(
      parsedSpa.titleNames instanceof Map ? parsedSpa.titleNames : [],
    ),
  };
}

function runXLiveLessNessWorker(workerData) {
  return new Promise((resolve, reject) => {
    const bundledWorkerPath = path.join(
      __dirname,
      "xlivelessness-worker.js",
    );
    const unpackedWorkerPath = bundledWorkerPath.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    const workerPath = fs.existsSync(unpackedWorkerPath)
      ? unpackedWorkerPath
      : bundledWorkerPath;
    const worker = new Worker(workerPath, { workerData });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
      void worker.terminate().catch(() => {});
    };
    worker.once("message", (message) => {
      if (message?.ok) finish(resolve, message.result);
      else {
        const error = new Error(
          message?.error || "XLiveLessNess worker operation failed",
        );
        if (message?.code) error.code = message.code;
        finish(reject, error);
      }
    });
    worker.once("error", (error) => finish(reject, error));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(
          reject,
          new Error(`XLiveLessNess worker stopped with exit code ${code}`),
        );
      }
    });
  });
}

async function getExecutableInspectionSignature(executablePath, configPath) {
  const [executableStat, configStat] = await Promise.all([
    fs.promises.stat(executablePath),
    fs.promises.stat(configPath),
  ]);
  return [
    normalizePathForComparison(executablePath),
    executableStat.size,
    Math.trunc(executableStat.mtimeMs),
    normalizePathForComparison(configPath),
    configStat.size,
    Math.trunc(configStat.mtimeMs),
  ].join("::");
}

async function inspectExecutablePairAsync(
  directoryPath,
  cfgEntry,
  directoryIndex,
) {
  const cfgName = cfgEntry.name;
  const exeName = cfgName.slice(0, -4);
  const exeEntry = directoryIndex.get(exeName.toLowerCase());
  if (!exeEntry?.isFile() || !exeName.toLowerCase().endsWith(".exe")) {
    return {
      valid: false,
      reason: "matching-executable-missing",
    };
  }
  const configPath = path.join(directoryPath, cfgName);
  const executablePath = path.join(directoryPath, exeEntry.name);
  const titleConfig = await readTitleConfigAsync(configPath);
  if (!titleConfig.valid) return { valid: false, reason: titleConfig.reason };
  try {
    const signature = `${await getExecutableInspectionSignature(
      executablePath,
      configPath,
    )}::${titleConfig.titleId}::${titleConfig.titleVersion}`;
    const cached = executableInspectionCache.get(signature);
    if (
      cached &&
      Date.now() - cached.createdAt <= EXECUTABLE_CACHE_TTL_MS
    ) {
      return cached.result;
    }
    let pending = executableInspectionInFlight.get(signature);
    if (!pending) {
      pending = runXLiveLessNessWorker({
        operation: "inspect-executable",
        executablePath,
        titleId: titleConfig.titleId,
      })
        .then((workerResult) => {
          if (!workerResult?.valid) return workerResult;
          return {
            valid: true,
            reason: "",
            titleId: titleConfig.titleId,
            titleVersion: titleConfig.titleVersion,
            executablePath,
            processName: path.basename(executablePath),
            configPath,
            resourceFingerprint: workerResult.resourceFingerprint,
            spa: deserializeWorkerSpa(workerResult.spa),
          };
        })
        .finally(() => executableInspectionInFlight.delete(signature));
      executableInspectionInFlight.set(signature, pending);
    }
    const result = await pending;
    if (result?.valid) {
      executableInspectionCache.set(signature, {
        createdAt: Date.now(),
        result,
      });
      scheduleDiscoveryCacheCleanup();
      while (executableInspectionCache.size > EXECUTABLE_CACHE_MAX_ENTRIES) {
        executableInspectionCache.delete(
          executableInspectionCache.keys().next().value,
        );
      }
    }
    return result;
  } catch (error) {
    return {
      valid: false,
      reason: "spafile-invalid",
      error: error?.message || String(error),
    };
  }
}

function inspectExecutablePair(directoryPath, cfgEntry, directoryIndex) {
  const cfgName = cfgEntry.name;
  const exeName = cfgName.slice(0, -4);
  const exeEntry = directoryIndex.get(exeName.toLowerCase());
  if (!exeEntry?.isFile() || !exeName.toLowerCase().endsWith(".exe")) {
    return { valid: false, reason: "matching-executable-missing" };
  }
  const configPath = path.join(directoryPath, cfgName);
  const executablePath = path.join(directoryPath, exeEntry.name);
  const titleConfig = readTitleConfig(configPath);
  if (!titleConfig.valid) return { valid: false, reason: titleConfig.reason };
  try {
    const spaBuffer = extractSpaFile(executablePath);
    const spa = parseSpaFile(spaBuffer);
    const spaTitleId =
      Number.isInteger(spa.titleId) && spa.titleId >= 0
        ? spa.titleId.toString(16).toUpperCase().padStart(8, "0")
        : "";
    if (spaTitleId && spaTitleId !== titleConfig.titleId) {
      return {
        valid: false,
        reason: "title-id-mismatch",
        configTitleId: titleConfig.titleId,
        spaTitleId,
      };
    }
    return {
      valid: true,
      reason: "",
      titleId: titleConfig.titleId,
      titleVersion: titleConfig.titleVersion,
      executablePath,
      processName: path.basename(executablePath),
      configPath,
      spaBuffer,
      spa,
    };
  } catch (error) {
    return {
      valid: false,
      reason: "spafile-invalid",
      error: error?.message || String(error),
    };
  }
}

function resolveDetectedGameRoot(discoveryRoot, executablePath) {
  const root = path.resolve(String(discoveryRoot || ""));
  const executable = path.resolve(String(executablePath || ""));
  if (!isPathInsideRoot(root, executable)) return path.dirname(executable);
  const relative = path.relative(root, executable);
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const commonGameSubdirectories = new Set([
    "bin",
    "binaries",
    "engine",
    "game",
    "win32",
    "win64",
  ]);
  if (
    segments.length <= 1 ||
    commonGameSubdirectories.has(String(segments[0] || "").toLowerCase())
  ) {
    return root;
  }
  return path.join(root, segments[0]);
}

function detectXLiveLessNessRoot(rootPath, options = {}) {
  if (!rootPath) return { detected: false, partial: false, root: "", games: [] };
  let root = "";
  try {
    root = path.resolve(String(rootPath));
  } catch {
    return { detected: false, partial: false, root: "", games: [] };
  }
  if (!isDirectory(root)) {
    return { detected: false, partial: false, root, games: [] };
  }
  const maxDepth = Math.max(
    0,
    Math.min(8, Number(options.maxDepth ?? DISCOVERY_MAX_DEPTH)),
  );
  const maxDirectories = Math.max(
    1,
    Math.min(20000, Number(options.maxDirectories ?? DISCOVERY_MAX_DIRECTORIES)),
  );
  let rootMtimeMs = 0;
  try {
    rootMtimeMs = fs.statSync(root).mtimeMs;
  } catch {}
  const cacheKey = `${normalizePathForComparison(root)}::${maxDepth}::${maxDirectories}`;
  const cached = discoveryCache.get(cacheKey);
  if (
    options.forceRefresh !== true &&
    cached &&
    cached.rootMtimeMs === rootMtimeMs &&
    Date.now() - cached.createdAt <= DISCOVERY_CACHE_TTL_MS
  ) {
    return cached.result;
  }
  const queue = [{ directoryPath: root, depth: 0 }];
  let queueIndex = 0;
  const visited = new Set();
  const found = [];
  const rejected = [];
  let partial = false;

  while (queueIndex < queue.length && visited.size < maxDirectories) {
    const current = queue[queueIndex++];
    const key = normalizePathForComparison(current.directoryPath);
    if (!key || visited.has(key)) continue;
    visited.add(key);
    const index = readDirectoryIndex(current.directoryPath);
    const hasXlive = index.get("xlive.dll")?.isFile() === true;
    const cfgEntries = Array.from(index.values()).filter(
      (entry) => entry.isFile() && /\.exe\.cfg$/i.test(entry.name),
    );
    if (hasXlive || cfgEntries.length) partial = true;
    if (hasXlive && cfgEntries.length) {
      for (const cfgEntry of cfgEntries) {
        const inspected = inspectExecutablePair(current.directoryPath, cfgEntry, index);
        if (inspected.valid) found.push(inspected);
        else if (rejected.length < 50) {
          rejected.push({
            directoryPath: current.directoryPath,
            configPath: path.join(current.directoryPath, cfgEntry.name),
            reason: inspected.reason || "invalid",
            error: inspected.error || "",
          });
        }
      }
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of index.values()) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDiscoveryDirectory(entry.name)) continue;
      queue.push({
        directoryPath: path.join(current.directoryPath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  const gamesByTitleId = new Map();
  for (const match of found) {
    const gameRoot = resolveDetectedGameRoot(root, match.executablePath);
    const gameKey = `${match.titleId}::${normalizePathForComparison(gameRoot)}`;
    let game = gamesByTitleId.get(gameKey);
    if (!game) {
      game = {
        titleId: match.titleId,
        titleVersion: match.titleVersion,
        root: gameRoot,
        executableDirectory: path.dirname(match.executablePath),
        primaryExecutable: match.executablePath,
        titleConfigPath: match.configPath,
        spaBuffer: match.spaBuffer,
        spa: match.spa,
        executables: [],
      };
      gamesByTitleId.set(gameKey, game);
    }
    if (
      !game.executables.some(
        (entry) =>
          normalizePathForComparison(entry.path) ===
          normalizePathForComparison(match.executablePath),
      )
    ) {
      game.executables.push({
        path: match.executablePath,
        process_name: match.processName,
        title_config_path: match.configPath,
      });
    }
  }
  const games = Array.from(gamesByTitleId.values());
  const result = {
    detected: games.length > 0,
    partial: partial && games.length === 0,
    root,
    games,
    scannedDirectories: visited.size,
    limitReached: queueIndex < queue.length,
    rejected,
  };
  discoveryCache.set(cacheKey, {
    rootMtimeMs,
    createdAt: Date.now(),
    result,
  });
  scheduleDiscoveryCacheCleanup();
  if (discoveryCache.size > 32) {
    const oldestKey = discoveryCache.keys().next().value;
    if (oldestKey) discoveryCache.delete(oldestKey);
  }
  return result;
}

async function performXLiveLessNessRootDetection(rootPath, options = {}) {
  const startedAt = Date.now();
  if (!rootPath) return { detected: false, partial: false, root: "", games: [] };
  let root = "";
  try {
    root = path.resolve(String(rootPath));
  } catch {
    return { detected: false, partial: false, root: "", games: [] };
  }
  let rootStat = null;
  try {
    rootStat = await fs.promises.stat(root);
  } catch {}
  if (!rootStat?.isDirectory()) {
    return { detected: false, partial: false, root, games: [] };
  }
  const maxDepth = Math.max(
    0,
    Math.min(8, Number(options.maxDepth ?? DISCOVERY_MAX_DEPTH)),
  );
  const maxDirectories = Math.max(
    1,
    Math.min(20000, Number(options.maxDirectories ?? DISCOVERY_MAX_DIRECTORIES)),
  );
  const rootMtimeMs = rootStat.mtimeMs;
  const cacheKey = `${normalizePathForComparison(root)}::${maxDepth}::${maxDirectories}`;
  const cached = asyncDiscoveryCache.get(cacheKey);
  if (
    options.forceRefresh !== true &&
    cached &&
    cached.rootMtimeMs === rootMtimeMs &&
    Date.now() - cached.createdAt <= DISCOVERY_CACHE_TTL_MS
  ) {
    return cached.result;
  }

  const queue = [{ directoryPath: root, depth: 0 }];
  let queueIndex = 0;
  const visited = new Set();
  const found = [];
  const rejected = [];
  let partial = false;

  while (queueIndex < queue.length && visited.size < maxDirectories) {
    const current = queue[queueIndex++];
    const key = normalizePathForComparison(current.directoryPath);
    if (!key || visited.has(key)) continue;
    visited.add(key);
    const index = await readDirectoryIndexAsync(current.directoryPath);
    const hasXlive = index.get("xlive.dll")?.isFile() === true;
    const cfgEntries = Array.from(index.values()).filter(
      (entry) => entry.isFile() && /\.exe\.cfg$/i.test(entry.name),
    );
    if (hasXlive || cfgEntries.length) partial = true;
    if (hasXlive && cfgEntries.length) {
      for (const cfgEntry of cfgEntries) {
        const inspected = await inspectExecutablePairAsync(
          current.directoryPath,
          cfgEntry,
          index,
        );
        if (inspected.valid) found.push(inspected);
        else if (rejected.length < 50) {
          rejected.push({
            directoryPath: current.directoryPath,
            configPath: path.join(current.directoryPath, cfgEntry.name),
            reason: inspected.reason || "invalid",
            error: inspected.error || "",
          });
        }
      }
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of index.values()) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDiscoveryDirectory(entry.name)) continue;
      queue.push({
        directoryPath: path.join(current.directoryPath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  const gamesByTitleId = new Map();
  for (const match of found) {
    const gameRoot = resolveDetectedGameRoot(root, match.executablePath);
    const gameKey = `${match.titleId}::${normalizePathForComparison(gameRoot)}`;
    let game = gamesByTitleId.get(gameKey);
    if (!game) {
      game = {
        titleId: match.titleId,
        titleVersion: match.titleVersion,
        root: gameRoot,
        executableDirectory: path.dirname(match.executablePath),
        primaryExecutable: match.executablePath,
        titleConfigPath: match.configPath,
        resourceFingerprint: match.resourceFingerprint,
        spa: match.spa,
        executables: [],
      };
      gamesByTitleId.set(gameKey, game);
    }
    if (
      !game.executables.some(
        (entry) =>
          normalizePathForComparison(entry.path) ===
          normalizePathForComparison(match.executablePath),
      )
    ) {
      game.executables.push({
        path: match.executablePath,
        process_name: match.processName,
        title_config_path: match.configPath,
      });
    }
  }

  const games = Array.from(gamesByTitleId.values());
  const result = {
    detected: games.length > 0,
    partial: partial && games.length === 0,
    root,
    games,
    scannedDirectories: visited.size,
    limitReached: queueIndex < queue.length,
    rejected,
    scanDurationMs: Date.now() - startedAt,
  };
  asyncDiscoveryCache.set(cacheKey, {
    rootMtimeMs,
    createdAt: Date.now(),
    result,
  });
  scheduleDiscoveryCacheCleanup();
  if (asyncDiscoveryCache.size > 32) {
    asyncDiscoveryCache.delete(asyncDiscoveryCache.keys().next().value);
  }
  return result;
}

function detectXLiveLessNessRootAsync(rootPath, options = {}) {
  let normalizedRoot = "";
  try {
    normalizedRoot = normalizePathForComparison(rootPath);
  } catch {}
  const maxDepth = Math.max(
    0,
    Math.min(8, Number(options.maxDepth ?? DISCOVERY_MAX_DEPTH)),
  );
  const maxDirectories = Math.max(
    1,
    Math.min(20000, Number(options.maxDirectories ?? DISCOVERY_MAX_DIRECTORIES)),
  );
  const inFlightKey = `${normalizedRoot}::${maxDepth}::${maxDirectories}`;
  const existing = asyncDiscoveryInFlight.get(inFlightKey);
  if (existing) return existing;
  const pending = performXLiveLessNessRootDetection(rootPath, options).finally(
    () => asyncDiscoveryInFlight.delete(inFlightKey),
  );
  asyncDiscoveryInFlight.set(inFlightKey, pending);
  return pending;
}

function addUniquePath(target, value) {
  if (!value) return;
  let resolved = "";
  try {
    resolved = path.resolve(String(value));
  } catch {
    return;
  }
  const key = normalizePathForComparison(resolved);
  if (!key || target.some((entry) => entry.key === key)) return;
  target.push({ key, path: resolved });
}

function storageRootFromStatePath(value) {
  if (!value) return "";
  let current = path.resolve(String(value));
  if (path.basename(current).toLowerCase() === "achievements.dat") {
    current = path.dirname(current);
  }
  for (let index = 0; index < 8; index += 1) {
    if (path.basename(current).toLowerCase() === "xlivelessness") return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return "";
}

function getXLiveLessNessProfileFromStatePath(value) {
  if (!value) return "";
  let profileDir = path.resolve(String(value));
  if (path.basename(profileDir).toLowerCase() === "achievements.dat") {
    profileDir = path.dirname(profileDir);
  }
  const titleId = path.basename(path.dirname(profileDir));
  const titleDirectory = path.basename(path.dirname(path.dirname(profileDir)));
  if (
    titleDirectory.toLowerCase() !== "title" ||
    !/^[0-9a-f]{8}$/i.test(titleId)
  ) {
    return "";
  }
  return path.basename(profileDir);
}

function parseXLiveLessNessConfigArgument(commandLine) {
  const raw = Array.isArray(commandLine)
    ? commandLine.map((part) => String(part || "")).join(" ")
    : String(commandLine || "");
  if (!raw.trim()) return "";
  const patterns = [
    /(?:^|\s)"-xllnconfig=([^"]+)"/i,
    /(?:^|\s)'-xllnconfig=([^']+)'/i,
    /(?:^|\s)-xllnconfig(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = String(
      match?.[1] || match?.[2] || match?.[3] || "",
    ).trim();
    if (value) return value;
  }
  return "";
}

function resolveXLiveLessNessConfigArgument(commandLine, options = {}) {
  const configured = parseXLiveLessNessConfigArgument(commandLine);
  if (!configured) return "";
  if (path.isAbsolute(configured)) return path.normalize(configured);
  const workingDirectory = String(
    options.workingDirectory ||
      (options.executablePath ? path.dirname(String(options.executablePath)) : "") ||
      options.gamePath ||
      "",
  ).trim();
  return workingDirectory
    ? path.resolve(workingDirectory, configured)
    : path.resolve(configured);
}

function findXLiveLessNessStorageRoot(rootPath) {
  if (!rootPath) return "";
  let resolved = "";
  try {
    resolved = path.resolve(String(rootPath));
  } catch {
    return "";
  }
  const candidates = [];
  const add = (candidate) => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!candidates.some((entry) => normalizePathForComparison(entry) === normalizePathForComparison(normalized))) {
      candidates.push(normalized);
    }
  };
  add(resolved);
  add(path.join(resolved, "XLiveLessNess"));
  let current = resolved;
  for (let depth = 0; depth < 5; depth += 1) {
    add(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    const titleRoot = path.join(candidate, "profile", "title");
    if (
      isDirectory(titleRoot) ||
      (path.basename(candidate).toLowerCase() === "xlivelessness" &&
        normalizePathForComparison(candidate) ===
          normalizePathForComparison(resolved))
    ) {
      return candidate;
    }
  }
  return "";
}

function resolveXLiveLessNessStorageRoots(options = {}) {
  const candidates = [];
  const explicitConfigPath = String(options.explicitConfigPath || "").trim();
  if (explicitConfigPath) addUniquePath(candidates, path.dirname(explicitConfigPath));

  const manualRoot = storageRootFromStatePath(options.manualSavePath);
  if (manualRoot) addUniquePath(candidates, manualRoot);

  const gamePath = String(options.gamePath || "").trim();
  const executablePaths = Array.isArray(options.executablePaths)
    ? options.executablePaths
    : [options.executablePath];
  for (const executablePath of executablePaths.filter(Boolean)) {
    const executableDirectory = path.dirname(
      path.resolve(String(executablePath)),
    );
    addUniquePath(candidates, path.join(executableDirectory, "XLiveLessNess"));
  }
  if (gamePath) addUniquePath(candidates, path.join(gamePath, "XLiveLessNess"));
  if (options.localAppData) {
    addUniquePath(candidates, path.join(String(options.localAppData), "XLiveLessNess"));
  }
  return candidates.map((entry) => entry.path);
}

function getXLiveLessNessTitleRoots(configOrOptions = {}) {
  const titleId = String(
    configOrOptions.xlln_title_id ||
      configOrOptions.titleId ||
      configOrOptions.appid ||
      "",
  )
    .trim()
    .toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(titleId)) return [];
  const roots = Array.isArray(configOrOptions.xlln_storage_roots)
    ? configOrOptions.xlln_storage_roots
    : Array.isArray(configOrOptions.storageRoots)
      ? configOrOptions.storageRoots
      : [];
  const result = [];
  for (const root of roots) {
    addUniquePath(result, path.join(String(root), "profile", "title", titleId));
  }
  return result.map((entry) => entry.path);
}

function listXLiveLessNessStateFiles(titleRoot) {
  if (!isDirectory(titleRoot)) return [];
  const result = [];
  let entries = [];
  try {
    entries = fs.readdirSync(titleRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(titleRoot, entry.name, "achievements.dat");
    if (!isFile(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      result.push({
        filePath,
        profile: entry.name,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {}
  }
  return result.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
  );
}

function listAllXLiveLessNessStateFiles(configOrOptions = {}) {
  const byPath = new Map();
  for (const titleRoot of getXLiveLessNessTitleRoots(configOrOptions)) {
    for (const entry of listXLiveLessNessStateFiles(titleRoot)) {
      byPath.set(normalizePathForComparison(entry.filePath), {
        ...entry,
        titleRoot,
      });
    }
  }
  return Array.from(byPath.values()).sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath),
  );
}

function filetimeToUnixMs(low, high) {
  const ticks = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
  if (ticks === 0n) return 0;
  const milliseconds = ticks / 10000n - FILETIME_UNIX_EPOCH_MS;
  if (milliseconds <= 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
  return Number(milliseconds);
}

function parseAchievementsDatBuffer(buffer, previousSnapshot = {}) {
  const previous =
    previousSnapshot && typeof previousSnapshot === "object"
      ? previousSnapshot
      : {};
  if (!Buffer.isBuffer(buffer)) {
    return { valid: false, reason: "state-not-buffer", snapshot: previous };
  }
  if (buffer.length > XLIVELESSNESS_MAX_STATE_BYTES) {
    return { valid: false, reason: "state-too-large", snapshot: previous };
  }
  if (buffer.length === 0 && Object.keys(previous).length > 0) {
    return { valid: false, reason: "state-empty-after-unlocks", snapshot: previous };
  }
  if (buffer.length % XLIVELESSNESS_RECORD_SIZE !== 0) {
    return { valid: false, reason: "partial-record", snapshot: previous };
  }
  const recordsById = new Map();
  for (let offset = 0; offset < buffer.length; offset += XLIVELESSNESS_RECORD_SIZE) {
    const id = buffer.readUInt32LE(offset);
    const low = buffer.readUInt32LE(offset + 4);
    const high = buffer.readUInt32LE(offset + 8);
    const flags = buffer.readUInt32LE(offset + 12);
    const earnedTime = filetimeToUnixMs(low, high);
    const existing = recordsById.get(id);
    if (!existing || earnedTime >= existing.earned_time) {
      recordsById.set(id, {
        id,
        flags: existing ? existing.flags | flags : flags,
        earned_time: earnedTime || existing?.earned_time || 0,
      });
    }
  }
  // Unlock records are append-only for a profile. Preserve previously observed
  // entries so a stale mirror or an in-progress rewrite cannot look like a
  // relock and replay notifications when the fuller source returns.
  const snapshot = { ...previous };
  for (const record of recordsById.values()) {
    const key = String(record.id);
    snapshot[key] = {
      earned: true,
      earned_time:
        record.earned_time ||
        (previous[key]?.earned ? Number(previous[key].earned_time || 0) : 0),
      xlln_flags: record.flags,
    };
  }
  return {
    valid: true,
    reason: "",
    records: Array.from(recordsById.values()),
    snapshot,
  };
}

function readXLiveLessNessSnapshot(filePath, previousSnapshot = {}) {
  if (!filePath || !isFile(filePath)) {
    return {
      valid: false,
      reason: "state-file-missing",
      filePath: String(filePath || ""),
      snapshot: previousSnapshot || {},
    };
  }
  try {
    return {
      ...parseAchievementsDatBuffer(fs.readFileSync(filePath), previousSnapshot),
      filePath,
      profile: path.basename(path.dirname(filePath)),
    };
  } catch (error) {
    return {
      valid: false,
      reason: "state-file-read-failed",
      filePath,
      error: error?.message || String(error),
      snapshot: previousSnapshot || {},
    };
  }
}

function findXLiveLessNessConfig(configsDir, titleId) {
  if (!isDirectory(configsDir)) return null;
  const target = String(titleId || "").trim().toUpperCase();
  try {
    for (const entry of fs.readdirSync(configsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      const filePath = path.join(configsDir, entry.name);
      try {
        const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (
          isXLiveLessNessConfig(config) &&
          String(config.xlln_title_id || config.appid || "").toUpperCase() === target
        ) {
          return { filePath, config };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function findXLiveLessNessConfigAsync(configsDir, titleId) {
  if (!(await isDirectoryAsync(configsDir))) return null;
  const target = String(titleId || "").trim().toUpperCase();
  let entries = [];
  try {
    entries = await fs.promises.readdir(configsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const filePath = path.join(configsDir, entry.name);
    try {
      const config = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      if (
        isXLiveLessNessConfig(config) &&
        String(config.xlln_title_id || config.appid || "").toUpperCase() === target
      ) {
        return { filePath, config };
      }
    } catch {}
  }
  return null;
}

function chooseConfigPath(configsDir, displayName, titleId) {
  const base = sanitizeConfigName(`${displayName} (XLiveLessNess)`);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? base : `${base} ${suffix}`;
    const filePath = path.join(configsDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return { name, filePath };
  }
  const fallback = sanitizeConfigName(`XLiveLessNess ${titleId}`);
  return { name: fallback, filePath: path.join(configsDir, `${fallback}.json`) };
}

async function chooseConfigPathAsync(configsDir, displayName, titleId) {
  const base = sanitizeConfigName(`${displayName} (XLiveLessNess)`);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? base : `${base} ${suffix}`;
    const filePath = path.join(configsDir, `${name}.json`);
    if (!(await isFileAsync(filePath))) return { name, filePath };
  }
  const fallback = sanitizeConfigName(`XLiveLessNess ${titleId}`);
  return { name: fallback, filePath: path.join(configsDir, `${fallback}.json`) };
}

async function copySpaImagesAsync(parsedSpa, schemaDir, concurrency = 4) {
  const imagesDir = path.join(schemaDir, "img");
  await fs.promises.mkdir(imagesDir, { recursive: true });
  const jobs = [];
  for (const achievement of parsedSpa.achievements) {
    const image = parsedSpa.images.get(achievement.imageId);
    if (!image) continue;
    jobs.push({
      image,
      destination: path.join(imagesDir, `${achievement.id}.png`),
    });
  }
  let nextIndex = 0;
  const workerCount = Math.min(
    jobs.length,
    Math.max(1, Math.trunc(Number(concurrency) || 4)),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < jobs.length) {
        const job = jobs[nextIndex++];
        const temporary = `${job.destination}.${process.pid}.${Date.now()}.${crypto
          .randomBytes(4)
          .toString("hex")}.tmp`;
        try {
          await fs.promises.writeFile(temporary, job.image);
          await fs.promises.rename(temporary, job.destination);
        } finally {
          try {
            await fs.promises.unlink(temporary);
          } catch {}
        }
      }
    }),
  );
}

function mergeProcessNames(
  previousValue,
  detectedExecutables,
  previousDetectedExecutables = [],
) {
  const values = [];
  const currentDetectedNames = new Set(
    detectedExecutables.map((entry) =>
      String(entry?.process_name || "").trim().toLowerCase(),
    ),
  );
  const previousAutoNames = new Set(
    (Array.isArray(previousDetectedExecutables)
      ? previousDetectedExecutables
      : []
    ).map((entry) =>
      String(entry?.process_name || path.basename(entry?.path || ""))
        .trim()
        .toLowerCase(),
    ),
  );
  const add = (value) => {
    const text = String(value || "").trim();
    const normalized = text.toLowerCase();
    if (
      previousAutoNames.has(normalized) &&
      !currentDetectedNames.has(normalized)
    ) {
      return;
    }
    if (!text || values.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    values.push(text);
  };
  if (Array.isArray(previousValue)) previousValue.forEach(add);
  else if (typeof previousValue === "string") {
    previousValue.split(/[;,\r\n]+/).forEach(add);
  }
  detectedExecutables.forEach((entry) => add(entry.process_name));
  if (values.length <= 1) return values[0] || "";
  return values;
}

function isStoredDetectedExecutableValid(entry, titleId) {
  const executablePath = String(entry?.path || entry?.executable || "").trim();
  if (!isFile(executablePath)) return false;
  const executableDirectory = path.dirname(executablePath);
  if (!isFile(path.join(executableDirectory, "xlive.dll"))) return false;
  const configPath = String(
    entry?.title_config_path || `${executablePath}.cfg`,
  ).trim();
  if (!isFile(configPath)) return false;
  const parsed = readTitleConfig(configPath);
  return (
    parsed.valid &&
    (!titleId || parsed.titleId === String(titleId).trim().toUpperCase())
  );
}

function mergeDetectedExecutables(
  previousValue,
  detectedExecutables,
  titleId = "",
) {
  const result = [];
  const add = (entry) => {
    const executablePath = String(entry?.path || entry?.executable || "").trim();
    if (!executablePath) return;
    const key = normalizePathForComparison(executablePath);
    if (!key || result.some((current) => normalizePathForComparison(current.path) === key)) {
      return;
    }
    result.push({
      path: path.resolve(executablePath),
      process_name: String(entry?.process_name || path.basename(executablePath)).trim(),
      title_config_path: String(entry?.title_config_path || "").trim(),
      game_path: String(entry?.game_path || "").trim(),
    });
  };
  if (Array.isArray(previousValue)) {
    previousValue
      .filter((entry) => isStoredDetectedExecutableValid(entry, titleId))
      .forEach(add);
  }
  detectedExecutables.forEach(add);
  return result;
}

function findActiveState(previous, storageRoots, titleId) {
  const candidates = listAllXLiveLessNessStateFiles({
    xlln_title_id: titleId,
    xlln_storage_roots: storageRoots,
  });
  const previousPath = String(previous?.xlln_active_state_file || "").trim();
  const active =
    candidates.find(
      (entry) =>
        normalizePathForComparison(entry.filePath) ===
        normalizePathForComparison(previousPath),
    ) || candidates[0] || null;
  return { active, candidates };
}

async function ensureXLiveLessNessConfig(options = {}) {
  const game = options.game;
  if (!game?.titleId || !game?.spa || !Array.isArray(game?.executables)) {
    throw new Error("A validated XLiveLessNess game detection is required");
  }
  const configsDir = path.resolve(String(options.configsDir || ""));
  await fs.promises.mkdir(configsDir, { recursive: true });
  const existing = await findXLiveLessNessConfigAsync(configsDir, game.titleId);
  const gamePath = path.resolve(String(game.root || options.rootPath || ""));
  const displayBase = String(
    options.displayName || getSpaTitleName(game.spa, "english") || path.basename(gamePath) || "",
  ).trim();
  const displayName = displayBase || path.basename(game.primaryExecutable, ".exe");
  const destination = existing
    ? {
        name: path.basename(existing.filePath, ".json"),
        filePath: existing.filePath,
      }
    : await chooseConfigPathAsync(configsDir, displayName, game.titleId);
  const previous = existing?.config || {};
  const currentExecutables = game.executables.map((entry) => ({
    path: path.resolve(entry.path),
    process_name: path.basename(entry.path),
    title_config_path: entry.title_config_path,
    game_path: gamePath,
  }));
  const detectedExecutables = mergeDetectedExecutables(
    previous.xlln_detected_executables,
    currentExecutables,
    game.titleId,
  );
  const primaryExecutable =
    (await isFileAsync(previous.executable)) &&
    detectedExecutables.some(
      (entry) =>
        normalizePathForComparison(entry.path) ===
        normalizePathForComparison(previous.executable),
    )
      ? previous.executable
      : detectedExecutables[0]?.path || game.primaryExecutable;
  const gamePathEntries = [];
  for (const candidate of [
    ...(Array.isArray(previous.xlln_game_paths)
      ? previous.xlln_game_paths
      : []),
    previous.xlln_game_path,
    gamePath,
  ]) {
    const normalizedCandidate = normalizePathForComparison(candidate);
    const isCurrent = normalizedCandidate === normalizePathForComparison(gamePath);
    const hasDetectedExecutable = detectedExecutables.some(
      (entry) =>
        normalizePathForComparison(entry?.game_path) === normalizedCandidate ||
        isPathInsideRoot(candidate, entry?.path),
    );
    if (isCurrent || hasDetectedExecutable) {
      addUniquePath(gamePathEntries, candidate);
    }
  }
  const gamePaths = gamePathEntries.map((entry) => entry.path);
  const storageRootEntries = [];
  for (const candidateGamePath of gamePaths) {
    for (const root of resolveXLiveLessNessStorageRoots({
      gamePath: candidateGamePath,
      executablePaths: detectedExecutables
        .filter(
          (entry) =>
            !entry.game_path ||
            normalizePathForComparison(entry.game_path) ===
              normalizePathForComparison(candidateGamePath),
        )
        .map((entry) => entry.path),
      localAppData: options.localAppData || process.env.LOCALAPPDATA || "",
      explicitConfigPath: previous.xlln_config_path,
      manualSavePath: previous.save_path,
    })) {
      addUniquePath(storageRootEntries, root);
    }
  }
  for (const root of Array.isArray(previous.xlln_storage_roots)
    ? previous.xlln_storage_roots
    : []) {
    const normalizedRoot = normalizePathForComparison(root);
    const alreadyResolved = storageRootEntries.some(
      (entry) => entry.key === normalizedRoot,
    );
    const containsExistingState = listXLiveLessNessStateFiles(
      path.join(String(root), "profile", "title", game.titleId),
    ).length > 0;
    if (alreadyResolved || containsExistingState || isDirectory(root)) {
      addUniquePath(storageRootEntries, root);
    }
  }
  const storageRoots = storageRootEntries.map((entry) => entry.path);
  const { active, candidates } = findActiveState(previous, storageRoots, game.titleId);
  const schemaDir = path.join(
    configsDir,
    "schema",
    XLIVELESSNESS_PLATFORM,
    game.titleId,
  );
  const schemaPath = path.join(schemaDir, "achievements.json");
  const fingerprint =
    String(game.resourceFingerprint || "") ||
    crypto.createHash("sha256").update(game.spaBuffer).digest("hex");
  const requestedLanguages = Array.from(
    new Set(
      (Array.isArray(options.schemaLanguages) ? options.schemaLanguages : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
  const needsSchemaRefresh =
    previous.xlln_resource_fingerprint !== fingerprint ||
    JSON.stringify(previous.xlln_schema_languages_selection || []) !==
      JSON.stringify(requestedLanguages) ||
    !(await isFileAsync(schemaPath));
  let schemaLanguages = Array.isArray(previous.schema_languages)
    ? previous.schema_languages
    : [];
  if (needsSchemaRefresh) {
    const built = await runXLiveLessNessWorker({
      operation: "build-schema",
      spa: serializeWorkerSpa(game.spa),
      schemaLanguages: requestedLanguages,
    });
    await fs.promises.mkdir(schemaDir, { recursive: true });
    await copySpaImagesAsync(game.spa, schemaDir);
    await writeJsonAtomic(schemaPath, built.schema);
    schemaLanguages = built.languages;
  }
  const activeFile = active?.filePath || "";
  const config = {
    ...previous,
    name: destination.name,
    displayName: `${displayName} (XLiveLessNess)`,
    appid: game.titleId,
    platform: XLIVELESSNESS_PLATFORM,
    config_path: schemaDir,
    save_path: activeFile ? path.dirname(activeFile) : previous.save_path || "",
    executable: primaryExecutable,
    arguments: typeof previous.arguments === "string" ? previous.arguments : "",
    process_name: mergeProcessNames(
      previous.process_name,
      detectedExecutables,
      previous.xlln_detected_executables,
    ),
    game_path: gamePaths[0] || gamePath,
    xlln_title_id: game.titleId,
    xlln_game_path: gamePaths[0] || gamePath,
    xlln_game_paths: gamePaths,
    xlln_title_config_path:
      detectedExecutables.find(
        (entry) =>
          normalizePathForComparison(entry.path) ===
          normalizePathForComparison(primaryExecutable),
      )?.title_config_path || game.titleConfigPath,
    xlln_config_path: typeof previous.xlln_config_path === "string" ? previous.xlln_config_path : "",
    xlln_storage_roots: storageRoots,
    xlln_active_profile: active?.profile || previous.xlln_active_profile || "",
    xlln_active_state_file: activeFile || previous.xlln_active_state_file || "",
    xlln_detected_executables: detectedExecutables,
    xlln_resource_fingerprint: fingerprint,
    xlln_schema_languages_selection: requestedLanguages,
    schema_languages: schemaLanguages,
    achievement_source: {
      type: "local-emulator",
      provider: XLIVELESSNESS_PROVIDER,
      version: 1,
      game_path: gamePaths[0] || gamePath,
      game_paths: gamePaths,
      title_id: game.titleId,
      storage_roots: storageRoots,
    },
  };
  const configChanged =
    !existing || JSON.stringify(previous) !== JSON.stringify(config);
  if (configChanged) {
    await writeJsonAtomic(destination.filePath, config, { backup: true });
  }
  return {
    created: !existing,
    updated: !!existing && configChanged,
    unchanged: !!existing && !configChanged && !needsSchemaRefresh,
    schemaUpdated: needsSchemaRefresh,
    name: destination.name,
    configPath: destination.filePath,
    schemaDir,
    activeStateFile: activeFile,
    stateFiles: candidates,
    config,
  };
}

function isXLiveLessNessConfig(config) {
  const provider = String(
    config?.achievement_source?.provider || config?.achievement_provider || "",
  )
    .trim()
    .toLowerCase();
  return (
    String(config?.platform || "").trim().toLowerCase() ===
      XLIVELESSNESS_PLATFORM || provider === XLIVELESSNESS_PROVIDER
  );
}

function getXLiveLessNessGamePath(config) {
  if (!isXLiveLessNessConfig(config)) return "";
  return String(
    config?.xlln_game_path ||
      config?.game_path ||
      config?.achievement_source?.game_path ||
      "",
  ).trim();
}

function getXLiveLessNessGamePaths(config) {
  if (!isXLiveLessNessConfig(config)) return [];
  const entries = [];
  for (const candidate of [
    ...(Array.isArray(config?.xlln_game_paths) ? config.xlln_game_paths : []),
    config?.xlln_game_path,
    config?.game_path,
    ...(Array.isArray(config?.achievement_source?.game_paths)
      ? config.achievement_source.game_paths
      : []),
  ]) {
    addUniquePath(entries, candidate);
  }
  return entries.map((entry) => entry.path);
}

function isExpectedXLiveLessNessStateFile(config, filePath) {
  if (!isXLiveLessNessConfig(config) || !filePath) return false;
  if (path.basename(filePath).toLowerCase() !== "achievements.dat") return false;
  const parent = path.dirname(filePath);
  const titleRoot = path.dirname(parent);
  const titleId = String(config.xlln_title_id || config.appid || "").toUpperCase();
  if (path.basename(titleRoot).toUpperCase() !== titleId) return false;
  return getXLiveLessNessTitleRoots(config).some(
    (candidate) =>
      normalizePathForComparison(candidate) === normalizePathForComparison(titleRoot),
  );
}

module.exports = {
  XLIVELESSNESS_MAX_STATE_BYTES,
  XLIVELESSNESS_PLATFORM,
  XLIVELESSNESS_PROVIDER,
  XLIVELESSNESS_RECORD_SIZE,
  detectXLiveLessNessRoot,
  detectXLiveLessNessRootAsync,
  ensureXLiveLessNessConfig,
  filetimeToUnixMs,
  findXLiveLessNessConfig,
  getXLiveLessNessGamePath,
  getXLiveLessNessGamePaths,
  getXLiveLessNessProfileFromStatePath,
  getXLiveLessNessTitleRoots,
  isExpectedXLiveLessNessStateFile,
  isPathInsideRoot,
  isXLiveLessNessConfig,
  listAllXLiveLessNessStateFiles,
  listXLiveLessNessStateFiles,
  normalizePathForComparison,
  parseAchievementsDatBuffer,
  parseXLiveLessNessConfigArgument,
  parseTitleConfigText,
  readTitleConfig,
  readXLiveLessNessSnapshot,
  resolveXLiveLessNessStorageRoots,
  resolveXLiveLessNessConfigArgument,
  findXLiveLessNessStorageRoot,
  storageRootFromStatePath,
};
