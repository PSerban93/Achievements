"use strict";

const fs = require("fs");
const path = require("path");
const state = require("./x360-recomp-state");
const { expandPath } = require("./x360-recomp-paths");
const NAME = "achievements-recomp.json";
const FORMATS = new Set(["toml", "tsv", "json", "unleashed", "gpd", "json-mapped", "tsv-mapped"]);
const TIME_FORMATS = new Set(["unknown", "unix", "unix-ms", "filetime", "iso"]);

function mappingFor(format, value) {
  if (!["json-mapped", "tsv-mapped"].includes(format)) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing progress mapping");
  const mapping = { ...value, timestamp_format: value.timestamp_format || "unknown" };
  if (!TIME_FORMATS.has(mapping.timestamp_format) || !["boolean", "string", "number"].includes(typeof mapping.unlocked_value) ||
      typeof mapping.unlocked_value === "number" && !Number.isFinite(mapping.unlocked_value)) throw new Error("Invalid mapped unlock value/time format");
  const selector = (key) => typeof key === "string" && key.length <= 256 && key.split(".").every((part) => /^[a-z0-9_-]+$/i.test(part) && !["__proto__", "constructor", "prototype"].includes(part));
  if (format === "json-mapped") {
    if (!(selector(mapping.id) || ["@key", "@value"].includes(mapping.id)) ||
        mapping.unlocked !== undefined && !(selector(mapping.unlocked) || mapping.unlocked === "@value") ||
        ["entries", "timestamp", "title_id"].some((key) => mapping[key] !== undefined && !selector(mapping[key]))) throw new Error("Invalid JSON field mapping");
  } else {
    if (!Number.isSafeInteger(mapping.columns) || mapping.columns < 1 || mapping.columns > 64 ||
        !Number.isSafeInteger(mapping.id) || mapping.id < 0 || mapping.id >= mapping.columns ||
        ["unlocked", "timestamp"].some((key) => mapping[key] !== undefined && (!Number.isSafeInteger(mapping[key]) || mapping[key] < 0 || mapping[key] >= mapping.columns)) ||
        mapping.unlocked !== undefined && typeof mapping.unlocked_value !== "string" ||
        mapping.header !== undefined && (typeof mapping.header !== "string" || /[\r\n]/.test(mapping.header))) throw new Error("Invalid TSV column mapping");
  }
  if (mapping.timestamp_format !== "unknown" && mapping.timestamp === undefined) throw new Error("Missing timestamp field/column");
  return mapping;
}

function readManifest(file, options = {}) {
  const root = path.dirname(file), doc = JSON.parse(state.readStateText(file));
  const id = state.titleId(doc.title_id);
  if (doc.version !== 1 || !id || typeof doc.title !== "string" || !doc.title.trim() || doc.title.length > 256) throw new Error("Invalid recomp manifest identity/version");
  if (doc.adapter !== undefined && (doc.adapter !== "reblue" || id !== "4D5307DF")) throw new Error("Unsupported manifest adapter");
  const resolve = (value) => {
    const target = expandPath(value, root, options);
    if (!target || options.isBlocked?.(target)) throw new Error("Invalid or excluded recomp manifest path");
    // Do not silently follow symlinks/junctions, including existing ancestors
    // of a progress file that has not been created yet.
    let candidate = target;
    while (true) {
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error("Recomp manifest path traverses a symlink"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = path.dirname(candidate); if (parent === candidate) break; candidate = parent;
    }
    return target;
  };
  if (!doc.profiles || typeof doc.profiles !== "object" || Array.isArray(doc.profiles) || !Object.keys(doc.profiles).length || Object.keys(doc.profiles).length > 64) throw new Error("Missing recomp manifest profiles");
  const profiles = {}, progress = {}, files = new Set();
  for (const [profile, source] of Object.entries(doc.profiles)) {
    if (!state.validProfile(profile) || ["__proto__", "constructor", "prototype"].includes(profile) || !FORMATS.has(source?.format)) throw new Error("Invalid recomp manifest profile/format");
    if (source.format === "unleashed" && id !== "53450812") throw new Error("Unleashed state belongs to another TitleID");
    const target = resolve(source.file), key = process.platform === "win32" ? target.toLowerCase() : target;
    if (files.has(key)) throw new Error("Two recomp profiles reference the same file");
    files.add(key);
    if (source.format === "gpd" && path.basename(target).toUpperCase() !== `${id}.GPD`) throw new Error("GPD filename must match TitleID");
    if (source.format === "tsv" && !/^[a-f0-9]{16}\.tsv$/i.test(path.basename(target))) throw new Error("EOT TSV requires a profile filename");
    if (source.format === "toml" && path.basename(target).toUpperCase() !== `${id}.TOML`) throw new Error("ReXGlue TOML filename must match TitleID");
    progress[profile] = { format: source.format, file: target, source: "manifest", ...(source.mapping ? { mapping: mappingFor(source.format, source.mapping) } : {}) };
    if (["json-mapped", "tsv-mapped"].includes(source.format) && !progress[profile].mapping) throw new Error("Missing progress mapping");
    profiles[profile] = path.dirname(target);
  }
  if (doc.metadata !== undefined && (!Array.isArray(doc.metadata) || doc.metadata.length > 32)) throw new Error("Invalid recomp metadata list");
  const metadata = (doc.metadata || []).map((value) => {
    const target = resolve(value);
    if (!/\.(toml|json|spa|xdbf|gpd)$/i.test(target) || state.samePath(target, file)) throw new Error("Unsupported metadata export");
    if (/\.gpd$/i.test(target) && path.basename(target).toUpperCase() !== `${id}.GPD`) throw new Error("Metadata GPD filename/TitleID mismatch");
    return target;
  });
  if (doc.icons !== undefined && (!doc.icons || typeof doc.icons !== "object" || Array.isArray(doc.icons) || Object.keys(doc.icons).length > 10000)) throw new Error("Invalid recomp icon map");
  const icons = {};
  for (const [key, value] of Object.entries(doc.icons || {})) {
    const target = resolve(value);
    if (!/\.(png|jpg|jpeg|webp)$/i.test(target)) throw new Error("Unsupported achievement icon type");
    icons[state.achievementId(key)] = target;
  }
  return { file, titleId: id, title: doc.title.trim(), adapter: doc.adapter || "manifest", profiles, progress, metadata, icons, xexPath: doc.xex ? resolve(doc.xex) : "" };
}

module.exports = { NAME, readManifest };
