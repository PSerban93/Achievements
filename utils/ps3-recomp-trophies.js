"use strict";

const fs = require("fs");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { parseTropconfSfm, ttypeToLabel, parseHiddenFlag } = require("./rpcs3-trophy");
const LANGUAGES = ["japanese", "english", "french", "spanish", "german", "italian", "dutch",
  "portuguese", "russian", "koreana", "tchinese", "schinese", "finnish", "swedish",
  "danish", "norwegian", "polish", "brazilian", "english"];

function extract(file, expectedId) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error("Invalid PS3 trophy archive");
  const bytes = fs.readFileSync(file);
  // PS3 TRP has a 64-byte header, unlike the 96-byte PS4 header.
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0xdca24d00) throw new Error("Invalid PS3 TRP header");
  const count = bytes.readUInt32BE(16), stride = bytes.readUInt32BE(20);
  if (!count || count > 4096 || stride !== 64 || 64 + count * stride > bytes.length ||
      bytes.readBigUInt64BE(8) !== BigInt(bytes.length)) throw new Error("Invalid PS3 TRP directory");
  const documents = new Map(), images = new Map(), names = new Set();
  let selectedBytes = 0;
  for (let i = 0; i < count; i++) {
    const at = 64 + i * stride, name = bytes.subarray(at, at + 32).toString("ascii").split("\0")[0].toUpperCase();
    if (names.has(name)) throw new Error(`Duplicate TRP entry: ${name}`);
    names.add(name);
    const text = /^(?:TROPCONF|TROP(?:_\d{2})?)\.SFM$/.test(name);
    if (!text && !/^(?:TROP\d{3}|ICON0)\.PNG$/.test(name)) continue;
    const offset = Number(bytes.readBigUInt64BE(at + 32)), size = Number(bytes.readBigUInt64BE(at + 40));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0 || size > 8 * 1024 * 1024 ||
        offset < 64 + count * stride || offset + size > bytes.length) throw new Error("Invalid PS3 TRP entry bounds");
    selectedBytes += size;
    if (selectedBytes > bytes.length) throw new Error("Overlapping or oversized PS3 TRP payload");
    const value = bytes.subarray(offset, offset + size);
    if (text) documents.set(name, parseTropconfSfm(value.toString("utf8")));
    else {
      if (value.length < 24 || !value.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
          value.readUInt32BE(16) > 4096 || value.readUInt32BE(20) > 4096) throw new Error(`Invalid trophy image: ${name}`);
      images.set(name, Buffer.from(value));
    }
  }
  const primary = documents.get("TROP_01.SFM") || documents.get("TROP.SFM") || documents.get("TROPCONF.SFM");
  if (!primary?.trophies.length) throw new Error("PS3 trophy metadata is missing");
  const identity = String(primary.npcommid || "").toUpperCase();
  if (identity && identity !== expectedId && identity !== expectedId.slice(0, 9)) throw new Error("PS3 trophy set identity mismatch");
  const ids = new Set(primary.trophies.map((t) => t.id));
  if (ids.size !== primary.trophies.length) throw new Error("Duplicate PS3 trophy ID");
  const translations = new Map([["english", primary]]);
  for (const [name, doc] of documents) {
    const match = /^TROP_(\d{2})\.SFM$/.exec(name), language = match && LANGUAGES[Number(match[1])];
    if (!language || (language === "english" && translations.get(language) !== primary)) continue;
    if (doc.npcommid && doc.npcommid.toUpperCase() !== identity) throw new Error("Conflicting localized trophy identity");
    if (doc.trophies.length !== ids.size || doc.trophies.some((t) => !ids.has(t.id)) ||
        new Set(doc.trophies.map((t) => t.id)).size !== ids.size) throw new Error("Conflicting localized trophy IDs");
    translations.set(language, doc);
  }
  const entries = primary.trophies.map((trophy) => {
    const displayName = {}, description = {};
    for (const [language, doc] of translations) {
      const row = doc.trophies.find((t) => t.id === trophy.id);
      displayName[language] = row.name || trophy.name || String(trophy.id);
      description[language] = row.detail || "";
    }
    const name = `TROP${String(trophy.id).padStart(3, "0")}.PNG`;
    const icon = images.has(name) ? `img/${name}` : images.has("ICON0.PNG") ? "img/ICON0.PNG" : "";
    return { name: String(trophy.id), displayName, description, trophyType: ttypeToLabel(trophy.ttype),
      hidden: parseHiddenFlag(trophy.hidden) ? 1 : 0, icon, icon_gray: icon };
  });
  return { title: primary.titleName, entries, images: [...images] };
}

function metadata(file, expectedId) {
  return new Promise((resolve, reject) => {
    const workerPath = __filename.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const worker = new Worker(workerPath, { workerData: { file, expectedId },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
    let done = false;
    const finish = async (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { await worker.terminate(); } catch (e) { error ||= e; }
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => void finish(new Error("PS3 TRP extraction timed out")), 30000);
    worker.once("message", (message) => void finish(message.error ? new Error(message.error) : null, message.value));
    worker.once("error", (error) => void finish(error));
    worker.once("exit", (code) => { if (!done) void finish(new Error(`PS3 TRP worker exited without a result: ${code}`)); });
  });
}
if (!isMainThread && workerData?.file) {
  try { parentPort.postMessage({ value: extract(workerData.file, workerData.expectedId) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
module.exports = { extract, metadata };
