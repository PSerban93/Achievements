const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { watchGenerationProcess } = require("./generation-process-timeout");
const { coordinateSchemaParse } = require("./schema-parse-coordinator");
const { createLogger } = require("./logger");
const { schemaConnectionFailure } = require("./schema-download-warning");
const { updateTopOwnersIds } = require("./update-top-owners");
const {
  readSchemaParseLaunchMetadata,
} = require("./schema-parse-launch-metadata");

const execFileAsync = promisify(execFile);
const logger = createLogger("schema-parse");
const TOP_OWNERS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SCHEMA_PARSE_DIRNAME = "schema_parse";
const SCHEMA_PARSE_ARCHIVE_NAME = "schema_parse.zip";
const SCHEMA_PARSE_DEFAULT_USERNAME = "goldie_0003";
const SCHEMA_PARSE_DEFAULT_PASSWORD = "BabaYaga0003";
const SCHEMA_PARSE_BATCH_CHUNK_SIZE = 20;
const SCHEMA_PARSE_AUTH_RETRY_DELAY_MS = 30000;
const SCHEMA_PARSE_CHUNK_DELAY_MS = 7000;
const SCHEMA_PARSE_OUTPUT_DIR_NAMES = ["output", "_OUTPUT"];
const SCHEMA_PARSE_GAME_TIMEOUT_MS = 180000;
const SCHEMA_PARSE_MUTABLE_NAMES = [
  "my_login.txt",
  "refresh_tokens.json",
  "top_owners_ids.txt",
  "output",
  "_OUTPUT",
];

let bootPreparationPromise = null;
let bootPreparationResult = null;
let bootPreparationStatus = "idle";

function normalizeUserDataDir(userDataDir = "") {
  return path.resolve(String(userDataDir || process.cwd()).trim());
}

function applySchemaParseEnvironment(baseEnv = process.env) {
  const nextEnv = { ...(baseEnv || {}) };
  nextEnv.PYTHONUNBUFFERED = "1";
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

function isPathWithinDirectory(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveSchemaParseExecutable(runtimeDir = "") {
  const runtimeInput = String(runtimeDir || "").trim();
  if (!runtimeInput) {
    throw new Error("schema_parse runtime directory is required");
  }

  const resolvedRuntimeDir = path.resolve(runtimeInput);
  const candidatePath = path.join(
    resolvedRuntimeDir,
    "generate_emu_config.exe",
  );
  let realRuntimeDir;
  let realExecutablePath;
  try {
    realRuntimeDir = fs.realpathSync(resolvedRuntimeDir);
    realExecutablePath = fs.realpathSync(candidatePath);
  } catch (error) {
    const wrapped = new Error(
      `schema_parse executable is unavailable: ${candidatePath}`,
    );
    wrapped.code = error?.code || "SCHEMA_PARSE_EXECUTABLE_UNAVAILABLE";
    throw wrapped;
  }

  if (
    !isPathWithinDirectory(realRuntimeDir, realExecutablePath) ||
    path.basename(realExecutablePath).toLowerCase() !==
      "generate_emu_config.exe"
  ) {
    throw new Error("schema_parse executable resolved outside its runtime");
  }

  let executableStat;
  try {
    executableStat = fs.statSync(realExecutablePath);
  } catch (error) {
    const wrapped = new Error(
      `schema_parse executable cannot be inspected: ${realExecutablePath}`,
    );
    wrapped.code = error?.code || "SCHEMA_PARSE_EXECUTABLE_UNAVAILABLE";
    throw wrapped;
  }
  if (!executableStat.isFile()) {
    throw new Error("schema_parse executable path is not a file");
  }

  return realExecutablePath;
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

async function computeFileHash(filePath = "") {
  const fullPath = path.resolve(String(filePath || "").trim());
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(fullPath)) hash.update(chunk);
  return hash.digest("hex");
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

async function extractSchemaParseArchive(archivePath, runtimeDir, options = {}) {
  const archiveLiteral = String(path.resolve(archivePath)).replace(/'/g, "''");
  const runtimeLiteral = String(path.resolve(runtimeDir)).replace(/'/g, "''");
  const command =
    "$ErrorActionPreference = 'Stop'; " +
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
      timeout: options.extractionTimeoutMs || 120000,
      signal: options.signal,
    },
  );
}

function normalizeAchievementTextObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  const text = String(value || "").trim();
  return text ? { english: text } : {};
}

function delay(ms = 0, signal = null) {
  const timeout = Math.max(0, Number(ms) || 0);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
  });
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

const { createRuntimePreparer } = require("./schema-parse-runtime-preparation");
const runtimePreparer = createRuntimePreparer({
  logger,
  coordinate: coordinateSchemaParse,
  resolveDir: resolveSchemaParseRuntimeDir,
  resolveArchive: resolveSchemaParseSeedArchive,
  hash: computeFileHash,
  ensureEnv: ensureSchemaParseProcessEnv,
  extract: extractSchemaParseArchive,
  validate: resolveSchemaParseExecutable,
  refreshOwners: updateTopOwnersIds,
  mutableNames: SCHEMA_PARSE_MUTABLE_NAMES,
});
async function ensureSchemaParseRuntimeReady(options = {}) {
  return runtimePreparer.prepare(options);
}

function startSchemaParseBootPreparation(options = {}) {
  if (bootPreparationPromise) return bootPreparationPromise;
  const startedAt = Date.now();
  bootPreparationStatus = "preparing";
  logger.info("schema-parse:boot-preparation:start", {
    reason: String(options.reason || "boot"),
  });
  // Yield before archive preparation so Electron can present its first frame.
  bootPreparationPromise = new Promise((resolve) => setImmediate(resolve))
    .then(() => ensureSchemaParseRuntimeReady({
      ...options,
      generationId: options.generationId || `boot-${crypto.randomUUID()}`,
      refreshTopOwners: true,
      reason: options.reason || "boot",
    }))
    .then((runtime) => {
      // The preparer already falls back to a local owners list and records
      // deferred cleanup. Preserve that state instead of claiming full success.
      bootPreparationResult = runtime;
      bootPreparationStatus = runtime.status;
      logger[runtime.fallback ? "warn" : "info"](
        runtime.fallback ? "schema-parse:boot-preparation:fallback" : "schema-parse:boot-preparation:ready",
        { durationMs: Date.now() - startedAt, fallback: runtime.fallback,
          topOwnersRefreshed: runtime.topOwnersRefreshed },
      );
      return runtime;
    })
    .catch((error) => {
      bootPreparationStatus = "failed";
      bootPreparationResult = null;
      logger.error("schema-parse:boot-preparation:failed", {
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error), code: error?.code,
        nativeCode: error?.nativeCode, stage: error?.stage,
        syscall: error?.syscall, path: error?.path,
      });
      bootPreparationPromise = null;
      throw error;
    });
  return bootPreparationPromise;
}

async function waitForSchemaParseBootPreparation() {
  if (!bootPreparationPromise) return null;
  return await bootPreparationPromise;
}

function getSchemaParseBootPreparationStatus() {
  return {
    status: bootPreparationStatus,
    result: bootPreparationResult,
    pending: bootPreparationStatus === "preparing",
  };
}

async function runGenerateEmuConfig(runtimeDir, appid, options = {}) {
  options.signal?.throwIfAborted();
  const exePath = resolveSchemaParseExecutable(runtimeDir);
  cleanupGeneratedAppArtifacts(runtimeDir, appid, { log: false });
  logger.info("schema-parse:run:start", { appid, runtimeDir });
  let result;
  let streamedStdout = "";
  let streamedStderr = "";
  try {
    // Inventory is unrelated to achievements and can stall after a complete
    // achievements result. Keep the executable and its runtime unchanged.
    const pending = execFileAsync(exePath, ["-skip_inv", String(appid)], {
      cwd: runtimeDir,
      windowsHide: true,
      shell: false,
      maxBuffer: 8 * 1024 * 1024,
      env: applySchemaParseEnvironment(process.env),
    });
    pending.child.stdout?.setEncoding("utf8");
    pending.child.stderr?.setEncoding("utf8");
    pending.child.stdout?.on("data", (chunk) => { streamedStdout += chunk; });
    pending.child.stderr?.on("data", (chunk) => { streamedStderr += chunk; });
    const deadline = watchGenerationProcess(pending.child, SCHEMA_PARSE_GAME_TIMEOUT_MS, { signal: options.signal });
    try {
      result = await pending;
      if (deadline.error) throw deadline.error;
    } catch (error) {
      if (deadline.error) {
        deadline.error.stdout = error.stdout || streamedStdout;
        deadline.error.stderr = error.stderr || streamedStderr;
        throw deadline.error;
      }
      throw error;
    } finally {
      deadline.clear();
    }
  } catch (err) {
    const stdout = String(err?.stdout || streamedStdout);
    const stderr = String(err?.stderr || streamedStderr);
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

function schemaRequestWarnings(appid, stdout = "", stderr = "", single = false) {
  const id = String(appid).replace(/^0+(?=\d)/, "");
  const text = String(stdout);
  const starts = [...text.matchAll(/(?:\*+\s*generating info for app id|\*+\s*STARTED config for app id)\s+(\d+)/gi)];
  const blocks = starts.flatMap((match, index) =>
    match[1].replace(/^0+(?=\d)/, "") === id
      ? [text.slice(match.index, starts[index + 1]?.index ?? text.length)] : []);
  // Without a game boundary, batch stderr cannot be assigned to an AppID.
  if (single && !starts.length) blocks.push(text);
  // Images, inventory and playtime are downloaded by the same executable.
  // Their failures must not become schema-download notifications.
  const candidates = blocks.flatMap((block) => block.split(/^(?:downloading|saving|finding)\s+(?:achievement\s+)?(?:images|icons|inventory)\b|^inventory definitions\b|^(?:downloading|finding)\s+playtime\b/imu)[0].split(/\r?\n/));
  const assetOrRarity = /\b(?:images?|icons?|inventory|playtime|rarity|percentages?)\b|(?:download|save|fetch|get)_[a-z_]*(?:image|icon|inventory|playtime|percentage)|\.(?:png|jpe?g|webp|gif)(?:[?\s'"]|$)/i;
  const stderrBlocks = String(stderr).split(/(?=Traceback \(most recent call last\):)/);
  for (const block of stderrBlocks) {
    if ((single || new RegExp(`\\b${id}\\b`).test(block)) &&
        !assetOrRarity.test(block)) {
      candidates.push(...block.split(/\r?\n/));
    }
  }
  return candidates.filter((line) => !assetOrRarity.test(line) && schemaConnectionFailure(line))
    .slice(0, 8).map((line) => line.trim().slice(0, 512));
}

function classifySchemaParseResult(appid, result, stdout = "", stderr = "") {
  result = { ...result, downloadWarnings: schemaRequestWarnings(appid, stdout, stderr) };
  if (result.ok) return result;
  const steamId = String(appid).replace(/^0+(?=\d)/, "");
  const text = String(stdout);
  const starts = [...text.matchAll(/(?:\*+\s*generating info for app id|\*+\s*STARTED config for app id)\s+(\d+)/gi)];
  const hasExplicitEmpty = (block) => [...block.matchAll(/\[X\]\s*app id\s+(\d+)\s+has not achievements/gi)]
    .some((match) => match[1].replace(/^0+(?=\d)/, "") === steamId);
  // A batch's game name must come from the same game's output block.
  const blocks = starts.flatMap((match, index) =>
    match[1].replace(/^0+(?=\d)/, "") === steamId
      ? [text.slice(match.index, starts[index + 1]?.index ?? text.length)] : []);
  // An unrelated later authentication retry must not discard an already
  // confirmed empty result for this AppID.
  const appText = [...blocks].reverse().find(hasExplicitEmpty) || blocks[blocks.length - 1] ||
    (starts.length ? "" : text);
  const nameMatch = appText.match(/App name on store:\s*(['"])(.+)\1/);
  const displayName = result.displayName || nameMatch?.[2]?.trim() || "";
  const explicitEmpty = hasExplicitEmpty(appText);
  if (result.status === "identified-no-achievements" || (displayName && explicitEmpty)) {
    logger.info("schema-parse:run:confirmed-no-achievements", {
      appid, displayName, source: explicitEmpty ? "stdout" : "empty-generated-schema",
    });
    return { ...result, displayName, status: "identified-no-achievements", identified: true, count: 0 };
  }
  const missingMetadata = [...appText.matchAll(/KeyError:\s*(\d+)\b/g)]
    .some((match) => match[1].replace(/^0+(?=\d)/, "") === steamId);
  if (missingMetadata && !displayName) {
    return { ...result, status: "not-found", reason: "application-metadata-missing" };
  }
  return { ...result, displayName };
}

async function executeSchemaParseSingle(runtimeDir, appid, outDir, options = {}) {
  let runResult = null;
  let runError = null;
  const maxAttempts = 2;
  const downloadWarnings = [];
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        runResult = await runGenerateEmuConfig(runtimeDir, appid, options);
        downloadWarnings.push(...schemaRequestWarnings(appid, runResult.stdout, runResult.stderr, true));
        runError = null;
        break;
      } catch (err) {
        runError = err;
        downloadWarnings.push(...schemaRequestWarnings(appid, err.stdout, err.stderr, true));
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
        await delay(SCHEMA_PARSE_AUTH_RETRY_DELAY_MS, options.signal);
      }
    }
    options.signal?.throwIfAborted();
    const result = classifySchemaParseResult(appid,
      readSchemaParseGeneratedResult(appid, runResult.appOutputDir, outDir), runResult.stdout);
    result.downloadWarnings = [...new Set([...downloadWarnings, ...result.downloadWarnings])];
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
    // Inventory/download failures must not erase an explicit achievements result.
    if (["identified-no-achievements", "not-found"].includes(result.status)) return result;
    if (runError) {
      runError.downloadWarnings = result.downloadWarnings;
      throw runError;
    }
    return result;
  } finally {
    cleanupGeneratedAppArtifacts(runtimeDir, appid);
  }
}

async function runGenerateEmuConfigBatch(runtimeDir, appids = [], options = {}) {
  options.signal?.throwIfAborted();
  const exePath = resolveSchemaParseExecutable(runtimeDir);
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
    // Security invariant: exePath is confined to the managed runtime, AppIDs
    // are digits-only, and no command string or shell is used.
    const cp = spawn( // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      exePath,
      ["-skip_inv", ...normalizedAppIds],
      {
        cwd: runtimeDir,
        windowsHide: true,
        shell: false,
        env: applySchemaParseEnvironment(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const deadline = watchGenerationProcess(cp, SCHEMA_PARSE_GAME_TIMEOUT_MS, { signal: options.signal });
    let deadlineProgress = -1;
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
      if (current > deadlineProgress) {
        deadlineProgress = current;
        deadline.touch();
      }
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
      deadline.clear();
      reject(err);
    });
    cp.on("close", (code) => {
      clearInterval(pollTimer);
      deadline.clear();
      if (deadline.error) {
        deadline.error.stdout = stdout;
        deadline.error.stderr = stderr;
        reject(deadline.error);
        return;
      }
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
    logger.info("schema-parse:run:missing-achievements-json", { appid });
    return {
      ok: false,
      reason: "no-achievements-json",
      launchMetadata,
      displayName,
    };
  }

  const rawSchema = JSON.parse(fs.readFileSync(schemaJsonPath, "utf8"));
  const achievements = normalizeGeneratedAchievementsSchema(rawSchema);
  if (!achievements.length) {
    return { ok: false, status: displayName && Array.isArray(rawSchema) && rawSchema.length === 0
      ? "identified-no-achievements" : "ambiguous", count: 0, displayName,
      identified: !!displayName, launchMetadata, reason: "empty-generated-schema" };
  }
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

async function generateSteamSchemaWithSchemaParseUncoordinated(options = {}) {
  const appid = String(options.appid || "").trim().replace(/^0+(?=\d)/, "");
  const outDir = path.resolve(String(options.outDir || "").trim());
  const userDataDir = normalizeUserDataDir(options.userDataDir);
  if (!/^\d+$/.test(appid)) {
    return { ok: false, reason: "invalid-appid" };
  }
  if (!outDir) {
    return { ok: false, reason: "invalid-output-dir" };
  }

  const preparedRuntime = options.__preparedRuntime || await waitForSchemaParseBootPreparation();
  const runtime = preparedRuntime || (await ensureSchemaParseRuntimeReady({
    userDataDir,
    reason: options.reason || "generate",
  }));
  return executeSchemaParseSingle(runtime.runtimeDir, appid, outDir, options);
}

async function generateSteamSchemasWithSchemaParseBatchUncoordinated(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  const normalizedItems = items
    .map((item) => ({
      appid: String(item?.appid || "").trim().replace(/^0+(?=\d)/, ""),
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

  const preparedRuntime = options.__preparedRuntime || await waitForSchemaParseBootPreparation();
  const runtime = preparedRuntime || (await ensureSchemaParseRuntimeReady({
    userDataDir: normalizeUserDataDir(options.userDataDir),
    reason: options.reason || "generate-batch",
  }));
  try {
    const chunkedItems = chunkArray(
      normalizedItems,
      options.chunkSize || SCHEMA_PARSE_BATCH_CHUNK_SIZE,
    );
    const batchErrors = [];
    let batchStdout = "";
    let batchStderr = "";
    let completedBeforeChunk = 0;
    for (let chunkIndex = 0; chunkIndex < chunkedItems.length; chunkIndex += 1) {
      options.signal?.throwIfAborted();
      const chunk = chunkedItems[chunkIndex];
      const chunkAppIds = chunk.map((item) => item.appid);
      const runChunk = async (attemptAppIds = chunkAppIds, attemptStartIndex = 0) => {
        try {
          const result = await runGenerateEmuConfigBatch(runtime.runtimeDir, attemptAppIds, {
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
          batchStdout += result.stdout || "";
          batchStderr += result.stderr || "";
          return result;
        } catch (error) {
          batchStdout += error.stdout || "";
          batchStderr += error.stderr || "";
          throw error;
        }
      };
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
            await delay(SCHEMA_PARSE_AUTH_RETRY_DELAY_MS, options.signal);
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
        await delay(SCHEMA_PARSE_CHUNK_DELAY_MS, options.signal);
      }
    }

    for (const item of normalizedItems) {
      options.signal?.throwIfAborted();
      const appOutputDir = resolveSchemaParseAppOutputDir(
        runtime.runtimeDir,
        item.appid,
      );
      const shouldRetrySingle =
        batchErrors.length > 0 &&
        !hasSchemaParseGeneratedAchievements(runtime.runtimeDir, item.appid);
      try {
        const generatedResult = classifySchemaParseResult(item.appid,
          readSchemaParseGeneratedResult(item.appid, appOutputDir, item.outDir), batchStdout, batchStderr);
        if (generatedResult.ok || ["identified-no-achievements", "not-found"].includes(generatedResult.status)) {
          results.set(item.resultKey, generatedResult);
          continue;
        }
        if (shouldRetrySingle) {
          logger.info("schema-parse:batch:retry-single", {
            appid: item.appid,
            resultKey: item.resultKey,
          });
          try {
            const retried = await executeSchemaParseSingle(runtime.runtimeDir, item.appid, item.outDir, options);
            results.set(item.resultKey, { ...retried,
              downloadWarnings: [...generatedResult.downloadWarnings, ...(retried.downloadWarnings || [])] });
            continue;
          } catch (err) {
            options.signal?.throwIfAborted();
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
              status: "technical-error",
              error: String(err?.message || err),
              downloadWarnings: [...generatedResult.downloadWarnings, ...(err.downloadWarnings || [])],
            });
            continue;
          }
        }
        results.set(
          item.resultKey,
          generatedResult,
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
  } finally {
    if (options.signal?.aborted) {
      for (const item of normalizedItems) cleanupGeneratedAppArtifacts(runtime.runtimeDir, item.appid);
    }
  }
}

async function generateSteamSchemaWithSchemaParse(options = {}) {
  if (process.env.ACHIEVEMENTS_SCHEMA_PARSE_COORDINATED === "1") {
    return coordinateSchemaParse("single", options, () => {});
  }
  if (!/^\d+$/.test(String(options.appid || "").trim())) {
    return { ok: false, reason: "invalid-appid" };
  }
  const runtime = await ensureSchemaParseRuntimeReady(options);
  return coordinateSchemaParse("single", options, () => generateSteamSchemaWithSchemaParseUncoordinated({ ...options, __preparedRuntime: runtime }));
}
async function generateSteamSchemasWithSchemaParseBatch(options = {}) {
  if (process.env.ACHIEVEMENTS_SCHEMA_PARSE_COORDINATED === "1") {
    return coordinateSchemaParse("batch", options, () => {});
  }
  if (!Array.isArray(options.items) || !options.items.some((item) => /^\d+$/.test(String(item?.appid || "").trim()))) {
    return { ok: true, results: new Map() };
  }
  const runtime = await ensureSchemaParseRuntimeReady(options);
  return coordinateSchemaParse("batch", options, () => generateSteamSchemasWithSchemaParseBatchUncoordinated({ ...options, __preparedRuntime: runtime }));
}

module.exports = {
  TOP_OWNERS_TTL_MS,
  ensureSchemaParseRuntimeReady,
  getSchemaParseBootPreparationStatus,
  generateSteamSchemaWithSchemaParse,
  generateSteamSchemasWithSchemaParseBatch,
  hasSchemaParseOutputArtifacts,
  normalizeGeneratedAchievementsSchema,
  readSchemaParseGeneratedDisplayName,
  resolveSchemaParseAppOutputDir,
  resolveSchemaParseExecutable,
  resolveSchemaParseRuntimeDir,
  resolveSchemaParseSeedArchive,
  startSchemaParseBootPreparation,
  waitForSchemaParseBootPreparation,
};
