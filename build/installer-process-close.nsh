!ifndef ACHIEVEMENTS_INSTALLER_PROCESS_CLOSE
!define ACHIEVEMENTS_INSTALLER_PROCESS_CLOSE

# Keep electron-builder's detection, consent, wait and Retry/Cancel flow. Replace
# only its termination macro: the all-users taskkill fallback omitted /F.
!ifmacrondef KILL_PROCESS
  !error "Achievements installer: electron-builder KILL_PROCESS macro changed; review the process-close override."
!endif
!macroundef KILL_PROCESS
!macro KILL_PROCESS _FILE _FORCE
  Push $0
  ${if} ${_FORCE} == 1
    ${if} $IsPowerShellAvailable == 0
      StrCpy $0 "-Force"
    ${else}
      StrCpy $0 "/F"
    ${endIf}
  ${else}
    StrCpy $0 ""
  ${endIf}

  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId $0 }"`
  ${else}
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `"$SYSDIR\taskkill.exe" $0 /IM "${_FILE}" /FI "PID ne $pid"`
    !else
      nsExec::Exec `"$CmdPath" /C taskkill $0 /IM "${_FILE}" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"`
    !endif
  ${endIf}
  # nsExec pushes an exit status. Discard it before restoring the caller's $0;
  # the upstream process-detection loop decides whether another attempt is needed.
  Pop $0
  Pop $0
!macroend
!endif
