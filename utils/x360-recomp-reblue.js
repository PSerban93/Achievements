"use strict";

// Read-only extraction of re:Blue's compiled custom achievement definitions.
// This is not a CPU emulator: only the constant moves in a validated x64
// initializer are reconstructed. Calls/jumps are never executed or followed.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const VERSION = 1;
const MAX_EXE = 128 * 1024 * 1024;
const MAX_ICON = 1024 * 1024;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw Object.assign(new Error(message), { code: "REBLUE_METADATA" }); };
const cancelled = (options) => {
  if (options.isCancelled?.()) throw Object.assign(new Error("Recomp generation cancelled"), { code: "XEX_CANCELLED" });
};

function parsePe(bytes) {
  const range = (at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at + size > bytes.length) fail("Truncated PE metadata");
    return bytes.subarray(at, at + size);
  };
  if (bytes.length < 64 || bytes.length > MAX_EXE || bytes.toString("ascii", 0, 2) !== "MZ") fail("Invalid re:Blue executable");
  const pe = bytes.readUInt32LE(60);
  range(pe, 24);
  if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 22) & 0x2000) fail("Unsupported re:Blue PE architecture");
  const count = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20), opt = pe + 24;
  range(opt, optionalSize);
  if (count < 1 || count > 96 || optionalSize < 144 || bytes.readUInt16LE(opt) !== 0x20b) fail("Invalid PE section table");
  const base = Number(bytes.readBigUInt64LE(opt + 24));
  if (!Number.isSafeInteger(base) || base <= 0) fail("Invalid PE image base");
  const sections = [];
  for (let i = 0; i < count; i++) {
    const at = opt + optionalSize + i * 40;
    range(at, 40);
    const section = { name: bytes.toString("ascii", at, at + 8).replace(/\0.*$/, ""),
      va: bytes.readUInt32LE(at + 12), virtualSize: bytes.readUInt32LE(at + 8),
      size: bytes.readUInt32LE(at + 16), raw: bytes.readUInt32LE(at + 20), flags: bytes.readUInt32LE(at + 36) };
    range(section.raw, section.size);
    if (!section.virtualSize || section.va + Math.max(section.size, section.virtualSize) > 0xffffffff ||
        !Number.isSafeInteger(base + section.va + Math.max(section.size, section.virtualSize))) fail("Invalid PE section bounds");
    if (sections.some((other) => section.va < other.va + Math.max(other.size, other.virtualSize) &&
        other.va < section.va + Math.max(section.size, section.virtualSize))) fail("Overlapping PE sections");
    sections.push(section);
  }
  const sectionAt = (va, size = 1) => sections.find((s) => va >= base + s.va && va + size <= base + s.va + Math.max(s.size, s.virtualSize));
  const read = (va, size) => {
    const s = sectionAt(va, size), offset = s && va - base - s.va;
    if (!s || offset + size > s.size) fail("PE reference has no file-backed data");
    return range(s.raw + offset, size);
  };
  const pointer = (at) => {
    const value = Number(bytes.readBigUInt64LE(at));
    if (!Number.isSafeInteger(value)) fail("Invalid PE pointer");
    return value;
  };
  // Exception directory supplies actual function boundaries; byte signatures
  // alone are never accepted as a decoded initializer.
  const exceptionRva = bytes.readUInt32LE(opt + 112 + 3 * 8), exceptionSize = bytes.readUInt32LE(opt + 116 + 3 * 8);
  if (!exceptionRva || exceptionSize < 12 || exceptionSize > 8 * 1024 * 1024 || exceptionSize % 12) fail("Missing x64 function boundaries");
  const functions = read(base + exceptionRva, exceptionSize);
  let version = "";
  const resources = sections.find((s) => s.name === ".rsrc");
  if (resources) {
    const block = range(resources.raw, resources.size), marker = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
    const at = block.indexOf(marker);
    if (at >= 0 && at + 52 <= block.length && block.indexOf(marker, at + 1) < 0 && block.readUInt32LE(at + 4) === 0x10000) {
      const ms = block.readUInt32LE(at + 8), ls = block.readUInt32LE(at + 12);
      if ((ls & 0xffff) === 0) version = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}`;
    }
  }
  return { bytes, base, sections, read, pointer, sectionAt, functions, version };
}

function png(bytes) {
  if (bytes.length < 45 || bytes.length > MAX_ICON || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) fail("Invalid embedded PNG");
  let at = 8, first = true, data = false;
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.toString("ascii", at + 4, at + 8);
    if (size > MAX_ICON || at + size + 12 > bytes.length) fail("Truncated embedded PNG");
    if (first) {
      if (type !== "IHDR" || size !== 13 || !bytes.readUInt32BE(at + 8) || !bytes.readUInt32BE(at + 12) ||
          bytes.readUInt32BE(at + 8) > 1024 || bytes.readUInt32BE(at + 12) > 1024) fail("Invalid embedded icon dimensions");
      first = false;
    }
    let crc = 0xffffffff;
    for (let p = at + 4; p < at + 8 + size; p++) {
      crc ^= bytes[p];
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(at + 8 + size)) fail("Embedded icon CRC mismatch");
    if (type === "IDAT") data = true;
    at += size + 12;
    if (type === "IEND") {
      if (size || !data || at !== bytes.length) fail("Invalid embedded PNG ending");
      return bytes;
    }
  }
  fail("Missing embedded PNG ending");
}

function embeddedIcons(pe) {
  const icons = new Map();
  for (const s of pe.sections.filter((s) => !(s.flags & 0x20000000) && !(s.flags & 0x80000000))) {
    for (let at = s.raw; at + 32 <= s.raw + s.size; at += 8) {
      const length = Number(pe.bytes.readBigUInt64LE(at + 8));
      if (length < 23 || length > 26) continue;
      let recognized = false;
      try {
        const name = pe.read(pe.pointer(at), length).toString("ascii"), match = /^achievements\/0x([a-f0-9]{5})\.png$/i.exec(name);
        if (!match) continue;
        recognized = true;
        const id = parseInt(match[1], 16), size = Number(pe.bytes.readBigUInt64LE(at + 24));
        if (id <= 0x10000 || id > 0x1ffff || size < 45 || size > MAX_ICON) fail("Invalid custom icon entry");
        const bytes = png(pe.read(pe.pointer(at + 16), size));
        const previous = icons.get(id);
        if (previous && !previous.equals(bytes)) fail("Conflicting custom icon tables");
        icons.set(id, bytes);
      } catch (error) {
        // Random data may look like a string_view. A recognized asset name,
        // however, must never silently lose a damaged icon.
        if (recognized) throw error;
      }
    }
  }
  if (!icons.size || icons.size > 64) fail("No supported re:Blue embedded achievement icons");
  return icons;
}

function reconstruct(pe, start, end, expectedIds) {
  const code = pe.read(pe.base + start, end - start), regs = new Map(), vectors = new Map(), memory = new Map(), ids = new Map();
  const heapBase = 0x10000000000, heaps = [];
  let allocationTarget, stop = false;
  const read = (address, size) => {
    if (!Number.isSafeInteger(address)) fail("Unknown initializer address");
    if (Array.from({ length: size }, (_, i) => memory.has(address + i)).every(Boolean)) {
      return Buffer.from(Array.from({ length: size }, (_, i) => memory.get(address + i)));
    }
    return pe.read(address, size);
  };
  const write = (address, value) => {
    if (!Number.isSafeInteger(address) || !Buffer.isBuffer(value)) fail("Unknown initializer value");
    const s = pe.sectionAt(address, value.length), heap = heaps.find((h) => address >= h.at && address + value.length <= h.at + h.size);
    if (!heap && !(s?.flags & 0x80000000)) fail("Initializer write outside its data section");
    if (memory.size > 65536) fail("Oversized initializer data");
    for (let i = 0; i < value.length; i++) memory.set(address + i, value[i]);
  };
  const number = (buffer) => {
    if (!buffer) fail("Uninitialized register");
    const value = buffer.length === 8 ? Number(buffer.readBigUInt64LE()) : buffer.readUIntLE(0, buffer.length);
    if (!Number.isSafeInteger(value)) fail("Invalid initializer pointer/size");
    return value;
  };
  const encode = (value, size) => {
    const b = Buffer.alloc(size);
    if (size === 8) b.writeBigUInt64LE(BigInt(value)); else b.writeUIntLE(value, 0, size);
    return b;
  };
  const setReg = (index, value, size) => {
    // A 32-bit move clears the high half of the x64 register.
    const next = Buffer.alloc(8); value.copy(next, 0, 0, size); regs.set(index, next);
  };
  for (let at = 0; at < code.length && !stop;) {
    const begin = at;
    let prefix = 0, rex = 0;
    if (code[at] === 0x66) { prefix = 0x66; at++; }
    if (code[at] >= 0x40 && code[at] <= 0x4f) rex = code[at++];
    const op = code[at++], width = rex & 8 ? 8 : prefix ? 2 : 4;
    const need = (size) => { if (at + size > code.length) fail("Truncated initializer instruction"); };
    if (op >= 0x50 && op <= 0x5f) continue; // Stack save/restore; no data writes.
    if (op >= 0xb8 && op <= 0xbf) {
      need(width); setReg((op - 0xb8) + (rex & 1 ? 8 : 0), code.subarray(at, at + width), width); at += width; continue;
    }
    if (op === 0xe8) {
      need(4); const target = pe.base + start + at + 4 + code.readInt32LE(at); at += 4;
      // Only the allocation-shaped calls belonging to reconstructed strings
      // are modeled. Nothing at the target address is inspected or executed.
      const size = number(regs.get(1));
      if (size < 16 || size > 8192 || allocationTarget !== undefined && target !== allocationTarget) {
        if (ids.size === expectedIds.size) { stop = true; continue; }
        fail("Unsupported initializer call");
      }
      allocationTarget = target;
      const address = heapBase + heaps.length * 16384;
      heaps.push({ at: address, size }); regs.set(0, encode(address, 8));
      regs.delete(1); regs.delete(2); regs.delete(8); regs.delete(9); continue;
    }
    if (op === 0xc3 || op === 0xe9) { stop = true; continue; }
    let vectorOp;
    if (op === 0x0f) { need(1); vectorOp = code[at++]; }
    const supported = vectorOp ? [0x10, 0x11, 0x28, 0x29, 0x57].includes(vectorOp) : [0x88, 0x89, 0x8b, 0x8d, 0xc6, 0xc7, 0x83].includes(op);
    if (!supported) fail(`Unsupported initializer instruction at ${begin}`);
    need(1);
    const modrm = code[at++], mod = modrm >>> 6, reg = ((modrm >>> 3) & 7) + (rex & 4 ? 8 : 0), rm = (modrm & 7) + (rex & 1 ? 8 : 0);
    if (vectorOp === 0x57 && mod === 3 && reg === rm) { vectors.set(reg, Buffer.alloc(16)); continue; }
    if (op === 0x83 && mod === 3 && rm === 4 && [0, 5].includes((modrm >>> 3) & 7)) { need(1); at++; continue; }
    if (mod === 3) fail("Unsupported register operation in initializer");
    let displacement = 0, address, stack = false, rip = mod === 0 && (modrm & 7) === 5;
    if ((modrm & 7) === 4) {
      need(1); const sib = code[at++];
      if ((sib & 0x3f) !== 0x24) fail("Unsupported indexed initializer address");
      stack = true;
    } else if (rm === 5 && mod !== 0) stack = true;
    if (mod === 1) { need(1); displacement = code.readInt8(at++); }
    else if (mod === 2 || rip) { need(4); displacement = code.readInt32LE(at); at += 4; }
    const valueSize = vectorOp ? 16 : [0x88, 0xc6].includes(op) ? 1 : width;
    let immediate;
    if (op === 0xc6 || op === 0xc7) {
      const size = op === 0xc6 ? 1 : width === 2 ? 2 : 4;
      need(size); immediate = Buffer.alloc(valueSize);
      code.copy(immediate, 0, at, at + size);
      if (width === 8 && code[at + 3] & 0x80) immediate.fill(0xff, 4);
      at += size;
    }
    if (!stack) address = rip ? pe.base + start + at + displacement : number(regs.get(rm)) + displacement;
    if (stack) continue;
    if (op === 0x8d) { regs.set(reg, encode(address, 8)); continue; }
    if (vectorOp === 0x10 || vectorOp === 0x28) { vectors.set(reg, read(address, 16)); continue; }
    if (op === 0x8b) { setReg(reg, read(address, valueSize), valueSize); continue; }
    const value = immediate || (vectorOp ? vectors.get(reg) : regs.get(reg)?.subarray(0, valueSize));
    write(address, value);
    if (op === 0xc7 && width === 4 && expectedIds.has(number(value))) {
      const id = number(value);
      if (ids.has(id)) fail("Duplicate custom achievement initialization");
      ids.set(id, address);
    }
  }
  if (ids.size !== expectedIds.size) fail("Incomplete custom achievement initializer");
  const addresses = [...ids.values()].sort((a, b) => a - b);
  if (addresses.some((at, i) => i && at - addresses[i - 1] !== 160)) fail("Unsupported AchievementInfo table layout");
  const text = (at) => {
    const size = number(read(at + 16, 8)), capacity = number(read(at + 24, 8));
    if (size > 8191 || capacity < size || capacity > 8191) fail("Invalid compiled string length");
    const bytes = read(capacity <= 15 ? at : number(read(at, 8)), size + 1);
    if (bytes[size] !== 0) fail("Unterminated compiled string");
    const value = bytes.subarray(0, size).toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes.subarray(0, size)) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail("Invalid compiled UTF-8 text");
    return value;
  };
  return [...ids].map(([id, at]) => {
    const displayName = text(at + 8), description = text(at + 40), lockedDescription = text(at + 72), iconPath = text(at + 104);
    const imageId = number(read(at + 136, 4)), points = number(read(at + 140, 4)), flags = number(read(at + 144, 4));
    if (!displayName.trim() || imageId || points > 100000 || flags || iconPath.toLowerCase() !== `achievements/0x${id.toString(16)}.png`) fail("Invalid custom achievement association");
    return { name: String(id), displayName, description, lockedDescription, gamerscore: points, points, iconPath };
  }).sort((a, b) => Number(a.name) - Number(b.name));
}

function extractExecutable(bytes) {
  const pe = parsePe(bytes), icons = embeddedIcons(pe), expected = new Set(icons.keys()), candidates = [];
  const marker = Buffer.alloc(4); marker.writeUInt32LE(Math.min(...expected));
  for (const s of pe.sections.filter((s) => s.flags & 0x20000000)) {
    let at = s.raw - 1;
    while ((at = bytes.indexOf(marker, at + 1)) >= 0 && at < s.raw + s.size) {
      if (at < s.raw + 6 || bytes[at - 6] !== 0xc7 || bytes[at - 5] !== 5) continue;
      const rva = s.va + at - 6 - s.raw;
      for (let p = 0; p + 12 <= pe.functions.length; p += 12) {
        const start = pe.functions.readUInt32LE(p), end = pe.functions.readUInt32LE(p + 4);
        if (start <= rva && end > rva && end - start <= 65536) { candidates.push([start, end]); break; }
      }
    }
  }
  const results = [];
  for (const [start, end] of [...new Map(candidates.map((pair) => [pair.join(":"), pair])).values()]) {
    try { results.push(reconstruct(pe, start, end, expected)); } catch { /* Unsupported candidate must not leak partial definitions. */ }
  }
  if (results.length !== 1) fail("No unique supported re:Blue achievement initializer");
  return { entries: results[0].map((entry) => ({ ...entry, image: icons.get(Number(entry.name)).toString("base64") })),
    version: pe.version, executableSha256: sha256(bytes), source: "executable" };
}

function sourceIdentity(file) {
  const stat = fs.statSync(file);
  if (fs.lstatSync(file).isSymbolicLink() || !stat.isFile() || stat.size < 64 || stat.size > MAX_EXE) fail("Invalid re:Blue executable file");
  return { file: path.resolve(file), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function extractWorker(file, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      { workerData: { reblueExtract: true, file }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } });
    let settled = false, timer, cancelTimer;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(cancelTimer);
      await worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    worker.once("message", (value) => void finish(value.ok ? null : Object.assign(new Error(value.error), { code: "REBLUE_METADATA" }), value.result));
    worker.once("error", (error) => void finish(error));
    worker.once("exit", (code) => { if (!settled) void finish(new Error(`re:Blue metadata worker exited (${code})`)); });
    timer = setTimeout(() => void finish(new Error("re:Blue metadata extraction timed out")), 15000);
    if (options.isCancelled) cancelTimer = setInterval(() => {
      try { cancelled(options); } catch (error) { void finish(error); }
    }, 100);
  });
}

function validateResult(result) {
  if (!Array.isArray(result?.entries) || !result.entries.length || result.entries.length > 64 || !/^[a-f0-9]{64}$/.test(result.executableSha256 || "")) fail("Invalid re:Blue cache");
  const ids = new Set();
  for (const entry of result.entries) {
    const id = Number(entry.name);
    if (!Number.isInteger(id) || id <= 0x10000 || id > 0x1ffff || String(id) !== entry.name || ids.has(id) ||
        ![entry.displayName, entry.description, entry.lockedDescription].every((v) => typeof v === "string" && v.length <= 8191) || !entry.displayName.trim() ||
        !Number.isInteger(entry.points) || entry.points < 0 || entry.points > 100000 || entry.gamerscore !== entry.points ||
        typeof entry.image !== "string" || entry.image.length > MAX_ICON * 2) fail("Invalid cached custom achievement");
    ids.add(id); png(Buffer.from(entry.image, "base64"));
  }
  return result;
}

async function onlineFallback(file, options) {
  // Never substitute the current GitHub branch for an unknown installed build.
  // Match the local executable to an official release archive before reading
  // definitions from that release's immutable commit.
  const bytes = await fs.promises.readFile(file), pe = parsePe(bytes);
  if (!pe.version) fail("Online fallback requires a verified release version");
  const axios = require("axios"), get = async (url, max, binary = false) => {
    cancelled(options);
    const controller = new AbortController();
    const timer = options.isCancelled && setInterval(() => {
      try { if (options.isCancelled()) controller.abort(); } catch { controller.abort(); }
    }, 100);
    try {
      const response = await axios.get(url, { timeout: 15000, maxContentLength: max, maxBodyLength: max, signal: controller.signal,
        responseType: binary ? "arraybuffer" : "json", headers: { "User-Agent": "Achievements-reblue-metadata" } });
      cancelled(options); return response.data;
    } catch (error) { cancelled(options); throw error; }
    finally { if (timer) clearInterval(timer); }
  };
  const api = "https://api.github.com/repos/zolaware/reblue", release = await get(`${api}/releases/tags/v${pe.version}`, 1024 * 1024);
  const asset = release.assets?.find((a) => a.name === `reblue-${pe.version}-win-amd64.zip`);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") || asset.size > 64 * 1024 * 1024 ||
      !String(asset.browser_download_url).startsWith("https://github.com/zolaware/reblue/releases/download/")) fail("No verifiable re:Blue release archive");
  const zipBytes = Buffer.from(await get(asset.browser_download_url, 64 * 1024 * 1024, true));
  if (`sha256:${sha256(zipBytes)}` !== asset.digest) fail("re:Blue release archive hash mismatch");
  const zip = new (require("adm-zip"))(zipBytes), entries = zip.getEntries().filter((e) => /(?:^|\/)reblue\.exe$/i.test(e.entryName));
  if (entries.length !== 1 || entries[0].header.size > MAX_EXE || sha256(entries[0].getData()) !== sha256(bytes)) fail("Installed executable does not match official release");
  const commit = await get(`${api}/commits/v${pe.version}`, 1024 * 1024);
  if (!/^[a-f0-9]{40}$/.test(commit.sha || "")) fail("Invalid re:Blue release commit");
  const raw = `https://raw.githubusercontent.com/zolaware/reblue/${commit.sha}`;
  const source = Buffer.from(await get(`${raw}/src/engine/achievements/achievements.cpp`, 256 * 1024, true)).toString("utf8");
  const constants = new Map([...source.matchAll(/constexpr\s+u32\s+(\w+)\s*=\s*(0x[0-9a-f]+|\d+)\s*;/gi)].map((m) => [m[1], Number(m[2])]));
  const table = /CustomAchievement\s+s_achievements\[\]\s*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (!table) fail("Unsupported online achievement definition layout");
  const literal = '"(?:[^"\\\\]|\\\\.)*"', pattern = new RegExp(`\\{\\{(\\w+),\\s*(${literal}),\\s*(${literal}),\\s*(${literal}),\\s*(${literal}),\\s*0,\\s*(\\d+),\\s*0\\}\\}`, "g");
  const definitions = [...table.matchAll(pattern)];
  if (definitions.length < 1 || definitions.length > 64 || table.replace(pattern, "").replace(/[\s,]/g, "")) fail("Incomplete online achievement definitions");
  const result = { entries: [], version: pe.version, executableSha256: sha256(bytes), source: "verified-release", revision: commit.sha };
  for (const m of definitions) {
    const id = constants.get(m[1]), iconPath = JSON.parse(m[5]);
    if (!id || iconPath !== `achievements/0x${id.toString(16)}.png`) fail("Invalid online achievement icon association");
    const image = png(Buffer.from(await get(`${raw}/res/embed/${iconPath}`, MAX_ICON, true)));
    result.entries.push({ name: String(id), displayName: JSON.parse(m[2]), description: JSON.parse(m[3]), lockedDescription: JSON.parse(m[4]),
      points: Number(m[6]), gamerscore: Number(m[6]), iconPath, image: image.toString("base64") });
  }
  return validateResult(result);
}

async function loadReblueMetadata(game, schemaDir, logger, options = {}) {
  const file = path.join(game.installRoot, "reblue.exe"), identity = sourceIdentity(file), cache = path.join(schemaDir, "reblue-metadata-cache.json");
  cancelled(options);
  if (!options.forceXexRefresh) {
    try {
      const stat = fs.statSync(cache);
      if (stat.size > 8 * 1024 * 1024) fail("Oversized re:Blue cache");
      const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
      if (saved.cacheVersion === VERSION && JSON.stringify(saved.identity) === JSON.stringify(identity) &&
          saved.resultSha256 === sha256(JSON.stringify(saved.result)) &&
          JSON.stringify(identity) === JSON.stringify(sourceIdentity(file))) {
        const result = validateResult(saved.result);
        logger?.info("x360recomp:reblue:cache-hit", { appid: game.titleId, count: result.entries.length, source: result.source });
        return result;
      }
    } catch { /* A stale/damaged cache is recovered from this installation. */ }
  }
  logger?.info("x360recomp:reblue:extract", { appid: game.titleId, file, size: identity.size });
  let result;
  try { result = validateResult(await extractWorker(file, options)); }
  catch (error) {
    cancelled(options);
    logger?.warn("x360recomp:reblue:extract-failed", { appid: game.titleId, error: error.message });
    if (options.disableReblueOnline) throw error;
    result = await onlineFallback(file, options);
  }
  cancelled(options);
  if (JSON.stringify(identity) !== JSON.stringify(sourceIdentity(file))) fail("re:Blue executable changed during metadata extraction");
  writeJsonAtomicSync(cache, { cacheVersion: VERSION, identity, result, resultSha256: sha256(JSON.stringify(result)) }, { backup: true });
  logger?.info("x360recomp:reblue:ready", { appid: game.titleId, count: result.entries.length, source: result.source, version: result.version });
  return result;
}

if (!isMainThread && workerData?.reblueExtract) {
  try {
    sourceIdentity(workerData.file);
    parentPort.postMessage({ ok: true, result: extractExecutable(fs.readFileSync(workerData.file)) });
  } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
}

module.exports = { loadReblueMetadata, extractExecutable };
