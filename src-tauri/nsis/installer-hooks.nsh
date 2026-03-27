; ABOUTME: NSIS installer hooks for Seren Desktop.
; ABOUTME: Kills running Seren and orphaned embedded-runtime processes to prevent file-lock errors.

!macro NSIS_HOOK_PREINSTALL
  ; Kill Seren main process and its child process tree
  nsExec::ExecToStack 'taskkill /F /IM "Seren.exe" /T'
  Pop $0
  Pop $1
  ; Brief pause for child processes to exit
  Sleep 1000
  ; Kill orphaned node.exe from the embedded runtime. The /T flag above misses
  ; node.exe processes that were detached or orphaned by a provider-runtime crash.
  ; Target only Seren's embedded node — not the user's own Node.js processes.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "Get-Process node -EA 0 | ? { $_.Path -and $_.Path -match ''SerenDesktop'' } | Stop-Process -Force -EA 0"'
  Pop $0
  Pop $1
  ; Allow OS to release file handles after process termination
  Sleep 2000
!macroend
