$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$names = @('CaptureFileOutput','SaveInstantReplayHotkey','InstantReplayEnabled','InstantReplayDuration','DesktopRecordingEnabled','DvrEnabled','HotkeysDisabled','DvrDesktops','FileEncoderType','FileCustomFrameRate')
$profiles = @()
$profileViews = @()
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
  $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  try {
    $key = $root.OpenSubKey('Software\AMD\DVR',$false)
    if ($null -ne $key) {
      try {
        $values = [ordered]@{}
        foreach ($name in $names) { $values[$name] = $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        $profiles += $values
        $profileViews += $view.ToString()
      } finally { $key.Dispose() }
    }
  } finally { $root.Dispose() }
}
$machineProfiles = @()
$machineErrors = @()
# Read both sources separately; JavaScript resolves each missing user value.
# The registry is never modified and runtime service state is checked below.
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
  try {
    $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
    try {
      $key = $root.OpenSubKey('Software\AMD\DVR',$false)
      if ($null -ne $key) {
        try {
          $values = [ordered]@{}
          foreach ($name in $names) { $values[$name] = $key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
          $machineProfiles += [ordered]@{ view=$view.ToString(); values=$values }
        } finally { $key.Dispose() }
      }
    } finally { $root.Dispose() }
  } catch {
    $machineErrors += [ordered]@{ view=$view.ToString(); error=$_.Exception.Message }
  }
}
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$running = @(Get-Process AMDRSServ -ErrorAction SilentlyContinue | Where-Object SessionId -eq $session).Count -gt 0
[ordered]@{ profiles=$profiles; profileViews=$profileViews; machineProfiles=$machineProfiles; machineErrors=$machineErrors; running=$running } | ConvertTo-Json -Depth 6 -Compress
