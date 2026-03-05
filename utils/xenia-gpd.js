const fs = require("fs");
const path = require("path");

const XDBF_HEADER_SIZE = 0x18;
const ENTRY_SIZE = 0x12;
const FREE_ENTRY_SIZE = 0x08;
const ACHIEVEMENT_NAMESPACE = 1;
const STRING_NAMESPACE = 5;
const IMAGE_NAMESPACE = 2;
const TITLE_STRING_ID = 0x8000;
const ACHIEVEMENT_EARNED_FLAG = 0x20000;

const FILETIME_EPOCH_DIFF_MS = 11644473600000n; // 1601 -> 1970
const DOTNET_EPOCH_DIFF_MS = 62135596800000n; // 0001 -> 1970

function readUInt64LE(buf, offset) {
  const low = buf.readUInt32LE(offset);
  const high = buf.readUInt32LE(offset + 4);
  return (BigInt(high) << 32n) | BigInt(low);
}

function readUInt64BE(buf, offset) {
  const high = buf.readUInt32BE(offset);
  const low = buf.readUInt32BE(offset + 4);
  return (BigInt(high) << 32n) | BigInt(low);
}

function readInt64LE(buf, offset) {
  const value = buf.readBigInt64LE
    ? buf.readBigInt64LE(offset)
    : readUInt64LE(buf, offset);
  return value;
}

function readInt64BE(buf, offset) {
  if (buf.readBigInt64BE) {
    return buf.readBigInt64BE(offset);
  }
  const unsigned = readUInt64BE(buf, offset);
  return unsigned >= 0x8000000000000000n
    ? unsigned - 0x10000000000000000n
    : unsigned;
}

function decodeUtf16Be(buffer) {
  if (!buffer || buffer.length === 0) return "";
  const swapped = Buffer.from(buffer);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const tmp = swapped[i];
    swapped[i] = swapped[i + 1];
    swapped[i + 1] = tmp;
  }
  return swapped.toString("utf16le").replace(/\u0000+$/, "").trim();
}

function readUtf16BeNullTerminated(buffer, offset) {
  if (!buffer || offset >= buffer.length) {
    return { text: "", nextOffset: offset };
  }
  const bytes = [];
  let cursor = offset;
  while (cursor + 1 < buffer.length) {
    const code = buffer.readUInt16BE(cursor);
    cursor += 2;
    if (code === 0) break;
    bytes.push((code >> 8) & 0xff, code & 0xff);
  }
  const text = decodeUtf16Be(Buffer.from(bytes));
  return { text, nextOffset: cursor };
}

function normalizeUnlockTime(raw) {
  if (raw === null || raw === undefined) return 0;
  let value = typeof raw === "bigint" ? raw : BigInt(raw);
  if (value <= 0n) return 0;

  const filetimeMs = value / 10000n - FILETIME_EPOCH_DIFF_MS;
  if (filetimeMs > 946684800000n && filetimeMs < 4102444800000n) {
    return Number(filetimeMs);
  }

  const dotnetMs = value / 10000n - DOTNET_EPOCH_DIFF_MS;
  if (dotnetMs > 946684800000n && dotnetMs < 4102444800000n) {
    return Number(dotnetMs);
  }

  return Number(filetimeMs);
}

function parseHeader(buffer) {
  if (buffer.length < XDBF_HEADER_SIZE) return null;
  const magic = buffer.slice(0, 4).toString("ascii");
  if (magic !== "XDBF") return null;

  const be = {
    version: buffer.readUInt32BE(0x04),
    entryTableLength: buffer.readUInt32BE(0x08),
    entryCount: buffer.readUInt32BE(0x0c),
    freeTableLength: buffer.readUInt32BE(0x10),
    freeCount: buffer.readUInt32BE(0x14),
    endian: "be",
  };
  const le = {
    version: buffer.readUInt32LE(0x04),
    entryTableLength: buffer.readUInt32LE(0x08),
    entryCount: buffer.readUInt32LE(0x0c),
    freeTableLength: buffer.readUInt32LE(0x10),
    freeCount: buffer.readUInt32LE(0x14),
    endian: "le",
  };

  const beLooksValid =
    be.version >= 0x00010000 && be.version <= 0x00020000;
  const leLooksValid =
    le.version >= 0x00010000 && le.version <= 0x00020000;

  if (beLooksValid && !leLooksValid) return be;
  if (leLooksValid && !beLooksValid) return le;
  return beLooksValid ? be : le;
}

function resolveTableSizes(header, fileSize) {
  const entryCount = header.entryCount;
  const freeCount = header.freeCount;
  let entryEntries = header.entryTableLength;
  let freeEntries = header.freeTableLength;

  if (header.endian === "be") {
    let baseData =
      XDBF_HEADER_SIZE +
      entryEntries * ENTRY_SIZE +
      freeEntries * FREE_ENTRY_SIZE;
    if (baseData > fileSize || entryCount > entryEntries) {
      if (header.entryTableLength % ENTRY_SIZE === 0) {
        entryEntries = header.entryTableLength / ENTRY_SIZE;
      }
      if (header.freeTableLength % FREE_ENTRY_SIZE === 0) {
        freeEntries = header.freeTableLength / FREE_ENTRY_SIZE;
      }
    }
  } else {
    const entryTableIsBytes =
      header.entryTableLength % ENTRY_SIZE === 0 &&
      entryCount > 0 &&
      header.entryTableLength >= entryCount * ENTRY_SIZE;
    const freeTableIsBytes =
      header.freeTableLength % FREE_ENTRY_SIZE === 0 &&
      freeCount > 0 &&
      header.freeTableLength >= freeCount * FREE_ENTRY_SIZE;

    entryEntries = entryTableIsBytes
      ? header.entryTableLength / ENTRY_SIZE
      : header.entryTableLength;
    freeEntries = freeTableIsBytes
      ? header.freeTableLength / FREE_ENTRY_SIZE
      : header.freeTableLength;
  }

  const baseData =
    XDBF_HEADER_SIZE +
    entryEntries * ENTRY_SIZE +
    freeEntries * FREE_ENTRY_SIZE;

  return { entryEntries, freeEntries, baseData };
}

function parseXdbfEntries(buffer) {
  if (buffer.length < XDBF_HEADER_SIZE) return [];

  const header = parseHeader(buffer);
  if (!header) return [];
  const { entryEntries, baseData } = resolveTableSizes(header, buffer.length);
  const totalEntries =
    header.entryCount > 0 && header.entryCount <= entryEntries
      ? header.entryCount
      : entryEntries;

  const entries = [];
  const readU16 = header.endian === "be" ? "readUInt16BE" : "readUInt16LE";
  const readU32 = header.endian === "be" ? "readUInt32BE" : "readUInt32LE";
  for (let i = 0; i < totalEntries; i += 1) {
    const base = XDBF_HEADER_SIZE + i * ENTRY_SIZE;
    if (base + ENTRY_SIZE > buffer.length) break;
    const namespace = buffer[readU16](base);
    const id =
      header.endian === "be"
        ? readUInt64BE(buffer, base + 2)
        : readUInt64LE(buffer, base + 2);
    const offset = buffer[readU32](base + 10);
    const length = buffer[readU32](base + 14);
    if (!length) continue;
    const absoluteOffset = baseData + offset;
    if (absoluteOffset < 0 || absoluteOffset + length > buffer.length) {
      continue;
    }
    entries.push({
      namespace,
      id,
      offset: absoluteOffset,
      length,
    });
  }

  entries.__endian = header.endian;
  return entries;
}

function parseAchievementPayload(buffer, endian = "le") {
  if (!buffer || buffer.length < 0x1c) return null;
  const readU32 = endian === "be" ? "readUInt32BE" : "readUInt32LE";
  const readI32 = endian === "be" ? "readInt32BE" : "readInt32LE";
  const structSize = buffer[readU32](0x00);
  const startOffset = structSize >= 0x1c ? structSize : 0x1c;
  const achievementId = buffer[readU32](0x04);
  const imageId = buffer[readU32](0x08);
  const gamerscore = buffer[readI32](0x0c);
  const flags = buffer[readU32](0x10);
  const unlockRaw =
    endian === "be" ? readInt64BE(buffer, 0x14) : readInt64LE(buffer, 0x14);

  const nameRes = readUtf16BeNullTerminated(buffer, startOffset);
  const lockedRes = readUtf16BeNullTerminated(buffer, nameRes.nextOffset);
  const unlockedRes = readUtf16BeNullTerminated(
    buffer,
    lockedRes.nextOffset
  );

  return {
    achievementId,
    imageId,
    gamerscore,
    flags,
    unlockRaw,
    name: nameRes.text,
    lockedDescription: lockedRes.text,
    unlockedDescription: unlockedRes.text,
  };
}

function parseGpdFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const entries = parseXdbfEntries(raw);
  const endian = entries.__endian || "le";

  const entrySummary = {
    total: entries.length,
    byNamespace: {},
  };
  for (const entry of entries) {
    const key = String(entry.namespace);
    entrySummary.byNamespace[key] = (entrySummary.byNamespace[key] || 0) + 1;
  }

  const achievements = [];
  const imagesById = new Map();
  let title = "";

  for (const entry of entries) {
    const payload = raw.slice(entry.offset, entry.offset + entry.length);
    if (entry.namespace === ACHIEVEMENT_NAMESPACE) {
      const parsed = parseAchievementPayload(payload, endian);
      if (parsed) achievements.push(parsed);
      continue;
    }
    if (entry.namespace === IMAGE_NAMESPACE) {
      imagesById.set(String(entry.id), Buffer.from(payload));
      continue;
    }
    if (entry.namespace === STRING_NAMESPACE && Number(entry.id) === TITLE_STRING_ID) {
      title = decodeUtf16Be(payload);
    }
  }

  return {
    filePath,
    title: title || path.basename(filePath, path.extname(filePath)),
    achievements,
    imagesById,
    entrySummary,
  };
}

function normalizeAchievementText(value) {
  return String(value || "").trim();
}

function isPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function isValidAchievementPayloadForSchema(achievement) {
  if (!achievement || typeof achievement !== "object") return false;
  const name = normalizeAchievementText(achievement.name);
  const lockedDescription = normalizeAchievementText(
    achievement.lockedDescription
  );
  const unlockedDescription = normalizeAchievementText(
    achievement.unlockedDescription
  );
  if (!name || !lockedDescription || !unlockedDescription) return false;
  if (!isPositiveNumber(achievement.flags)) return false;
  if (!isPositiveNumber(achievement.imageId)) return false;
  if (!isPositiveNumber(achievement.achievementId)) return false;
  return true;
}

function scoreAchievementPayload(achievement) {
  const name = normalizeAchievementText(achievement?.name);
  const lockedDescription = normalizeAchievementText(
    achievement?.lockedDescription
  );
  const unlockedDescription = normalizeAchievementText(
    achievement?.unlockedDescription
  );
  const flags = Number(achievement?.flags || 0);
  const imageId = Number(achievement?.imageId || 0);
  return (
    name.length +
    lockedDescription.length +
    unlockedDescription.length +
    (flags > 0 ? 1000 : 0) +
    (imageId > 0 ? 1000 : 0) +
    ((flags & ACHIEVEMENT_EARNED_FLAG) !== 0 ? 10 : 0)
  );
}

function getValidAchievements(parsed) {
  const byId = new Map();
  for (const achievement of parsed?.achievements || []) {
    if (!isValidAchievementPayloadForSchema(achievement)) continue;
    const key = String(achievement.achievementId || "").trim();
    if (!key) continue;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, achievement);
      continue;
    }
    if (scoreAchievementPayload(achievement) > scoreAchievementPayload(existing)) {
      byId.set(key, achievement);
    }
  }
  return Array.from(byId.values());
}

function buildSnapshotFromGpd(parsed) {
  const out = {};
  for (const ach of getValidAchievements(parsed)) {
    const key = String(ach.achievementId);
    const earned = (ach.flags & ACHIEVEMENT_EARNED_FLAG) !== 0;
    out[key] = {
      earned,
      earned_time: earned ? normalizeUnlockTime(ach.unlockRaw) : 0,
    };
  }
  return out;
}

function buildSchemaFromGpd(parsed, options = {}) {
  const entries = [];
  const preferLocked = options.preferLocked === true;

  for (const ach of getValidAchievements(parsed)) {
    const name = String(ach.achievementId);
    const displayName = normalizeAchievementText(ach.name);
    const locked = (ach.lockedDescription || "").trim();
    const unlocked = (ach.unlockedDescription || locked || "").trim();
    const hidden = (ach.flags & 0x8) === 0 ? 1 : 0;
    const description =
      preferLocked && !hidden ? locked : unlocked || locked || "";

    entries.push({
      name,
      displayName: { english: displayName },
      description: { english: description },
      icon: "",
      icon_gray: "",
      hidden,
      gamerscore: ach.gamerscore,
      imageId: ach.imageId,
    });
  }

  return entries;
}

module.exports = {
  parseGpdFile,
  buildSnapshotFromGpd,
  buildSchemaFromGpd,
  normalizeUnlockTime,
  getValidAchievements,
  isValidAchievementPayloadForSchema,
};
