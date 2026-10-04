"use strict";

const { verifyPinnedWindowsSignature } = require("../utils/windows-code-signature");

async function main() {
  if (process.argv.length < 3) throw new Error("Usage: node build/verify-self-signed.js <installer-or-exe> [...files]");
  for (const file of process.argv.slice(2)) {
    const result = await verifyPinnedWindowsSignature(file);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
