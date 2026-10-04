"use strict";

const path = require("path");
const { build, Platform, Arch } = require("electron-builder");
const { powershell, policy } = require("../utils/windows-code-signature");

async function main() {
  if (process.platform !== "win32") throw new Error("Signing from the Windows certificate store requires Windows");
  if (!/^[A-F0-9]{40}$/.test(policy.certificateStoreSha1)) throw new Error("Invalid signing certificate store thumbprint");
  const certificate = await powershell(`
    $ErrorActionPreference = 'Stop'
    $cert = Get-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $env:ACHIEVEMENTS_CERTIFICATE_SHA1)
    if (-not $cert.HasPrivateKey) { throw 'Signing certificate has no private key' }
    if ($cert.Subject -ne $env:ACHIEVEMENTS_CERTIFICATE_SUBJECT) { throw 'Signing certificate subject mismatch' }
    if ($cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date)) { throw 'Signing certificate is not currently valid' }
    if (-not @($cert.EnhancedKeyUsageList | Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count) {
      throw 'Signing certificate is not intended for code signing'
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $pin = [BitConverter]::ToString($hasher.ComputeHash($cert.RawData)).Replace('-', '') }
    finally { $hasher.Dispose() }
    ConvertTo-Json -InputObject @{ pin = $pin; subject = $cert.Subject } -Compress
  `, { ACHIEVEMENTS_CERTIFICATE_SHA1: policy.certificateStoreSha1,
    ACHIEVEMENTS_CERTIFICATE_SUBJECT: policy.certificateSubject });
  if (!policy.allowedCertificateSha256.includes(certificate.pin)) throw new Error("Build certificate is not allowed by the update signing policy");
  const args = process.argv.slice(2);
  const directory = args.includes("--dir");
  const outputIndex = args.indexOf("--output");
  if (args.some((arg, index) => arg !== "--dir" && arg !== "--output" && !(outputIndex !== -1 && index === outputIndex + 1)) ||
      (outputIndex !== -1 && !args[outputIndex + 1])) throw new Error("Usage: build-self-signed.js [--dir] [--output directory]");
  process.env.ACHIEVEMENTS_SIGNING_MODE = "pinned";
  console.log(`Signing Windows artifacts as ${certificate.subject}, certificate SHA-256 ${certificate.pin}`);
  await build({
    projectDir: path.resolve(__dirname, ".."),
    targets: Platform.WINDOWS.createTarget(directory ? "dir" : "nsis", Arch.x64),
    publish: "never",
    config: {
      forceCodeSigning: true,
      ...(outputIndex !== -1 ? { directories: { output: path.resolve(args[outputIndex + 1]) } } : {}),
      win: { signAndEditExecutable: true, signExecutable: true,
        signtoolOptions: { certificateSha1: policy.certificateStoreSha1,
          publisherName: policy.publisherName, signingHashAlgorithms: ["sha256"],
          rfc3161TimeStampServer: "http://timestamp.digicert.com" } },
    },
  });
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
