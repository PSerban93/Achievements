"use strict";

const path = require("path");
const { verifyPinnedWindowsSignature, policy } = require("./windows-code-signature");

function createWindowsUpdateSigning(updater, { enabled, logger }) {
  const enforce = enabled && process.platform === "win32" && policy.enforceWindowsUpdates === true;
  let verified = null;
  let generation = 0;
  if (enforce) {
    // This hook handles fresh downloads. The updater's cache reuse path skips
    // it, so downloaded events and explicit installation are also checked.
    updater.verifyUpdateCodeSignature = async (_publisherNames, file) => {
      try { await verifyPinnedWindowsSignature(file); return null; }
      catch (error) { return error.message || "Windows update signature verification failed"; }
    };
  }
  return {
    invalidate() { generation++; verified = null; },
    async validateDownloaded(info) {
      if (!enforce) return;
      const current = ++generation;
      verified = null;
      const file = info?.downloadedFile;
      const expectedSha512 = info?.files?.find(item => /\.exe(?:$|\?)/i.test(item.url || ""))?.sha512 || info?.sha512;
      if (!file || !expectedSha512) throw new Error("Downloaded Windows update has incomplete verification metadata");
      const result = await verifyPinnedWindowsSignature(file, { expectedSha512 });
      if (current !== generation) throw new Error("Windows update verification was superseded");
      if (!updater.installerPath || path.resolve(updater.installerPath) !== result.file) {
        throw new Error("Verified installer does not match the updater installation path");
      }
      verified = result;
      logger.info("app-update:signature-verified", { file: result.file, signers: result.signers });
    },
    async verifyReadyToInstall() {
      if (!enforce) return;
      const ready = verified;
      const current = generation;
      if (!ready || !updater.installerPath || path.resolve(updater.installerPath) !== ready.file) {
        throw new Error("No verified Windows update is ready for installation");
      }
      await verifyPinnedWindowsSignature(ready.file, { expectedSha512: ready.sha512 });
      if (current !== generation || verified !== ready) throw new Error("Windows update changed before installation");
    },
  };
}

module.exports = { createWindowsUpdateSigning };
