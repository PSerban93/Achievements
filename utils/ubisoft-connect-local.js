const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  RARITY_SOURCES,
  fetchSteamGlobalAchievementPercentages,
  buildRarityEntriesForSchema,
  writeAchievementPercentagesSidecar,
} = require("./achievement-rarity");
const { createLogger } = require("./logger");
const { normalizeProcessNameValue } = require("./process-name-utils");
const uplayMappingStore = require("./uplay-mapping-store");

let electronApp = null;
try {
  electronApp = require("electron").app;
} catch {}

const ubisoftLogger = createLogger("ubisoft-local");

const userDataDir = electronApp?.getPath?.("userData")
  ? electronApp.getPath("userData")
  : path.join(os.tmpdir(), "Achievements");
const runtimeUplaySteamMapPath = path.join(userDataDir, "uplay-steam.json");
const defaultUplaySteamMapPath = path.join(
  __dirname,
  "..",
  "assets",
  "uplay-steam.json",
);

const DEFAULT_UBISOFT_CONFIGURATIONS_PATH = process.env.LOCALAPPDATA
  ? path.join(
      process.env.LOCALAPPDATA,
      "Ubisoft Game Launcher",
      "cache",
      "configuration",
      "configurations",
    )
  : "";
const DEFAULT_UBISOFT_ACHIEVEMENTS_ROOT = process.env.ProgramData
  ? path.join(
      process.env.ProgramData,
      "Ubisoft",
      "Ubisoft Game Launcher",
      "cache",
      "achievements",
    )
  : "";

const UBISOFT_LOCALE_MAP = new Map([
  ["en-us", "english"],
  ["en-gb", "english"],
  ["ar-sa", "arabic"],
  ["bg-bg", "bulgarian"],
  ["zh-cn", "schinese"],
  ["zh-sg", "schinese"],
  ["zh-tw", "tchinese"],
  ["cs-cz", "czech"],
  ["da-dk", "danish"],
  ["nl-nl", "dutch"],
  ["fi-fi", "finnish"],
  ["fr-fr", "french"],
  ["de-de", "german"],
  ["el-gr", "greek"],
  ["hu-hu", "hungarian"],
  ["id-id", "indonesian"],
  ["it-it", "italian"],
  ["ja-jp", "japanese"],
  ["ko-kr", "koreana"],
  ["ko-ko", "koreana"],
  ["ko", "koreana"],
  ["nb-no", "norwegian"],
  ["no-no", "norwegian"],
  ["pl-pl", "polish"],
  ["pt-pt", "portuguese"],
  ["pt-br", "brazilian"],
  ["ro-ro", "romanian"],
  ["ru-ru", "russian"],
  ["es-es", "spanish"],
  ["es-mx", "latam"],
  ["es-419", "latam"],
  ["sv-se", "swedish"],
  ["th-th", "thai"],
  ["tr-tr", "turkish"],
  ["uk-ua", "ukrainian"],
  ["vi-vn", "vietnamese"],
]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizePathForCompare(inputPath) {
  if (!inputPath) return "";
  try {
    return path.normalize(String(inputPath)).toLowerCase();
  } catch {
    return "";
  }
}

function normalizeAchievementsSpec(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/[\\/]+/g, "/");
  if (!raw) return "";
  let base = path.posix.basename(raw).toLowerCase();
  if (base.endsWith(".zip")) base = base.slice(0, -4);
  const prefixed = base.match(/^\d+_(.+)$/);
  return prefixed ? prefixed[1] : base;
}

function normalizeQuotedText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/^"+|"+$/g, "").trim();
}

function extractRelativeExecutableNames(block) {
  const candidates = [];
  const seen = new Set();
  const relativeRe = /^\s*relative:\s*([^\r\n]+)/gim;
  let match = null;
  while ((match = relativeRe.exec(String(block || "")))) {
    const raw = normalizeQuotedText(match[1] || "");
    if (!/\.exe$/i.test(raw)) continue;
    const name = path.basename(raw.replace(/\//g, "\\"));
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(name);
  }
  return candidates;
}

function scoreUbisoftProcessCandidate(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower.endsWith(".exe")) return -100;
  let score = 100;
  if (/(updater|update|patch|launcher|setup|install|unins|uninstall)/i.test(lower)) {
    score -= 80;
  }
  if (/(editor|benchmark|settings|config|crash|reporter|support|server)/i.test(lower)) {
    score -= 45;
  }
  if (/(shipping|game|win64|x64|dx11|dx12)/i.test(lower)) {
    score += 15;
  }
  return score;
}

function extractUbisoftProcessName(block) {
  const candidates = extractRelativeExecutableNames(block);
  if (!candidates.length) return "";
  const ranked = candidates
    .map((name, index) => ({
      name,
      index,
      score: scoreUbisoftProcessCandidate(name),
    }))
    .filter((entry) => entry.score >= 70)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (!ranked.length) return "";
  return normalizeProcessNameValue(ranked.map((entry) => entry.name));
}

uplayMappingStore.configure({
  runtimePath: runtimeUplaySteamMapPath,
  assetPath: defaultUplaySteamMapPath,
});
uplayMappingStore.reloadSnapshot({ preserveLastValid: true });
const uplayToSteam = uplayMappingStore.getMap();

function resolveUbisoftSteamMapping(appid) {
  const key = String(appid || "").trim();
  return key ? uplayToSteam.get(key) || null : null;
}

function resolveUbisoftSteamAppId(appid) {
  const entry = resolveUbisoftSteamMapping(appid);
  return entry?.steam_appid != null ? String(entry.steam_appid).trim() : "";
}

function normalizeEpochMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function stripAchievementPrefix(name) {
  if (typeof name !== "string") return name;
  const match = name.match(/Ach_(.+)$/i);
  if (match && match[1]) return match[1];
  return name;
}

function normalizeAchievementName(name, shouldStrip = false) {
  if (typeof name !== "string") return name;
  let result = name.trim();
  if (shouldStrip) {
    result = stripAchievementPrefix(result);
    const match = result.match(/^(.*)_(\d+)$/);
    if (match && match[1] && /[A-Za-z]/.test(match[1])) {
      result = match[2];
    }
  }
  return result;
}

function readVarint(buffer, offset, end = buffer.length) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < end) {
    const byte = buffer[cursor];
    value += (byte & 0x7f) * 2 ** shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: cursor };
    }
    shift += 7;
    if (shift > 49) {
      throw new Error("ubisoft-official:varint-too-large");
    }
  }
  throw new Error("ubisoft-official:truncated-varint");
}

function skipProtoField(buffer, offset, wireType, end = buffer.length) {
  if (wireType === 0) {
    return readVarint(buffer, offset, end).nextOffset;
  }
  if (wireType === 1) {
    return offset + 8;
  }
  if (wireType === 2) {
    const lenInfo = readVarint(buffer, offset, end);
    return lenInfo.nextOffset + lenInfo.value;
  }
  if (wireType === 5) {
    return offset + 4;
  }
  throw new Error(`ubisoft-official:unsupported-wire-type:${wireType}`);
}

function findFirstProtoVarint(buffer, targetField, start = 0, end = buffer.length, depth = 0) {
  let offset = start;
  while (offset < end) {
    const tagInfo = readVarint(buffer, offset, end);
    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x07;
    offset = tagInfo.nextOffset;
    if (wireType === 0) {
      const valueInfo = readVarint(buffer, offset, end);
      if (fieldNumber === targetField) {
        return valueInfo.value;
      }
      offset = valueInfo.nextOffset;
      continue;
    }
    if (wireType === 2) {
      const lenInfo = readVarint(buffer, offset, end);
      const payloadStart = lenInfo.nextOffset;
      const payloadEnd = payloadStart + lenInfo.value;
      if (depth < 4) {
        const nested = findFirstProtoVarint(
          buffer,
          targetField,
          payloadStart,
          payloadEnd,
          depth + 1,
        );
        if (nested != null) return nested;
      }
      offset = payloadEnd;
      continue;
    }
    offset = skipProtoField(buffer, offset, wireType, end);
  }
  return null;
}

function readUbisoftSpoolFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const records = [];
  const seen = new Set();
  let offset = 0;
  while (offset < buffer.length) {
    const tagInfo = readVarint(buffer, offset, buffer.length);
    const fieldNumber = tagInfo.value >> 3;
    const wireType = tagInfo.value & 0x07;
    offset = tagInfo.nextOffset;
    if (fieldNumber === 1 && wireType === 2) {
      const lenInfo = readVarint(buffer, offset, buffer.length);
      const payloadStart = lenInfo.nextOffset;
      const payloadEnd = payloadStart + lenInfo.value;
      const achievementId = findFirstProtoVarint(
        buffer,
        1,
        payloadStart,
        payloadEnd,
      );
      const earnedTime = findFirstProtoVarint(
        buffer,
        2,
        payloadStart,
        payloadEnd,
      );
      if (
        Number.isFinite(Number(achievementId)) &&
        Number.isFinite(Number(earnedTime)) &&
        Number(achievementId) > 0 &&
        Number(earnedTime) > 0
      ) {
        const record = {
          achievementId: Number(achievementId),
          earned_time: normalizeEpochMs(earnedTime),
        };
        const dedupeKey = `${record.achievementId}:${record.earned_time}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          records.push(record);
        }
      }
      offset = payloadEnd;
      continue;
    }
    offset = skipProtoField(buffer, offset, wireType, buffer.length);
  }
  records.sort((a, b) => a.earned_time - b.earned_time);
  return {
    appid: path.basename(filePath, path.extname(filePath)),
    filePath,
    records,
  };
}

function buildUbisoftOfficialSnapshot(records) {
  const snapshot = {};
  const bestById = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = String(record?.achievementId || "").trim();
    const earnedTime = normalizeEpochMs(record?.earned_time || 0);
    if (!key || !earnedTime) continue;
    const previous = bestById.get(key);
    if (!previous || earnedTime < previous.earned_time) {
      bestById.set(key, {
        earned: true,
        earned_time: earnedTime,
      });
    }
  }
  for (const [key, value] of bestById.entries()) {
    snapshot[key] = value;
  }
  return snapshot;
}

function resolveUbisoftSpoolRoots(rootPath) {
  const out = [];
  const seen = new Set();
  const push = (candidate) => {
    if (!candidate) return;
    let resolved = "";
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      try {
        resolved = path.resolve(String(candidate));
      } catch {
        resolved = "";
      }
    }
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return;
      }
    } catch {
      return;
    }
    seen.add(key);
    out.push(resolved);
  };

  if (!rootPath) return out;

  let cursor = "";
  try {
    cursor = fs.realpathSync(rootPath);
  } catch {
    try {
      cursor = path.resolve(String(rootPath));
    } catch {
      cursor = "";
    }
  }

  while (cursor) {
    const base = path.basename(cursor).toLowerCase();
    const parent = path.dirname(cursor);
    const parentBase = path.basename(parent).toLowerCase();
    const grandParent = path.dirname(parent);
    const grandParentBase = path.basename(grandParent).toLowerCase();

    if (base === "spool" && parentBase === "ubisoft game launcher") {
      push(cursor);
    }
    if (
      parentBase === "spool" &&
      grandParentBase === "ubisoft game launcher"
    ) {
      push(parent);
    }

    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  return out;
}

function listUbisoftOfficialSpoolEntries(rootPath, options = {}) {
  const roots = Array.isArray(rootPath)
    ? rootPath
    : resolveUbisoftSpoolRoots(rootPath || options?.spoolRoot || "");
  const seen = new Set();
  const out = [];

  for (const spoolRoot of roots) {
    let userEntries = [];
    try {
      userEntries = fs.readdirSync(spoolRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const userEntry of userEntries) {
      if (!userEntry.isDirectory()) continue;
      const userId = String(userEntry.name || "").trim();
      if (!userId) continue;
      const userDir = path.join(spoolRoot, userId);
      let files = [];
      try {
        files = fs.readdirSync(userDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const fileEntry of files) {
        if (!fileEntry.isFile()) continue;
        const match = String(fileEntry.name || "").match(/^(\d+)\.spool$/i);
        if (!match) continue;
        const appid = match[1];
        const spoolFilePath = path.join(userDir, fileEntry.name);
        const key = `${userId}:${appid}:${normalizePathForCompare(spoolFilePath)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          appid,
          userId,
          spoolDir: userDir,
          spoolFilePath,
          spoolRoot,
        });
      }
    }
  }

  out.sort((a, b) => {
    const appCmp = String(a.appid).localeCompare(String(b.appid), undefined, {
      numeric: true,
    });
    if (appCmp !== 0) return appCmp;
    return String(a.userId).localeCompare(String(b.userId));
  });
  return out;
}

function resolveUbisoftOfficialSpoolEntryForAppId(appid, options = {}) {
  const target = String(appid || "").trim();
  if (!target) return null;
  const preferredUserId = String(options?.userId || options?.ubisoftUserId || "").trim();
  const explicitFile = String(
    options?.spoolFilePath || options?.ubisoftSpoolFile || "",
  ).trim();
  if (explicitFile && fs.existsSync(explicitFile)) {
    const userDir = path.dirname(explicitFile);
    return {
      appid: target,
      userId: path.basename(userDir),
      spoolDir: userDir,
      spoolFilePath: explicitFile,
      spoolRoot: path.dirname(userDir),
    };
  }

  const roots = resolveUbisoftSpoolRoots(
    options?.spoolRoot || options?.savePath || "",
  );
  const entries = listUbisoftOfficialSpoolEntries(roots);
  const matches = entries.filter((entry) => entry.appid === target);
  if (!matches.length) return null;
  if (preferredUserId) {
    const preferred = matches.find((entry) => entry.userId === preferredUserId);
    if (preferred) return preferred;
  }
  return matches[0];
}

function resolveUbisoftOfficialSpoolFileForConfig(config = {}, options = {}) {
  const appid = String(config?.appid || "").trim();
  if (!appid) return null;

  const explicitFile = String(
    config?.ubisoft_spool_file || config?.ubisoftSpoolFile || "",
  ).trim();
  if (explicitFile && fs.existsSync(explicitFile)) {
    const spoolDir = path.dirname(explicitFile);
    return {
      appid,
      userId: path.basename(spoolDir),
      spoolDir,
      spoolFilePath: explicitFile,
      spoolRoot: path.dirname(spoolDir),
    };
  }

  const savePath = String(config?.save_path || options?.savePath || "").trim();
  if (savePath) {
    const directSpoolFile = path.join(savePath, `${appid}.spool`);
    if (fs.existsSync(directSpoolFile)) {
      return {
        appid,
        userId: path.basename(savePath),
        spoolDir: savePath,
        spoolFilePath: directSpoolFile,
        spoolRoot: path.dirname(savePath),
      };
    }
  }

  return resolveUbisoftOfficialSpoolEntryForAppId(appid, {
    userId:
      config?.ubisoft_user_id ||
      config?.ubisoftUserId ||
      options?.userId ||
      options?.ubisoftUserId,
    spoolRoot: options?.spoolRoot || savePath || "",
  });
}

let cachedConfigurationsIndex = {
  path: "",
  mtimeMs: 0,
  blocks: [],
};

function readUbisoftConfigurationsIndex(configurationsPath = DEFAULT_UBISOFT_CONFIGURATIONS_PATH) {
  const filePath = String(configurationsPath || "").trim();
  if (!filePath || !fs.existsSync(filePath)) return [];
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (
    cachedConfigurationsIndex.path === filePath &&
    cachedConfigurationsIndex.mtimeMs === Number(stat.mtimeMs || 0)
  ) {
    return cachedConfigurationsIndex.blocks;
  }

  let text = "";
  try {
    text = fs.readFileSync(filePath).toString("latin1").replace(/\0/g, "");
  } catch {
    return [];
  }

  const blockRegex = /version:\s*[^\r\n]+\r?\nroot:\s*[\s\S]*?(?=(?:version:\s*[^\r\n]+\r?\nroot:)|$)/g;
  const blocks = [];
  let match = null;
  while ((match = blockRegex.exec(text))) {
    const block = String(match[0] || "");
    const achievementsSpec = normalizeQuotedText(
      block.match(/^\s*achievements:\s*([^\r\n]+)/m)?.[1] || "",
    );
    if (!achievementsSpec) continue;
    const gameCode = normalizeQuotedText(
      block.match(/^\s*game_code:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const achievementsSyncId = normalizeQuotedText(
      block.match(/^\s*achievements_sync_id:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const gameIdentifier = normalizeQuotedText(
      block.match(/^\s*game_identifier:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const displayName = normalizeQuotedText(
      block.match(/^\s*display_name:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const rootName = normalizeQuotedText(
      block.match(/root:\s*[\s\S]*?\n\s+name:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const spaceId = normalizeQuotedText(
      block.match(/^\s*space_id:\s*([^\r\n]+)/m)?.[1] || "",
    );
    const processName = extractUbisoftProcessName(block);
    blocks.push({
      achievementsSpec,
      normalizedAchievementsSpec: normalizeAchievementsSpec(achievementsSpec),
      gameCode,
      achievementsSyncId,
      gameIdentifier,
      displayName,
      rootName,
      title: gameIdentifier || displayName || rootName || "",
      spaceId,
      processName,
    });
  }

  cachedConfigurationsIndex = {
    path: filePath,
    mtimeMs: Number(stat.mtimeMs || 0),
    blocks,
  };
  return blocks;
}

function resolveUbisoftAchievementsArchiveForAppId(appid, options = {}) {
  const safeAppId = String(appid || "").trim();
  if (!/^\d+$/.test(safeAppId)) {
    throw new Error("ubisoft-official:invalid-appid");
  }

  const achievementsRoot =
    String(options?.achievementsRoot || DEFAULT_UBISOFT_ACHIEVEMENTS_ROOT).trim();
  if (!achievementsRoot || !fs.existsSync(achievementsRoot)) {
    throw new Error("ubisoft-official:achievements-cache-missing");
  }

  const prefix = `${safeAppId}_`;
  let candidateFiles = [];
  try {
    candidateFiles = fs
      .readdirSync(achievementsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => path.join(achievementsRoot, entry.name));
  } catch {
    candidateFiles = [];
  }
  if (!candidateFiles.length) {
    throw new Error("ubisoft-official:archive-missing");
  }

  const blocks = readUbisoftConfigurationsIndex(
    options?.configurationsPath || DEFAULT_UBISOFT_CONFIGURATIONS_PATH,
  );

  let best = null;
  for (const filePath of candidateFiles) {
    const fileName = path.basename(filePath);
    const normalizedSpec = normalizeAchievementsSpec(fileName.slice(prefix.length));
    const metadata =
      blocks.find((block) => block.normalizedAchievementsSpec === normalizedSpec) ||
      null;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {}
    const score = metadata ? 2 : 1;
    const mtimeMs = Number(stat?.mtimeMs || 0);
    if (!best || score > best.score || (score === best.score && mtimeMs > best.mtimeMs)) {
      best = {
        appid: safeAppId,
        archivePath: filePath,
        archiveName: fileName,
        metadata,
        score,
        mtimeMs,
      };
    }
  }

  if (!best) {
    throw new Error("ubisoft-official:archive-missing");
  }

  return {
    appid: safeAppId,
    archivePath: best.archivePath,
    archiveName: best.archiveName,
    achievementsSpec:
      best.metadata?.achievementsSpec ||
      path.basename(best.archiveName).slice(prefix.length),
    title: best.metadata?.title || "",
    gameIdentifier: best.metadata?.gameIdentifier || "",
    displayName: best.metadata?.displayName || "",
    rootName: best.metadata?.rootName || "",
    gameCode: best.metadata?.gameCode || "",
    achievementsSyncId: best.metadata?.achievementsSyncId || "",
    spaceId: best.metadata?.spaceId || "",
    processName: best.metadata?.processName || "",
  };
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("ubisoft-official:zip-eocd-not-found");
}

function readZipEntries(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  const eocdOffset = findZipEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralEnd = centralDirectoryOffset + centralDirectorySize;
  const entries = new Map();
  let offset = centralDirectoryOffset;

  while (offset < centralEnd) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ubisoft-official:zip-central-entry-invalid");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.toString("utf8", fileNameStart, fileNameEnd);
    entries.set(fileName, {
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset =
      fileNameEnd +
      extraFieldLength +
      fileCommentLength;
  }

  const readEntry = (entryName) => {
    const entry = entries.get(entryName);
    if (!entry) return null;
    const localOffset = entry.localHeaderOffset;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("ubisoft-official:zip-local-entry-invalid");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const compressed = buffer.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return Buffer.from(compressed);
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(compressed);
    }
    throw new Error(
      `ubisoft-official:zip-compression-unsupported:${entry.compressionMethod}`,
    );
  };

  return { entries, readEntry };
}

function mapUbisoftLocaleKey(rawLocale) {
  const normalized = String(rawLocale || "")
    .trim()
    .toLowerCase();
  if (!normalized) return "";
  if (UBISOFT_LOCALE_MAP.has(normalized)) {
    return UBISOFT_LOCALE_MAP.get(normalized);
  }
  const compact = normalized.replace(/[^a-z]/g, "");
  if (!compact) return "";
  if (compact === "koko" || compact === "korean" || compact === "ko") {
    return "koreana";
  }
  return compact;
}

function parseUbisoftLocalizationText(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const out = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const rawId = String(parts[0] || "").trim();
    if (!/^\d+$/.test(rawId)) continue;
    const id = rawId.replace(/^0+(?=\d)/, "");
    const name = String(parts[1] || "").trim();
    const description = parts.slice(2).join("\t").trim();
    out.set(id, {
      displayName: name,
      description,
    });
  }
  return out;
}

function collectUbisoftSchemaData(archivePath) {
  const zip = readZipEntries(archivePath);
  const localizations = new Map();
  const imageBuffers = new Map();

  for (const entryName of zip.entries.keys()) {
    const lower = entryName.toLowerCase();
    const locMatch = lower.match(/^([a-z]{2}(?:-[a-z]{2,4})?)_loc\.txt$/i);
    if (locMatch) {
      const localeKey = mapUbisoftLocaleKey(locMatch[1]);
      if (!localeKey) continue;
      localizations.set(localeKey, parseUbisoftLocalizationText(zip.readEntry(entryName)));
      continue;
    }
    const pngMatch = lower.match(/^(\d+)\.png$/);
    if (pngMatch) {
      imageBuffers.set(String(Number(pngMatch[1])), zip.readEntry(entryName));
    }
  }

  const localizedIds = new Set();
  for (const map of localizations.values()) {
    for (const id of map.keys()) localizedIds.add(id);
  }
  const allIds = localizedIds.size ? localizedIds : new Set(imageBuffers.keys());

  const achievements = [];
  const sortedIds = Array.from(allIds).sort((a, b) => Number(a) - Number(b));
  for (const id of sortedIds) {
    const displayName = {};
    const description = {};
    for (const [localeKey, map] of localizations.entries()) {
      const entry = map.get(id);
      if (!entry) continue;
      if (entry.displayName) displayName[localeKey] = entry.displayName;
      if (entry.description) description[localeKey] = entry.description;
    }
    achievements.push({
      name: String(id),
      hidden: 0,
      displayName,
      description,
      hasIcon: imageBuffers.has(id),
    });
  }

  return {
    achievements,
    imageBuffers,
    localeCount: localizations.size,
  };
}

async function writeUbisoftOfficialAchievementPercentages(schemaDir, appid, schemaEntries, options = {}) {
  const steamAppId = String(
    options?.steamAppId || resolveUbisoftSteamAppId(appid) || "",
  ).trim();
  if (!/^\d+$/.test(steamAppId)) {
    return {
      written: false,
      fetched: 0,
      matched: 0,
      steamAppId: "",
    };
  }
  try {
    const fetchedMap = await fetchSteamGlobalAchievementPercentages(steamAppId, {
      timeoutMs: 15000,
    });
    const achievements = buildRarityEntriesForSchema(fetchedMap, schemaEntries, {
      normalizeName: (name) => normalizeAchievementName(String(name || ""), true),
    });
    writeAchievementPercentagesSidecar(schemaDir, steamAppId, achievements, {
      source: RARITY_SOURCES.steamGlobal,
    });
    return {
      written: true,
      fetched: fetchedMap.size,
      matched: achievements.length,
      steamAppId,
    };
  } catch (err) {
    ubisoftLogger.warn("ubisoft-official:rarity-fetch-failed", {
      appid: String(appid || ""),
      steamAppId,
      error: err?.message || String(err),
    });
    return {
      written: false,
      fetched: 0,
      matched: 0,
      steamAppId,
    };
  }
}

async function ensureUbisoftOfficialSchema(appid, schemaDir, options = {}) {
  const safeAppId = String(appid || "").trim();
  if (!/^\d+$/.test(safeAppId)) {
    throw new Error("ubisoft-official:invalid-appid");
  }
  if (!schemaDir || typeof schemaDir !== "string") {
    throw new Error("ubisoft-official:invalid-schema-dir");
  }

  const archiveInfo = options?.archivePath
    ? {
        appid: safeAppId,
        archivePath: options.archivePath,
        archiveName: path.basename(options.archivePath),
        achievementsSpec: options?.achievementsSpec || "",
        title: options?.title || "",
        gameIdentifier: options?.gameIdentifier || "",
        displayName: options?.displayName || "",
        rootName: options?.rootName || "",
        gameCode: options?.gameCode || "",
        achievementsSyncId: options?.achievementsSyncId || "",
        spaceId: options?.spaceId || "",
      }
    : resolveUbisoftAchievementsArchiveForAppId(safeAppId, options);

  const collected = collectUbisoftSchemaData(archiveInfo.archivePath);
  const rows = [];
  const imgDir = path.join(schemaDir, "img");
  ensureDir(imgDir);

  for (const entry of collected.achievements) {
    const iconRel = entry.hasIcon ? `img/${entry.name}.png` : "";
    if (entry.hasIcon) {
      fs.writeFileSync(
        path.join(imgDir, `${entry.name}.png`),
        collected.imageBuffers.get(entry.name),
      );
    }
    rows.push({
      hidden: Number(entry.hidden || 0),
      displayName: entry.displayName || {},
      description: entry.description || {},
      icon: iconRel,
      icon_gray: iconRel,
      name: entry.name,
    });
  }

  if (!rows.length) {
    throw new Error("ubisoft-official:schema-empty");
  }

  ensureDir(schemaDir);
  fs.writeFileSync(
    path.join(schemaDir, "achievements.json"),
    JSON.stringify(rows, null, 2),
    "utf8",
  );

  const rarity = await writeUbisoftOfficialAchievementPercentages(
    schemaDir,
    safeAppId,
    rows,
    {
      steamAppId: options?.steamAppId,
    },
  );

  ubisoftLogger.info("ubisoft-official:schema-written", {
    appid: safeAppId,
    schemaDir,
    archivePath: archiveInfo.archivePath,
    achievements: rows.length,
    locales: collected.localeCount,
    steamAppId: rarity.steamAppId || null,
  });

  return {
    dir: schemaDir,
    count: rows.length,
    archivePath: archiveInfo.archivePath,
    title:
      archiveInfo.title ||
      archiveInfo.gameIdentifier ||
      archiveInfo.displayName ||
      archiveInfo.rootName ||
      "",
    gameCode: archiveInfo.gameCode || "",
    spaceId: archiveInfo.spaceId || "",
    steamAppId: rarity.steamAppId || "",
  };
}

module.exports = {
  DEFAULT_UBISOFT_ACHIEVEMENTS_ROOT,
  DEFAULT_UBISOFT_CONFIGURATIONS_PATH,
  buildUbisoftOfficialSnapshot,
  ensureUbisoftOfficialSchema,
  listUbisoftOfficialSpoolEntries,
  readUbisoftConfigurationsIndex,
  readUbisoftSpoolFile,
  resolveUbisoftAchievementsArchiveForAppId,
  resolveUbisoftOfficialSpoolEntryForAppId,
  resolveUbisoftOfficialSpoolFileForConfig,
  resolveUbisoftSpoolRoots,
  resolveUbisoftSteamAppId,
  resolveUbisoftSteamMapping,
};
