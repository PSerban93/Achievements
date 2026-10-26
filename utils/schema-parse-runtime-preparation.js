"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { setTimeout: delay } = require("timers/promises");
const fsp = fs.promises;
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const MAX_CACHED_OPERATIONS = 128;
let unavailableHandler = null;

function configureSchemaParseRuntimeNotifications(handler) {
  unavailableHandler = typeof handler === "function" ? handler : null;
}

function isCancelled(error) {
  return /CANCELLED|CANCELED/.test(String(error?.code || ""));
}

function describe(error, stage) {
  return {
    stage, code: error?.code || null, syscall: error?.syscall || null,
    path: error?.path || null, dest: error?.dest || null,
    message: String(error?.message || error),
  };
}

// Preparation must finish before an execution job is submitted to the same
// queue. Waiting for it from inside that job would deadlock the queue.
function createRuntimePreparer(deps) {
  const cache = new Map();
  const inflight = new Map();
  const completed = new Set();
  const log = (level, event, payload) => deps.logger[level](event, payload);

  async function io(stage, operation, options) {
    const maxRetries = Math.max(0, options.fsRetries ?? 3);
    const retryDelay = Math.max(1, options.fsRetryDelayMs ?? 80);
    for (let attempt = 0; ; attempt += 1) {
      try {
        options.signal?.throwIfAborted();
        return await operation();
      } catch (error) {
        if (options.signal?.aborted || isCancelled(error)) throw options.signal?.reason || error;
        error.prepareStage ??= stage;
        if (!RETRYABLE_CODES.has(error.code) || attempt >= maxRetries) throw error;
        log("warn", "schema-parse:filesystem:retry", {
          ...describe(error, stage), attempt: attempt + 1, maxRetries,
        });
        await delay(retryDelay * (attempt + 1), undefined, { signal: options.signal });
      }
    }
  }

  async function exists(target) {
    try {
      await fsp.stat(target);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function readJson(file) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeJson(file, value, options, stage) {
    const temporary = `${file}.${crypto.randomBytes(5).toString("hex")}.tmp`;
    try {
      await io(stage, () => fsp.writeFile(temporary, JSON.stringify(value, null, 2)), options);
      await io(stage, () => fsp.rename(temporary, file), options);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function copyMutable(from, to, options, overwrite) {
    for (const name of deps.mutableNames) {
      const source = path.join(from, name);
      if (await exists(source)) {
        await io(`copy-mutable:${name}`, () => fsp.cp(source, path.join(to, name), {
          recursive: true, force: overwrite, errorOnExist: false,
        }), options);
      }
    }
  }

  async function cleanup(target, options, warnings) {
    try {
      await io(`cleanup:${path.basename(target)}`, () => fsp.rm(target, {
        recursive: true, force: true, maxRetries: 0,
      }), options);
      return true;
    } catch (error) {
      if (options.signal?.aborted || isCancelled(error)) throw error;
      warnings.push(describe(error, error.prepareStage));
      log("warn", "schema-parse:cleanup:deferred", describe(error, error.prepareStage));
      return false;
    }
  }

  function validateJournal(journal, runtime) {
    const parent = path.dirname(runtime);
    if (typeof journal.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(journal.id) ||
        journal.runtime !== runtime ||
        typeof journal.stage !== "string" || typeof journal.previous !== "string" ||
        path.dirname(journal.stage) !== parent || path.dirname(journal.previous) !== parent ||
        !path.basename(journal.stage).startsWith(".schema_parse-stage-") ||
        !path.basename(journal.previous).startsWith(".schema_parse-previous-")) {
      throw Object.assign(new Error("Runtime journal escaped its expected directory"), {
        code: "INVALID_RUNTIME_JOURNAL",
      });
    }
  }

  async function recover(runtime, journalPath, options, warnings) {
    const journal = await readJson(journalPath);
    if (!journal) return true;
    validateJournal(journal, runtime);
    const state = await readJson(path.join(runtime, ".seed-state.json"));
    const committed = state?.transaction === journal.id &&
      await exists(path.join(runtime, "generate_emu_config.exe"));
    if (committed) deps.validate(runtime);
    if (!committed && !(await exists(runtime)) && await exists(journal.previous)) {
      await io("recover-previous", () => fsp.rename(journal.previous, runtime), options);
    }
    if (!committed && await exists(journal.previous) && await exists(runtime)) {
      throw Object.assign(new Error("Both runtime versions retained for recovery"), {
        code: "RUNTIME_RECOVERY_CONFLICT",
      });
    }
    let cleared = await cleanup(journal.stage, options, warnings);
    if (committed) {
      cleared = (await cleanup(journal.previous, options, warnings)) && cleared;
      cleared = (await cleanup(`${runtime}.preserve`, options, warnings)) && cleared;
    }
    // Removing a completed journal is cleanup too; it cannot invalidate the
    // already promoted runtime if Windows temporarily denies deletion.
    if (cleared) cleared = await cleanup(journalPath, options, warnings);
    return cleared;
  }

  async function work(options) {
    const runtime = deps.resolveDir(options.userDataDir);
    const parent = path.dirname(runtime);
    const journalPath = path.join(parent, ".schema_parse-transaction.json");
    const legacy = `${runtime}.preserve`;
    const warnings = [];
    let committed = false;
    try {
      const archive = deps.resolveArchive(options);
      if (!archive) {
        throw Object.assign(new Error("schema_parse seed archive not found"), {
          code: "SCHEMA_PARSE_SEED_MISSING", prepareStage: "resolve-archive",
        });
      }
      const hash = await deps.hash(archive);
      deps.ensureEnv();
      await io("create-tools-directory", () => fsp.mkdir(parent, { recursive: true }), options);
      const recovered = await recover(runtime, journalPath, options, warnings);
      const state = await readJson(path.join(runtime, ".seed-state.json"));
      const hadExecutable = await exists(path.join(runtime, "generate_emu_config.exe"));
      const needsExtract = !hadExecutable || state?.archiveHash !== hash;
      if (!needsExtract) {
        deps.validate(runtime);
        // Restore only missing files left by an older interrupted update.
        // Active credentials and output always take priority over .preserve.
        if (await exists(legacy)) await copyMutable(legacy, runtime, options, false);
      } else {
        if (!recovered) {
          throw Object.assign(new Error("Pending cleanup prevents another runtime update"), {
            code: "RUNTIME_CLEANUP_PENDING",
          });
        }
        const id = crypto.randomBytes(8).toString("hex");
        const transaction = {
          id, runtime,
          stage: path.join(parent, `.schema_parse-stage-${id}`),
          previous: path.join(parent, `.schema_parse-previous-${id}`),
          phase: "extracting",
        };
        await writeJson(journalPath, transaction, options, "write-journal");
        await io("create-staging-directory", () => fsp.mkdir(transaction.stage, { recursive: true }), options);
        log("info", "schema-parse:bootstrap:start", {
          runtimeDir: runtime, reason: options.reason || "runtime",
          operationId: options.generationId || "session",
        });
        try {
          await deps.extract(archive, transaction.stage, options);
        } catch (error) {
          error.prepareStage ??= "extract";
          throw error;
        }
        // Backups override bundled defaults; active files override backups.
        // Sources remain untouched until promotion has succeeded.
        await copyMutable(legacy, transaction.stage, options, true);
        await copyMutable(runtime, transaction.stage, options, true);
        await io("validate-staging-runtime", () => deps.validate(transaction.stage), options);
        await writeJson(path.join(transaction.stage, ".seed-state.json"), {
          archivePath: archive, archiveHash: hash,
          extractedAt: new Date().toISOString(), transaction: id,
        }, options, "write-seed-state");
        options.signal?.throwIfAborted();
        transaction.phase = "promoting";
        await writeJson(journalPath, transaction, options, "write-journal");
        if (await exists(runtime)) {
          await io("rename-old-runtime", () => fsp.rename(runtime, transaction.previous), options);
        }
        try {
          await io("promote-runtime", () => fsp.rename(transaction.stage, runtime), options);
        } catch (error) {
          if (!(await exists(runtime)) && await exists(transaction.previous)) {
            await io("rollback-runtime", () => fsp.rename(transaction.previous, runtime), {
              ...options, signal: undefined,
            }).catch((rollback) => { error.rollback = describe(rollback, "rollback-runtime"); });
          }
          throw error;
        }
        committed = true;
        deps.validate(runtime);
        await recover(runtime, journalPath, options, warnings);
        log("info", "schema-parse:bootstrap:success", {
          runtimeDir: runtime, operationId: options.generationId || "session",
        });
      }
      const owners = path.join(runtime, "top_owners_ids.txt");
      let topOwnersRefreshed = false;
      if (options.refreshTopOwners === true || !(await exists(owners))) {
        try {
          await deps.refreshOwners({
            outputPath: owners, limit: options.topOwnersLimit || 250,
            timeoutMs: options.topOwnersTimeoutMs || 30000, headless: true,
          });
          topOwnersRefreshed = true;
        } catch (error) {
          if (options.signal?.aborted || isCancelled(error)) throw error;
          if (!(await exists(owners))) {
            error.prepareStage = "refresh-top-owners";
            throw error;
          }
          warnings.push(describe(error, "refresh-top-owners"));
          log("warn", "schema-parse:top-owners:local-fallback", describe(error, "refresh-top-owners"));
        }
      }
      return {
        runtimeDir: runtime, seedArchive: archive,
        bootstrapped: needsExtract && !hadExecutable,
        updated: needsExtract && hadExecutable,
        status: warnings.length ? "ready-with-fallback" : "ready",
        fallback: warnings.length > 0, warnings,
        topOwnersPath: owners, topOwnersRefreshed,
      };
    } catch (cause) {
      if (options.signal?.aborted || isCancelled(cause)) throw options.signal?.reason || cause;
      const stage = cause.prepareStage || "runtime-preparation";
      const error = Object.assign(new Error(`Schema Parse is unavailable: ${cause.message || cause}`, {
        cause,
      }), {
        code: "SCHEMA_PARSE_RUNTIME_UNAVAILABLE", nativeCode: cause.code,
        stage, syscall: cause.syscall, path: cause.path, dest: cause.dest,
        runtimeDir: runtime, committed, rollback: cause.rollback,
      });
      log("error", "schema-parse:runtime:unavailable", {
        ...describe(cause, stage), operationId: options.generationId || "session",
        runtimeDir: runtime, committed,
      });
      // Boot records availability; notify when generation needs this source.
      if (!String(options.reason || "").startsWith("boot")) {
        try { unavailableHandler?.(error); } catch {}
      }
      throw error;
    }
  }

  function prepare(options = {}) {
    options.signal?.throwIfAborted();
    const runtime = deps.resolveDir(options.userDataDir);
    const key = `${runtime}\0${options.generationId || "session"}`;
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(runtime)) {
      return inflight.get(runtime).then(() => prepare(options), () => prepare(options));
    }
    const pending = deps.coordinate("prepare", options, () => work(options));
    cache.set(key, pending);
    inflight.set(runtime, pending);
    const finish = (error) => {
      if (inflight.get(runtime) === pending) inflight.delete(runtime);
      if (options.signal?.aborted || isCancelled(error)) cache.delete(key);
      else completed.add(key);
      // Bound historical operations while retaining one result per active lot.
      while (completed.size > MAX_CACHED_OPERATIONS) {
        const oldest = completed.values().next().value;
        completed.delete(oldest);
        cache.delete(oldest);
      }
    };
    pending.then(() => finish(), finish);
    return pending;
  }

  return { prepare, describe };
}

module.exports = { createRuntimePreparer, configureSchemaParseRuntimeNotifications };
