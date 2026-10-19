"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("node:worker_threads");
const { parseSpaFile } = require("./xlivelessness-spa");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { MAX_IMAGE, fail } = require("./x360-recomp-lzx");
const CACHE_VERSION = 1;
const TIMEOUT_MS = 30000;

function sourceIdentity(file, titleId) {
  const resolved = path.resolve(file), stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE) fail("XEX_SIZE", "Invalid or oversized XEX file");
  return { file: resolved, titleId, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameSource(a, b) {
  return a?.file === b?.file && a?.titleId === b?.titleId && a?.size === b?.size &&
    a?.mtimeMs === b?.mtimeMs && a?.ctimeMs === b?.ctimeMs;
}

function validateSpa(bytes, titleId) {
  const parsed = parseSpaFile(bytes);
  if (!parsed.titleId || parsed.titleId.toString(16).padStart(8, "0").toUpperCase() !== titleId) {
    fail("XEX_SPA_TITLE_MISMATCH", "SPA Title ID mismatch");
  }
  return parsed;
}

function workerExtract(file, titleId, isCancelled) {
  return new Promise((resolve, reject) => {
    if (isCancelled?.()) { reject(Object.assign(new Error("Recomp generation cancelled"), { code: "XEX_CANCELLED" })); return; }
    const workerPath = path.join(__dirname, "x360-recomp-xex-worker.js")
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    let worker, settled = false, timeout, cancellation;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearInterval(cancellation);
      // Await termination before permitting another extraction/fallback.
      // The worker owns no cache writes, so timeout cannot leave partial files.
      try { if (worker) await worker.terminate(); }
      catch (terminationError) { if (!error) error = terminationError; }
      if (error) reject(error); else resolve(result);
    };
    try {
      worker = new Worker(workerPath, { workerData: { file, titleId },
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      worker.once("message", (result) => {
        if (!result?.ok) void finish(Object.assign(new Error(result?.error || "Xbox metadata worker failed"), { code: result?.code || "XEX_WORKER" }));
        else void finish(null, result);
      });
      worker.once("error", (error) => void finish(error));
      worker.once("exit", (code) => {
        if (!settled) void finish(Object.assign(new Error(`Xbox metadata worker exited without a result (${code})`), { code: "XEX_WORKER_EXIT" }));
      });
      timeout = setTimeout(() => void finish(Object.assign(new Error("Xbox metadata extraction exceeded 30 seconds"), { code: "XEX_TIMEOUT" })), TIMEOUT_MS);
      if (isCancelled) cancellation = setInterval(() => {
        try {
          if (isCancelled()) void finish(Object.assign(new Error("Recomp generation cancelled"), { code: "XEX_CANCELLED" }));
        } catch (error) { void finish(error); }
      }, 100);
    } catch (error) { void finish(error); }
  });
}

async function loadXexSpa(file, titleId, schemaDir, logger, options = {}) {
  const startedAt = Date.now(), identity = sourceIdentity(file, titleId);
  const spaFile = path.join(schemaDir, "xbox-spa.xdbf"), manifestFile = path.join(schemaDir, "xbox-spa-cache.json");
  const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  if (options.isCancelled?.()) fail("XEX_CANCELLED", "Recomp generation cancelled");
  if (!options.forceXexRefresh) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (manifest.version === CACHE_VERSION && sameSource(manifest.source, identity)) {
        const stat = fs.statSync(spaFile);
        if (stat.size >= 24 && stat.size <= MAX_IMAGE) {
          const bytes = fs.readFileSync(spaFile);
          if (sha256(bytes) === manifest.sha256 && sameSource(identity, sourceIdentity(file, titleId))) {
            const parsed = validateSpa(bytes, titleId);
            logger?.info("x360recomp:xex:cache-hit", { appid: titleId, compression: manifest.compression,
              durationMs: Date.now() - startedAt });
            return { parsed, compression: manifest.compression, cached: true };
          }
        }
      }
    } catch { /* Missing/stale/damaged metadata cache: extract from the game. */ }
  }
  logger?.info("x360recomp:xex:start", { appid: titleId, file, size: identity.size });
  const result = await workerExtract(identity.file, titleId, options.isCancelled);
  if (options.isCancelled?.()) fail("XEX_CANCELLED", "Recomp generation cancelled");
  const workerIdentity = { ...identity, size: result.fileSize, mtimeMs: result.mtimeMs, ctimeMs: result.ctimeMs };
  if (!sameSource(identity, workerIdentity) || !sameSource(identity, sourceIdentity(file, titleId))) {
    fail("XEX_CHANGED", "XEX changed during extraction; rescan when copying has finished");
  }
  const bytes = Buffer.from(result.spa);
  const parsed = validateSpa(bytes, titleId);
  // Cache failure must not discard successfully decoded local metadata.
  let temp;
  try {
    fs.mkdirSync(schemaDir, { recursive: true });
    temp = `${spaFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temp, bytes); fs.renameSync(temp, spaFile); temp = null;
    writeJsonAtomicSync(manifestFile, { version: CACHE_VERSION, source: identity,
      compression: result.compression, sha256: sha256(bytes) });
  } catch (error) {
    logger?.warn("x360recomp:xex:cache-write-failed", { appid: titleId, error: error.message });
  } finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } }
  logger?.info("x360recomp:xex:ready", { appid: titleId,
    compression: result.compression === 2 ? "lzx" : result.compression === 1 ? "basic" : "none",
    achievements: parsed.achievements.length, spaBytes: bytes.length, durationMs: Date.now() - startedAt });
  return { parsed, compression: result.compression, cached: false };
}

module.exports = { loadXexSpa };
