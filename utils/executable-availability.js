"use strict";
const fs = require("fs"), path = require("path");

function createExecutableAvailabilityCheck({ access = file => fs.promises.access(file, fs.constants.F_OK), logger } = {}) {
  const failures = new Map(), pending = new Map();
  return function check(executable) {
    if (typeof executable !== "string" || !executable.trim()) return Promise.resolve(false);
    const absolute = path.resolve(executable), key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      try {
        await access(executable);
        if (failures.delete(key)) logger?.info?.("executable:available-again", { executable });
        return true;
      } catch (error) {
        const signature = JSON.stringify([error?.code || null, error?.message || String(error)]);
        if (failures.get(key) !== signature) {
          if (!failures.has(key) && failures.size >= 512) failures.delete(failures.keys().next().value);
          failures.set(key, signature);
          logger?.warn?.("executable:check-failed", { executable, code: error?.code || null, error: error?.message || String(error) });
        }
        return false;
      }
    })().finally(() => pending.delete(key));
    pending.set(key, operation); return operation;
  };
}
module.exports = { createExecutableAvailabilityCheck };
