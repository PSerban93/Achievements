# Xbox LZX decoder

`decoder.wasm` is built from `native/x360-lzx` using the pinned Cargo dependency
[`lzxd` 0.2.7](https://crates.io/crates/lzxd/0.2.7). Its upstream repository is
[Lonami/lzxd](https://github.com/Lonami/lzxd). We distribute it under the MIT
option of its dual MIT/Apache-2.0 licence; see `LICENSE-MIT` in this directory.

The small ABI wrapper and XEX framing/integration are implemented in this
project. XEX block layout was cross-checked against the
[Xenia loader](https://github.com/xenia-project/xenia/blob/master/src/xenia/cpu/xex_module.cc)
and the [acceleration XEX loader](https://github.com/landaire/acceleration/blob/main/crates/xex2/src/basefile.rs).
Their implementation code is not included here.

## Rebuild

```powershell
rustup toolchain install 1.97.0 --profile minimal --target wasm32-unknown-unknown
npm run build:x360-lzx
```

This compiles the release WASM artifact; it does not run tests. The toolchain is
pinned in `native/x360-lzx/rust-toolchain.toml`; the build explicitly selects it
even if a different global toolchain is configured. Cargo.lock pins the dependency
and checksum. `manifest.json` records the Rust version and artifact/source hashes,
including the toolchain file. Other Rust helpers retain their existing toolchains.
Source hashes normalize CRLF/LF so Windows checkouts do not require recompilation.
The linker caps WASM memory at 64 MiB. The ABI passes at most one 64 KiB input
chunk and one 32 KiB output chunk at a time; it retains the decoder window.
The runtime has no host imports, filesystem access or network access.

The WASM artifact is included through `utils/**/*` and belongs with the source
files in version control; users and
normal application builds do not need Rust. `npm run verify:x360-lzx` validates
hashes, WASM structure and exported symbols without running decompression.
The `afterPack` hook also compares the packaged decoder, manifest and licence
byte-for-byte with the verified project files on every platform. A missing or
changed packaged file stops the build before signing or installer creation.
