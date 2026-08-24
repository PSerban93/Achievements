const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { createLogger } = require("./logger");
const { updateTopOwnersIds } = require("./update-top-owners");
const {
  readSchemaParseLaunchMetadata,
} = require("./schema-parse-launch-metadata");

const execFileAsync = promisify(execFile);
const logger = createLogger("schema-parse");
const TOP_OWNERS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SCHEMA_PARSE_DIRNAME = "schema_parse";
const SCHEMA_PARSE_ARCHIVE_NAME = "schema_parse.zip";
const SCHEMA_PARSE_STATE_FILENAME = ".seed-state.json";
const SCHEMA_PARSE_DEFAULT_USERNAME = "goldie_0003";
const SCHEMA_PARSE_DEFAULT_PASSWORD = "BabaYaga0003";
const SCHEMA_PARSE_BATCH_CHUNK_SIZE = 20;
const SCHEMA_PARSE_AUTH_RETRY_DELAY_MS = 30000;
const SCHEMA_PARSE_CHUNK_DELAY_MS = 7000;
const SCHEMA_PARSE_OUTPUT_DIR_NAMES = ["output", "_OUTPUT"];
const SCHEMA_PARSE_MUTABLE_NAMES = [
  "my_login.txt",
  "refresh_tokens.json",
  "top_owners_ids.txt",
  "output",
  "_OUTPUT",
];

function normalizeUserDataDir(userDataDir = "") {
  return path.resolve(String(userDataDir || process.cwd()).trim());
}

function applySchemaParseEnvironment(baseEnv = process.env) {
  const nextEnv = { ...(baseEnv || {}) };
  const username = String(nextEnv.GSE_CFG_USERNAME || "").trim();
  const password = String(nextEnv.GSE_CFG_PASSWORD || "").trim();
  if (!username) {
    nextEnv.GSE_CFG_USERNAME = SCHEMA_PARSE_DEFAULT_USERNAME;
  }
  if (!password) {
    nextEnv.GSE_CFG_PASSWORD = SCHEMA_PARSE_DEFAULT_PASSWORD;
  }
  return nextEnv;
}

function ensureSchemaParseProcessEnv() {
  const nextEnv = applySchemaParseEnvironment(process.env);
  process.env.GSE_CFG_USERNAME = nextEnv.GSE_CFG_USERNAME;
  process.env.GSE_CFG_PASSWORD = nextEnv.GSE_CFG_PASSWORD;
  logger.info("schema-parse:env-ready", {
    hasUsername: !!String(process.env.GSE_CFG_USERNAME || "").trim(),
    hasPassword: !!String(process.env.GSE_CFG_PASSWORD || "").trim(),
  });
}

function resolveSchemaParseRuntimeDir(userDataDir = "") {
  return path.join(normalizeUserDataDir(userDataDir), "tools", SCHEMA_PARSE_DIRNAME);
}

function resolveSchemaParseStatePath(runtimeDir = "") {
  return path.join(path.resolve(String(runtimeDir || "").trim()), SCHEMA_PARSE_STATE_FILENAME);
}

function isValidSchemaParseSeedArchive(candidate = "") {
  const filePath = path.resolve(String(candidate || "").trim());
  return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function resolveSchemaParseSeedArchive(options = {}) {
  const explicit = String(options.seedDir || "").trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "tools", SCHEMA_PARSE_ARCHIVE_NAME),
    );
  }
  candidates.push(path.join(__dirname, "..", "tools", SCHEMA_PARSE_ARCHIVE_NAME));
  candidates.push(path.join(process.cwd(), "tools", SCHEMA_PARSE_ARCHIVE_NAME));
  candidates.push(path.join(__dirname, "..", SCHEMA_PARSE_ARCHIVE_NAME));
  candidates.push(path.join(process.cwd(), SCHEMA_PARSE_ARCHIVE_NAME));
  for (const candidate of candidates) {
    if (isValidSchemaParseSeedArchive(candidate)) {
      return path.resolve(candidate);
    }
  }
  return "";
}

function computeFileHash(filePath = "") {
  const fullPath = path.resolve(String(filePath || "").trim());
  const hash = crypto.createHash("sha256");
  const buffer = fs.readFileSync(fullPath);
  hash.update(buffer);
  return hash.digest("hex");
}

function readJsonFile(filePath = "") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath = "", value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function copyRecursive(sourceDir, destDir, options = {}) {
  const excludeDirs = new Set(options.excludeDirs || []);
  const copyIfMissingOnly = new Set(options.copyIfMissingOnly || []);
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(sourcePath, destPath, options);
      continue;
    }
    if (copyIfMissingOnly.has(entry.name) && fs.existsSync(destPath)) continue;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  }
}

function copyPathRecursive(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) return;
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    copyRecursive(sourcePath, destPath);
    return;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
}

function preserveRuntimeMutableEntries(runtimeDir, preserveRoot) {
  fs.rmSync(preserveRoot, { recursive: true, force: true });
  fs.mkdirSync(preserveRoot, { recursive: true });
  for (const name of SCHEMA_PARSE_MUTABLE_NAMES) {
    const sourcePath = path.join(runtimeDir, name);
    if (!fs.existsSync(sourcePath)) continue;
    copyPathRecursive(sourcePath, path.join(preserveRoot, name));
  }
}

function restoreRuntimeMutableEntries(preserveRoot, runtimeDir) {
  if (!fs.existsSync(preserveRoot)) return;
  for (const name of SCHEMA_PARSE_MUTABLE_NAMES) {
    const sourcePath = path.join(preserveRoot, name);
    if (!fs.existsSync(sourcePath)) continue;
    copyPathRecursive(sourcePath, path.join(runtimeDir, name));
  }
}

async function extractSchemaParseArchive(archivePath, runtimeDir) {
  const archiveLiteral = String(path.resolve(archivePath)).replace(/'/g, "''");
  const runtimeLiteral = String(path.resolve(runtimeDir)).replace(/'/g, "''");
  const command =
    `$archive = '${archiveLiteral}'; ` +
    `$dest = '${runtimeLiteral}'; ` +
    "New-Item -ItemType Directory -Path $dest -Force | Out-Null; " +
    "Expand-Archive -LiteralPath $archive -DestinationPath $dest -Force";
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

function statMtimeMs(filePath = "") {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function normalizeAchievementTextObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  const text = String(value || "").trim();
  return text ? { english: text } : {};
}

function delay(ms = 0) {
  const timeout = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

function buildSchemaParseErrorText(err = null) {
  return [
    String(err?.message || ""),
    String(err?.stdout || ""),
    String(err?.stderr || ""),
  ]
    .filter(Boolean)
    .join("\n");
}

function isSchemaParseAuthError(err = null) {
  const text = buildSchemaParseErrorText(err);
  if (!text) return false;
  return (
    text.includes("429 Client Error") ||
    text.includes("Too Many Requests") ||
    text.includes("KeyError('client_id')") ||
    text.includes("WebAuthException: (KeyError('client_id')") ||
    text.includes("IAuthenticationService/BeginAuthSessionViaCredentials")
  );
}

function chunkArray(items = [], size = 1) {
  const normalizedSize = Math.max(1, Number(size) || 1);
  const result = [];
  for (let index = 0; index < items.length; index += normalizedSize) {
    result.push(items.slice(index, index + normalizedSize));
  }
  return result;
}

function normalizeGeneratedAchievementsSchema(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    ...entry,
    displayName: normalizeAchievementTextObject(entry?.displayName),
    description: normalizeAchievementTextObject(entry?.description),
  }));
}

function getSchemaParseOutputRoots(runtimeDir = "") {
  const normalizedRuntimeDir = path.resolve(String(runtimeDir || "").trim());
  return SCHEMA_PARSE_OUTPUT_DIR_NAMES.map((name) =>
    path.join(normalizedRuntimeDir, name),
  );
}

function getSchemaParseAppOutputCandidates(runtimeDir = "", appid = "") {
  const normalizedAppId = String(appid || "").trim();
  return getSchemaParseOutputRoots(runtimeDir).map((outputRoot) =>
    path.join(outputRoot, normalizedAppId),
  );
}

function hasSchemaParseOutputArtifacts(appOutputDir = "") {
  const targetDir = path.resolve(String(appOutputDir || "").trim());
  if (!targetDir || !fs.existsSync(targetDir)) return false;
  return [
    path.join(targetDir, "steam_settings", "achievements.json"),
    path.join(targetDir, "info", "launch_config.json"),
    path.join(targetDir, "info", "product_info.json"),
    path.join(targetDir, "steam_misc", "app_info", "config_launch.json"),
    path.join(targetDir, "steam_misc", "app_info", "app_product_info.json"),
  ].some((candidate) => fs.existsSync(candidate));
}

function resolveSchemaParseAppOutputDir(runtimeDir = "", appid = "") {
  const candidates = getSchemaParseAppOutputCandidates(runtimeDir, appid);
  return (
    candidates.find((candidate) => hasSchemaParseOutputArtifacts(candidate)) ||
    candidates.find((candidate) => fs.existsSync(candidate)) ||
    candidates[0]
  );
}

function resolveFirstExistingPath(rootDir = "", relativeCandidates = []) {
  for (const relativePath of relativeCandidates) {
    const candidate = path.join(rootDir, ...relativePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function readSchemaParseGeneratedDisplayName(appOutputDir = "", appid = "") {
  const normalizedAppId = String(appid || "").trim();
  const productInfoPath = resolveFirstExistingPath(appOutputDir, [
    ["info", "product_info.json"],
    ["steam_misc", "app_info", "app_product_info.json"],
  ]);
  const detailsPath = resolveFirstExistingPath(appOutputDir, [
    ["info", "app_details.json"],
    ["steam_misc", "app_info", "app_details.json"],
  ]);
  try {
    if (fs.existsSync(productInfoPath)) {
      const raw = JSON.parse(fs.readFileSync(productInfoPath, "utf8"));
      const productName = String(raw?.common?.name || "").trim();
      if (productName) return productName;
    }
  } catch {}
  try {
    if (fs.existsSync(detailsPath)) {
      const raw = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
      const detailsRoot =
        raw && typeof raw === "object"
          ? raw[normalizedAppId]?.data || raw?.data || null
          : null;
      const detailsName = String(detailsRoot?.name || "").trim();
      if (detailsName) return detailsName;
    }
  } catch {}
  return "";
}

async function ensureSchemaParseRuntimeReady(options = {}) {
  const userDataDir = normalizeUserDataDir(options.userDataDir);
  const runtimeDir = resolveSchemaParseRuntimeDir(userDataDir);
  const seedArchive = resolveSchemaParseSeedArchive(options);
  if (!seedArchive) {
    throw new Error("schema_parse seed archive not found");
  }

  ensureSchemaParseProcessEnv();

  const runtimeExe = path.join(runtimeDir, "generate_emu_config.exe");
  const runtimeStatePath = resolveSchemaParseStatePath(runtimeDir);
  const bundledHash = computeFileHash(seedArchive);
  const previousState = readJsonFile(runtimeStatePath) || {};
  const requiresExtract =
    !fs.existsSync(runtimeExe) ||
    String(previousState.archiveHash || "").trim() !== bundledHash;
  const bootstrapped = !fs.existsSync(runtimeExe);
  const updated = requiresExtract && !bootstrapped;

  if (requiresExtract) {
    const preserveRoot = path.join(path.dirname(runtimeDir), `${SCHEMA_PARSE_DIRNAME}.preserve`);
    logger.info("schema-parse:bootstrap:start", {
      runtimeDir,
      seedArchive,
      reason: String(options.reason || "runtime"),
      updated,
    });
    if (fs.existsSync(runtimeDir)) {
      preserveRuntimeMutableEntries(runtimeDir, preserveRoot);
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    } else {
      fs.rmSync(preserveRoot, { recursive: true, force: true });
    }
    await extractSchemaParseArchive(seedArchive, runtimeDir);
    restoreRuntimeMutableEntries(preserveRoot, runtimeDir);
    fs.rmSync(preserveRoot, { recursive: true, force: true });
    writeJsonFile(runtimeStatePath, {
      archivePath: seedArchive,
      archiveHash: bundledHash,
      extractedAt: new Date().toISOString(),
    });
    logger.info("schema-parse:bootstrap:success", {
      runtimeDir,
      seedArchive,
      updated,
    });
  } else if (
    String(previousState.archivePath || "").trim() !== seedArchive ||
    String(previousState.archiveHash || "").trim() !== bundledHash
  ) {
    writeJsonFile(runtimeStatePath, {
      archivePath: seedArchive,
      archiveHash: bundledHash,
      extractedAt:
        previousState?.extractedAt || new Date().toISOString(),
    });
  }

  const topOwnersPath = path.join(runtimeDir, "top_owners_ids.txt");
  let topOwnersRefreshed = false;
  if (options.refreshTopOwners === true) {
    await updateTopOwnersIds({
      outputPath: topOwnersPath,
      limit: options.topOwnersLimit || 250,
      timeoutMs: options.topOwnersTimeoutMs || 30000,
      headless: true,
    });
    topOwnersRefreshed = true;
  } else if (!fs.existsSync(topOwnersPath)) {
    await updateTopOwnersIds({
      outputPath: topOwnersPath,
      limit: options.topOwnersLimit || 250,
      timeoutMs: options.topOwnersTimeoutMs || 30000,
      headless: true,
    });
    topOwnersRefreshed = true;
  } else {
    const ageMs = Date.now() - statMtimeMs(topOwnersPath);
    if (ageMs > TOP_OWNERS_TTL_MS) {
      logger.info("schema-parse:top-owners:stale", {
        outputPath: topOwnersPath,
        ageMs,
      });
    }
  }

  return {
    runtimeDir,
    seedArchive,
    bootstrapped,
    updated,
    topOwnersPath,
    topOwnersRefreshed,
  };
}

async function runGenerateEmuConfig(runtimeDir, appid) {
  const exePath = path.join(runtimeDir, "generate_emu_config.exe");
  cleanupGeneratedAppArtifacts(runtimeDir, appid, { log: false });
  logger.info("schema-parse:run:start", { appid, runtimeDir });
  let result;
  try {
    result = await execFileAsync(exePath, [String(appid)], {
      cwd: runtimeDir,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: applySchemaParseEnvironment(process.env),
    });
  } catch (err) {
    const stdout = String(err?.stdout || "");
    const stderr = String(err?.stderr || "");
    logger.warn("schema-parse:run:command-failed", {
      appid,
      code:
        Number.isFinite(Number(err?.code)) || typeof err?.code === "string"
          ? err.code
          : null,
      hasStdout: !!stdout.trim(),
      hasStderr: !!stderr.trim(),
      stdoutPreview: stdout.trim().slice(0, 4000) || null,
      stderrPreview: stderr.trim().slice(0, 4000) || null,
    });
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  logger.info("schema-parse:run:finish", {
    appid,
    hasStdout: !!String(result.stdout || "").trim(),
    hasStderr: !!String(result.stderr || "").trim(),
  });
  return {
    appOutputDir: resolveSchemaParseAppOutputDir(runtimeDir, appid),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

async function executeSchemaParseSingle(runtimeDir, appid, outDir) {
  let runResult = null;
  let runError = null;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      runResult = await runGenerateEmuConfig(runtimeDir, appid);
      runError = null;
      break;
    } catch (err) {
      runError = err;
      runResult = {
        appOutputDir: resolveSchemaParseAppOutputDir(runtimeDir, appid),
        stdout: String(err?.stdout || ""),
        stderr: String(err?.stderr || ""),
      };
      if (attempt >= maxAttempts || !isSchemaParseAuthError(err)) {
        break;
      }
      logger.warn("schema-parse:run:auth-retry", {
        appid,
        attempt,
        delayMs: SCHEMA_PARSE_AUTH_RETRY_DELAY_MS,
      });
      await delay(SCHEMA_PARSE_AUTH_RETRY_DELAY_MS);
    }
  }
  try {
    const result = readSchemaParseGeneratedResult(appid, runResult.appOutputDir, outDir);
    if (result?.ok) {
      if (runError) {
        logger.warn("schema-parse:run:partial-success", {
          appid,
          code:
            Number.isFinite(Number(runError?.code)) || typeof runError?.code === "string"
              ? runError.code
              : null,
          hasLaunchMetadata: !!result.launchMetadata,
          count: Number.isFinite(Number(result.count)) ? Number(result.count) : 0,
        });
      }
      return result;
    }
    if (runError) {
      throw runError;
    }
    return result;
  } finally {
    cleanupGeneratedAppArtifacts(runtimeDir, appid);
  }
}

async function runGenerateEmuConfigBatch(runtimeDir, appids = [], options = {}) {
  const exePath = path.join(runtimeDir, "generate_emu_config.exe");
  const normalizedAppIds = Array.from(
    new Set(
      (Array.isArray(appids) ? appids : [])
        .map((appid) => String(appid || "").trim())
        .filter((appid) => /^\d+$/.test(appid)),
    ),
  );
  for (const appid of normalizedAppIds) {
    cleanupGeneratedAppArtifacts(runtimeDir, appid, { log: false });
  }
  logger.info("schema-parse:batch:start", {
    count: normalizedAppIds.length,
    runtimeDir,
  });
  const result = await new Promise((resolve, reject) => {
    const cp = execFile(exePath, normalizedAppIds, {
      cwd: runtimeDir,
      windowsHide: true,
      env: applySchemaParseEnvironment(process.env),
    });
    let stdout = "";
    let stdoutLineBuffer = "";
    let stderr = "";
    const total = normalizedAppIds.length;
    const indexByAppId = new Map(
      normalizedAppIds.map((appid, index) => [appid, index]),
    );
    let lastProgressCount = 0;
    let sawStartedStdout = false;
    const emitBatchProgress = (appid, current, detail, percent) => {
      try {
        if (typeof options.onProgress !== "function") return;
        const itemName = readSchemaParseGeneratedDisplayName(
          resolveSchemaParseAppOutputDir(runtimeDir, appid),
          appid,
        ) || "";
        options.onProgress({
          appid,
          itemName,
          current,
          total,
          phase: "schemaParse",
          detail,
          percent,
        });
      } catch {}
    };
    emitBatchProgress(
      normalizedAppIds[0] || "",
      0,
      "Generating local Steam schema",
      4,
    );
    const pollTimer = setInterval(() => {
      if (sawStartedStdout) return;
      let completed = 0;
      for (const appid of normalizedAppIds) {
        const outputDir = resolveSchemaParseAppOutputDir(runtimeDir, appid);
        const hasOutput = hasSchemaParseOutputArtifacts(outputDir);
        if (!hasOutput) continue;
        completed += 1;
      }
      if (completed <= lastProgressCount) return;
      lastProgressCount = completed;
      const currentIndex =
        normalizedAppIds.length > 0
          ? Math.min(
              Math.max(completed - 1, 0),
              Math.max(normalizedAppIds.length - 1, 0),
            )
          : 0;
      const currentAppId = normalizedAppIds[currentIndex] || "";
      const percent =
        total > 0
          ? Math.max(6, Math.min(78, Math.round((completed / total) * 78)))
          : 6;
      emitBatchProgress(
        currentAppId,
        completed,
        "Generating local Steam schema",
        percent,
      );
    }, 1000);
    const flushStdoutLines = (chunk) => {
      stdout += chunk;
      stdoutLineBuffer += chunk;
      const parts = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = parts.pop() || "";
      for (const rawLine of parts) {
        const line = String(rawLine || "").trim();
        const startedMatch =
          line.match(
            /^\*{3}\s+STARTED config for app id\s+(\d+)\s+\*{3}$/i,
          ) ||
          line.match(
            /^\*+\s*generating info for app id\s+(\d+)\s*\*+$/i,
          );
        if (!startedMatch) continue;
        sawStartedStdout = true;
        const appid = String(startedMatch[1] || "").trim();
        const index = indexByAppId.get(appid);
        if (index === undefined) continue;
        emitBatchProgress(
          appid,
          index + 1,
          "Generating local Steam schema",
          total > 0
            ? Math.max(8, Math.min(78, Math.round(((index + 1) / total) * 78)))
            : 8,
        );
      }
    };
    cp.stdout.on("data", (buf) => flushStdoutLines(buf.toString()));
    cp.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });
    cp.on("error", (err) => {
      clearInterval(pollTimer);
      reject(err);
    });
    cp.on("close", (code) => {
      clearInterval(pollTimer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        logger.warn("schema-parse:batch:command-failed", {
          code,
          count: normalizedAppIds.length,
          hasStdout: !!stdout.trim(),
          hasStderr: !!stderr.trim(),
          stdoutPreview: stdout.trim().slice(0, 4000) || null,
          stderrPreview: stderr.trim().slice(0, 4000) || null,
        });
        const err = new Error(`schema_parse batch exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
  logger.info("schema-parse:batch:finish", {
    count: normalizedAppIds.length,
    hasStdout: !!String(result.stdout || "").trim(),
    hasStderr: !!String(result.stderr || "").trim(),
  });
  return {
    outputRoot: getSchemaParseOutputRoots(runtimeDir)[0],
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    appids: normalizedAppIds,
  };
}

function copyImageDirectory(sourceDir, destDir) {
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch {}
  if (!fs.existsSync(sourceDir)) return false;
  copyRecursive(sourceDir, destDir);
  return true;
}

function copySchemaParseProductInfo(appOutputDir, outDir) {
  const sourcePath = resolveFirstExistingPath(appOutputDir, [
    ["info", "product_info.json"],
    ["steam_misc", "app_info", "app_product_info.json"],
  ]);
  if (!sourcePath) return false;
  const destPath = path.join(
    outDir,
    "steam_misc",
    "app_info",
    "app_product_info.json",
  );
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
    return true;
  } catch {
    return false;
  }
}

function cleanupGeneratedAppArtifacts(runtimeDir = "", appid = "", options = {}) {
  const normalizedAppId = String(appid || "").trim();
  if (!/^\d+$/.test(normalizedAppId)) return;
  const normalizedRuntimeDir = path.resolve(String(runtimeDir || "").trim());
  const roots = [
    ...getSchemaParseOutputRoots(normalizedRuntimeDir),
    path.join(normalizedRuntimeDir, "backup"),
  ];
  const removedPaths = [];
  const failures = [];
  for (const rootDir of roots) {
    const normalizedRootDir = path.resolve(rootDir);
    const targetDir = path.resolve(normalizedRootDir, normalizedAppId);
    if (path.dirname(targetDir) !== normalizedRootDir || !fs.existsSync(targetDir)) {
      continue;
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      removedPaths.push(targetDir);
    } catch (err) {
      failures.push({ targetDir, error: err?.message || String(err) });
    }
  }
  if (options.log === false) return;
  if (removedPaths.length > 0) {
    logger.info("schema-parse:cleanup:success", {
      appid: normalizedAppId,
      removedPaths,
    });
  }
  for (const failure of failures) {
    logger.warn("schema-parse:cleanup:failed", {
      appid: normalizedAppId,
      appOutputDir: failure.targetDir,
      error: failure.error,
    });
  }
}

function hasSchemaParseGeneratedAchievements(runtimeDir = "", appid = "") {
  const normalizedAppId = String(appid || "").trim();
  if (!normalizedAppId) return false;
  return getSchemaParseAppOutputCandidates(runtimeDir, normalizedAppId).some(
    (appOutputDir) =>
      fs.existsSync(
        path.join(appOutputDir, "steam_settings", "achievements.json"),
      ),
  );
}

function findFirstMissingSchemaParseOutputIndex(runtimeDir = "", appids = []) {
  const normalizedAppIds = Array.isArray(appids) ? appids : [];
  for (let index = 0; index < normalizedAppIds.length; index += 1) {
    if (!hasSchemaParseGeneratedAchievements(runtimeDir, normalizedAppIds[index])) {
      return index;
    }
  }
  return normalizedAppIds.length;
}

function readSchemaParseGeneratedResult(appid, appOutputDir, outDir) {
  const schemaJsonPath = path.join(appOutputDir, "steam_settings", "achievements.json");
  const launchConfigPath = resolveFirstExistingPath(appOutputDir, [
    ["info", "launch_config.json"],
    ["steam_misc", "app_info", "config_launch.json"],
  ]);
  const launchMetadata = launchConfigPath
    ? readSchemaParseLaunchMetadata(launchConfigPath, appid)
    : null;
  const displayName = readSchemaParseGeneratedDisplayName(appOutputDir, appid);
  if (!fs.existsSync(schemaJsonPath)) {
    logger.info("schema-parse:run:no-achievements", { appid });
    return {
      ok: false,
      reason: "no-achievements-json",
      launchMetadata,
      displayName,
    };
  }

  const rawSchema = JSON.parse(fs.readFileSync(schemaJsonPath, "utf8"));
  const achievements = normalizeGeneratedAchievementsSchema(rawSchema);
  fs.mkdirSync(outDir, { recursive: true });
  const outJsonPath = path.join(outDir, "achievements.json");
  fs.writeFileSync(outJsonPath, JSON.stringify(achievements, null, 2), "utf8");

  const sourceImgDir = path.join(appOutputDir, "steam_settings", "img");
  const destImgDir = path.join(outDir, "img");
  copyImageDirectory(sourceImgDir, destImgDir);
  const hasProductInfo = copySchemaParseProductInfo(appOutputDir, outDir);

  logger.info("schema-parse:run:success", {
    appid,
    count: achievements.length,
    outDir,
    hasLaunchMetadata: !!launchMetadata,
    hasProductInfo,
  });
  return {
    ok: true,
    achievements,
    count: achievements.length,
    outDir,
    launchMetadata,
    displayName,
    hasProductInfo,
  };
}

async function generateSteamSchemaWithSchemaParse(options = {}) {
  const appid = String(options.appid || "").trim();
  const outDir = path.resolve(String(options.outDir || "").trim());
  const userDataDir = normalizeUserDataDir(options.userDataDir);
  if (!/^\d+$/.test(appid)) {
    return { ok: false, reason: "invalid-appid" };
  }
  if (!outDir) {
    return { ok: false, reason: "invalid-output-dir" };
  }

  const runtime = await ensureSchemaParseRuntimeReady({
    userDataDir,
    reason: options.reason || "generate",
  });
  return executeSchemaParseSingle(runtime.runtimeDir, appid, outDir);
}

async function generateSteamSchemasWithSchemaParseBatch(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  const normalizedItems = items
    .map((item) => ({
      appid: String(item?.appid || "").trim(),
      outDir: path.resolve(String(item?.outDir || "").trim()),
      resultKey: String(item?.resultKey || item?.appid || "").trim(),
    }))
    .filter(
      (item) =>
        /^\d+$/.test(item.appid) &&
        !!item.outDir &&
        !!item.resultKey,
    );
  const results = new Map();
  if (!normalizedItems.length) {
    return { ok: true, results };
  }

  const runtime = await ensureSchemaParseRuntimeReady({
    userDataDir: normalizeUserDataDir(options.userDataDir),
    reason: options.reason || "generate-batch",
  });
  const chunkedItems = chunkArray(
    normalizedItems,
    options.chunkSize || SCHEMA_PARSE_BATCH_CHUNK_SIZE,
  );
  const batchErrors = [];
  let completedBeforeChunk = 0;
  for (let chunkIndex = 0; chunkIndex < chunkedItems.length; chunkIndex += 1) {
    const chunk = chunkedItems[chunkIndex];
    const chunkAppIds = chunk.map((item) => item.appid);
    const runChunk = async (attemptAppIds = chunkAppIds, attemptStartIndex = 0) =>
      runGenerateEmuConfigBatch(runtime.runtimeDir, attemptAppIds, {
        ...options,
        onProgress:
          typeof options.onProgress === "function"
            ? (progress = {}) => {
                const current =
                  Number.isFinite(Number(progress.current)) &&
                  Number(progress.current) >= 0
                    ? Number(progress.current)
                    : 0;
                options.onProgress({
                  ...progress,
                  current: completedBeforeChunk + attemptStartIndex + current,
                  total: normalizedItems.length,
                  percent:
                    Number.isFinite(Number(progress.percent)) &&
                    Number(progress.percent) >= 0
                      ? Math.max(
                          0,
                          Math.min(
                            78,
                            Math.round(
                              ((completedBeforeChunk + attemptStartIndex + current) /
                                Math.max(normalizedItems.length, 1)) *
                                78,
                            ),
                          ),
                        )
                      : 0,
                });
              }
            : null,
      });
    let chunkError = null;
    try {
      await runChunk();
    } catch (err) {
      chunkError = err;
      batchErrors.push(err);
      if (isSchemaParseAuthError(err)) {
        const retryStartIndex = findFirstMissingSchemaParseOutputIndex(
          runtime.runtimeDir,
          chunkAppIds,
        );
        const retryAppIds = chunkAppIds.slice(retryStartIndex);
        logger.warn("schema-parse:batch:auth-retry", {
          chunkIndex: chunkIndex + 1,
          chunkCount: chunkedItems.length,
          count: chunkAppIds.length,
          retryStartIndex,
          retryCount: retryAppIds.length,
          retryFromAppId: retryAppIds[0] || null,
          delayMs: SCHEMA_PARSE_AUTH_RETRY_DELAY_MS,
        });
        if (retryAppIds.length > 0) {
          await delay(SCHEMA_PARSE_AUTH_RETRY_DELAY_MS);
          try {
            await runChunk(retryAppIds, retryStartIndex);
            chunkError = null;
            batchErrors.pop();
          } catch (retryErr) {
            chunkError = retryErr;
            batchErrors[batchErrors.length - 1] = retryErr;
          }
        } else {
          chunkError = null;
          batchErrors.pop();
        }
      }
    }
    completedBeforeChunk += chunk.length;
    if (chunkIndex < chunkedItems.length - 1) {
      await delay(SCHEMA_PARSE_CHUNK_DELAY_MS);
    }
  }

  for (const item of normalizedItems) {
    const appOutputDir = resolveSchemaParseAppOutputDir(
      runtime.runtimeDir,
      item.appid,
    );
    const shouldRetrySingle =
      batchErrors.length > 0 &&
      !hasSchemaParseGeneratedAchievements(runtime.runtimeDir, item.appid);
    try {
      if (shouldRetrySingle) {
        logger.info("schema-parse:batch:retry-single", {
          appid: item.appid,
          resultKey: item.resultKey,
        });
        try {
          results.set(
            item.resultKey,
            await executeSchemaParseSingle(runtime.runtimeDir, item.appid, item.outDir),
          );
          continue;
        } catch (err) {
          logger.warn("schema-parse:batch:retry-single-failed", {
            appid: item.appid,
            resultKey: item.resultKey,
            error: err?.message || String(err),
            code:
              Number.isFinite(Number(err?.code)) || typeof err?.code === "string"
                ? err.code
                : null,
            hasStdout: !!String(err?.stdout || "").trim(),
            hasStderr: !!String(err?.stderr || "").trim(),
            stdoutPreview: String(err?.stdout || "").trim().slice(0, 4000) || null,
            stderrPreview: String(err?.stderr || "").trim().slice(0, 4000) || null,
          });
          results.set(item.resultKey, {
            ok: false,
            reason: "retry-single-failed",
          });
          continue;
        }
      }
      results.set(
        item.resultKey,
        readSchemaParseGeneratedResult(item.appid, appOutputDir, item.outDir),
      );
    } finally {
      cleanupGeneratedAppArtifacts(runtime.runtimeDir, item.appid);
    }
  }
  logger.info("schema-parse:batch:results", {
    count: normalizedItems.length,
    successCount: Array.from(results.values()).filter((entry) => entry?.ok)
      .length,
    partial: batchErrors.length > 0,
  });
  return {
    ok: batchErrors.length === 0,
    runtimeDir: runtime.runtimeDir,
    batchError: batchErrors[0] || null,
    batchErrors,
    results,
  };
}

module.exports = {
  TOP_OWNERS_TTL_MS,
  ensureSchemaParseRuntimeReady,
  generateSteamSchemaWithSchemaParse,
  generateSteamSchemasWithSchemaParseBatch,
  hasSchemaParseOutputArtifacts,
  normalizeGeneratedAchievementsSchema,
  readSchemaParseGeneratedDisplayName,
  resolveSchemaParseAppOutputDir,
  resolveSchemaParseRuntimeDir,
  resolveSchemaParseSeedArchive,
};
