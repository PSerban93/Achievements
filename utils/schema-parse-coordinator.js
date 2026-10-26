"use strict";

const path = require("path");
const { createLogger } = require("./logger");

const logger = createLogger("schema-parse");
const IPC_ENV = "ACHIEVEMENTS_SCHEMA_PARSE_COORDINATED";
// The main process owns the queue shared by all generator forks. Ownership
// includes runtime preparation, execution, copying results and cleanup.
const queue = [];
const requests = new Set();
let active = null;
let nextId = 0;
let lifecycleAttached = false;
let stopping = false;

function cancelled(message = "Schema generation cancelled") {
  const error = new Error(message);
  error.code = "SCHEMA_PARSE_CANCELLED";
  return error;
}

function notifyState(options, state) {
  try { options.onQueueState?.(state); } catch {}
}

function pump() {
  if (active || !queue.length) return;
  const job = active = queue.shift();
  job.options.signal?.removeEventListener("abort", job.abortQueued);
  const waitMs = Date.now() - job.queuedAt;
  logger.info("schema-parse:queue:started", { id: job.id, kind: job.kind, waitMs, pending: queue.length });
  notifyState(job.options, { state: "running", waitMs });
  Promise.resolve().then(() => {
    job.options.signal?.throwIfAborted();
    return job.execute();
  }).then(job.resolve, job.reject).finally(() => {
    active = null;
    logger.info("schema-parse:queue:released", { id: job.id, pending: queue.length });
    pump();
  });
}

function runExclusive(kind, options, execute) {
  return new Promise((resolve, reject) => {
    if (stopping || options.signal?.aborted) {
      reject(options.signal?.reason || cancelled("Schema coordinator is closing")); return;
    }
    const job = { id: ++nextId, kind, options, execute, resolve, reject, queuedAt: Date.now() };
    job.abortQueued = () => {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      logger.info("schema-parse:queue:cancelled", { id: job.id, pending: queue.length });
      reject(options.signal.reason || cancelled());
    };
    queue.push(job);
    options.signal?.addEventListener("abort", job.abortQueued, { once: true });
    logger.info("schema-parse:queue:queued", { id: job.id, kind, appid: options.appid || null, pending: queue.length });
    if (active || queue.length > 1) notifyState(options, { state: "queued", position: queue.length });
    queueMicrotask(pump);
  });
}

function requestRemote(kind, options) {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(cancelled("Schema coordinator connection unavailable")); return;
    }
    const id = `${process.pid}:${++nextId}`;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      error ? reject(error) : resolve(result);
    };
    const onDisconnect = () => finish(cancelled("Schema coordinator disconnected"));
    const onMessage = message => {
      if (message?.id !== id) return;
      if (message.type === "schema-parse:state") { notifyState(options, message.state); return; }
      if (message.type === "schema-parse:progress") {
        try { options.onProgress?.(message.progress); } catch {}
        return;
      }
      if (message.type !== "schema-parse:result") return;
      if (message.error) {
        const error = Object.assign(new Error(message.error.message), message.error);
        finish(error); return;
      }
      const result = message.result;
      if (kind === "batch" && result) {
        result.results = new Map(result.results || []);
        result.batchErrors = (result.batchErrors || []).map(error => Object.assign(new Error(error.message), error));
        if (result.batchError) result.batchError = Object.assign(new Error(result.batchError.message), result.batchError);
      }
      finish(null, result);
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send({ type: "schema-parse:request", id, kind, options: {
      appid: options.appid, outDir: options.outDir, items: options.items,
      reason: options.reason, generationId: options.generationId, chunkSize: options.chunkSize,
    } }, error => { if (error) finish(error); });
  });
}

function coordinateSchemaParse(kind, options, execute) {
  return process.env[IPC_ENV] === "1" ? requestRemote(kind, options) : runExclusive(kind, options, execute);
}

function errorData(error) {
  return { message: String(error?.message || error), code: error?.code,
    stdout: error?.stdout, stderr: error?.stderr,
    downloadWarnings: error?.downloadWarnings, nativeCode: error?.nativeCode, stage: error?.stage, syscall: error?.syscall, path: error?.path, dest: error?.dest, committed: error?.committed };
}

function attachSchemaParseCoordinator(child, { userDataDir, schemaRoot, deadline }) {
  const pending = new Map();
  let waiting = 0;
  let closed = false;
  const root = path.resolve(schemaRoot);
  const send = message => { try { if (!closed && child.connected) child.send(message, () => {}); } catch {} };
  const outputPath = value => {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Invalid schema output directory");
    const output = path.resolve(value);
    const relative = path.relative(root, output);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Schema output directory is outside the generator destination");
    }
    return output;
  };
  const onMessage = message => {
    if (closed || message?.type !== "schema-parse:request") return;
    if (typeof message.id !== "string" || pending.has(message.id)) return;
    const id = message.id;
    const controller = new AbortController();
    const record = { controller, waiting: false };
    pending.set(id, record); requests.add(controller);
    Promise.resolve().then(async () => {
      const input = message.options || {};
      if (stopping) throw cancelled("Application is closing");
      const options = { userDataDir, reason: String(input.reason || "generator"), generationId: String(input.generationId || "session"), signal: controller.signal,
        onQueueState: state => {
          if (state.state === "queued" && !record.waiting) {
            record.waiting = true; waiting++; deadline?.pause();
          } else if (state.state === "running" && record.waiting) {
            record.waiting = false;
            if (--waiting === 0) deadline?.resume();
          }
          send({ type: "schema-parse:state", id, state });
        },
        onProgress: progress => send({ type: "schema-parse:progress", id, progress }),
      };
      const schema = require("./steam-schema-parse");
      let result;
      if (message.kind === "single") {
        if (!/^\d+$/.test(String(input.appid || ""))) throw new Error("Invalid Steam AppID");
        result = await schema.generateSteamSchemaWithSchemaParse({ ...options, appid: input.appid, outDir: outputPath(input.outDir) });
      } else if (message.kind === "batch") {
        if (!Array.isArray(input.items) || !input.items.length) throw new Error("Invalid schema batch");
        const items = input.items.map(item => {
          if (!/^\d+$/.test(String(item?.appid || ""))) throw new Error("Invalid Steam AppID");
          return { appid: item.appid, resultKey: String(item.resultKey || item.appid), outDir: outputPath(item.outDir) };
        });
        result = await schema.generateSteamSchemasWithSchemaParseBatch({ ...options, items,
          chunkSize: Number.isInteger(input.chunkSize) && input.chunkSize > 0 ? Math.min(20, input.chunkSize) : 20 });
        result = { ...result, results: [...result.results], batchError: result.batchError ? errorData(result.batchError) : null,
          batchErrors: (result.batchErrors || []).map(errorData) };
      } else throw new Error("Invalid schema operation");
      send({ type: "schema-parse:result", id, result });
    }).catch(error => send({ type: "schema-parse:result", id, error: errorData(error) })).finally(() => {
      if (record.waiting && --waiting === 0) deadline?.resume();
      pending.delete(id); requests.delete(controller);
    });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    child.off("message", onMessage);
    for (const { controller } of pending.values()) controller.abort(cancelled("Schema requester closed"));
  };
  child.on("message", onMessage);
  child.once("disconnect", close);
  child.once("exit", close);
  child.once("close", close);
  child.once("error", close);
  if (!lifecycleAttached) {
    try {
      const app = require("electron").app;
      if (app?.once) {
        app.once("before-quit", () => {
          stopping = true;
          for (const controller of requests) controller.abort(cancelled("Application is closing"));
        });
        lifecycleAttached = true;
      }
    } catch {}
  }
}

module.exports = { coordinateSchemaParse, attachSchemaParseCoordinator, IPC_ENV };
