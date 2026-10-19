"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { extractSpaFromXex } = require("./x360-recomp-xex");
try {
  const result = extractSpaFromXex(workerData.file, workerData.titleId);
  // Transfer only the SPA, not the original/decompressed executable buffer.
  const bytes = Uint8Array.from(result.spa);
  parentPort.postMessage({ ok: true, ...result, spa: bytes }, [bytes.buffer]);
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.code || "XEX_DECODE", error: error.message });
}
