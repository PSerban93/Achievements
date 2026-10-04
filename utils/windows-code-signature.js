"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const policy = require("../windows-signing-policy.json");

const OID = {
  signedData: "2a864886f70d010702",
  authenticode: "2b060104018237020104",
  sha256: "608648016503040201",
  timestamp: "2b060104018237030301",
  timestampContent: "2a864886f70d0109100104",
  nestedSignature: "2b060104018237020401",
};

// Only definite, bounded DER is accepted. Signature metadata is untrusted input.
function der(data, start = 0, limit = data.length) {
  if (start < 0 || start + 2 > limit || limit > data.length) throw new Error("Truncated signature DER");
  const tag = data[start];
  if ((tag & 31) === 31) throw new Error("Unsupported signature DER tag");
  let offset = start + 2;
  let length = data[start + 1];
  if (length & 128) {
    const count = length & 127;
    if (!count || count > 4 || offset + count > limit || data[offset] === 0) {
      throw new Error("Invalid signature DER length");
    }
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[offset++];
    if (length < 128) throw new Error("Non-canonical signature DER length");
  }
  if (offset + length > limit) throw new Error("Signature DER exceeds its container");
  return { tag, start, offset, end: offset + length };
}

function children(data, parent, tag) {
  if (tag != null && parent.tag !== tag) throw new Error("Unexpected signature DER structure");
  const items = [];
  let offset = parent.offset;
  while (offset < parent.end) {
    if (items.length >= 256) throw new Error("Signature DER contains too many fields");
    const item = der(data, offset, parent.end);
    items.push(item);
    offset = item.end;
  }
  return items;
}

function value(data, node, tag) {
  if (!node || (tag != null && node.tag !== tag)) throw new Error("Missing signature DER field");
  return data.subarray(node.offset, node.end);
}

function oid(data, node) { return value(data, node, 6).toString("hex"); }

function cms(data, node) {
  const outer = children(data, node, 48);
  if (outer.length !== 2 || oid(data, outer[0]) !== OID.signedData) throw new Error("Expected CMS SignedData");
  const wrapped = children(data, outer[1], 160);
  if (wrapped.length !== 1) throw new Error("Invalid CMS wrapper");
  const signed = children(data, wrapped[0], 48);
  const content = children(data, signed[2], 48);
  if (content.length !== 2) throw new Error("Detached CMS signatures are not accepted");
  const contentNodes = children(data, content[1], 160);
  if (contentNodes.length !== 1) throw new Error("Invalid CMS content");
  let contentNode = contentNodes[0];
  // RFC 3161 uses an OCTET STRING; Authenticode also supports a direct SEQUENCE.
  if (contentNode.tag === 4) {
    const decoded = der(data, contentNode.offset, contentNode.end);
    if (decoded.end !== contentNode.end) throw new Error("Trailing CMS content");
    contentNode = decoded;
  }
  const signers = children(data, signed[signed.length - 1], 49);
  if (signers.length !== 1) throw new Error("Exactly one signer per CMS layer is required");
  const signer = children(data, signers[0], 48);
  const digest = children(data, signer[2], 48);
  if (oid(data, digest[0]) !== OID.sha256) throw new Error("Only SHA-256 code and timestamp signatures are accepted");
  let signatureIndex = signer[3]?.tag === 160 ? 5 : 4;
  const signature = value(data, signer[signatureIndex], 4);
  const attributes = signer[signatureIndex + 1];
  if (signer.length !== signatureIndex + 1 + (attributes ? 1 : 0)) throw new Error("Invalid CMS signer fields");
  const unsigned = attributes ? children(data, attributes, 161) : [];
  return { contentOid: oid(data, content[0]), contentNode, signature, unsigned };
}

function sha256Digest(data, digestInfo) {
  const fields = children(data, digestInfo, 48);
  if (fields.length !== 2 || oid(data, children(data, fields[0], 48)[0]) !== OID.sha256) {
    throw new Error("Only SHA-256 Authenticode digests are accepted");
  }
  const digest = value(data, fields[1], 4);
  if (digest.length !== 32) throw new Error("Invalid SHA-256 digest size");
  return digest;
}

function readSignedPe(data) {
  if (data.length < 64 || data.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a Windows executable");
  const pe = data.readUInt32LE(60);
  if (pe < 64 || pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) throw new Error("Invalid PE header");
  const optional = pe + 24;
  const optionalSize = data.readUInt16LE(pe + 20);
  if (optional + optionalSize > data.length || optionalSize < 68) throw new Error("Truncated PE optional header");
  const magic = data.readUInt16LE(optional);
  const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directories || directories + 40 > optionalSize || data.readUInt32LE(optional + directories - 4) < 5) {
    throw new Error("PE certificate directory is missing");
  }
  const checksum = optional + 64;
  const security = optional + directories + 32;
  const certificateOffset = data.readUInt32LE(security);
  const certificateSize = data.readUInt32LE(security + 4);
  const headerSize = data.readUInt32LE(optional + 60);
  const sectionCount = data.readUInt16LE(pe + 6);
  const sectionTable = optional + optionalSize;
  if (!sectionCount || sectionCount > 96 || sectionTable + sectionCount * 40 > headerSize ||
      headerSize > data.length || headerSize < security + 8) throw new Error("Invalid PE section table");
  if (!certificateOffset || certificateSize < 8) throw new Error("Executable is not signed");
  if (certificateOffset % 8 || certificateOffset < headerSize || certificateOffset + certificateSize !== data.length) {
    throw new Error("Unsupported PE certificate layout");
  }
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const section = sectionTable + i * 40;
    const size = data.readUInt32LE(section + 16);
    const start = data.readUInt32LE(section + 20);
    if (size) sections.push({ start, size });
  }
  sections.sort((a, b) => a.start - b.start);
  const hasher = crypto.createHash("sha256");
  hasher.update(data.subarray(0, checksum));
  hasher.update(data.subarray(checksum + 4, security));
  hasher.update(data.subarray(security + 8, headerSize));
  let end = headerSize;
  for (const section of sections) {
    // Our MSVC/Rust/Electron/NSIS artifacts have contiguous raw sections. Reject
    // gaps/overlaps rather than apply an ambiguous Authenticode hash algorithm.
    if (section.start !== end || section.start + section.size > certificateOffset) {
      throw new Error("Unsupported non-contiguous PE sections");
    }
    end += section.size;
    hasher.update(data.subarray(section.start, end));
  }
  hasher.update(data.subarray(end, certificateOffset)); // Includes NSIS installer overlay.
  const signatures = [];
  let offset = certificateOffset;
  while (offset < data.length) {
    if (offset + 8 > data.length || signatures.length >= 4) throw new Error("Invalid PE certificate table");
    const size = data.readUInt32LE(offset);
    if (size < 8 || offset + size > data.length || data.readUInt16LE(offset + 4) !== 0x200 ||
        data.readUInt16LE(offset + 6) !== 2) throw new Error("Unsupported WIN_CERTIFICATE");
    const signature = der(data, offset + 8, offset + size);
    if (signature.tag !== 48 || data.subarray(signature.end, offset + size).some(byte => byte !== 0)) {
      throw new Error("Invalid certificate payload or padding");
    }
    signatures.push(signature);
    const aligned = offset + Math.ceil(size / 8) * 8;
    if (aligned > data.length || data.subarray(offset + size, aligned).some(byte => byte !== 0)) {
      throw new Error("Invalid certificate alignment");
    }
    offset = aligned;
  }
  return { imageDigest: hasher.digest(), signatures };
}

function timestampTime(data, node, signature) {
  const token = cms(data, node);
  if (token.contentOid !== OID.timestampContent) throw new Error("Not an RFC 3161 timestamp");
  const info = children(data, token.contentNode, 48);
  if (!sha256Digest(data, info[2]).equals(crypto.createHash("sha256").update(signature).digest())) {
    throw new Error("Timestamp does not belong to this code signature");
  }
  const text = value(data, info[4], 24).toString("ascii");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!match) throw new Error("Invalid timestamp time");
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] || "").padEnd(3, "0").slice(0, 3)}Z`;
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== iso || time.getTime() > Date.now() + 300000) {
    throw new Error("Invalid or future timestamp");
  }
  return iso;
}

function verificationRequests(data, pe, requireTimestamp) {
  const requests = [];
  function add(node, depth = 0) {
    if (depth > 3 || requests.length > 12) throw new Error("Too many nested code signatures");
    const signed = cms(data, node);
    if (signed.contentOid !== OID.authenticode) throw new Error("Not an Authenticode signature");
    const content = children(data, signed.contentNode, 48);
    if (content.length !== 2 || !sha256Digest(data, content[1]).equals(pe.imageDigest)) {
      throw new Error("Authenticode image digest mismatch");
    }
    const code = { offset: node.start, length: node.end - node.start, kind: "code", time: null };
    requests.push(code);
    let timestampCount = 0;
    for (const attribute of signed.unsigned) {
      const parts = children(data, attribute, 48);
      if (parts.length !== 2) throw new Error("Invalid unsigned signature attribute");
      const type = oid(data, parts[0]);
      const values = children(data, parts[1], 49);
      if (type === OID.timestamp) {
        for (const stamp of values) {
          if (++timestampCount > 1) throw new Error("Ambiguous code signature timestamps");
          code.time = timestampTime(data, stamp, signed.signature);
          requests.push({ offset: stamp.start, length: stamp.end - stamp.start, kind: "timestamp", time: code.time });
        }
      } else if (type === OID.nestedSignature) {
        for (const nested of values) add(nested, depth + 1);
      } else {
        // Production builds use RFC 3161, never legacy countersignatures or
        // opaque unsigned attributes which could hide another signature.
        throw new Error("Unsupported unsigned Authenticode attribute");
      }
    }
    if (requireTimestamp && timestampCount !== 1) throw new Error("Code signature is missing an RFC 3161 timestamp");
  }
  for (const node of pe.signatures) add(node);
  return requests;
}

function powershell(script, env) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    execFile(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
        env: { ...process.env, ...env, PSModulePath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else {
          try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "").trim())); }
          catch { reject(new Error("Windows signature verifier returned invalid output")); }
        }
      });
  });
}

const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$requests = ConvertFrom-Json $env:ACHIEVEMENTS_SIGNATURE_REQUESTS
$results = @()
$stream = [IO.File]::Open($env:ACHIEVEMENTS_SIGNATURE_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
foreach ($request in $requests) {
  $raw = New-Object byte[] ([int]$request.length)
  [void]$stream.Seek([int64]$request.offset, [IO.SeekOrigin]::Begin)
  $read = 0
  while ($read -lt $raw.Length) {
    $count = $stream.Read($raw, $read, $raw.Length - $read)
    if ($count -eq 0) { throw 'Truncated CMS signature' }
    $read += $count
  }
  $cms = New-Object Security.Cryptography.Pkcs.SignedCms
  $cms.Decode($raw)
  if ($cms.SignerInfos.Count -ne 1) { throw 'Exactly one CMS signer is required' }
  $signer = $cms.SignerInfos[0]
  $signer.CheckSignature($true)
  $cert = $signer.Certificate
  if (-not $cert) { throw 'CMS signer certificate missing' }
  $usage = @($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' })
  $needed = if ($request.kind -eq 'timestamp') { '1.3.6.1.5.5.7.3.8' } else { '1.3.6.1.5.5.7.3.3' }
  if ($usage.Count -ne 1 -or -not @($usage[0].EnhancedKeyUsages | Where-Object { $_.Value -eq $needed }).Count) {
    throw 'Signer certificate has the wrong extended key usage'
  }
  $when = if ($request.time) { [DateTimeOffset]::Parse($request.time).UtcDateTime } else { [DateTime]::UtcNow }
  if ($when -lt $cert.NotBefore.ToUniversalTime() -or $when -gt $cert.NotAfter.ToUniversalTime()) {
    throw 'Signer certificate was not valid at the signing time'
  }
  if ($request.kind -eq 'timestamp') {
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    try {
      $chain.ChainPolicy.VerificationTime = $when.ToLocalTime()
      $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
      [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid($needed)))
      $chain.ChainPolicy.ExtraStore.AddRange($cms.Certificates)
      if (-not $chain.Build($cert)) { throw 'Timestamp certificate does not chain to a trusted root' }
    } finally { $chain.Dispose() }
  }
  $results += @{ kind = $request.kind; certificate = [Convert]::ToBase64String($cert.RawData); subject = $cert.Subject }
}
} finally { $stream.Dispose() }
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
`;

async function verifyPinnedWindowsSignature(file, options = {}) {
  if (process.platform !== "win32") throw new Error("Authenticode verification requires Windows");
  const absolute = path.resolve(file);
  const data = await fs.promises.readFile(absolute);
  const sha512 = crypto.createHash("sha512").update(data).digest("base64");
  if (options.expectedSha512 && options.expectedSha512 !== sha512) throw new Error("Update installer checksum mismatch");
  const pins = options.allowedCertificateSha256 || policy.allowedCertificateSha256;
  if (!Array.isArray(pins) || !pins.length || pins.some(pin => !/^[A-F0-9]{64}$/.test(pin))) {
    throw new Error("No valid Windows signing certificate pins configured");
  }
  const requests = verificationRequests(data, readSignedPe(data), options.requireTimestamp ?? policy.requireTimestamp);
  const results = await powershell(VERIFY_SCRIPT, {
    ACHIEVEMENTS_SIGNATURE_FILE: absolute,
    ACHIEVEMENTS_SIGNATURE_REQUESTS: JSON.stringify(requests),
  });
  if (!Array.isArray(results) || results.length !== requests.length) throw new Error("Incomplete Windows signature verification");
  const signers = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i].kind !== requests[i].kind) throw new Error("Windows signature verification request mismatch");
    if (results[i].kind !== "code") continue;
    const certificate = new crypto.X509Certificate(Buffer.from(results[i].certificate, "base64"));
    const pin = certificate.fingerprint256.replace(/:/g, "");
    if (!pins.includes(pin)) throw new Error("Executable is signed by an unrecognized certificate");
    signers.push({ subject: results[i].subject, certificateSha256: pin });
  }
  // Ensure the file did not change between the JS image digest and CMS validation.
  const afterHasher = crypto.createHash("sha512");
  for await (const chunk of fs.createReadStream(absolute)) afterHasher.update(chunk);
  const after = afterHasher.digest("base64");
  if (after !== sha512) throw new Error("Executable changed during signature verification");
  return { file: absolute, sha512, signers };
}

module.exports = { verifyPinnedWindowsSignature, powershell, policy };
