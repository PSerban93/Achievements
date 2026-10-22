"use strict";

// Read metadata only. Never execute scripts supplied by a port or a game dump.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const collections = require("./ps4-recomp-collections");
// Main installs its File compatibility shim before importing web/XML parsers.
// Keep this lazy because the platform module is registered early at startup.
const cheerio = { load: (...args) => require("cheerio").load(...args) };
const crc32 = require("crc-32");
// Public PS4 retail trophy key documented with the ESFM format:
// https://www.psdevwiki.com/ps4/Trophy00.trp#Entries
// A local trophy.key can override this value for other key sets.
const PUBLIC_RETAIL_TROPHY_KEY = "21F41A6BAD8A1D3ECA7AD586C101B7A9";
const GRADES = { p: "platinum", g: "gold", s: "silver", b: "bronze" };
const LANG = { "00": "japanese", "01": "english", "02": "french", "03": "spanish", "04": "german",
  "05": "italian", "06": "dutch", "07": "portuguese", "08": "russian", "09": "koreana",
  "10": "tchinese", "11": "schinese", "12": "finnish", "13": "swedish", "14": "danish", "15": "norwegian",
  "16": "polish", "17": "brazilian", "18": "english", "19": "turkish", "20": "latam", "21": "arabic",
  "22": "french", "23": "czech", "24": "hungarian", "25": "greek", "26": "romanian", "27": "thai",
  "28": "vietnamese", "29": "indonesian", "30": "ukrainian" };
function bounded(file, max = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`Invalid trophy metadata: ${file}`);
  return fs.readFileSync(file);
}
function tsvMetadata(file) {
  if (!file) return null;
  try {
    const entries = [], seen = new Set();
    let title = "", language = "english";
    const lines = bounded(file, 4 * 1024 * 1024).toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = line.split("\t");
      if (fields[0].startsWith("#")) {
        if (fields[0] === "#title") title = (fields[1] || "").trim();
        if (fields[0] === "#lang") language = LANG[String(fields[1]).padStart(2, "0")] || "english";
        continue;
      }
      if (fields.length !== 5 || !/^\d{1,4}$/.test(fields[0]) || !GRADES[fields[1].toLowerCase()] ||
          !/^[01]$/.test(fields[2]) || !fields[3].trim()) return null;
      const id = String(Number(fields[0]));
      if (seen.has(id)) return null;
      seen.add(id);
      entries.push({ name: id, trophyType: GRADES[fields[1].toLowerCase()], hidden: Number(fields[2]),
        text: fields[3].trim(), detail: fields[4].trim() });
    }
    if (!entries.length) return null;
    return { title, entries: entries.sort((a, b) => Number(a.name) - Number(b.name)).map(({ text, detail, ...entry }) => ({
      ...entry, rarity: entry.trophyType, displayName: { [language]: text, english: text },
      description: { [language]: detail, english: detail },
    })) };
  } catch { return null; } // Missing/invalid exports fall back to the native trophy files.
}
function xmlEntries(documents) {
  const entries = new Map();
  // Prefer US English when both US and UK exist; UK fills missing translations.
  documents.sort((a, b) => /_01\./i.test(b.name) - /_01\./i.test(a.name));
  for (const document of documents) {
    const lang = LANG[document.name.match(/_(\d{2})\./)?.[1]] || "english";
    if (/<!DOCTYPE|<!ENTITY/i.test(document.text)) throw new Error("Unsupported trophy XML entities");
    const $ = cheerio.load(document.text, { xmlMode: true });
    if (!$("trophyconf").length) continue;
    const seen = new Set();
    $("trophyconf > trophy").each((_, element) => {
      const node = $(element), id = node.attr("id"), grade = GRADES[node.attr("ttype")?.toLowerCase()];
      if (!/^\d{1,4}$/.test(id || "") || !grade) throw new Error("Invalid native trophy ID or grade");
      const key = String(Number(id));
      if (seen.has(key)) throw new Error(`Duplicate native trophy ID: ${key}`);
      seen.add(key);
      const pid = node.attr("pid") ?? "-1";
      if (!/^(?:-1|\d{1,4})$/.test(pid)) throw new Error("Invalid native Platinum ID");
      const entry = entries.get(key) || { name: key, trophyType: grade, rarity: grade, hidden: 0, displayName: {}, description: {},
        ps4_recomp_platinum_id: String(Number(pid)) };
      if (entry.trophyType !== grade) throw new Error(`Conflicting trophy grade: ${key}`);
      entry.hidden ||= node.attr("hidden") === "yes" ? 1 : 0;
      entry.displayName[lang] ||= node.children("name").text().trim();
      entry.description[lang] ||= node.children("detail").text().trim();
      entries.set(key, entry);
    });
  }
  const result = [...entries.values()].sort((a, b) => Number(a.name) - Number(b.name));
  if (!result.length || result.some((entry) => !Object.values(entry.displayName).some(Boolean))) throw new Error("No valid trophy metadata found");
  for (const entry of result) {
    entry.displayName.english ||= Object.values(entry.displayName).find(Boolean);
    entry.description.english ||= Object.values(entry.description).find(Boolean) || "";
  }
  return result;
}
function addIcon(icons, name, bytes) {
  const match = /^TROP(\d{3,4})\.PNG$/i.exec(name);
  if (!match) return;
  // Bound dimensions as well as file size before passing images to the UI.
  if (bytes.length < 33 || bytes.length > 4 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) ||
      bytes.readUInt32BE(16) > 2048 || bytes.readUInt32BE(20) > 2048) throw new Error(`Invalid trophy PNG: ${name}`);
  const id = String(Number(match[1]));
  if (icons.has(id)) throw new Error(`Duplicate trophy icon: ${id}`);
  icons.set(id, Buffer.from(bytes));
}
function trpContents(file, npcommid, key, readDocuments = true) {
  const bytes = bounded(file, 128 * 1024 * 1024);
  if (bytes.length < 96 || bytes.readUInt32BE(0) !== 0xdca24d00) throw new Error("Invalid TRP header");
  const count = bytes.readUInt32BE(16), stride = bytes.readUInt32BE(20);
  if (count > 4096 || stride < 64 || stride > 4096 || 96 + count * stride > bytes.length) throw new Error("Invalid TRP directory");
  const documents = [], icons = new Map();
  for (let index = 0; index < count; index++) {
    const at = 96 + index * stride, name = bytes.subarray(at, at + 32).toString("ascii").split("\0")[0];
    const isIcon = /^TROP\d{3,4}\.PNG$/i.test(name);
    if (!isIcon && (!readDocuments || !/^TROP(?:_\d{2})?\.(?:XML|SFM|ESFM)$/i.test(name))) continue;
    const offset = Number(bytes.readBigUInt64BE(at + 32)), size = Number(bytes.readBigUInt64BE(at + 40));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size > 4 * 1024 * 1024 || offset < 0 || size < 0 || offset + size > bytes.length) throw new Error("Invalid TRP entry");
    let text = bytes.subarray(offset, offset + size);
    if (isIcon) { addIcon(icons, name, text); continue; }
    if (/\.ESFM$/i.test(name)) {
      if (!/^[a-f0-9]{32}$/i.test(key || "") || !/^NPWR\d{5}_\d{2}$/.test(npcommid || "")) continue;
      if (text.length < 32 || text.length % 16) throw new Error("Invalid encrypted trophy metadata");
      const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "hex"), Buffer.alloc(16));
      cipher.setAutoPadding(false);
      const identity = Buffer.alloc(16); identity.write(npcommid, "ascii");
      const derived = Buffer.concat([cipher.update(identity), cipher.final()]);
      const decipher = crypto.createDecipheriv("aes-128-cbc", derived, text.subarray(0, 16));
      decipher.setAutoPadding(false);
      text = Buffer.concat([decipher.update(text.subarray(16)), decipher.final()]);
    }
    const raw = text.toString("utf8");
    const xml = raw.slice(0, raw.lastIndexOf(">") + 1);
    if (/\.ESFM$/i.test(name) && (!/<trophyconf\b/.test(xml) || !/<\/trophyconf\s*>/.test(xml))) {
      throw new Error("Unable to decrypt trophy metadata: check the trophy key and NP binding");
    }
    documents.push({ name, text: xml });
  }
  return { documents, icons };
}
function npBindings(file) {
  const bytes = bounded(file), result = new Map();
  if (bytes.length < 128 || bytes.readUInt32BE(0) !== 0xd294a018) throw new Error("Invalid NP binding file");
  const count = Number(bytes.readBigUInt64BE(24));
  if (!Number.isSafeInteger(count) || count > 100) throw new Error("Invalid NP binding count");
  let at = 128;
  for (let i = 0; i < count; i++) {
    let id = "", label = "";
    for (let field = 0; field < 4; field++) {
      if (at + 4 > bytes.length) throw new Error("Truncated NP binding");
      const type = bytes.readUInt16BE(at), size = bytes.readUInt16BE(at + 2); at += 4;
      if (at + size > bytes.length) throw new Error("Truncated NP binding value");
      if (type === 0x10) id = bytes.subarray(at, at + size).toString("ascii").replace(/\0/g, "");
      if (type === 0x11) label = bytes.subarray(at, at + size).toString("ascii").replace(/\0/g, "").trim();
      at += size;
    }
    if (!/^NPWR\d{5}_\d{2}$/.test(id) || !/^\d{1,2}$/.test(label)) {
      throw new Error("Invalid NP binding trophy identity");
    }
    const slot = Number(label);
    if (result.has(slot)) throw new Error("Duplicate NP binding trophy label");
    // Labels identify trophyNN.trp; record positions need not start at trophy00.
    result.set(slot, id); at += 152;
  }
  return result;
}
function nativeSet(gameRoot, installRoot = gameRoot) {
  const slots = new Set();
  for (const directory of [path.join(gameRoot, "sce_sys", "trophy"), path.join(installRoot, "TrophyFiles")]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const match = /^trophy(\d{2})(?:\.trp)?$/i.exec(name);
      if (match) slots.add(Number(match[1]));
    }
  }
  if (!slots.size) return null;
  if (slots.size !== 1) throw new Error("Multiple PS4 trophy sets found; automatic single-game import requires one set (Uncharted uses its collection adapter)");
  const trophySet = [...slots][0], bindFile = path.join(gameRoot, "sce_sys", "npbind.dat");
  return { trophySet, npcommid: fs.existsSync(bindFile) ? npBindings(bindFile).get(trophySet) || "" : "" };
}
async function metadata(game) {
  const exported = !collections.collection(game.port) ? tsvMetadata(game.metadataFile) : null;
  const trophyRoot = path.join(game.gameRoot || game.installRoot, "sce_sys", "trophy");
  if (collections.collection(game.port) && !game.metadataSetVerified) {
    // Collection set order can differ between regions. Resolve by the XML's
    // title, never by an assumed trophy00/u1, trophy01/u2 ordering.
    const expected = collections.expectedTitle(game.port, game.game);
    if (!expected) throw new Error("Unknown PS4 Recomp collection game");
    const exportRoot = path.join(game.installRoot, "TrophyFiles");
    const slots = new Set();
    for (const directory of [trophyRoot, exportRoot]) if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory)) {
        const match = /^trophy(\d{2})(?:\.trp)?$/i.exec(name);
        if (match) slots.add(Number(match[1]));
      }
    }
    let lastError;
    for (const trophySet of [...slots].sort((a, b) => a - b)) {
      try { return await metadata({ ...game, trophySet, metadataSetVerified: true, expectedTitle: expected }); }
      catch (error) { if (error.code !== "PS4_RECOMP_WRONG_SET") lastError = error; }
    }
    if (lastError) throw lastError;
    throw new Error(`No native trophy metadata for ${game.title}; select the original dump in the port's launcher and rescan`);
  }
  const slot = String(game.trophySet).padStart(2, "0"), documents = [], icons = new Map();
  // Explicit per-set export, preserving collection separation and native IDs.
  for (const directory of [path.join(trophyRoot, `trophy${slot}`, "Xml"), path.join(game.installRoot, "TrophyFiles", `trophy${slot}`, "Xml")]) {
    if (!fs.existsSync(directory)) continue;
    // Keep metadata and exported images from the same per-set source.
    const names = fs.readdirSync(directory).filter((name) => /^TROP(?:_\d{2})?\.(?:XML|SFM)$/i.test(name));
    if (!names.length) continue;
    for (const name of names) documents.push({ name, text: bounded(path.join(directory, name)).toString("utf8") });
    const iconDirectory = path.join(directory, "..", "Icons");
    if (fs.existsSync(iconDirectory)) for (const name of fs.readdirSync(iconDirectory)) {
      if (/^TROP\d{3,4}\.PNG$/i.test(name)) addIcon(icons, name, bounded(path.join(iconDirectory, name), 4 * 1024 * 1024));
    }
    break;
  }
  if (fs.existsSync(trophyRoot)) {
    const names = fs.readdirSync(trophyRoot), trp = names.find((name) => name.toLowerCase() === `trophy${slot}.trp`);
    if (trp) {
      const bindFile = path.join(game.gameRoot || game.installRoot, "sce_sys", "npbind.dat");
      const bindings = !exported && !documents.length && fs.existsSync(bindFile) ? npBindings(bindFile) : new Map();
      const keyFile = path.join(game.installRoot, "trophy.key");
      const key = !exported && !documents.length && fs.existsSync(keyFile) ? bounded(keyFile, 256).toString("utf8").trim() : PUBLIC_RETAIL_TROPHY_KEY;
      if (!/^[a-f0-9]{32}$/i.test(key)) throw new Error("Invalid local trophy.key: expected 32 hexadecimal characters");
      const contents = trpContents(path.join(trophyRoot, trp), bindings.get(Number(game.trophySet)), key, !exported && !documents.length);
      documents.push(...contents.documents);
      for (const [id, bytes] of contents.icons) if (!icons.has(id)) icons.set(id, bytes);
    }
  }
  if (exported) return { ...exported, icons, trophySet: game.trophySet };
  if (!documents.length) throw new Error(`PS4 Recomp metadata missing for ${game.title}: provide the original game's trophy data and matching npbind.dat, or decrypted TrophyFiles/trophy${slot}/Xml`);
  if (game.expectedTitle && !documents.some((document) => {
    const $ = cheerio.load(document.text, { xmlMode: true });
    return game.expectedTitle.test($("title-name").text().replace(/[™®]/g, ""));
  })) {
    const error = new Error("The trophy set belongs to a different collection game");
    error.code = "PS4_RECOMP_WRONG_SET"; throw error;
  }
  const entries = xmlEntries(documents);
  // xmlEntries orders US English first, with other languages as fallbacks.
  let title = "";
  for (const document of documents) {
    const $ = cheerio.load(document.text, { xmlMode: true });
    title = $("trophyconf > title-name").first().text().trim();
    if (title) break;
  }
  const bind = path.join(game.gameRoot || game.installRoot, "sce_sys", "npbind.dat");
  return { entries, icons, title, trophySet: game.trophySet,
    npcommid: fs.existsSync(bind) ? npBindings(bind).get(Number(game.trophySet)) || "" : "" };
}
function trophyPng(grade, locked = false) {
  // Generic cup, equivalent to the port's launcher icon; no external icon source.
  const rgb = { platinum: [196,204,216], gold: [200,169,106], silver: [173,177,183], bronze: [176,119,79] }[grade] || [173,177,183];
  const size = 96, data = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, bowl = v >= .25 && v <= .55 && Math.abs(u - .5) <= .17 - Math.max(0, v - .4) * .53;
    const handles = v >= .27 && v <= .47 && ((u >= .24 && u <= .38) || (u >= .62 && u <= .76)) &&
      (v <= .30 || v >= .44 || u <= .27 || u >= .73);
    const stem = v >= .53 && v <= .66 && Math.abs(u - .5) < .032;
    const base = v >= .65 && v <= .70 && Math.abs(u - .5) < .11 || v >= .71 && v <= .76 && Math.abs(u - .5) < .15;
    if (!(bowl || handles || stem || base)) continue;
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    data.set(locked ? [90,90,90,255] : [...rgb,255], offset);
  }
  const chunk = (name, bytes) => { const tag = Buffer.from(name), result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length, 0); tag.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32.buf(Buffer.concat([tag, bytes])) >>> 0, bytes.length + 8); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(data)), chunk("IEND", Buffer.alloc(0))]);
}
module.exports = { metadata, nativeSet, trophyPng, tsvMetadata };
