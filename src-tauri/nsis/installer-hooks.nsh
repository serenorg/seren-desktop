; ABOUTME: NSIS installer hooks for Seren Desktop.
; ABOUTME: Kills running Seren process before files are copied to prevent file-lock errors.

!macro NSIS_HOOK_PREINSTALL
  ; Kill any running Seren instance so installer can overwrite locked files
  nsExec::ExecToStack 'taskkill /F /IM "Seren.exe" /T'
  Pop $0
  Pop $1
  Sleep 1000
!macroend
