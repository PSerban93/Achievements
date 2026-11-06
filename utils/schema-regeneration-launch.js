"use strict";

const fs = require("fs");
const path = require("path");
const finder = require("./game-executable-finder");
const { writeJsonAtomicSync } = require("./atomic-json-store");
const { gameProcessName, resolveGameProcessName } = require("./game-launch-process");
const { hasProcessNameValue, normalizeProcessNameList, normalizeProcessNameValue } = require("./process-name-utils");

const text = value => typeof value === "string" ? value.trim() : "";
const hasProcess = value => hasProcessNameValue(value, { splitString: true });
const gameProcesses = value => normalizeProcessNameValue(
  normalizeProcessNameList(value, { splitString: true }).map(gameProcessName).filter(Boolean),
);

function normalizeSchemaLaunchMetadata(value = {}) {
  const relative = text(value.relative_executable);
  return {
    process_name: gameProcesses(value.process_name) || gameProcesses(relative),
    relative_executable: relative,
    relative_working_directory: text(value.relative_working_directory),
    arguments: text(value.arguments),
    displayName: text(value.displayName),
  };
}

function mergeSchemaLaunchMetadata(previous, incoming) {
  const before = normalizeSchemaLaunchMetadata(previous || {});
  const next = normalizeSchemaLaunchMetadata(incoming || {});
  return Object.fromEntries(Object.keys(before).map(key => [key, before[key] || next[key]]));
}

// Enrichment is optional and applies to this exact config, after schema validation.
// Re-read after asynchronous lookups and skip conflicting edits or exports.
async function enrichRegeneratedConfigLaunch({ filePath, appid, platform, metadata, logger }, dependencies = {}) {
  const find = dependencies.findExecutable || finder.findExecutable;
  const lookupSteam = dependencies.lookupSteamMetadata || (id =>
    require("./steamdb-launch-metadata").fetchSteamDbLaunchMetadata(id));
  const resolveProcess = dependencies.resolveProcess || resolveGameProcessName;
  const write = dependencies.write || writeJsonAtomicSync;
  const log = (level, event, detail) => {
    try { logger?.[level]?.(event, { configName: path.basename(filePath, ".json"), appid, platform, ...detail }); } catch {}
  };
  try {
    const before = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (String(before.appid) !== String(appid) || before.platform !== platform) {
      return { updated: false, status: "config-changed" };
    }
    if (hasProcess(before.process_name) && text(before.executable)) {
      return { updated: false, status: "unchanged" };
    }
    const draft = structuredClone(before);
    let launch = normalizeSchemaLaunchMetadata(metadata || {});
    if (!hasProcess(draft.process_name)) {
      draft.process_name = launch.process_name || gameProcesses(await resolveProcess(text(draft.executable)));
      const lookupId = platform === "steam" ? String(appid) :
        platform === "uplay" ? String(before.steamAppId || "") : "";
      if (!hasProcess(draft.process_name) && /^\d+$/.test(lookupId)) {
        try {
          launch = mergeSchemaLaunchMetadata(launch, await lookupSteam(lookupId));
          draft.process_name = launch.process_name;
        } catch (error) {
          log("warn", "schema:regenerate-launch-lookup-failed", { error: error.message });
        }
      }
    }

    // A declared executable for another launch variant must not outrank the
    // existing process names selected by the user.
    const processName = hasProcess(draft.process_name) ? draft.process_name : "";
    const acceptsRelative = relative => !relative || !hasProcess(processName) ||
      normalizeProcessNameList(processName, { splitString: true }).some(name =>
        path.win32.basename(name).toLowerCase() === path.win32.basename(relative).toLowerCase());
    if (!acceptsRelative(launch.relative_executable)) {
      launch = { ...launch, relative_executable: "", relative_working_directory: "" };
    }
    if (draft.launch_metadata && !acceptsRelative(draft.launch_metadata.relative_executable)) {
      draft.launch_metadata = { ...draft.launch_metadata, relative_executable: "", relative_working_directory: "" };
    }
    let searchStatus = "existing";
    if (!text(draft.executable) && finder.supported(draft)) {
      try {
        const search = await find({ ...draft, displayName: launch.displayName || draft.displayName || draft.name }, {
          metadata: { ...launch, process_name: processName },
          extended: true,
          context: finder.createSearchContext({ timeLimitMs: 20_000, maxDirectories: 1500 }),
        });
        searchStatus = search.status;
        log(search.truncated ? "warn" : "info", "schema:regenerate-executable-search", {
          status: search.status, truncated: !!search.truncated,
          candidates: search.candidates?.length || 0, diagnostics: search.diagnostics || null,
        });
        if (search.status === "found" && !search.truncated) finder.applyCandidate(draft, search.candidate);
      } catch (error) {
        searchStatus = "error";
        log("warn", "schema:regenerate-executable-search-failed", { error: error.message });
      }
    }
    // Existing user values stay exact. An initially empty field may include
    // the confirmed game runtime behind a newly discovered AE launcher.
    draft.process_name = hasProcess(before.process_name) ? before.process_name : gameProcesses(draft.process_name);
    const latest = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const unchangedFields = [
      "name", "displayName", "appid", "platform", "save_path", "process_name", "executable",
      "arguments", "working_directory", "launch_metadata", "install_root", "install_path", "ea_install_path",
      "steamAppId", "epic_namespace", "epic_catalog_item_id", "epic_app_name",
    ];
    if (unchangedFields.some(key => JSON.stringify(latest[key]) !== JSON.stringify(before[key]))) {
      log("info", "schema:regenerate-launch-skipped", { reason: "config-changed" });
      return { updated: false, status: "config-changed", searchStatus };
    }
    const fields = [];
    if (!hasProcess(latest.process_name) && hasProcess(draft.process_name)) {
      latest.process_name = draft.process_name;
      fields.push("process_name");
    }
    if (!text(latest.executable) && text(draft.executable)) {
      latest.executable = draft.executable;
      fields.push("executable");
      if (!text(latest.working_directory) && text(draft.working_directory)) {
        latest.working_directory = draft.working_directory;
        fields.push("working_directory");
      }
      if (!text(latest.arguments) && text(draft.arguments)) {
        latest.arguments = draft.arguments;
        fields.push("arguments");
      }
    }
    if (!fields.length) return { updated: false, status: "unchanged", searchStatus };
    write(filePath, latest, { backup: true });
    log("info", "schema:regenerate-launch-updated", {
      configName: latest.name, fields, process_name: latest.process_name || null, executable: latest.executable || null,
    });
    return { updated: true, status: "updated", fields, searchStatus };
  } catch (error) {
    log("warn", "schema:regenerate-launch-failed", { error: error.message });
    return { updated: false, status: "error", error: error.message };
  }
}

module.exports = { normalizeSchemaLaunchMetadata, mergeSchemaLaunchMetadata, enrichRegeneratedConfigLaunch };
