"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("../atomic-json-store");

const JOURNAL = "update-transaction.json";
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const exists = async file => {
  try { return await fsp.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};

async function checkedFolder(root, folder, scratch = false) {
  const releases = path.resolve(root, "releases"), target = path.resolve(folder);
  if (!same(path.dirname(target), releases) || scratch && !/^\.(?:update|rollback)-[0-9a-f-]{36}$/i.test(path.basename(target))) {
    throw new Error("Unsafe Achievement Enabler update folder.");
  }
  const info = await exists(target);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("An update folder is not a regular directory.");
  if (info) {
    const relative = path.relative(await fsp.realpath(releases), await fsp.realpath(target));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("An update folder leaves the installation.");
  }
  return info;
}

async function removeStaging(root, folder) {
  // Only transaction-owned directories directly under releases can be removed.
  if (await checkedFolder(root, folder, true)) await fsp.rm(path.resolve(folder), { recursive: true, force: true });
}

async function move(root, source, destination) {
  if (!await checkedFolder(root, source)) throw new Error("An update source folder is missing.");
  if (await checkedFolder(root, destination)) throw new Error("An update destination already exists.");
  await fsp.rename(source, destination);
}

async function recoverUpdate(root, stateFile) {
  const journalFile = path.join(root, JOURNAL), info = await exists(journalFile);
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error("Invalid Achievement Enabler update journal.");
  const journal = JSON.parse(await fsp.readFile(journalFile, "utf8"));
  if (journal.version !== 1 || typeof journal.installationId !== "string" || !/^[0-9a-f-]{36}$/i.test(journal.installationId) ||
      typeof journal.destination !== "string" || typeof journal.stage !== "string" || typeof journal.backup !== "string" || typeof journal.hadPrevious !== "boolean") {
    throw new Error("Invalid Achievement Enabler update journal.");
  }
  const destination = path.resolve(root, journal.destination), stage = path.resolve(root, journal.stage), backup = path.resolve(root, journal.backup);
  await checkedFolder(root, destination); await checkedFolder(root, stage, true); await checkedFolder(root, backup, true);
  if (same(destination, stage) || same(destination, backup) || same(stage, backup)) throw new Error("Invalid Achievement Enabler update paths.");
  let current = {};
  try { current = JSON.parse(await fsp.readFile(stateFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const committed = current.installationId === journal.installationId && typeof current.active === "string" && same(path.resolve(root, current.active), destination);
  if (!committed) {
    if (await exists(backup)) {
      if (await exists(destination)) { await removeStaging(root, stage); await move(root, destination, stage); }
      await move(root, backup, destination);
    } else if (!journal.hadPrevious && await exists(destination)) {
      await removeStaging(root, stage); await move(root, destination, stage);
    } else if (journal.hadPrevious && !await exists(destination)) {
      throw new Error("The previous Achievement Enabler installation cannot be restored.");
    }
  }
  await removeStaging(root, stage);
  await removeStaging(root, backup);
  await fsp.unlink(journalFile);
}

async function commitUpdate({ root, stateFile, stage, destination, nextState, signal }) {
  await checkedFolder(root, stage, true);
  const hadPrevious = !!await checkedFolder(root, destination);
  const backup = path.join(root, "releases", `.rollback-${crypto.randomUUID()}`);
  const journalFile = path.join(root, JOURNAL);
  signal?.throwIfAborted();
  await writeJsonAtomic(journalFile, {
    version: 1, installationId: nextState.installationId, hadPrevious,
    destination: path.relative(root, destination), stage: path.relative(root, stage), backup: path.relative(root, backup),
  }, { backup: false });
  try {
    if (hadPrevious) await move(root, destination, backup);
    await move(root, stage, destination);
    signal?.throwIfAborted();
    await writeJsonAtomic(stateFile, nextState, { backup: false });
  } catch (error) {
    try { await recoverUpdate(root, stateFile); }
    catch (recoveryError) { error.recoveryError = recoveryError; }
    throw error;
  }
  // Once metadata is committed, a cleanup failure must not roll back a valid
  // installation. The retained journal permits cleanup on the next opening.
  try { await recoverUpdate(root, stateFile); return null; }
  catch (error) { return error; }
}

module.exports = { JOURNAL, recoverUpdate, commitUpdate, removeStaging };
