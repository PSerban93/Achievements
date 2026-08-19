# Achievements HDR screenshot helper

This transient Windows helper captures the primary monitor through Windows
Graphics Capture using `R16G16B16A16_FLOAT`, tone-maps the frame to SDR sRGB,
and writes a PNG. It is launched only when a screenshot is requested and the
`Enable HDR for Screenshots` preference is enabled.

Build the x64 release binary with:

```powershell
cargo build --release --locked
Copy-Item .\target\release\achievements-hdr-screenshot.exe `
  ..\..\utils\native\achievements-hdr-screenshot.exe -Force
```

End users do not need Rust or the Windows SDK. Electron Builder packages the
prebuilt executable from `utils/native` outside ASAR so Windows can launch it.

The helper uses the MIT-licensed `windows-capture` crate. Its license notice is
included beside the packaged executable.
