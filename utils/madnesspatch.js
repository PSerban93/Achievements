"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { writeJsonAtomicSync } = require("./atomic-json-store");
const { sanitizeConfigName } = require("./config-name");

const MADNESSPATCH_APP_ID = "19680";
const MADNESSPATCH_PLATFORM = "madnesspatch";
const MADNESSPATCH_PROVIDER = "madnesspatch";
const MADNESSPATCH_GAME_NAME = "Alice: Madness Returns";
const MADNESSPATCH_CONFIG_NAME = "Alice: Madness Returns (MadnessPatch)";
const MADNESSPATCH_ACHIEVEMENT_COUNT = 45;
const MADNESSPATCH_SECRET_INDICES = new Set([
  1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 18, 19, 31, 33, 35,
]);
const MADNESSPATCH_LANGUAGE_FILES = Object.freeze({
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

function findChildCaseInsensitive(parentPath, childName, type = "any") {
  if (!parentPath || !childName || !isDirectory(parentPath)) return "";
  try {
    const match = fs
      .readdirSync(parentPath, { withFileTypes: true })
      .find((entry) => {
        if (entry.name.toLowerCase() !== String(childName).toLowerCase()) {
          return false;
        }
        if (type === "file") return entry.isFile();
        if (type === "directory") return entry.isDirectory();
        return entry.isFile() || entry.isDirectory();
      });
    return match ? path.join(parentPath, match.name) : "";
  } catch {
    return "";
  }
}

function readChildrenCaseInsensitive(parentPath) {
  if (!parentPath || !isDirectory(parentPath)) return new Map();
  try {
    return new Map(
      fs.readdirSync(parentPath, { withFileTypes: true }).map((entry) => [
        entry.name.toLowerCase(),
        entry,
      ]),
    );
  } catch {
    return new Map();
  }
}

function getIndexedChild(parentPath, entries, childName, type = "any") {
  const entry = entries.get(String(childName || "").toLowerCase());
  if (!entry) return "";
  if (type === "file" && !entry.isFile()) return "";
  if (type === "directory" && !entry.isDirectory()) return "";
  if (type === "any" && !entry.isFile() && !entry.isDirectory()) return "";
  return path.join(parentPath, entry.name);
}

function getMadnessPatchCandidateRoots(inputRoot) {
  const root = path.resolve(String(inputRoot || ""));
  const candidates = [
    root,
    path.join(root, "Binaries", "Win32"),
    path.join(root, "Alice2", "Binaries", "Win32"),
    path.join(root, "Game", "Alice2", "Binaries", "Win32"),
  ];
  return Array.from(
    new Map(
      candidates.map((candidate) => [
        normalizePathForComparison(candidate),
        candidate,
      ]),
    ).values(),
  );
}

function inspectMadnessPatchRoot(candidateRoot) {
  const rootEntries = readChildrenCaseInsensitive(candidateRoot);
  const executable = getIndexedChild(
    candidateRoot,
    rootEntries,
    "AliceMadnessReturns.exe",
    "file",
  );
  const ini = getIndexedChild(
    candidateRoot,
    rootEntries,
    "MadnessPatch.ini",
    "file",
  );
  const proxy = getIndexedChild(
    candidateRoot,
    rootEntries,
    "dinput8.dll",
    "file",
  );
  const achievementsDir = getIndexedChild(
    candidateRoot,
    rootEntries,
    "Achievements",
    "directory",
  );
  const achievementEntries = achievementsDir
    ? readChildrenCaseInsensitive(achievementsDir)
    : new Map();
  const imagesDir = achievementsDir
    ? getIndexedChild(
        achievementsDir,
        achievementEntries,
        "img",
        "directory",
      )
    : "";
  const textDir = achievementsDir
    ? getIndexedChild(
        achievementsDir,
        achievementEntries,
        "txt",
        "directory",
      )
    : "";
  const paths = {
    root: path.resolve(candidateRoot),
    executable,
    ini,
    proxy,
    achievementsDir,
    imagesDir,
    textDir,
  };
  const signals = {
    executable: isFile(executable),
    ini: isFile(ini),
    proxy: isFile(proxy),
    images: isDirectory(imagesDir),
    texts: isDirectory(textDir),
  };
  return {
    detected: Object.values(signals).every(Boolean),
    signalCount: Object.values(signals).filter(Boolean).length,
    paths,
    signals,
  };
}

function detectMadnessPatchRoot(inputRoot) {
  if (!inputRoot) return { detected: false, partial: false, root: "" };
  let candidates = [];
  try {
    candidates = getMadnessPatchCandidateRoots(inputRoot).map(
      inspectMadnessPatchRoot,
    );
  } catch {
    return { detected: false, partial: false, root: "" };
  }
  const detected = candidates.find((candidate) => candidate.detected);
  const best =
    detected ||
    candidates.sort((left, right) => right.signalCount - left.signalCount)[0];
  if (!best) return { detected: false, partial: false, root: "" };
  return {
    detected: best.detected,
    partial: best.signalCount > 0 && !best.detected,
    root: best.paths.root,
    paths: best.paths,
    signals: best.signals,
  };
}

function resolveMadnessPatchCheckpointRoot(options = {}) {
  const candidates = [];
  const addDocumentsCandidate = (documentsPath) => {
    if (!documentsPath) return;
    const candidate = path.join(
      String(documentsPath),
      "My Games",
      "Alice Madness Returns",
      "AliceGame",
      "CheckPoint",
    );
    const key = normalizePathForComparison(candidate);
    if (key && !candidates.some((item) => item.key === key)) {
      candidates.push({ key, path: candidate });
    }
  };

  addDocumentsCandidate(options.documentsPath);
  if (options.userProfile) {
    addDocumentsCandidate(path.join(String(options.userProfile), "Documents"));
  }
  if (process.env.USERPROFILE) {
    addDocumentsCandidate(path.join(process.env.USERPROFILE, "Documents"));
  }
  if (!candidates.length) return "";
  return (
    candidates.find((candidate) => isDirectory(candidate.path))?.path ||
    candidates[0].path
  );
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || "");
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function parseMadnessPatchAchievementsText(text) {
  let rawFlag = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*UnlockFlag\s*=\s*([^;#\s]+)\s*/i);
    if (match) rawFlag = match[1];
  }
  if (!/^\d+$/.test(rawFlag)) {
    return { valid: false, reason: "unlock-flag-missing-or-invalid", flag: null };
  }
  let flag = null;
  try {
    flag = BigInt(rawFlag);
  } catch {
    flag = null;
  }
  if (flag === null || flag < 0n || flag > 0xffffffffffffffffn) {
    return { valid: false, reason: "unlock-flag-missing-or-invalid", flag: null };
  }
  return { valid: true, reason: "", flag };
}

function readMadnessPatchStateFile(stateFile) {
  const filePath = String(stateFile || "");
  if (!filePath || !isFile(filePath)) {
    return { valid: false, reason: "state-file-missing", filePath };
  }
  try {
    const parsed = parseMadnessPatchAchievementsText(
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

function buildMadnessPatchSnapshot(flag, previousSnapshot = {}) {
  if (typeof flag !== "bigint" || flag < 0n) return null;
  const previous =
    previousSnapshot && typeof previousSnapshot === "object"
      ? previousSnapshot
      : {};
  const snapshot = {};
  for (let index = 0; index < MADNESSPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const name = `MADNESSPATCH_${index}`;
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

function readMadnessPatchSnapshot(stateFile, previousSnapshot = {}) {
  const parsed = readMadnessPatchStateFile(stateFile);
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
    snapshot: buildMadnessPatchSnapshot(parsed.flag, previousSnapshot),
  };
}

function listMadnessPatchStateFiles(checkpointRoot) {
  if (!isDirectory(checkpointRoot)) return [];
  const files = [];
  try {
    for (const profile of fs.readdirSync(checkpointRoot, {
      withFileTypes: true,
    })) {
      if (!profile.isDirectory()) continue;
      const profileDir = path.join(checkpointRoot, profile.name);
      const stateFile = findChildCaseInsensitive(
        profileDir,
        "Achievements.txt",
        "file",
      );
      if (!stateFile) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = Number(fs.statSync(stateFile).mtimeMs) || 0;
      } catch {}
      files.push({ profile: profile.name, filePath: stateFile, mtimeMs });
    }
  } catch {}
  return files.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.profile.localeCompare(right.profile),
  );
}

function getLatestMadnessPatchStateFile(configOrRoot) {
  const checkpointRoot =
    typeof configOrRoot === "string"
      ? configOrRoot
      : getMadnessPatchCheckpointRoot(configOrRoot);
  return listMadnessPatchStateFiles(checkpointRoot)[0]?.filePath || "";
}

function parseLanguageFile(filePath) {
  const rows = decodeTextBuffer(fs.readFileSync(filePath))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separator = line.indexOf("|");
      if (separator <= 0) {
        throw new Error(
          `Invalid MadnessPatch achievement text at ${path.basename(filePath)}:${index + 1}`,
        );
      }
      return {
        displayName: line.slice(0, separator).trim(),
        description: line.slice(separator + 1).trim(),
      };
    });
  if (rows.length !== MADNESSPATCH_ACHIEVEMENT_COUNT) {
    throw new Error(
      `Expected ${MADNESSPATCH_ACHIEVEMENT_COUNT} MadnessPatch achievements in ${path.basename(filePath)}, found ${rows.length}`,
    );
  }
  return rows;
}

function validateMadnessPatchResources(detection) {
  if (!detection?.detected || !detection?.paths) {
    throw new Error("MadnessPatch was not detected in the selected game folder.");
  }
  const englishPath = path.join(detection.paths.textDir, "en.txt");
  if (!isFile(englishPath)) {
    throw new Error("MadnessPatch English achievement text is missing.");
  }
  for (let index = 0; index < MADNESSPATCH_ACHIEVEMENT_COUNT; index += 1) {
    if (!isFile(path.join(detection.paths.imagesDir, `${index}.png`))) {
      throw new Error(`MadnessPatch achievement image ${index}.png is missing.`);
    }
  }
}

function buildMadnessPatchSchema(rootPath, options = {}) {
  const detection = detectMadnessPatchRoot(rootPath);
  validateMadnessPatchResources(detection);
  const requestedLanguages = new Set(
    (Array.isArray(options.schemaLanguages) ? options.schemaLanguages : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const restrictLanguages = requestedLanguages.size > 0;
  const localizedRows = new Map();
  for (const [fileCode, language] of Object.entries(
    MADNESSPATCH_LANGUAGE_FILES,
  )) {
    if (
      restrictLanguages &&
      language !== "english" &&
      !requestedLanguages.has(language)
    ) {
      continue;
    }
    const filePath = path.join(detection.paths.textDir, `${fileCode}.txt`);
    if (isFile(filePath)) localizedRows.set(language, parseLanguageFile(filePath));
  }
  if (!localizedRows.has("english")) {
    throw new Error("MadnessPatch English achievement text is invalid.");
  }

  const schema = [];
  for (let index = 0; index < MADNESSPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const displayName = {};
    const description = {};
    for (const [language, rows] of localizedRows.entries()) {
      displayName[language] = rows[index].displayName;
      description[language] = rows[index].description;
    }
    const entry = {
      hidden: MADNESSPATCH_SECRET_INDICES.has(index) ? 1 : 0,
      displayName,
      description,
      icon: `img/${index}.png`,
      icon_gray: `img/${index}.png`,
      name: `MADNESSPATCH_${index}`,
    };
    if (index === 0) entry.trophyType = "platinum";
    schema.push(entry);
  }
  return { detection, schema, languages: Array.from(localizedRows.keys()) };
}

function computeMadnessPatchResourceFingerprint(rootPath) {
  const detection = detectMadnessPatchRoot(rootPath);
  if (!detection.detected) return "";
  const hash = crypto.createHash("sha256");
  const candidates = [
    detection.paths.ini,
    detection.paths.proxy,
    detection.paths.executable,
  ];
  for (const code of Object.keys(MADNESSPATCH_LANGUAGE_FILES)) {
    candidates.push(path.join(detection.paths.textDir, `${code}.txt`));
  }
  for (let index = 0; index < MADNESSPATCH_ACHIEVEMENT_COUNT; index += 1) {
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

function findMadnessPatchConfig(configsDir, rootPath) {
  const targetRoot = normalizePathForComparison(rootPath);
  if (!targetRoot || !isDirectory(configsDir)) return null;
  try {
    for (const entry of fs.readdirSync(configsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      const filePath = path.join(configsDir, entry.name);
      try {
        const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (
          isMadnessPatchConfig(config) &&
          normalizePathForComparison(getMadnessPatchGamePath(config)) ===
            targetRoot
        ) {
          return { filePath, config };
        }
      } catch {}
    }
  } catch {}
  return null;
}

function chooseConfigPath(configsDir) {
  const base = sanitizeConfigName(MADNESSPATCH_CONFIG_NAME);
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const name = suffix === 1 ? base : `${base} ${suffix}`;
    const filePath = path.join(configsDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return { name, filePath };
  }
  throw new Error("Could not allocate a MadnessPatch config filename.");
}

function copyImages(imagesDir, schemaDir) {
  const targetImagesDir = path.join(schemaDir, "img");
  fs.mkdirSync(targetImagesDir, { recursive: true });
  for (let index = 0; index < MADNESSPATCH_ACHIEVEMENT_COUNT; index += 1) {
    const source = path.join(imagesDir, `${index}.png`);
    const destination = path.join(targetImagesDir, `${index}.png`);
    const temporary = path.join(
      targetImagesDir,
      `.${index}.png.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      fs.copyFileSync(source, temporary);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      fs.renameSync(temporary, destination);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch {}
    }
  }
}

function ensureMadnessPatchConfig(options = {}) {
  const detection = detectMadnessPatchRoot(options.rootPath);
  validateMadnessPatchResources(detection);
  const configsDir = path.resolve(String(options.configsDir || ""));
  fs.mkdirSync(configsDir, { recursive: true });
  const existing = findMadnessPatchConfig(configsDir, detection.root);
  const destination = existing
    ? {
        name: path.basename(existing.filePath, ".json"),
        filePath: existing.filePath,
      }
    : chooseConfigPath(configsDir);
  const previous = existing?.config || {};
  const checkpointRoot = resolveMadnessPatchCheckpointRoot(options);
  const schemaDir = path.join(
    configsDir,
    "schema",
    MADNESSPATCH_PLATFORM,
    MADNESSPATCH_APP_ID,
  );
  const fingerprint = computeMadnessPatchResourceFingerprint(detection.root);
  const requestedSchemaLanguages = Array.from(
    new Set(
      (Array.isArray(options.schemaLanguages) ? options.schemaLanguages : [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
  const schemaPath = path.join(schemaDir, "achievements.json");
  const needsSchemaRefresh =
    previous?.madnesspatch_resource_fingerprint !== fingerprint ||
    JSON.stringify(previous?.madnesspatch_schema_languages_selection || []) !==
      JSON.stringify(requestedSchemaLanguages) ||
    !isFile(schemaPath);
  let languages = Array.isArray(previous?.schema_languages)
    ? previous.schema_languages
    : [];
  if (needsSchemaRefresh) {
    const built = buildMadnessPatchSchema(detection.root, {
      schemaLanguages: requestedSchemaLanguages,
    });
    fs.mkdirSync(schemaDir, { recursive: true });
    copyImages(built.detection.paths.imagesDir, schemaDir);
    writeJsonAtomicSync(schemaPath, built.schema);
    languages = built.languages;
  }

  const config = {
    ...previous,
    name: destination.name,
    displayName: MADNESSPATCH_CONFIG_NAME,
    appid: MADNESSPATCH_APP_ID,
    platform: MADNESSPATCH_PLATFORM,
    metadata_platform: "steam",
    config_path: schemaDir,
    save_path: checkpointRoot,
    executable: detection.paths.executable,
    arguments: typeof previous?.arguments === "string" ? previous.arguments : "",
    process_name: path.basename(detection.paths.executable),
    game_path: detection.root,
    madnesspatch_game_path: detection.root,
    madnesspatch_checkpoint_root: checkpointRoot,
    madnesspatch_resource_fingerprint: fingerprint,
    madnesspatch_schema_languages_selection: requestedSchemaLanguages,
    schema_languages: languages,
    native_platinum: true,
    achievement_source: {
      type: "local-mod",
      provider: MADNESSPATCH_PROVIDER,
      version: 1,
      game_path: detection.root,
      state_root: checkpointRoot,
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
    checkpointRoot,
    config,
  };
}

function isMadnessPatchConfig(config) {
  const platform = String(config?.platform || "").trim().toLowerCase();
  const provider = String(
    config?.achievement_source?.provider || config?.achievement_provider || "",
  )
    .trim()
    .toLowerCase();
  return platform === MADNESSPATCH_PLATFORM || provider === MADNESSPATCH_PROVIDER;
}

function getMadnessPatchGamePath(config) {
  if (!isMadnessPatchConfig(config)) return "";
  return String(
    config?.game_path ||
      config?.madnesspatch_game_path ||
      config?.achievement_source?.game_path ||
      "",
  ).trim();
}

function getMadnessPatchCheckpointRoot(config) {
  if (!isMadnessPatchConfig(config)) return "";
  return String(
    config?.madnesspatch_checkpoint_root ||
      config?.achievement_source?.state_root ||
      config?.save_path ||
      "",
  ).trim();
}

module.exports = {
  MADNESSPATCH_ACHIEVEMENT_COUNT,
  MADNESSPATCH_APP_ID,
  MADNESSPATCH_CONFIG_NAME,
  MADNESSPATCH_GAME_NAME,
  MADNESSPATCH_PLATFORM,
  MADNESSPATCH_PROVIDER,
  buildMadnessPatchSchema,
  buildMadnessPatchSnapshot,
  computeMadnessPatchResourceFingerprint,
  detectMadnessPatchRoot,
  ensureMadnessPatchConfig,
  findMadnessPatchConfig,
  getMadnessPatchCandidateRoots,
  getLatestMadnessPatchStateFile,
  getMadnessPatchCheckpointRoot,
  getMadnessPatchGamePath,
  isMadnessPatchConfig,
  listMadnessPatchStateFiles,
  normalizePathForComparison,
  parseMadnessPatchAchievementsText,
  readMadnessPatchSnapshot,
  readMadnessPatchStateFile,
  resolveMadnessPatchCheckpointRoot,
};
