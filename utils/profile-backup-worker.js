const { parentPort, workerData } = require("worker_threads");
const {
  createProfileBackup,
  inspectProfileBackup,
  stageProfileRestore,
} = require("./profile-backup");

function compact(result) {
  return {
    destinationPath: result?.destinationPath || null,
    stagedArchive: result?.stagedArchive || null,
    summary: result?.summary || result?.manifest?.summary || {},
    manifest: result?.manifest
      ? {
          formatVersion: result.manifest.formatVersion,
          createdAt: result.manifest.createdAt || null,
          appVersion: result.manifest.appVersion || null,
          sourceUserDataRoot: result.manifest.sourceUserDataRoot || null,
        }
      : null,
  };
}

function reportProgress(progress = {}) {
  try {
    parentPort.postMessage({ type: "progress", progress });
  } catch {}
}

(async () => {
  try {
    let result;
    switch (workerData?.action) {
      case "export":
        result = await createProfileBackup({
          ...(workerData.payload || {}),
          onProgress: reportProgress,
        });
        break;
      case "inspect":
        result = await inspectProfileBackup(workerData?.payload?.archivePath);
        break;
      case "stage":
        result = await stageProfileRestore({
          ...(workerData.payload || {}),
          onProgress: reportProgress,
        });
        break;
      default:
        throw new Error("Unknown profile backup worker action.");
    }
    parentPort.postMessage({ ok: true, result: compact(result) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || null,
    });
  }
})();
