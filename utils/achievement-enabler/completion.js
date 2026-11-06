"use strict";

const { stripVTControlCharacters } = require("util");

const TERMINAL_STATUSES = new Set(["finished", "warning", "attention", "interrupted", "failed", "stopped"]);
const isTerminalStatus = status => TERMINAL_STATUSES.has(status);
function expectsSelfDelete(source) {
  const commands = source.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !/^rem(?:\s|$)/i.test(line));
  return /^del\s+\/q\s+"%~f0"\s*>\s*nul\s+2>&1$/i.test(commands.at(-1) || "");
}

// Keep diagnostic categories across the stream, never credentials or raw text.
function createDiagnosticTracker() {
  let pending = "", hasWarnings = false, hasErrors = false, reason = "", declined = false, inBlock = false;
  function line(text) {
    const value = stripVTControlCharacters(text).trim();
    if (/Continue anyway\? \[Y\/N\]:\s*N\b/i.test(value)) declined = true;
    if (!/^\[(?:WARN(?:ING)?|ERROR)\]/i.test(value)) {
      inBlock = false;
      if (/^\[INFO\]|^(?:Generating|Writing|Creating|Fetching|Detecting|Copying|Cleanup complete\.|SETUP COMPLETE)/i.test(value)) reason = "";
      return;
    }
    if (!inBlock) reason = "";
    inBlock = true;
    hasWarnings ||= /^\[WARN/i.test(value);
    hasErrors ||= /^\[ERROR\]/i.test(value);
    if (/cached GSE Tools version .*ships a broken generate_emu_config\.exe/i.test(value)) reason = "gseTools";
    else if (/dummy_account\.txt.*not found|(?:username|password).*missing or empty in dummy_account\.txt/i.test(value)) reason = "credentials";
    else if (/^\[ERROR\]/i.test(value) && /requires Python|Python.*(?:was not|wasn't) found|asset pack.*(?:not found|missing required)|(?:uplay_r[12]\.ini|upc_r[12]\.ini|installerdata\.xml|origin_helper\.py).*not found|No \.exe files found|Please reinstall the game without/i.test(value)) reason = "requirements";
    else if (/After the above steps, rerun the script/i.test(value)) reason = "requirements";
    else if (/Failed to fetch required tooling|(?:Failed|Could not|Unable) to download|Extraction failed/i.test(value)) reason = "download";
    else if (/Failed to (?:create save folder|patch .*\.ini|write|copy)|Could not switch to script folder/i.test(value)) reason = "write";
    else if (/Could not determine an adapter|No adapters found|find_paths\.ps1 did not produce/i.test(value)) reason = "adapter";
  }
  return {
    append(data) {
      const lines = (pending + data).split(/\r\n|[\r\n]/);
      pending = lines.pop().slice(-16384);
      for (const text of lines) line(text);
    },
    snapshot() { line(pending); return { hasWarnings, hasErrors, reason, declined }; },
  };
}

function classifyCompletion(exitCode, output, scriptMissing, diagnostics, selfDeleteExpected = false) {
  if (!diagnostics) {
    const tracker = createDiagnosticTracker(); tracker.append(output); diagnostics = tracker.snapshot();
  }
  const { hasWarnings = false, hasErrors = false, reason = "", declined = false } = diagnostics;
  const result = (status, completionReason, resultReason = "") => ({ status, exitCode, completionReason, resultReason, hasWarnings, hasErrors });
  let completionReason = "exit-code";
  let completed = exitCode === 0;
  if (exitCode === 1 && scriptMissing) {
    const lines = stripVTControlCharacters(output).split(/[\r\n]+/).map(line => line.trim());
    const cleanup = lines.lastIndexOf("Cleanup complete.");
    const setup = lines.lastIndexOf("SETUP COMPLETE");
    const launch = lines.lastIndexOf("Launch the game from the desktop shortcut that was just created.");
    const missing = lines.lastIndexOf("The batch file cannot be found.");
    // The shell's missing-batch message is localized by Windows. A verified
    // final self-delete command provides the same evidence on other locales.
    if (cleanup >= 0 && setup > cleanup && launch > setup && (missing > launch || selfDeleteExpected) &&
        !lines.slice(setup + 1).some(line => /^\[ERROR\]/i.test(line))) {
      completed = true; completionReason = "upstream-self-delete";
    }
  }
  if (completed) return result(hasWarnings || hasErrors ? "warning" : "finished", completionReason);
  if (declined) return result("stopped", "user-declined");
  if (["gseTools", "credentials", "requirements"].includes(reason)) return result("attention", "prerequisite", reason);
  if (["download", "write", "adapter"].includes(reason)) return result("failed", "diagnostic-error", reason);
  if (hasErrors) return result("failed", "diagnostic-error");
  return result("interrupted", "unknown-exit");
}

module.exports = { classifyCompletion, createDiagnosticTracker, isTerminalStatus, expectsSelfDelete };
