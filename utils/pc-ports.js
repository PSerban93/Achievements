"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");
const { createLogger } = require("./logger");
const logger = createLogger("achschema");
const GAME_ID = "ladxhd";
const TITLE = "The Legend of Zelda: Link's Awakening DX HD";
// AchievementManager.Count in the supported Updated builds. Extra localization
// keys do not define achievements; missing rows must not produce a shorter schema.
const ACHIEVEMENT_COUNT = 110;
const LANGUAGES = { eng: "english", chn: "schinese", deu: "german", esp: "spanish", fre: "french",
  ind: "indonesian", ita: "italian", por: "brazilian", pte: "portuguese", rus: "russian", swe: "swedish" };

function samePath(a, b) {
  const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return !!a && !!b && key(a) === key(b);
}

function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readText(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`Invalid PC port data file: ${file}`);
  return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)).replace(/^\uFEFF/, "");
}

function languageFiles(root) {
  const result = [];
  for (const directory of [path.join(root, "Data", "Languages"), path.join(root, "Mods", "Languages")]) {
    if (!fs.existsSync(directory)) continue;
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Symlinked LADXHD language directory is unsupported");
    for (const name of fs.readdirSync(directory).sort()) {
      const match = /^(?:(?:achieve|dialog)_)?([a-z]{3})\.lng$/i.exec(name);
      if (match && LANGUAGES[match[1].toLowerCase()]) result.push({ file: path.join(directory, name), language: LANGUAGES[match[1].toLowerCase()] });
    }
  }
  return result;
}

function metadata(root, options = {}) {
  const languages = new Map();
  for (const { file, language } of languageFiles(root)) {
    if (options.isBlocked?.(file)) continue;
    const strings = languages.get(language) || new Map();
    for (const line of readText(file).split(/\r?\n/)) {
      const match = /^(achieve(?:Name|Desc)(\d+)) (.*)$/.exec(line);
      if (match && Number(match[2]) < ACHIEVEMENT_COUNT) strings.set(match[1], match[3]);
    }
    languages.set(language, strings);
  }
  const english = languages.get("english");
  if (!english?.has("achieveName0")) throw new Error("LADXHD English achievement metadata is missing");
  const ids = Array.from({ length: ACHIEVEMENT_COUNT }, (_, id) => id);
  return ids.map((id) => {
    const displayName = {}, description = {};
    for (const [language, strings] of languages) {
      displayName[language] = strings.get(`achieveName${id}`) || english.get(`achieveName${id}`);
      description[language] = strings.get(`achieveDesc${id}`) || english.get(`achieveDesc${id}`) || "";
    }
    if (!displayName.english || !description.english) throw new Error(`Incomplete LADXHD achievement ${id}`);
    const image = path.join(root, "Data", "Achievements", `achievement${id}.png`);
    if (options.isBlocked?.(image)) throw new Error(`LADXHD achievement image is blocked: ${image}`);
    const stat = fs.lstatSync(image);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error(`Invalid achievement image: ${image}`);
    return { name: `achievement${id}`, displayName, description, hidden: 0,
      icon: `img/achievement${id}.png`, icon_gray: `img/achievement${id}.png`, image };
  });
}

function detectGame(root, options = {}) {
  const names = fs.readdirSync(root);
  const executable = names.find((name) => /^(?:Link['’]?s Awakening DX HD|LADXHD)\.exe$/i.test(name));
  if (!executable || !fs.existsSync(path.join(root, "Data", "Languages", "achieve_eng.lng")) ||
      !fs.existsSync(path.join(root, "Data", "Achievements", "achievement0.png"))) return null;
  for (const directory of [path.join(root, "Data"), path.join(root, "Data", "Achievements")]) {
    if (fs.lstatSync(directory).isSymbolicLink() || options.isBlocked?.(directory)) return null;
  }
  const portable = fs.existsSync(path.join(root, "portable.txt"));
  const localData = options.localAppDataPath || process.env.LOCALAPPDATA || path.join(require("os").homedir(), ".local", "share");
  const progressFile = portable ? path.join(root, "achievements") : path.join(localData, "Zelda_LA", "achievements");
  if (options.isBlocked?.(progressFile)) return null;
  return { appid: GAME_ID, name: TITLE, title: TITLE, platform: "pcports", installRoot: root, executable, portable, progressFile };
}

async function discoverGames(root, options = {}) {
  const queue = [{ directory: path.resolve(root), depth: 0 }], games = [], errors = [];
  let visited = 0;
  while (queue.length && visited++ < 400) {
    if (visited % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
    const { directory, depth } = queue.shift();
    if (options.isBlocked?.(directory)) continue;
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) continue;
      const game = detectGame(directory, options);
      if (game) { games.push(game); continue; }
      if (depth >= 3) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !/^(?:Data|Content|Mods|node_modules|\.git|\.svn|SaveFiles)$/i.test(entry.name)) {
          queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
        }
      }
    } catch (error) { errors.push({ root: directory, error: error.message }); }
  }
  return { games, errors, truncated: queue.length > 0 };
}

function fingerprint(game) {
  const files = [...languageFiles(game.installRoot).map((entry) => entry.file),
    ...fs.readdirSync(path.join(game.installRoot, "Data", "Achievements")).filter((name) => /^achievement\d+\.png$/i.test(name))
      .map((name) => path.join(game.installRoot, "Data", "Achievements", name))];
  return JSON.stringify([game.progressFile, ...files.map((file) => { const stat = fs.statSync(file); return [file, stat.size, stat.mtimeMs]; })]);
}

function progressPath(config) { return String(config?.pc_port_progress_file || config?.save_path || "").trim(); }
function cacheOptions(config) { return { pcPortsSource: progressPath(config) }; }
function cacheScope(config, options = {}) {
  const file = options.pcPortsSource || progressPath(config);
  if (!file) throw new Error("PC port achievement source is missing");
  const resolved = path.resolve(file);
  return crypto.createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 12);
}

function readSnapshot(file, previous = {}, options = {}) {
  try {
    const text = readText(file), snapshot = {}, expected = options.names ? new Set(options.names) : null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^(achievement\d+) (true|false)$/i.exec(line.trim());
      if (!match || Object.hasOwn(snapshot, match[1].toLowerCase())) throw new Error("Invalid or duplicate LADXHD achievement record");
      const name = match[1].toLowerCase(), earned = match[2].toLowerCase() === "true";
      if (expected && !expected.has(name)) continue;
      snapshot[name] = { earned, earned_time: earned ? previous[name]?.earned_time || options.observedTime || 0 : 0 };
    }
    if (!Object.keys(snapshot).length || expected && [...expected].some((name) => !Object.hasOwn(snapshot, name))) {
      throw new Error("Incomplete LADXHD achievements file");
    }
    return { valid: true, snapshot };
  } catch (error) { return { valid: false, missing: error.code === "ENOENT", snapshot: previous, error: error.message }; }
}

function loadConfigSnapshot(config, previous = {}) {
  let names;
  try { names = JSON.parse(fs.readFileSync(path.join(config.config_path, "achievements.json"), "utf8")).map((entry) => entry.name); }
  catch (error) { return { valid: false, snapshot: previous, error: error.message }; }
  return readSnapshot(progressPath(config), previous, { names });
}

function changedWrite(file, value) {
  try { if (JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) === JSON.stringify(value)) return false; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  writeJsonAtomicSync(file, value, { backup: true }); return true;
}

async function generateConfig(game, configsDir, options = {}) {
  if (options.isCancelled?.()) throw new Error("PC port generation cancelled");
  fs.mkdirSync(configsDir, { recursive: true });
  const existing = fs.readdirSync(configsDir).filter((file) => file.endsWith(".json")).map((file) => {
    try { return { file, data: JSON.parse(fs.readFileSync(path.join(configsDir, file), "utf8")) }; } catch { return null; }
  }).find((entry) => entry?.data.platform === "pcports" && entry.data.appid === game.appid &&
    (samePath(progressPath(entry.data), game.progressFile) || samePath(entry.data.pc_port_install_root, game.installRoot)));
  const schemaDir = path.join(configsDir, "schema", "pcports", game.appid, cacheScope({ save_path: game.progressFile }));
  options.onProgress?.({ phase: "generatingSchema", percent: 15, appid: game.appid, itemName: game.title });
  const entries = metadata(game.installRoot, options);
  // Rescans rebuild local text/icons, but must retain manually refreshed rarity.
  // Achievement IDs remain local LADXHD IDs, independent of Exophase row order.
  const previousSchemaPath = existing?.data.config_path && path.join(existing.data.config_path, "achievements.json");
  const previousSchema = previousSchemaPath && fs.existsSync(previousSchemaPath)
    ? JSON.parse(fs.readFileSync(previousSchemaPath, "utf8")) : [];
  if (!Array.isArray(previousSchema)) throw new Error("Existing PC port schema is invalid");
  const previousByName = new Map(previousSchema.map((entry) => [entry.name, entry]));
  fs.mkdirSync(path.join(schemaDir, "img"), { recursive: true });
  const schema = entries.map(({ image, ...entry }) => {
    const previous = previousByName.get(entry.name);
    if (typeof previous?.rarityPct === "number" && Number.isFinite(previous.rarityPct) &&
        previous.rarityPct >= 0 && previous.rarityPct <= 100) {
      entry.rarityPct = previous.rarityPct;
      if (previous.raritySource) entry.raritySource = previous.raritySource;
    }
    const target = path.join(schemaDir, entry.icon), bytes = fs.readFileSync(image);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Invalid PNG: ${image}`);
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) fs.writeFileSync(target, bytes);
    return entry;
  });
  if (options.isCancelled?.()) throw new Error("PC port generation cancelled");
  const schemaUpdated = changedWrite(path.join(schemaDir, "achievements.json"), schema);
  let name = existing ? path.basename(existing.file, ".json") : sanitizeConfigName(`${game.title} (PC Port)`);
  if (!existing) { const base = name; let suffix = 2; while (fs.existsSync(path.join(configsDir, `${name}.json`))) name = `${base} [${suffix++}]`; }
  const previous = existing ? JSON.parse(fs.readFileSync(path.join(configsDir, existing.file), "utf8")) : {};
  const data = { ...previous, name, displayName: game.title, appid: game.appid, platform: "pcports", config_path: schemaDir,
    pc_port_game: GAME_ID, pc_port_install_root: game.installRoot, pc_port_progress_file: game.progressFile,
    pc_port_portable: game.portable, pc_port_metadata_source: "local-ladxhd", save_path: game.progressFile,
    process_name: previous.process_name || game.executable, executable: previous.executable || path.join(game.installRoot, game.executable),
    language: previous.language || "english" };
  options.onProgress?.({ phase: "finalizingConfig", percent: 90, appid: game.appid, itemName: game.title });
  const configUpdated = changedWrite(path.join(configsDir, `${name}.json`), data);
  logger.info("pcports:schema:ready", { appid: game.appid, config: name, count: schema.length,
    languages: Object.keys(schema[0].displayName), source: "local-ladxhd", progressFile: game.progressFile });
  return { ...data, config: data, created: !existing, configUpdated, schemaUpdated, schemaDir };
}

module.exports = { discoverGames, detectGame, fingerprint, metadata, generateConfig, readSnapshot, loadConfigSnapshot,
  progressPath, cacheOptions, cacheScope, samePath, inside };
