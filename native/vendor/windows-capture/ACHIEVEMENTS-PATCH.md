# Achievements local extension

This directory contains the MIT-licensed `windows-capture` 2.0.1 source used by
the native achievement recorder. The original project and license are retained
unchanged.

Achievements adds one narrow encoder API, `VideoEncoder::send_surface`, so an
HDR frame can be tone-mapped into a BGRA8 Direct3D surface and handed to the
existing encoder without a GPU-to-CPU readback. No other upstream behavior is
intentionally changed.

When updating `windows-capture`, replace this vendor snapshot with the desired
upstream release, reapply the documented method, and run the native recorder
test and live capture suite.
