# ABOUTME: Pre-seeds the tauri-bundler NSIS cache and EV-signs the stock plugin DLLs in place (#2299).
# ABOUTME: makensis embeds stock plugins from the cache, not the bundler's signed copies (tauri#14147, fix unreleased), so the cache must carry the signatures.

[CmdletBinding()]
param(
  # Pinned to the tauri-bundler constants shipped in @tauri-apps/cli 2.11.2
  # (crates/tauri-bundler/src/bundle/windows/nsis/mod.rs). If a CLI bump changes
  # the NSIS version, the bundler recreates the cache with unsigned DLLs and the
  # "Verify embedded installer payload signatures" gate fails with the exact
  # DLL names — update these constants alongside the CLI.
  [string]$NsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip",
  [string]$NsisSha1 = "EF7FF767E5CBD9EDD22ADD3A32C9B8F4500BB10D",
  [string]$NsisZipRoot = "nsis-3.11",
  # Hash-pinned by the bundler: must match byte-for-byte or the bundler
  # re-downloads it (which is also why this one is NOT signed here — it gets
  # signed on the bundler's build-local copy, which IS on the plugin search
  # path for additional/).
  [string]$UtilsUrl = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll",
  [string]$UtilsSha1 = "75197FEE3C6A814FE035788D1C34EAD39349B860",
  # Content-addressed signature cache directory (restored from R2 by the release
  # workflow). When set, the stock plugins reuse a prior release's signatures
  # instead of spending an SSL.com cloud signature each time — they are
  # byte-identical across releases (pinned NsisSha1), so the cache hits ~always.
  [string]$CacheDir = "",
  # Pre-sign hash manifest for the cache restore/save round-trip.
  [string]$Manifest = "windows-nsis-cache-manifest.tsv",
  # EV cert thumbprint; only signatures from this cert are trusted on restore.
  [string]$Thumbprint = ""
)

$ErrorActionPreference = "Stop"

function Get-VerifiedDownload {
  param([string]$Url, [string]$Sha1, [string]$OutFile)
  Invoke-WebRequest -Uri $Url -OutFile $OutFile
  $hash = (Get-FileHash -LiteralPath $OutFile -Algorithm SHA1).Hash
  if ($hash -ine $Sha1) {
    Write-Host "::error::SHA1 mismatch for ${Url}: expected $Sha1, got $hash."
    exit 1
  }
}

$toolsDir = Join-Path $env:LOCALAPPDATA "tauri"
$nsisDir = Join-Path $toolsDir "NSIS"

if (Test-Path -LiteralPath $nsisDir) {
  Write-Host "NSIS cache already present at $nsisDir; skipping seed."
} else {
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $zip = Join-Path $env:RUNNER_TEMP "nsis-toolset.zip"
  Get-VerifiedDownload -Url $NsisUrl -Sha1 $NsisSha1 -OutFile $zip
  Expand-Archive -LiteralPath $zip -DestinationPath $toolsDir
  Rename-Item -LiteralPath (Join-Path $toolsDir $NsisZipRoot) -NewName "NSIS"
  Write-Host "Seeded NSIS toolset cache at $nsisDir."
}

# The bundler treats additional/nsis_tauri_utils.dll as a required file: if it
# is missing it deletes and re-extracts the WHOLE cache, clobbering the
# signatures below. Seed it with the exact pinned bytes so the cache survives.
$additionalDir = Join-Path $nsisDir "Plugins/x86-unicode/additional"
$utilsDll = Join-Path $additionalDir "nsis_tauri_utils.dll"
if (-not (Test-Path -LiteralPath $utilsDll)) {
  New-Item -ItemType Directory -Force -Path $additionalDir | Out-Null
  Get-VerifiedDownload -Url $UtilsUrl -Sha1 $UtilsSha1 -OutFile $utilsDll
  Write-Host "Seeded nsis_tauri_utils.dll (hash-pinned, left unsigned on purpose)."
}

# Sign every stock plugin DLL the compiler could embed into $PLUGINSDIR
# (top level only — additional/ stays pristine, see above). Smart App Control
# evaluates these after the installer extracts them to %TEMP% (#2237).
$pluginDir = Join-Path $nsisDir "Plugins/x86-unicode"
$stock = @(Get-ChildItem -LiteralPath $pluginDir -Filter "*.dll" -File)
if ($stock.Count -eq 0) {
  Write-Host "::error::No stock plugin DLLs found under $pluginDir — NSIS zip layout changed?"
  exit 1
}
# The four our installer is known to embed (template + installer-hooks.nsh)
# must be in the set, or the seeded toolset cannot produce a clean installer.
$required = @("System.dll", "nsExec.dll", "StartMenu.dll", "nsDialogs.dll")
$missing = @($required | Where-Object { $_ -notin $stock.Name })
if ($missing.Count -gt 0) {
  Write-Host "::error::Stock plugin set is missing: $($missing -join ', ')."
  exit 1
}
$pluginPaths = @($stock | ForEach-Object { $_.FullName })

# Restore cached signatures before signing so unchanged plugins skip the cloud
# signer. Uses the same content-addressed engine as the embedded runtime; the
# signer's own valid-signature skip then avoids re-signing anything restored.
$cacheScript = Join-Path $PSScriptRoot "windows-signature-cache.ps1"
if ($CacheDir) {
  $listFile = Join-Path ([IO.Path]::GetTempPath()) "nsis-signables.txt"
  Set-Content -LiteralPath $listFile -Value $pluginPaths
  & $cacheScript -Mode restore -ListFile $listFile -CacheDir $CacheDir -Manifest $Manifest -Thumbprint $Thumbprint
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Signing $($stock.Count) stock NSIS plugin DLL(s) in the toolset cache..."
& (Join-Path $PSScriptRoot "sign-windows-payload.ps1") -File $pluginPaths
$signExit = $LASTEXITCODE
if ($signExit -ne 0) { exit $signExit }

# Persist newly signed plugins into the cache for the next release to restore.
if ($CacheDir) {
  & $cacheScript -Mode save -ListFile $listFile -CacheDir $CacheDir -Manifest $Manifest -Thumbprint $Thumbprint
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
exit 0
