"use strict";

const fs = require("fs");
const path = require("path");
const { parentPort } = require("node:worker_threads");
const state = require("./x360-recomp-state");
const { readProgressCandidate, discoverGames, inside } = require("./x360-recomp-discovery");

parentPort.on("message", async ({ requestId, file, explicit, root, configs, blockedPaths, skipExisting }) => {
  try {
    if (root) {
      const discovery = await discoverGames(root, { ...explicit, existingConfigs: configs,
        isBlocked: (candidate) => blockedPaths.some((blocked) => inside(blocked, candidate)) || configs.some((config) =>
          skipExisting && inside(root, config.x360_recomp_install_root) && !state.samePath(root, config.x360_recomp_install_root) &&
            inside(config.x360_recomp_install_root, candidate) ||
          !inside(root, config.x360_recomp_install_root) && Object.values(config.x360_recomp_progress || {}).some((entry) =>
            state.hasConfirmedProgress({ x360_recomp_progress: { entry } }) && state.samePath(entry.file, candidate))) });
      parentPort.postMessage({ requestId, discovery });
      return;
    }
    // The discovery watcher never follows directory links. Enforce that also
    // for direct candidate requests from a confirmed profile directory.
    let ancestor = file;
    while (true) {
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Linked recomp progress source");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    let item = readProgressCandidate(file);
    if (item && explicit && item.id === explicit.titleId && item.format !== "tsv") {
      item.profile = explicit.profile; item.descriptor = explicit.descriptor;
    }
    if (!item && explicit) item = { id: explicit.titleId, profile: explicit.profile,
      format: explicit.descriptor.format, file, userRoot: path.dirname(file), descriptor: explicit.descriptor };
    if (item) {
      const snapshot = state.readSnapshot(file, {}, { titleId: item.id, descriptor: item.descriptor || { format: item.format } });
      if (!snapshot.valid) item = null;
      else { item.snapshot = snapshot.snapshot; item.mtimeMs = fs.statSync(file).mtimeMs; }
    }
    parentPort.postMessage({ requestId, item });
  } catch (error) {
    parentPort.postMessage({ requestId, item: null, error: error.code === "ENOENT" ? null : error.message, discoveryError: !!root });
  }
});
