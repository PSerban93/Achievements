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
  };
}

function buildSchema(payload = {}) {
  const spa = deserializeSpa(payload.spa);
  return buildSchemaFromSpa(spa, {
    schemaLanguages: payload.schemaLanguages,
  });
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
