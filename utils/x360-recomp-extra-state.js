"use strict";

const { TextDecoder } = require("util");
const { achievementId, titleId, unixFiletime } = require("./x360-recomp-state");

function timestamp(value, format = "unknown") {
  if (format === "unknown" || value === undefined || value === null || value === "" || value === 0 || value === "0") return 0;
  if (format === "filetime") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("FILETIME must be a string to preserve precision");
    return unixFiletime(value);
  }
  if (format === "iso" && typeof value !== "string") throw new Error("ISO timestamp must be a string");
  const seconds = format === "iso" ? Date.parse(value) / 1000 : Number(value) / (format === "unix-ms" ? 1000 : 1);
  if (!["iso", "unix", "unix-ms"].includes(format) || !Number.isFinite(seconds) || seconds < 0 || seconds > 253402300799) throw new Error("Invalid achievement timestamp");
  return Math.floor(seconds);
}

function decode(bytes) {
  return new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
}

function field(object, key) {
  let node = object;
  for (const part of key.split(".")) {
    if (!part || ["__proto__", "constructor", "prototype"].includes(part) || !node || !Object.hasOwn(node, part)) throw new Error(`Missing achievement field ${key}`);
    node = node[part];
  }
  return node;
}

// Official UnleashedRecomp x64 layout: 16-byte header + 50 packed 16-byte
// records (uint16 ID, signed 64-bit time_t, three reserved uint16s).
function unleashed(bytes, expectedTitle) {
  if (titleId(expectedTitle) !== "53450812" || bytes.length !== 816 || bytes.toString("ascii", 0, 4) !== "ACH " || bytes.readUInt32LE(4) > 1) throw new Error("Invalid Unleashed ACH-DATA header/title");
  let checksum = 0;
  for (let i = 16; i < bytes.length; i++) checksum ^= bytes[i];
  if (checksum !== bytes.readUInt32LE(8)) throw new Error("Unleashed ACH-DATA checksum mismatch");
  const snapshot = {};
  let ended = false;
  for (let at = 16; at < bytes.length; at += 16) {
    const id = bytes.readUInt16LE(at);
    if (!id) { ended = true; continue; }
    if (ended || id < 24 || id > 83 || id === 30 || id >= 55 && id <= 63 || Object.hasOwn(snapshot, id)) throw new Error("Invalid Unleashed achievement record");
    const raw = bytes.readBigInt64LE(at + 2);
    if (raw < 0n || raw > 253402300799n) throw new Error("Invalid Unleashed timestamp");
    snapshot[String(id)] = { earned: true, earned_time: Number(raw) };
  }
  return snapshot;
}

function parseGpd(bytes, file = "") {
  if (bytes.length < 24 || bytes.toString("ascii", 0, 4) !== "XDBF") throw new Error("Invalid GPD header");
  const be = bytes.readUInt32BE(4), le = bytes.readUInt32LE(4);
  const read = be >= 0x10000 && be <= 0x20000 ? "readUInt32BE" : le >= 0x10000 && le <= 0x20000 ? "readUInt32LE" : "";
  if (!read) throw new Error("Invalid GPD version");
  const capacity = bytes[read](8), count = bytes[read](12), freeCapacity = bytes[read](16), freeCount = bytes[read](20);
  const dataAt = 24 + capacity * 18 + freeCapacity * 8;
  if (count > capacity || freeCount > freeCapacity || dataAt > bytes.length) throw new Error("Truncated GPD tables");
  for (let i = 0; i < count; i++) {
    const at = 24 + i * 18, offset = bytes[read](at + 10), length = bytes[read](at + 14);
    if (dataAt + offset + length > bytes.length) throw new Error("Truncated GPD entry");
  }
  const gpd = require("./xenia-gpd");
  const parsed = gpd.parseGpdFile(file, bytes);
  const valid = gpd.getValidAchievements(parsed);
  if (!valid.length || valid.length !== parsed.achievements.length) throw new Error("Missing or incomplete GPD achievement definitions");
  return parsed;
}

function readExtraSnapshot(bytes, descriptor, expectedTitle, fallback) {
  if (descriptor.format === "unleashed") return unleashed(bytes, expectedTitle);
  if (descriptor.format === "gpd") {
    const raw = require("./xenia-gpd").buildSnapshotFromGpd(parseGpd(bytes, descriptor.file));
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => value.earned).map(([id, value]) =>
      [id, { earned: true, earned_time: timestamp(value.earned_time, "unix-ms") }]));
  }
  const mapping = descriptor.mapping;
  if (!mapping) throw new Error("Missing achievement field mapping");
  const snapshot = {}, seen = new Set();
  const add = (id, unlocked, time) => {
    const key = achievementId(id);
    if (seen.has(key) || typeof unlocked !== typeof mapping.unlocked_value) throw new Error("Duplicate ID or invalid unlock flag");
    seen.add(key);
    if (unlocked === mapping.unlocked_value) snapshot[key] = { earned: true,
      earned_time: timestamp(time, mapping.timestamp_format) || fallback[key]?.earned_time || 0 };
  };
  if (descriptor.format === "json-mapped") {
    const doc = JSON.parse(decode(bytes));
    if (mapping.title_id && titleId(field(doc, mapping.title_id)) !== titleId(expectedTitle)) throw new Error("JSON TitleID mismatch");
    const entries = mapping.entries ? field(doc, mapping.entries) : doc;
    if (!entries || typeof entries !== "object") throw new Error("Mapped JSON entries must be an array or ID map");
    if (Array.isArray(entries) && mapping.id === "@key") throw new Error("Array indexes are not achievement IDs");
    for (const [key, entry] of Object.entries(entries)) {
      const get = (selector) => selector === "@value" ? entry : selector === "@key" ? key : field(entry, selector);
      add(get(mapping.id), mapping.unlocked === undefined ? mapping.unlocked_value : get(mapping.unlocked), mapping.timestamp ? field(entry, mapping.timestamp) : undefined);
    }
  } else if (descriptor.format === "tsv-mapped") {
    const lines = decode(bytes).split(/\r?\n/);
    if (mapping.header !== undefined && lines.shift() !== mapping.header) throw new Error("Mapped TSV header mismatch");
    for (const line of lines) {
      if (!line.trim()) continue;
      const columns = line.split("\t");
      if (columns.length !== mapping.columns) throw new Error("Incomplete mapped TSV row");
      add(columns[mapping.id], mapping.unlocked === undefined ? mapping.unlocked_value : columns[mapping.unlocked], mapping.timestamp === undefined ? undefined : columns[mapping.timestamp]);
    }
  } else throw new Error("Unsupported achievement state format");
  return snapshot;
}

module.exports = { readExtraSnapshot, parseGpd, timestamp };
