"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");

const MARKERPATCH_APP_ID = "47780";
const MARKERPATCH_PLATFORM = "markerpatch";
const MARKERPATCH_GAME_NAME = "Dead Space 2";
const MARKERPATCH_CONFIG_NAME = "Dead Space 2 (MarkerPatch)";
const MARKERPATCH_ACHIEVEMENT_COUNT = 51;
const MARKERPATCH_PROVIDER = "markerpatch";
const MARKERPATCH_STATE_RELATIVE_PATH = path.join(
  "EA Games",
  "Dead Space 2",
  "settings.txt",
);

const MARKERPATCH_LANGUAGE_FILES = Object.freeze({
  en: "english",
  de: "german",
  es: "spanish",
  fr: "french",
  it: "italian",
});

function normalizePathForComparison(value) {
  if (!value) return "";
  let resolved = "";
  try {
    resolved = path.resolve(String(value));
  } catch {
    return "";
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(rootPath, targetPath) {
  const root = normalizePathForComparison(rootPath);
  const target = normalizePathForComparison(targetPath);
  if (!root || !target) return false;
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function getMarkerPatchPaths(rootPath) {
  const root = path.resolve(String(rootPath || ""));
  const achievementsDir = path.join(root, "achievements");
  return {
    root,
    executable: path.join(root, "deadspace2.exe"),
    ini: path.join(root, "MarkerPatch.ini"),
    achievementsDir,
    imagesDir: path.join(achievementsDir, "img"),
    textDir: path.join(achievementsDir, "txt"),
  };
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function detectMarkerPatchRoot(rootPath) {
  if (!rootPath) return { detected: false, partial: false, root: "" };
  let paths = null;
  try {
    paths = getMarkerPatchPaths(rootPath);
  } catch {
    return { detected: false, partial: false, root: "" };
  }

  const signals = {
    executable: isFile(paths.executable),
    ini: isFile(paths.ini),
    images: isDirectory(paths.imagesDir),
    texts: isDirectory(paths.textDir),
  };
  const signalCount = Object.values(signals).filter(Boolean).length;
  return {
    detected: signalCount === Object.keys(signals).length,
    partial: signalCount > 0 && signalCount < Object.keys(signals).length,
    root: paths.root,
    paths,
    signals,
  };
}

function resolveMarkerPatchStateFile(options = {}) {
  const candidates = [];
  const addCandidate = (base) => {
    if (!base) return;
    try {
      const candidate = path.join(String(base), MARKERPATCH_STATE_RELATIVE_PATH);
      if (
        !candidates.some(
          (item) =>
            normalizePathForComparison(item) ===
            normalizePathForComparison(candidate),
        )
      ) {
        candidates.push(candidate);
      }
    } catch {}
  };

  addCandidate(options.localAppData);
  addCandidate(process.env.LOCALAPPDATA);
  if (options.appData) {
    try {
      addCandidate(path.join(path.dirname(String(options.appData)), "Local"));
    } catch {}
  }

  if (!candidates.length) return "";
  return candidates.find((candidate) => isFile(candidate)) || candidates[0];
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || "");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function parseUint32(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let parsed = null;
  try {
    parsed = /^0x[0-9a-f]+$/i.test(raw)
      ? BigInt(raw)
      : /^\d+$/.test(raw)
        ? BigInt(raw)
        : null;
  } catch {
    return null;
  }
  if (parsed === null || parsed < 0n || parsed > 0xffffffffn) return null;
  return parsed;
}

function parseMarkerPatchSettingsText(text) {
  const values = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(Controls\.AcL\.[XY])\s*=\s*([^;#\s]+)\s*/i);
    if (!match) continue;
    values.set(match[1].toLowerCase(), match[2]);
  }

  const low = parseUint32(values.get("controls.acl.x"));
  const high = parseUint32(values.get("controls.acl.y"));
  if (low === null || high === null) {
    return {
      valid: false,
      reason: "achievement-bitflag-missing-or-invalid",
      low: null,
      high: null,
      flag: null,
    };
  }
  return {
    valid: true,
    reason: "",
    low,
    high,
    flag: low | (high << 32n),
  };
}

function readMarkerPatchStateFile(stateFile) {
  const filePath = String(stateFile || "");
  if (!filePath || !isFile(filePath)) {
    return { valid: false, reason: "state-file-missing", filePath };
  }
  try {
    const parsed = parseMarkerPatchSettingsText(
      decodeTextBuffer(fs.readFileSync(filePath)),
    );
    return { ...parsed, filePath };
  } catch (error) {
    return {
      valid: false,
      reason: "state-file-read-failed",
      error: error?.message || String(error),
      filePath,
    };
  }
}

function buildMarkerPatchSnapshot(flag, previousSnapshot = {}) {
  if (typeof flag !== "bigint" || flag < 0n) return null;
  const previous =
    previousSnapshot && typeof previousSnapshot === "object"
      ? previousSnapshot
      : {};
  const snapshot = {};
  for (let index = 0; index < MARKERPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const name = `MARKERPATCH_${index}`;
    const earned = (flag & (1n << BigInt(index))) !== 0n;
    const previousEntry = previous[name];
    snapshot[name] = {
      earned,
      earned_time:
        earned && previousEntry?.earned
          ? Number(previousEntry.earned_time || 0) || 0
          : 0,
    };
  }
  return snapshot;
}

function readMarkerPatchSnapshot(stateFile, previousSnapshot = {}) {
  const parsed = readMarkerPatchStateFile(stateFile);
  if (!parsed.valid) {
    return {
      ...parsed,
      snapshot:
        previousSnapshot && typeof previousSnapshot === "object"
          ? previousSnapshot
          : {},
    };
  }
  return {
    ...parsed,
    snapshot: buildMarkerPatchSnapshot(parsed.flag, previousSnapshot),
  };
}

function parseMarkerPatchLanguageFile(filePath) {
  const text = decodeTextBuffer(fs.readFileSync(filePath));
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separator = line.indexOf("|");
      if (separator <= 0) {
        throw new Error(
          `Invalid MarkerPatch achievement text at ${path.basename(filePath)}:${index + 1}`,
        );
      }
      return {
        displayName: line.slice(0, separator).trim(),
        description: line.slice(separator + 1).trim(),
      };
    });
  if (rows.length !== MARKERPATCH_ACHIEVEMENT_COUNT) {
    throw new Error(
      `Expected ${MARKERPATCH_ACHIEVEMENT_COUNT} MarkerPatch achievements in ${path.basename(filePath)}, found ${rows.length}`,
    );
  }
  return rows;
}

function validateMarkerPatchResources(detection) {
  if (!detection?.detected || !detection?.paths) {
    throw new Error("MarkerPatch was not detected in the selected game folder.");
  }
  const englishPath = path.join(detection.paths.textDir, "en.txt");
  if (!isFile(englishPath)) {
    throw new Error("MarkerPatch English achievement text is missing.");
  }
  for (let index = 0; index < MARKERPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const iconPath = path.join(detection.paths.imagesDir, `${index}.png`);
    if (!isFile(iconPath)) {
      throw new Error(`MarkerPatch achievement image ${index}.png is missing.`);
    }
  }
  return true;
}

function buildMarkerPatchSchema(rootPath, options = {}) {
  const detection = detectMarkerPatchRoot(rootPath);
  validateMarkerPatchResources(detection);

  const localizedRows = new Map();
  const requestedLanguages = new Set(
    (Array.isArray(options.schemaLanguages) ? options.schemaLanguages : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const restrictLanguages = requestedLanguages.size > 0;
  for (const [fileCode, language] of Object.entries(
    MARKERPATCH_LANGUAGE_FILES,
  )) {
    if (
      restrictLanguages &&
      language !== "english" &&
      !requestedLanguages.has(language)
    ) {
      continue;
    }
    const filePath = path.join(detection.paths.textDir, `${fileCode}.txt`);
    if (!isFile(filePath)) continue;
    localizedRows.set(language, parseMarkerPatchLanguageFile(filePath));
  }
  if (!localizedRows.has("english")) {
    throw new Error("MarkerPatch English achievement text is invalid.");
  }

  const schema = [];
  for (let index = 0; index < MARKERPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const displayName = {};
    const description = {};
    for (const [language, rows] of localizedRows.entries()) {
      displayName[language] = rows[index].displayName;
      description[language] = rows[index].description;
    }
    const entry = {
      hidden: index >= 1 && index <= 15 ? 1 : 0,
      displayName,
      description,
      icon: `img/${index}.png`,
      icon_gray: `img/${index}.png`,
      name: `MARKERPATCH_${index}`,
    };
    if (index === 0) entry.trophyType = "platinum";
    schema.push(entry);
  }
  return { detection, schema, languages: Array.from(localizedRows.keys()) };
}

function computeMarkerPatchResourceFingerprint(rootPath) {
  const detection = detectMarkerPatchRoot(rootPath);
  if (!detection.detected) return "";
  const hash = crypto.createHash("sha256");
  const candidates = [detection.paths.ini, detection.paths.executable];
  for (const fileCode of Object.keys(MARKERPATCH_LANGUAGE_FILES)) {
    candidates.push(path.join(detection.paths.textDir, `${fileCode}.txt`));
  }
  for (let index = 0; index < MARKERPATCH_ACHIEVEMENT_COUNT; index += 1) {
    candidates.push(path.join(detection.paths.imagesDir, `${index}.png`));
  }

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      hash.update(path.basename(candidate).toLowerCase());
      hash.update(String(stat.size));
      hash.update(String(Math.trunc(stat.mtimeMs)));
    } catch {
      hash.update(`${path.basename(candidate).toLowerCase()}:missing`);
    }
  }
  return hash.digest("hex");
}

function findMarkerPatchConfig(configsDir, rootPath) {
  const targetRoot = normalizePathForComparison(rootPath);
  if (!targetRoot || !isDirectory(configsDir)) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(configsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }
    const filePath = path.join(configsDir, entry.name);
    try {
      const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const provider = String(
        config?.achievement_source?.provider || config?.achievement_provider || "",
      )
        .trim()
        .toLowerCase();
      if (
        provider === MARKERPATCH_PROVIDER &&
        normalizePathForComparison(
          config?.game_path || config?.markerpatch_game_path,
        ) === targetRoot
      ) {
        return { filePath, config };
      }
    } catch {}
  }
  return null;
}

function chooseMarkerPatchConfigPath(configsDir) {
  const base = sanitizeConfigName(MARKERPATCH_CONFIG_NAME);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? base : `${base} ${suffix}`;
    const filePath = path.join(configsDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return { name, filePath };
  }
  throw new Error("Could not allocate a MarkerPatch config filename.");
}

function copyMarkerPatchImages(imagesDir, schemaDir) {
  const targetImagesDir = path.join(schemaDir, "img");
  fs.mkdirSync(targetImagesDir, { recursive: true });
  for (let index = 0; index < MARKERPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const source = path.join(imagesDir, `${index}.png`);
    const destination = path.join(targetImagesDir, `${index}.png`);
    const temporary = path.join(
      targetImagesDir,
      `.${index}.png.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.copyFileSync(source, temporary);
      fs.renameSync(temporary, destination);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {}
    }
  }
}

function ensureMarkerPatchConfig(options = {}) {
  const rootPath = path.resolve(String(options.rootPath || ""));
  const configsDir = path.resolve(String(options.configsDir || ""));
  const detection = detectMarkerPatchRoot(rootPath);
  validateMarkerPatchResources(detection);
  fs.mkdirSync(configsDir, { recursive: true });

  const existing = findMarkerPatchConfig(configsDir, rootPath);
  const destination = existing
    ? {
        name: path.basename(existing.filePath, ".json"),
        filePath: existing.filePath,
      }
    : chooseMarkerPatchConfigPath(configsDir);
  const previous = existing?.config || {};
  const schemaDir = path.join(
    configsDir,
    "schema",
    MARKERPATCH_PLATFORM,
    MARKERPATCH_APP_ID,
  );
  const stateFile = resolveMarkerPatchStateFile(options);
  const fingerprint = computeMarkerPatchResourceFingerprint(rootPath);
  const requestedSchemaLanguages = Array.from(
    new Set(
      (Array.isArray(options.schemaLanguages) ? options.schemaLanguages : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
  const schemaPath = path.join(schemaDir, "achievements.json");
  const needsSchemaRefresh =
    previous?.markerpatch_resource_fingerprint !== fingerprint ||
    JSON.stringify(previous?.markerpatch_schema_languages_selection || []) !==
      JSON.stringify(requestedSchemaLanguages) ||
    !isFile(schemaPath);
  let languages = Array.isArray(previous?.schema_languages)
    ? previous.schema_languages
    : [];

  if (needsSchemaRefresh) {
    const built = buildMarkerPatchSchema(rootPath, {
      schemaLanguages: requestedSchemaLanguages,
    });
    fs.mkdirSync(schemaDir, { recursive: true });
    copyMarkerPatchImages(built.detection.paths.imagesDir, schemaDir);
    writeJsonAtomicSync(schemaPath, built.schema);
    languages = built.languages;
  }

  const config = {
    ...previous,
    name: destination.name,
    displayName: MARKERPATCH_CONFIG_NAME,
    appid: MARKERPATCH_APP_ID,
    platform: MARKERPATCH_PLATFORM,
    metadata_platform: "steam",
    config_path: schemaDir,
    save_path: stateFile ? path.dirname(stateFile) : "",
    executable: detection.paths.executable,
    arguments: typeof previous?.arguments === "string" ? previous.arguments : "",
    process_name: "deadspace2.exe",
    game_path: detection.paths.root,
    markerpatch_game_path: detection.paths.root,
    markerpatch_state_file: stateFile,
    markerpatch_resource_fingerprint: fingerprint,
    markerpatch_schema_languages_selection: requestedSchemaLanguages,
    schema_languages: languages,
    native_platinum: true,
    achievement_source: {
      type: "local-mod",
      provider: MARKERPATCH_PROVIDER,
      version: 1,
      game_path: detection.paths.root,
      state_file: stateFile,
    },
  };
  const configChanged =
    !existing || JSON.stringify(previous) !== JSON.stringify(config);
  if (configChanged) {
    writeJsonAtomicSync(destination.filePath, config, { backup: true });
  }

  return {
    created: !existing,
    updated: !!existing && configChanged,
    unchanged: !!existing && !configChanged && !needsSchemaRefresh,
    schemaUpdated: needsSchemaRefresh,
    name: destination.name,
    configPath: destination.filePath,
    schemaDir,
    stateFile,
    config,
  };
}

function isMarkerPatchConfig(config) {
  const provider = String(
    config?.achievement_source?.provider || config?.achievement_provider || "",
  )
    .trim()
    .toLowerCase();
  return (
    String(config?.platform || "").trim().toLowerCase() ===
      MARKERPATCH_PLATFORM || provider === MARKERPATCH_PROVIDER
  );
}

function getMarkerPatchGamePath(config) {
  if (!isMarkerPatchConfig(config)) return "";
  return String(
    config?.game_path ||
      config?.markerpatch_game_path ||
      config?.achievement_source?.game_path ||
      "",
  ).trim();
}

function getMarkerPatchStateFile(config) {
  if (!isMarkerPatchConfig(config)) return "";
  const explicit = String(
    config?.markerpatch_state_file ||
      config?.achievement_source?.state_file ||
      "",
  ).trim();
  if (explicit) return explicit;
  const savePath = String(config?.save_path || "").trim();
  return savePath ? path.join(savePath, "settings.txt") : "";
}

module.exports = {
  MARKERPATCH_ACHIEVEMENT_COUNT,
  MARKERPATCH_APP_ID,
  MARKERPATCH_CONFIG_NAME,
  MARKERPATCH_GAME_NAME,
  MARKERPATCH_PLATFORM,
  MARKERPATCH_PROVIDER,
  buildMarkerPatchSchema,
  buildMarkerPatchSnapshot,
  computeMarkerPatchResourceFingerprint,
  detectMarkerPatchRoot,
  ensureMarkerPatchConfig,
  findMarkerPatchConfig,
  getMarkerPatchGamePath,
  getMarkerPatchStateFile,
  isMarkerPatchConfig,
  isPathInsideRoot,
  normalizePathForComparison,
  parseMarkerPatchSettingsText,
  readMarkerPatchSnapshot,
  readMarkerPatchStateFile,
  resolveMarkerPatchStateFile,
};
