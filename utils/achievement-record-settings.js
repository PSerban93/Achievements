"use strict";

const ACHIEVEMENT_RECORD_FPS_VALUES = Object.freeze([30, 60]);
const ACHIEVEMENT_RECORD_DURATION_VALUES = Object.freeze([
  10, 15, 20, 25, 30,
]);
const ACHIEVEMENT_RECORD_FPS_OPTIONS = new Set(
  ACHIEVEMENT_RECORD_FPS_VALUES,
);
const ACHIEVEMENT_RECORD_DURATION_OPTIONS = new Set(
  ACHIEVEMENT_RECORD_DURATION_VALUES,
);
const DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES = Object.freeze({
  disableAchievementRecords: true,
  enableHdrRecords: false,
  recordFps: 30,
  recordDurationSeconds: 20,
});

function normalizeAchievementRecordFps(value, fallback = 30) {
  const parsed = Number.parseInt(value, 10);
  return ACHIEVEMENT_RECORD_FPS_OPTIONS.has(parsed) ? parsed : fallback;
}

function normalizeAchievementRecordDuration(value, fallback = 20) {
  const parsed = Number.parseInt(value, 10);
  return ACHIEVEMENT_RECORD_DURATION_OPTIONS.has(parsed) ? parsed : fallback;
}

function normalizeAchievementRecordPreferences(prefs = {}, defaults = {}) {
  const source = prefs && typeof prefs === "object" ? prefs : {};
  const fallback = {
    ...DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES,
    ...(defaults && typeof defaults === "object" ? defaults : {}),
  };
  return {
    ...source,
    disableAchievementRecords:
      typeof source.disableAchievementRecords === "boolean"
        ? source.disableAchievementRecords
        : fallback.disableAchievementRecords === true,
    enableHdrRecords:
      typeof source.enableHdrRecords === "boolean"
        ? source.enableHdrRecords
        : fallback.enableHdrRecords === true,
    recordFps: normalizeAchievementRecordFps(
      source.recordFps,
      normalizeAchievementRecordFps(fallback.recordFps, 30),
    ),
    recordDurationSeconds: normalizeAchievementRecordDuration(
      source.recordDurationSeconds,
      normalizeAchievementRecordDuration(fallback.recordDurationSeconds, 20),
    ),
  };
}

function getAchievementRecorderTimings(prefs = {}) {
  const fps = normalizeAchievementRecordFps(prefs?.recordFps, 30);
  const durationSeconds = normalizeAchievementRecordDuration(
    prefs?.recordDurationSeconds,
    20,
  );
  const halfDurationMs = Math.round((durationSeconds * 1000) / 2);
  return {
    fps,
    preMs: halfDurationMs,
    postMs: halfDurationMs,
    segmentMs: 2_000,
    hdrToneMapping: prefs?.enableHdrRecords === true,
  };
}

function shouldEnableAchievementRecorder(options = {}) {
  const platform = String(options.platform || process.platform);
  const prefs =
    options.prefs && typeof options.prefs === "object" ? options.prefs : {};
  const configName = String(options.configName || "").trim();
  return (
    platform === "win32" &&
    prefs.disableAchievementRecords === false &&
    options.configMode === "active" &&
    configName.length > 0
  );
}

module.exports = {
  ACHIEVEMENT_RECORD_DURATION_VALUES,
  ACHIEVEMENT_RECORD_FPS_VALUES,
  DEFAULT_ACHIEVEMENT_RECORD_PREFERENCES,
  getAchievementRecorderTimings,
  normalizeAchievementRecordDuration,
  normalizeAchievementRecordFps,
  normalizeAchievementRecordPreferences,
  shouldEnableAchievementRecorder,
};
