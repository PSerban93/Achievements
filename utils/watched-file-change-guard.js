"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Scoped to discovery inputs. Access-time notifications are not definition or
// progress changes. Small XML/config files are compared by content as well, so
// same-size writes with preserved timestamps remain detectable.
function createWatchedFileChangeGuard() {
  const observed = new Map();
  const keyFor = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  function capture(file, content) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return { kind: "directory" };
      return { kind: "file", identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size, mtime: stat.mtimeMs,
        digest: content ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null };
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return { kind: "missing" };
      return { kind: "unreadable" };
    }
  }
  function inspect(file, { content = true, seed = false } = {}) {
    const key = keyFor(file), previous = observed.get(key), current = capture(file, content);
    if (["directory", "unreadable"].includes(current.kind)) return { changed: true, reason: current.kind };
    observed.set(key, current);
    let reason = !previous ? "first-observation" : current.kind !== previous.kind ? current.kind === "missing" ? "removed" : "appeared"
      : current.kind === "missing" ? "unchanged" : previous.identity !== current.identity ? "replaced"
      : content ? previous.digest !== current.digest ? "content-changed" : "unchanged"
      : previous.size !== current.size || previous.mtime !== current.mtime ? "file-revision-changed" : "unchanged";
    return { changed: !seed && reason !== "unchanged", reason };
  }
  return { inspect, prime: (file, options) => inspect(file, { ...options, seed: true }), forget: file => observed.delete(keyFor(file)) };
}

module.exports = { createWatchedFileChangeGuard };
