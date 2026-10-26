"use strict";

// Source-specific edits for selected IDs. Callers supply only resolved state
// files, never a game/library directory to recursively search or remove.
const crypto = require("crypto");
const ini = require("ini");
const TOML = require("smol-toml");
const data = require("./achievement-data");
const x360 = require("./x360-recomp-state");
const { createUplayNameResolver } = require("./uplay-achievement-identity");
const FLAG = /^(achieved|earned|unlock|unlocked|state)$/i;
const TIME = /^(unlock_?time|unlockedtime|timestamp|earned_?time|time)$/i;
const PROGRESS = /^(curprogress|cur_progress|progress)$/i;
function fail(message = "Unsupported achievement state format") { throw new Error(message); }
function textCodec(bytes) {
  const le = bytes[0] === 255 && bytes[1] === 254;
  const be = bytes[0] === 254 && bytes[1] === 255;
  const bom = le || be || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  const raw = be ? Buffer.from(bytes).swap16() : bytes;
  const text = new TextDecoder(le || be ? "utf-16le" : "utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/, "");
  return { text, encode(value) {
    const out = Buffer.from((bom ? "\uFEFF" : "") + value, le || be ? "utf16le" : "utf8");
    return be ? out.swap16() : out;
  } };
}
function resolver(schema, platform) {
  const exact = new Map(), display = new Map(), aliases = new Map();
  const normalized = value => String(value ?? "").normalize("NFKC").replace(/\u2026/g, "...").replace(/\s/g, " ").trim().toLowerCase();
  const add = (map, raw, name) => {
    const key = normalized(raw);
    if (!key) return;
    if (!map.has(key)) map.set(key, name); else if (map.get(key) !== name) map.set(key, null);
  };
  for (const entry of schema) {
    add(exact, entry.name, String(entry.name));
    if (!/^ach_/i.test(String(entry.name))) add(aliases, `ach_${entry.name}`, String(entry.name));
    for (const name of Object.values(typeof entry.displayName === "object" ? entry.displayName : { english: entry.displayName })) add(display, name, String(entry.name));
  }
  const uplay = platform === "uplay" ? createUplayNameResolver(schema) : () => null;
  return raw => {
    const key = normalized(raw);
    return exact.has(key) ? exact.get(key) : uplay(raw) || aliases.get(key) || display.get(key) || null;
  };
}
function zero(value, flag = false) {
  if (typeof value === "boolean") return false;
  if (typeof value === "number") return 0;
  if (typeof value === "string") {
    if (/^(true|false)$/i.test(value)) return "false";
    if (/^(yes|no)$/i.test(value)) return "no";
    if (flag && /^[0-9a-f]{8,}$/i.test(value)) return "0".repeat(value.length);
    return /^\d+$/.test(value) ? "0" : "";
  }
  fail();
}
function clearEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
  let flags = 0;
  for (const key of Object.keys(entry)) {
    if (FLAG.test(key)) { entry[key] = zero(entry[key], true); flags++; }
    else if (TIME.test(key) || PROGRESS.test(key)) entry[key] = zero(entry[key]);
  }
  if (!flags && !Object.keys(entry).some(key => TIME.test(key))) fail();
}
// Keep large numeric timestamps/unknown metadata lossless when serializing JSON.
function jsonCodec(text) {
  const stack = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0], top = stack.at(-1);
    if (token === "{" || token === "[") stack.push({ object: token === "{", expectingKey: token === "{", keys: new Set() });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && top?.object) top.expectingKey = true;
    else if (token[0] === '"' && top?.object && top.expectingKey) {
      const name = JSON.parse(token);
      if (top.keys.has(name)) fail("Duplicate JSON field");
      top.keys.add(name); top.expectingKey = false;
    }
  }
  const raw = new Map(), prefix = `__achievement_number_${crypto.randomUUID()}_`;
  const doc = JSON.parse(text, (_key, value, context) => {
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value))) {
      if (!context?.source) fail("Lossless JSON parsing unavailable");
      const marker = prefix + raw.size; raw.set(marker, context.source); return marker;
    }
    return value;
  });
  return { doc, encode: () => {
    let result = JSON.stringify(doc, null, 2);
    for (const [marker, number] of raw) result = result.replaceAll(JSON.stringify(marker), number);
    return result + "\n";
  } };
}
function json(bytes, ctx) {
  const codec = textCodec(bytes), parsed = jsonCodec(codec.text), doc = parsed.doc;
  if (!doc || typeof doc !== "object") fail();
  const matched = new Set();
  if (ctx.kind === "kyty-json") {
    if (!Array.isArray(doc.unlockedTrophies) || !doc.unlockedTrophies.every(id => Number.isSafeInteger(id) && id >= 0) ||
        new Set(doc.unlockedTrophies).size !== doc.unlockedTrophies.length) fail();
    doc.unlockedTrophies = doc.unlockedTrophies.filter(id => !ctx.ids.has(String(id)));
    if (doc.unlockedAt && (typeof doc.unlockedAt !== "object" || Array.isArray(doc.unlockedAt))) fail();
    for (const id of ctx.ids) { matched.add(id); if (doc.unlockedAt) delete doc.unlockedAt[id]; }
  } else {
    const collection = ctx.kind === "x360-json" ? doc.achievements : doc;
    if (!collection || typeof collection !== "object") fail();
    for (const [key, entry] of Object.entries(collection)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = ctx.kind === "x360-json" ? x360.achievementId(entry.id) : Array.isArray(collection) ? entry.name ?? entry.Name ?? entry.id ?? entry.AchievementId ?? entry.achievementId : key;
      const id = ctx.resolve(raw);
      if (!id || !ctx.ids.has(id)) continue;
      clearEntry(entry); matched.add(id);
    }
    if (ctx.kind === "x360-json") {
      // Validation also checks title identity and the complete definitions.
      const entries = doc.achievements;
      if (!Array.isArray(entries) || entries.some(e => typeof e.unlocked !== "boolean")) fail();
    }
  }
  return { bytes: codec.encode(parsed.encode()), matched };
}
function iniState(bytes, ctx) {
  const codec = textCodec(bytes), lines = codec.text.split(/(?<=\n)/), matched = new Set();
  let section = "", target = "", fields = 0;
  // Parsing first prevents edits to a partial INI from looking successful.
  const parsed = ini.parse(codec.text);
  if (!parsed || !Object.keys(parsed).length) fail();
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n], header = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?(?:\r?\n)?$/.exec(line);
    if (header) { section = header[1]; target = ctx.resolve(section); continue; }
    if (/^\s*[;#]/.test(line)) continue;
    if (/^achievements$/i.test(section)) {
      const row = /^(\s*"([^"]+)"\s*=\s*\{)([^\r\n]*)(\}[^\r\n]*)(\r?\n)?$/.exec(line);
      const id = row && ctx.resolve(row[2]);
      if (id && ctx.ids.has(id)) {
        let count = 0;
        const next = row[3].replace(/\b(Unlocked|Time|Progress|Value)\s*=\s*([^,}]+)/gi, (all, key, value) => {
          count++; return `${key}=${/^unlocked$/i.test(key) ? "false" : "0"}`;
        });
        if (!count || !/\bUnlocked\s*=/i.test(row[3])) fail();
        lines[n] = row[1] + next + row[4] + (row[5] || ""); matched.add(id); fields++;
      }
      continue;
    }
    if (!target || !ctx.ids.has(target)) continue;
    const kv = /^(\s*([^=\s]+)\s*=\s*)([^\r\n]*)(\r?\n)?$/.exec(line);
    if (!kv || !(FLAG.test(kv[2]) || TIME.test(kv[2]) || PROGRESS.test(kv[2]))) continue;
    const tail = /^(.*?)(\s+[;#].*)?$/.exec(kv[3]), value = tail[1].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value), old = quoted ? quoted[2] : value;
    const next = /^(true|false)$/i.test(old) ? "false" : /^(yes|no)$/i.test(old) ? "no" : /^[0-9a-f]{8,}$/i.test(old) ? "0".repeat(old.length) : "0";
    lines[n] = kv[1] + (quoted ? quoted[1] + next + quoted[1] : next) + (tail[2] || "") + (kv[4] || "");
    matched.add(target); fields++;
  }
  if (!fields) return { bytes, matched };
  const output = lines.join("");
  ini.parse(output);
  return { bytes: codec.encode(output), matched };
}
function rune(bytes, ctx) {
  const codec = textCodec(bytes), doc = data.parseRuneKeyValuesText(codec.text, { rejectDuplicates: true }), entries = doc.achievements, matched = new Set();
  if (!entries || typeof entries !== "object") fail();
  for (const [key, entry] of Object.entries(entries)) {
    const id = ctx.resolve(key);
    if (id && ctx.ids.has(id)) { clearEntry(entry); matched.add(id); }
  }
  const serialize = (object, level = 0) => Object.entries(object).map(([key, value]) => {
    const pad = "  ".repeat(level), quoted = JSON.stringify(key);
    return value && typeof value === "object" ? `${pad}${quoted}\n${pad}{\n${serialize(value, level + 1)}${pad}}\n` : `${pad}${quoted} ${JSON.stringify(String(value))}\n`;
  }).join("");
  return { bytes: codec.encode(serialize(doc)), matched };
}
function xml(bytes, ctx) {
  const codec = textCodec(bytes), seen = new Set(), matched = new Set();
  if (!/<\/(?:trophyconf|trophyset)>\s*$/i.test(codec.text) ||
      (codec.text.match(/<trophy\b[^>]*[^/]>/gi) || []).length !== (codec.text.match(/<\/trophy\s*>/gi) || []).length) fail();
  const result = codec.text.replace(/<trophy\b[^>]*>/gi, tag => {
    const attr = /\bid\s*=\s*(["'])(\d+)\1/i.exec(tag);
    if (!attr) fail();
    const id = String(Number(attr[2])); if (seen.has(id)) fail(); seen.add(id);
    if (!ctx.ids.has(id)) return tag;
    if (!/\b(?:unlockstate|unlocked)\s*=/i.test(tag)) fail();
    matched.add(id);
    return tag.replace(/\b(unlockstate|unlocked|timestamp)\s*=\s*(["'])(.*?)\2/gi, (_, key, quote) =>
      `${key}=${quote}${key.toLowerCase() === "unlocked" ? "no" : key.toLowerCase() === "timestamp" ? "0" : "false"}${quote}`);
  });
  if (!seen.size || !/<(?:trophyconf|trophyset)\b/i.test(codec.text)) fail();
  // Cheerio is the same XML parser used by the read path.
  require("cheerio").load(result, { xmlMode: true });
  return { bytes: codec.encode(result), matched };
}
function gpd(bytes, ctx) {
  const reader = require("./xenia-gpd"), entries = reader.parseXdbfEntries(bytes), output = Buffer.from(bytes), matched = new Set();
  const parsed = reader.parseGpdFile("state.gpd", bytes), valid = reader.getValidAchievements(parsed);
  if (!valid.length || valid.length !== parsed.achievements.length || entries.length !==
      bytes[entries.__endian === "be" ? "readUInt32BE" : "readUInt32LE"](12)) fail();
  const allowed = new Set(valid.map(a => String(a.achievementId))), be = entries.__endian === "be";
  for (const entry of entries) {
    const id = String(entry.id);
    if (entry.namespace !== 1 || !allowed.has(id) || !ctx.ids.has(id)) continue;
    if (matched.has(id) || entry.length < 0x1c) fail();
    const pos = entry.offset, read = be ? "readUInt32BE" : "readUInt32LE", write = be ? "writeUInt32BE" : "writeUInt32LE";
    output[write]((output[read](pos + 0x10) & ~0x20000) >>> 0, pos + 0x10);
    output.fill(0, pos + 0x14, pos + 0x1c); matched.add(id);
  }
  reader.parseGpdFile("state.gpd", output);
  return { bytes: output, matched };
}
function rpcs3(bytes, ctx) {
  if (bytes.length < 0x30 || bytes.readUInt32BE(0) !== 0x818f54ad) fail();
  const tables = bytes.readUInt32BE(8), output = Buffer.from(bytes), matched = new Set();
  if (!tables || tables > 32 || 0x30 + tables * 0x20 > bytes.length) fail();
  let found = 0;
  for (let n = 0; n < tables; n++) {
    const at = 0x30 + n * 0x20;
    if (bytes.readUInt32BE(at) !== 6) continue;
    if (++found !== 1 || bytes.readUInt32BE(at + 4) !== 0x60) fail();
    const count = bytes.readUInt32BE(at + 12), offset = Number(bytes.readBigUInt64BE(at + 16)), seen = new Set();
    if (!count || count > 5000 || offset < 0x30 + tables * 0x20 || offset + count * 0x70 > bytes.length) fail();
    for (let i = 0; i < count; i++) {
      const pos = offset + i * 0x70, id = String(bytes.readUInt32BE(pos + 0x10));
      if (bytes.readUInt32BE(pos) !== 6 || bytes.readUInt32BE(pos + 4) !== 0x60 || bytes.readUInt32BE(pos + 0x14) > 1 || seen.has(id)) fail();
      seen.add(id);
      if (!ctx.ids.has(id)) continue;
      output.writeUInt32BE(0, pos + 0x14); output.fill(0, pos + 0x20, pos + 0x30); matched.add(id);
    }
  }
  if (!found) fail();
  require("./rpcs3-trophy").parseTropusrDatAuto(output);
  return { bytes: output, matched };
}
function statsBin(bytes, ctx) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) > 100000 || bytes.length !== 4 + bytes.readUInt32LE(0) * 24) fail();
  const map = data.buildCrcNameMap(ctx.schema), output = Buffer.from(bytes), matched = new Set(), seen = new Set();
  for (let pos = 4; pos < bytes.length; pos += 24) {
    const crc = bytes.readUInt32LE(pos).toString(16).padStart(8, "0"), id = map[crc]?.name;
    if (seen.has(crc)) fail(); seen.add(crc);
    if (!ctx.ids.has(id)) continue;
    if (bytes.readUInt32LE(pos + 20) > 1) fail();
    output.writeUInt32LE(0, pos + 8); output.writeUInt32LE(0, pos + 20); matched.add(id);
  }
  return { bytes: output, matched };
}
function recomp(bytes, ctx) {
  const codec = ctx.kind === "unleashed" ? null : textCodec(bytes), matched = new Set(ctx.ids);
  if (ctx.kind === "x360-json") return json(bytes, ctx);
  if (ctx.kind === "ini-earned" || ctx.kind === "tsv") {
    const lines = codec.text.split(/(?<=\n)/);
    const result = lines.filter((line, index) => {
      if (ctx.kind === "tsv" && index === 0) return true;
      const match = /^\s*(\d+)\s*(?:=|\t)/.exec(line);
      return !match || !ctx.ids.has(String(Number(match[1])));
    }).join("");
    return { bytes: codec.encode(result), matched };
  }
  if (ctx.kind === "toml") {
    const doc = TOML.parse(codec.text, { integersAsBigInt: true, unsafeKeyBehaviour: "throw" });
    if (Array.isArray(doc.unlocked)) doc.unlocked = doc.unlocked.filter(id => !ctx.ids.has(String(id)));
    else if (doc.unlocked && typeof doc.unlocked === "object") {
      for (const raw of Object.keys(doc.unlocked)) if (ctx.ids.has(x360.achievementId(raw))) delete doc.unlocked[raw];
    }
    else if (!/Achievement unlock state.*ReXGlue/i.test(codec.text)) fail();
    return { bytes: codec.encode("# Achievement unlock state - ReXGlue\n" + TOML.stringify(doc)), matched };
  }
  if (ctx.kind === "unleashed") {
    require("./x360-recomp-extra-state").readExtraSnapshot(bytes, { format: "unleashed" }, ctx.config.appid, {});
    const output = Buffer.from(bytes), records = [];
    for (let pos = 16; pos < bytes.length; pos += 16) if (bytes.readUInt16LE(pos) && !ctx.ids.has(String(bytes.readUInt16LE(pos)))) records.push(bytes.subarray(pos, pos + 16));
    output.fill(0, 16); records.forEach((record, i) => record.copy(output, 16 + i * 16));
    let checksum = 0; for (let i = 16; i < output.length; i++) checksum ^= output[i]; output.writeUInt32LE(checksum, 8);
    require("./x360-recomp-extra-state").readExtraSnapshot(output, { format: "unleashed" }, ctx.config.appid, {});
    return { bytes: output, matched };
  }
  fail();
}
function edit(bytes, context) {
  const ctx = { ...context, ids: new Set(context.ids), resolve: resolver(context.schema, context.config.platform) };
  if (ctx.kind === "json" || ctx.kind === "kyty-json") return json(bytes, ctx);
  if (ctx.kind === "ini") return iniState(bytes, ctx);
  if (ctx.kind === "rune") return rune(bytes, ctx);
  if (ctx.kind === "xml") return xml(bytes, ctx);
  if (ctx.kind === "gpd") return gpd(bytes, ctx);
  if (ctx.kind === "rpcs3") return rpcs3(bytes, ctx);
  if (ctx.kind === "stats-bin") return statsBin(bytes, ctx);
  return recomp(bytes, ctx);
}
module.exports = { edit, textCodec, resolver, jsonCodec };
