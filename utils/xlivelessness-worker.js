"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { parentPort, workerData } = require("node:worker_threads");

const {
  buildSchemaFromSpa,
  extractSpaFile,
  parseSpaFile,
} = require("./xlivelessness-spa");

function serializeSpa(parsedSpa) {
  return {
    titleId: parsedSpa.titleId,
    achievements: parsedSpa.achievements,
    stringsByLanguage: Array.from(parsedSpa.stringsByLanguage, ([id, strings]) => [
      id,
      Array.from(strings),
    ]),
    images: Array.from(parsedSpa.images, ([id, image]) => [id, image]),
    titleNames: Array.from(parsedSpa.titleNames),
    warnings: parsedSpa.warnings || [],
  };
}

async function inspectExecutable(payload = {}) {
  const executablePath = String(payload.executablePath || "");
  const executableBuffer = await fs.promises.readFile(executablePath);
  const spaBuffer = extractSpaFile(executableBuffer);
  const parsedSpa = parseSpaFile(spaBuffer);
  const spaTitleId =
    Number.isInteger(parsedSpa.titleId) && parsedSpa.titleId >= 0
      ? parsedSpa.titleId.toString(16).toUpperCase().padStart(8, "0")
      : "";
  const configTitleId = String(payload.titleId || "").toUpperCase();
  if (spaTitleId && configTitleId && spaTitleId !== configTitleId) {
    return {
      valid: false,
      reason: "title-id-mismatch",
      configTitleId,
      spaTitleId,
    };
  }
  return {
    valid: true,
    reason: "",
    resourceFingerprint: crypto
      .createHash("sha256")
      .update(spaBuffer)
      .digest("hex"),
    spa: serializeSpa(parsedSpa),
  };
}

function deserializeSpa(serializedSpa = {}) {
  return {
    titleId: serializedSpa.titleId,
    achievements: Array.isArray(serializedSpa.achievements)
      ? serializedSpa.achievements
      : [],
    stringsByLanguage: new Map(
      (Array.isArray(serializedSpa.stringsByLanguage)
        ? serializedSpa.stringsByLanguage
        : []
      ).map(([id, strings]) => [id, new Map(strings)]),
    ),
    images: new Map(
      Array.isArray(serializedSpa.images) ? serializedSpa.images : [],
    ),
    titleNames: new Map(
      Array.isArray(serializedSpa.titleNames) ? serializedSpa.titleNames : [],
    ),
    warnings: serializedSpa.warnings || [],
  };
}

async function buildSchema(payload = {}) {
  const spa = deserializeSpa(payload.spa);
  const built = buildSchemaFromSpa(spa, {
    schemaLanguages: payload.schemaLanguages,
  });
  const known = new Set(built.schema.map((entry) => entry.name));
  const images = new Map(), sources = [], warnings = [...spa.warnings];
  const languages = new Set(built.languages), available = new Set(built.availableLanguages);
  const collectImages = (source, rows) => {
    for (const entry of rows) {
      const image = source.images.get(entry.xlln_image_id);
      if (image) images.set(entry.name, image);
    }
  };
  collectImages(spa, built.schema);
  const files = Array.isArray(payload.packFiles) ? payload.packFiles : [];
  if (files.length > 128) throw new Error("Too many XLiveLessNess DLC SPA files");
  let totalBytes = 0;
  for (const file of files) {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 ||
        (totalBytes += stat.size) > 128 * 1024 * 1024) throw new Error(`Invalid or oversized DLC SPA: ${file}`);
    const bytes = await fs.promises.readFile(file);
    if (bytes.length !== stat.size) throw new Error(`DLC SPA changed while reading: ${file}`);
    const source = { path: file, fingerprint: crypto.createHash("sha256").update(bytes).digest("hex") };
    let pack;
    try { pack = parseSpaFile(bytes); } catch (error) {
      // Content packs may contain no achievement definitions at all.
      if (error.message !== "SPAFILE does not contain XACH metadata") throw error;
      sources.push(source); continue;
    }
    if (pack.titleId !== null && pack.titleId !== Number.parseInt(payload.titleId, 16)) {
      throw new Error(`DLC SPA title ID does not match the game: ${file}`);
    }
    if (!pack.achievements.some((entry) => !known.has(String(entry.id)))) {
      warnings.push(...(pack.warnings || []).map((warning) => `${file}: ${warning}`));
      sources.push(source); continue;
    }
    const extra = buildSchemaFromSpa(pack, { schemaLanguages: payload.schemaLanguages });
    const rows = extra.schema.filter((entry) => {
      if (known.has(entry.name)) return false;
      known.add(entry.name); return true;
    }).map((entry) => ({ ...entry, xlln_dlc: true }));
    built.schema.push(...rows);
    collectImages(pack, rows);
    extra.languages.forEach((language) => languages.add(language));
    extra.availableLanguages.forEach((language) => available.add(language));
    warnings.push(...(pack.warnings || []).map((warning) => `${file}: ${warning}`));
    sources.push(source);
  }
  return { ...built, languages: [...languages], availableLanguages: [...available],
    images: [...images], sources, warnings };
}

async function run() {
  switch (String(workerData?.operation || "")) {
    case "inspect-executable":
      return inspectExecutable(workerData);
    case "build-schema":
      return buildSchema(workerData);
    default:
      throw new Error("Unknown XLiveLessNess worker operation");
  }
}

if (!parentPort) {
  throw new Error("XLiveLessNess worker requires a parent port");
}

run()
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((error) => {
    parentPort.postMessage({
      ok: false,
      error: error?.message || String(error),
      code: error?.code || "",
    });
  });
