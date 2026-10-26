"use strict";

const path = require("path");

const pendingFiles = new Map();

// Queue encryption as well as the write. A slower encryption operation must
// not overwrite a later save, or recreate an account after Disconnect.
function withAuthFile(filePath, operation) {
  const resolved = path.resolve(filePath);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = pendingFiles.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pendingFiles.set(key, current);
  const release = () => {
    if (pendingFiles.get(key) === current) pendingFiles.delete(key);
  };
  current.then(release, release);
  return current;
}

function unavailable() {
  const error = new Error("Authentication storage is temporarily unavailable");
  error.code = "AUTH_STORAGE_UNAVAILABLE";
  error.isTemporarilyUnavailable = true;
  return error;
}

function isAuthStorageUnavailable(error) {
  return error?.isTemporarilyUnavailable === true ||
    ["AUTH_STORAGE_UNAVAILABLE", "EACCES", "EPERM", "EBUSY"].includes(error?.code);
}

async function getAsyncSafeStorage(options = {}) {
  let storage;
  if (Object.hasOwn(options, "safeStorage")) {
    storage = options.safeStorage;
  } else {
    let electron;
    try { electron = require("electron"); } catch { return null; }
    storage = electron?.safeStorage;
    if (storage && electron.app && !electron.app.isReady()) await electron.app.whenReady();
  }
  // Standalone Node tools have no Electron provider. Existing Xbox v1 data
  // remains supported there; an unavailable Electron provider never downgrades.
  if (!storage) return null;
  try {
    if (typeof storage.isAsyncEncryptionAvailable !== "function" ||
        typeof storage.encryptStringAsync !== "function" ||
        typeof storage.decryptStringAsync !== "function" ||
        !await storage.isAsyncEncryptionAvailable()) throw unavailable();
  } catch {
    throw unavailable();
  }
  return storage;
}

async function decryptAuthString(storage, encrypted) {
  if (!storage) throw unavailable();
  const decrypted = await storage.decryptStringAsync(encrypted);
  if (typeof decrypted?.result !== "string") throw new Error("Invalid authentication storage result");
  // Reading a valid old file does not rewrite it. The next normal save uses
  // the current encryption key, including after provider key rotation.
  return decrypted.result;
}

module.exports = { withAuthFile, getAsyncSafeStorage, decryptAuthString, isAuthStorageUnavailable };
