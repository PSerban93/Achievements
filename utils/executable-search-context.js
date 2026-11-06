"use strict";

const fs = require("fs").promises;
const path = require("path");
const key = value => path.resolve(value).toLowerCase();
const inside = (root, file) => key(file) === key(root) || key(file).startsWith(key(root) + path.sep);
const signature = info => `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;

// Per-job caches hold only successful reads. Every search gets its own limits
// and stat snapshot; cached content is reused only while its signature matches.
function createSearchContext(options, dependencies) {
  const { discoverRoots, fixedDrives, skip, directSkip, specificHint, readPe } = dependencies;
  const directories = { rows: new Map(), count: 0 }, texts = new Map(), headers = new Map();
  let filesystemIndex, filesystemScan;
  const dirtyDirectories = new Set();
  const newBatch = () => ({ roots: new Map(), platformLibraries: new Map() });
  let batch = newBatch();
  const unavailableVolumes = new Map();
  let registryRows = options.registryRows, state;
  function startSearch() {
    state = { started: Date.now(), deadline: Date.now() + (options.timeLimitMs || 90_000),
      truncated: false, limits: new Set(), issues: new Map(), stats: new Map(), directoryReads: { rows: new Map(), count: 0 }, visited: new Set(),
      metrics: { directoriesRead: 0, directoryCacheHits: 0, metadataReads: 0, metadataCacheHits: 0, peReads: 0, peCacheHits: 0 } };
  }
  startSearch();
  function check() {
    if (options.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
  }
  function limit(reason) {
    state.truncated = true;
    state.limits.add(reason);
    throw Object.assign(new Error(`Search limit: ${reason}`), { code: "EXECUTABLE_SEARCH_LIMIT" });
  }
  function checkpoint() { check(); if (Date.now() > state.deadline) limit("time"); }
  function addMetric(name, value = 1) { state.metrics[name] = (state.metrics[name] || 0) + value; }
  async function measure(name, action) {
    const started = Date.now();
    try { return await action(); } finally { addMetric(name, Date.now() - started); }
  }
  function issue(operation, file, error, critical = false) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return;
    const entry = { operation, path: file, code: error?.code || "IO_ERROR" };
    if (state.issues.size < 20) state.issues.set(`${operation}:${key(file)}:${entry.code}`, entry);
    if (critical) { state.truncated = true; state.limits.add("unreadable-path"); }
  }
  function remember(map, file, value, maximum) {
    map.delete(file); map.set(file, value);
    if (map.size > maximum) map.delete(map.keys().next().value);
  }
  function rememberDirectory(cache, file, result) {
    const previous = cache.rows.get(file);
    if (previous) { cache.count -= previous.value.length; cache.rows.delete(file); }
    // File count matters as well as directory count on large installations.
    if (result.value.length > 100000) return;
    cache.rows.set(file, result); cache.count += result.value.length;
    while (cache.rows.size > 10000 || cache.count > 100000) {
      const oldest = cache.rows.keys().next().value;
      cache.count -= cache.rows.get(oldest).value.length; cache.rows.delete(oldest);
    }
  }
  function forgetDirectory(file) {
    const previous = directories.rows.get(file);
    if (previous) { directories.count -= previous.value.length; directories.rows.delete(file); }
  }
  function finishSearch(status) {
    // NTFS can coalesce directory timestamp updates. A failed/partial scan
    // must not turn a temporary absence into a reusable negative result.
    if (status === "not-found" || state.truncated) for (const file of state.visited) forgetDirectory(file);
  }
  async function stat(file, critical = false) {
    checkpoint();
    if (options.batchSnapshot) for (const [root, error] of unavailableVolumes) if (inside(root, file)) {
      if (critical) issue("stat", file, error, true);
      addMetric("unavailableVolumeSkips"); return null;
    }
    const id = key(file);
    if (!state.stats.has(id)) {
      addMetric("statReads");
      try { state.stats.set(id, { value: await fs.stat(file) }); }
      catch (error) { state.stats.set(id, { value: null, error }); }
      checkpoint();
    }
    const result = state.stats.get(id);
    if (result.error) issue("stat", file, result.error, critical);
    return result.value;
  }
  async function entries(file, critical = false) {
    checkpoint();
    const id = key(file);
    if (state.directoryReads.rows.has(id)) {
      const result = state.directoryReads.rows.get(id);
      if (result.error) issue("readdir", file, result.error, critical);
      return result.value;
    }
    const info = await stat(file, critical);
    if (!info?.isDirectory()) return [];
    const stamp = signature(info), cached = directories.rows.get(id);
    if (cached?.stamp === stamp) {
      state.metrics.directoryCacheHits++;
      rememberDirectory(state.directoryReads, id, cached);
      return cached.value;
    }
    state.metrics.directoriesRead++;
    let result;
    try {
      result = { stamp, value: await fs.readdir(file, { withFileTypes: true }) };
      rememberDirectory(directories, id, result);
    } catch (error) {
      forgetDirectory(id);
      result = { value: [], error };
      issue("readdir", file, error, critical);
    }
    rememberDirectory(state.directoryReads, id, result);
    checkpoint();
    return result.value;
  }
  async function text(file, critical = true) {
    checkpoint();
    const info = await stat(file, critical);
    if (!info?.isFile() || info.size > 256 * 1024) return "";
    const id = key(file), stamp = signature(info), cached = texts.get(id);
    if (cached?.stamp === stamp) { state.metrics.metadataCacheHits++; return cached.value; }
    try {
      state.metrics.metadataReads++;
      const value = (await fs.readFile(file, { encoding: "utf8", signal: options.signal })).replace(/^\uFEFF/, "");
      // Bound cached text memory independently of the number of candidates.
      if (info.size <= 32 * 1024) remember(texts, id, { stamp, value }, 256);
      checkpoint();
      return value;
    } catch (error) {
      if (["ABORT_ERR", "EXECUTABLE_SEARCH_LIMIT"].includes(error.code)) throw error;
      texts.delete(id); issue("readFile", file, error, critical); return "";
    }
  }
  async function pe(file, machine = false) {
    checkpoint();
    const info = await stat(file, true);
    if (!info?.isFile()) return false;
    const id = key(file), stamp = signature(info), cached = headers.get(id);
    let value;
    if (cached?.stamp === stamp) { state.metrics.peCacheHits++; value = cached.value; }
    else {
      state.metrics.peReads++;
      let failed = false;
      value = await readPe(file, true, error => { failed = true; issue("pe", file, error, true); });
      if (!failed && value !== false) remember(headers, id, { stamp, value }, 20000);
      else headers.delete(id);
    }
    checkpoint();
    return value !== false ? machine ? value : true : false;
  }
  async function discovery() {
    checkpoint();
    const cache = options.batchSnapshot ? batch : state;
    if (!cache.discovery) cache.discovery = (options.discover === false ? Promise.resolve({ roots: [], installs: [], installations: [] }) :
      discoverRoots({ ...options, registryRows, onRegistryRows: rows => { registryRows = rows; } },
        { stat, text: file => text(file, false), entries, checkpoint, directFolders, volumes }))
      .catch(error => { delete cache.discovery; throw error; });
    return cache.discovery;
  }
  async function volumes() {
    const cache = options.batchSnapshot ? batch : state;
    if (!cache.volumes) cache.volumes = (async () => {
      const disks = options.drives || (options.discover === false ? [] : fixedDrives(options.env || process.env)), available = [];
      for (const disk of disks) {
        const info = await stat(disk);
        if (info?.isDirectory()) await entries(disk);
        const failure = state.stats.get(key(disk))?.error || state.directoryReads.rows.get(key(disk))?.error;
        if (info?.isDirectory() && !failure) available.push(disk);
        else if (options.batchSnapshot) {
          const error = failure || { code: "VOLUME_UNAVAILABLE" };
          unavailableVolumes.set(disk, error);
          try { options.onVolumeUnavailable?.({ volume: disk, code: error.code || "IO_ERROR" }); } catch {}
        }
      }
      return available;
    })().catch(error => { delete cache.volumes; throw error; });
    return cache.volumes;
  }
  async function installations() { return (await discovery()).installations || []; }
  async function foreignLibraries(platform) {
    const found = await discovery(), result = [];
    for (const [family, source] of Object.entries(found.platformRoots || {})) {
      if (family === platform) continue;
      const cache = options.batchSnapshot ? batch : state;
      cache.platformLibraries ||= new Map();
      if (!cache.platformLibraries.has(family)) cache.platformLibraries.set(family,
        typeof source === "function" ? await source() : source || []);
      result.push(...cache.platformLibraries.get(family));
    }
    return result;
  }
  async function roots(platform = "") {
    checkpoint();
    const cache = options.batchSnapshot ? batch : state;
    cache.roots ||= new Map();
    if (!cache.roots.has(platform)) cache.roots.set(platform, (async () => {
      const found = await discovery(), folders = new Map();
      const platformSource = found.platformRoots?.[platform];
      const platformRoots = typeof platformSource === "function" ? await platformSource() : platformSource || [];
      for (const root of [...found.roots, ...platformRoots, ...(options.roots || [])]) {
        checkpoint();
        for (const entry of await entries(root)) if (entry.isDirectory() && !entry.isSymbolicLink() && !skip.test(entry.name)) {
          const dir = path.join(root, entry.name); folders.set(key(dir), dir);
          if (folders.size >= 4000) limit("library-folders");
          if (folders.size < 2000) for (const child of await entries(dir)) if (child.isDirectory() && !child.isSymbolicLink() && !skip.test(child.name)) {
            const nested = path.join(dir, child.name); folders.set(key(nested), nested);
            if (folders.size >= 4000) limit("library-folders");
          }
        }
      }
      for (const dir of found.installs) folders.set(key(dir), dir);
      return [...folders.values()];
    })().catch(error => { cache.roots.delete(platform); throw error; }));
    return cache.roots.get(platform);
  }
  async function directFolders() {
    checkpoint();
    const cache = options.batchSnapshot ? batch : state;
    if (!cache.direct) cache.direct = (async () => {
      const dirs = [], disks = await volumes();
      for (const disk of disks) for (const entry of await entries(disk)) {
        checkpoint();
        if (!entry.isDirectory() || entry.isSymbolicLink() || directSkip.test(entry.name) || skip.test(entry.name)) continue;
        if (dirs.length >= 1024) limit("disk-folders");
        dirs.push(path.join(disk, entry.name));
      }
      return dirs;
    })().catch(error => { delete cache.direct; throw error; });
    return cache.direct;
  }
  async function directMatches(hints, relative) {
    const specific = hints.filter(specificHint);
    if (!specific.length) return [];
    const dirs = await directFolders();
    const cache = options.batchSnapshot ? batch : state;
    if (!cache.directIndex) cache.directIndex = (async () => {
      const index = new Map();
      for (const root of dirs) for (const sub of ["", "bin", "bin/x64", "bin/win64", "Binaries/Win64"]) {
        checkpoint();
        // Do not follow a junction in one of the shallow binary directories.
        let dir = root, available = true;
        for (const segment of sub.split("/").filter(Boolean)) {
          const child = (await entries(dir)).find(entry => entry.name.toLowerCase() === segment.toLowerCase() && entry.isDirectory() && !entry.isSymbolicLink());
          if (!child) { available = false; break; }
          dir = path.join(dir, child.name);
        }
        if (!available) continue;
        for (const entry of await entries(dir)) if (entry.isFile() && !entry.isSymbolicLink() && /\.exe$/i.test(entry.name)) {
          const name = entry.name.toLowerCase();
          if (!index.has(name)) index.set(name, new Set());
          index.get(name).add(root);
        }
      }
      return index;
    })().catch(error => { delete cache.directIndex; throw error; });
    const index = await cache.directIndex, result = new Set();
    for (const hint of specific) for (const root of index.get(hint.toLowerCase()) || []) result.add(root);
    if (relative && !path.isAbsolute(relative)) for (const root of dirs) {
      checkpoint();
      const target = path.resolve(root, relative.replace(/\\/g, path.sep));
      if (inside(root, target) && (await stat(target))?.isFile()) result.add(root);
    }
    return [...result];
  }
  async function filesystemMatches(hints, controls = {}) {
    const specific = [...new Set(hints.filter(specificHint).map(name => name.toLowerCase()))];
    if (!specific.length && !controls.revalidate) return [];
    const matches = index => [...new Set(specific.flatMap(name => [...(index.get(name) || [])]))];
    const deliver = async files => {
      for (const file of files) { checkpoint(); await controls.onMatch?.(file); }
      return files;
    };
    // Only explicit Find All jobs reuse a completed index. Automatic searches
    // get a fresh snapshot; no persistent index or background watcher is added.
    let refreshScan;
    if (options.batchSnapshot && filesystemIndex && !controls.revalidate) {
      const available = await measure("indexLookupMs", async () => {
        const files = [];
        for (const file of matches(filesystemIndex.files)) {
          if ((await stat(file))?.isFile()) files.push(file);
          else dirtyDirectories.add(path.dirname(file));
        }
        return files;
      });
      state.metrics.filesystemIndexReused = true;
      return deliver(available);
    }
    if (options.reuseFilesystemIndex && filesystemIndex) {
      const changed = new Set(dirtyDirectories);
      await measure("indexRevalidationMs", async () => {
        for (const [dir, stamp] of filesystemIndex.snapshot) {
          addMetric("indexSnapshotChecks");
          const blocked = [...unavailableVolumes.keys()].find(root => inside(root, dir));
          if (blocked) { changed.add(blocked); continue; }
          const info = await stat(dir);
          if (!info || signature(info) !== stamp) changed.add(dir);
        }
      });
      const availableVolumes = await volumes();
      for (const dir of availableVolumes) if (!(filesystemIndex.volumes || []).some(root => key(root) === key(dir))) changed.add(dir);
      if (!changed.size) {
        const cached = matches(filesystemIndex.files), available = [];
        for (const file of cached) {
          if ((await stat(file))?.isFile()) available.push(file);
          else changed.add(path.dirname(file));
        }
        // A fresh signature check also validates an empty lookup within this
        // job; do not rebuild the entire inventory for every absent runtime.
        if (available.length === cached.length) {
          state.metrics.filesystemIndexReused = true;
          return deliver(available);
        }
      }
      const roots = [...changed];
      refreshScan = { files: filesystemIndex.files, snapshot: filesystemIndex.snapshot, queued: new Set(roots.map(key)),
        queue: roots, next: [], cursor: 0, active: null, fileCount: 0, directoryCount: 0, fatal: null,
        covered: filesystemIndex.covered, holes: filesystemIndex.holes, volumes: availableVolumes,
        deadline: filesystemIndex.deadline, refresh: true };
      state.metrics.filesystemRefresh = true;
    }
    filesystemIndex = null;
    state.metrics.filesystemSearch = true;
    let scan = refreshScan || options.reuseFilesystemIndex && filesystemScan;
    if (!scan) {
      const disks = await volumes();
      const roots = [...new Map(disks.map(dir => [key(dir), dir])).values()];
      scan = { files: new Map(), snapshot: new Map(), queued: new Set(roots.map(key)), queue: roots, next: [], cursor: 0,
        covered: new Set(), holes: new Set(), volumes: roots,
        active: null, fileCount: 0, directoryCount: 0, fatal: null,
        deadline: options.filesystemTimeLimitMs ? Date.now() + options.filesystemTimeLimitMs : Infinity };
    } else if (!refreshScan) {
      state.metrics.filesystemResumed = true;
      state.metrics.filesystemResumeFrom = scan.directoryCount;
      await deliver(matches(scan.files));
    }
    if (options.reuseFilesystemIndex) filesystemScan = scan;
    const index = scan.files, snapshot = scan.snapshot;
    const chunkSize = options.maxFilesystemDirectories || 25000;
    const retries = Math.max(0, Math.min(8, options.filesystemRetries ?? 3));
    let chunkCount = 0, passes = 1, prepared = false;
    state.metrics.filesystemPasses = passes;
    state.metrics.filesystemDirectories = scan.directoryCount;
    const filesystemCheckpoint = () => {
      checkpoint();
      if (Date.now() > scan.deadline) limit("filesystem-time");
      if (scan.fatal) limit(scan.fatal);
    };
    const reportRetry = reason => {
      const progress = { reason, pass: passes, chunkSize, completedDirectories: scan.directoryCount,
        pendingDirectories: scan.queue.length - scan.cursor + scan.next.length };
      try { options.onFilesystemRetry?.(progress); } catch {} // Reporting must not break discovery.
    };
    if (state.metrics.filesystemResumed) reportRetry("resume");
    const system = /^(?:Windows|WinSxS|AppData|ProgramData|Recovery|System Volume Information|Config\.Msi|\$.*|\.Trash.*)$/i;
    const enqueue = (dir, target) => {
      const id = key(dir);
      if (scan.queued.has(id)) return;
      // Existing directories were all stat-checked before refresh. Revisit
      // only changed ones plus new subtrees, rather than rebuilding the volume.
      if (scan.refresh && snapshot.has(dir)) return;
      if (scan.queued.size >= 100000) { scan.fatal = "filesystem-queue"; limit(scan.fatal); }
      scan.queued.add(id); target.push(dir);
    };
    // Breadth first across volumes: arbitrary library/container names are
    // traversed, including Program Files and relocated installations. Reparse
    // points, OS data and existing asset/backup exclusions are not followed.
    try {
      while (scan.queue.length) {
        filesystemCheckpoint();
        if (scan.cursor >= scan.queue.length) {
          scan.queue = scan.next; scan.next = []; scan.cursor = 0; prepared = false;
          continue;
        }
        // All matching game folders at this depth form a targeted scope, just
        // like launcher library matches. Validate them before traversing the
        // unrelated subtrees; compare sibling installations before selecting.
        if (!scan.active && !prepared) {
          const pending = scan.queue.slice(scan.cursor), preferred = pending.filter(dir => controls.preferDirectory?.(dir));
          for (const dir of preferred) { filesystemCheckpoint(); await controls.onDirectory?.(dir); }
          if (preferred.length && await controls.preferredComplete?.()) {
            state.metrics.filesystemScope = "matching-game-folders";
            return matches(index);
          }
          const preferredKeys = new Set(preferred.map(key));
          scan.queue = [...preferred, ...pending.filter(dir => !preferredKeys.has(key(dir)))];
          scan.cursor = 0; prepared = true;
        }
        if (!scan.active) {
          if (chunkCount >= chunkSize) {
            if (passes > retries) limit("filesystem-directories");
            passes++; chunkCount = 0;
            state.metrics.filesystemPasses = passes;
            state.metrics.filesystemRetries = passes - 1;
            reportRetry("directory-batch");
            await new Promise(resolve => setImmediate(resolve));
            filesystemCheckpoint();
          }
          scan.active = { dir: scan.queue[scan.cursor], list: null, position: 0 };
          chunkCount++;
          state.metrics.filesystemDirectories = ++scan.directoryCount;
          options.onProgress?.({ directories: state.visited.size + scan.directoryCount, folder: scan.active.dir });
        }
        const active = scan.active;
        if (!active.list) {
          active.list = await entries(active.dir);
          const info = await stat(active.dir);
          if (info && !state.directoryReads.rows.get(key(active.dir))?.error) {
            scan.covered.add(key(active.dir)); scan.holes.delete(key(active.dir));
          } else scan.holes.add(key(active.dir));
          if (scan.refresh && !state.directoryReads.rows.get(key(active.dir))?.error) {
            const present = new Set(active.list.filter(entry => entry.isFile()).map(entry => key(path.join(active.dir, entry.name))));
            for (const [name, files] of index) {
              for (const file of files) if ((!info && inside(active.dir, file)) ||
                key(path.dirname(file)) === key(active.dir) && !present.has(key(file))) files.delete(file);
              if (!files.size) index.delete(name);
            }
            if (!info) {
              for (const dir of snapshot.keys()) if (inside(active.dir, dir)) snapshot.delete(dir);
              for (const dir of scan.covered) if (inside(active.dir, dir)) scan.covered.delete(dir);
            }
          }
          if (info) snapshot.set(active.dir, signature(info));
        }
        while (active.position < active.list.length) {
            filesystemCheckpoint();
            const entry = active.list[active.position++];
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory() && !skip.test(entry.name)) {
              if (system.test(entry.name)) scan.holes.add(key(path.join(active.dir, entry.name)));
              else enqueue(path.join(active.dir, entry.name), scan.next);
            }
            if (entry.isFile() && /\.exe$/i.test(entry.name)) {
              if (++scan.fileCount > 100000) { scan.fatal = "filesystem-executables"; limit(scan.fatal); }
              const name = entry.name.toLowerCase(), file = path.join(active.dir, entry.name);
              if (!index.has(name)) index.set(name, new Set());
              index.get(name).add(file);
              if (specific.includes(name)) { state.metrics.filesystemMatches = (state.metrics.filesystemMatches || 0) + 1; await controls.onMatch?.(file); }
            }
        }
        scan.active = null; scan.cursor++;
      }
      checkpoint();
    } catch (error) {
      // The current directory/entry and pending queue remain in memory for
      // Find All. A later config can continue, never inherit a cached failure.
      throw error;
    }
    if (options.reuseFilesystemIndex) filesystemIndex = { files: index, snapshot, deadline: scan.deadline,
      covered: scan.covered, holes: scan.holes, volumes: scan.volumes };
    filesystemScan = null;
    state.metrics.filesystemScope = "volumes";
    return matches(index);
  }
  function isFilesystemCovered(root) {
    return !!filesystemIndex?.covered.has(key(root)) && ![...filesystemIndex.holes].some(dir => inside(root, dir) || inside(dir, root));
  }
  async function refreshBatch() {
    startSearch();
    const oldDiscovery = batch.discovery ? await batch.discovery : null;
    const oldDirect = batch.direct ? await batch.direct : [];
    const oldRoots = new Map();
    for (const [platform, value] of batch.roots) oldRoots.set(platform, await value);
    const fingerprints = files => new Map([...(files || [])].map(([name, paths]) => [name, [...paths].map(key).sort().join("\n")]));
    const before = fingerprints((filesystemIndex || filesystemScan)?.files);
    batch = newBatch(); registryRows = options.registryRows; unavailableVolumes.clear();
    let metadataChanged = JSON.stringify(oldDiscovery) !== JSON.stringify(await discovery());
    const sorted = values => values.map(key).sort().join("\n");
    if (sorted(oldDirect) !== sorted(await directFolders())) metadataChanged = true;
    for (const [platform, value] of oldRoots) if (sorted(value) !== sorted(await roots(platform))) metadataChanged = true;
    if (filesystemIndex || filesystemScan) {
      try { await filesystemMatches([], { revalidate: true }); }
      catch (error) { if (error.code !== "EXECUTABLE_SEARCH_LIMIT") throw error; }
    }
    dirtyDirectories.clear();
    const after = fingerprints((filesystemIndex || filesystemScan)?.files);
    const inventoryChanged = before.size !== after.size || [...before].some(([name, value]) => after.get(name) !== value);
    return { changed: metadataChanged || inventoryChanged, metadataChanged, inventoryChanged, truncated: state.truncated, diagnostics: { ...state.metrics, limits: [...state.limits] } };
  }
  async function walk(root) {
    const result = [], queue = [{ dir: root, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      checkpoint();
      const { dir, depth } = queue[cursor], id = key(dir);
      if (!state.visited.has(id)) {
        if (state.visited.size >= (options.maxDirectories || 7000)) limit("directories");
        state.visited.add(id);
      }
      const list = await entries(dir, true);
      options.onProgress?.({ directories: state.visited.size, folder: dir });
      for (const entry of list) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 5 && !skip.test(entry.name)) queue.push({ dir: full, depth: depth + 1 });
        if (entry.isFile() && /\.(?:exe|ini|json|info|txt|bat|cmd|ps1)$/i.test(entry.name)) result.push({ full, dir, name: entry.name, depth });
      }
    }
    return result;
  }
  return { startSearch, finishSearch, check, checkpoint, measure, addMetric, stat, text, entries, pe, roots, installations, foreignLibraries, directFolders, directMatches, filesystemMatches, isFilesystemCovered, refreshBatch, walk,
    get hasCompleteInventory() { return !!filesystemIndex; },
    get truncated() { return state.truncated; },
    get diagnostics() { return { elapsedMs: Date.now() - state.started, visitedDirectories: state.visited.size,
      ...state.metrics, limits: [...state.limits], issues: [...state.issues.values()] }; } };
}

module.exports = { createSearchContext };
