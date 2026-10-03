const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeCollectionImageFile } = require("./game-collections");

const MAX_COLLECTION_IMAGE_BYTES = 15 * 1024 * 1024;

function detectImageExtension(header) {
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "png";
  }
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  ) {
    return "jpg";
  }
  if (
    header.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))
  ) {
    return "gif";
  }
  if (
    header.length >= 12 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return "";
}

function resolveCollectionImagePath(directory, collectionId, fileName) {
  if (!normalizeCollectionImageFile(fileName, collectionId)) return "";
  return path.join(directory, fileName);
}

async function saveCollectionImage(directory, collectionId, sourcePath) {
  if (!/^[a-f0-9-]{36}$/i.test(String(collectionId || ""))) {
    throw new Error("Invalid collection ID.");
  }
  const source = String(sourcePath || "");
  const stat = await fs.promises.stat(source);
  if (!stat.isFile() || stat.size < 12 || stat.size > MAX_COLLECTION_IMAGE_BYTES) {
    throw new Error("Choose an image smaller than 15 MB.");
  }
  const handle = await fs.promises.open(source, "r");
  let extension = "";
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    extension = detectImageExtension(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  if (!extension) {
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  }
  await fs.promises.mkdir(directory, { recursive: true });
  const fileName = `${collectionId}-${crypto.randomBytes(6).toString("hex")}.${extension}`;
  const destination = resolveCollectionImagePath(directory, collectionId, fileName);
  try {
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      await fs.promises.unlink(destination).catch(() => {});
    }
    throw error;
  }
  return fileName;
}

async function removeCollectionImage(directory, collectionId, fileName) {
  const imagePath = resolveCollectionImagePath(directory, collectionId, fileName);
  if (!imagePath) return false;
  try {
    await fs.promises.unlink(imagePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

module.exports = {
  MAX_COLLECTION_IMAGE_BYTES,
  detectImageExtension,
  removeCollectionImage,
  resolveCollectionImagePath,
  saveCollectionImage,
};
