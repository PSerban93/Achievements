"use strict";

const fs = require("fs").promises;
const path = require("path");
const { sanitizeAchievementMediaFilename: sanitize } = require("./screenshot-paths");
const folded = value => process.platform === "win32" ? value.toLowerCase() : value;
const inside = (root, file) => {
  const relative = path.relative(folded(root), folded(file));
  return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
function labels(value) {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(labels);
}
const folderIdentity = value => folded(sanitize(value).normalize("NFC").replace(/[\u2018\u2019\u201b\u02bc\uff07]/g, "'"));
async function mediaDirectories(root, configName, getConfigNames) {
  const expected = sanitize(configName), identity = folderIdentity(expected);
  let exact = null;
  try { exact = await fs.realpath(path.join(root, expected)); }
  catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  // Plain ASCII names without apostrophes cannot have any of these aliases.
  if (exact && !/['\u2018\u2019\u201b\u02bc\uff07]/.test(expected) && expected.normalize("NFD") === expected) return [exact];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return exact ? [exact] : []; }
  const aliases = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() &&
    folded(entry.name) !== folded(expected) && folderIdentity(entry.name) === identity);
  if (aliases.length !== 1) return exact ? [exact] : [];
  if (getConfigNames) {
    // A typography-equivalent name may be a separate config. Keep its captures separate.
    let names;
    try { names = await getConfigNames(); } catch { return exact ? [exact] : []; }
    if ([...names].some(name => folded(sanitize(name)) !== folded(expected) && folderIdentity(name) === identity)) return exact ? [exact] : [];
  }
  let alias;
  try { alias = await fs.realpath(path.join(root, aliases[0].name)); } catch { return exact ? [exact] : []; }
  // Retain historical captures if a later unlock creates the current exact-name folder.
  return [...new Set([exact, alias].filter(Boolean))];
}
function timestampSuffix(stem, base) {
  if (folded(stem) === folded(base)) return 0;
  if (!folded(stem).startsWith(folded(base) + "_")) return null;
  const suffix = stem.slice(base.length + 1);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(suffix);
  if (!m) return null;
  const date = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().replace(/[:.]/g, "-") === suffix ? date.getTime() : null;
}
async function complete(file, kind, size) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    if (kind === "screenshot") {
      if (size < 20) return false;
      const header = Buffer.alloc(8), tail = Buffer.alloc(12);
      await handle.read(header, 0, 8, 0); await handle.read(tail, 0, 12, size - 12);
      return header.equals(Buffer.from([137,80,78,71,13,10,26,10])) && tail.toString("ascii", 4, 8) === "IEND";
    }
    // Native recordings become public only after their staging file is renamed.
    // Validate top-level MP4 boxes too, so an interrupted/truncated file is not offered.
    let at = 0, ftyp = false, moov = false, boxes = 0;
    while (at + 8 <= size && boxes++ < 256) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, Math.min(16, size - at), at);
      if (bytesRead < 8) return false;
      let length = header.readUInt32BE(0);
      if (length === 1) {
        if (bytesRead < 16) return false;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        length = Number(large);
        if (length < 16) return false;
      } else if (length === 0) length = size - at;
      if (length < 8 || at + length > size) return false;
      const type = header.toString("ascii", 4, 8);
      ftyp ||= type === "ftyp"; moov ||= type === "moov";
      at += length;
    }
    return at === size && ftyp && moov;
  } catch { return false; } finally { await handle?.close(); }
}

async function scanAchievementMedia({ configName, achievementId, schema, snapshot, roots, getConfigNames }, all = false) {
  const empty = { screenshot: [], record: [] };
  if (!Array.isArray(schema)) return empty;
  const saved = snapshot?.achievements || snapshot;
  const wanted = new Set(schema.filter(entry => (all || String(entry?.name) === String(achievementId)) &&
    (saved?.[String(entry?.name)]?.earned === true || saved?.[String(entry?.name)]?.earned === 1)).map(entry => String(entry.name)));
  if (!wanted.size) return empty;
  // A translated label can collide after invalid characters/truncation have been
  // sanitised. Never associate the same file with two different achievement IDs.
  const owners = new Map();
  for (const item of schema) for (const name of labels(item?.displayName)) {
    const base = folded(sanitize(name));
    if (!owners.has(base)) owners.set(base, new Set());
    owners.get(base).add(String(item.name));
  }
  const found = { screenshot: new Map(), record: new Map() };
  for (const kind of ["screenshot", "record"]) for (const root of new Set(roots[kind].filter(Boolean))) {
    try {
      const actualRoot = await fs.realpath(root);
      for (const dir of await mediaDirectories(root, configName, getConfigNames)) {
        if (!inside(actualRoot, dir)) continue;
        for (const file of await fs.readdir(dir, { withFileTypes: true })) {
          if (!file.isFile() || file.isSymbolicLink()) continue;
          const parsed = path.parse(file.name), extension = kind === "screenshot" ? ".png" : ".mp4";
          if (parsed.ext.toLowerCase() !== extension) continue;
          const possibleOwners = new Set(owners.get(folded(parsed.name)) || []);
          const suffixed = /^(.*)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/.exec(parsed.name);
          if (suffixed && timestampSuffix(parsed.name, suffixed[1]) !== null) for (const id of owners.get(folded(suffixed[1])) || []) possibleOwners.add(id);
          if (possibleOwners.size !== 1) continue;
          const id = [...possibleOwners][0];
          if (!wanted.has(id)) continue;
          const full = path.join(dir, file.name), actual = await fs.realpath(full);
          if (!inside(dir, actual)) continue;
          const stat = await fs.stat(actual);
          if (!stat.isFile() || !stat.size || !await complete(actual, kind, stat.size)) continue;
          found[kind].set(folded(actual), { path: actual, filename: file.name, modifiedAt: stat.mtimeMs, size: stat.size,
            ...(all ? { achievementId: id } : {}) });
        }
      }
    } catch { /* A removed/offline media folder should not block other actions. */ }
  }
  return Object.fromEntries(Object.entries(found).map(([kind, files]) => [kind, [...files.values()].sort((a,b) => b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename))]));
}
const findAchievementMedia = options => scanAchievementMedia(options);
const findGameMedia = options => scanAchievementMedia(options, true);
module.exports = { findAchievementMedia, findGameMedia, timestampSuffix, complete };
