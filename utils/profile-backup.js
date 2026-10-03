const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const tar = require("tar-stream");
const zlib = require("zlib");
const { writeJsonAtomicSync } = require("./atomic-json-store");

const PROFILE_BACKUP_FORMAT_VERSION = 2;
const PROFILE_BACKUP_MAGIC = Buffer.from("ACHBKZST", "ascii");
const PROFILE_BACKUP_HEADER_BYTES = PROFILE_BACKUP_MAGIC.length + 8;
const PROFILE_BACKUP_PREFIX = "profile/";
const PROFILE_BACKUP_DIRECTORIES = Object.freeze([
  "ach_cache",
  "collection-images",
  "configs",
  "custom-covers",
  "custom-headers",
  "images",
  "presets",
  "SANcache",
  "SANpresets",
  "sounds",
  "Themes",
  "xbox-pc",
  "retroachievements",
]);
const PROFILE_BACKUP_FILES = Object.freeze([
  "ach_cache_meta.json",
  "collections.json",
  "dashboard-summary.json",
  "epic-official-import-meta.json",
  "playtime-totals.json",
  "preferences.json",
]);
const PROFILE_BACKUP_ALLOWED_ROOTS = new Set([
  ...PROFILE_BACKUP_DIRECTORIES,
  ...PROFILE_BACKUP_FILES,
]);
const PROFILE_RESTORE_DIR = ".profile-restore";
const PROFILE_RESTORE_MARKER = "pending.json";
const MAX_BACKUP_ENTRIES = 150000;
const MAX_BACKUP_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BACKUP_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_MANIFEST_BYTES = 64 * 1024 * 1024;
const ZSTD_COMPRESSION_LEVEL = 15;
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function normalizeArchivePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function isSafeRelativePath(value) {
  const normalized = normalizeArchivePath(value);
  if (!normalized || normalized.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) return false;
  const parts = normalized.split("/");
  return !parts.some((part) => part === ".." || part === "");
}

async function sha256File(filePath, onChunk = null) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    if (typeof onChunk === "function") onChunk(chunk.length);
  }
  return hash.digest("hex");
}

function clampProgressPercent(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function createProgressReporter(callback) {
  if (typeof callback !== "function") return () => {};
  let lastPhase = "";
  let lastPercent = -1;
  let lastEmitAt = 0;
  return (payload = {}, options = {}) => {
    const phase = String(payload.phase || "");
    const percent = clampProgressPercent(payload.percent, lastPercent < 0 ? 0 : lastPercent);
    const now = Date.now();
    if (
      options.force !== true &&
      phase === lastPhase &&
      percent === lastPercent &&
      now - lastEmitAt < 500
    ) {
      return;
    }
    lastPhase = phase;
    lastPercent = percent;
    lastEmitAt = now;
    try {
      callback({ ...payload, phase, percent });
    } catch {}
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3 });
}

function writeProfileRestoreMarker(markerPath, marker) {
  writeJsonAtomicSync(markerPath, marker, { trailingNewline: true });
}

function createProfileRestoreRecoveryError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.recoveryRequired = true;
  return error;
}

function readStagedProfileRoots(stagingDir) {
  return fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((entry) => PROFILE_BACKUP_ALLOWED_ROOTS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function isValidProfileRestoreTransactionId(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

function walkFiles(rootPath, relativeRoot, visitor) {
  if (!fs.existsSync(rootPath)) return;
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink()) return;
  if (rootStat.isFile()) {
    visitor(rootPath, normalizeArchivePath(relativeRoot));
    return;
  }
  if (!rootStat.isDirectory()) return;
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    const relativePath = normalizeArchivePath(path.join(relativeRoot, entry.name));
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walkFiles(absolutePath, relativePath, visitor);
    } else if (stat.isFile()) {
      visitor(absolutePath, relativePath);
    }
  }
}

async function collectProfileEntries(userDataDir, options = {}) {
  const entries = [];
  const excludedPaths = new Set(
    (options.excludePaths || []).map((value) => path.resolve(value)),
  );
  const addFile = (absolutePath, relativePath) => {
    if (excludedPaths.has(path.resolve(absolutePath))) return;
    const safeRelativePath = normalizeArchivePath(relativePath);
    if (!isSafeRelativePath(safeRelativePath)) {
      throw new Error(`Unsafe profile path: ${relativePath}`);
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_BACKUP_ENTRY_BYTES) {
      throw new Error(`Profile file is too large to back up: ${safeRelativePath}`);
    }
    entries.push({
      absolutePath,
      relativePath: safeRelativePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: null,
    });
  };

  for (const directoryName of PROFILE_BACKUP_DIRECTORIES) {
    walkFiles(
      path.join(userDataDir, directoryName),
      directoryName,
      addFile,
    );
  }
  const profileFilesDir = options.profileFilesDir || userDataDir;
  for (const fileName of PROFILE_BACKUP_FILES) {
    const absolutePath = path.join(profileFilesDir, fileName);
    if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isFile()) {
      addFile(absolutePath, fileName);
    }
  }
  if (entries.length > MAX_BACKUP_ENTRIES) {
    throw new Error("The profile contains too many files to back up.");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
    throw new Error("The profile is larger than the supported backup limit.");
  }
  let processedBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    entry.sha256 = await sha256File(entry.absolutePath, (chunkBytes) => {
      processedBytes += chunkBytes;
      options.onProgress?.({
        phase: "hashing",
        processedBytes,
        totalBytes,
        current: index,
        total: entries.length,
        itemName: entry.relativePath,
      });
    });
    const current = fs.statSync(entry.absolutePath);
    if (current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) {
      throw new Error(
        `Profile file changed while preparing the backup: ${entry.relativePath}`,
      );
    }
    options.onProgress?.({
      phase: "hashing",
      processedBytes,
      totalBytes,
      current: index + 1,
      total: entries.length,
      itemName: entry.relativePath,
    });
  }
  return entries;
}

function createProfileFilesSnapshot(userDataDir) {
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "achievements-profile-backup-files-"),
  );
  try {
    for (const fileName of PROFILE_BACKUP_FILES) {
      const sourcePath = path.join(userDataDir, fileName);
      if (!fs.existsSync(sourcePath)) continue;
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > MAX_BACKUP_ENTRY_BYTES) {
        throw new Error(`Profile file is too large to back up: ${fileName}`);
      }
      const snapshotPath = path.join(snapshotDir, fileName);
      fs.copyFileSync(sourcePath, snapshotPath);
      fs.utimesSync(snapshotPath, stat.atime, stat.mtime);
    }
    return snapshotDir;
  } catch (error) {
    removePath(snapshotDir);
    throw error;
  }
}

function countEntryPrefix(entries, prefix) {
  const normalizedPrefix = `${normalizeArchivePath(prefix).replace(/\/$/, "")}/`;
  return entries.filter((entry) => entry.relativePath.startsWith(normalizedPrefix))
    .length;
}

function buildBackupSummary(entries) {
  const configPrefix = "configs/";
  const configCount = entries.filter((entry) => {
    if (!entry.relativePath.startsWith(configPrefix)) return false;
    const nested = entry.relativePath.slice(configPrefix.length);
    return !nested.includes("/") && nested.toLowerCase().endsWith(".json");
  }).length;
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    configCount,
    cacheCount: countEntryPrefix(entries, "ach_cache"),
    presetCount:
      countEntryPrefix(entries, "presets") +
      countEntryPrefix(entries, "SANpresets"),
    imageCount:
      countEntryPrefix(entries, "images") +
      countEntryPrefix(entries, "custom-covers") +
      countEntryPrefix(entries, "custom-headers"),
  };
}

function createZstdCompressor() {
  const params = {
    [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL,
  };
  if (Number.isInteger(zlib.constants.ZSTD_c_checksumFlag)) {
    params[zlib.constants.ZSTD_c_checksumFlag] = 1;
  }
  return zlib.createZstdCompress({ params });
}

function writeStreamBuffer(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function addFileToTar(pack, entry, onChunk = null) {
  const archiveEntry = pack.entry({
    name: `${PROFILE_BACKUP_PREFIX}${entry.relativePath}`,
    size: entry.size,
    mode: 0o600,
    mtime: new Date(entry.mtimeMs),
    type: "file",
  });
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      if (typeof onChunk === "function") onChunk(chunk.length);
      callback(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(entry.absolutePath), meter, archiveEntry);
}

async function writeStreamingTarZstd(
  destinationPath,
  entries,
  manifest,
  options = {},
) {
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBuffer.length > MAX_BACKUP_MANIFEST_BYTES) {
    throw new Error("The backup manifest is too large.");
  }

  const header = Buffer.alloc(PROFILE_BACKUP_HEADER_BYTES);
  PROFILE_BACKUP_MAGIC.copy(header, 0);
  header.writeUInt32LE(PROFILE_BACKUP_FORMAT_VERSION, PROFILE_BACKUP_MAGIC.length);
  header.writeUInt32LE(
    manifestBuffer.length,
    PROFILE_BACKUP_MAGIC.length + 4,
  );

  const output = fs.createWriteStream(destinationPath, { flags: "wx" });
  try {
    await writeStreamBuffer(output, header);
    await writeStreamBuffer(output, manifestBuffer);
  } catch (error) {
    output.destroy();
    throw error;
  }

  const pack = tar.pack();
  const compressor = createZstdCompressor();
  let archivePipelineError = null;
  const archivePipeline = pipeline(pack, compressor, output).catch((error) => {
    archivePipelineError = error;
    try {
      pack.destroy(error);
    } catch {}
  });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  let processedBytes = 0;

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (archivePipelineError) throw archivePipelineError;
      await addFileToTar(pack, entry, (chunkBytes) => {
        processedBytes += chunkBytes;
        options.onProgress?.({
          phase: "compressing",
          processedBytes,
          totalBytes,
          current: index,
          total: entries.length,
          itemName: entry.relativePath,
        });
      });
      options.onProgress?.({
        phase: "compressing",
        processedBytes,
        totalBytes,
        current: index + 1,
        total: entries.length,
        itemName: entry.relativePath,
      });
    }
    options.onProgress?.({
      phase: "finalizing",
      processedBytes,
      totalBytes,
      current: entries.length,
      total: entries.length,
      itemName: "",
    });
    pack.finalize();
    await archivePipeline;
    if (archivePipelineError) throw archivePipelineError;
  } catch (error) {
    try {
      pack.destroy(error);
    } catch {}
    try {
      compressor.destroy(error);
    } catch {}
    try {
      output.destroy(error);
    } catch {}
    await archivePipeline;
    throw archivePipelineError || error;
  }
}

async function createProfileBackup({
  userDataDir,
  destinationPath,
  appVersion,
  onProgress,
}) {
  if (!userDataDir || !destinationPath) {
    throw new Error("Backup source and destination are required.");
  }
  ensureDirectory(path.dirname(destinationPath));
  const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  const reportProgress = createProgressReporter(onProgress);
  reportProgress(
    { phase: "preparing", percent: 0, current: 0, total: 0, itemName: "" },
    { force: true },
  );
  const profileFilesSnapshotDir = createProfileFilesSnapshot(userDataDir);
  try {
    reportProgress(
      { phase: "scanning", percent: 3, current: 0, total: 0, itemName: "" },
      { force: true },
    );
    const entries = await collectProfileEntries(userDataDir, {
      excludePaths: [destinationPath],
      profileFilesDir: profileFilesSnapshotDir,
      onProgress(progress = {}) {
        const totalBytes = Number(progress.totalBytes || 0);
        const ratio = totalBytes > 0
          ? Number(progress.processedBytes || 0) / totalBytes
          : Number(progress.current || 0) / Math.max(1, Number(progress.total || 0));
        reportProgress({
          ...progress,
          percent: 5 + Math.max(0, Math.min(1, ratio)) * 40,
        });
      },
    });
    if (!entries.some((entry) => entry.relativePath === "preferences.json")) {
      throw new Error("preferences.json is missing from the profile.");
    }
    const summary = buildBackupSummary(entries);
    if (entries.length > MAX_BACKUP_ENTRIES) {
      throw new Error("The profile contains too many files to back up.");
    }
    if (summary.totalBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
      throw new Error("The profile is larger than the supported backup limit.");
    }
    const manifest = {
      format: "achievements-profile-backup",
      formatVersion: PROFILE_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      appVersion: String(appVersion || "unknown"),
      sourceUserDataRoot: path.resolve(userDataDir),
      summary,
      entries: entries.map((entry) => ({
        path: entry.relativePath,
        size: entry.size,
        sha256: entry.sha256,
      })),
    };

    reportProgress(
      {
        phase: "compressing",
        percent: 45,
        current: 0,
        total: entries.length,
        itemName: "",
      },
      { force: true },
    );
    await writeStreamingTarZstd(tempPath, entries, manifest, {
      onProgress(progress = {}) {
        const totalBytes = Number(progress.totalBytes || 0);
        const ratio = totalBytes > 0
          ? Number(progress.processedBytes || 0) / totalBytes
          : Number(progress.current || 0) / Math.max(1, Number(progress.total || 0));
        const isFinalizing = progress.phase === "finalizing";
        reportProgress(
          {
            ...progress,
            percent: isFinalizing
              ? 99
              : 45 + Math.max(0, Math.min(1, ratio)) * 53,
          },
          { force: isFinalizing },
        );
      },
    });
    for (const entry of entries) {
      const current = fs.statSync(entry.absolutePath);
      if (current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) {
        throw new Error(
          `Profile file changed while creating the backup: ${entry.relativePath}`,
        );
      }
    }
    // The temp file is a sibling, so rename replaces the destination on the
    // same volume. Keep the previous archive in place if replacement fails.
    fs.renameSync(tempPath, destinationPath);
    reportProgress(
      {
        phase: "completed",
        percent: 100,
        current: entries.length,
        total: entries.length,
        itemName: "",
      },
      { force: true },
    );
    return { ...summary, destinationPath, manifest };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    } catch {}
    try {
      removePath(profileFilesSnapshotDir);
    } catch {}
  }
}

function parseManifestData(data) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    throw new Error("The backup manifest is invalid.");
  }
  if (
    manifest?.format !== "achievements-profile-backup" ||
    Number(manifest?.formatVersion) !== PROFILE_BACKUP_FORMAT_VERSION ||
    !Array.isArray(manifest?.entries)
  ) {
    throw new Error("This backup format is not supported.");
  }
  return manifest;
}

function validateManifestEntry(relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  if (!isSafeRelativePath(normalized)) {
    throw new Error(`Unsafe path in backup: ${relativePath}`);
  }
  const root = normalized.split("/", 1)[0];
  if (!PROFILE_BACKUP_ALLOWED_ROOTS.has(root)) {
    throw new Error(`Unsupported profile entry: ${relativePath}`);
  }
  if (PROFILE_BACKUP_FILES.includes(root) && normalized !== root) {
    throw new Error(`Invalid file entry in backup: ${relativePath}`);
  }
  return normalized;
}

async function readExact(fileHandle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await fileHandle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (!result.bytesRead) {
      throw new Error("The backup file is truncated.");
    }
    offset += result.bytesRead;
  }
}

async function readBackupContainerHeader(archivePath) {
  const fileHandle = await fs.promises.open(archivePath, "r");
  try {
    const stat = await fileHandle.stat();
    if (stat.size < PROFILE_BACKUP_HEADER_BYTES + ZSTD_FRAME_MAGIC.length) {
      throw new Error("This file is not an Achievements profile backup.");
    }
    const header = Buffer.alloc(PROFILE_BACKUP_HEADER_BYTES);
    await readExact(fileHandle, header, 0);
    if (!header.subarray(0, PROFILE_BACKUP_MAGIC.length).equals(PROFILE_BACKUP_MAGIC)) {
      throw new Error("This backup format is not supported.");
    }
    const formatVersion = header.readUInt32LE(PROFILE_BACKUP_MAGIC.length);
    if (formatVersion !== PROFILE_BACKUP_FORMAT_VERSION) {
      throw new Error("This backup format is not supported.");
    }
    const manifestLength = header.readUInt32LE(PROFILE_BACKUP_MAGIC.length + 4);
    if (!manifestLength || manifestLength > MAX_BACKUP_MANIFEST_BYTES) {
      throw new Error("The backup manifest is invalid.");
    }
    const payloadOffset = PROFILE_BACKUP_HEADER_BYTES + manifestLength;
    if (payloadOffset + ZSTD_FRAME_MAGIC.length > stat.size) {
      throw new Error("The backup file is truncated.");
    }
    const manifestBuffer = Buffer.alloc(manifestLength);
    await readExact(fileHandle, manifestBuffer, PROFILE_BACKUP_HEADER_BYTES);
    const zstdMagic = Buffer.alloc(ZSTD_FRAME_MAGIC.length);
    await readExact(fileHandle, zstdMagic, payloadOffset);
    if (!zstdMagic.equals(ZSTD_FRAME_MAGIC)) {
      throw new Error("The backup payload is not a valid Zstandard stream.");
    }
    return {
      manifest: parseManifestData(manifestBuffer),
      payloadOffset,
    };
  } finally {
    await fileHandle.close();
  }
}

function normalizeTarEntryPath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (
    !raw ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("//") ||
    /^[a-zA-Z]:/.test(raw)
  ) {
    throw new Error(`Unsafe path in backup payload: ${value}`);
  }
  const normalized = normalizeArchivePath(raw);
  if (!isSafeRelativePath(normalized)) {
    throw new Error(`Unsafe path in backup payload: ${value}`);
  }
  return normalized;
}

async function processTarZstdPayload(
  archivePath,
  payloadOffset,
  expectedEntries,
  options = {},
) {
  const expected = new Map(
    expectedEntries.map((entry) => [
      `${PROFILE_BACKUP_PREFIX}${entry.path}`,
      entry,
    ]),
  );
  const processed = new Set();
  const totalBytes = expectedEntries.reduce(
    (sum, entry) => sum + Number(entry.size || 0),
    0,
  );
  let processedBytes = 0;
  const input = fs.createReadStream(archivePath, { start: payloadOffset });
  const decompressor = zlib.createZstdDecompress();
  const extract = tar.extract();
  let archivePipelineError = null;
  const archivePipeline = pipeline(input, decompressor, extract).catch(
    (error) => {
      archivePipelineError = error;
    },
  );
  try {
    for await (const archiveEntry of extract) {
      const header = archiveEntry.header || {};
      const name = normalizeTarEntryPath(header.name);
      if (header.type !== "file") {
        throw new Error(`Unsupported entry type in backup: ${name}`);
      }
      const expectedEntry = expected.get(name);
      if (!expectedEntry) {
        throw new Error(`Unsupported archive entry: ${name}`);
      }
      if (processed.has(expectedEntry.path)) {
        throw new Error(`Duplicate archive entry: ${name}`);
      }
      const headerSize = Number(header.size);
      if (!Number.isSafeInteger(headerSize) || headerSize !== expectedEntry.size) {
        throw new Error(`Backup entry size mismatch: ${expectedEntry.path}`);
      }
      const hash = crypto.createHash("sha256");
      let size = 0;
      const reportChunk = (chunkBytes) => {
        size += chunkBytes;
        processedBytes += chunkBytes;
        options.onProgress?.({
          phase: "extracting",
          processedBytes,
          totalBytes,
          current: processed.size,
          total: expectedEntries.length,
          itemName: expectedEntry.path,
        });
      };

      const destination = options.stagingDir
        ? path.resolve(options.stagingDir, ...expectedEntry.path.split("/"))
        : null;
      if (destination && !isPathInside(options.stagingDir, destination)) {
        throw new Error(`Unsafe restore destination: ${expectedEntry.path}`);
      }
      if (destination) ensureDirectory(path.dirname(destination));

      if (destination) {
        const verifier = new Transform({
          transform(chunk, _encoding, callback) {
            reportChunk(chunk.length);
            if (size > expectedEntry.size) {
              callback(
                new Error(`Backup entry size mismatch: ${expectedEntry.path}`),
              );
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          archiveEntry,
          verifier,
          fs.createWriteStream(destination, { flags: "wx" }),
        );
      } else {
        for await (const chunk of archiveEntry) {
          reportChunk(chunk.length);
          if (size > expectedEntry.size) {
            throw new Error(
              `Backup entry size mismatch: ${expectedEntry.path}`,
            );
          }
          hash.update(chunk);
        }
      }
      if (
        size !== expectedEntry.size ||
        hash.digest("hex") !== expectedEntry.sha256
      ) {
        throw new Error(`Backup entry failed verification: ${expectedEntry.path}`);
      }
      processed.add(expectedEntry.path);
      options.onProgress?.({
        phase: "extracting",
        processedBytes,
        totalBytes,
        current: processed.size,
        total: expectedEntries.length,
        itemName: expectedEntry.path,
      });
      if (processed.size > MAX_BACKUP_ENTRIES) {
        throw new Error("The backup contains too many archive entries.");
      }
    }
    await archivePipeline;
    if (archivePipelineError) throw archivePipelineError;
  } catch (error) {
    input.destroy();
    decompressor.destroy();
    extract.destroy();
    await archivePipeline;
    throw error;
  }
  if (processed.size !== expected.size) {
    const missing = expectedEntries.find((entry) => !processed.has(entry.path));
    throw new Error(`Backup entry is missing: ${missing?.path || "unknown"}`);
  }
}

async function inspectProfileBackup(archivePath, options = {}) {
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error("The selected backup file no longer exists.");
  }
  const { manifest, payloadOffset } =
    await readBackupContainerHeader(archivePath);
  if (manifest.entries.length > MAX_BACKUP_ENTRIES) {
    throw new Error("The backup contains too many files.");
  }
  let totalBytes = 0;
  const seen = new Set();
  const normalizedEntries = manifest.entries.map((entry) => {
    const relativePath = validateManifestEntry(entry?.path);
    if (seen.has(relativePath)) {
      throw new Error(`Duplicate entry in backup: ${relativePath}`);
    }
    seen.add(relativePath);
    const size = Number(entry?.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid size in backup: ${relativePath}`);
    }
    if (size > MAX_BACKUP_ENTRY_BYTES) {
      throw new Error(`Backup entry is too large: ${relativePath}`);
    }
    const digest = String(entry?.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid checksum in backup: ${relativePath}`);
    }
    totalBytes += size;
    return {
      path: relativePath,
      size,
      sha256: digest,
    };
  });
  if (totalBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
    throw new Error("The backup is larger than the supported profile limit.");
  }
  if (options.verifyData === true) {
    await processTarZstdPayload(
      archivePath,
      payloadOffset,
      normalizedEntries,
      { onProgress: options.onProgress },
    );
  }
  return {
    archivePath,
    payloadOffset,
    manifest: { ...manifest, entries: normalizedEntries },
    summary: manifest.summary || buildBackupSummary(
      normalizedEntries.map((entry) => ({
        relativePath: entry.path,
        size: entry.size,
      })),
    ),
  };
}

function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function extractProfileArchive(
  archivePath,
  payloadOffset,
  stagingDir,
  manifestEntries,
  options = {},
) {
  await processTarZstdPayload(archivePath, payloadOffset, manifestEntries, {
    stagingDir,
    onProgress: options.onProgress,
  });
}

function removePreviousPreparedRestore(restoreDir, marker, keepPath) {
  const previousStaging = String(marker?.stagingDir || "").trim();
  if (
    previousStaging &&
    path.resolve(previousStaging) !== path.resolve(keepPath) &&
    isPathInside(restoreDir, previousStaging)
  ) {
    try {
      removePath(previousStaging);
    } catch {}
  }
}

async function stageProfileRestore({ archivePath, userDataDir, onProgress }) {
  const reportProgress = createProgressReporter(onProgress);
  reportProgress(
    { phase: "checking", percent: 0, current: 0, total: 0, itemName: "" },
    { force: true },
  );
  const inspected = await inspectProfileBackup(archivePath);
  reportProgress(
    {
      phase: "extracting",
      percent: 5,
      current: 0,
      total: inspected.manifest.entries.length,
      itemName: "",
    },
    { force: true },
  );
  const restoreDir = path.join(userDataDir, PROFILE_RESTORE_DIR);
  ensureDirectory(restoreDir);
  const markerPath = path.join(restoreDir, PROFILE_RESTORE_MARKER);
  let previousMarker = null;
  if (fs.existsSync(markerPath)) {
    try {
      previousMarker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    } catch {
      throw new Error(
        "A profile restore marker is unreadable. Resolve it before preparing another restore.",
      );
    }
    if (previousMarker?.state !== "committed") {
      throw new Error(
        "A profile restore is already pending. Restart Achievements before preparing another restore.",
      );
    }
  }
  const transactionId = crypto.randomUUID();
  const stagingTemp = path.join(restoreDir, `prepared-${transactionId}.tmp`);
  const stagingDir = path.join(restoreDir, `prepared-${transactionId}`);
  removePath(stagingTemp);
  removePath(stagingDir);
  ensureDirectory(stagingTemp);
  let committed = false;
  try {
    await extractProfileArchive(
      archivePath,
      inspected.payloadOffset,
      stagingTemp,
      inspected.manifest.entries,
      {
        onProgress(progress = {}) {
          const totalBytes = Number(progress.totalBytes || 0);
          const ratio = totalBytes > 0
            ? Number(progress.processedBytes || 0) / totalBytes
            : Number(progress.current || 0) /
              Math.max(1, Number(progress.total || 0));
          reportProgress({
            ...progress,
            percent: 5 + Math.max(0, Math.min(1, ratio)) * 90,
          });
        },
      },
    );
    fs.renameSync(stagingTemp, stagingDir);
    reportProgress(
      {
        phase: "finalizing",
        percent: 98,
        current: inspected.manifest.entries.length,
        total: inspected.manifest.entries.length,
        itemName: "",
      },
      { force: true },
    );
    const stagedRoots = Array.from(
      new Set(
        inspected.manifest.entries.map((entry) =>
          normalizeArchivePath(entry.path).split("/")[0],
        ),
      ),
    ).sort();
    if (
      !stagedRoots.includes("preferences.json") ||
      stagedRoots.some((rootName) => !PROFILE_BACKUP_ALLOWED_ROOTS.has(rootName))
    ) {
      throw new Error("The prepared backup does not contain valid profile roots.");
    }
    const marker = {
      version: 3,
      state: "prepared",
      transactionId,
      stagingDir,
      stagedRoots,
      supersededRollbackDirs:
        previousMarker?.state === "committed"
          ? [
              previousMarker.rollbackDir,
              ...(Array.isArray(previousMarker.supersededRollbackDirs)
                ? previousMarker.supersededRollbackDirs
                : []),
            ].filter((value) => typeof value === "string" && value.trim())
          : [],
      requestedAt: new Date().toISOString(),
      sourceUserDataRoot: inspected.manifest.sourceUserDataRoot || "",
      createdAt: inspected.manifest.createdAt || null,
      appVersion: inspected.manifest.appVersion || null,
      summary: inspected.summary || {},
    };
    writeProfileRestoreMarker(markerPath, marker);
    committed = true;
    removePreviousPreparedRestore(restoreDir, previousMarker, stagingDir);
    reportProgress(
      {
        phase: "completed",
        percent: 100,
        current: inspected.manifest.entries.length,
        total: inspected.manifest.entries.length,
        itemName: "",
      },
      { force: true },
    );
    return { ...inspected, stagingDir };
  } finally {
    try {
      removePath(stagingTemp);
    } catch {}
    if (!committed) {
      try {
        removePath(stagingDir);
      } catch {}
    }
  }
}

function rebaseString(value, oldRoot, newRoot) {
  if (!oldRoot || typeof value !== "string") return value;
  const oldNormalized = path.resolve(oldRoot);
  const valueLower = process.platform === "win32" ? value.toLowerCase() : value;
  const oldLower = process.platform === "win32" ? oldNormalized.toLowerCase() : oldNormalized;
  if (valueLower === oldLower) return newRoot;
  if (
    valueLower.startsWith(`${oldLower}\\`) ||
    valueLower.startsWith(`${oldLower}/`)
  ) {
    return path.join(newRoot, value.slice(oldNormalized.length).replace(/^[\\/]+/, ""));
  }
  return value;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteRestoredJsonFiles(userDataDir, oldRoot) {
  if (!oldRoot || path.resolve(oldRoot) === path.resolve(userDataDir)) return;
  const sourceRoot = path.resolve(oldRoot);
  const targetRoot = path.resolve(userDataDir);
  const replacements = [
    [
      JSON.stringify(sourceRoot).slice(1, -1),
      JSON.stringify(targetRoot).slice(1, -1),
    ],
    [sourceRoot.replace(/\\/g, "/"), targetRoot.replace(/\\/g, "/")],
    [sourceRoot, targetRoot],
  ];
  for (const rootName of [...PROFILE_BACKUP_DIRECTORIES, ...PROFILE_BACKUP_FILES]) {
    const target = path.join(userDataDir, rootName);
    walkFiles(target, rootName, (absolutePath) => {
      if (path.extname(absolutePath).toLowerCase() !== ".json") return;
      try {
        const original = fs.readFileSync(absolutePath, "utf8");
        let rebased = original;
        for (const [source, destination] of replacements) {
          if (!source || source === destination) continue;
          rebased = rebased.replace(
            new RegExp(escapeRegExp(source), process.platform === "win32" ? "gi" : "g"),
            () => destination,
          );
        }
        if (rebased !== original) fs.writeFileSync(absolutePath, rebased, "utf8");
      } catch {
        // Non-JSON assets with a .json suffix are left byte-for-byte intact.
      }
    });
  }
}

function refreshFingerprintPart(part, oldRoot, userDataDir) {
  if (!part || typeof part !== "object") return part;
  const rebasedPath = rebaseString(part.path, oldRoot, userDataDir);
  if (!rebasedPath) return { ...part, path: rebasedPath || "" };
  try {
    const stat = fs.statSync(rebasedPath);
    return { path: rebasedPath, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { path: rebasedPath, mtimeMs: null, size: null };
  }
}

function repairDashboardSummary(userDataDir, oldRoot) {
  const summaryPath = path.join(userDataDir, "dashboard-summary.json");
  if (!fs.existsSync(summaryPath)) return;
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const entries = summary?.entries && typeof summary.entries === "object"
      ? summary.entries
      : {};
    for (const value of Object.values(entries)) {
      if (!value || typeof value !== "object") continue;
      if (value.fingerprint && typeof value.fingerprint === "object") {
        for (const key of ["config", "schema", "cache"]) {
          value.fingerprint[key] = refreshFingerprintPart(
            value.fingerprint[key],
            oldRoot,
            userDataDir,
          );
        }
      }
      if (value.platinumConfigFingerprint) {
        value.platinumConfigFingerprint = refreshFingerprintPart(
          value.platinumConfigFingerprint,
          oldRoot,
          userDataDir,
        );
      }
    }
    summary.updatedAt = Date.now();
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch {
    // The normal dashboard reconciliation path can rebuild an invalid summary.
  }
}

function applyStagedProfileRestoreSync({
  userDataDir,
  restoreDir,
  markerPath,
  marker: initialMarker,
}) {
  const transactionId = initialMarker.transactionId;
  const stagingDir = path.resolve(initialMarker.stagingDir);
  const stagedRoots = Array.isArray(initialMarker.stagedRoots)
    ? initialMarker.stagedRoots
    : readStagedProfileRoots(stagingDir);
  const replacementTargets = [
    ...PROFILE_BACKUP_ALLOWED_ROOTS,
    ...PROFILE_BACKUP_FILES.map((fileName) => `${fileName}.bak`),
  ];
  if (
    !isValidProfileRestoreTransactionId(transactionId) ||
    !stagedRoots.includes("preferences.json") ||
    stagedRoots.some((rootName) => !PROFILE_BACKUP_ALLOWED_ROOTS.has(rootName))
  ) {
    throw new Error("The prepared profile restore journal is invalid.");
  }

  if (initialMarker.state === "committed") {
    return {
      applied: true,
      summary: initialMarker.summary || {},
      createdAt: initialMarker.createdAt || null,
      appVersion: initialMarker.appVersion || null,
      rollbackDir: initialMarker.rollbackDir || null,
    };
  }

  if (initialMarker.state === "applying" || initialMarker.state === "rollingBack") {
    const marker = { ...initialMarker, state: "rollingBack" };
    try {
      writeProfileRestoreMarker(markerPath, marker);
      rollbackProfileRestoreSync({
        userDataDir,
        restoreDir,
        markerPath,
        marker,
        stagedRoots,
      });
    } catch (error) {
      error.recoveryRequired = true;
      throw error;
    }
    return {
      applied: false,
      rolledBack: true,
      transactionId,
    };
  }
  if (initialMarker.state !== "prepared") {
    throw new Error("The prepared profile restore has an unknown state.");
  }

  const rollbackDir = path.join(restoreDir, `rollback-${transactionId}`);
  const existingRoots = replacementTargets.filter((rootName) =>
    fs.existsSync(path.join(userDataDir, rootName)),
  );
  const marker = {
    ...initialMarker,
    version: 3,
    state: "applying",
    rollbackDir,
    existingRoots,
    startedAt: new Date().toISOString(),
  };
  // Persist the recovery information before moving any live profile data.
  writeProfileRestoreMarker(markerPath, marker);
  try {
    ensureDirectory(rollbackDir);
    for (const rootName of replacementTargets) {
      const current = path.join(userDataDir, rootName);
      if (!fs.existsSync(current)) continue;
      const rollback = path.join(rollbackDir, rootName);
      ensureDirectory(path.dirname(rollback));
      fs.renameSync(current, rollback);
    }
    for (const rootName of stagedRoots) {
      const incoming = path.join(stagingDir, rootName);
      if (!fs.existsSync(incoming)) {
        throw new Error(`A staged profile root is missing: ${rootName}`);
      }
      const destination = path.join(userDataDir, rootName);
      fs.renameSync(incoming, destination);
    }
    rewriteRestoredJsonFiles(
      userDataDir,
      String(marker.sourceUserDataRoot || "").trim(),
    );
    repairDashboardSummary(
      userDataDir,
      String(marker.sourceUserDataRoot || "").trim(),
    );
    writeProfileRestoreMarker(markerPath, {
      ...marker,
      state: "committed",
      committedAt: new Date().toISOString(),
    });
    try {
      removePath(stagingDir);
    } catch {
      // The committed journal allows startup to retry cleanup safely.
    }
    return {
      applied: true,
      summary: marker.summary || {},
      createdAt: marker.createdAt || null,
      appVersion: marker.appVersion || null,
      rollbackDir,
    };
  } catch (error) {
    let rollbackError = null;
    try {
      const rollingBack = { ...marker, state: "rollingBack" };
      writeProfileRestoreMarker(markerPath, rollingBack);
      rollbackProfileRestoreSync({
        userDataDir,
        restoreDir,
        markerPath,
        marker: rollingBack,
        stagedRoots,
      });
    } catch (recoveryError) {
      rollbackError = recoveryError;
    }
    if (rollbackError) {
      throw createProfileRestoreRecoveryError(
        `${error?.message || String(error)}; restore recovery remains pending: ${rollbackError?.message || String(rollbackError)}`,
        error,
      );
    }
    throw error;
  }
}

function rollbackProfileRestoreSync({
  userDataDir,
  restoreDir,
  markerPath,
  marker,
  stagedRoots,
}) {
  const stagingDir = path.resolve(String(marker.stagingDir || ""));
  const rollbackDir = path.resolve(String(marker.rollbackDir || ""));
  if (
    !isPathInside(restoreDir, stagingDir) ||
    !isPathInside(restoreDir, rollbackDir) ||
    !/^rollback-[a-f0-9-]{36}$/i.test(path.basename(rollbackDir))
  ) {
    throw new Error("The profile restore rollback paths are invalid.");
  }
  const existingRoots = new Set(
    Array.isArray(marker.existingRoots) ? marker.existingRoots : [],
  );
  const replacementTargetSet = new Set([
    ...PROFILE_BACKUP_ALLOWED_ROOTS,
    ...PROFILE_BACKUP_FILES.map((fileName) => `${fileName}.bak`),
  ]);
  if ([...existingRoots].some((rootName) => !replacementTargetSet.has(rootName))) {
    throw new Error("The profile restore rollback journal is invalid.");
  }

  for (const rootName of stagedRoots) {
    const incoming = path.join(stagingDir, rootName);
    const destination = path.join(userDataDir, rootName);
    const rollback = path.join(rollbackDir, rootName);
    if (
      !fs.existsSync(incoming) &&
      (!existingRoots.has(rootName) || fs.existsSync(rollback))
    ) {
      removePath(destination);
    }
  }
  for (const rootName of existingRoots) {
    const current = path.join(userDataDir, rootName);
    const rollback = path.join(rollbackDir, rootName);
    if (fs.existsSync(rollback)) {
      removePath(current);
      ensureDirectory(path.dirname(current));
      fs.renameSync(rollback, current);
    } else if (!fs.existsSync(current)) {
      throw new Error(`The original profile root cannot be recovered: ${rootName}`);
    }
  }

  fs.rmSync(markerPath, { force: true });
  try {
    removePath(stagingDir);
  } catch {}
  try {
    removePath(rollbackDir);
  } catch {}
}

async function cleanupProfileRestoreRollbacks({ userDataDir } = {}) {
  if (!userDataDir) return { removed: [], failed: [] };
  const restoreDir = path.join(userDataDir, PROFILE_RESTORE_DIR);
  const markerPath = path.join(restoreDir, PROFILE_RESTORE_MARKER);
  let marker;
  try {
    marker = JSON.parse(await fs.promises.readFile(markerPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: [], failed: [] };
    return {
      removed: [],
      failed: [{ path: markerPath, error: error?.message || String(error) }],
    };
  }
  if (marker?.version !== 3 || marker?.state !== "committed") {
    return { removed: [], failed: [] };
  }
  const rawRollbackPaths = [
    marker.rollbackDir,
    ...(Array.isArray(marker.supersededRollbackDirs)
      ? marker.supersededRollbackDirs
      : []),
  ].filter((value) => typeof value === "string" && value.trim());
  const rollbackPaths = Array.from(
    new Set(rawRollbackPaths.map((value) => path.resolve(value))),
  );
  if (
    rollbackPaths.length === 0 ||
    rollbackPaths.some(
      (rollbackPath) =>
        !isPathInside(restoreDir, rollbackPath) ||
        !/^rollback-[a-f0-9-]{36}$/i.test(path.basename(rollbackPath)),
    )
  ) {
    return {
      removed: [],
      failed: [{ path: markerPath, error: "Invalid committed restore cleanup paths." }],
    };
  }
  const removed = [];
  try {
    for (const rollbackPath of rollbackPaths) {
      const existed = fs.existsSync(rollbackPath);
      await fs.promises.rm(rollbackPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      });
      if (existed) removed.push(rollbackPath);
    }
    await fs.promises.rm(markerPath, { force: true });
    return { removed, failed: [] };
  } catch (error) {
    return {
      removed,
      failed: [{ path: markerPath, error: error?.message || String(error) }],
    };
  }
}

function hasProfileRestoreRollbackDirectories(restoreDir) {
  try {
    return fs
      .readdirSync(restoreDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^rollback-/.test(entry.name));
  } catch {
    return false;
  }
}

function applyPendingProfileRestoreSync({ userDataDir }) {
  const restoreDir = path.join(userDataDir, PROFILE_RESTORE_DIR);
  const markerPath = path.join(restoreDir, PROFILE_RESTORE_MARKER);
  if (!fs.existsSync(markerPath)) return { applied: false };
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    return {
      applied: false,
      error: `Invalid restore marker: ${error.message}`,
      recoveryRequired: hasProfileRestoreRollbackDirectories(restoreDir),
    };
  }
  if (![2, 3].includes(Number(marker?.version)) || !marker?.stagingDir) {
    const error = new Error("This prepared profile restore is not supported.");
    if (hasProfileRestoreRollbackDirectories(restoreDir)) {
      error.recoveryRequired = true;
    }
    throw error;
  }
  const stagingDir = path.resolve(String(marker.stagingDir));
  if (!isPathInside(restoreDir, stagingDir)) {
    const error = new Error("Invalid prepared restore path.");
    if (
      ["applying", "rollingBack"].includes(marker.state) ||
      hasProfileRestoreRollbackDirectories(restoreDir)
    ) {
      error.recoveryRequired = true;
    }
    throw error;
  }
  const stagingExists =
    fs.existsSync(stagingDir) && fs.statSync(stagingDir).isDirectory();
  if (!stagingExists && marker.state !== "committed") {
    const error = new Error("The prepared profile restore is missing.");
    if (["applying", "rollingBack"].includes(marker.state)) {
      error.recoveryRequired = true;
    }
    throw error;
  }
  if (
    (Number(marker.version) === 2 || marker.state === "prepared") &&
    !fs.existsSync(path.join(stagingDir, "preferences.json"))
  ) {
    const error = new Error(
      "The staged restore is incomplete. The pending marker and rollback data were preserved.",
    );
    if (Number(marker.version) === 2) error.recoveryRequired = true;
    throw error;
  }
  if (Number(marker.version) === 2) {
    const entries = fs.readdirSync(restoreDir, { withFileTypes: true });
    if (
      entries.some(
        (entry) => entry.isDirectory() && /^rollback-/.test(entry.name),
      )
    ) {
      throw createProfileRestoreRecoveryError(
        "An older restore may have been interrupted. Its rollback data was preserved for recovery.",
      );
    }
    marker = {
      ...marker,
      version: 3,
      state: "prepared",
      transactionId: crypto.randomUUID(),
      stagedRoots: readStagedProfileRoots(stagingDir),
    };
    if (marker.stagedRoots.some((rootName) => !PROFILE_BACKUP_ALLOWED_ROOTS.has(rootName))) {
      throw new Error("The staged profile restore contains an unknown profile root.");
    }
    writeProfileRestoreMarker(markerPath, marker);
  }
  if (
    Number(marker.version) !== 3 ||
    !isValidProfileRestoreTransactionId(marker.transactionId) ||
    !["prepared", "applying", "rollingBack", "committed"].includes(marker.state)
  ) {
    const error = new Error("The prepared profile restore journal is invalid.");
    if (["applying", "rollingBack"].includes(marker.state)) {
      error.recoveryRequired = true;
    }
    throw error;
  }
  if (
    marker.state !== "prepared" &&
    (!marker.rollbackDir ||
      !isPathInside(restoreDir, marker.rollbackDir) ||
      !/^rollback-[a-f0-9-]{36}$/i.test(path.basename(marker.rollbackDir)))
  ) {
    const error = new Error("The prepared profile restore rollback path is invalid.");
    if (["applying", "rollingBack"].includes(marker.state)) {
      error.recoveryRequired = true;
    }
    throw error;
  }
  return applyStagedProfileRestoreSync({
    userDataDir,
    restoreDir,
    markerPath,
    marker,
  });
}

module.exports = {
  PROFILE_BACKUP_DIRECTORIES,
  PROFILE_BACKUP_FILES,
  PROFILE_BACKUP_FORMAT_VERSION,
  applyPendingProfileRestoreSync,
  cleanupProfileRestoreRollbacks,
  createProfileBackup,
  inspectProfileBackup,
  stageProfileRestore,
};
