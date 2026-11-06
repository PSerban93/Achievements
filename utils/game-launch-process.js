"use strict";

const fs = require("fs").promises;
const path = require("path");

// These are shared launchers/hosts, never the identity of one particular game.
const coldClient = /^steamclient_loader(?:_x(?:32|64))?\.exe$/i;
const sharedHost = /^(?:UniverseLANServer(?:64)?|cmd|powershell|pwsh|conhost|explorer|wscript|cscript|rundll32|python(?:w|3(?:\.\d+)?)?|steam|EpicGamesLauncher|UbisoftConnect|GalaxyClient|Origin|EADesktop)\.exe$/i;

function gameProcessName(executable) {
  const name = path.win32.basename(String(executable || "").trim());
  return /\.exe$/i.test(name) && !coldClient.test(name) && !sharedHost.test(name) ? name : "";
}

async function resolveGameProcessName(executable) {
  const name = gameProcessName(executable);
  if (name) return name;
  if (!coldClient.test(path.win32.basename(String(executable || "")))) return "";
  // ColdClient declares the game's real executable relative to its INI file.
  // Read only that file and target; do not scan the installation or run scripts.
  try {
    const directory = path.dirname(executable);
    const ini = path.join(directory, "ColdClientLoader.ini");
    const info = await fs.stat(ini);
    if (!info.isFile() || info.size > 256 * 1024) return "";
    const source = (await fs.readFile(ini, "utf8")).replace(/^\uFEFF/, "");
    const relative = /^\s*Exe\s*=\s*(.*?)\s*$/im.exec(source)?.[1]?.replace(/^"|"$/g, "");
    if (!relative) return "";
    const target = path.resolve(directory, relative.replace(/\\/g, path.sep));
    const runtime = gameProcessName(target);
    return runtime && (await fs.stat(target)).isFile() ? runtime : "";
  } catch { return ""; }
}

module.exports = { gameProcessName, resolveGameProcessName };
