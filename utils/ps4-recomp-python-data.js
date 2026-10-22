"use strict";

// A bounded data reader for CPython 3.12 / PyInstaller archives. No Python VM,
// imports, native code objects, or launcher commands are executed here.
const fs = require("fs");
const zlib = require("zlib");
const MAX = 8 * 1024 * 1024;
const NONE = Symbol("marshal-null");
class Reader {
  constructor(bytes) { this.bytes = bytes; this.at = 0; this.refs = []; this.nodes = 0; }
  take(n) {
    if (!Number.isInteger(n) || n < 0 || n > MAX || this.at + n > this.bytes.length) throw new Error("Invalid Python data bounds");
    const value = this.bytes.subarray(this.at, this.at + n); this.at += n; return value;
  }
  int() { return this.take(4).readInt32LE(); }
  read(depth = 0) {
    if (depth > 96 || ++this.nodes > 150000) throw new Error("Python data exceeds discovery limits");
    const tag = this.take(1)[0], type = String.fromCharCode(tag & 127), flagged = tag & 128;
    const ref = flagged ? this.refs.push(null) - 1 : -1;
    let value;
    if (type === "r") {
      const index = this.int();
      if (index < 0 || index >= this.refs.length || this.refs[index] === null) throw new Error("Invalid Python data reference");
      value = this.refs[index];
    } else if (type === "N") value = undefined;
    else if (type === "0") value = NONE;
    else if (type === "T" || type === "F") value = type === "T";
    else if (type === "i") value = this.int();
    else if (type === "g") value = this.take(8).readDoubleLE();
    else if ("staAu".includes(type)) {
      const bytes = this.take(this.int()); value = type === "s" ? bytes : bytes.toString("utf8");
    } else if (type === "z" || type === "Z") value = this.take(this.take(1)[0]).toString("utf8");
    else if ("([<>)".includes(type)) {
      const count = type === ")" ? this.take(1)[0] : this.int();
      if (count < 0 || count > 50000) throw new Error("Python container exceeds discovery limits");
      value = []; if (flagged) this.refs[ref] = value;
      for (let i = 0; i < count; i++) value.push(this.read(depth + 1));
    } else if (type === "{") {
      value = new Map(); if (flagged) this.refs[ref] = value;
      for (let i = 0; ; i++) {
        if (i > 50000) throw new Error("Python dictionary exceeds discovery limits");
        const key = this.read(depth + 1); if (key === NONE) break;
        value.set(key, this.read(depth + 1));
      }
    } else if (type === "c") {
      value = { kind: "code" }; if (flagged) this.refs[ref] = value;
      for (const name of ["argc", "posonly", "kwonly", "stacksize", "flags"]) value[name] = this.int();
      for (const name of ["bytes", "constants", "names", "locals", "localKinds", "filename", "name", "qualname"]) value[name] = this.read(depth + 1);
      value.firstline = this.int(); value.lines = this.read(depth + 1); value.exceptions = this.read(depth + 1);
      if (!Buffer.isBuffer(value.bytes) || !Array.isArray(value.constants) || !Array.isArray(value.names) || !Array.isArray(value.locals)) throw new Error("Invalid Python code data");
    } else if (type === "l") {
      const count = this.int(); if (Math.abs(count) > 16) throw new Error("Python integer exceeds discovery limits");
      let number = 0n;
      for (let i = 0; i < Math.abs(count); i++) number |= BigInt(this.take(2).readUInt16LE()) << BigInt(15 * i);
      value = Number(count < 0 ? -number : number);
    } else throw new Error(`Unsupported Python data type ${JSON.stringify(type)}`);
    if (flagged) this.refs[ref] = value;
    return value;
  }
}
function inflate(bytes, expected) {
  if (expected !== undefined && (expected < 0 || expected > MAX)) throw new Error("Python archive entry exceeds discovery limits");
  const value = zlib.inflateSync(bytes, { maxOutputLength: expected === undefined ? MAX : expected + 1 });
  if (expected !== undefined && value.length !== expected) throw new Error("Python archive entry size mismatch");
  return value;
}
function archive(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) return null;
  const bytes = fs.readFileSync(file), at = bytes.lastIndexOf(Buffer.from([77, 69, 73, 12, 11, 10, 11, 14]));
  if (at < 0) return null;
  if (at + 88 > bytes.length) throw new Error("Truncated PyInstaller header");
  const size = bytes.readUInt32BE(at + 8), offset = bytes.readUInt32BE(at + 12), length = bytes.readUInt32BE(at + 16);
  const version = bytes.readUInt32BE(at + 20), start = at + 88 - size;
  if (version !== 312) throw new Error(`Unsupported PyInstaller Python version ${version}`);
  if (start < 0 || length > 1024 * 1024 || offset + length > size - 88) throw new Error("Invalid PyInstaller table bounds");
  const toc = bytes.subarray(start + offset, start + offset + length), entries = new Map();
  for (let pos = 0; pos < toc.length;) {
    if (pos + 18 > toc.length) throw new Error("Truncated PyInstaller table");
    const n = toc.readUInt32BE(pos), off = toc.readUInt32BE(pos + 4), len = toc.readUInt32BE(pos + 8), unpacked = toc.readUInt32BE(pos + 12);
    if (n < 19 || pos + n > toc.length || off + len > offset || unpacked > MAX) throw new Error("Invalid PyInstaller entry bounds");
    const name = toc.subarray(pos + 18, pos + n).toString("utf8").replace(/\0+$/, "");
    const type = String.fromCharCode(toc[pos + 17]), compressed = toc[pos + 16];
    if (entries.has(name) || compressed > 1) throw new Error("Invalid PyInstaller entry");
    entries.set(name, { off, len, unpacked, compressed, type }); pos += n;
  }
  const extract = (entry) => {
    const data = bytes.subarray(start + entry.off, start + entry.off + entry.len);
    if (!entry.compressed && data.length !== entry.unpacked) throw new Error("Invalid PyInstaller entry size");
    return entry.compressed ? inflate(data, entry.unpacked) : data;
  };
  const pyzs = [...entries.values()].filter((entry) => entry.type === "z");
  if (pyzs.length !== 1) throw new Error("Unsupported PyInstaller module layout");
  const pyz = extract(pyzs[0]);
  if (pyz.length < 12 || pyz.subarray(0, 8).toString("hex") !== "50595a00cb0d0d0a") throw new Error("Unsupported Python bytecode version");
  const tableAt = pyz.readUInt32BE(8);
  if (tableAt < 12 || tableAt >= pyz.length) throw new Error("Invalid Python module table");
  const rows = new Reader(pyz.subarray(tableAt)).read();
  const table = rows instanceof Map ? rows : new Map(rows);
  if (table.size > 4096) throw new Error("Python module table exceeds discovery limits");
  let inflated = 0;
  return {
    scripts: [...entries].filter(([name, entry]) => entry.type === "s" && !/^pyi(?:_|boot)/.test(name)).map(([name, entry]) => ({ name, code: new Reader(extract(entry)).read() })),
    names: [...table.keys()],
    module(name) {
      const row = table.get(name); if (!row) return null;
      const [type, pos, len] = row;
      if (type !== 0 && type !== 1) return null;
      if (!Number.isInteger(pos) || !Number.isInteger(len) || pos < 12 || len < 0 || pos + len > tableAt) throw new Error("Invalid Python module bounds");
      const raw = inflate(pyz.subarray(pos, pos + len)); inflated += raw.length;
      if (inflated > 32 * 1024 * 1024) throw new Error("Python modules exceed discovery limits");
      return new Reader(raw).read();
    },
  };
}
module.exports = { Reader, inflate, archive };
