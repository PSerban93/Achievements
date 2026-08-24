"use strict";

const fs = require("fs");

const XDBF_MAGIC = "XDBF";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const XLLN_LANGUAGE_BY_ID = Object.freeze({
  1: "english",
  2: "japanese",
  3: "german",
  4: "french",
  5: "spanish",
  6: "italian",
  7: "koreana",
  8: "tchinese",
  9: "portuguese",
  10: "schinese",
  11: "polish",
  12: "russian",
});

function assertRange(buffer, offset, length, label) {
  if (
    !Buffer.isBuffer(buffer) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`Invalid ${label || "buffer"} range`);
  }
}

function readU16BE(buffer, offset, label) {
  assertRange(buffer, offset, 2, label);
  return buffer.readUInt16BE(offset);
}

function readU32BE(buffer, offset, label) {
  assertRange(buffer, offset, 4, label);
  return buffer.readUInt32BE(offset);
}

function readU64BE(buffer, offset, label) {
  assertRange(buffer, offset, 8, label);
  return buffer.readBigUInt64BE(offset);
}

function readU16LE(buffer, offset, label) {
  assertRange(buffer, offset, 2, label);
  return buffer.readUInt16LE(offset);
}

function readU32LE(buffer, offset, label) {
  assertRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function normalizeResourceName(value) {
  return String(value || "").replace(/^#/, "").trim().toUpperCase();
}

function parsePeSections(buffer, peOffset, optionalSize, sectionCount) {
  if (!Number.isInteger(sectionCount) || sectionCount <= 0 || sectionCount > 96) {
    throw new Error("PE section count is invalid");
  }
  const sectionTableOffset = peOffset + 24 + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    assertRange(buffer, offset, 40, "PE section");
    sections.push({
      virtualSize: readU32LE(buffer, offset + 8, "PE virtual size"),
      virtualAddress: readU32LE(buffer, offset + 12, "PE virtual address"),
      rawSize: readU32LE(buffer, offset + 16, "PE raw size"),
      rawOffset: readU32LE(buffer, offset + 20, "PE raw offset"),
    });
  }
  return sections;
}

function rvaToOffset(rva, sections, bufferLength) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + span) {
      continue;
    }
    const offset = section.rawOffset + (rva - section.virtualAddress);
    if (offset >= 0 && offset < bufferLength) return offset;
  }
  if (rva >= 0 && rva < bufferLength) return rva;
  throw new Error("PE resource RVA is outside the image");
}

function readResourceString(buffer, resourceBase, value) {
  const offset = resourceBase + (value & 0x7fffffff);
  const length = readU16LE(buffer, offset, "PE resource string length");
  assertRange(buffer, offset + 2, length * 2, "PE resource string");
  return buffer.subarray(offset + 2, offset + 2 + length * 2).toString("utf16le");
}

function readResourceDirectoryEntries(buffer, resourceBase, directoryOffset) {
  const offset = resourceBase + directoryOffset;
  assertRange(buffer, offset, 16, "PE resource directory");
  const namedCount = readU16LE(buffer, offset + 12, "PE named resource count");
  const idCount = readU16LE(buffer, offset + 14, "PE id resource count");
  const count = namedCount + idCount;
  if (count > 0x4000) throw new Error("PE resource directory is implausibly large");
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset + 16 + index * 8;
    assertRange(buffer, entryOffset, 8, "PE resource entry");
    const nameValue = readU32LE(buffer, entryOffset, "PE resource name");
    const dataValue = readU32LE(buffer, entryOffset + 4, "PE resource data");
    entries.push({
      id: nameValue & 0xffff,
      name:
        (nameValue & 0x80000000) !== 0
          ? readResourceString(buffer, resourceBase, nameValue)
          : "",
      isDirectory: (dataValue & 0x80000000) !== 0,
      childOffset: dataValue & 0x7fffffff,
    });
  }
  return entries;
}

function extractSpaFileFromPeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x100) {
    throw new Error("Executable is too small to contain a SPAFILE resource");
  }
  if (buffer.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error("Not a PE executable");
  }
  const peOffset = readU32LE(buffer, 0x3c, "PE header offset");
  assertRange(buffer, peOffset, 24, "PE header");
  if (buffer.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\0\0") {
    throw new Error("Invalid PE signature");
  }
  const sectionCount = readU16LE(buffer, peOffset + 6, "PE section count");
  const optionalSize = readU16LE(buffer, peOffset + 20, "PE optional size");
  const optionalOffset = peOffset + 24;
  assertRange(buffer, optionalOffset, optionalSize, "PE optional header");
  const optionalMagic = readU16LE(buffer, optionalOffset, "PE optional magic");
  const dataDirectoryOffset =
    optionalMagic === 0x10b
      ? optionalOffset + 96
      : optionalMagic === 0x20b
        ? optionalOffset + 112
        : 0;
  if (!dataDirectoryOffset) throw new Error("Unsupported PE optional header");
  assertRange(buffer, dataDirectoryOffset + 16, 8, "PE resource directory entry");
  const resourceRva = readU32LE(
    buffer,
    dataDirectoryOffset + 16,
    "PE resource RVA",
  );
  const resourceSize = readU32LE(
    buffer,
    dataDirectoryOffset + 20,
    "PE resource size",
  );
  if (!resourceRva || !resourceSize) throw new Error("PE has no resources");
  const sections = parsePeSections(buffer, peOffset, optionalSize, sectionCount);
  const resourceBase = rvaToOffset(resourceRva, sections, buffer.length);
  assertRange(buffer, resourceBase, Math.min(resourceSize, 16), "PE resources");

  const typeEntries = readResourceDirectoryEntries(buffer, resourceBase, 0);
  const rcData = typeEntries.find(
    (entry) =>
      entry.isDirectory &&
      (entry.id === 10 || normalizeResourceName(entry.name) === "RT_RCDATA"),
  );
  if (!rcData) throw new Error("RT_RCDATA resource directory not found");
  const nameEntries = readResourceDirectoryEntries(
    buffer,
    resourceBase,
    rcData.childOffset,
  );
  const spaEntry = nameEntries.find(
    (entry) =>
      entry.isDirectory && normalizeResourceName(entry.name) === "SPAFILE",
  );
  if (!spaEntry) throw new Error("SPAFILE resource not found");
  const languageEntries = readResourceDirectoryEntries(
    buffer,
    resourceBase,
    spaEntry.childOffset,
  );
  const languageEntry = languageEntries.find((entry) => !entry.isDirectory);
  if (!languageEntry) throw new Error("SPAFILE language resource not found");
  const dataEntryOffset = resourceBase + languageEntry.childOffset;
  assertRange(buffer, dataEntryOffset, 16, "PE resource data entry");
  const dataRva = readU32LE(buffer, dataEntryOffset, "SPAFILE data RVA");
  const dataSize = readU32LE(buffer, dataEntryOffset + 4, "SPAFILE data size");
  if (!dataSize || dataSize > 64 * 1024 * 1024) {
    throw new Error("SPAFILE resource has an invalid size");
  }
  const dataOffset = rvaToOffset(dataRva, sections, buffer.length);
  assertRange(buffer, dataOffset, dataSize, "SPAFILE data");
  const result = Buffer.from(buffer.subarray(dataOffset, dataOffset + dataSize));
  if (result.subarray(0, 4).toString("ascii") !== XDBF_MAGIC) {
    throw new Error("SPAFILE resource is not an XDBF file");
  }
  return result;
}

function extractSpaFile(executableOrBuffer) {
  const buffer = Buffer.isBuffer(executableOrBuffer)
    ? executableOrBuffer
    : fs.readFileSync(String(executableOrBuffer || ""));
  if (buffer.subarray(0, 4).toString("ascii") === XDBF_MAGIC) {
    return Buffer.from(buffer);
  }
  return extractSpaFileFromPeBuffer(buffer);
}

function parseXdbf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw new Error("XDBF buffer is too small");
  }
  if (buffer.subarray(0, 4).toString("ascii") !== XDBF_MAGIC) {
    throw new Error("Invalid XDBF magic");
  }
  const version = readU32BE(buffer, 4, "XDBF version");
  const entryTableLength = readU32BE(buffer, 8, "XDBF entry table length");
  const entryCount = readU32BE(buffer, 12, "XDBF entry count");
  const freeTableLength = readU32BE(buffer, 16, "XDBF free table length");
  const freeCount = readU32BE(buffer, 20, "XDBF free count");
  if (
    entryCount > entryTableLength ||
    freeCount > freeTableLength ||
    entryTableLength > 65_536 ||
    freeTableLength > 65_536
  ) {
    throw new Error("Invalid XDBF table counts");
  }
  const dataOffset = 24 + entryTableLength * 18 + freeTableLength * 8;
  if (!Number.isSafeInteger(dataOffset) || dataOffset > buffer.length) {
    throw new Error("XDBF data area is outside the file");
  }
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = 24 + index * 18;
    const namespace = readU16BE(buffer, offset, "XDBF namespace");
    const id = readU64BE(buffer, offset + 2, "XDBF id");
    const relativeOffset = readU32BE(buffer, offset + 10, "XDBF data offset");
    const length = readU32BE(buffer, offset + 14, "XDBF data length");
    const absoluteOffset = dataOffset + relativeOffset;
    assertRange(buffer, absoluteOffset, length, "XDBF entry data");
    entries.push({
      namespace,
      id,
      offset: absoluteOffset,
      length,
      data: buffer.subarray(absoluteOffset, absoluteOffset + length),
    });
  }
  return { version, entries, dataOffset };
}

function parseXach(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "XACH") {
    throw new Error("Invalid XACH magic");
  }
  const count = readU16BE(buffer, 12, "XACH count");
  if (count > 10000) throw new Error("XACH count is implausibly large");
  assertRange(buffer, 14, count * 36, "XACH achievements");
  const achievements = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 14 + index * 36;
    achievements.push({
      id: readU16BE(buffer, offset, "XACH achievement id"),
      titleStringId: readU16BE(buffer, offset + 2, "XACH title string id"),
      unlockedDescriptionId: readU16BE(
        buffer,
        offset + 4,
        "XACH unlocked description id",
      ),
      lockedDescriptionId: readU16BE(
        buffer,
        offset + 6,
        "XACH locked description id",
      ),
      imageId: readU32BE(buffer, offset + 8, "XACH image id"),
      gamerscore: readU16BE(buffer, offset + 12, "XACH gamerscore"),
      flags: readU32BE(buffer, offset + 16, "XACH flags"),
    });
  }
  return achievements;
}

function parseXstr(buffer) {
  if (buffer.subarray(0, 4).toString("ascii") !== "XSTR") {
    throw new Error("Invalid XSTR magic");
  }
  const count = readU16BE(buffer, 12, "XSTR count");
  if (count > 10000) throw new Error("XSTR count is implausibly large");
  let offset = 14;
  const strings = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = readU16BE(buffer, offset, "XSTR string id");
    const length = readU16BE(buffer, offset + 2, "XSTR string length");
    offset += 4;
    assertRange(buffer, offset, length, "XSTR string");
    strings.set(
      id,
      buffer
        .subarray(offset, offset + length)
        .toString("utf8")
        .replace(/\0+$/, ""),
    );
    offset += length;
  }
  return strings;
}

function parseSpaFile(spaBuffer) {
  const xdbf = parseXdbf(spaBuffer);
  const xachEntry = xdbf.entries.find(
    (entry) =>
      entry.namespace === 1 &&
      entry.data.length >= 14 &&
      entry.data.subarray(0, 4).toString("ascii") === "XACH",
  );
  if (!xachEntry) throw new Error("SPAFILE does not contain XACH metadata");
  const achievements = parseXach(xachEntry.data);
  const titleHeaderEntry = xdbf.entries.find(
    (entry) =>
      entry.namespace === 1 &&
      entry.data.length >= 16 &&
      entry.data.subarray(0, 4).toString("ascii") === "XTHD",
  );
  const titleId = titleHeaderEntry
    ? readU32BE(titleHeaderEntry.data, 12, "XTHD title id")
    : null;
  const stringsByLanguage = new Map();
  const images = new Map();
  for (const entry of xdbf.entries) {
    if (
      entry.namespace === 3 &&
      entry.data.length >= 14 &&
      entry.data.subarray(0, 4).toString("ascii") === "XSTR"
    ) {
      const languageId = Number(entry.id);
      if (Number.isSafeInteger(languageId)) {
        stringsByLanguage.set(languageId, parseXstr(entry.data));
      }
    } else if (
      entry.namespace === 2 &&
      entry.data.length >= PNG_MAGIC.length &&
      entry.data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
    ) {
      const imageId = Number(entry.id);
      if (Number.isSafeInteger(imageId)) images.set(imageId, Buffer.from(entry.data));
    }
  }
  const titleNames = new Map();
  for (const [languageId, strings] of stringsByLanguage) {
    const titleName = String(strings?.get(0x8000) || "").trim();
    if (titleName) titleNames.set(languageId, titleName);
  }
  return {
    ...xdbf,
    titleId,
    achievements,
    stringsByLanguage,
    images,
    titleNames,
  };
}

function getSpaTitleName(parsedSpa, preferredLanguage = "english") {
  if (!parsedSpa?.titleNames?.size) return "";
  const preferredEntry = Object.entries(XLLN_LANGUAGE_BY_ID).find(
    ([, name]) => name === String(preferredLanguage || "").toLowerCase(),
  );
  const preferredId = preferredEntry ? Number(preferredEntry[0]) : 1;
  return String(
    parsedSpa.titleNames.get(preferredId) ||
      parsedSpa.titleNames.get(1) ||
      parsedSpa.titleNames.values().next().value ||
      "",
  ).trim();
}

function normalizeRequestedLanguages(values) {
  const requested = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(requested.length ? requested : ["english"]));
}

function buildSchemaFromSpa(parsedSpa, options = {}) {
  const requested = normalizeRequestedLanguages(options.schemaLanguages);
  const available = Array.from(parsedSpa.stringsByLanguage.keys())
    .map((id) => ({ id, name: XLLN_LANGUAGE_BY_ID[id] || `xlln-language-${id}` }))
    .filter((entry) => parsedSpa.stringsByLanguage.get(entry.id)?.size)
    .sort((left, right) => left.id - right.id);
  if (!available.length) throw new Error("SPAFILE has no usable string tables");
  const selected = available.filter((entry) => requested.includes(entry.name));
  if (!selected.length) {
    selected.push(
      available.find((entry) => entry.name === "english") || available[0],
    );
  }
  const english =
    available.find((entry) => entry.name === "english") || selected[0] || available[0];
  const schema = parsedSpa.achievements.map((achievement) => {
    const displayName = {};
    const description = {};
    const lockedDescription = {};
    for (const language of selected) {
      const strings = parsedSpa.stringsByLanguage.get(language.id);
      const fallback = parsedSpa.stringsByLanguage.get(english.id);
      displayName[language.name] =
        strings?.get(achievement.titleStringId) ||
        fallback?.get(achievement.titleStringId) ||
        String(achievement.id);
      description[language.name] =
        strings?.get(achievement.unlockedDescriptionId) ||
        fallback?.get(achievement.unlockedDescriptionId) ||
        "";
      lockedDescription[language.name] =
        strings?.get(achievement.lockedDescriptionId) ||
        fallback?.get(achievement.lockedDescriptionId) ||
        description[language.name];
    }
    const iconName = `${achievement.id}.png`;
    return {
      hidden: (achievement.flags & 0x1) !== 0 ? 1 : 0,
      displayName,
      description,
      lockedDescription,
      icon: `img/${iconName}`,
      icon_gray: `img/${iconName}`,
      name: String(achievement.id),
      points: achievement.gamerscore,
      xlln_image_id: achievement.imageId,
      xlln_flags: achievement.flags,
    };
  });
  return {
    schema,
    languages: selected.map((entry) => entry.name),
    availableLanguages: available.map((entry) => entry.name),
  };
}

module.exports = {
  XLLN_LANGUAGE_BY_ID,
  buildSchemaFromSpa,
  extractSpaFile,
  extractSpaFileFromPeBuffer,
  getSpaTitleName,
  parseSpaFile,
  parseXach,
  parseXdbf,
  parseXstr,
};
