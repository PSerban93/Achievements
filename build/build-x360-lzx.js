"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const crate = path.join(root, "native", "x360-lzx");
const { toolchain } = require("smol-toml").parse(fs.readFileSync(path.join(crate, "rust-toolchain.toml"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(toolchain?.channel || "")) {
  throw new Error("LZX build requires an exact Rust version in rust-toolchain.toml");
}
const result = spawnSync("cargo", [`+${toolchain.channel}`, "build", "--release", "--locked", "--target", "wasm32-unknown-unknown",
  "--manifest-path", path.join(crate, "Cargo.toml")], {
  cwd: crate, stdio: "inherit", windowsHide: true,
  env: { ...process.env, CARGO_TARGET_DIR: path.join(crate, "target"),
    CARGO_ENCODED_RUSTFLAGS: "-C\x1flink-arg=--max-memory=67108864\x1f-C\x1flink-arg=-zstack-size=1048576" },
});
if (result.error || result.status !== 0) {
  throw result.error || new Error(`LZX WASM build failed. Prepare Rust with: rustup toolchain install ${toolchain.channel} --profile minimal --target wasm32-unknown-unknown`);
}
const destination = path.join(root, "utils", "vendor", "x360-lzx");
fs.mkdirSync(destination, { recursive: true });
const wasm = fs.readFileSync(path.join(crate, "target", "wasm32-unknown-unknown", "release", "achievements_x360_lzx.wasm"));
fs.writeFileSync(path.join(destination, "decoder.wasm"), wasm);
const sources = ["Cargo.toml", "Cargo.lock", "src/lib.rs", "rust-toolchain.toml"];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(path.join(destination, "manifest.json"), JSON.stringify({
  version: 1, dependency: "lzxd@0.2.7", toolchain: toolchain.channel, sha256: sha256(wasm),
  sources: Object.fromEntries(sources.map((file) => [file,
    sha256(fs.readFileSync(path.join(crate, file), "utf8").replace(/\r\n/g, "\n"))])),
}, null, 2) + "\n");
require("./verify-x360-lzx").verifyX360Lzx();
