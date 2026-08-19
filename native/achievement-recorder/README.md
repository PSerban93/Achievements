# Achievements recorder helper

This persistent Windows helper maintains a bounded rolling capture of the
primary monitor through Windows Graphics Capture. Captured frames are encoded
as short H.264/MP4 segments using the hardware-accelerated Windows Media
pipeline exposed by `windows-capture`. System output is captured from the
current default Windows playback device through WASAPI loopback and encoded as
stereo AAC at 48 kHz/192 kbps in the same MP4 segments.

When `Enable HDR-to-SDR Conversion for Records` is enabled, the helper captures
FP16 scRGB frames and converts them on the GPU with a D3D11 tone-mapping shader
before sending the resulting BGRA8 surface directly to the H.264 encoder. The
saved file remains a standard SDR H.264/MP4 clip; this option is intended to
preserve HDR highlights and colors on ordinary SDR players, not to create an
HDR video. If the FP16 capture or shader cannot initialize, the helper logs the
failure and falls back to its normal SDR capture backend before recording
starts.

When the Electron process sends a `trigger` command, the helper retains the
segments covering ten seconds before the command, records ten seconds after
it, and composes those segments into the requested MP4 file. Old segments are
deleted continuously and every helper run uses an isolated temporary session
folder.

The audio source is the complete default Windows output mix, so game audio and
other sounds played through that device can be included. Microphone input is
not captured. If WASAPI loopback cannot be initialized, the helper reports the
reason and safely continues recording video-only instead of failing the entire
achievement record.

Build the x64 release binary with:

```powershell
cargo build --release --locked
Copy-Item .\target\release\achievements-recorder.exe `
  ..\..\utils\native\achievements-recorder.exe -Force
```

End users do not need Rust or the Windows SDK. Electron Builder packages the
prebuilt executable outside ASAR.

The local `windows-capture` 2.0.1 source snapshot under `../vendor` is retained
under its MIT license. `src/encoder.rs` contains the small project-specific
extension used to submit an already tone-mapped Direct3D surface without a
GPU-to-CPU readback.
