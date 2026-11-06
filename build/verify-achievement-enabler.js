"use strict";

const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createWindowsSession } = require("../utils/achievement-enabler/process-host");

app.whenReady().then(async () => {
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log("Achievement Enabler verification skipped: Windows x64 only");
    return;
  }
  for (const file of [
    "@xterm/xterm/lib/xterm.js", "@xterm/xterm/css/xterm.css", "@xterm/addon-fit/lib/addon-fit.js",
    "node-pty/lib/worker/conoutSocketWorker.js",
  ]) fs.accessSync(path.join(__dirname, "..", "node_modules", file));

  const tempRoot = path.resolve(os.tmpdir());
  const folder = fs.mkdtempSync(path.join(tempRoot, "Achievements-Enabler-build-check-"));
  const script = path.join(folder, "runtime-check.bat");
  const probe = path.join(folder, "hash-probe.txt");
  fs.writeFileSync(probe, "Achievements PowerShell module compatibility check");
  const expectedHash = crypto.createHash("sha1").update(fs.readFileSync(probe)).digest("hex").toUpperCase();
  fs.writeFileSync(script, [
    "@echo off",
    "setlocal EnableDelayedExpansion",
    'set "PROBE_HASH="',
    `for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '${probe}' -Algorithm SHA1).Hash"') do set "PROBE_HASH=%%H"`,
    `if /I not "!PROBE_HASH!"=="${expectedHash}" exit /b 2`,
    "echo ACHIEVEMENTS_ENABLER_RUNTIME_OK",
    "exit /b 0", "",
  ].join("\r\n"));
  // Simulate npm start from a shell whose module path is incompatible with
  // Windows PowerShell; the session must initialize its own built-in modules.
  const sessionEnv = { ...process.env };
  for (const key of Object.keys(sessionEnv)) if (key.toLowerCase() === "psmodulepath") delete sessionEnv[key];
  sessionEnv.pSmOdUlEpAtH = path.join(folder, "incompatible-modules");
  let session, timer, output = "";
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => { session?.stop(); reject(new Error("Achievement Enabler runtime timed out.")); }, 15000);
      session = createWindowsSession({
        pty: require("node-pty"), koffi: require("koffi"), folder, script,
        env: sessionEnv,
        gatePath: path.join(__dirname, "..", "utils", "achievement-enabler", "gate.ps1"),
        onData: data => { output += data; },
        onState: state => {
          if (state.status === "finished") {
            if (state.exitCode === 0 && output.includes("ACHIEVEMENTS_ENABLER_RUNTIME_OK")) resolve();
            else reject(new Error("Achievement Enabler runtime result is invalid."));
          } else if (state.status === "failed") reject(new Error(state.error || "Achievement Enabler runtime failed."));
        },
      });
    });
    console.log(`Achievement Enabler runtime verified: Electron ${process.versions.electron}, ConPTY, process ownership, terminal assets and nested PowerShell Get-FileHash with an incompatible inherited module path`);
  } finally {
    clearTimeout(timer);
    session?.stop();
    if (path.dirname(folder) === tempRoot && path.basename(folder).startsWith("Achievements-Enabler-build-check-")) {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}).then(() => app.exit(0)).catch(error => { console.error(error.stack || error); app.exit(1); });
