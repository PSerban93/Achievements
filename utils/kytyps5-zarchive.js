"use strict";

const fs = require("fs");
const { zstdDecompressSync } = require("zlib");

// ZArchive v1 layout: https://github.com/Exzap/ZArchive
// Only the index and requested 64 KiB blocks are read. No archive entries are
// extracted to disk, and the footer's whole-archive hash is not recomputed.
const BLOCK_SIZE = 65536;
const FOOTER_SIZE = 144;
const MAX_INDEX_SIZE = 64 * 1024 * 1024;

function openZArchive(filePath) {
  const fd = fs.openSync(filePath, "r");
  let closed = false;
  const close = () => { if (!closed) { closed = true; fs.closeSync(fd); } };
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= FOOTER_SIZE || !Number.isSafeInteger(stat.size)) {
      throw new Error("Invalid KytyPS5 ZArchive size");
    }
    const readAt = (offset, size) => {
      if (closed || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
          offset < 0 || size < 0 || offset + size > stat.size) {
        throw new Error("Invalid KytyPS5 ZArchive read range");
      }
      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const count = fs.readSync(fd, bytes, read, size - read, offset + read);
        if (!count) throw new Error("Incomplete KytyPS5 ZArchive");
        read += count;
      }
      return bytes;
    };
    const number64 = (bytes, offset) => {
      const value = bytes.readBigUInt64BE(offset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid ZArchive offset");
      return Number(value);
    };
    const footer = readAt(stat.size - FOOTER_SIZE, FOOTER_SIZE);
    if (footer.readUInt32BE(140) !== 0x169f52d6 ||
        footer.readUInt32BE(136) !== 0x61bf3a01 || number64(footer, 128) !== stat.size) {
      throw new Error("Unsupported or incomplete KytyPS5 ZArchive");
    }
    const sections = Array.from({ length: 6 }, (_, index) => ({
      offset: number64(footer, index * 16), size: number64(footer, index * 16 + 8),
    }));
    const ranges = sections.filter((section) => section.size).sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const section of ranges) {
      if (section.offset < end || section.offset + section.size > stat.size - FOOTER_SIZE) {
        throw new Error("Invalid KytyPS5 ZArchive sections");
      }
      end = section.offset + section.size;
    }
    const [data, offsets, names, tree] = sections;
    if (!offsets.size || offsets.size % 40 || !tree.size || tree.size % 16 ||
        names.size + tree.size > MAX_INDEX_SIZE) throw new Error("Invalid ZArchive index");
    const nameTable = readAt(names.offset, names.size);
    const nodes = readAt(tree.offset, tree.size);
    const nodeCount = nodes.length / 16;
    const nameOf = (flags) => {
      let offset = flags & 0x7fffffff;
      if (offset === 0x7fffffff) return ""; // Unnamed root sentinel.
      if (offset >= nameTable.length) throw new Error("Invalid ZArchive name offset");
      const first = nameTable[offset++];
      let length = first & 0x7f;
      if (first & 0x80) {
        if (offset >= nameTable.length) throw new Error("Incomplete ZArchive name");
        length |= nameTable[offset++] << 7;
      }
      if (offset + length > nameTable.length) throw new Error("Incomplete ZArchive name");
      return nameTable.toString("utf8", offset, offset + length);
    };
    const nodeAt = (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= nodeCount) throw new Error("Invalid ZArchive node");
      const offset = index * 16;
      const flags = nodes.readUInt32BE(offset);
      const a = nodes.readUInt32BE(offset + 4), b = nodes.readUInt32BE(offset + 8);
      const high = nodes.readUInt32BE(offset + 12);
      const node = { index, name: nameOf(flags), isFile: Boolean(flags & 0x80000000) };
      if (node.isFile) {
        node.offset = a + (high & 0xffff) * 4294967296;
        node.size = b + (high >>> 16) * 4294967296;
        if (node.offset + node.size > offsets.size / 40 * 16 * BLOCK_SIZE) {
          throw new Error("Invalid ZArchive member range");
        }
      } else {
        node.start = a; node.count = b;
        if (a + b > nodeCount) throw new Error("Invalid ZArchive directory range");
      }
      return node;
    };
    const root = nodeAt(0);
    if (root.isFile || root.name) throw new Error("Invalid ZArchive root");
    const lookup = (member) => {
      const parts = String(member).replace(/\\/g, "/").split("/").filter(Boolean);
      if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
        throw new Error("Invalid ZArchive member path");
      }
      let node = root;
      for (const part of parts) {
        if (node.isFile) return null;
        let match = null;
        for (let index = node.start; index < node.start + node.count; index += 1) {
          const child = nodeAt(index);
          if (child.name.toLowerCase() === part.toLowerCase()) { match = child; break; }
        }
        if (!match) return null;
        node = match;
      }
      return node;
    };
    const records = new Map(), blocks = new Map();
    const blockAt = (index) => {
      if (blocks.has(index)) return blocks.get(index);
      const recordIndex = Math.floor(index / 16), subIndex = index % 16;
      if (recordIndex * 40 >= offsets.size) throw new Error("Invalid ZArchive block");
      let record = records.get(recordIndex);
      if (!record) {
        record = readAt(offsets.offset + recordIndex * 40, 40);
        if (records.size >= 32) records.delete(records.keys().next().value);
        records.set(recordIndex, record);
      }
      let offset = number64(record, 0);
      for (let i = 0; i < subIndex; i += 1) offset += record.readUInt16BE(8 + i * 2) + 1;
      const size = record.readUInt16BE(8 + subIndex * 2) + 1;
      if (offset + size > data.size) throw new Error("Incomplete ZArchive block");
      const compressed = readAt(data.offset + offset, size);
      if (size !== BLOCK_SIZE && typeof zstdDecompressSync !== "function") {
        throw new Error("KytyPS5 ZArchive requires a runtime with Zstandard support");
      }
      const block = size === BLOCK_SIZE ? compressed :
        zstdDecompressSync(compressed, { maxOutputLength: BLOCK_SIZE });
      if (block.length !== BLOCK_SIZE) throw new Error("Invalid decompressed ZArchive block");
      if (blocks.size >= 8) blocks.delete(blocks.keys().next().value);
      blocks.set(index, block);
      return block;
    };
    return {
      close,
      verifyUnchanged() {
        const current = fs.fstatSync(fd);
        if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
          throw new Error("KytyPS5 ZArchive changed while reading");
        }
      },
      list(member) {
        const node = lookup(member);
        if (!node || node.isFile) throw new Error(`Missing ZArchive directory: ${member}`);
        const files = [];
        for (let index = node.start; index < node.start + node.count; index += 1) {
          const child = nodeAt(index);
          if (child.isFile) files.push(child.name);
        }
        return files;
      },
      read(member, maxSize) {
        const node = lookup(member);
        if (!node?.isFile) throw new Error(`Missing ZArchive file: ${member}`);
        if (!Number.isSafeInteger(maxSize) || maxSize < 0 || node.size > maxSize) {
          throw new Error(`KytyPS5 ZArchive member is too large: ${member}`);
        }
        const result = Buffer.alloc(node.size);
        let copied = 0;
        while (copied < node.size) {
          const position = node.offset + copied;
          const withinBlock = position % BLOCK_SIZE;
          const size = Math.min(node.size - copied, BLOCK_SIZE - withinBlock);
          blockAt(Math.floor(position / BLOCK_SIZE)).copy(result, copied, withinBlock, withinBlock + size);
          copied += size;
        }
        return result;
      },
    };
  } catch (error) { close(); throw error; }
}

module.exports = { openZArchive };
