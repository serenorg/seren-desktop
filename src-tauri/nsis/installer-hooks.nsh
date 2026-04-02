; ABOUTME: NSIS installer hooks for Seren Desktop.
; ABOUTME: Kills running Seren and orphaned embedded-runtime processes to prevent file-lock errors.

!macro NSIS_HOOK_PREINSTALL
  ; Kill Seren main process and its child process tree
  nsExec::ExecToStack 'taskkill /F /IM "Seren.exe" /T'
  Pop $0
  Pop $1
  ; Brief pause for child processes to exit
  Sleep 1500

  ; Kill ALL node.exe processes. This is the nuclear option but the only
  ; reliable approach through NSIS:
  ;
  ; - PowerShell $_ variables get eaten by NSIS's own $ interpolation
  ; - wmic + cmd /c for /f has nested quoting issues inside nsExec
  ; - The user is actively installing — killing node.exe is expected
  ;
  ; This catches: embedded provider-runtime, playwright MCP server,
  ; claude CLI, and any other orphaned node.exe holding file locks.
  nsExec::ExecToStack 'taskkill /F /IM "node.exe" /T'
  Pop $0
  Pop $1

  ; Allow OS to release file handles after process termination.
  ; 3 seconds — Windows can take longer than Linux to release locks.
  Sleep 3000
!macroend
