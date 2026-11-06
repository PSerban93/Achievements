"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("../atomic-json-store");
const { JOURNAL, recoverUpdate, commitUpdate, removeStaging } = require("./update-transaction");

const RELEASES_URL = "https://github.com/Roschach96/Achievement-Enabler/releases";
const ISSUES_URL = "https://github.com/Roschach96/Achievement-Enabler/issues";
const RELEASE_API = "https://api.github.com/repos/Roschach96/Achievement-Enabler/releases/latest";
const ENTRY = "_Achievement_Enabler.bat";

function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function archiveFiles(zip) {
  const entries = zip.getEntries();
  if (entries.length > 20000) throw new Error("Archive contains too many files.");
  let expanded = 0;
  const names = new Set();
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").some(p => p === ".." || p.includes(":") || p && /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) || /[\x00-\x1f]/.test(name)) {
      throw new Error("Unsafe archive path.");
    }
    if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error("Archive links are not supported.");
    expanded += Number(entry.header.size) || 0;
    if (expanded > 512 * 1024 * 1024) throw new Error("Expanded archive is too large.");
    const key = name.toLowerCase();
    if (!entry.isDirectory && names.has(key)) throw new Error("Duplicate archive path.");
    if (!entry.isDirectory) names.add(key);
  }
  const roots = entries.filter(e => !e.isDirectory && path.posix.basename(e.entryName.replace(/\\/g, "/")) === ENTRY);
  if (roots.length !== 1) throw new Error("The release must contain one Achievement Enabler entry point.");
  const prefix = roots[0].entryName.replace(/\\/g, "/").slice(0, -ENTRY.length);
  const files = entries.filter(e => !e.isDirectory && e.entryName.replace(/\\/g, "/").startsWith(prefix)).map(entry => ({
    entry, relative: entry.entryName.replace(/\\/g, "/").slice(prefix.length),
  }));
  const set = new Set(files.map(f => f.relative));
  if (!set.has("core/common/select_adapter.ps1") || !files.some(f => /^adapters\/[^/]+\/adapter\.json$/.test(f.relative))) {
    throw new Error("The downloaded release is incomplete.");
  }
  return files;
}

async function walkFiles(root, relative = "", { gameCopy = false } = {}) {
  const result = [];
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    // Adapter bundles may contain cloned repositories. Git's read-only objects
    // are not runtime files and must not be copied into games or newer releases.
    if (entry.name.toLowerCase() === ".git") continue;
    if (gameCopy) {
      const name = entry.name.toLowerCase();
      if (name === ".github") continue;
      // Keep the downloaded package complete, but only stage the upstream
      // entry point and runtime trees that upstream cleans up after setup.
      if (!relative && name !== ENTRY.toLowerCase() && name !== "core" && name !== "adapters") continue;
    }
    const rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Links inside the distribution are not supported.");
    if (entry.isDirectory()) result.push(...await walkFiles(root, rel, { gameCopy }));
    else if (entry.isFile()) result.push(rel);
  }
  return result;
}

function createEnablerStore({ userData, fetchImpl = globalThis.fetch, onProgress = () => {}, logger } = {}) {
  const root = path.join(userData, "AchievementEnabler");
  const stateFile = path.join(root, "state.json");
  let state = {};
  let latest = null;
  let lastCheck = 0;
  let download = null;
  let recovered = false, recovering = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  async function recover() {
    if (recovered) return;
    if (!recovering) recovering = (async () => {
      await recoverUpdate(root, stateFile);
      try { state = JSON.parse(await fsp.readFile(stateFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      recovered = true;
    })().finally(() => { recovering = null; });
    return recovering;
  }
  function activeFolder() {
    const candidate = typeof state.active === "string" ? path.resolve(root, state.active) : "";
    return candidate && inside(path.join(root, "releases"), candidate) && candidate !== path.join(root, "releases") ? candidate : "";
  }
  function snapshot() {
    const folder = activeFolder();
    return {
      installed: !!folder && fs.existsSync(path.join(folder, ENTRY)), folder,
      version: state.version || "", latest: latest?.tag_name || "", releaseUrl: latest?.html_url || RELEASES_URL,
      adaptersAcknowledged: state.adaptersAcknowledged === true,
      downloading: !!download, root,
    };
  }
  async function save(next) {
    await fsp.mkdir(root, { recursive: true });
    await writeJsonAtomic(stateFile, next, { backup: false });
    state = next;
  }
  async function check(force = false) {
    await recover();
    if (latest && !force && Date.now() - lastCheck < 15 * 60 * 1000) return snapshot();
    const response = await fetchImpl(RELEASE_API, {
      headers: { "User-Agent": "Achievements-Achievement-Enabler", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const release = await response.json();
    if (!release.tag_name || release.draft || release.prerelease) throw new Error("No stable release is available.");
    latest = release; lastCheck = Date.now();
    return snapshot();
  }
  async function install() {
    await recover();
    if (download) throw new Error("A download is already running.");
    download = new AbortController();
    const controller = download;
    let stage = "";
    try {
      if (!latest) await check();
      const release = latest;
      const asset = (release.assets || []).find(a => /^Achievement-Enabler.*\.zip$/i.test(a.name)) || (release.assets || []).find(a => /\.zip$/i.test(a.name));
      const url = asset?.browser_download_url || release.zipball_url;
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["github.com", "api.github.com"].includes(parsed.hostname)) throw new Error("Unexpected release URL.");
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "Achievements-Achievement-Enabler" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length")) || asset?.size || 0;
      const chunks = []; let size = 0, sent = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new Error("Release archive is too large.");
        chunks.push(chunk);
        if (Date.now() - sent > 100) { onProgress({ received: size, total }); sent = Date.now(); }
      }
      controller.signal.throwIfAborted();
      const buffer = Buffer.concat(chunks);
      const digest = crypto.createHash("sha256").update(buffer).digest("hex");
      if (asset?.digest?.startsWith("sha256:") && asset.digest.slice(7).toLowerCase() !== digest) throw new Error("Release integrity check failed.");
      const AdmZip = require("adm-zip");
      const files = archiveFiles(new AdmZip(buffer));
      const releases = path.join(root, "releases");
      await fsp.mkdir(releases, { recursive: true });
      stage = path.join(releases, `.update-${crypto.randomUUID()}`);
      await fsp.mkdir(stage);
      for (const { entry, relative } of files) {
        controller.signal.throwIfAborted();
        const dest = path.resolve(stage, relative);
        if (!inside(stage, dest)) throw new Error("Unsafe archive path.");
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, entry.getData());
      }
      // Preserve supplemental files, but let the official release own its source files.
      const previous = activeFolder();
      const wasInstalled = snapshot().installed;
      const baseline = new Set(state.files || []);
      if (previous && fs.existsSync(previous)) {
        const info = await fsp.lstat(previous);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The installed release is not a regular directory.");
        for (const relative of await walkFiles(previous)) {
          controller.signal.throwIfAborted();
          const key = relative.replace(/\\/g, "/");
          if (baseline.has(key) || fs.existsSync(path.join(stage, relative))) continue;
          await fsp.mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
          await fsp.copyFile(path.join(previous, relative), path.join(stage, relative));
        }
      }
      controller.signal.throwIfAborted();
      const destination = previous || path.join(releases, "current");
      const next = {
        version: String(release.tag_name), active: path.relative(root, destination),
        adaptersAcknowledged: wasInstalled && state.adaptersAcknowledged === true,
        files: files.map(f => f.relative), digest, installedAt: new Date().toISOString(),
        installationId: crypto.randomUUID(),
      };
      const cleanupError = await commitUpdate({ root, stateFile, stage, destination, nextState: next, signal: controller.signal });
      state = next;
      stage = "";
      if (cleanupError) {
        recovered = false;
        logger?.warn("enabler:update-cleanup-pending", { code: cleanupError.code || "", error: cleanupError.message });
      }
      onProgress({ received: size, total: total || size });
      logger?.info("enabler:installed", { version: next.version, digest });
      return snapshot();
    } finally {
      if (stage) {
        if (fs.existsSync(path.join(root, JOURNAL))) recovered = false;
        else await removeStaging(root, stage).catch(error => logger?.warn("enabler:update-cleanup-pending", { code: error.code || "", error: error.message }));
      }
      download = null;
    }
  }
  async function acknowledge(value = true) {
    await recover();
    if (!snapshot().installed) throw new Error("Download Achievement Enabler first.");
    await save({ ...state, adaptersAcknowledged: value === true });
    return snapshot();
  }
  async function prepareGame(gameFolder, signal) {
    await recover();
    const current = snapshot();
    if (!current.installed || !current.adaptersAcknowledged) throw new Error("Complete the setup steps first.");
    const game = await fsp.realpath(gameFolder);
    const master = await fsp.realpath(current.folder);
    if (!(await fsp.stat(game)).isDirectory() || inside(root, game) || inside(game, root) || game === path.parse(game).root) throw new Error("Select a separate game installation folder.");
    // The unmodified upstream entry point uses its own location as the game root.
    for (const relative of await walkFiles(master, "", { gameCopy: true })) {
      signal?.throwIfAborted();
      const target = path.join(game, relative);
      // Check each parent before creating anything through it, including junctions.
      let parent = game;
      for (const segment of path.dirname(relative).split(path.sep).filter(p => p && p !== ".")) {
        parent = path.join(parent, segment);
        const info = await fsp.lstat(parent).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (info?.isSymbolicLink() || info && !info.isDirectory()) throw new Error("A setup destination is not a regular directory.");
        if (!info) await fsp.mkdir(parent);
        if (!inside(game, await fsp.realpath(parent))) throw new Error("A setup destination leaves the game folder.");
      }
      if ((await fsp.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; }))?.isSymbolicLink()) throw new Error("A setup destination is a link.");
      await fsp.copyFile(path.join(master, relative), target);
    }
    return { folder: game, script: path.join(game, ENTRY), version: current.version };
  }
  return { snapshot, check, install, acknowledge, prepareGame, recover, cancelDownload: () => download?.abort(), root };
}

module.exports = { createEnablerStore, archiveFiles, inside, walkFiles, ENTRY, RELEASES_URL, ISSUES_URL };
