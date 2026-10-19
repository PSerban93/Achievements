"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.resolve(__dirname, "..");
const artifactFiles = ["decoder.wasm", "manifest.json", "LICENSE-MIT"];
const sourceFiles = ["Cargo.toml", "Cargo.lock", "src/lib.rs", "rust-toolchain.toml"];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function readArtifact(directory, file) {
  const target = path.join(directory, file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`LZX runtime file missing: ${target}`);
  }
  const bytes = fs.readFileSync(target);
  if (!bytes.length) throw new Error(`LZX runtime file is empty: ${target}`);
  return bytes;
}

function verifyX360Lzx({ projectDir = root } = {}) {
  const directory = path.join(projectDir, "utils", "vendor", "x360-lzx");
  const artifacts = Object.fromEntries(artifactFiles.map((file) => [file, readArtifact(directory, file)]));
  const bytes = artifacts["decoder.wasm"];
  const manifest = JSON.parse(artifacts["manifest.json"].toString("utf8"));
  if (manifest.version !== 1 || manifest.dependency !== "lzxd@0.2.7" || sha256(bytes) !== manifest.sha256) {
    throw new Error("LZX decoder integrity mismatch; run npm run build:x360-lzx");
  }
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(projectDir, "native", "x360-lzx", file), "utf8").replace(/\r\n/g, "\n");
    if (manifest.sources?.[file] !== sha256(source)) {
      throw new Error(`LZX decoder source changed (${file}); run npm run build:x360-lzx`);
    }
  }
  const { toolchain } = require("smol-toml").parse(fs.readFileSync(
    path.join(projectDir, "native", "x360-lzx", "rust-toolchain.toml"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(toolchain?.channel || "") || manifest.toolchain !== toolchain.channel) {
    throw new Error("LZX decoder toolchain mismatch; run npm run build:x360-lzx");
  }
  // Inspect the artifact and ABI without instantiating or running the decoder.
  const moduleInfo = new WebAssembly.Module(bytes);
  const exportedSymbols = new Map(WebAssembly.Module.exports(moduleInfo).map((entry) => [entry.name, entry.kind]));
  for (const name of ["alloc", "free", "decoder_new", "decoder_free", "decode_next"]) {
    if (exportedSymbols.get(name) !== "function") throw new Error(`LZX decoder export missing: ${name}`);
  }
  if (exportedSymbols.get("memory") !== "memory" || WebAssembly.Module.imports(moduleInfo).length) {
    throw new Error("LZX decoder must expose memory and require no host imports");
  }
  console.log(`Xbox LZX runtime verified (${bytes.length} bytes, Rust ${toolchain.channel}).`);
  return artifacts;
}

function verifyPackagedX360Lzx({ projectDir = root, resourcesDir } = {}) {
  if (!resourcesDir) throw new Error("LZX packaged verification requires the application resources directory");
  const artifacts = verifyX360Lzx({ projectDir });
  const directory = path.join(resourcesDir, "app.asar.unpacked", "utils", "vendor", "x360-lzx");
  for (const file of artifactFiles) {
    if (!readArtifact(directory, file).equals(artifacts[file])) {
      throw new Error(`Packaged LZX runtime differs from the verified source: ${path.join(directory, file)}`);
    }
  }
  console.log("Packaged Xbox LZX decoder, manifest and license match the verified source.");
}

if (require.main === module) verifyX360Lzx();

module.exports = { verifyX360Lzx, verifyPackagedX360Lzx };
