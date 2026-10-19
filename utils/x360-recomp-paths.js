"use strict";

const fs = require("fs");
const path = require("path");
const { parseTomlFile, readStateText } = require("./x360-recomp-state");
const PATH_KEYS = ["game_data_root", "user_data_root", "metadata_root"];

// Match the literal tokenization used by Play. No shell is evaluated here.
function argumentPaths(input, base, options = {}) {
  const text = String(input || "").trim();
  if (text.length > 128 * 1024 || /[\r\n\x00]/.test(text)) throw new Error("Invalid recomp launch arguments");
  const tokens = (text.match(/(?:[^\s"]+|"[^"]*"|'[^']*')+/g) || []).map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")) ? part.slice(1, -1) : part);
  const runtime = {};
  for (let i = 0; i < tokens.length; i++) {
    const match = /^--(game_data_root|user_data_root|metadata_root)(?:=(.*))?$/i.exec(tokens[i]);
    if (!match) continue;
    const raw = match[2] === undefined ? tokens[++i] : match[2];
    // Quotes embedded in --key="value" would also reach the executable via
    // Play. Reject that ambiguous form instead of monitoring a different path.
    const value = typeof raw === "string" && raw && !raw.startsWith("--") && !/"/.test(raw) &&
      !/^[a-z]+:\/\//i.test(raw) && path.resolve(base, raw);
    if (!value) throw new Error(`Unresolved launch ${match[1]}`);
    runtime[match[1].toLowerCase()] = value;
  }
  return runtime;
}

function pathArguments(runtime) {
  return PATH_KEYS.filter((key) => runtime[key]).map((key) => {
    const value = String(runtime[key]);
    if (/["\r\n\x00]/.test(value)) throw new Error("Invalid recomp launch path");
    // Separate flag/value tokens also work with Play's current parser.
    return `--${key} "${value}"`;
  }).join(" ");
}

function expandPath(value, base, options = {}, variables = {}) {
  if (typeof value !== "string" || !value.trim()) return "";
  const env = { USERPROFILE: options.userProfile || process.env.USERPROFILE,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, ...variables };
  let text = value.trim().replace(/^(["'])(.*)\1$/, "$2")
    .replace(/%~dp0/gi, `${options.scriptRoot || base}${path.sep}`).replace(/\$PSScriptRoot\b/gi, options.scriptRoot || base);
  text = text.replace(/%([a-z_][a-z0-9_]*)%/gi, (match, name) => env[name.toUpperCase()] || match);
  // Never evaluate expressions, substitutions, arbitrary shell variables or commands.
  if (/[%$`\r\n\x00]/.test(text) || /^[a-z]+:\/\//i.test(text)) return "";
  return path.resolve(base, text);
}

function collectPaths(doc) {
  const queue = [doc], values = {};
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const key of PATH_KEYS) if (typeof node[key] === "string" && node[key].trim()) {
      if (values[key] && values[key] !== node[key]) throw new Error(`Conflicting ${key} declarations`);
      values[key] = node[key];
    }
    queue.push(...Object.values(node).filter((value) => value && typeof value === "object" && !Array.isArray(value)));
  }
  return values;
}

function runtimePaths(file) {
  try { return collectPaths(parseTomlFile(file)); }
  catch (originalError) {
    // Some native launchers write Windows paths in double quotes without TOML
    // escaping. Recover those literal absolute paths only, in memory. Metadata
    // and unlock TOML continue to use the strict parser.
    const text = readStateText(file);
    let repaired = false;
    const normalized = text.replace(/^(\s*[a-z_][a-z0-9_-]*\s*=\s*)"((?:[a-z]:\\|\\\\)[^"\r\n]*)"(\s*(?:#.*)?)$/gim,
      (line, prefix, value, suffix) => {
        try { require("smol-toml").parse(`value = "${value}"`); return line; }
        catch { repaired = true; return `${prefix}${JSON.stringify(value)}${suffix}`; }
      });
    if (!repaired) throw originalError;
    return collectPaths(require("smol-toml").parse(normalized));
  }
}

function launcherPaths(file, options) {
  const base = path.dirname(file), variables = {}, found = [];
  options = { ...options, scriptRoot: base };
  let cwd = base, uncertain = false;
  const text = readStateText(file);
  if (text.length > 128 * 1024) throw new Error("Oversized recomp launcher");
  const lines = text.replace(/\^\r?\n/g, " ").split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim().replace(/^@/, "");
    if (!line || /^(?:rem\b|::|#)/i.test(line)) continue;
    if (/^(?:if|for|else|goto|call|popd|push-location|pop-location)\b|[{}]|^[()]/i.test(line)) { uncertain = true; continue; }
    const assignment = /^set\s+"?([a-z_][a-z0-9_]*)=([^\r\n]*?)"?$/i.exec(line);
    if (assignment) {
      const value = expandPath(assignment[2], cwd, options, variables);
      if (value) variables[assignment[1].toUpperCase()] = value;
      continue;
    }
    const cd = /^(?:cd(?:\s+\/d)?|pushd|Set-Location(?:\s+-LiteralPath)?)\s+(.+)$/i.exec(line);
    if (cd) { const value = expandPath(cd[1], cwd, options, variables); if (value) cwd = value; else uncertain = true; continue; }
    // START is common in shipped batch launchers. Only its literal empty-title,
    // standard window/wait flags and /D directory form are accepted.
    if (/^start\s/i.test(line)) {
      line = line.replace(/^start\s+/i, "").replace(/^""\s+/, "");
      while (/^\/(?:wait|b|min|max|d)(?:\s|$)/i.test(line)) {
        const flag = /^\/(wait|b|min|max|d)\s*/i.exec(line);
        line = line.slice(flag[0].length);
        if (flag[1].toLowerCase() === "d") {
          const directory = /^(?:"([^"]+)"|([^\s"]+))\s+/.exec(line);
          const value = directory && expandPath(directory[1] || directory[2], cwd, options, variables);
          if (!value) { uncertain = true; break; }
          cwd = value; line = line.slice(directory[0].length);
        }
      }
    }
    // Only a direct native executable invocation is accepted; conditional,
    // piped or dynamically assembled launch commands need an existing state.
    const invocation = /^(?:&\s*)?(?:"([^"]+\.exe)"|'([^']+\.exe)'|([^\s"']+\.exe))(?:\s|$)/i.exec(line);
    if (!invocation || /[|<>;]|(?:&&)|\b(?:if|for|powershell|cmd)\b/i.test(line) || uncertain) continue;
    const executable = expandPath(invocation[1] || invocation[2] || invocation[3], cwd, options, variables);
    if (!executable) continue;
    const runtime = {};
    for (const key of PATH_KEYS) {
      const match = new RegExp(`--${key}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "i").exec(line);
      if (!match) continue;
      const value = expandPath(match[1] || match[2] || match[3], cwd, options, variables);
      if (!value) throw new Error(`Unresolved launcher ${key}`);
      runtime[key] = value;
    }
    if (Object.keys(runtime).length) found.push({ file, executable, runtime, kind: "launcher", base: cwd });
  }
  return found;
}

function readDeclarations(root, entries, options = {}) {
  const declarations = [], errors = [];
  const files = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && !options.isBlocked?.(path.join(root, entry.name)) && /\.(?:toml|bat|cmd|ps1)$/i.test(entry.name) &&
    !/^(?:achievements|.*_manifest)\.toml$/i.test(entry.name)).slice(0, 32);
  for (const entry of files) {
    const file = path.join(root, entry.name);
    try {
      if (/\.toml$/i.test(file)) {
        const runtime = runtimePaths(file);
        if (Object.keys(runtime).length) declarations.push({ file, runtime, kind: "config", base: root });
      } else declarations.push(...launcherPaths(file, options));
    } catch (error) { errors.push({ root, file, error: error.message }); }
  }
  return { declarations, errors };
}

// reNut's wizard writes literal Windows paths, not TOML-escaped strings.
// Mirror its key=value reader; never evaluate the file as a launch script.
function readPortConfig(file, options = {}) {
  if (options.isBlocked?.(file)) throw new Error("Blocked recomp path configuration");
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Linked recomp path configuration");
  const text = readStateText(file);
  if (text.length > 128 * 1024) throw new Error("Oversized recomp path configuration");
  const runtime = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!["game_data_root", "user_data_root"].includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // The wizard saves absolute paths. Relative/custom values require an
    // explicit manifest: the launcher's working directory is not known here.
    if (!path.isAbsolute(value) || /[\r\n\x00]/.test(value)) throw new Error(`Unresolved port ${key}`);
    runtime[key] = path.normalize(value);
  }
  if (!runtime.game_data_root || !runtime.user_data_root) throw new Error("Incomplete recomp path configuration");
  return { file, runtime, kind: "port-config", base: path.dirname(file) };
}

module.exports = { expandPath, collectPaths, readDeclarations, readPortConfig, argumentPaths, pathArguments };
