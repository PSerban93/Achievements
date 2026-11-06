"use strict";

const { createRequire } = require("module");
const path = require("path");
const { createWindowsSession } = require("./process-host");
let session = null;
let runId = "";
let output = "";
let flushTimer = null;
const send = message => process.parentPort.postMessage(message);
function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  if (output) { send({ type: "output", runId, data: output }); output = ""; }
}
process.parentPort.on("message", ({ data: message }) => {
  try {
    if (message.type === "start") {
      if (session && !session.finished) throw new Error("A session is already running.");
      runId = message.runId;
      const appRequire = createRequire(path.join(message.appPath, "package.json"));
      session = createWindowsSession({
        pty: appRequire("node-pty"), koffi: appRequire("koffi"),
        script: message.script, folder: message.folder, gatePath: message.gatePath,
        onData(data) {
          output += data;
          if (output.length >= 32768) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, 40);
        },
        onState(state) { flush(); send({ type: "state", runId, ...state }); },
      });
    } else if (message.runId === runId) {
      if (message.type === "input") session?.input(message.text, message.raw === true);
      if (message.type === "resize") session?.resize(message.cols, message.rows);
      if (message.type === "stop") session?.stop();
    }
  } catch (error) {
    send({ type: "error", runId, fatal: message.type === "start", error: error.message || String(error) });
  }
});
process.on("exit", () => { try { session?.stop(); } catch {} });
