; ABOUTME: NSIS installer hooks for Seren Desktop.
; ABOUTME: Path-scoped cleanup of Seren-owned processes — never kills user's unrelated node.exe.

; Defensive define: if Tauri's generated NSI template references
; ${PRODUCT_NAME} or ${product_name} without first defining the symbol
; (#2230 screenshot showed the literal placeholder in the "App is running"
; prompt), provide a fallback so the installer UI shows a real string. NSIS
; !ifndef is a no-op when the symbol is already defined upstream, so this
; is safe to land regardless of which Tauri version emits the template.
!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "SerenDesktop"
!endif
!ifndef product_name
  !define product_name "${PRODUCT_NAME}"
!endif

!macro NSIS_HOOK_PREINSTALL
  ; Primary cleanup is the signed in-app updater path
  ; (commands::updater::updater_pre_install). This NSIS hook is a fallback
  ; for: first-time installs over a crashed prior version, sideloaded
  ; installer runs that bypass the in-app updater, and cases where Smart
  ; App Control blocked the in-app path.
  ;
  ; The hook is intentionally CONSERVATIVE: it must NEVER kill the user's
  ; unrelated node.exe. The prior nuclear `taskkill /F /IM node.exe`
  ; destroyed running editors, build watchers, and dev servers across
  ; entire Windows boxes (#2230 audit item C).

  ; 1. Kill Seren.exe by image name. Safe — no other vendor ships an
  ;    executable called Seren.exe. /T flattens the process tree, which
  ;    catches every provider-runtime / MCP / claude CLI child spawned
  ;    by the running app.
  nsExec::ExecToStack 'taskkill /F /IM "Seren.exe" /T'
  Pop $0
  Pop $1
  Sleep 1500

  ; 2. Path-scoped sweep for ORPHANED node.exe children whose parent died
  ;    but who still hold an executable mapping on the bundled node.exe.
  ;    Without this, an old install whose Seren.exe crashed without
  ;    cleaning up its tree blocks the file-replace step.
  ;
  ;    PowerShell is dropped to %TEMP% as a .ps1 file so we don't fight
  ;    NSIS's $-interpolation rules inside a long inline -Command (the
  ;    prior author tried inline and reverted; see git history). Each
  ;    NSIS-source $$ emits one literal $ so $_, $env, and $installRoot
  ;    reach PowerShell intact.
  ;
  ;    Filter by ExecutablePath under %LOCALAPPDATA%\SerenDesktop\
  ;    embedded-runtime\**. The user's system node.exe at C:\Program
  ;    Files\nodejs\node.exe cannot match.
  FileOpen $9 "$TEMP\seren-preinstall-cleanup.ps1" w
  FileWrite $9 'try {$\r$\n'
  FileWrite $9 '  $$installRoot = Join-Path -Path $$env:LOCALAPPDATA -ChildPath "SerenDesktop\embedded-runtime"$\r$\n'
  FileWrite $9 '  Get-CimInstance Win32_Process -ErrorAction Stop |$\r$\n'
  FileWrite $9 '    Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$installRoot, [System.StringComparison]::OrdinalIgnoreCase) } |$\r$\n'
  FileWrite $9 '    ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n'
  FileWrite $9 '} catch {}$\r$\n'
  FileClose $9

  ; -ExecutionPolicy Bypass restricts the looser policy to this invocation
  ; only; it does not persist after PowerShell exits. The try/catch in the
  ; script swallows failures so a locked-down system cannot fail the
  ; installer — Seren.exe was already killed above.
  nsExec::ExecToStack 'powershell.exe -ExecutionPolicy Bypass -NonInteractive -WindowStyle Hidden -File "$TEMP\seren-preinstall-cleanup.ps1"'
  Pop $0
  Pop $1
  Delete "$TEMP\seren-preinstall-cleanup.ps1"

  ; Allow the kernel to flush file handles after TerminateProcess. Windows
  ; can take longer than Linux to release locks, especially under Defender
  ; real-time scanning. The in-app pre-install path polls for release
  ; explicitly; here we just sleep.
  Sleep 3000
!macroend
