"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { createLogger } = require("./logger");
const { samePath, hasConfirmedProgress, progressPath, progressStatus, sourceKey } = require("./x360-recomp-state");
const { loadMetadata } = require("./x360-recomp-metadata");
const logger = createLogger("achschema");

function changedWrite(file, value) {
  try { if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(value)) return false; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  writeJsonAtomicSync(file, value, { backup: true }); return true;
}

// Progress discovery must not load metadata or write achievement definitions.
function applyProgressSources(game, data, previous) {
  const profiles = { ...game.profiles }, progress = { ...game.progress };
  const realProfiles = Object.keys(profiles).filter((key) => !["pending", "tsv-directory"].includes(progress[key]?.format));
  const choices = realProfiles.length ? realProfiles : Object.keys(profiles);
  const selected = previous?.x360_recomp_profile;
  data.x360_recomp_profile = choices.includes(selected) ? selected : choices.includes("default") ? "default" : choices[0];
  data.x360_recomp_profiles = profiles;
  data.x360_recomp_progress = progress;
  data.x360_recomp_discovery_roots = game.searchRoots || [];
  data.x360_recomp_progress_confirmed = hasConfirmedProgress(data);
  data.save_path = data.x360_recomp_progress_confirmed ? progressPath(data) : "";
  const generations = { ...(previous?.x360_recomp_cache_generations || {}) };
  for (const key of Object.keys(profiles)) {
    const previousSource = previous && sourceKey(previous, key), nextSource = sourceKey(data, key);
    if (previousSource && nextSource && previousSource !== nextSource) generations[key] = crypto.randomBytes(8).toString("hex");
  }
  if (Object.keys(generations).length) data.x360_recomp_cache_generations = generations;
  const status = progressStatus(data);
  data.x360_recomp_progress_pending = status.pending;
  data.x360_recomp_progress_reason = status.reason;
  return status;
}

function bindProgressConfig(configsDir, configName, item) {
  if (!configName || path.basename(configName) !== configName) throw new Error("Invalid recomp config name");
  const previous = JSON.parse(fs.readFileSync(path.join(configsDir, `${configName}.json`), "utf8"));
  if (previous.platform !== "x360recomp" || previous.appid !== item.id) throw new Error("Recomp progress TitleID mismatch");
  const profiles = { ...previous.x360_recomp_profiles }, progress = { ...previous.x360_recomp_progress };
  for (const profile of Object.keys(profiles)) {
    if (!hasConfirmedProgress(previous) || ["pending", "tsv-directory"].includes(progress[profile]?.format)) {
      delete profiles[profile]; delete progress[profile];
    }
  }
  if (progress[item.profile]?.file && !samePath(progress[item.profile].file, item.file)) {
    throw new Error("Multiple progress sources for one recomp profile; manual Rescan required");
  }
  profiles[item.profile] = item.userRoot;
  progress[item.profile] = { ...item.descriptor, format: item.format, file: item.file, source: "observed-state", confirmed: true };
  return updateProgressConfig({ titleId: item.id, installRoot: previous.x360_recomp_install_root, profiles, progress,
    searchRoots: [...new Set(Object.values(progress).filter((entry) => entry?.file).map((entry) => path.dirname(entry.file)))] }, configsDir, configName);
}

function updateProgressConfig(game, configsDir, configName) {
  if (!configName || path.basename(configName) !== configName) throw new Error("Invalid recomp config name");
  const file = path.join(configsDir, `${configName}.json`);
  const previous = JSON.parse(fs.readFileSync(file, "utf8"));
  if (previous.platform !== "x360recomp" || previous.appid !== game.titleId ||
      !samePath(previous.x360_recomp_install_root, game.installRoot)) throw new Error("Recomp progress config identity changed");
  const data = { ...previous };
  const status = applyProgressSources(game, data, previous);
  const configUpdated = changedWrite(file, data);
  return { ...data, config: data, name: configName, created: false, schemaUpdated: false, configUpdated,
    schemaDir: data.config_path, pending: [], progressOnly: true, progressPending: status.pending, progressReason: status.reason };
}

async function generateConfig(game, configsDir, options = {}) {
  if (options.isCancelled?.()) throw new Error("Recomp generation cancelled");
  const installKey = process.platform === "win32" ? path.resolve(game.installRoot).toLowerCase() : path.resolve(game.installRoot);
  const hash = crypto.createHash("sha256").update(`${game.adapter}\0${installKey}`).digest("hex").slice(0, 8);
  let schemaDir = path.join(configsDir, "schema", "x360recomp", game.titleId, hash);
  fs.mkdirSync(configsDir, { recursive: true });
  const configs = fs.readdirSync(configsDir).filter((file) => file.endsWith(".json")).map((file) => {
    try { return { file, data: JSON.parse(fs.readFileSync(path.join(configsDir, file), "utf8")) }; } catch { return null; }
  }).filter((entry) => entry?.data.platform === "x360recomp" && entry.data.appid === game.titleId);
  let existing = configs.find((entry) => samePath(entry.data.x360_recomp_install_root, game.installRoot));
  if (!existing && !game.sourceOnly) {
    const matches = configs.filter((entry) => (entry.data.x360_recomp_source_only === true ||
      entry.data.x360_recomp_source_only === undefined && entry.data.x360_recomp_adapter !== "reblue" && !entry.data.x360_recomp_xex_path &&
      Object.values(entry.data.x360_recomp_profiles || {}).some((root) => samePath(root, entry.data.x360_recomp_install_root))) &&
      (game.stateAliases || []).some((alias) => samePath(alias, entry.data.x360_recomp_install_root)) &&
      Object.keys(entry.data.x360_recomp_profiles || {}).some((profile) =>
        Object.values(game.progress || {}).some((descriptor) => samePath(descriptor.file, progressPath(entry.data, profile)))));
    if (matches.length > 1) throw new Error("Multiple existing configs match the recomp save source");
    existing = matches[0];
  }
  // Retain the schema and cache identity when a state-only config learns its
  // installation. User settings and previously refreshed rarity stay intact.
  if (existing?.data.config_path) {
    const relative = path.relative(path.join(configsDir, "schema", "x360recomp"), existing.data.config_path);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) schemaDir = existing.data.config_path;
  }
  options.onProgress?.({ phase: options.bootMode ? "preparing" : "generatingSchema", percent: 15, appid: game.titleId, itemName: game.title });
  const launchIdentity = (data) => JSON.stringify([data.executable || "", data.arguments || "", data.working_directory || ""]);
  const originalLaunch = existing && launchIdentity(existing.data);
  const metadata = await loadMetadata(game, schemaDir, logger, options);
  if (options.isCancelled?.()) throw new Error("Recomp generation cancelled");
  if (!metadata.schema.length) throw new Error("Empty recomp achievement metadata");
  if (existing) {
    existing.data = JSON.parse(fs.readFileSync(path.join(configsDir, existing.file), "utf8"));
    if (launchIdentity(existing.data) !== originalLaunch) throw new Error("Recomp launch settings changed during generation; rescan required");
  }
  let old = []; try { old = JSON.parse(fs.readFileSync(path.join(schemaDir, "achievements.json"), "utf8")); } catch {}
  const previous = new Map(old.map((entry) => [entry.name, entry]));
  metadata.schema = metadata.schema.map((entry) => {
    const known = previous.get(entry.name);
    return { ...entry, ...(known?.rarityPct != null ? { rarityPct: known.rarityPct, raritySource: known.raritySource } : {}),
      ...(entry.icon ? {} : known?.icon ? { icon: known.icon, icon_gray: known.icon_gray || known.icon } : {}) };
  });
  const schemaUpdated = changedWrite(path.join(schemaDir, "achievements.json"), metadata.schema);
  // Catalog title records can contain another region's marketing name. Keep
  // an established native-port name when the executable's own metadata failed.
  const title = game.manifest || game.adapter === "reblue" ||
    metadata.source === "catalog" && game.native && !game.native.generic
    ? game.title : metadata.title || game.title;
  const safe = (value) => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "").slice(0, 140) || game.titleId;
  let name = existing ? path.basename(existing.file, ".json") : safe(`${title} (Xbox 360 Recomp)`);
  if (!existing) { const base = name; let i = 2; while (fs.existsSync(path.join(configsDir, `${name}.json`))) name = `${base} [${game.titleId}-${i++}]`; }
  const profiles = { ...game.profiles }, progress = { ...game.progress };
  const selected = existing?.data.x360_recomp_profile;
  const realProfiles = Object.keys(profiles).filter((key) => !["pending", "tsv-directory"].includes(progress[key]?.format));
  const choices = realProfiles.length ? realProfiles : Object.keys(profiles);
  const profile = choices.includes(selected) ? selected : choices.includes("default") ? "default" : choices[0];
  const data = { ...(existing?.data || {}), name, displayName: title, appid: game.titleId, platform: "x360recomp",
    executable: existing?.data.executable || game.executable || "",
    process_name: existing?.data.process_name || path.basename(existing?.data.executable || game.executable || ""),
    arguments: game.launch?.arguments ?? existing?.data.arguments ?? "",
    ...(game.launch ? { working_directory: game.launch.workingDirectory } : {}),
    ...(game.launch?.source === "auto" ? { x360_recomp_generated_launch: {
      executable: game.launch.executable, arguments: game.launch.arguments, workingDirectory: game.launch.workingDirectory } } : {}),
    config_path: schemaDir, x360_recomp_title_id: game.titleId, x360_recomp_install_root: game.installRoot,
    x360_recomp_adapter: game.adapter, x360_recomp_profile: profile, x360_recomp_profiles: profiles,
    x360_recomp_progress: progress, x360_recomp_source_only: game.sourceOnly === true,
    x360_recomp_cache_root: existing?.data.x360_recomp_cache_root || existing?.data.x360_recomp_install_root || game.installRoot,
    x360_recomp_discovery_roots: game.searchRoots || [],
    x360_recomp_xex_path: game.xexPath, x360_recomp_metadata_paths: game.metadataPaths,
    x360_recomp_metadata_source: metadata.source, x360_recomp_catalog_title: metadata.title || game.title,
    x360_recomp_format_version: 2,
    language: existing?.data.language || "english" };
  const progressState = applyProgressSources(game, data, existing?.data);
  const configUpdated = changedWrite(path.join(configsDir, `${name}.json`), data);
  logger.info(`x360recomp:schema:${schemaUpdated ? old.length ? "updated" : "created" : "unchanged"}`, {
    appid: game.titleId, config: name, source: metadata.source, count: metadata.schema.length, profile,
    schemaUpdated, pending: metadata.pending });
  logger.info(`x360recomp:config:${!existing ? "created" : configUpdated ? "updated" : "unchanged"}`, {
    appid: game.titleId, config: name, created: !existing, configUpdated, schemaUpdated });
  if (configUpdated || !existing) logger.info("x360recomp:progress:source", { appid: game.titleId, config: name, profile,
    format: progress[profile]?.format || "toml", file: data.save_path || null, source: progress[profile]?.source || "existing-config" });
  options.onProgress?.({ phase: configUpdated || schemaUpdated ? "finalizingConfig" : "preparing", percent: 90, appid: game.titleId, itemName: title });
  return { ...data, config: data, name, created: !existing, schemaUpdated, configUpdated, schemaDir, pending: metadata.pending,
    progressPending: progressState.pending, progressReason: progressState.reason };
}

module.exports = { generateConfig, updateProgressConfig, bindProgressConfig };
