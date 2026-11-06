"use strict";
const { encodedSize } = require("./game-artwork-image");
const { MAX_BYTES } = require("./game-artwork-policy");
const MAX_PIXELS = 24 * 1024 * 1024;
async function decodeImage(buffer, nativeImage) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw new Error("invalid-artwork-file");
  const extension = require("./game-artwork-storage").signature(buffer);
  if (!extension) throw new Error("unsupported-image-format");
  const encoded = encodedSize(buffer);
  if (encoded.width * encoded.height > MAX_PIXELS) throw new Error("invalid-artwork-dimensions");
  if (!nativeImage && process.versions.electron) try { nativeImage = require("electron").nativeImage; } catch {}
  const image = nativeImage?.createFromBuffer(buffer);
  let size = image?.getSize();
  // PNG/JPEG are supported by nativeImage. A failed native decode is corrupt
  // input, not permission to trust the dimensions declared by the file.
  if (nativeImage && [".png", ".jpg"].includes(extension) && (!size?.width || !size?.height)) throw new Error("unreadable-artwork-image");
  if ([".gif", ".webp"].includes(extension) || !size?.width || !size?.height) {
    const mime = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif" }[extension];
    size = await require("./game-artwork-decoder").decode(buffer, mime);
  }
  if (!size.width || !size.height || size.width * size.height > MAX_PIXELS) throw new Error("invalid-artwork-dimensions");
  return { image, size };
}
async function size(nativeImage, buffer) {
  try { return (await decodeImage(buffer, nativeImage)).size; }
  catch { return { width: 0, height: 0 }; }
}
module.exports = { decodeImage, size };
