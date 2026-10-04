"use strict";

const { execFile } = require("child_process");
const path = require("path");
const { verifyPinnedWindowsSignature } = require("../utils/windows-code-signature");

function verifyWindowsSignatures(files) {
  if (process.env.ACHIEVEMENTS_SIGNING_MODE === "pinned") {
    return (async () => {
      for (const file of files) {
        const result = await verifyPinnedWindowsSignature(file);
        console.log(`Verified pinned Authenticode signature and timestamp: ${result.file}`);
      }
    })();
  }
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows release signature validation requires Windows"));
  }
  // Pass paths as data, never interpolate them into PowerShell source.
  const script = `
    $ErrorActionPreference = 'Stop'
    $targets = ConvertFrom-Json $env:ACHIEVEMENTS_SIGNATURE_TARGETS
    foreach ($target in $targets) {
      $signature = Get-AuthenticodeSignature -LiteralPath $target
      if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature ($($signature.Status)): $target"
      }
      $cert = $signature.SignerCertificate
      if ($cert.Subject -eq $cert.Issuer) {
        throw "Self-signed certificates are not accepted for public releases: $target"
      }
      if (-not $signature.TimeStamperCertificate) {
        throw "Release signature is missing a trusted timestamp: $target"
      }
      Write-Output "Verified Authenticode signature and timestamp: $target"
    }
  `;
  return new Promise((resolve, reject) => {
    execFile(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env,
          PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
          ACHIEVEMENTS_SIGNATURE_TARGETS: JSON.stringify(files.map((file) => path.resolve(file))) },
      },
      (error, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve();
      },
    );
  });
}

module.exports = { verifyWindowsSignatures };
