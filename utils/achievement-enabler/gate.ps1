$ErrorActionPreference = 'Stop'
$gate = [Threading.EventWaitHandle]::OpenExisting($env:ACHIEVEMENTS_ENABLER_GATE)
try { [void]$gate.WaitOne() } finally { $gate.Dispose() }
& $env:ComSpec /d /c $env:ACHIEVEMENTS_ENABLER_SCRIPT
exit $LASTEXITCODE
