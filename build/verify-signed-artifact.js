"use strict";

const { verifyWindowsSignatures } = require("./verify-windows-signatures");

module.exports = async (event) => {
  if (event.packager?.platform?.nodeName !== "win32" ||
      event.packager.config.forceCodeSigning !== true ||
      !event.file || !/\.(?:exe|msi)$/i.test(event.file)) return;
  await verifyWindowsSignatures([event.file]);
};
