"use strict";

// Resolve a runtime and its files, never a game name. Game identity is supplied
// by param.sfo/npbind.dat in ps4-recomp.js. Nothing here executes port scripts.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { samePath } = require("./pc-ports");
const collections = require("./ps4-recomp-collections");
const compiledLaunchers = require("./ps4-recomp-compiled-launcher");
const GAME_PATH_KEYS = ["game_dir", "game_path", "game", "app0", "prepared_dir", "update", "update_dir", "base", "base_dir"];

function regular(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function directory(file) {
  try { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}
function text(file, limit = 512 * 1024) {
  if (!regular(file) || fs.statSync(file).size > limit) return "";
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}
function readSettings(file, extraKeys = []) {
  const source = text(file, 1024 * 1024);
  if (!source && !regular(file)) return {};
  const result = Object.create(null);
  const accept = (key, value) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) return;
    if (Object.hasOwn(result, key) && result[key] !== value) throw new Error(`Ambiguous launcher setting: ${key}`);
    result[key] = value;
  };
  if (/\.json$/i.test(file)) {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid PS4 Recomp launcher settings");
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // INI-like JSON sections used by launchers. No recursive arbitrary data.
        if (/^(?:launcher|paths|folders)$/i.test(key)) for (const [k, v] of Object.entries(value)) accept(k, v);
      } else accept(key, value);
    }
  } else for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([\w.-]+)\s*=(.*)$/.exec(line);
    // Display/controller INIs may repeat keys across sections. They cannot
    // select a game and must not make an otherwise valid launcher ambiguous.
    if (match && (extraKeys.includes(match[1]) || /^(?:game_dir|game_path|game|app0|prepared_dir|update|base|base_dir|update_dir|user_dir|saves_dir|data_dir|log_dir|logs_dir|user_id|extra_env)$/.test(match[1]) || /^[A-Z][A-Z0-9_]*_(?:GAME|USER|DATA|LOG)_DIR$/.test(match[1]))) {
      accept(match[1], match[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return result;
}
function runners(root) {
  if (!directory(root)) return [];
  const names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /\.(?:py|sh)$/i.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => Number(/^run\./i.test(b)) - Number(/^run\./i.test(a)) || a.localeCompare(b)).slice(0, 64);
  return names.map((name) => ({ file: path.join(root, name), source: text(path.join(root, name)) }))
    .filter((entry) => /boot-linked\.bin|--app0\b/.test(entry.source));
}
function launcherSources(root) {
  const result = [];
  for (const relative of ["launcher", "source", ""]) {
    const folder = path.join(root, relative);
    if (!directory(folder)) continue;
    const names = fs.readdirSync(folder).filter((name) => /\.pyw?$/i.test(name) && (relative === "launcher" || /launcher/i.test(name))).sort();
    if (names.length > 48) throw new Error("PS4 Recomp launcher source directory exceeds its discovery limit");
    for (const name of names) {
      const file = path.join(folder, name), source = text(file);
      if (source) result.push({ file, source });
    }
  }
  return result;
}
function runnerNames(source) {
  return [...source.matchAll(/\b(?:PORT_DIR|PORT|RUNTIME|ROOT)\s*\/\s*['"]([a-z0-9_.-]+\.(?:py|sh))['"]/gi)].map((match) => match[1]);
}
function entryFiles(root) {
  return fs.readdirSync(root).filter((name) => /\.(?:bat|cmd|desktop|spec|sh)$/i.test(name) && !/^(?:run|build)\.sh$/i.test(name)).sort().slice(0, 64);
}
function activeSources(root, launchers, scripts) {
  const owned = [...launchers, ...scripts];
  // A shipping entry point is stronger evidence than an unused source file.
  // Only literal references to files belonging to this installation are used.
  const wrappers = entryFiles(root);
  const sources = wrappers.map((name) => text(path.join(root, name)).split(/\r?\n/)
    .filter((line) => !/^\s*(?:#|rem\b|::)/i.test(line)).join("\n"));
  const active = new Set();
  const references = (source, file) => {
    const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s/\\\\'\"])${escaped}(?=$|[\\s'\"])`, "im").test(source);
  };
  for (const entry of owned) if (sources.some((source) => references(source, entry.file))) active.add(entry);
  // Link a CLI runner back to its own launcher (and its settings location).
  for (const entry of launchers) if (runnerNames(entry.source).some((name) => scripts.some((script) => active.has(script) && path.basename(script.file) === name))) active.add(entry);
  // Launcher helpers can own the settings (e.g. an imported online module).
  for (let pass = 0; pass < 2; pass++) for (const entry of [...active]) for (const helper of launchers) {
    const module = path.basename(helper.file, path.extname(helper.file)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*(?:from\\s+${module}\\s+import|import\\s+${module}\\b)`, "m").test(entry.source)) active.add(helper);
  }
  return active;
}
function gamePath(cfg, root) {
  for (const key of [...GAME_PATH_KEYS, ...Object.keys(cfg).filter((key) => /^[A-Z][A-Z0-9_]*_GAME_DIR$/.test(key))]) {
    const value = cfg[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = path.resolve(root, value);
    if (regular(path.join(candidate, "sce_sys", "param.sfo"))) return candidate;
  }
  return "";
}
function literalPaths(source, root) {
  const values = { PORT: root, PORT_DIR: root, ROOT: root, BASE: root, RUNTIME: root, HERE: path.join(root, "launcher"), data: root };
  const expression = (raw) => {
    const match = /^([A-Za-z_]\w*)((?:\.parent)*)(\s*(?:\/\s*(?:'[^'\r\n]*'|"[^"\r\n]*")\s*)*)$/.exec(raw.trim());
    if (!match || !values[match[1]]) return "";
    let result = values[match[1]];
    for (const _ of match[2].matchAll(/\.parent/g)) result = path.dirname(result);
    for (const part of match[3].matchAll(/['"]([^'"]*)['"]/g)) result = path.resolve(result, part[1]);
    return result;
  };
  for (const line of source.split(/\r?\n/)) {
    const tuple = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (tuple) {
      const names = tuple[1].split(/\s*,\s*/), expressions = tuple[2].split(/\s*,\s*/);
      if (names.length === expressions.length) names.forEach((name, index) => { const value = expression(expressions[index]); if (value) values[name] = value; });
      continue;
    }
    const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!assignment) continue;
    let raw = assignment[2];
    const env = /^Path\((?:os\.environ|env)\.get\(['"]([A-Z][A-Z0-9_]*)['"],\s*(.+)\)\)(?:\.resolve\(\))?$/.exec(raw);
    if (env) raw = env[2];
    const value = env && process.env[env[1]] ? path.resolve(root, process.env[env[1]]) : expression(raw);
    if (value) values[assignment[1]] = value;
  }
  return values;
}
function externalLocations(entry) {
  const result = [];
  for (const match of entry.source.matchAll(/['"]([a-z0-9][a-z0-9._-]*[-_]launcher)['"]/gi)) {
    const base = process.platform === "win32" ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    if (base) result.push({ file: path.join(base, match[1], "settings.json") });
  }
  // Other launcher families declare their own config folder and filename.
  // Both literals must occur in the actual config assignments.
  const configAssignment = entry.source.match(/^CONFIG_DIR\s*=\s*((?:[^\r\n]*\r?\n[ \t]+)?[^\r\n]*)$/m)?.[1] || "";
  const configFolder = /APPDATA|XDG_CONFIG_HOME/.test(configAssignment) ? configAssignment.match(/\/\s*['"]([a-z0-9][a-z0-9._-]+)['"]\s*$/i)?.[1] : "";
  const configName = entry.source.match(/CONFIG_FILE\s*=\s*CONFIG_DIR\s*\/\s*['"]([a-z0-9_.-]+\.(?:json|ini))['"]/i)?.[1];
  if (configFolder && configName) {
    const base = process.platform === "win32" ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    if (base) result.push({ file: path.join(base, configFolder, configName) });
  }
  // A bounded literal declaration is evidence, not a search of the data tree.
  for (const match of ( /['"]launcher\.json['"]/.test(entry.source) ? entry.source : "").matchAll(/['"]XDG_DATA_HOME['"][\s\S]{0,160}?\)\)\s*\/\s*['"]([a-z0-9][a-z0-9._-]*)['"]/gi)) {
    const dataRoot = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), match[1]);
    result.push({ file: path.join(dataRoot, "launcher.json"), dataRoot });
  }
  return result;
}
function settingsCandidates(root, launchers, hints = []) {
  const local = [];
  for (const relative of ["", "data", "user", "launcher"]) {
    const folder = path.join(root, relative);
    if (!directory(folder)) continue;
    const names = fs.readdirSync(folder).filter((name) => /^(?:settings|launcher)\.(?:json|ini)$/i.test(name) || /\.ini$/i.test(name)).sort();
    if (names.length > 128) throw new Error("PS4 Recomp settings directory exceeds its discovery limit");
    for (const name of names) {
      const file = path.join(folder, name);
      if (regular(file)) local.push({ file, external: false, bindings: [] });
    }
  }
  const external = new Map();
  for (const entry of launchers) for (const location of externalLocations(entry)) {
    if (!regular(location.file)) continue;
    const item = external.get(location.file) || { ...location, external: true, bindings: [] };
    item.bindings.push(entry); external.set(location.file, item);
  }
  for (const hint of hints) {
    const file = hint.ps4_recomp_settings_file;
    if (!samePath(hint.ps4_recomp_install_root, root) || typeof file !== "string" || !path.isAbsolute(file) || !regular(file) ||
        !/^CUSA\d{5}$/.test(hint.ps4_recomp_title_id || "")) continue;
    const item = external.get(file) || { file, external: true, bindings: [] };
    item.savedTitleIds ||= new Set(); item.savedTitleIds.add(hint.ps4_recomp_title_id);
    external.set(file, item);
  }
  return [...local, ...external.values()];
}
function resolveSettings(root, launchers, identity, hints, active, compiled) {
  const candidates = settingsCandidates(root, launchers, hints);
  for (const file of compiled?.settings || []) if (regular(file)) {
    const existing = candidates.find((entry) => samePath(entry.file, file));
    if (existing) existing.compiled = true;
    else candidates.push({ file, external: true, bindings: [], compiled: true });
  }
  const hasSavedBinding = candidates.some((entry) => entry.savedTitleIds?.size);
  const usable = [], errors = [];
  const activeIds = new Set([...active].filter((entry) => externalLocations(entry).length || /boot-linked\.bin|--app0\b/.test(entry.source))
    .flatMap((entry) => entry.source.match(/\bCUSA\d{5}\b/g) || []));
  const families = new Set(launchers.filter((entry) => /\bCUSA\d{5}\b/.test(entry.source)).flatMap(externalLocations).map((location) => path.resolve(location.file).toLowerCase()));
  for (const candidate of candidates) {
    if (compiled && !compiled.settings.some((file) => samePath(file, candidate.file))) continue;
    const activeBinding = candidate.bindings.some((entry) => active.has(entry));
    const rank = !candidate.external ? 4 : activeBinding || candidate.compiled ? 3 : candidate.savedTitleIds?.size ? 2 : 0;
    if (candidate.external && rank === 0 && (active.size || hasSavedBinding || families.size > 1)) continue;
    try {
      const cfg = readSettings(candidate.file);
      if (candidate.dataRoot && !cfg.game && candidate.bindings.some((entry) => /['"]game-folder['"]/.test(entry.source))) {
        const saved = text(path.join(candidate.dataRoot, "game-folder"), 4096).trim();
        if (saved) cfg.game = saved;
      }
      const gameRoot = gamePath(cfg, root);
      if (!gameRoot) continue; // Graphics/settings files cannot select the game.
      const declaredGames = ["game_dir", "game_path", "game", "app0", "update", "base", "base_dir", "update_dir"].map((key) => cfg[key])
        .filter((value) => typeof value === "string" && value.trim()).map((value) => identity(path.resolve(root, value)).ps4_recomp_title_id).filter(Boolean);
      if (new Set(declaredGames).size > 1) throw new Error("PS4 Recomp base and update belong to different games");
      if (candidate.external) {
        // An installed launcher elsewhere in AppData is not evidence. Require
        // this installation's launcher source to bind that config to the SFO ID.
        const id = identity(gameRoot).ps4_recomp_title_id;
        if (activeIds.size && !activeIds.has(id) && !activeBinding) continue;
        if (!id || !candidate.compiled && !candidate.savedTitleIds?.has(id) && !candidate.bindings.some((entry) => {
          const ids = new Set(entry.source.match(/\bCUSA\d{5}\b/g) || []);
          return ids.has(id);
        })) continue;
      }
      const bindings = candidate.external ? candidate.bindings : launchers.filter((entry) =>
        Object.values(literalPaths(entry.source, root)).some((value) => samePath(value, candidate.file)));
      usable.push({ ...candidate, bindings, cfg, gameRoot, rank });
    } catch (error) { errors.push({ rank, error }); }
  }
  const best = Math.max(-1, ...usable.map((entry) => entry.rank));
  const relevantError = errors.find((entry) => entry.rank > best);
  if (relevantError) throw relevantError.error;
  const selected = usable.filter((entry) => entry.rank === best);
  const unique = new Map(selected.map((entry) => [path.resolve(entry.gameRoot).toLowerCase(), entry]));
  if (unique.size > 1) throw new Error("PS4 Recomp launcher settings refer to different games; refusing to choose another installation's game");
  if (!selected.length) {
    if (hasSavedBinding) throw new Error("Saved PS4 Recomp launcher settings no longer match the original game's identity");
    if (!active.size && families.size > 1) throw new Error("Ambiguous PS4 Recomp launcher ownership; configure this installation's launcher before importing");
    return null;
  }
  // Prefer launcher over graphics settings; duplicate sources for one game
  // must also agree about save/data locations.
  const locations = new Set(selected.map((entry) => JSON.stringify([
    entry.cfg.user_dir || "", entry.cfg.data_dir || "",
  ])));
  if (locations.size > 1) throw new Error("PS4 Recomp launcher settings disagree about the progress location");
  return selected.sort((a, b) => /launcher\.(json|ini)$/i.test(b.file) - /launcher\.(json|ini)$/i.test(a.file))[0];
}
function packageDeclarations(root, owners = []) {
  // Bounded literal C launcher manifests shipped with a multi-port package.
  // No game IDs, application names, or AppData folder names are embedded here.
  const declarations = [];
  for (const owner of [...new Set([root, path.dirname(path.dirname(root)), ...owners])]) {
    if (typeof owner !== "string" || !path.isAbsolute(owner)) continue;
    const folder = path.join(owner, "src");
    if (!directory(folder)) continue;
    for (const name of fs.readdirSync(folder).filter((name) => /\.c$/i.test(name)).sort().slice(0, 32)) {
      const file = path.join(folder, name), source = text(file);
      const table = source.match(/static\s+const\s+Game\s+\w+\s*\[[^\]]*\]\s*=\s*\{([\s\S]*?)\n\};/)?.[1];
      const layout = source.match(/static\s+void\s+PortDir\([^)]*\)\s*\{([^}]+)\}/)?.[1];
      const settings = source.match(/static\s+void\s+SfPath\([^)]*\)\s*\{([^}]+)\}/)?.[1];
      const relative = layout?.match(/Join\(\w+,\s*\w+,\s*L"([a-z0-9_-]+)"\)/i)?.[1];
      const variable = settings?.match(/GetEnvironmentVariableW\(L"(LOCALAPPDATA|APPDATA)"/)?.[1];
      const ini = settings?.match(/L"([a-z0-9_.-]+\.ini)"/i)?.[1];
      if (!table || !relative || !variable || !ini || !process.env[variable]) continue;
      const master = source.match(/GetEnvironmentVariableW\(L"(LOCALAPPDATA|APPDATA)",\s*(\w+),[\s\S]{0,240}?Join\((\w+),\s*\2,\s*L"([a-z0-9_-]+)"\);[\s\S]{0,160}?Join\((\w+),\s*\3,\s*L"([a-z0-9_.-]+\.ini)"\)/i);
      const masterFile = master && process.env[master[1]] ? path.join(process.env[master[1]], master[4], master[6]) : "";
      const keyTemplate = layout.match(/L"([a-z0-9_-]*%s[a-z0-9_-]*)"/i)?.[1];
      const rows = [...table.matchAll(/\{L"([a-z0-9_.-]+)",\s*L"[^"]*",\s*L"([a-z0-9_.-]+\.exe)",\s*L"([a-z0-9_.-]+)",\s*FALSE\}/gi)];
      const overrides = masterFile && keyTemplate ? readSettings(masterFile, rows.map((row) => keyTemplate.replace("%s", row[1]))) : {};
      const children = [];
      for (const row of rows) {
        if ([row[1], row[3]].some((value) => value === "." || value === "..")) continue;
        const override = keyTemplate && overrides[keyTemplate.replace("%s", row[1])];
        const installRoot = typeof override === "string" && path.isAbsolute(override) && directory(override) ? override : path.join(owner, relative, row[1]);
        const dataRoot = path.join(process.env[variable], row[3]);
        children.push({ installRoot, dataRoot, settingsFile: path.join(dataRoot, ini), declarationFile: file, packageOwner: owner, packageSettings: masterFile });
      }
      if (children.length > 64) throw new Error("PS4 Recomp package declaration exceeds its discovery limit");
      declarations.push(...children.filter((entry) => samePath(owner, root) || samePath(entry.installRoot, root)));
    }
  }
  return declarations;
}
function resolve(root, { identity, collection, hints = [], packageOwner }) {
  if (!directory(root)) return null;
  const owners = [packageOwner, ...hints.filter((hint) => samePath(hint.ps4_recomp_install_root, root)).map((hint) => hint.ps4_recomp_package_owner)].filter(Boolean);
  const declared = packageDeclarations(root, owners);
  const binding = declared.find((entry) => samePath(entry.installRoot, root));
  const children = declared.filter((entry) => !samePath(entry.installRoot, root) && directory(entry.installRoot));
  if (children.length) return { port: "container", children: children.map((entry) => entry.installRoot), packageOwner: root,
    identityFiles: [...new Set(children.map((entry) => path.relative(root, entry.declarationFile)))], settingsFiles: [...new Set(children.map((entry) => entry.packageSettings).filter(Boolean))] };
  const scripts = runners(root);
  const prepared = ["out/boot-linked.bin", "out/content.bin", "game/image/boot.bin", "game/image/content.bin"]
    .some((relative) => regular(path.join(root, relative)));
  const nativeLayout = directory(path.join(root, "game", "prepared")) && directory(path.join(root, "game", "image"));
  const nativeCandidate = ["bin", "data", "logs"].some((name) => directory(path.join(root, name))) &&
    ["launcher.ini", "launcher.json", "settings.json", "user/launcher.ini"].some((name) => {
      try { const candidate = gamePath(readSettings(path.join(root, name)), root); return candidate && !!identity(candidate).ps4_recomp_title_id; }
      catch { return false; }
    });
  if (!scripts.length && !prepared && !nativeLayout && !nativeCandidate && !binding) return null;
  const launchers = launcherSources(root);
  // Source-based launchers keep their existing adapter. Compiled readers are
  // prepared asynchronously and only consulted for source-free installations.
  if (!scripts.length && !launchers.length) compiledLaunchers.restore(root, hints);
  const compiled = !scripts.length && !launchers.length ? compiledLaunchers.resolveContract(root) : null;
  const active = activeSources(root, launchers, scripts);
  const ownedCollection = scripts.map((entry) => collections.identify(entry.source)).find(Boolean);
  if (ownedCollection) for (const entry of launchers) {
    if (collections.identify(entry.source)?.port === ownedCollection.port) active.add(entry);
  }
  let selected = resolveSettings(root, launchers, identity, hints, active, compiled);
  const compiledErrors = !scripts.length && !launchers.length && compiledLaunchers.cached(root)?.errors;
  if (!selected && !compiled && compiledErrors?.length) throw new Error(compiledErrors[0]);
  if (binding) {
    const cfg = readSettings(binding.settingsFile), gameRoot = gamePath(cfg, root);
    if (selected && gameRoot && !samePath(selected.gameRoot, gameRoot)) throw new Error("PS4 Recomp package and local settings select different games");
    if (!selected && gameRoot && identity(gameRoot).ps4_recomp_title_id) selected = { file: binding.settingsFile, cfg, gameRoot, bindings: [] };
  }
  // Native launchers use a selected PS4 dump plus runtime data/resources; no
  // particular executable name is required. A bare game dump is not a port.
  const nativeConfigured = selected && !selected.external &&
    (directory(path.join(root, "bin")) || directory(path.join(root, "data")) || directory(path.join(root, "logs")));
  if (!scripts.length && !prepared && !nativeLayout && !nativeConfigured && !binding) return null;
  const selectedId = selected?.gameRoot ? identity(selected.gameRoot).ps4_recomp_title_id : "";
  const runnerBindings = selected?.bindings?.length ? selected.bindings : selectedId ?
    launchers.filter((entry) => (entry.source.match(/\bCUSA\d{5}\b/g) || []).includes(selectedId)) : [];
  const declaredNames = new Set(runnerBindings.flatMap((entry) => runnerNames(entry.source)));
  const referenced = scripts.filter((entry) => declaredNames.has(path.basename(entry.file)));
  const compatible = selectedId ? scripts.filter((entry) => {
    const ids = new Set(entry.source.match(/\bCUSA\d{5}\b/g) || []);
    return !ids.size || ids.has(selectedId);
  }) : scripts;
  const specific = selectedId && compatible.filter((entry) => entry.source.includes(selectedId));
  const activeRunners = compatible.filter((entry) => active.has(entry));
  const choices = referenced.length ? referenced : activeRunners.length ? activeRunners : specific?.length ? specific : compatible;
  const script = choices.find((entry) => entry.file.endsWith(".py")) || choices[0];
  const source = script?.source || "";
  const prefixes = [...new Set([...source.matchAll(/\b([A-Z][A-Z0-9_]*)_GAME_DIR\b/g)].map((match) => match[1]))];
  if (prefixes.length > 1) throw new Error("Ambiguous PS4 Recomp runtime environment");
  const collectionPort = collections.identify(source);
  // Collections retain their established routing and cache keys. Their
  // launcher can be bound by the explicit collection runner rather than CUSA.
  let chosen = selected;
  if (collectionPort && !chosen) {
    const file = path.join(process.env.APPDATA || process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), collectionPort.settings, collectionPort.settingsName || "settings.json");
    if (regular(file)) chosen = { file, cfg: readSettings(file) };
  }
  const localPending = settingsCandidates(root, []).filter((entry) => /(?:^|[\\/])(?:launcher|settings)\.(?:json|ini)$/i.test(entry.file) ||
    text(entry.file).includes(`${prefixes[0]}_GAME_DIR`));
  const settingsFile = chosen?.file || binding?.settingsFile || localPending[0]?.file || path.join(root, "launcher.ini");
  const pendingExternal = chosen ? [] : launchers.filter((entry) => active.size ? active.has(entry) : true).flatMap(externalLocations).map((location) => location.file);
  const logFiles = [...new Set([...(compiled?.logFiles || []), ...(chosen?.bindings || []).flatMap((entry) => Object.entries(literalPaths(entry.source, root))
    .filter(([key, value]) => /^(?:LOG|LOG_FILE|LOG_PATH|LAST_LOG|LAST_RUN_LOG)$/.test(key) && /\.log$/i.test(value))
    .map(([, value]) => value))])];
  const nativeLocation = (names) => {
    const values = !scripts.length ? (chosen?.bindings || []).flatMap((entry) => {
      const literals = literalPaths(entry.source, root);
      return names.map((name) => literals[name]).filter(Boolean);
    }) : [];
    if (new Set(values.map((value) => path.resolve(value).toLowerCase())).size > 1) throw new Error("Ambiguous PS4 Recomp native launcher paths");
    return values[0] || "";
  };
  const overrides = {};
  for (const entry of chosen?.bindings || []) {
    const literals = literalPaths(entry.source, root);
    for (const match of entry.source.matchAll(/['"]([A-Z][A-Z0-9_]*_(?:DATA|USER|GAME)_DIR)['"]\s*:\s*str\(([A-Za-z_]\w*)\)/g)) {
      if (!literals[match[2]]) continue;
      if (overrides[match[1]] && !samePath(overrides[match[1]], literals[match[2]])) throw new Error("Ambiguous PS4 Recomp launcher paths");
      overrides[match[1]] = literals[match[2]];
    }
  }
  return { ...(collectionPort || { port: "generic", launcher: "" }),
    env: prefixes[0] || "", settingsFile, scriptFile: script?.file || "", script: source,
    identityFiles: [...new Set([...entryFiles(root), ...(compiled?.executables || []).map((file) => path.relative(root, file)), ...[...launchers, ...scripts].map((entry) => path.relative(root, entry.file))])],
    settingsFiles: [...new Set([settingsFile, ...(compiled?.settings || []), ...(compiled?.dependencies || []), ...pendingExternal, ...localPending.map((entry) => entry.file), ...(binding ? [binding.declarationFile, binding.packageSettings].filter(Boolean) : []), ...(chosen?.dataRoot ? [path.join(chosen.dataRoot, "game-folder")] : []), ...["settings.json", "launcher.ini", "launcher.json", "data/launcher.json", "data/settings.json", "user/launcher.json", "user/launcher.ini", "launcher/settings.json"].map((name) => path.join(root, name))])],
    launcherSources: chosen?.bindings || [], logFiles, runtimeOverrides: overrides, nativeLayout, nativeConfigured: !!nativeConfigured, hasRunner: scripts.length > 0,
    selectedGameRoot: chosen?.gameRoot || "", declaredDataRoot: binding?.dataRoot || chosen?.dataRoot || nativeLocation(["DATA", "DATA_DIR"]),
    declaredUserRoot: compiled?.userRoot || nativeLocation(["USER", "USER_DIR"]),
    ...(compiled ? { compiledLauncher: compiledLaunchers.snapshot(root), compiledLogDirectories: compiled.logDirectories, compiledRuntime: compiled.runtime } : {}),
    ...(binding ? { packageOwner: binding.packageOwner } : {}),
    allowRunnerGameDefault: new Set(launchers.flatMap((entry) => entry.source.match(/\bCUSA\d{5}\b/g) || [])).size <= 1 };
}

module.exports = { resolve, text, regular, directory, readSettings, runners, launcherSources, gamePath, literalPaths, packageDeclarations };
