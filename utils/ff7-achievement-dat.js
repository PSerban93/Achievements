"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");

const FF7_ACHIEVEMENT_APP_ID = "39140";
const FF7_ACHIEVEMENT_PLATFORM = "steam";
const FF7_ACHIEVEMENT_PROVIDER = "ff7-achievement-dat";
const FF7_ACHIEVEMENT_CONFIG_NAME = "FINAL FANTASY VII (achievement.dat)";
const FF7_STATE_FILE_NAME = "achievement.dat";
const FF7_REQUIRED_CONFIG_FILES = Object.freeze([
  "ff7input.cfg",
  "ff7sound.cfg",
  "ff7video.cfg",
]);
// The 2013 Steam release stores a fixed 8-byte, MSB-first bitfield. The
// stable Steam achievement IDs are intentionally kept outside schema order;
// localized schemas may be reordered without changing this mapping.
const FF7_BIT_MAP = Object.freeze(
  require("../assets/achievement-bit-maps/steam/39140.json"),
);

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

function readSteamAppId(filePath) {
  try {
    const value = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    return /^\d+$/.test(value) ? value : "";
  } catch {
    return "";
  }
}

function findFf7Executable(rootPath) {
  const preferred = ["ff7_en.exe", "ff7.exe"];
  let names = [];
  try {
    names = fs.readdirSync(rootPath);
  } catch {
    return "";
  }
  const byLowerName = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const candidate of preferred) {
    const actual = byLowerName.get(candidate);
    if (actual && isFile(path.join(rootPath, actual))) {
      return path.join(rootPath, actual);
    }
  }
  const fallback = names.find(
    (name) => /^ff7.*\.exe$/i.test(name) && isFile(path.join(rootPath, name)),
  );
  return fallback ? path.join(rootPath, fallback) : "";
}

function detectFf7AchievementDatRoot(rootPath) {
  if (!rootPath) return { detected: false, partial: false, root: "" };
  let root = "";
  try {
    root = path.resolve(String(rootPath));
  } catch {
    return { detected: false, partial: false, root: "" };
  }
  const appIdFile = path.join(root, "steam_appid.txt");
  const appid = readSteamAppId(appIdFile);
  const cfgFiles = FF7_REQUIRED_CONFIG_FILES.map((name) => path.join(root, name));
  const cfgSignals = cfgFiles.map(isFile);
  const signals = {
    steamAppIdFile: isFile(appIdFile),
    matchingAppId: appid === FF7_ACHIEVEMENT_APP_ID,
    requiredConfigFiles: cfgSignals.every(Boolean),
    achievementDat: isFile(path.join(root, FF7_STATE_FILE_NAME)),
  };
  const relevantSignalCount = [
    signals.steamAppIdFile,
    ...cfgSignals,
    signals.achievementDat,
  ].filter(Boolean).length;
  return {
    detected: signals.matchingAppId && signals.requiredConfigFiles,
    partial: relevantSignalCount > 0 && !(signals.matchingAppId && signals.requiredConfigFiles),
    root,
    appid,
    stateFile: path.join(root, FF7_STATE_FILE_NAME),
    executable: findFf7Executable(root),
    signals,
    cfgFiles,
  };
}

function isFf7AchievementDatConfig(config) {
  const provider = String(
    config?.achievement_source?.provider || config?.achievement_provider || "",
  )
    .trim()
    .toLowerCase();
  return (
    provider === FF7_ACHIEVEMENT_PROVIDER &&
    String(config?.appid || "").trim() === FF7_ACHIEVEMENT_APP_ID
  );
}

function getFf7AchievementGamePath(config) {
  return String(
    config?.ff7_game_path ||
      config?.achievement_source?.game_path ||
      config?.game_path ||
      "",
  ).trim();
}

function getFf7AchievementStateFile(config) {
  const configured = String(
    config?.ff7_achievement_file || config?.achievement_source?.state_file || "",
  ).trim();
  if (configured) return configured;
  const gamePath = getFf7AchievementGamePath(config) || String(config?.save_path || "");
  return gamePath ? path.join(gamePath, FF7_STATE_FILE_NAME) : "";
}

function buildEmptyFf7AchievementSnapshot() {
  const snapshot = {};
  for (const name of Object.values(FF7_BIT_MAP)) {
    snapshot[name] = { earned: false, earned_time: 0 };
  }
  return snapshot;
}

function buildFf7AchievementSnapshot(buffer, previousSnapshot = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 8) return null;
  const previous =
    previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : {};
  const snapshot = {};
  for (const [rawBit, name] of Object.entries(FF7_BIT_MAP)) {
    const bit = Number(rawBit);
    const earned = (buffer[Math.floor(bit / 8)] & (1 << (7 - (bit % 8)))) !== 0;
    const previousEntry = previous[name];
    snapshot[name] = {
      earned,
      earned_time:
        earned && previousEntry?.earned
          ? Number(previousEntry.earned_time || 0) || 0
          : 0,
    };
  }
  return snapshot;
}

function readFf7AchievementSnapshot(filePath, previousSnapshot = {}) {
  const target = String(filePath || "");
  if (!target || !isFile(target)) {
    return {
      valid: false,
      reason: "state-file-missing",
      filePath: target,
      snapshot: previousSnapshot || {},
    };
  }
  try {
    const buffer = fs.readFileSync(target);
    const snapshot = buildFf7AchievementSnapshot(buffer, previousSnapshot);
    if (!snapshot) {
      return {
        valid: false,
        reason: buffer.length < 8 ? "partial-state-file" : "invalid-state-size",
        size: buffer.length,
        filePath: target,
        snapshot: previousSnapshot || {},
      };
    }
    return { valid: true, reason: "", filePath: target, snapshot };
  } catch (error) {
    return {
      valid: false,
      reason: "state-file-read-failed",
      error: error?.message || String(error),
      filePath: target,
      snapshot: previousSnapshot || {},
    };
  }
}

function findFf7AchievementConfig(configsDir, rootPath) {
  const rootKey = normalizePathForComparison(rootPath);
  if (!rootKey) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(configsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    const filePath = path.join(configsDir, entry.name);
    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (
        isFf7AchievementDatConfig(config) &&
        normalizePathForComparison(getFf7AchievementGamePath(config)) === rootKey
      ) {
        return { filePath, config };
      }
    } catch {}
  }
  return null;
}

function chooseFf7ConfigPath(configsDir) {
  const base = sanitizeConfigName(FF7_ACHIEVEMENT_CONFIG_NAME);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? base : `${base} ${suffix}`;
    const filePath = path.join(configsDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return { name, filePath };
  }
  throw new Error("Could not allocate a FINAL FANTASY VII achievement.dat config filename.");
}

function schemaHasFf7Achievements(schemaPath) {
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    if (!Array.isArray(schema)) return false;
    const names = new Set(schema.map((entry) => String(entry?.name || "")));
    return Object.values(FF7_BIT_MAP).every((name) => names.has(name));
  } catch {
    return false;
  }
}

function collectSchemaLanguages(schemaPath) {
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const languages = new Set();
    for (const entry of Array.isArray(schema) ? schema : []) {
      for (const field of [entry?.displayName, entry?.description]) {
        if (!field || typeof field !== "object" || Array.isArray(field)) continue;
        for (const language of Object.keys(field)) languages.add(language);
      }
    }
    return Array.from(languages).sort();
  } catch {
    return [];
  }
}

async function ensureFf7Schema(options) {
  const { rootPath, configsDir, generateConfigForAppId, schemaLanguages } = options;
  const schemaDir = path.join(
    configsDir,
    "schema",
    FF7_ACHIEVEMENT_PLATFORM,
    FF7_ACHIEVEMENT_APP_ID,
  );
  const schemaPath = path.join(schemaDir, "achievements.json");
  if (schemaHasFf7Achievements(schemaPath)) return { schemaDir, generated: false };
  if (typeof generateConfigForAppId !== "function") {
    throw new Error("Steam schema generator is unavailable.");
  }

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ach-ff7-schema-"));
  const temporaryConfigs = path.join(temporaryRoot, "configs");
  await fsp.mkdir(temporaryConfigs, { recursive: true });
  try {
    const result = await generateConfigForAppId(
      FF7_ACHIEVEMENT_APP_ID,
      temporaryConfigs,
      {
        appDir: rootPath,
        forcePlatform: FF7_ACHIEVEMENT_PLATFORM,
        savePathOverride: rootPath,
        schemaLanguages,
      },
    );
    const sourceSchemaDir = String(result?.config_path || "").trim() ||
      path.join(
        temporaryConfigs,
        "schema",
        FF7_ACHIEVEMENT_PLATFORM,
        FF7_ACHIEVEMENT_APP_ID,
      );
    const sourceSchemaPath = path.join(sourceSchemaDir, "achievements.json");
    if (!schemaHasFf7Achievements(sourceSchemaPath)) {
      throw new Error("Generated Steam schema does not contain the FF7 achievement IDs.");
    }
    await fsp.mkdir(path.dirname(schemaDir), { recursive: true });
    await fsp.cp(sourceSchemaDir, schemaDir, { recursive: true, force: true });
    if (!schemaHasFf7Achievements(schemaPath)) {
      throw new Error("FF7 Steam schema could not be installed.");
    }
    return { schemaDir, generated: true };
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function ensureFf7AchievementDatConfig(options = {}) {
  const rootPath = path.resolve(String(options.rootPath || ""));
  const configsDir = path.resolve(String(options.configsDir || ""));
  const detection = detectFf7AchievementDatRoot(rootPath);
  if (!detection.detected) {
    throw new Error("FINAL FANTASY VII achievement.dat signature is incomplete.");
  }
  await fsp.mkdir(configsDir, { recursive: true });
  const schemaResult = await ensureFf7Schema({
    rootPath,
    configsDir,
    generateConfigForAppId: options.generateConfigForAppId,
    schemaLanguages: options.schemaLanguages,
  });
  const existing = findFf7AchievementConfig(configsDir, rootPath);
  const destination = existing
    ? { name: path.basename(existing.filePath, ".json"), filePath: existing.filePath }
    : chooseFf7ConfigPath(configsDir);
  const previous = existing?.config || {};
  const executable = detection.executable || String(previous?.executable || "");
  const config = {
    ...previous,
    name: destination.name,
    displayName: FF7_ACHIEVEMENT_CONFIG_NAME,
    appid: FF7_ACHIEVEMENT_APP_ID,
    platform: FF7_ACHIEVEMENT_PLATFORM,
    config_path: schemaResult.schemaDir,
    save_path: detection.root,
    executable,
    arguments: typeof previous?.arguments === "string" ? previous.arguments : "",
    process_name: executable ? path.basename(executable) : String(previous?.process_name || ""),
    game_path: detection.root,
    ff7_game_path: detection.root,
    ff7_achievement_file: detection.stateFile,
    schema_languages: collectSchemaLanguages(
      path.join(schemaResult.schemaDir, "achievements.json"),
    ),
    achievement_source: {
      type: "local-bitfield",
      provider: FF7_ACHIEVEMENT_PROVIDER,
      version: 1,
      game_path: detection.root,
      state_file: detection.stateFile,
      bit_order: "msb-first",
    },
  };
  const changed = !existing || JSON.stringify(previous) !== JSON.stringify(config);
  if (changed) writeJsonAtomicSync(destination.filePath, config, { backup: true });
  return {
    name: destination.name,
    filePath: destination.filePath,
    config,
    stateFile: detection.stateFile,
    stateFileExists: detection.signals.achievementDat,
    created: !existing,
    updated: !!existing && changed,
    schemaUpdated: schemaResult.generated,
    unchanged: !!existing && !changed && !schemaResult.generated,
  };
}

module.exports = {
  FF7_ACHIEVEMENT_APP_ID,
  FF7_ACHIEVEMENT_CONFIG_NAME,
  FF7_ACHIEVEMENT_PLATFORM,
  FF7_ACHIEVEMENT_PROVIDER,
  FF7_BIT_MAP,
  FF7_REQUIRED_CONFIG_FILES,
  FF7_STATE_FILE_NAME,
  buildEmptyFf7AchievementSnapshot,
  buildFf7AchievementSnapshot,
  detectFf7AchievementDatRoot,
  ensureFf7AchievementDatConfig,
  findFf7AchievementConfig,
  getFf7AchievementGamePath,
  getFf7AchievementStateFile,
  isFf7AchievementDatConfig,
  normalizePathForComparison,
  readFf7AchievementSnapshot,
};
