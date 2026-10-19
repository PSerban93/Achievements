"use strict";

const fs = require("fs");
const path = require("path");
const { openZArchive } = require("./kytyps5-zarchive");

function isArchivePath(gamePath) {
  return /\.zar$/i.test(String(gamePath));
}

function withGameSource(gamePath, read) {
  // A directory ending in .zar remains a directory, not an archive.
  const stat = fs.statSync(gamePath);
  if (stat.isFile() && isArchivePath(gamePath)) {
    const archive = openZArchive(gamePath);
    try {
      const result = read(archive);
      archive.verifyUnchanged();
      return result;
    } finally { archive.close(); }
  }
  if (!stat.isDirectory()) throw new Error("Unsupported KytyPS5 game source");
  return read({
    read(member, maxSize) {
      const filePath = path.join(gamePath, ...member.split("/"));
      const memberStat = fs.statSync(filePath);
      if (!memberStat.isFile() || memberStat.size > maxSize) throw new Error(`Invalid KytyPS5 file size: ${member}`);
      return fs.readFileSync(filePath);
    },
    list(member) {
      return fs.readdirSync(path.join(gamePath, ...member.split("/")), { withFileTypes: true })
        .filter((entry) => entry.isFile()).map((entry) => entry.name);
    },
  });
}

function listTrophyPackages(gamePath) {
  return withGameSource(gamePath, (source) => source.list("sce_sys/trophy2")
    .filter((name) => /^trophy\d{2}\.ucp$/i.test(name)));
}

function packageFingerprint(gamePath, packageName) {
  const archive = fs.statSync(gamePath).isFile() && isArchivePath(gamePath);
  const filePath = archive ? gamePath : path.join(gamePath, "sce_sys", "trophy2", packageName);
  const stat = fs.statSync(filePath);
  return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${packageName}`;
}

function launchTarget(gamePath) {
  return fs.statSync(gamePath).isFile() && isArchivePath(gamePath)
    ? path.resolve(gamePath) : path.join(path.resolve(gamePath), "eboot.bin");
}

module.exports = { isArchivePath, withGameSource, listTrophyPackages, packageFingerprint, launchTarget };
