#requires -version 5.1

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "scripts/test-windows-cargo.ps1 must be run on Windows."
}

function Resolve-MtExe {
  $existing = Get-Command "mt.exe" -ErrorAction SilentlyContinue
  if ($existing) {
    return $existing.Source
  }

  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  $candidates = @()
  foreach ($root in $roots) {
    $sdkBin = Join-Path $root "Windows Kits\10\bin"
    if (Test-Path $sdkBin) {
      $candidates += Get-ChildItem -Path $sdkBin -Recurse -Filter "mt.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\mt\.exe$" }
    }
  }

  $selected = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $selected) {
    throw "mt.exe was not found. Install the Windows SDK with Visual Studio Build Tools."
  }

  return $selected.FullName
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
$commonControlsManifest = Join-Path $targetDeps "common-controls-v6.manifest"

Push-Location $repoRoot
try {
  Invoke-Checked "cargo" "test" "--manifest-path" $cargoManifest "--no-run"

  if (-not (Test-Path $targetDeps)) {
    throw "Cargo did not produce the expected target deps directory: $targetDeps"
  }

  Remove-AppLocalApiSetForwarders $targetDeps

  @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}" />
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}" />
    </application>
  </compatibility>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"@ | Set-Content -Path $commonControlsManifest -Encoding ASCII

  $mt = Resolve-MtExe
  $testExecutables = Get-ChildItem -Path $targetDeps -Filter "*.exe" -File
  if (-not $testExecutables) {
    throw "Cargo did not produce any Windows test executables in $targetDeps."
  }

  foreach ($testExecutable in $testExecutables) {
    Invoke-Checked $mt "-manifest" $commonControlsManifest "-outputresource:$($testExecutable.FullName);#1"
  }

  Invoke-Checked "cargo" "test" "--manifest-path" $cargoManifest
}
finally {
  Pop-Location
}
