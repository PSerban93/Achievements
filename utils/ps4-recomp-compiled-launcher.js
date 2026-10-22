"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const cache = new Map();
let queue = Promise.resolve();
function regular(file) { try { const s = fs.lstatSync(file); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } }
function directory(file) { try { const s = fs.lstatSync(file); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function inside(root, file) { const rel = path.relative(root, file); return !rel || !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); }
function candidates(root) {
  // Never inspect executables in arbitrary save folders or parent libraries.
  if (!directory(root) || !["out", "game/image"].some((dir) => directory(path.join(root, dir)) &&
      ["boot-linked.bin", "content.bin", "boot.bin"].some((name) => regular(path.join(root, dir, name))))) return [];
  const files = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && !e.isSymbolicLink() && /\.exe$/i.test(e.name));
  if (files.length > 16) return [];
  return files.map((e) => { const file = path.join(root, e.name), s = fs.lstatSync(file); return { file, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; })
    .filter((e) => e.size >= 88 && e.size <= 32 * 1024 * 1024).sort((a, b) => a.file.localeCompare(b.file));
}
function stamp(files) { return JSON.stringify(files); }
function prepare(root, { force = false, isBlocked = () => false } = {}) {
  root = path.resolve(root); const key = root.toLowerCase();
  if (isBlocked(root)) return Promise.resolve(null);
  const files = candidates(root).filter((entry) => !isBlocked(entry.file));
  if (!files.length) { cache.delete(key); return Promise.resolve(null); }
  const signature = stamp(files), existing = cache.get(key);
  if (existing?.signature === signature && !force) return existing.promise;
  existing?.cancel?.();
  while (cache.size >= 64) { const [oldKey, old] = cache.entries().next().value; old.cancel?.(); cache.delete(oldKey); }
  const entry = { signature, root, files, cancelled: false, data: null }; cache.set(key, entry);
  entry.promise = queue.then(() => new Promise((resolve) => {
    if (entry.cancelled || cache.get(key) !== entry) return resolve(null);
    const worker = new Worker(__filename, { workerData: { files: files.map((e) => e.file) }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    let done = false;
    const finish = (data) => {
      if (done) return; done = true; clearTimeout(timer); void worker.terminate();
      try {
        if (!entry.cancelled && cache.get(key) === entry && stamp(candidates(root).filter((e) => !isBlocked(e.file))) === signature) entry.data = data;
      } catch { /* A removed/inaccessible installation cannot publish a late result. */ }
      resolve(entry.cancelled ? null : entry.data);
    };
    const timer = setTimeout(() => finish({ contracts: [], errors: ["Compiled PS4 launcher analysis timed out"] }), 4000);
    entry.cancel = () => { entry.cancelled = true; finish(null); };
    worker.once("message", finish);
    worker.once("error", (e) => finish({ contracts: [], errors: [e.message] }));
    worker.once("exit", () => finish(null));
  }));
  // Serial worker analysis keeps imports of several folders from competing.
  queue = entry.promise.catch(() => null);
  return entry.promise;
}
function forget(root, remaining = []) {
  root = path.resolve(root);
  for (const [key, entry] of cache) if (inside(root, entry.root) && !remaining.some((other) => inside(path.resolve(other), entry.root))) {
    entry.cancelled = true; entry.cancel?.(); cache.delete(key);
  }
}
function cached(root) { return cache.get(path.resolve(root).toLowerCase())?.data || null; }
function restore(root, hints) {
  if (cached(root)) return;
  const files = candidates(root), signature = stamp(files);
  if (!files.length) return;
  for (const hint of hints || []) {
    const saved = hint.ps4_recomp_compiled_launcher;
    if (typeof hint.ps4_recomp_install_root !== "string" || path.resolve(hint.ps4_recomp_install_root).toLowerCase() !== path.resolve(root).toLowerCase() ||
        saved?.version !== 1 || saved.signature !== signature || !Array.isArray(saved.contracts) || !saved.contracts.length || saved.contracts.length > 16 ||
        !saved.contracts.every((c) => files.some((e) => e.file === c.executable))) continue;
    const data = { contracts: saved.contracts, errors: [] };
    if (cache.size >= 64) { const [oldKey, old] = cache.entries().next().value; old.cancel?.(); cache.delete(oldKey); }
    cache.set(path.resolve(root).toLowerCase(), { root, signature, files, data, promise: Promise.resolve(data) }); return;
  }
}
function snapshot(root) {
  const entry = cache.get(path.resolve(root).toLowerCase());
  if (!entry?.data?.contracts?.length) return undefined;
  // Both GUI variants have already been checked for agreement by resolveContract.
  // Store path expressions only, never bytecode or a second progress journal.
  return { version: 1, signature: entry.signature, contracts: entry.data.contracts };
}
function resolveContract(root, data = cached(root), env = process.env) {
  if (!data?.contracts?.length) return null;
  const dependencies = new Set(), jsonCache = new Map(), existenceCache = new Map(); let operations = 0;
  function evaluate(node, executable, depth = 0) {
    if (++operations > 10000 || depth > 64) throw new Error("Compiled launcher paths exceed discovery limits");
    if (node === undefined || node === null || typeof node !== "object") return node;
    const read = (value) => evaluate(value, executable, depth + 1);
    switch (node.op) {
      case "executable": return executable;
      case "home": return os.homedir();
      case "env": return typeof env[node.key] === "string" && env[node.key] ? env[node.key] : read(node.fallback);
      case "if": return read(node.condition) ? read(node.yes) : read(node.no);
      case "path": case "str": return read(node.value);
      case "resolve": { const value = read(node.value); return typeof value === "string" ? path.resolve(root, value) : undefined; }
      case "expanduser": { const value = read(node.value); return typeof value === "string" ? value.replace(/^~(?=[\\/]|$)/, os.homedir()) : undefined; }
      case "strip": { const value = read(node.value); return typeof value === "string" ? value.trim() : undefined; }
      case "parent": { const value = read(node.value); return typeof value === "string" ? path.dirname(value) : undefined; }
      case "exists": {
        const file = read(node.value);
        if (typeof file !== "string" || !path.isAbsolute(file)) return false;
        const key = file + "|" + node.type;
        if (!existenceCache.has(key)) {
          let result = false;
          try { const stat = fs.lstatSync(file); result = node.type === "is_symlink" ? stat.isSymbolicLink() : !stat.isSymbolicLink() && (node.type !== "is_file" || stat.isFile()); } catch {}
          existenceCache.set(key, result);
        }
        return existenceCache.get(key);
      }
      case "join": {
        const left = read(node.left), right = read(node.right);
        return typeof left === "string" && typeof right === "string" ? path.resolve(left, right) : undefined;
      }
      case "json": {
        const file = read(node.value);
        if (typeof file !== "string" || !path.isAbsolute(file) || !/\.(?:json|ini)$/i.test(file)) return {};
        dependencies.add(file);
        if (jsonCache.has(file)) return jsonCache.get(file);
        if (!regular(file) || fs.statSync(file).size > 1024 * 1024) return {};
        const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        const result = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        jsonCache.set(file, result); return result;
      }
      case "get": { const value = read(node.value); return value && Object.hasOwn(value, node.key) ? value[node.key] : read(node.fallback); }
      default: return undefined;
    }
  }
  function logParent(node, executable) {
    const exact = evaluate(node, executable);
    if (typeof exact === "string" && path.isAbsolute(exact) && /\.log$/i.test(exact)) return { file: exact, directory: path.dirname(exact) };
    for (let i = 0; i < 64; i++) {
      if (["str", "path", "resolve"].includes(node?.op)) node = node.value;
      else if (node?.op === "if") node = evaluate(node.condition, executable) ? node.yes : node.no;
      else break;
    }
    if (node?.op === "join") {
      const parent = evaluate(node.left, executable);
      if (typeof parent === "string" && path.isAbsolute(parent)) return { directory: parent };
    }
    return {};
  }
  const broad = [os.homedir(), env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, path.dirname(root)].filter(Boolean).map((v) => path.resolve(v).toLowerCase());
  const narrow = (folder) => folder && folder !== path.parse(folder).root && !broad.includes(path.resolve(folder).toLowerCase());
  const contracts = data.contracts.map((item) => {
    if (!inside(root, item.executable) || !regular(item.executable)) return null;
    const settings = item.settings.map((node) => evaluate(node, item.executable)).filter((v) => typeof v === "string" && path.isAbsolute(v));
    const userRoots = [...new Set(item.users.map((node) => evaluate(node, item.executable)).filter((v) => typeof v === "string" && v).map((v) => path.resolve(root, v)))];
    if (userRoots.length !== 1) throw new Error("Compiled PS4 launchers disagree about the user directory");
    const logs = item.logs.map((node) => logParent(node, item.executable));
    const runtime = item.runtime.map((node) => evaluate(node, item.executable)).filter((v) => typeof v === "string" && path.isAbsolute(v) && inside(root, v) && regular(v));
    return { executable: item.executable, settings, userRoot: userRoots[0], logFiles: logs.map((v) => v.file).filter(Boolean),
      logDirectories: [...new Set(logs.map((v) => v.directory).filter(narrow))], runtime };
  }).filter(Boolean);
  if (!contracts.length) return null;
  const signatures = new Set(contracts.map((c) => JSON.stringify([c.settings.slice().sort(), c.userRoot, c.logFiles.slice().sort(), c.logDirectories.slice().sort()])));
  if (signatures.size !== 1) throw new Error("Compiled PS4 launchers select different settings or progress sources");
  return { ...contracts[0], executables: contracts.map((c) => c.executable), runtime: [...new Set(contracts.flatMap((c) => c.runtime))],
    dependencies: [...dependencies] };
}
if (!isMainThread) {
  const { archive } = require("./ps4-recomp-python-data");
  const { analyze } = require("./ps4-recomp-python-paths");
  const contracts = [], errors = [];
  for (const file of workerData.files) {
    try { const bundle = archive(file), result = bundle && analyze(bundle, file); if (result) contracts.push(result); }
    catch (error) { errors.push(`${path.basename(file)}: ${error.message}`); }
  }
  parentPort.postMessage({ contracts, errors });
}
module.exports = { prepare, forget, cached, resolveContract, candidates, restore, snapshot };
