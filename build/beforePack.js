"use strict";

const { Arch } = require("builder-util");

const activeFilters = new WeakMap();
const x86Fastlist = "!**/node_modules/ps-list/vendor/fastlist-0.3.0-x86.exe";

function excludeFromRootFiles(originalFiles) {
  const files = originalFiles == null
    ? ["**/*"]
    : Array.isArray(originalFiles) ? originalFiles : [originalFiles];
  let hasRootFileSet = false;
  let hasRootPatterns = false;
  const filtered = files.map((file) => {
    if (typeof file === "string") {
      hasRootPatterns = true;
      return file;
    }
    if (file.from != null && file.from !== ".") return file;
    hasRootFileSet = true;
    const patterns = file.filter == null
      ? ["**/*"]
      : Array.isArray(file.filter) ? file.filter : [file.filter];
    return { ...file, filter: [...patterns, x86Fastlist] };
  });
  // electron-builder normalizes the main whitelist to a FileSet. Adding a
  // separate ignore-only platform matcher would create a new **/* matcher and
  // copy development files too. Extend the existing root matcher instead.
  if (hasRootPatterns) filtered.push(x86Fastlist);
  if (!hasRootPatterns && !hasRootFileSet) {
    throw new Error("beforePack: cannot extend the application root file filter");
  }
  return filtered;
}

module.exports = (context) => {
  if (context.electronPlatformName !== "win32") return;
  const packager = context.packager;
  // The platform options are shared between architecture builds. Do not allow
  // a concurrent ia32 build to inherit the x64-only exclusion.
  if (activeFilters.has(packager)) {
    throw new Error("beforePack: Windows architecture builds must run sequentially (concurrency.jobs=1)");
  }
  const config = packager.config;
  const originalFiles = config.files;
  activeFilters.set(packager, { config, originalFiles });
  if (context.arch !== Arch.x64) return;
  // Filter during copying, before ASAR integrity and executable signing. Keep
  // node_modules intact, and leave Linux/macOS and Windows ia32 unchanged.
  config.files = excludeFromRootFiles(originalFiles);
};

module.exports.restoreFilters = (context) => {
  const saved = activeFilters.get(context.packager);
  if (!saved) return;
  if (saved.originalFiles === undefined) delete saved.config.files;
  else saved.config.files = saved.originalFiles;
  activeFilters.delete(context.packager);
};
