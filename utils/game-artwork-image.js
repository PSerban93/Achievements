"use strict";

// nativeImage on Windows does not decode every format Chromium can display.
// Read the dimensions of WebP/GIF without treating that decoder limitation as
// a corrupt download. Keep animation when no resizing is necessary.
function encodedSize(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.subarray(12, 16).toString() === "IHDR")
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216) {
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 255) {
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 216) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8)
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString()) && buffer.length >= 10)
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.length < 30 || buffer.subarray(0, 4).toString() !== "RIFF" || buffer.subarray(8, 12).toString() !== "WEBP" || buffer.readUInt32LE(4) + 8 > buffer.length) return { width: 0, height: 0 };
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const kind = buffer.subarray(offset, offset + 4).toString(), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > buffer.length) break;
    if (kind === "VP8X" && length >= 10) return { width: buffer.readUIntLE(start + 4, 3) + 1, height: buffer.readUIntLE(start + 7, 3) + 1 };
    if (kind === "VP8 " && length >= 10 && buffer.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])))
      return { width: buffer.readUInt16LE(start + 6) & 16383, height: buffer.readUInt16LE(start + 8) & 16383 };
    if (kind === "VP8L" && length >= 5 && buffer[start] === 47) {
      const bits = buffer.readUInt32LE(start + 1); return { width: (bits & 16383) + 1, height: (bits >>> 14 & 16383) + 1 };
    }
    offset = start + length + (length & 1);
  }
  return { width: 0, height: 0 };
}
function size(nativeImage, buffer) {
  const encoded = encodedSize(buffer);
  if (encoded.width * encoded.height > 24 * 1024 * 1024) return { width: 0, height: 0 };
  const decoded = nativeImage.createFromBuffer(buffer).getSize();
  // This synchronous helper measures browser-only formats; it does not validate
  // their image payload. Publication/cached validation uses artwork-validation.
  return decoded.width && decoded.height ? decoded : /^(?:GIF8[79]a|RIFF)/.test(buffer.subarray(0, 6).toString()) ? encoded : { width: 0, height: 0 };
}
module.exports = { encodedSize, size };
