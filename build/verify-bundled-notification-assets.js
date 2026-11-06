"use strict";

const fs = require("fs");
const path = require("path");

function verifyDirectory(source, destination) {
  const actualEntries = fs.readdirSync(destination).sort();
  const expectedEntries = fs.readdirSync(source).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Notification assets: incomplete or unexpected contents at ${destination}`);
  }
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const original = path.join(source, entry.name);
    const delivered = path.join(destination, entry.name);
    const stat = fs.lstatSync(delivered);
    if (entry.isDirectory() && stat.isDirectory()) {
      count += verifyDirectory(original, delivered);
    } else if (entry.isFile() && stat.isFile()) {
      if (!fs.readFileSync(original).equals(fs.readFileSync(delivered))) {
        throw new Error(`Notification assets: content differs at ${delivered}`);
      }
      count++;
    } else {
      throw new Error(`Notification assets: unsupported or mismatched entry at ${delivered}`);
    }
  }
  return count;
}

function verifyBundledNotificationAssets({ projectDir, resourcesDir }) {
  const archive = path.join(resourcesDir, "app.asar");
  const asar = require("@electron/asar");
  asar.uncache(archive);
  const entries = asar.listPackage(archive)
    .map((entry) => entry.replace(/\\/g, "/"));
  // Only the two root folders are external. SAN's nested runtime presets and
  // the separate progress template must remain in the application archive.
  if (entries.some((entry) => /^\/(sounds|presets)(\/|$)/i.test(entry))) {
    throw new Error("Notification assets: duplicate root sounds/presets found inside app.asar");
  }
  for (const template of ["/progress.html", "/san-notification.html"]) {
    if (!entries.includes(template)) {
      throw new Error(`Notification assets: required template missing from app.asar: ${template}`);
    }
  }
  return Object.fromEntries(["sounds", "presets"].map((name) => [
    name,
    verifyDirectory(path.join(projectDir, name), path.join(resourcesDir, name)),
  ]));
}

module.exports = { verifyBundledNotificationAssets };
