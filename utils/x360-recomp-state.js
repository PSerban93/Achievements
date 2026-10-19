"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const TOML = require("smol-toml");
const MAX_TOML_BYTES = 4 * 1024 * 1024;
const PLATFORM = "x360recomp";

function parseTomlFile(file) {
  const bytes = readStateBytes(file);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return TOML.parse(text, { integersAsBigInt: true, unsafeKeyBehaviour: "throw" });
}

// ReXGlue exports identity/language in header comments in older versions.
// Parse the header and table from one bounded read so they cannot disagree
// merely because a game/exporter replaced the file between reads.
function readMetadataFile(file) {
  const text = readStateText(file);
  const doc = TOML.parse(text, { integersAsBigInt: true, unsafeKeyBehaviour: "throw" });
  const header = text.split(/^\s*\[\[/m, 1)[0];
  const commentId = /^\s*#\s*Title ID:\s*(?:0x)?([a-f0-9]{8})\s*$/im.exec(header)?.[1];
  const rawId = doc.title_id ?? doc.titleId;
  const explicitId = rawId === undefined ? "" : titleId(typeof rawId === "bigint" ? rawId.toString(16).padStart(8, "0") : rawId);
  const id = titleId(commentId);
  if ((rawId !== undefined && !explicitId) || (id && explicitId && id !== explicitId)) throw new Error("Invalid or conflicting Xbox metadata TitleID");
  const language = doc.language ?? /^\s*#\s*Language:\s*(\d+)\s*$/im.exec(header)?.[1];
  return { doc, titleId: explicitId || id, language: language === undefined ? 1 : Number(language) };
}

function achievementId(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("Invalid Xbox achievement ID");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 0xffffffff) throw new Error("Invalid Xbox achievement ID");
  return String(n);
}

function titleId(value) {
  const id = String(value || "").replace(/^0x/i, "").toUpperCase();
  return /^[A-F0-9]{8}$/.test(id) && id !== "00000000" ? id : "";
}

function validProfile(value) {
  const name = String(value || "");
  return name && name.length <= 128 && !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) && name !== "." && name !== "..";
}

function samePath(a, b) {
  const key = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return !!a && !!b && key(a) === key(b);
}

function hasConfirmedProgress(config) {
  return Object.values(config?.x360_recomp_progress || {}).some((entry) => entry?.file &&
    (entry.confirmed === true || ["existing-state", "observed-state"].includes(entry.source)));
}

function progressPath(config, profile = config?.x360_recomp_profile || "default") {
  const id = titleId(config?.appid || config?.x360_recomp_title_id);
  if (!id || !validProfile(profile)) return "";
  const descriptor = config?.x360_recomp_progress?.[profile];
  if (descriptor) {
    if (descriptor.file) return typeof descriptor.file === "string" ? descriptor.file : "";
    if (descriptor.format === "tsv-directory" && descriptor.directory) {
      try {
        const files = fs.readdirSync(descriptor.directory).filter((name) => /^[a-f0-9]{16}\.tsv$/i.test(name));
        if (files.length === 1) return path.join(descriptor.directory, files[0]);
      } catch {}
    }
    return "";
  }
  const roots = config?.x360_recomp_profiles || {};
  // Only use roots established by discovery; the profile label is never a path.
  const root = Object.hasOwn(roots, profile) ? roots[profile] : "";
  return typeof root === "string" && root ? path.join(root, "achievements", `${id}.toml`) : "";
}

function profileForPath(config, file) {
  return Object.keys(config?.x360_recomp_profiles || {}).find((profile) =>
    samePath(progressPath(config, profile), file)) || "";
}

function progressStatus(config) {
  const profile = config?.x360_recomp_profile || "default";
  const descriptor = config?.x360_recomp_progress?.[profile];
  const directoryKnown = descriptor?.format === "tsv-directory" && typeof descriptor.directory === "string" && descriptor.directory.trim();
  const pending = config?.x360_recomp_progress_confirmed === false || descriptor?.format === "pending" || !progressPath(config, profile) && !directoryKnown;
  return { pending: !!pending, reason: pending ? descriptor?.reason || descriptor?.source || "unknown-source" : "" };
}

function profileOptions(config, profile = config?.x360_recomp_profile || "default") {
  return { x360RecompProfile: profile, x360RecompRoot: config?.x360_recomp_cache_root || config?.x360_recomp_install_root,
    x360RecompGeneration: config?.x360_recomp_cache_generations?.[profile] || "",
    filePath: progressPath(config, profile), savePath: progressPath(config, profile) };
}

function sourceKey(config, profile = config?.x360_recomp_profile || "default") {
  const descriptor = config?.x360_recomp_progress?.[profile];
  const tsv = descriptor?.format === "tsv-directory" || descriptor?.format === "tsv";
  const file = tsv ? descriptor.directory || (descriptor.file && path.dirname(descriptor.file)) : progressPath(config, profile);
  if (!file || descriptor?.format === "pending") return "";
  const resolved = path.resolve(file);
  return `${tsv ? "tsv" : descriptor?.format || "toml"}\0${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
}

function cacheScope(config, options = {}) {
  const profile = options.x360RecompProfile || profileForPath(config,
    options.filePath || options.savePath || "") || config?.x360_recomp_profile || "default";
  const root = options.x360RecompRoot || config?.x360_recomp_cache_root || config?.x360_recomp_install_root;
  if (!root || !validProfile(profile)) throw new Error("Missing Xbox 360 Recomp cache identity");
  let resolvedRoot = path.resolve(root);
  if (process.platform === "win32") resolvedRoot = resolvedRoot.toLowerCase();
  const generation = Object.hasOwn(options, "x360RecompGeneration") ? options.x360RecompGeneration :
    config?.x360_recomp_cache_generations?.[profile] || "";
  if (generation && !/^[a-f0-9]{16}$/.test(generation)) throw new Error("Invalid recomp cache generation");
  // Unchanged sources retain their original cache names, including legacy
  // configs. Only an actual source switch introduces a new generation.
  return crypto.createHash("sha256").update(`${resolvedRoot}\0${profile}${generation ? `\0${generation}` : ""}`).digest("hex").slice(0, 24);
}

function readStateBytes(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOML_BYTES) throw new Error("Invalid or oversized achievement state");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Achievement state changed during read");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Achievement state changed during read");
    return bytes;
  } finally { fs.closeSync(fd); }
}

function readStateText(file) {
  const bytes = readStateBytes(file);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8";
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function unixFiletime(value) {
  if (!/^\d{1,20}$/.test(String(value)) || BigInt(value) > 0xffffffffffffffffn) throw new Error("Invalid achievement timestamp");
  const time = BigInt(value), seconds = Number(time / 10000000n - 11644473600n);
  if (time !== 0n && (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799)) throw new Error("Invalid achievement timestamp");
  return time === 0n ? 0 : seconds;
}

function parseTsv(file, expectedTitle = "") {
  const lines = readStateText(file).split(/\r?\n/);
  const header = lines.shift().split("\t");
  const id = titleId(header[1]);
  if (header.length !== 3 || header[0] !== "EOTACH1" || !id || !/^[a-f0-9]{16}$/i.test(header[2]) ||
      expectedTitle && id !== titleId(expectedTitle)) throw new Error("Invalid or mismatched achievement TSV header");
  const profile = header[2].toUpperCase(), filename = path.basename(file, path.extname(file));
  if (filename.toUpperCase() !== profile) throw new Error("Achievement TSV profile mismatch");
  const snapshot = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = /^(\d+)\t(\d+)\s*$/.exec(line);
    if (!row) throw new Error("Incomplete achievement TSV row");
    const key = achievementId(row[1]);
    if (Object.hasOwn(snapshot, key)) throw new Error("Duplicate achievement TSV ID");
    snapshot[key] = { earned: true, earned_time: unixFiletime(row[2]) };
  }
  return { titleId: id, profile, snapshot };
}

function parseJsonState(file) {
  const doc = JSON.parse(readStateText(file));
  if (!doc || !Array.isArray(doc.achievements) || !doc.achievements.length) throw new Error("Missing achievement JSON definitions");
  const seen = new Set();
  const entries = doc.achievements.map((entry) => {
    const id = achievementId(entry?.id);
    if (seen.has(id) || typeof entry.unlocked !== "boolean" || typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.description !== "string" || !Number.isSafeInteger(entry.gamerscore) || entry.gamerscore < 0 || entry.gamerscore > 0xffffffff) {
      throw new Error("Invalid or incomplete achievement JSON entry");
    }
    seen.add(id);
    return { ...entry, id };
  });
  const rawTitle = doc.title_id ?? doc.titleId;
  const id = titleId(typeof rawTitle === "number" && Number.isSafeInteger(rawTitle) && rawTitle >= 0 && rawTitle <= 0xffffffff
    ? rawTitle.toString(16).padStart(8, "0") : rawTitle);
  if (rawTitle != null && !id) throw new Error("Invalid achievement JSON TitleID");
  return { entries, titleId: id, title: typeof doc.title === "string" ? doc.title : "" };
}

function readSnapshot(file, fallback = {}, options = {}) {
  try {
    if (!file || !fs.existsSync(file)) return { valid: false, missing: true, snapshot: fallback };
    const descriptor = options.descriptor || {};
    if (["unleashed", "gpd", "json-mapped", "tsv-mapped"].includes(descriptor.format)) {
      return { valid: true, snapshot: require("./x360-recomp-extra-state").readExtraSnapshot(
        readStateBytes(file), descriptor, options.titleId, fallback) };
    }
    // Explicit descriptors own the format. Extension inference is retained
    // only for older configs and direct discovery reads without a descriptor.
    const format = descriptor.format === "tsv-directory" ? "tsv" : descriptor.format ||
      (/\.tsv$/i.test(file) ? "tsv" : /\.json$/i.test(file) ? "json" : "toml");
    if (format === "tsv") return { valid: true, ...parseTsv(file, options.titleId) };
    if (format === "json") {
      const json = parseJsonState(file);
      if (json.titleId && options.titleId && json.titleId !== titleId(options.titleId)) throw new Error("Achievement JSON Title ID mismatch");
      const snapshot = {};
      for (const entry of json.entries) if (entry.unlocked) snapshot[entry.id] = { earned: true, earned_time: fallback[entry.id]?.earned_time || 0 };
      return { valid: true, snapshot };
    }
    if (format !== "toml") throw new Error(`Unsupported or pending achievement state format: ${format}`);
    const doc = parseTomlFile(file);
    const unlocked = doc.unlocked;
    // A zero-length/half-written file is not a valid empty state. The SDK's
    // empty snapshot includes its identifying comment (e.g. after a reset).
    if (unlocked === undefined) {
      if (!/Achievement unlock state.*ReXGlue/i.test(readStateText(file))) {
        throw new Error("Missing ReXGlue unlock state");
      }
      return { valid: true, snapshot: {} };
    }
    const snapshot = {};
    if (Array.isArray(unlocked)) {
      for (const value of unlocked) {
        const id = achievementId(value);
        snapshot[id] = { earned: true, earned_time: fallback[id]?.earned_time || 0 };
      }
    } else if (unlocked && typeof unlocked === "object") {
      for (const [key, entry] of Object.entries(unlocked)) {
        const id = achievementId(key);
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            typeof entry.filetime !== "bigint" || entry.filetime < 0n) {
          throw new Error(`Incomplete ReXGlue unlock ${id}`);
        }
        const seconds = unixFiletime(entry.filetime);
        snapshot[id] = { earned: true, earned_time: entry.filetime ? seconds : fallback[id]?.earned_time || 0 };
      }
    } else throw new Error("Invalid ReXGlue unlock state");
    return { valid: true, snapshot };
  } catch (error) { return { valid: false, missing: error.code === "ENOENT", error: error.message, snapshot: fallback }; }
}

function loadConfigSnapshot(config, fallback = {}) {
  return readSnapshot(progressPath(config), fallback, { titleId: config?.appid,
    descriptor: config?.x360_recomp_progress?.[config?.x360_recomp_profile || "default"] });
}

module.exports = { PLATFORM, MAX_TOML_BYTES, parseTomlFile, achievementId, titleId,
  validProfile, samePath, hasConfirmedProgress, progressPath, progressStatus, profileForPath, profileOptions, sourceKey, cacheScope, readSnapshot, loadConfigSnapshot,
  parseTsv, parseJsonState, readStateText, readStateBytes, readMetadataFile, unixFiletime };
