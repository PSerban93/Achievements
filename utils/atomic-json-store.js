"use strict";

const fs = require("fs");
const path = require("path");

let tempSequence = 0;

function sleepSync(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, delayMs);
}

function isRetryableWindowsFileError(error) {
  return ["EACCES", "EBUSY", "EPERM"].includes(String(error?.code || ""));
}

function makeSiblingTempPath(filePath, label = "tmp") {
  tempSequence = (tempSequence + 1) % Number.MAX_SAFE_INTEGER;
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempSequence}.${label}`,
  );
}

function cleanupStaleSiblingTempsSync(filePath, options = {}) {
  const directory = path.dirname(filePath);
  const prefix = `.${path.basename(filePath)}.`;
  const maxAgeMs = Math.max(
    60_000,
    Number(options.staleTempMaxAgeMs) || 24 * 60 * 60 * 1000,
  );
  const cutoff = Date.now() - maxAgeMs;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    if (
      !entry.name.endsWith(".json-tmp") &&
      !entry.name.endsWith(".backup-tmp")
    ) {
      continue;
    }
    const candidate = path.join(directory, entry.name);
    try {
      if (fs.statSync(candidate).mtimeMs > cutoff) continue;
      fs.unlinkSync(candidate);
      removed += 1;
    } catch {}
  }
  return removed;
}

function fsyncFileSync(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r+");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function renameWithRetrySync(sourcePath, destinationPath, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 6);
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs) || 15);
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      if (
        !isRetryableWindowsFileError(error) ||
        attempt >= attempts - 1
      ) {
        throw error;
      }
      sleepSync(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function isValidJsonFileSync(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function replaceBackupSync(filePath, backupPath, options = {}) {
  if (!backupPath || !isValidJsonFileSync(filePath)) return false;
  const backupTempPath = makeSiblingTempPath(backupPath, "backup-tmp");
  try {
    fs.copyFileSync(filePath, backupTempPath);
    fsyncFileSync(backupTempPath);
    renameWithRetrySync(backupTempPath, backupPath, options);
    return true;
  } finally {
    try {
      if (fs.existsSync(backupTempPath)) fs.unlinkSync(backupTempPath);
    } catch {}
  }
}

function writeJsonAtomicSync(filePath, value, options = {}) {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("A destination file path is required.");
  }
  const json = JSON.stringify(value, null, options.spaces ?? 2);
  if (json === undefined) {
    throw new TypeError("The supplied value cannot be serialized as JSON.");
  }
  const serialized = `${json}${options.trailingNewline === true ? "\n" : ""}`;
  const targetDir = path.dirname(filePath);
  const tempPath = makeSiblingTempPath(filePath, "json-tmp");
  const backupPath =
    options.backup === true ? options.backupPath || `${filePath}.bak` : "";

  fs.mkdirSync(targetDir, { recursive: true });
  cleanupStaleSiblingTempsSync(filePath, options);
  try {
    fs.writeFileSync(tempPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    fsyncFileSync(tempPath);
    if (backupPath) replaceBackupSync(filePath, backupPath, options);
    renameWithRetrySync(tempPath, filePath, options);
    return true;
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

function readJsonWithBackupSync(filePath, options = {}) {
  const fallback = options.fallback ?? {};
  const backupPath = options.backupPath || `${filePath}.bak`;
  let primaryError = null;

  if (filePath && fs.existsSync(filePath)) {
    try {
      return {
        value: JSON.parse(fs.readFileSync(filePath, "utf8")),
        source: "primary",
        error: null,
      };
    } catch (error) {
      primaryError = error;
    }
  }

  if (options.backup !== false && backupPath && fs.existsSync(backupPath)) {
    try {
      return {
        value: JSON.parse(fs.readFileSync(backupPath, "utf8")),
        source: "backup",
        error: primaryError,
      };
    } catch (backupError) {
      return {
        value: fallback,
        source: "fallback",
        error: primaryError || backupError,
        backupError,
      };
    }
  }

  return {
    value: fallback,
    source: "fallback",
    error: primaryError,
  };
}

module.exports = {
  cleanupStaleSiblingTempsSync,
  readJsonWithBackupSync,
  writeJsonAtomicSync,
};
