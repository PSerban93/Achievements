# Achievements local extension

This directory contains the MIT-licensed `windows-capture` 2.0.1 source used by
the native Windows capture helpers. The original project and license are retained
unchanged.

The achievement recorder now uses this crate for Windows Graphics Capture only.
Its continuous Media Foundation encoder and compressed replay buffer live in
`native/achievement-recorder/src/media_encoder.rs` and `recording.rs`. The
upstream-compatible `VideoEncoder` extension below is retained in the vendor
snapshot; it is not the active recording backend.

Both capture entry points validate optional minimum-update-interval and border
settings before allocating a dispatcher, D3D device, or consumer handler. An
unsupported option therefore cannot start an encoder/audio worker whose teardown
posts WM_QUIT into a later fallback. The native recorder additionally gives each
capture attempt a dedicated thread, preserving typed errors and joining the
attempt before retrying. Default border settings remain available on older
Windows versions; no border-control API is called for that setting.

Achievements adds one narrow encoder API, `VideoEncoder::send_surface`, so an
HDR frame can be tone-mapped into a BGRA8 Direct3D surface and handed to the
existing encoder without a GPU-to-CPU readback.

`VideoSettingsBuilder::frame_rate_ratio` also preserves fractional display rates
for Unlocked recording. The existing `frame_rate` setter retains an integer
rate with denominator 1. Capture samples keep their original timestamps.

Encoder construction checks `CanTranscode` and exposes Windows profile rejection
reasons. Both asynchronous start and completion failures reach `check_error`,
which checks finished workers without blocking a running encoder. The recorder
calls it even when its video queue is full. Normal finalization still flushes
the streams and joins the transcoder worker.

When updating `windows-capture`, replace this vendor snapshot with the desired
upstream release, reapply the documented methods, and run the native recorder
test and live capture suite.
