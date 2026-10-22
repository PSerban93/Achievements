"use strict";

// Called only after PS4 Recomp installation/game identity has been established.
// Read files and literal declarations; never run a port's scripts or programs.
const fs = require("fs");
const path = require("path");
const installations = require("./ps4-recomp-installation");
const { inside, samePath } = require("./pc-ports");

function executableFile(root, file) {
  if (!inside(root, file)) return false;
  let fd;
  try {
    // Reject junctions as well as symlinked files/directories inside the root.
    let current = path.resolve(root);
    if (!installations.directory(current)) return false;
    for (const part of path.relative(current, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    if (!installations.regular(file) || !/\.exe$/i.test(file)) return false;
    fd = fs.openSync(file, "r");
    const dos = Buffer.alloc(64), pe = Buffer.alloc(24);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") return false;
    const at = dos.readUInt32LE(60);
    if (at < 64 || at > 1024 * 1024 || fs.readSync(fd, pe, 0, pe.length, at) !== pe.length || pe.readUInt32LE(0) !== 0x4550) return false;
    const flags = pe.readUInt16LE(22);
    return (flags & 2) !== 0 && (flags & 0x2000) === 0;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function candidates(root, relative) {
  const folder = path.join(root, relative);
  if (!installations.directory(folder)) return [];
  const names = fs.readdirSync(folder).filter((name) => /\.exe$/i.test(name));
  if (names.length > 128) return [];
  return names.map((name) => path.join(folder, name)).filter((file) => executableFile(root, file));
}

function unique(files) {
  const values = new Map(files.map((file) => [path.resolve(file).toLowerCase(), file]));
  return values.size === 1 ? [...values.values()][0] : "";
}

function launcher(root, port, files) {
  if (port.launcher) return files.find((file) => path.basename(file).toLowerCase() === port.launcher.toLowerCase()) || "";
  if (files.length <= 1) return files[0] || "";
  // A literal PyInstaller name or shipping command can disambiguate several
  // root executables. No executable-name catalog or title matching is used.
  const declarations = [];
  const wrappers = fs.readdirSync(root).filter((name) => /\.(?:spec|bat|cmd|desktop)$/i.test(name)).slice(0, 64);
  for (const name of wrappers) {
    const source = installations.text(path.join(root, name)).split(/\r?\n/)
      .filter((line) => !/^\s*(?:#|rem\b|::)/i.test(line)).join("\n");
    for (const file of files) {
      const base = path.basename(file), escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declared = /\.spec$/i.test(name)
        ? [...source.matchAll(/\bname\s*=\s*['"]([^'"]+)['"]/g)].some((match) => match[1].replace(/\.exe$/i, "").toLowerCase() === base.slice(0, -4).toLowerCase())
        : new RegExp(`(?:^|[\\s"'\\\\/])${escaped}(?=$|[\\s"'])`, "im").test(source);
      if (declared) declarations.push(file);
    }
  }
  return unique(declarations);
}

function literalRuntime(root, source) {
  const files = [];
  let declared = false;
  for (const match of source.matchAll(/^\s*(?:PROBE|RUNTIME(?:_EXE(?:CUTABLE)?)?|GAME_EXE(?:CUTABLE)?|EXECUTABLE)\s*=\s*([^\r\n]+)/gim)) {
    const expression = /^\s*(?:BASE|ROOT|PORT|PORT_DIR|RUNTIME)((?:\s*\/\s*['"][^'"\r\n]+['"])+)\s*(?:#.*)?$/.exec(match[1]);
    if (!expression) continue;
    const parts = [...expression[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    const file = path.resolve(root, ...parts);
    if (!/\.exe$/i.test(file) || !inside(root, file)) continue;
    declared = true;
    if (executableFile(root, file)) files.push(file);
  }
  return { files, declared };
}

function discover(root, port, { titleId = "", legacyProcessName = "" } = {}) {
  const entry = launcher(root, port, candidates(root, ""));
  if (port.compiledLauncher) {
    const runtimes = (port.compiledRuntime || []).filter((file) => executableFile(root, file));
    return { executable: entry ? path.relative(root, entry) : "", defaultArguments: "",
      processName: runtimes.length === 1 ? path.basename(runtimes[0]) : runtimes.map((file) => path.basename(file)),
      ...(runtimes.length === 1 ? { runtimeExecutable: runtimes[0] } : runtimes.length ? { runtimeExecutables: runtimes } : {}) };
  }
  const sources = port.launcherSources?.length ? port.launcherSources : installations.launcherSources(root);
  const owned = sources.filter(({ source }) => {
    const ids = source.match(/\bCUSA\d{5}\b/g) || [];
    return !titleId || !ids.length || ids.includes(titleId);
  });
  // A CLI runner's presence does not prove that a newly found GUI executable
  // accepts --play. Keep that option only when its launcher declares it.
  const defaultArguments = entry ? port.hasRunner && owned.length === 1 &&
    /\.add_argument\(\s*['"]--play['"]/.test(owned[0].source) ? "--play" : "" : undefined;
  // Existing runners keep their argument-based runtime matching. Only native
  // generic installations get the new exact executable-path contract.
  if (port.hasRunner !== false) return { executable: entry ? path.relative(root, entry) : "", processName: legacyProcessName, defaultArguments };
  const declarations = owned.map(({ source }) => literalRuntime(root, source));
  const declared = declarations.some((item) => item.declared);
  const runtimeCandidates = declared ? declarations.flatMap((item) => item.files) :
    ["bin", "out"].flatMap((folder) => candidates(root, folder));
  const runtime = unique(runtimeCandidates.filter((file) => !samePath(file, entry)));
  return { executable: entry ? path.relative(root, entry) : "",
    processName: runtime ? path.basename(runtime) : "", runtimeExecutable: runtime, defaultArguments };
}

function commandExecutable(entry) {
  const command = String(entry.cmd || entry.command || "").trim();
  const match = command.match(/^"([^"]+\.exe)"(?=\s|$)/i) || command.match(/^(.+?\.exe)(?=\s|$)/i);
  return match && path.isAbsolute(match[1]) ? match[1] : "";
}

function matchesPathOptions(command, options) {
  for (const [name, expected] of Object.entries(options)) {
    const pattern = new RegExp(`(?:^|\\s)--${name}(?=\\s|=|$)(?:\\s+|=)?(?:"([^"]*)"|'([^']*)'|(\\S+))?`, "gi");
    for (const match of command.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (!value || !path.isAbsolute(value) || !expected || !samePath(value, expected)) return false;
    }
  }
  return true;
}

module.exports = { discover, commandExecutable, matchesPathOptions };
