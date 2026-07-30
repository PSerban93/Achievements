"use strict";

const { spawn } = require("child_process");

const electronPath = require("electron");
const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node build/run-electron-script.js <script> [...args]");
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Electron verification terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(Number.isInteger(code) ? code : 1);
});
