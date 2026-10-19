"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { createLogger } = require("./logger");
const trophy = require("./kytyps5-trophy");
const { launchTarget, listTrophyPackages, packageFingerprint } = require("./kytyps5-game-source");
const logger = createLogger("autoconfig");

function samePath(a, b) {
  const normalize = (value) => {
    const resolved = path.resolve(value || ".");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function safeName(value) {
  const result = String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "").slice(0, 160);
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(result) ? `_${result}` : result || "PS5 game";
}

function writeChangedJson(filePath, data) {
  try {
    if (JSON.stringify(JSON.parse(fs.readFileSync(filePath, "utf8"))) === JSON.stringify(data)) return false;
  } catch {}
  writeJsonAtomicSync(filePath, data, { backup: true });
  return true;
}

function findGameConfigs(configsDir, titleId, emulatorRoot) {
  if (!fs.existsSync(configsDir)) return [];
  const result = [];
  for (const file of fs.readdirSync(configsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(configsDir, file), "utf8"));
      if (data.platform === "kytyps5" &&
          String(data.kytyps5_title_id || data.appid?.split("-s")[0]) === titleId &&
          samePath(data.kytyps5_emulator_root, emulatorRoot)) {
        result.push({ data, filePath: path.join(configsDir, file), name: path.basename(file, ".json") });
      }
    } catch {}
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// Reuse the persisted package metadata across boots without detaching a valid
// progress watcher. Incomplete/older schemas still take the normal update path.
function canReuseGeneratedConfig(config, game, options = {}) {
  try {
    const { emulatorRoot, userId, packages, schemaRoot } = options;
    if (config.platform !== "kytyps5" || config.kytyps5_format_version !== 2 ||
        config.appid !== game.titleId || config.kytyps5_title_id !== game.titleId ||
        String(config.kytyps5_user_id) !== String(userId) ||
        !config.kytyps5_emulator_root || !config.game_path || !config.kytyps5_game_path || !config.config_path ||
        !samePath(config.kytyps5_emulator_root, emulatorRoot) ||
        !samePath(config.game_path, game.gamePath) || !samePath(config.kytyps5_game_path, game.gamePath) ||
        Object.hasOwn(config, "platinum") ||
        ["executable", "arguments", "process_name", "working_directory"].some((field) => config[field] == null)) return false;
    const schemaDir = path.join(schemaRoot, "kytyps5", game.titleId);
    if (!samePath(config.config_path, schemaDir)) return false;
    const entries = JSON.parse(fs.readFileSync(path.join(schemaDir, "achievements.json"), "utf8"));
    if (!Array.isArray(entries) || !entries.length || !Array.isArray(config.kytyps5_trophy_sets)) return false;
    const labels = new Set(), names = new Set();
    for (const entry of entries) {
      const label = entry.kytyps5_service_label, id = entry.kytyps5_trophy_id;
      if (!Number.isInteger(label) || label < 0 || label > 99 || !/^\d+$/.test(String(id)) ||
          String(Number(id)) !== String(id) || !Number.isSafeInteger(Number(id)) ||
          entry.name !== trophy.trophyKey(label, id) || names.has(entry.name) || !entry.kytyps5_english_variants) return false;
      const icon = `img/${label ? `s${label}/` : ""}trop${String(Number(id)).padStart(4, "0")}.png`;
      if (entry.icon !== icon || entry.icon_gray !== icon || !fs.existsSync(path.join(schemaDir, icon))) return false;
      names.add(entry.name); labels.add(label);
    }
    const sortedLabels = [...labels].sort((a, b) => a - b);
    if (JSON.stringify(config.kytyps5_service_labels) !== JSON.stringify(sortedLabels) ||
        config.kytyps5_service_label !== sortedLabels[0] ||
        config.native_platinum !== entries.some((entry) => entry.trophyType === "platinum")) return false;
    const progressPath = path.join(emulatorRoot, "_Trophies", game.titleId, `trophies_${userId}_${sortedLabels[0]}.json`);
    if (!config.save_path || !config.kytyps5_progress_path ||
        !samePath(config.save_path, progressPath) || !samePath(config.kytyps5_progress_path, progressPath)) return false;
    if (config.kytyps5_trophy_sets.length !== sortedLabels.length) return false;
    for (const label of sortedLabels) {
      const sets = config.kytyps5_trophy_sets.filter((set) => set.serviceLabel === label);
      if (sets.length !== 1 || sets[0].englishVariantsVersion !== trophy.ENGLISH_VARIANTS_VERSION ||
          sets[0].count !== entries.filter((entry) => entry.kytyps5_service_label === label).length) return false;
    }
    for (const file of packages) {
      const match = /^trophy(\d{2})\.ucp$/i.exec(file);
      if (!match) return false;
      const set = config.kytyps5_trophy_sets.find((item) => item.serviceLabel === Number(match[1]));
      if (!set || set.fingerprint !== packageFingerprint(game.gamePath, file)) return false;
    }
    return true;
  } catch { return false; }
}

function generateConfigFromKytyGame(gamePath, configsDir, options = {}) {
  const { emulatorRoot, userId } = options;
  if (!emulatorRoot || !/^\d+$/.test(String(userId ?? "")) ||
      !Number.isSafeInteger(Number(userId)) || Number(userId) > 0x7fffffff ||
      [0xfe, 0xff].includes(Number(userId))) throw new Error("Missing KytyPS5 runtime identity");
  const identity = trophy.readGameIdentity(gamePath);
  const appid = identity.titleId;
  const reportProgress = (phase, percent) => {
    try {
      options.onGenerationProgress?.({ appid, itemName: identity.title,
        phase, percent, detail: "" });
    } catch {} // Progress reporting must not interrupt schema/cache writes.
  };
  reportProgress("generatingSchema", 15);
  const configs = findGameConfigs(configsDir, appid, emulatorRoot);
  const existing = configs.find((entry) => options.isConfigActive?.(entry.name)) ||
    configs.find((entry) => entry.data.appid === appid && entry.data.kytyps5_format_version === 2) ||
    configs.find((entry) => entry.data.appid === appid) || configs[0];
  const baseName = safeName(`${identity.title} (PS5)`);
  let name = existing?.name || baseName;
  if (!existing && fs.existsSync(path.join(configsDir, `${name}.json`))) {
    const runtimeId = crypto.createHash("sha256").update(path.resolve(emulatorRoot).toLowerCase()).digest("hex").slice(0, 12);
    name = safeName(`${baseName} [${appid}-${runtimeId}]`);
    let suffix = 2;
    const candidate = name;
    while (fs.existsSync(path.join(configsDir, `${name}.json`))) name = `${candidate}-${suffix++}`;
  }
  const schemaDir = path.join(options.schemaRoot || path.join(configsDir, "schema"), "kytyps5", appid);
  const oldEntries = new Map(), oldSets = new Map();
  // Preserve previously imported sets even when a source is temporarily incomplete.
  const schemaSources = [{ data: { config_path: schemaDir, kytyps5_format_version: 2 } }, ...configs];
  for (const { data } of schemaSources) {
    try {
      const old = JSON.parse(fs.readFileSync(path.join(data.config_path, "achievements.json"), "utf8"));
      for (const item of old) {
        const label = Number(item.kytyps5_service_label ?? data.kytyps5_service_label ?? 0);
        const id = item.kytyps5_trophy_id ?? item.name;
        if (!/^\d+$/.test(String(id)) || !Number.isInteger(label) || label < 0 || label > 99) continue;
        const key = trophy.trophyKey(label, id);
        const icon = `img/${label ? `s${label}/` : ""}trop${String(Number(id)).padStart(4, "0")}.png`;
        if (!oldEntries.has(key)) oldEntries.set(key, { ...item, name: key,
          kytyps5_trophy_id: String(Number(id)), kytyps5_service_label: label, icon, icon_gray: icon });
        const previousIcon = typeof item.icon === "string" && /^img\/(?:s\d+\/)?trop\d+\.png$/.test(item.icon)
          ? path.join(data.config_path, item.icon) : "";
        const destination = path.join(schemaDir, icon);
        if (previousIcon && !fs.existsSync(destination) && fs.existsSync(previousIcon)) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(previousIcon, destination);
        }
      }
      for (const set of data.kytyps5_trophy_sets || []) oldSets.set(set.serviceLabel, set);
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot preserve Kyty schema: ${error.message}`);
    }
  }
  const packages = options.packages || listTrophyPackages(gamePath);
  const pending = [];
  let artworkChanged = false;
  const sortedPackages = packages.slice().sort();
  for (const [packageIndex, file] of sortedPackages.entries()) {
    reportProgress("generatingSchema", 20 + Math.round(55 * packageIndex / sortedPackages.length));
    const match = /^trophy(\d{2})\.ucp$/i.exec(file);
    if (!match) continue;
    const label = Number(match[1]);
    try {
      const fingerprint = packageFingerprint(gamePath, file);
      const savedSet = oldSets.get(label);
      const savedEntries = [...oldEntries.values()].filter((entry) => entry.kytyps5_service_label === label);
      const packageUnchanged = savedSet?.fingerprint === fingerprint &&
        savedEntries.length === savedSet.count &&
        savedEntries.every((entry) => fs.existsSync(path.join(schemaDir, entry.icon)));
      if (packageUnchanged && savedSet.englishVariantsVersion === trophy.ENGLISH_VARIANTS_VERSION &&
          savedEntries.every((entry) => entry.kytyps5_english_variants)) continue;
      const parsed = trophy.parseTrophyPackage(gamePath, label);
      if (!parsed.trophies.length) throw new Error("Empty PS5 trophy package");
      if (packageUnchanged) {
        // Upgrade matching metadata only; retain displayed text, grades and artwork.
        const variantsById = new Map(parsed.trophies.map((item) =>
          [item.kytyps5_trophy_id, item.kytyps5_english_variants]));
        if (savedEntries.some((entry) => !variantsById.has(entry.kytyps5_trophy_id))) {
          throw new Error("PS5 regional text does not match the existing trophy IDs");
        }
        for (const entry of savedEntries) {
          entry.kytyps5_english_variants = variantsById.get(entry.kytyps5_trophy_id);
        }
        oldSets.set(label, { ...savedSet, englishVariantsVersion: trophy.ENGLISH_VARIANTS_VERSION });
        continue;
      }
      const next = parsed.trophies.map(({ imageName, ...item }) => {
        const key = trophy.trophyKey(label, item.kytyps5_trophy_id);
        const previous = oldEntries.get(key);
        const icon = `img/${label ? `s${label}/` : ""}${imageName}`;
        return { ...item, name: key, icon, icon_gray: icon,
          ...(previous?.rarityPct != null ? { rarityPct: previous.rarityPct } : {}),
          ...(previous?.raritySource ? { raritySource: previous.raritySource } : {}) };
      });
      for (const item of parsed.trophies) {
        const bytes = parsed.files.get(item.imageName);
        if (!bytes) continue;
        const destination = path.join(schemaDir, "img", label ? `s${label}` : "", item.imageName);
        let unchanged = false;
        try { unchanged = fs.readFileSync(destination).equals(bytes); } catch {}
        if (!unchanged) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, bytes);
          artworkChanged = true;
        }
      }
      for (const [key, item] of oldEntries) if (item.kytyps5_service_label === label) oldEntries.delete(key);
      for (const item of next) oldEntries.set(item.name, item);
      oldSets.set(label, { ...parsed.set, fingerprint, count: next.length });
    } catch (error) {
      pending.push({ serviceLabel: label, error: error.message });
      logger.warn("kytyps5:package:pending", { appid, serviceLabel: label, error: error.message });
    }
  }
  if (!oldEntries.size) return { skipped: true, reason: "no-valid-trophies", pending };
  const schema = [...oldEntries.values()].sort((a, b) =>
    a.kytyps5_service_label - b.kytyps5_service_label || Number(a.kytyps5_trophy_id) - Number(b.kytyps5_trophy_id));
  const labels = [...new Set(schema.map((item) => item.kytyps5_service_label))].sort((a, b) => a - b);
  reportProgress("generatingSchema", 80);
  const schemaUpdated = writeChangedJson(path.join(schemaDir, "achievements.json"), schema) || artworkChanged;
  const migrationNeeded = configs.some((entry) => entry.data.kytyps5_format_version !== 2 || entry.name !== name);
  if (migrationNeeded) {
    if (typeof options.migrateCaches !== "function") throw new Error("Kyty cache migration callback is required");
    const backupDir = path.join(configsDir, ".kyty-migration");
    fs.mkdirSync(backupDir, { recursive: true });
    for (const entry of configs) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(entry.filePath)).digest("hex").slice(0, 12);
      const backupPath = path.join(backupDir, `${entry.name}.${hash}.json.bak`);
      if (!fs.existsSync(backupPath)) fs.copyFileSync(entry.filePath, backupPath);
    }
  }
  const serviceLabel = labels[0];
  const progressPath = path.join(emulatorRoot, "_Trophies", appid, `trophies_${userId}_${serviceLabel}.json`);
  const defaultArguments = (sourcePath) => `--game "${launchTarget(sourcePath)}" --user-id ${userId} --trophy-notifications true`;
  let launchArguments = existing?.data?.arguments;
  const previousSource = existing?.data?.kytyps5_game_path;
  // Update a generated launch command when the source moves from a directory
  // to an archive (or back), while retaining explicitly customised commands.
  if (previousSource) {
    const oldTarget = /\.zar$/i.test(previousSource) ? path.resolve(previousSource) :
      path.join(path.resolve(previousSource), "eboot.bin");
    const oldDefault = `--game "${oldTarget}" --user-id ${existing.data.kytyps5_user_id} --trophy-notifications true`;
    if (launchArguments === oldDefault) launchArguments = undefined;
  }
  const payload = {
    ...(existing?.data || {}), name,
    displayName: existing?.data?.displayName || `${identity.title} (PS5)`,
    appid, platform: "kytyps5", config_path: schemaDir, save_path: progressPath,
    game_path: path.resolve(gamePath), kytyps5_title_id: appid,
    kytyps5_emulator_root: path.resolve(emulatorRoot), kytyps5_game_path: path.resolve(gamePath),
    kytyps5_progress_path: progressPath, kytyps5_user_id: String(userId),
    kytyps5_service_label: serviceLabel,
    kytyps5_service_labels: labels, kytyps5_format_version: 2,
    kytyps5_trophy_sets: labels.map((label) => oldSets.get(label) || { serviceLabel: label }),
    native_platinum: schema.some((item) => item.trophyType === "platinum"),
    executable: existing?.data?.executable ?? path.join(emulatorRoot, "kyty_emulator.exe"),
    arguments: launchArguments ?? defaultArguments(gamePath),
    process_name: existing?.data?.process_name ?? "kyty_emulator.exe",
    working_directory: existing?.data?.working_directory ?? path.resolve(emulatorRoot),
  };
  delete payload.platinum; // Completion is derived from each profile's snapshot.
  reportProgress("writingConfig", 90);
  if (migrationNeeded) options.migrateCaches({ payload, configs });
  const configPath = existing?.filePath || path.join(configsDir, `${name}.json`);
  const configUpdated = writeChangedJson(configPath, payload);
  const retiredConfigs = configs.filter((entry) => entry.name !== name);
  for (const entry of retiredConfigs) fs.unlinkSync(entry.filePath); // Backed up above; no emulator files are removed.
  const platformIndex = global.configPlatformIndex;
  if (platformIndex instanceof Map) {
    if (!platformIndex.has(appid)) platformIndex.set(appid, new Set());
    platformIndex.get(appid).add("kytyps5");
  }
  logger.info(`kytyps5:config:${!existing ? "created" : configUpdated || schemaUpdated ? "updated" : "unchanged"}`, {
    appid, name, userId: String(userId), serviceLabel, configPath, schemaDir, progressPath,
    created: !existing, configUpdated, schemaUpdated,
  });
  reportProgress("finalizing", 95);
  return { ...payload, configPath, created: !existing, configUpdated, schemaUpdated,
    pending, previousConfig: existing?.data || null,
    retiredConfigs: retiredConfigs.map((entry) => ({ name: entry.name, appid: entry.data.appid })) };
}

module.exports = { generateConfigFromKytyGame, canReuseGeneratedConfig, samePath, findGameConfigs };
