"use strict";

const { spawnSync } = require("child_process");

function isAchievementRecorderBuildSupported(platform = process.platform) {
  return platform === "win32";
}

function prepareAchievementRecorder() {
  if (!isAchievementRecorderBuildSupported()) {
    console.log(
      `Native Windows helpers preparation skipped: unsupported on ${process.platform}.`,
    );
    return 0;
  }

  const npmExecPath = String(process.env.npm_execpath || "").trim();
  if (!npmExecPath) {
    console.error(
      "Native Windows helpers preparation failed: npm_execpath is unavailable.",
    );
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    [npmExecPath, "run", "prepare:recorder:windows"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
    },
  );

  if (result.error) {
    console.error(
      `Native Windows helpers preparation failed: ${result.error.message}`,
    );
    return 1;
  }
  if (result.signal) {
    console.error(
      `Native Windows helpers preparation terminated by ${result.signal}.`,
    );
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = prepareAchievementRecorder();
}

module.exports = {
  isAchievementRecorderBuildSupported,
  prepareAchievementRecorder,
};
