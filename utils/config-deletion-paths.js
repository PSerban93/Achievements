const fs = require("fs");
const path = require("path");

function normalizeAbsolutePath(value) {
  const raw = String(value || "").trim();
  if (!raw || !path.isAbsolute(raw)) return "";
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

function isStrictDescendantPath(rootPath, targetPath) {
  const root = normalizeAbsolutePath(rootPath);
  const target = normalizeAbsolutePath(targetPath);
  if (!root || !target) return false;
  let relative = "";
  try {
    relative = path.relative(root, target);
  } catch {
    return false;
  }
  if (!relative || relative === "." || path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function validateAppIdDirectoryTarget(targetPath, appid) {
  const target = normalizeAbsolutePath(targetPath);
  const expectedName = String(appid || "").trim().toLowerCase();
  if (!target || !expectedName) return "";
  if (path.basename(target).toLowerCase() !== expectedName) return "";
  return target;
}

function findMostSpecificContainingRoot(targetPath, rootPaths) {
  const target = normalizeAbsolutePath(targetPath);
  if (!target) return null;
  let bestRoot = "";
  for (const rootPath of rootPaths || []) {
    const root = normalizeAbsolutePath(rootPath);
    if (!root || !isStrictDescendantPath(root, target)) continue;
    if (!bestRoot || root.length > bestRoot.length) bestRoot = root;
  }
  return bestRoot ? { root: bestRoot, target } : null;
}

module.exports = {
  findMostSpecificContainingRoot,
  isStrictDescendantPath,
  normalizeAbsolutePath,
  validateAppIdDirectoryTarget,
};
