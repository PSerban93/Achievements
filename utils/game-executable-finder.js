"use strict";

// Read-only installation discovery. These roots never become Watched Folders.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { normalizeProcessNameList, normalizeProcessNameValue } = require("./process-name-utils");
const { gameProcessName } = require("./game-launch-process");
const run = promisify(execFile);
const key = (p) => path.resolve(p).toLowerCase();
const inside = (root, p) => key(p) === key(root) || key(p).startsWith(key(root) + path.sep);
const clean = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)|\[\d+\]|™|®/g, "").replace(/[^\p{L}\p{N}]/gu, "");
// Crash can be part of the game's own name. Exclude crash-reporting tools,
// not every executable whose title contains that word.
const utility = /(?:^unins|setup|installer|redist|crash[-_ ]?(?:report|handler|sender|pad|dump|uploader|monitor|client|collector)|reporter|generate_interfaces|gpu.capabilities|benchmark|rapidcrc|^crs-|helper|tweaksconfig|gamingrepair|^cleanup|^touchup|^7z|^update|^universeLANServer|^ryujinx|^yuzu|^rpcs3|^xenia)/i;
// Backup/crack directories are not installations, even when a saved hint or
// registry entry points into one. Apply this rule to full paths as well as walks.
const excludedDirectory = /^(?:[\s_.-]*(?:cracks?|cracked|original[\s_.-]*files?|bin[\s_.-]*plus)(?:[\s_.-].*)?)$/i;
const excludedPath = file => String(file).split(/[\\/]/).some(segment => excludedDirectory.test(segment));
const excludedExecutable = name => /plus.*\.exe$/i.test(name);
const skip = /^(?:\.git|node_modules|steam_settings|userdata|shadercache|cache|saves?|movies?|videos?|textures?|audio|_?commonredist|_?redist|__Installer|directx|engine|content|archives?|assets|[\s_.-]*(?:cracks?|cracked|original[\s_.-]*files?|bin[\s_.-]*plus)(?:[\s_.-].*)?|nodvd|gamingservices|MonoBleedingEdge|.+_Data)$/i;
const unsupported = new Set(["rpcs3", "xenia", "shadps4", "kytyps5", "retroachievements", "xbox-pc"]);
const directSkip = /^(?:Windows|Users|Program Files(?: \(x86\))?|ProgramData|Recovery|System Volume Information|Config\.Msi|\$.*|Games?|SteamLibrary|GOG Games|XboxGames|Epic Games)$/i;
const specificHint = name => !/^(?:game|launcher|main|start|shipping|client|play|run|bootstrapper|start_protected_game)(?:[-_](?:win)?(?:x?64|x?32|x86|shipping))*\.exe$/i.test(name);
function supported(c) { return !unsupported.has(String(c.platform || "").toLowerCase()); }
async function stat(p) { try { return await fsp.stat(p); } catch { return null; } }
async function text(p) { try { const s = await stat(p); return s?.isFile() && s.size <= 256 * 1024 ? (await fsp.readFile(p, "utf8")).replace(/^\uFEFF/, "") : ""; } catch { return ""; } }
async function entries(p) { try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; } }
async function pe(p, machine = false, onError) {
  let file;
  try {
    file = await fsp.open(p, "r");
    const b = Buffer.alloc(64), h = Buffer.alloc(24);
    if ((await file.read(b, 0, 64, 0)).bytesRead !== 64 || b.toString("ascii", 0, 2) !== "MZ") return false;
    const offset = b.readUInt32LE(60);
    if (offset < 64 || offset > 1024 * 1024 || (await file.read(h, 0, 24, offset)).bytesRead !== 24 || h.readUInt32LE(0) !== 0x4550) return false;
    const valid = !!(h.readUInt16LE(22) & 2) && !(h.readUInt16LE(22) & 0x2000);
    return valid ? machine ? h.readUInt16LE(4) : true : false;
  } catch (error) { onError?.(error); return false; } finally { await file?.close(); }
}
function iniValue(source, name) { return new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, "im").exec(source)?.[1]?.replace(/^"|"$/g, "") || ""; }
function names(c, metadata = {}) {
  const values = [metadata.relative_executable, c.launch_metadata?.relative_executable,
    ...(Array.isArray(metadata.process_name) ? metadata.process_name : String(metadata.process_name || "").split(/[;,\r\n]/)),
    ...(Array.isArray(c.process_name) ? c.process_name : String(c.process_name || "").split(/[;,\r\n]/))];
  return values.filter(Boolean).map(v => path.win32.basename(String(v))).filter(v => /\.exe$/i.test(v));
}
function matchTitle(c, folder) {
  const a = clean(c.displayName || c.name), b = clean(path.basename(folder));
  // A sequel is not an edition/name variant of its predecessor.
  if (JSON.stringify(a.match(/\d+/g) || []) !== JSON.stringify(b.match(/\d+/g) || [])) return false;
  return a.length >= 2 && a === b || a.length >= 4 && b.length >= 4 && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= .7 && (a.includes(b) || b.includes(a));
}
function executableTitleScore(config, file) {
  const title = String(config.displayName || config.name || "");
  const expected = clean(title);
  // Keep executable qualifiers such as (classic), Trial and Play: stripping
  // them would make alternative versions indistinguishable from the base exe.
  const actual = path.basename(file).replace(/\.exe$/i, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (expected.length < 2 || JSON.stringify(expected.match(/\d+/g) || []) !== JSON.stringify(actual.match(/\d+/g) || [])) return 0;
  if (actual === expected) return 100;
  // Some titles abbreviate the subtitle (e.g. Kill the Justice League -> KTJL).
  // Require the full title prefix and at least three abbreviated subtitle words.
  const words = title.replace(/\([^)]*\)|™|®/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (let cut = 1; cut <= words.length - 3; cut++) {
    const prefix = words.slice(0, cut).join("");
    if (prefix.length >= 8 && actual === prefix + words.slice(cut).map(word => [...word][0]).join("")) return 90;
  }
  return expected.length >= 4 && actual.includes(expected) && expected.length / actual.length >= .7 ? 70 : 0;
}
function explicitRoots(c) {
  return [c.ps4_recomp_install_root, c.ps3_recomp_install_root, c.x360_recomp_install_root,
    c.pc_port_install_root, c.pcports_install_root, c.ea_install_path, c.install_path, c.install_root].filter(p => typeof p === "string" && path.isAbsolute(p));
}
async function registry(branch, value = "", signal) {
  if (process.platform !== "win32") return "";
  try { return (await run("reg.exe", ["query", branch, ...(value ? ["/v", value] : ["/s"])], { windowsHide: true, timeout: 4000, signal, maxBuffer: 2 * 1024 * 1024 })).stdout; } catch (error) { if (error.code === "ABORT_ERR") throw error; return ""; }
}
let driveType;
function fixedDrives(env) {
  if (process.platform !== "win32") return [];
  try {
    const koffi = require("koffi");
    if (!driveType) driveType = koffi.load("kernel32.dll").func("uint32_t __stdcall GetDriveTypeW(str16 root)");
    return "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(d => d + ":\\").filter(d => driveType(d) === 3);
  } catch { return [String(env.SystemDrive || "C:") + "\\"]; }
}
function platformFamily(platform) {
  const family = String(platform || "steam").toLowerCase().replace(/-official$/, "");
  return family === "ubisoft" ? "uplay" : family;
}
function matchesInstallation(config, entry) {
  if (platformFamily(config.platform) !== entry.platform) return false;
  if (entry.platform !== "epic") return String(config.appid || "") === entry.appid;
  const dimensions = [[config.epic_namespace, entry.namespace], [config.epic_catalog_item_id, entry.catalogItemId], [config.epic_app_name, entry.appName]];
  if (dimensions.some(([expected, actual]) => expected && actual && String(expected).toLowerCase() !== actual.toLowerCase())) return false;
  const ids = [entry.namespace, entry.catalogItemId, entry.appName].filter(Boolean).map(value => value.toLowerCase());
  return [config.appid, ...dimensions.map(([value]) => value)].filter(Boolean).some(value => ids.includes(String(value).toLowerCase()));
}
function registryInstallations(source, platform) {
  const result = [];
  for (const block of String(source || "").split(/\r?\n(?=HKEY_)/i)) {
    const first = block.trim().split(/\r?\n/)[0];
    const id = /\\(?:Games|Installs)\\(\d+)$/i.exec(first)?.[1];
    if (!id) continue;
    const values = new Map([...block.matchAll(/^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/gim)].map(match => [match[1].toLowerCase(), match[2].trim()]));
    const root = values.get("path") || values.get("installdir");
    if (root && path.isAbsolute(root)) result.push({ platform, appid: id, installRoot: root,
      executable: values.get("exe") || values.get("executable") || "", source: `${platform}-registry` });
  }
  return result;
}
function galaxyInstallations(dbPath) {
  let db;
  try {
    // Galaxy can retain the current installation after a move even when the
    // Windows registry entry is missing. Read only installed product paths;
    // ownership and launch targets are still checked by inspect().
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare("SELECT CAST(productId AS TEXT) AS appid, installationPath FROM InstalledBaseProducts").all()
      .filter(row => /^\d+$/.test(row.appid) && typeof row.installationPath === "string" && path.isAbsolute(row.installationPath.trim()))
      .map(row => ({ platform: "gog", appid: row.appid, installRoot: path.normalize(row.installationPath.trim()),
        executable: "", source: "gog-galaxy" }));
  } catch {
    // An absent, locked or incompatible Galaxy database must not prevent the
    // existing registry and filesystem discovery methods from running.
    return [];
  } finally { try { db?.close(); } catch {} }
}
async function ubisoftLibraryRoots(env, launcherRegistry, disks, io) {
  const libraries = new Map(), found = new Map();
  const add = value => { if (value && path.isAbsolute(value)) libraries.set(key(value), path.normalize(value)); };
  const launcher = /InstallDir\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(launcherRegistry || "")?.[1]?.trim();
  if (launcher) add(path.join(launcher, "games"));
  add(path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Ubisoft", "Ubisoft Game Launcher", "games"));
  if (env.LOCALAPPDATA) {
    const settings = await io.text(path.join(env.LOCALAPPDATA, "Ubisoft Game Launcher", "settings.yaml"));
    let value = /^\s*game_installation_path:\s*(.*?)\s*$/m.exec(settings)?.[1] || "";
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { value = ""; } }
    else if (value.startsWith("'")) value = /^'(.*)'$/.exec(value)?.[1]?.replace(/''/g, "'") || "";
    add(value);
  }
  const missing = [];
  for (const library of libraries.values()) {
    io.checkpoint();
    if ((await io.stat(library))?.isDirectory()) found.set(key(library), library);
    else if (/^[a-z]:[\\/]/i.test(library)) missing.push(library);
  }
  if (!missing.length) return [...found.values()];
  // Relocation tools can preserve a drive's directory structure under a
  // container on another disk. Check only the exact declared library suffix,
  // never recursively scan that container or infer a game's identity from it.
  let containers;
  if (io.directFolders) containers = await io.directFolders();
  else {
    containers = [];
    for (const disk of disks) for (const entry of await io.entries(disk)) {
      io.checkpoint();
      if (entry.isDirectory() && !entry.isSymbolicLink() && !directSkip.test(entry.name) && !skip.test(entry.name)) containers.push(path.join(disk, entry.name));
    }
    containers = containers.slice(0, 1024);
  }
  for (const library of missing) for (const container of containers) {
    io.checkpoint();
    let current = container, available = true;
    const segments = [library[0], ...library.slice(path.parse(library).root.length).split(/[\\/]/).filter(Boolean)];
    for (const segment of segments) {
      const child = (await io.entries(current)).find(entry => entry.name.toLowerCase() === segment.toLowerCase() && entry.isDirectory() && !entry.isSymbolicLink());
      if (!child) { available = false; break; }
      current = path.join(current, child.name);
    }
    if (available) found.set(key(current), current);
  }
  return [...found.values()];
}
async function discoverRoots({ env = process.env, home = env.USERPROFILE || "", drives, registryRows, onRegistryRows, signal } = {}, io = {}) {
  const readText = io.text || text, readEntries = io.entries || entries, readStat = io.stat || stat;
  const checkpoint = io.checkpoint || (() => {});
  const roots = [], installs = [], installations = [];
  const add = (p) => { if (p && path.isAbsolute(p) && !roots.some(r => key(r) === key(p))) roots.push(path.normalize(p)); };
  const disks = io.volumes ? await io.volumes() : drives || fixedDrives(env);
  for (const disk of disks) for (const folder of ["Games", "Game", "SteamLibrary\\steamapps\\common", "GOG Games", "XboxGames", "Epic Games"]) add(path.join(disk, folder));
  if (home) for (const folder of ["Games", "Downloads\\Compressed", "Downloads\\Programs", "Desktop\\Games"]) add(path.join(home, folder));
  const branches = registryRows || await Promise.all([
    registry("HKCU\\Software\\Valve\\Steam", "SteamPath", signal), registry("HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games", "", signal),
    registry("HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs", "", signal), registry("HKLM\\SOFTWARE\\GOG.com\\Games", "", signal),
    registry("HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher", "InstallDir", signal), registry("HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs", "", signal)]);
  onRegistryRows?.(branches);
  checkpoint();
  const steam = /(?:SteamPath|InstallPath)\s+REG_SZ\s+(.+)/i.exec(branches[0])?.[1]?.trim();
  if (steam) {
    add(path.join(steam, "steamapps", "common"));
    const libs = await readText(path.join(steam, "steamapps", "libraryfolders.vdf"));
    for (const m of libs.matchAll(/"path"\s+"([^"]+)"/gi)) add(path.join(m[1].replace(/\\\\/g, "\\"), "steamapps", "common"));
  }
  for (const source of [branches[1], branches[2], branches[3], branches[5]]) for (const m of String(source || "").matchAll(/^\s*(?:path|InstallDir)\s+REG_SZ\s+(.+)$/gim)) {
    const p = m[1].trim(); if (path.isAbsolute(p)) { installs.push(p); add(path.dirname(p)); }
  }
  installations.push(...registryInstallations(branches[1], "gog"), ...registryInstallations(branches[2], "uplay"), ...registryInstallations(branches[3], "gog"),
    ...registryInstallations(branches[5], "uplay"));
  const galaxyDb = path.join(env.ProgramData || "C:\\ProgramData", "GOG.com", "Galaxy", "storage", "galaxy-2.0.db");
  if ((await readStat(galaxyDb))?.isFile()) installations.push(...galaxyInstallations(galaxyDb));
  checkpoint();
  const manifestRoot = path.join(env.ProgramData || "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
  for (const e of await readEntries(manifestRoot)) if (e.isFile() && /\.item$/i.test(e.name)) {
    checkpoint();
    try {
      const j = JSON.parse(await readText(path.join(manifestRoot, e.name)));
      if (typeof j.InstallLocation === "string" && path.isAbsolute(j.InstallLocation)) {
        installs.push(j.InstallLocation); add(path.dirname(j.InstallLocation));
        installations.push({ platform: "epic", installRoot: j.InstallLocation, executable: String(j.LaunchExecutable || ""),
          namespace: String(j.CatalogNamespace || ""), catalogItemId: String(j.CatalogItemId || ""), appName: String(j.AppName || ""), source: "epic-manifest" });
      }
    } catch (error) { if (["ABORT_ERR", "EXECUTABLE_SEARCH_LIMIT"].includes(error.code)) throw error; }
  }
  for (const entry of installations) { if (!installs.includes(entry.installRoot)) installs.push(entry.installRoot); add(path.dirname(entry.installRoot)); }
  const available = [];
  for (const root of roots) { checkpoint(); if ((await readStat(root))?.isDirectory()) available.push(root); }
  return { roots: available, platformRoots: { uplay: () => ubisoftLibraryRoots(env, branches[4], disks, {
    text: file => readText(file), entries: readEntries, stat: readStat, checkpoint, directFolders: io.directFolders,
  }) },
    installs: [...new Map(installs.map(root => [key(root), root])).values()], installations };
}

function createSearchContext(options = {}) {
  return require("./executable-search-context").createSearchContext(options, { discoverRoots, fixedDrives, skip, directSkip, specificHint, readPe: pe });
}

async function launcherFor(root, files, original, c, io) {
  const { text: readText, pe: readPe, checkpoint } = io;
  const matches = [], family = platformFamily(c.platform);
  // ColdClient owns the game's command line. The loader itself receives no
  // duplicated game arguments; runtime matching remains the real game exe.
  if (["steam", "uplay", ""].includes(family)) for (const row of files.filter(f => /^ColdClientLoader\.ini$/i.test(f.name))) {
    checkpoint();
    const ini = await readText(row.full), id = iniValue(ini, "AppId"), rel = iniValue(ini, "Exe");
    const target = path.resolve(row.dir, rel.replace(/\\/g, path.sep));
    if (!rel || !inside(root, target) || key(target) !== key(original)) continue;
    const expected = family === "uplay" ? c.steamAppId : c.appid;
    if (id && expected && String(id) !== String(expected)) continue;
    const loaders = files.filter(f => key(f.dir) === key(row.dir) && /^steamclient_loader(?:_x64|_x32)?\.exe$/i.test(f.name));
    const targetMachine = await readPe(original, true);
    for (const loader of loaders) if (await readPe(loader.full)) {
      const loaderMachine = await readPe(loader.full, true);
      if (targetMachine && loaderMachine && targetMachine !== loaderMachine) continue;
      matches.push({ executable: loader.full, arguments: "", working_directory: row.dir, process_name: path.basename(original), source: "coldclient-launcher", ownsArguments: true });
    }
  }
  if (family === "epic") for (const row of files.filter(f => /\.bat$/i.test(f.name) && !utility.test(f.name) && key(f.dir) === key(path.dirname(original)))) {
    checkpoint();
    const src = await readText(row.full);
    const command = /^\s*start\s+\/b\s+"[^"]*"\s+"([^"]+\.exe)"\s+(.+)$/im.exec(src);
    if (!command || !/-AUTH_TYPE=exchangecode\b/i.test(command[2]) || !/-epicapp=/i.test(command[2])) continue;
    if (key(path.resolve(row.dir, command[1])) !== key(original)) continue;
    // This exact AE launcher format carries all required arguments itself.
    matches.push({ executable: row.full, arguments: "", working_directory: row.dir, process_name: path.basename(original), source: "epic-exchange-launcher", ownsArguments: true });
  }
  if (family === "gog") for (const row of files.filter(f => f.name.toLowerCase() === "_ae_gog_launch.ps1")) {
    checkpoint();
    const src = await readText(row.full);
    const game = /^\s*\$gameProc\s*=\s*Start-Process\s+-FilePath\s+'([^']+)'\s+-WorkingDirectory\s+'([^']+)'\s+-PassThru\s*$/im.exec(src);
    const server = /^\s*\$serverProc\s*=\s*Start-Process\s+-FilePath\s+'([^']+)'/im.exec(src);
    if (!game || !server || !inside(root, game[1]) || key(game[1]) !== key(original) || !inside(root, server[1]) || !/^UniverseLANServer(?:64)?\.exe$/i.test(path.basename(server[1])) || !await readPe(server[1])) continue;
    matches.push({ executable: row.full, arguments: "", working_directory: row.dir, process_name: path.basename(original), source: "gog-server-launcher", ownsArguments: true });
  }
  return matches;
}

async function findExecutable(c, options = {}) {
  if (String(c.executable || "").trim()) return { status: "existing", candidates: [] };
  if (!supported(c)) return { status: "unsupported", candidates: [] };
  const context = options.context || createSearchContext(options), metadata = options.metadata || {};
  context.startSearch();
  const measure = (name, action) => context.measure ? context.measure(name, action) : action();
  const candidates = new Map();
  let explicit = [], queriedInventory = false;
  try {
    const hints = names(c, metadata), relative = metadata.relative_executable || c.launch_metadata?.relative_executable || "";
    explicit = options.folder ? [options.folder] : explicitRoots(c);
    const validRoots = [];
    for (const root of explicit) if ((await context.stat(root, true))?.isDirectory()) validRoots.push(root);
    explicit = validRoots;
    // A declared installation isolates recomp/config variants. AppData save
    // paths are never searched upward or converted into installation roots.
    const epicOfficial = String(c.platform).toLowerCase() === "epic-official";
    const { records, allFolders, direct } = await measure("discoveryMs", async () => ({
      records: explicit.length && !epicOfficial ? [] : await context.installations(),
      allFolders: explicit.length || epicOfficial ? [] : await context.roots(platformFamily(c.platform)),
      direct: explicit.length || epicOfficial ? [] : await context.directFolders(),
    }));
    const matched = records.filter(entry => matchesInstallation(c, entry));
    const selected = [...new Map((epicOfficial ? matched.filter(entry => entry.source === "epic-manifest" && gameProcessName(entry.executable) &&
      (!explicit.length || explicit.some(root => key(root) === key(entry.installRoot)))).map(entry => entry.installRoot) : explicit.length ? explicit : [
      ...matched.map(entry => entry.installRoot), ...allFolders.filter(dir => matchTitle(c, dir)), ...direct.filter(dir => matchTitle(c, dir)),
    ]).map(root => [key(root), root])).values()];
    async function inspectDirectory(root, authoritative = false, exactLocationHint = false, filesystemHint = false) {
      context.checkpoint();
      if (excludedPath(root)) return;
      const owners = records.filter(entry => entry.platform === platformFamily(c.platform) &&
        (entry.appid || entry.namespace || entry.catalogItemId || entry.appName) && inside(entry.installRoot, root));
      const nearest = owners.length ? Math.max(...owners.map(entry => entry.installRoot.length)) : 0;
      const known = owners.filter(entry => entry.installRoot.length === nearest);
      if (known.length && !known.some(entry => matchesInstallation(c, entry))) return;
      const identified = matched.filter(entry => key(entry.installRoot) === key(root));
      authoritative ||= identified.length > 0;
      // Official Epic discovery trusts only the exact launcher manifest target.
      // Do not walk other files or reinterpret an AE script as its launch entry.
      if (epicOfficial) {
        for (const entry of identified.filter(record => record.source === "epic-manifest")) {
          const target = path.resolve(root, entry.executable.replace(/\\/g, path.sep));
          if (!gameProcessName(target) || !inside(root, target) || excludedPath(target) || excludedExecutable(path.basename(target))) continue;
          if (!await context.pe(target)) continue;
          candidates.set(key(target), { executable: target, process_name: path.basename(target), install_root: root,
            working_directory: root, source: entry.source, score: 100, confident: true, identifiedInstall: true });
        }
        return;
      }
      const files = await context.walk(root);
      let launcherConfig = {};
      try { launcherConfig = JSON.parse(await context.text(path.join(root, "launcher-configuration.json"))); }
      catch (error) { if (["ABORT_ERR", "EXECUTABLE_SEARCH_LIMIT"].includes(error.code)) throw error; }
      const declared = new Set();
      const addDeclared = value => {
        if (typeof value !== "string" || !value) return;
        const target = path.resolve(root, value.replace(/\\/g, path.sep));
        if (inside(root, target)) declared.add(key(target));
      };
      if (relative && !path.isAbsolute(relative)) addDeclared(relative);
      if (launcherConfig.executablePath && !path.isAbsolute(launcherConfig.executablePath)) addDeclared(launcherConfig.executablePath);
      const installationTargets = new Set();
      for (const entry of identified) {
        if (entry.executable && gameProcessName(entry.executable)) {
          const target = path.resolve(root, entry.executable.replace(/\\/g, path.sep));
          if (!inside(root, target)) return;
          installationTargets.add(key(target));
        }
        addDeclared(entry.executable);
      }
      const gogIds = files.filter(file => /^goggame-\d+\.info$/i.test(file.name) && key(file.dir) === key(root));
      const family = platformFamily(c.platform);
      if (family === "gog" && gogIds.length && !gogIds.some(file => file.name.match(/\d+/)?.[0] === String(c.appid))) return;
      const rootSteamId = (await context.text(path.join(root, "steam_appid.txt"))).trim();
      if (filesystemHint) {
        const coldClientId = iniValue(await context.text(path.join(root, "ColdClientLoader.ini")), "AppId");
        const expectedSteamId = family === "steam" ? c.appid : family === "uplay" ? c.steamAppId : "";
        if (/^\d+$/.test(coldClientId) && (!expectedSteamId || String(expectedSteamId) !== coldClientId)) return;
        if (family === "uplay" && /^\d+$/.test(rootSteamId) && String(c.steamAppId || "") !== rootSteamId) return;
      }
      // Read directory entries already visited by this search; never recurse
      // into emulator settings or look in a neighbouring game's directory.
      const markerCache = new Map();
      async function markersFor(directory) {
        const id = key(directory);
        if (!markerCache.has(id)) markerCache.set(id, (async () => {
          const list = await context.entries(directory);
          const parent = id === key(root) ? {} : await markersFor(path.dirname(directory));
          return {
            steam: !!parent.steam || list.some(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^steam_settings$/i.test(entry.name)),
            gog: !!parent.gog || list.some(entry => !entry.isSymbolicLink() && (entry.isDirectory() ? /^UniverseLAN(?:Data)?$/i : /^UniverseLAN(?:Server(?:64)?\.exe|\.ini)$/i).test(entry.name)),
          };
        })());
        return markerCache.get(id);
      }
      const relativeCwd = metadata.relative_working_directory || c.launch_metadata?.relative_working_directory;
      const declaredCwd = typeof relativeCwd === "string" && relativeCwd ? path.resolve(root, relativeCwd.replace(/\\/g, path.sep)) : "";
      const validCwd = declaredCwd && inside(root, declaredCwd) && (await context.stat(declaredCwd))?.isDirectory() ? declaredCwd : "";
      if (family === "gog") for (const info of gogIds) {
        if (info.name.match(/\d+/)?.[0] !== String(c.appid)) continue;
        try {
          const data = JSON.parse(await context.text(info.full));
          for (const task of data.playTasks || []) if (task.isPrimary && task.path && !path.isAbsolute(task.path)) addDeclared(task.path);
        } catch (error) { if (["ABORT_ERR", "EXECUTABLE_SEARCH_LIMIT"].includes(error.code)) throw error; }
      }
      const title = matchTitle(c, root);
      for (const row of files.filter(file => gameProcessName(file.name) && !utility.test(file.name) && !excludedExecutable(file.name) && !excludedPath(file.full))) {
        context.checkpoint();
        if (c.platform === "ps4recomp" && (/probe(?:-v\d+)?\.exe$/i.test(row.name) ||
            [c.ps4_recomp_runtime_executable, ...(c.ps4_recomp_runtime_executables || [])].filter(Boolean).some(file => key(file) === key(row.full)))) continue;
        if (family === "steam") {
          const id = (await context.text(path.join(row.dir, "steam_appid.txt"))).trim();
          if ([rootSteamId, id].some(value => /^\d+$/.test(value) && value !== String(c.appid))) continue;
        }
        const declaredMatch = declared.has(key(row.full));
        if (installationTargets.size && !installationTargets.has(key(row.full)) && !/Win64-Shipping\.exe$/i.test(row.name)) continue;
        if (c.platform === "ps4recomp" && row.depth > 0 && !declaredMatch) continue;
        const hint = hints.some(value => value.toLowerCase() === row.name.toLowerCase());
        if (exactLocationHint && !hint && !declaredMatch) continue;
        // A declaration in an unrelated installation describes that other
        // game. It cannot establish ownership of this config on its own.
        if (!authoritative && !title && !(hint && specificHint(row.name))) continue;
        if (!declaredMatch && hints.length && !hint && !title && !authoritative) continue;
        if (!await context.pe(row.full)) continue;
        const markers = await markersFor(row.dir);
        // steam_settings identifies a Steam emulator even in a folder with
        // leftover GOG package metadata. Otherwise UniverseLAN identifies GOG.
        const foreignInstall = family === "steam" ? !markers.steam && (markers.gog || gogIds.length > 0) :
          family === "gog" ? markers.steam || !markers.gog && /^\d+$/.test(rootSteamId) : gogIds.length > 0 || family === "epic" && /^\d+$/.test(rootSteamId);
        const score = (declaredMatch ? 100 : 0) + (hint ? 70 : 0) + (title ? 40 : 0) + (matchTitle(c, row.name) ? 35 : 0);
        const codeFolderMatches = exactLocationHint && hint && specificHint(row.name) && clean(path.basename(root)) === clean(row.name.replace(/\.exe$/i, ""));
        const base = { executable: row.full, process_name: path.basename(row.full), runtime_executable: row.full, install_root: root,
          working_directory: validCwd || path.dirname(row.full),
          source: identified[0]?.source || (declaredMatch ? "declared-executable" : hint ? "process-name" : "installation-folder"), score,
          identifiedInstall: identified.length > 0, exactTitle: clean(c.displayName || c.name) === clean(path.basename(root)), foreignInstall,
          confident: !foreignInstall && (declaredMatch || codeFolderMatches || hint && (title || authoritative || filesystemHint && specificHint(row.name)) || title && matchTitle(c, row.name)) };
        const launchers = await launcherFor(root, files, row.full, c, context);
        const variants = launchers.length ? launchers.map(launcher => ({ ...base, ...launcher, score: score + 150, confident: !foreignInstall })) : [base];
        for (const variant of variants) {
          const previous = candidates.get(key(variant.executable));
          if (!previous || previous.score < variant.score || previous.score === variant.score && variant.confident && !previous.confident)
            candidates.set(key(variant.executable), variant);
        }
      }
    }
    const inspect = (...args) => measure("candidateValidationMs", () => inspectDirectory(...args));
    for (const root of selected) await inspect(root, explicit.some(value => key(value) === key(root)));
    if (!explicit.length && !epicOfficial) for (const root of await context.directMatches(hints, relative)) if (!selected.some(value => key(value) === key(root))) await inspect(root, false, true);
    if (!explicit.length && !epicOfficial && ![...candidates.values()].some(row => row.confident) && context.filesystemMatches) {
      const exactHints = hints.filter(name => specificHint(name) && gameProcessName(name) && !utility.test(name) && !excludedExecutable(name));
      queriedInventory = exactHints.length > 0;
      const inspected = new Set(), preferredRoots = new Set();
      let foreignPromise;
      const allowedLocation = async file => {
        foreignPromise ||= context.foreignLibraries ? context.foreignLibraries(platformFamily(c.platform)) : Promise.resolve([]);
        const foreignLibraries = await foreignPromise;
        return !excludedPath(file) && !foreignLibraries.some(root => inside(root, file));
      };
      const inspectFile = async file => {
        context.checkpoint();
        if (!await allowedLocation(file)) return;
        const owners = records.filter(entry => inside(entry.installRoot, file));
        const nearest = owners.length ? Math.max(...owners.map(entry => entry.installRoot.length)) : 0;
        const known = owners.filter(entry => entry.installRoot.length === nearest);
        // Exact filenames do not override a different launcher's ownership.
        if (known.length && !known.some(entry => matchesInstallation(c, entry))) return;
        let root = known.find(entry => matchesInstallation(c, entry))?.installRoot || path.dirname(file);
        if (!known.length) {
          const relativePath = relative.replace(/[\\/]/g, path.sep);
          if (relativePath && !path.isAbsolute(relativePath) && key(file).endsWith(path.sep + relativePath.toLowerCase())) {
            const declaredRoot = file.slice(0, -relativePath.length);
            if (inside(declaredRoot, file)) root = path.normalize(declaredRoot);
          }
          // A binary can live below its launcher/settings. Recover only its
          // own nearest installation boundary, never inspect a whole library.
          let ancestor = path.dirname(file);
          for (let depth = 0; depth < 6 && path.dirname(ancestor) !== ancestor; depth++, ancestor = path.dirname(ancestor)) {
            const list = await context.entries(ancestor);
            if (list.some(entry => !entry.isSymbolicLink() && (entry.isDirectory() ? /^(?:steam_settings|UniverseLAN(?:Data)?)$/i :
              /^(?:steam_appid\.txt|goggame-\d+\.info|ColdClientLoader\.ini|launcher-configuration\.json|UniverseLAN\.ini)$/i).test(entry.name)) || matchTitle(c, ancestor)) {
              root = ancestor; break;
            }
          }
        }
        if (!inspected.has(key(root))) { inspected.add(key(root)); await inspect(root, false, true, true); }
      };
      const files = await measure("filesystemMs", () => context.filesystemMatches(exactHints, {
        onMatch: inspectFile,
        preferDirectory: dir => matchTitle(c, dir),
        onDirectory: async root => {
          if (!await allowedLocation(root)) return;
          const owners = records.filter(entry => inside(entry.installRoot, root));
          const nearest = owners.length ? Math.max(...owners.map(entry => entry.installRoot.length)) : 0;
          if (owners.some(entry => entry.installRoot.length === nearest) && !owners.some(entry => entry.installRoot.length === nearest && matchesInstallation(c, entry))) return;
          preferredRoots.add(root);
          if (!inspected.has(key(root))) { inspected.add(key(root)); await inspect(root, false, true, true); }
        },
        preferredComplete: () => [...candidates.values()].some(row => row.confident && !row.foreignInstall &&
          [...preferredRoots].some(root => inside(root, row.runtime_executable || row.executable))),
      }));
      // Older/custom contexts can return matches without streaming callbacks.
      for (const file of files) await inspectFile(file);
    }
    if (!candidates.size && options.extended && hints.length) await measure("extendedScanMs", async () => {
      for (const root of allFolders.filter(dir => !selected.some(value => inside(value, dir)))) {
        if (queriedInventory && context.isFilesystemCovered?.(root)) { context.addMetric?.("extendedRootsSkipped"); continue; }
        context.addMetric?.("extendedRootsChecked"); await inspect(root);
      }
    });
  } catch (error) { if (error.code !== "EXECUTABLE_SEARCH_LIMIT") throw error; }
  let rows = [...candidates.values()].sort((a, b) => b.score - a.score || a.executable.localeCompare(b.executable));
  // Prefer the normal executable only when its -l counterpart is also present
  // in the same directory. An unrelated executable ending in -l remains valid.
  rows = rows.filter(row => {
    const file = row.runtime_executable || row.executable;
    return !/-l\.exe$/i.test(file) || !rows.some(other => key(other.runtime_executable || other.executable) === key(file.replace(/-l\.exe$/i, ".exe")));
  });
  if (String(c.platform).toLowerCase() !== "epic-official") rows = rows.filter(row => row.ownsArguments || !/^launcher\.exe$/i.test(path.basename(row.executable)) ||
    !rows.some(other => other !== row && key(path.dirname(other.executable)) === key(path.dirname(row.executable)) && !/^launcher\.exe$/i.test(path.basename(other.executable))));
  const confident = rows.filter(row => row.confident), ae = rows.filter(row => row.ownsArguments && row.confident);
  const oneInstallation = new Set(rows.map(row => key(row.install_root))).size <= 1;
  const preferred = preferredCandidate(c, rows, oneInstallation);
  const aeWinner = ae.length === 1 && oneInstallation ? ae[0] : null;
  const best = aeWinner || preferred || (oneInstallation && confident.length === 1 && (rows.length === 1 || confident[0].score - rows[1].score >= 50) ? confident[0] :
    rows.length === 1 && !rows[0].foreignInstall && (explicit.length || rows[0].identifiedInstall || rows[0].exactTitle) && !/launcher|loader|helper/i.test(path.basename(rows[0].executable)) ? rows[0] : null);
  const safeBest = context.truncated ? null : best;
  const status = safeBest ? "found" : context.truncated ? "incomplete" : rows.length ? "ambiguous" : "not-found";
  context.finishSearch(status);
  return { status, candidate: safeBest, candidates: rows,
    truncated: context.truncated, diagnostics: context.diagnostics };
}

function preferredCandidate(config, rows, oneInstallation) {
  if (!oneInstallation || !rows.length || rows.some(row => row.foreignInstall)) return null;
  const eligible = rows.filter(row => row.confident || row.identifiedInstall || row.exactTitle || explicitRoots(config).some(root => key(root) === key(row.install_root)));
  const runtime = row => row.runtime_executable || row.executable;
  const choose = (matches, rule) => {
    if (matches.length !== 1) return null;
    return { ...matches[0], selectionRule: rule };
  };
  // Launcher metadata is the authority for official Epic, including launchers
  // whose declared target is a bootstrap executable instead of Shipping.
  if (String(config.platform).toLowerCase() === "epic-official") return null;
  const shipping = eligible.filter(row => /Win64-Shipping\.exe$/i.test(runtime(row)));
  if (shipping.length) return choose(shipping, "win64-shipping");
  // User-confirmed defaults for multi-entry games. Scope by platform and AppID,
  // never by a similar title or by a filename in another installation.
  const defaults = { "steam:1659420": "u4.exe", "uplay:205": "fc3_blooddragon.exe" };
  const preferredName = defaults[`${platformFamily(config.platform)}:${config.appid}`];
  if (preferredName) return choose(eligible.filter(row => path.basename(runtime(row)).toLowerCase() === preferredName), "confirmed-default");
  const named = eligible.map(row => ({ row, score: executableTitleScore(config, runtime(row)) })).filter(match => match.score > 0);
  if (named.length) {
    const highest = Math.max(...named.map(match => match.score));
    const winner = choose(named.filter(match => match.score === highest).map(match => match.row), "game-title");
    if (winner) return winner;
  }
  // Same-named version subdirectories do not override the installation's root
  // entry (e.g. DSX.exe alongside Main_v3_Beta/DSX.exe).
  const rootEntries = eligible.filter(row => row.confident && key(path.dirname(runtime(row))) === key(row.install_root) &&
    rows.some(other => other !== row && path.basename(runtime(other)).toLowerCase() === path.basename(runtime(row)).toLowerCase()));
  if (rootEntries.length) return choose(rootEntries, "installation-root");
  return null;
}

function applyCandidate(c, candidate) {
  if (!candidate || String(c.executable || "").trim()) return false;
  c.executable = candidate.executable;
  // Only recognised AE launchers own the argument field. Keep all existing
  // game processes and add the discovered one without tracking launch scripts.
  if (candidate.ownsArguments) c.arguments = candidate.arguments;
  else if (!String(c.arguments || "").trim() && candidate.arguments) c.arguments = candidate.arguments;
  const processes = normalizeProcessNameList(candidate.process_name, { splitString: true }).filter(gameProcessName);
  if (processes.length) c.process_name = normalizeProcessNameValue([c.process_name, processes], { splitString: true });
  if (!c.working_directory) c.working_directory = candidate.working_directory;
  return true;
}
let automaticContext, automaticAt = 0, automaticQueue = Promise.resolve();
let automaticLogger;
function logAutomaticFailure(config, result, error) {
  if (!error && !result?.truncated && !result?.diagnostics?.issues?.length) return;
  try {
    automaticLogger ||= require("./logger").createLogger("autoconfig");
    automaticLogger.warn("executable-finder:auto-incomplete", { configName: config.name || "", platform: config.platform || "",
      status: result?.status || "error", truncated: !!result?.truncated, diagnostics: result?.diagnostics || null,
      ...(error ? { code: error.code || "SEARCH_ERROR" } : {}) });
  } catch {} // Diagnostic logging must not affect schema generation.
}
async function autoFindExecutable(c, metadata = {}) {
  if (String(c.executable || "").trim() || !supported(c)) return false;
  // Concurrent schema jobs may share caches, never mutable per-search limits.
  const pending = automaticQueue.then(async () => {
    if (String(c.executable || "").trim()) return false;
    try {
      if (!automaticContext || Date.now() - automaticAt > 5 * 60_000) { automaticContext = createSearchContext({ timeLimitMs: 20_000, maxDirectories: 1500 }); automaticAt = Date.now(); }
      const result = await findExecutable(c, { context: automaticContext, metadata });
      logAutomaticFailure(c, result);
      return result.status === "found" && applyCandidate(c, result.candidate);
    } catch (error) { logAutomaticFailure(c, null, error); return false; } // Optional enrichment must never stop schema generation.
  });
  automaticQueue = pending.then(() => {}, () => {});
  return pending;
}
module.exports = { findExecutable, createSearchContext, discoverRoots, applyCandidate, autoFindExecutable, supported, pe,
  hasExecutableHints: config => names(config).length > 0 };
