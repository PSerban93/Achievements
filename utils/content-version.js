const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function toPortableRelativePath(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).join("/");
}

function sortDirentsByName(dirents) {
  return [...dirents].sort((left, right) => left.name.localeCompare(right.name));
}

function updateHashForDirectory(hash, rootDir, currentDir) {
  const dirents = sortDirentsByName(
    fs.readdirSync(currentDir, { withFileTypes: true }),
  );

  for (const dirent of dirents) {
    const fullPath = path.join(currentDir, dirent.name);
    const relativePath = toPortableRelativePath(rootDir, fullPath);

    if (dirent.isDirectory()) {
      hash.update(`d:${relativePath}\0`, "utf8");
      updateHashForDirectory(hash, rootDir, fullPath);
      continue;
    }

    if (dirent.isFile()) {
      hash.update(`f:${relativePath}\0`, "utf8");
      hash.update(fs.readFileSync(fullPath));
      hash.update("\0", "utf8");
      continue;
    }

    if (dirent.isSymbolicLink()) {
      hash.update(`l:${relativePath}\0`, "utf8");
    }
  }
}

function computeFolderContentVersion(rootDir, { prefix = "content" } = {}) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return `${prefix}-missing`;
  }

  const hash = crypto.createHash("sha256");
  hash.update(`${prefix}\0`, "utf8");
  updateHashForDirectory(hash, rootDir, rootDir);
  return `${prefix}-${hash.digest("hex").slice(0, 16)}`;
}

module.exports = {
  computeFolderContentVersion,
};
