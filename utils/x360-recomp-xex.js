"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { parseSpaFile } = require("./xlivelessness-spa");
const { extractLzxResource, MAX_IMAGE, fail } = require("./x360-recomp-lzx");

function extractSpaFromXex(file, expectedTitleId = "") {
  let fd;
  let data, before;
  try {
    fd = fs.openSync(file, "r"); before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 24 || before.size > MAX_IMAGE) fail("XEX_SIZE", "Invalid or oversized XEX file");
    data = Buffer.alloc(before.size);
    let at = 0;
    while (at < data.length) {
      const length = fs.readSync(fd, data, at, data.length - at, at);
      if (!length) fail("XEX_CHANGED", "XEX changed or was truncated during extraction");
      at += length;
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("XEX_CHANGED", "XEX changed during extraction");
    }
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (data.toString("ascii", 0, 4) !== "XEX2") fail("XEX_HEADER", "Invalid XEX2 file");
  const payloadOffset = data.readUInt32BE(8);
  if (payloadOffset < 24 || payloadOffset > data.length || payloadOffset > 16 * 1024 * 1024) fail("XEX_HEADER", "Invalid XEX2 header size");
  const range = (offset, length, limit = payloadOffset) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
      fail("XEX_RANGE", "XEX2 range outside header");
    }
  };
  const count = data.readUInt32BE(20), headers = new Map();
  if (count > 4096) fail("XEX_HEADER", "Invalid XEX2 header count");
  range(24, count * 8);
  for (let i = 0; i < count; i++) headers.set(data.readUInt32BE(24 + i * 8), data.readUInt32BE(28 + i * 8));
  if (headers.has(0x000005ff) || data.readUInt32BE(4) & 0x40) {
    fail("XEX_DELTA_REQUIRES_BASE", "Delta XEX requires its matching base executable; select a complete patched XEX or exported SPA in achievements-recomp.json");
  }
  const security = data.readUInt32BE(16), format = headers.get(0x000003ff), resource = headers.get(0x000002ff);
  const execution = headers.get(0x00040006);
  if (format === undefined || resource === undefined || execution === undefined) fail("XEX_SPA_MISSING", "XEX2 has no title/achievement resource");
  range(security, 0x160); range(format, 8); range(resource, 4); range(execution, 16);
  const titleId = data.readUInt32BE(execution + 12).toString(16).padStart(8, "0").toUpperCase();
  if (titleId === "00000000" || (expectedTitleId && titleId !== expectedTitleId)) fail("XEX_TITLE_MISMATCH", "XEX Title ID mismatch");
  const imageSize = data.readUInt32BE(security + 4);
  const base = headers.get(0x00010201) || data.readUInt32BE(security + 0x110);
  if (!imageSize || imageSize > MAX_IMAGE) fail("XEX_SIZE", "Invalid XEX2 image size");
  const resourceSize = data.readUInt32BE(resource);
  if (resourceSize < 4 || (resourceSize - 4) % 16) fail("XEX_HEADER", "Invalid XEX2 resource table");
  range(resource, resourceSize);
  let spa;
  for (let at = resource + 4; at < resource + resourceSize; at += 16) {
    if (data.toString("ascii", at, at + 8).toUpperCase() === titleId) {
      spa = { offset: data.readUInt32BE(at + 8) - base, size: data.readUInt32BE(at + 12) }; break;
    }
  }
  if (!spa || spa.offset < 0 || spa.size < 24 || spa.offset + spa.size > imageSize) fail("XEX_SPA_MISSING", "Missing Xbox SPA resource");
  const compression = data.readUInt16BE(format + 6), encryption = data.readUInt16BE(format + 4);
  if (compression > 2) fail("XEX_COMPRESSION", `Unsupported XEX compression type: ${compression}`);
  if (encryption > 1) fail("XEX_ENCRYPTION", "Unsupported XEX encryption");
  const payload = data.subarray(payloadOffset);
  const decrypt = (bytes, key) => {
    const cipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16)); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  };
  // Published console loader format constants, not user credentials.
  const masters = encryption ? [Buffer.from("20b185a59d28fdc340583fbb0896bf91", "hex"), Buffer.alloc(16)] : [null];
  let lastError;
  for (const master of masters) {
    try {
      const bytes = master ? decrypt(payload, decrypt(data.subarray(security + 0x150, security + 0x160), master)) : payload;
      let spaBuffer;
      if (compression === 2) {
        const infoSize = data.readUInt32BE(format); range(format, infoSize);
        if (infoSize < 36) fail("XEX_HEADER", "Truncated XEX LZX format header");
        spaBuffer = extractLzxResource(bytes, { imageSize,
          windowSize: data.readUInt32BE(format + 8), firstBlockSize: data.readUInt32BE(format + 12),
          firstBlockHash: data.subarray(format + 16, format + 36) }, spa);
      } else {
        let image;
        if (!compression) {
          if (bytes.length < imageSize) fail("XEX_TRUNCATED", "Truncated XEX image");
          image = bytes.subarray(0, imageSize);
        } else {
          const infoSize = data.readUInt32BE(format); range(format, infoSize);
          if (infoSize < 8 || (infoSize - 8) % 8) fail("XEX_HEADER", "Invalid XEX basic blocks");
          image = Buffer.alloc(imageSize);
          let input = 0, output = 0;
          for (let at = format + 8; at < format + infoSize; at += 8) {
            const length = data.readUInt32BE(at), zeros = data.readUInt32BE(at + 4);
            if (input + length > bytes.length || output + length + zeros > imageSize) fail("XEX_TRUNCATED", "Truncated XEX basic block");
            bytes.copy(image, output, input, input + length); input += length; output += length + zeros;
          }
          // Basic blocks describe stored data/zero runs, not necessarily the
          // entire reserved image. Require the requested resource to be fully
          // covered; never manufacture missing SPA bytes from the reserved tail.
          if (spa.offset + spa.size > output) fail("XEX_TRUNCATED", "Incomplete XEX basic resource");
        }
        spaBuffer = image.subarray(spa.offset, spa.offset + spa.size);
      }
      const parsed = parseSpaFile(spaBuffer);
      // Require the SPA to identify this game, not only look like an XDBF.
      if (!parsed.titleId || parsed.titleId.toString(16).padStart(8, "0").toUpperCase() !== titleId) {
        fail("XEX_SPA_TITLE_MISMATCH", "SPA Title ID mismatch");
      }
      return { spa: spaBuffer, titleId, compression, fileSize: before.size,
        mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs };
    } catch (error) { lastError = error; if (!encryption) throw error; }
  }
  throw lastError || new Error("Cannot decode Xbox SPA resource");
}

module.exports = { extractSpaFromXex };
