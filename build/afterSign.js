"use strict";

const fs = require("fs");
const path = require("path");
const { executableContentHash } = require("./windows-executable-integrity");
const { verifyWindowsSignatures } = require("./verify-windows-signatures");

module.exports = async (context) => {
  if (context.electronPlatformName !== "win32") return;
  const projectDir = context.packager.projectDir;
  const files = [path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)];
  for (const name of ["achievements-recorder.exe", "achievements-hdr-screenshot.exe"]) {
    const source = path.join(projectDir, "utils", "native", name);
    const packaged = path.join(context.appOutDir, "resources", "app.asar.unpacked", "utils", "native", name);
    if (executableContentHash(fs.readFileSync(source)) !== executableContentHash(fs.readFileSync(packaged))) {
      throw new Error(`afterSign: packaged native helper content changed: ${name}`);
    }
    files.push(packaged);
  }
  if (context.packager.config.forceCodeSigning === true) {
    await verifyWindowsSignatures(files);
  }
};
