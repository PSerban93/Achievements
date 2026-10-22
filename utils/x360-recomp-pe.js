"use strict";

// Inspect PE import descriptors without loading or running the executable.
// Reads are bounded independently of the size of embedded game data.
const fs = require("fs");

function readImports(file) {
  let fd, budget = 256 * 1024;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return [];
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const read = (at, length) => {
      if (!Number.isSafeInteger(at) || at < 0 || length < 0 || at + length > size || (budget -= length) < 0) throw new Error("Invalid PE import range");
      const bytes = Buffer.alloc(length);
      if (fs.readSync(fd, bytes, 0, length, at) !== length) throw new Error("Incomplete PE imports");
      return bytes;
    };
    const dos = read(0, 64);
    if (dos.toString("ascii", 0, 2) !== "MZ") return [];
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > 8 * 1024 * 1024) return [];
    const pe = read(offset, 24), count = pe.readUInt16LE(6), optionalSize = pe.readUInt16LE(20);
    if (pe.readUInt32LE(0) !== 0x4550 || count < 1 || count > 96 || optionalSize > 4096) return [];
    const opt = read(offset + 24, optionalSize), magic = opt.readUInt16LE(0);
    const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
    if (!directories || opt.length < directories + 16 || opt.readUInt32LE(directories - 4) < 2) return [];
    const sections = read(offset + 24 + optionalSize, count * 40);
    const translate = (rva, length) => {
      if (rva < opt.readUInt32LE(60) && rva + length <= opt.readUInt32LE(60)) return rva;
      for (let at = 0; at < sections.length; at += 40) {
        const start = sections.readUInt32LE(at + 12), rawSize = sections.readUInt32LE(at + 16);
        if (rva >= start && rva - start + length <= rawSize) return sections.readUInt32LE(at + 20) + rva - start;
      }
      throw new Error("PE import RVA has no file data");
    };
    const rva = opt.readUInt32LE(directories + 8), length = opt.readUInt32LE(directories + 12);
    if (!rva || length < 20 || length > 64 * 1024) return [];
    const names = [];
    for (let index = 0; index < Math.min(1024, Math.floor(length / 20)); index++) {
      const descriptor = read(translate(rva + index * 20, 20), 20);
      if (descriptor.every(byte => byte === 0)) return [...new Set(names)];
      const nameRva = descriptor.readUInt32LE(12);
      let name = "", ended = false;
      for (let i = 0; i < 256; i++) {
        const byte = read(translate(nameRva + i, 1), 1)[0];
        if (!byte) { ended = true; break; }
        if (byte < 32 || byte > 126) throw new Error("Invalid PE import name");
        name += String.fromCharCode(byte);
      }
      if (!ended || !/^[a-z0-9_.-]+\.dll$/i.test(name)) throw new Error("Invalid PE import DLL");
      names.push(name.toLowerCase());
    }
    return [];
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { readImports };
