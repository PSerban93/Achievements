"use strict";

const { app } = require("electron");

function getProcesses(provider) {
  return new Promise((resolve, reject) => {
    try {
      provider.getAllProcesses(
        (list) => resolve(list),
        provider.ProcessDataFlag.None,
      );
    } catch (error) {
      reject(error);
    }
  });
}

app
  .whenReady()
  .then(async () => {
    if (process.platform !== "win32") {
      console.log("windows-process-tree verification skipped: Windows only");
      app.exit(0);
      return;
    }
    const provider = require("@vscode/windows-process-tree");
    if (
      typeof provider.getAllProcesses !== "function" ||
      !provider.ProcessDataFlag
    ) {
      throw new Error("windows-process-tree API contract is invalid");
    }
    const processes = await getProcesses(provider);
    if (!Array.isArray(processes) || processes.length === 0) {
      throw new Error("windows-process-tree returned an empty or invalid snapshot");
    }
    const validEntry = processes.find(
      (entry) =>
        Number.isFinite(Number(entry?.pid)) &&
        Number(entry.pid) > 0 &&
        String(entry?.name || "").trim(),
    );
    if (!validEntry) {
      throw new Error("windows-process-tree returned no valid process entries");
    }
    console.log(
      `windows-process-tree verification passed (${processes.length} processes)`,
    );
    app.exit(0);
  })
  .catch((error) => {
    console.error(
      `windows-process-tree verification failed: ${error?.stack || error}`,
    );
    app.exit(1);
  });
