"use strict";

const fs = require("fs");
const path = require("path");

const RPCS3_SCHEMA_FILE = "tropconf.sfm";
const RPCS3_PROGRESS_FILE = "tropusr.dat";
const SHADPS4_SCHEMA_FILE = "trop.xml";
const SHADPS4_LOG_FILE = "shad_log.txt";
const XENIA_GPD_EXTENSION = ".gpd";
const XENIA_XDBF_MAGIC = "XDBF";

function normalizePath(inputPath) {
  if (!inputPath) return "";
  let resolved = "";
  try {
    resolved = path.resolve(String(inputPath));
  } catch {
    resolved = String(inputPath);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootPath, candidatePath) {
  const root = normalizePath(rootPath);
  const candidate = normalizePath(candidatePath);
  if (!root || !candidate) return false;
  if (root === candidate) return true;
  const relative = path.relative(root, candidate);
  return Boolean(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
}

function isDirectory(inputPath) {
  try {
    return fs.statSync(inputPath).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(inputPath) {
  try {
    return fs
      .readdirSync(inputPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(inputPath, entry.name));
  } catch {
    return [];
  }
}

function hasXeniaPathHint(inputPath) {
  return String(inputPath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((part) => part.toLowerCase().includes("xenia"));
}

function isXeniaGpdFile(inputPath) {
  if (
    path.extname(String(inputPath || "")).toLowerCase() !==
    XENIA_GPD_EXTENSION
  ) {
    return false;
  }
  try {
    const fd = fs.openSync(inputPath, "r");
    try {
      const magic = Buffer.allocUnsafe(4);
      return (
        fs.readSync(fd, magic, 0, magic.length, 0) === magic.length &&
        magic.toString("ascii") === XENIA_XDBF_MAGIC
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findXeniaGpdUnder(rootPath, maxDepth = 6) {
  const stack = [{ dir: rootPath, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current.dir, entry.name);
      if (entry.isFile() && isXeniaGpdFile(candidate)) return candidate;
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: candidate, depth: current.depth + 1 });
      }
    }
  }
  return "";
}

function getMetaRuntimePaths(meta) {
  return [
    meta?.gpd_path,
    meta?.trophy_path,
    meta?.trophy_dir,
    meta?.shadps4_schema_path,
    meta?.shadps4_progress_path,
    meta?.save_path,
  ]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean);
}

function findXeniaRootEvidence(rootPath, metas = [], fallbackDepth = 6) {
  const runtimeMetas = metas.filter((meta) =>
    getMetaRuntimePaths(meta).some((candidate) =>
      isPathInside(rootPath, candidate),
    ),
  );
  const hasOtherProvider = runtimeMetas.some(
    (meta) => String(meta?.platform || "").trim().toLowerCase() !== "xenia",
  );
  if (hasOtherProvider) return null;

  const xeniaMeta = runtimeMetas.find(
    (meta) => String(meta?.platform || "").trim().toLowerCase() === "xenia",
  );
  if (xeniaMeta) {
    return { source: "config-metadata", path: rootPath };
  }

  // Avoid recursively probing every unknown generic root. A path hint is not
  // sufficient by itself; confirm it with an actual XDBF-backed GPD first.
  if (!hasXeniaPathHint(rootPath)) return null;
  const gpdPath = findXeniaGpdUnder(
    rootPath,
    Math.max(0, Math.min(7, Number(fallbackDepth) || 6)),
  );
  return gpdPath
    ? { source: "detected-xenia-layout", path: rootPath, gpdPath }
    : null;
}

function hasRpcs3TrophyPair(trophyDir) {
  if (!trophyDir || !isDirectory(trophyDir)) return false;
  try {
    const names = new Set(
      fs
        .readdirSync(trophyDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name.toLowerCase()),
    );
    return names.has(RPCS3_SCHEMA_FILE) && names.has(RPCS3_PROGRESS_FILE);
  } catch {
    return false;
  }
}

function looksLikeRpcs3TrophyContainer(containerPath) {
  if (!containerPath || !isDirectory(containerPath)) return false;
  return listDirectories(containerPath).some((candidate) => {
    const name = path.basename(candidate);
    return /^npwr[0-9a-z_]+$/i.test(name) && hasRpcs3TrophyPair(candidate);
  });
}

function addUniquePath(target, candidatePath, rootPath) {
  if (!candidatePath || !isPathInside(rootPath, candidatePath)) return;
  const normalized = normalizePath(candidatePath);
  if (
    !normalized ||
    target.some((entry) => normalizePath(entry) === normalized)
  ) {
    return;
  }
  target.push(path.resolve(String(candidatePath)));
}

function collectRpcs3ContainersFromStandardLayout(rootPath) {
  const containers = [];
  const homeCandidates = [
    path.join(rootPath, "home"),
    path.join(rootPath, "dev_hdd0", "home"),
  ];
  for (const homePath of homeCandidates) {
    if (!isDirectory(homePath)) continue;
    for (const userPath of listDirectories(homePath)) {
      const trophyPath = path.join(userPath, "trophy");
      if (isDirectory(trophyPath))
        addUniquePath(containers, trophyPath, rootPath);
    }
  }
  return containers;
}

function findRpcs3Containers(rootPath, metas = []) {
  const containers = [];
  const standardContainers = collectRpcs3ContainersFromStandardLayout(rootPath);
  const rootLooksLikeRpcs3 = looksLikeRpcs3TrophyContainer(rootPath);
  const standardLayoutConfirmed = standardContainers.some((candidate) =>
    looksLikeRpcs3TrophyContainer(candidate),
  );
  const rootParts = String(rootPath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  const explicitRpcs3Structure = rootParts.includes("dev_hdd0");
  const metadataContainers = [];
  for (const meta of metas) {
    if (
      String(meta?.platform || "")
        .trim()
        .toLowerCase() !== "rpcs3"
    )
      continue;
    const trophyDir = String(meta?.trophy_path || meta?.save_path || "").trim();
    if (!trophyDir || !isPathInside(rootPath, trophyDir)) continue;
    addUniquePath(metadataContainers, path.dirname(trophyDir), rootPath);
  }
  const rpcs3Confirmed =
    rootLooksLikeRpcs3 ||
    standardLayoutConfirmed ||
    explicitRpcs3Structure ||
    metadataContainers.length > 0;
  if (!rpcs3Confirmed) return containers;

  if (rootLooksLikeRpcs3 || explicitRpcs3Structure) {
    const rootBase = path.basename(rootPath || "").toLowerCase();
    if (rootLooksLikeRpcs3 || rootBase === "trophy") {
      addUniquePath(containers, rootPath, rootPath);
    }
  }
  for (const candidate of standardContainers) {
    addUniquePath(containers, candidate, rootPath);
  }
  for (const candidate of metadataContainers) {
    addUniquePath(containers, candidate, rootPath);
  }
  return containers;
}

function findShadPs4Anchors(rootPath, metas = []) {
  const anchors = [];
  const rootBase = path.basename(rootPath || "").toLowerCase();
  const trophyRoot = path.join(rootPath, "trophy");
  const homeRoot = path.join(rootPath, "home");
  const structurallyDetected =
    rootBase === "shadps4" ||
    (isDirectory(trophyRoot) && isDirectory(homeRoot));
  const relevantMetas = metas.filter((meta) => {
    if (
      String(meta?.platform || "")
        .trim()
        .toLowerCase() !== "shadps4"
    ) {
      return false;
    }
    return [
      meta?.shadps4_schema_path,
      meta?.trophy_path,
      meta?.shadps4_progress_path,
      meta?.save_path,
    ].some((candidate) => candidate && isPathInside(rootPath, candidate));
  });
  if (!structurallyDetected && relevantMetas.length === 0) return [];

  for (const anchor of [
    { kind: "shadps4-schema", path: trophyRoot },
    { kind: "shadps4-home", path: homeRoot },
    { kind: "shadps4-legacy", path: path.join(rootPath, "game_data") },
  ]) {
    // Keep missing standard anchors too: their creation must be observable.
    anchors.push(anchor);
  }
  anchors.push({
    kind: "exact-file",
    path: path.join(rootPath, "log", SHADPS4_LOG_FILE),
  });

  for (const meta of relevantMetas) {
    const schemaPath = String(
      meta?.shadps4_schema_path || meta?.trophy_path || "",
    ).trim();
    const progressPath = String(
      meta?.shadps4_progress_path ||
        (String(meta?.save_path || "")
          .toLowerCase()
          .endsWith(".xml")
          ? meta.save_path
          : ""),
    ).trim();
    if (schemaPath && isPathInside(rootPath, schemaPath)) {
      anchors.push({ kind: "shadps4-schema", path: schemaPath });
    }
    if (progressPath && isPathInside(rootPath, progressPath)) {
      anchors.push({ kind: "exact-file", path: progressPath });
    }
  }
  return anchors;
}

function dedupeAnchors(anchors, rootPath) {
  const seen = new Set();
  const result = [];
  for (const anchor of anchors) {
    if (!anchor?.path || !isPathInside(rootPath, anchor.path)) continue;
    const key = `${anchor.kind}:${normalizePath(anchor.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...anchor, path: path.resolve(anchor.path) });
  }
  return result;
}

function isAncestorOrSame(candidatePath, targetPath) {
  return isPathInside(candidatePath, targetPath);
}

function getRelativeSegments(anchorPath, candidatePath) {
  const relative = path.relative(anchorPath, candidatePath);
  if (!relative || relative === ".") return [];
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(/[\\/]+/).filter(Boolean);
}

function isDirectoryCandidate(stats, candidatePath) {
  if (stats && typeof stats.isDirectory === "function") {
    return stats.isDirectory();
  }
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    // Chokidar can ask about a path before it is fully materialized. Retain
    // the existing extension heuristic so future directories stay visible.
  }
  const base = path.basename(candidatePath || "");
  return !path.extname(base);
}

function shouldIncludeAnchorDescendant(anchor, candidatePath, stats) {
  const segments = getRelativeSegments(anchor.path, candidatePath);
  if (segments === null || segments.length === 0) return true;
  const base = String(segments[segments.length - 1] || "").toLowerCase();
  const directoryCandidate = isDirectoryCandidate(stats, candidatePath);

  if (anchor.kind === "rpcs3-container") {
    if (directoryCandidate) return true;
    return base === RPCS3_SCHEMA_FILE || base === RPCS3_PROGRESS_FILE;
  }
  if (anchor.kind === "rpcs3-home") {
    if (directoryCandidate) {
      if (segments.length === 1) return true;
      if (segments.length === 2) return base === "trophy";
      if (segments.length === 3) return /^npwr[0-9a-z_]+$/i.test(base);
      return false;
    }
    return (
      segments.length === 4 &&
      String(segments[1] || "").toLowerCase() === "trophy" &&
      /^npwr[0-9a-z_]+$/i.test(String(segments[2] || "")) &&
      (base === RPCS3_SCHEMA_FILE || base === RPCS3_PROGRESS_FILE)
    );
  }
  if (anchor.kind === "shadps4-schema") {
    if (directoryCandidate) return true;
    return base === SHADPS4_SCHEMA_FILE;
  }
  if (anchor.kind === "shadps4-home") {
    if (directoryCandidate) {
      if (segments.length === 1) return true;
      if (segments.length === 2) return base === "trophy";
      return false;
    }
    return (
      segments.length === 3 &&
      String(segments[1] || "").toLowerCase() === "trophy" &&
      /^np[a-z0-9_]+\.xml$/i.test(base)
    );
  }
  if (anchor.kind === "xenia-root") {
    if (directoryCandidate) return true;
    return path.extname(base).toLowerCase() === XENIA_GPD_EXTENSION;
  }
  if (anchor.kind === "shadps4-legacy") {
    if (directoryCandidate) return true;
    return base === SHADPS4_SCHEMA_FILE;
  }
  return false;
}

function isRuntimeAuxiliaryFileForAnchor(anchor, candidatePath) {
  if (!isPathInside(anchor.path, candidatePath)) return false;
  const segments = getRelativeSegments(anchor.path, candidatePath);
  if (!segments || segments.length === 0) return false;
  const base = path.basename(candidatePath || "").toLowerCase();
  const parentBase = path
    .basename(path.dirname(candidatePath || ""))
    .toLowerCase();
  const isNativeIcon =
    parentBase === "icons" &&
    (base === "icon0.png" || /^trop\d{3}\.png$/i.test(base));
  const isLocalizedPs4Schema =
    parentBase === "xml" && /^trop_\d{2}\.xml$/i.test(base);

  if (anchor.kind === "rpcs3-container") {
    return (
      segments.length === 2 &&
      /^npwr[0-9a-z_]+$/i.test(String(segments[0] || "")) &&
      (base === "icon0.png" || /^trop\d{3}\.png$/i.test(base))
    );
  }
  if (anchor.kind === "rpcs3-home") {
    return (
      segments.length === 4 &&
      String(segments[1] || "").toLowerCase() === "trophy" &&
      /^npwr[0-9a-z_]+$/i.test(String(segments[2] || "")) &&
      (base === "icon0.png" || /^trop\d{3}\.png$/i.test(base))
    );
  }
  if (anchor.kind === "shadps4-schema" || anchor.kind === "shadps4-legacy") {
    return isNativeIcon || isLocalizedPs4Schema;
  }
  return false;
}

function createTrophyDiscoveryWatchPolicy(rootPath, options = {}) {
  const rawRoot = String(rootPath || "").trim();
  if (!rawRoot) return null;
  const root = path.resolve(rawRoot);
  const metas = Array.isArray(options.metas) ? options.metas : [];
  const fallbackDepth = Math.max(0, Number(options.fallbackDepth) || 6);
  const rpcs3Containers = findRpcs3Containers(root, metas);
  const xeniaEvidence = findXeniaRootEvidence(root, metas, fallbackDepth);
  const anchors = [
    ...rpcs3Containers.map((container) => ({
      kind: "rpcs3-container",
      path: container,
    })),
    ...findShadPs4Anchors(root, metas),
    ...(xeniaEvidence ? [{ kind: "xenia-root", path: root }] : []),
  ];
  for (const container of rpcs3Containers) {
    const userPath = path.dirname(container);
    const homePath = path.dirname(userPath);
    if (
      path.basename(container).toLowerCase() === "trophy" &&
      path.basename(homePath).toLowerCase() === "home" &&
      isPathInside(root, homePath)
    ) {
      anchors.push({ kind: "rpcs3-home", path: homePath });
    }
  }
  const normalizedAnchors = dedupeAnchors(anchors, root);
  if (normalizedAnchors.length === 0) return null;

  const hasRpcs3 = normalizedAnchors.some(
    (anchor) =>
      anchor.kind === "rpcs3-container" || anchor.kind === "rpcs3-home",
  );
  const hasShadPs4 = normalizedAnchors.some(
    (anchor) =>
      anchor.kind.startsWith("shadps4-") || anchor.kind === "exact-file",
  );
  const hasXenia = normalizedAnchors.some(
    (anchor) => anchor.kind === "xenia-root",
  );
  const mode =
    hasXenia && (hasRpcs3 || hasShadPs4)
      ? "emulator-targeted-mixed"
      : hasXenia
        ? "xenia-targeted"
        : hasRpcs3 && hasShadPs4
          ? "trophy-targeted-mixed"
          : hasRpcs3
            ? "rpcs3-targeted"
            : "shadps4-targeted";

  return {
    mode,
    source:
      hasXenia && !hasRpcs3 && !hasShadPs4
        ? xeniaEvidence.source
        : "detected-trophy-layout",
    // Retain the existing maximum depth. Filtering narrows files/subtrees while
    // preserving unusual but currently supported folder placements.
    depth: fallbackDepth,
    targetCount: normalizedAnchors.length,
    preserveGenericDiscovery: false,
    anchors: normalizedAnchors,
    isRuntimeAuxiliaryFile(candidatePath) {
      return normalizedAnchors.some((anchor) =>
        isRuntimeAuxiliaryFileForAnchor(anchor, candidatePath),
      );
    },
    shouldIgnore(candidatePath, stats, context = {}) {
      if (!candidatePath) return true;
      if (normalizePath(candidatePath) === normalizePath(root)) return false;
      if (
        context.allowRuntimeAuxiliaryFiles === true &&
        normalizedAnchors.some((anchor) =>
          isRuntimeAuxiliaryFileForAnchor(anchor, candidatePath),
        )
      ) {
        return false;
      }
      for (const anchor of normalizedAnchors) {
        if (anchor.kind === "exact-file") {
          if (
            normalizePath(candidatePath) === normalizePath(anchor.path) ||
            isAncestorOrSame(candidatePath, anchor.path)
          ) {
            return false;
          }
          continue;
        }
        if (isAncestorOrSame(candidatePath, anchor.path)) return false;
        if (isPathInside(anchor.path, candidatePath)) {
          return !shouldIncludeAnchorDescendant(anchor, candidatePath, stats);
        }
      }
      return true;
    },
  };
}

module.exports = {
  RPCS3_PROGRESS_FILE,
  RPCS3_SCHEMA_FILE,
  SHADPS4_LOG_FILE,
  SHADPS4_SCHEMA_FILE,
  createTrophyDiscoveryWatchPolicy,
};
