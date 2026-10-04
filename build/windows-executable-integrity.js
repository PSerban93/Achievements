"use strict";

const crypto = require("crypto");

// Signing may change only the PE checksum, certificate directory and the
// appended certificate table/alignment. Keep every other byte in the comparison.
function executableContentHash(input) {
  const data = Buffer.from(input);
  if (data.length < 64 || data.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Invalid Windows executable: DOS header missing");
  }
  const pe = data.readUInt32LE(0x3c);
  if (pe < 64 || pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) {
    throw new Error("Invalid Windows executable: PE header missing");
  }
  const optional = pe + 24;
  const optionalSize = data.readUInt16LE(pe + 20);
  if (optionalSize < 2 || optional + optionalSize > data.length) {
    throw new Error("Invalid Windows executable: optional header truncated");
  }
  const magic = data.readUInt16LE(optional);
  const directoryStart = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  const security = optional + directoryStart + 4 * 8;
  if (!directoryStart || directoryStart + 5 * 8 > optionalSize ||
      data.readUInt32LE(optional + directoryStart - 4) < 5) {
    throw new Error("Invalid Windows executable: certificate directory missing");
  }
  const certificateOffset = data.readUInt32LE(security);
  const certificateSize = data.readUInt32LE(security + 4);
  let end = data.length;
  if (certificateOffset || certificateSize) {
    if (certificateOffset < optional + optionalSize || certificateOffset % 8 ||
        certificateSize < 8 || certificateOffset + certificateSize !== data.length) {
      throw new Error("Unsupported Windows executable certificate layout");
    }
    end = certificateOffset;
  }
  data.fill(0, optional + 64, optional + 68); // PE checksum.
  data.fill(0, security, security + 8);
  // SignTool aligns the certificate table to eight bytes, filling with zeros.
  const normalized = Buffer.alloc(Math.ceil(end / 8) * 8);
  data.copy(normalized, 0, 0, end);
  return crypto.createHash("sha256").update(normalized).digest("hex").toUpperCase();
}

module.exports = { executableContentHash };
