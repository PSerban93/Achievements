# Installer process close

The installed electron-builder 26.18.0 template omits the force flag in its
all-users `taskkill` fallback, used when its PowerShell availability check fails.
For Electron windows using close-to-tray, the normal close signal can succeed
without ending the process; repeating that signal does not force termination.

`nsis.include` explicitly loads `build/installer.nsh`. Its `customHeader` hook
replaces only `KILL_PROCESS` through `installer-process-close.nsh`, after the
upstream macros are defined and before installer/uninstaller sections expand.
The all-users fallback uses the absolute system `taskkill.exe` path and honors
`/F` only on the forced attempt. PowerShell/current-user command selection,
process detection, consent dialogs, retry/wait intervals and Retry/Cancel remain
upstream behavior. The replacement also consumes the `nsExec` exit status before
restoring its saved register, keeping the NSIS stack balanced.

Force termination can interrupt pending recording/file work. The override does
not add an application shutdown IPC protocol or extend recording drain time.
It repairs the demonstrated fallback failure; it cannot remove file locks from
other processes or guarantee that every installer Retry report has this cause.

The hook checks that the upstream macro exists at compile time. Review the
override when upgrading electron-builder; do not patch `node_modules` manually.
See the official [custom NSIS script documentation](https://www.electron.build/nsis/).

## Verification

Run `npm run verify:installer-close` on Windows with Electron installed and the
electron-builder NSIS toolset already cached (a previous Windows build downloads
it). The suite compiles temporary NSIS probes with the actual upstream macros and
project hook. They run without elevation and target a uniquely named copy of
Electron in an isolated temporary directory, never `Achievements.exe` or the
development `electron.exe`. Test windows are transparent, do not activate, and
use an isolated profile. No application installer/uninstaller is run and no
installation registry entries are written.

The runtime cases reproduce the original all-users fallback defect, then check
the corrected hidden/window close-to-tray paths, normal close, current-user
fallback, PowerShell and already-closed state. They also verify register/stack
preservation. A separate compile check covers the uninstaller macro context;
that uninstaller is not executed. Scripts, tiny probes and `report.json` remain
in the printed temporary directory; the large copied Electron runtime is removed
after success.

The baseline case deliberately expects the installed upstream bug. If a future
electron-builder version repairs it, review and remove/adapt the override rather
than weakening the baseline check. This suite is isolated process behavior
evidence, not a full signed-installer upgrade of a real installed application.
