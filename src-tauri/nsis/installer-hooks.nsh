; ABOUTME: NSIS installer hooks for Seren Desktop.
; ABOUTME: Kills running Seren and orphaned embedded-runtime processes to prevent file-lock errors.

!macro NSIS_HOOK_PREINSTALL
  ; Kill Seren main process and its child process tree
  nsExec::ExecToStack 'taskkill /F /IM "Seren.exe" /T'
  Pop $0
  Pop $1
  ; Brief pause for child processes to exit
  Sleep 1500

  ; Kill ALL node.exe whose executable path lives under the SerenDesktop
  ; install directory. Uses Get-CimInstance (WMI) which returns the full
  ; ExecutablePath — more reliable than Get-Process which can miss
  ; processes running under different security contexts.
  ; This catches: embedded node.exe, claude CLI node.exe spawned from
  ; the embedded runtime, and any other node child still holding a lock.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\
    Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" -EA 0 | \
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath -match ''SerenDesktop'' } | \
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"'
  Pop $0
  Pop $1

  ; Also kill node.exe that were spawned BY the embedded runtime but live
  ; outside SerenDesktop (e.g. globally-installed claude at ~/.local/bin).
  ; Match by parent: any node.exe whose parent command line contains SerenDesktop.
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\
    Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" -EA 0 | \
      Where-Object { \
        $ppid = $_.ParentProcessId; \
        $parent = Get-CimInstance Win32_Process -Filter \"ProcessId=$ppid\" -EA 0; \
        $parent -and $parent.ExecutablePath -and $parent.ExecutablePath -match ''SerenDesktop'' \
      } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }"'
  Pop $0
  Pop $1

  ; Allow OS to release file handles after process termination.
  ; 3 seconds — Windows can take longer than Linux to release locks.
  Sleep 3000
!macroend
