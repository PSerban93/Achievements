"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const MAX_IMAGE = 128 * 1024 * 1024;
const CHUNK_OUTPUT = 0x8000;

function fail(code, message) {
  const error = new Error(message); error.code = code; throw error;
}

function loadDecoder() {
  const directory = path.join(__dirname, "vendor", "x360-lzx");
  const bytes = fs.readFileSync(path.join(directory, "decoder.wasm"));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    fail("XEX_LZX_RUNTIME", "Xbox LZX decoder integrity mismatch");
  }
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
}

// XEX normal compression wraps LZX chunks in chained, SHA-1 checked blocks.
// The block header describes the NEXT block. The first descriptor is in XEX.
function collectChunks(bytes, firstSize, firstHash, imageSize) {
  const chunks = [];
  let offset = 0, blockSize = firstSize, expectedHash = firstHash;
  const expectedCount = Math.ceil(imageSize / CHUNK_OUTPUT);
  while (blockSize) {
    if (blockSize < 26 || blockSize > bytes.length - offset) {
      fail("XEX_LZX_BLOCK", "Truncated or invalid XEX LZX block");
    }
    const block = bytes.subarray(offset, offset + blockSize);
    if (!crypto.createHash("sha1").update(block).digest().equals(expectedHash)) {
      fail("XEX_LZX_HASH", "XEX LZX block hash mismatch (damaged file or wrong decryption key)");
    }
    const nextSize = block.readUInt32BE(0), nextHash = block.subarray(4, 24);
    let at = 24, terminated = false;
    while (at + 2 <= block.length) {
      const length = block.readUInt16BE(at); at += 2;
      if (!length) { terminated = true; break; }
      if (length > block.length - at || chunks.length >= expectedCount) {
        fail("XEX_LZX_CHUNK", "Invalid XEX LZX chunk boundaries or count");
      }
      chunks.push(block.subarray(at, at + length)); at += length;
    }
    if (!terminated) fail("XEX_LZX_BLOCK", "Missing XEX LZX block terminator");
    offset += blockSize; blockSize = nextSize; expectedHash = nextHash;
  }
  if (chunks.length !== expectedCount) fail("XEX_LZX_TRUNCATED", "Incomplete XEX LZX image");
  return chunks;
}

function extractLzxResource(bytes, info, resource) {
  const { imageSize, windowSize, firstBlockSize, firstBlockHash } = info;
  if (!Number.isSafeInteger(imageSize) || imageSize <= 0 || imageSize > MAX_IMAGE ||
      !Number.isSafeInteger(resource.offset) || resource.offset < 0 ||
      !Number.isSafeInteger(resource.size) || resource.size < 24 || resource.offset + resource.size > imageSize) {
    fail("XEX_LZX_RANGE", "Invalid XEX LZX image/resource limits");
  }
  const chunks = collectChunks(bytes, firstBlockSize, firstBlockHash, imageSize);
  const api = loadDecoder();
  const decoder = api.decoder_new(windowSize);
  if (!decoder) fail("XEX_LZX_WINDOW", `Unsupported Xbox LZX window size: ${windowSize}`);
  let input = 0, output = 0;
  try {
    input = api.alloc(65536); output = api.alloc(CHUNK_OUTPUT);
    if (!input || !output) fail("XEX_LZX_MEMORY", "Xbox LZX decoder allocation failed");
    const spa = Buffer.alloc(resource.size);
    let imageOffset = 0, copied = 0;
    for (const chunk of chunks) {
      const length = Math.min(CHUNK_OUTPUT, imageSize - imageOffset);
      new Uint8Array(api.memory.buffer, input, chunk.length).set(chunk);
      if (api.decode_next(decoder, input, chunk.length, output, length) !== 0) {
        fail("XEX_LZX_DECODE", `Xbox LZX decompression failed at image offset ${imageOffset}`);
      }
      const decoded = Buffer.from(api.memory.buffer, output, length);
      if (!imageOffset && decoded.toString("ascii", 0, 2) !== "MZ") {
        fail("XEX_LZX_IMAGE", "Decompressed Xbox image has no PE signature");
      }
      const from = Math.max(imageOffset, resource.offset);
      const to = Math.min(imageOffset + length, resource.offset + resource.size);
      if (to > from) {
        decoded.copy(spa, from - resource.offset, from - imageOffset, to - imageOffset); copied += to - from;
      }
      imageOffset += length;
    }
    if (imageOffset !== imageSize || copied !== resource.size) fail("XEX_LZX_TRUNCATED", "Incomplete Xbox SPA output");
    return spa;
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) fail("XEX_LZX_DECODE", `Xbox LZX decoder rejected the stream: ${error.message}`);
    throw error;
  } finally {
    // A trapped instance is discarded by its worker. Cleanup must not hide the
    // original decode failure if the WASM allocator itself was exhausted.
    try {
      if (input) api.free(input, 65536);
      if (output) api.free(output, CHUNK_OUTPUT);
      api.decoder_free(decoder);
    } catch {}
  }
}

module.exports = { extractLzxResource, MAX_IMAGE, fail };
