#requires -version 5.1

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "scripts/test-windows-cargo.ps1 must be run on Windows."
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Remove-AppLocalApiSetForwarders {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Directory
  )

  if (-not (Test-Path $Directory)) {
    return
  }

  # API-set DLLs are OS contracts. App-local downlevel copies can shadow
  # KernelBase-backed implementations and break modern Windows test binaries.
  Get-ChildItem -Path $Directory -Filter "api-ms-win-*.dll" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tauriDir = Join-Path $repoRoot "src-tauri"
$cargoManifest = Join-Path $tauriDir "Cargo.toml"
$targetDeps = Join-Path $tauriDir "target\debug\deps"

Push-Location $repoRoot
try {
  Invoke-Checked "cargo" "test" "--manifest-path" $cargoManifest "--no-run"

  if (-not (Test-Path $targetDeps)) {
    throw "Cargo did not produce the expected target deps directory: $targetDeps"
  }

  Remove-AppLocalApiSetForwarders $targetDeps

  Invoke-Checked "cargo" "test" "--manifest-path" $cargoManifest
}
finally {
  Pop-Location
}
