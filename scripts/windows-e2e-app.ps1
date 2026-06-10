param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [int]$RemoteDebugPort = 9222,

  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "SerenDesktopE2E"),

  [int]$StartupTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "::error::$Message"
  exit 1
}

function Require-Env([string[]]$Names) {
  $missing = @()
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
      $missing += $name
    }
  }
  if ($missing.Count -gt 0) {
    Fail "Missing required Windows e2e secret(s): $($missing -join ', ')"
  }
}

function Require-ValidSignature([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "$Label not found: $Path"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne "Valid") {
    Fail "$Label is not validly Authenticode signed. Status=$($signature.Status) Subject=$($signature.SignerCertificate.Subject)"
  }
  Write-Host "$Label signature valid: $Path"
}

function Wait-ForCdp([int]$Port, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $url = "http://127.0.0.1:$Port/json/version"
  do {
    try {
      $response = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 2
      if ($response.webSocketDebuggerUrl) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  Fail "Timed out waiting for WebView2 remote debugging endpoint at $url"
}

function Find-RequiredFile([string]$Root, [string]$Filter, [string]$Label) {
  $match = Get-ChildItem -Path $Root -Filter $Filter -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $match) {
    Fail "Installed app is missing $Label under $Root"
  }
  return $match.FullName
}

Require-Env @(
  "SEREN_E2E_EMAIL",
  "SEREN_E2E_PASSWORD",
  "SEREN_E2E_HISTORY_PROJECT_ID",
  "SEREN_E2E_HISTORY_BRANCH_ID",
  "SEREN_E2E_HISTORY_DATABASE_NAME",
  "SEREN_E2E_GITHUB_USERNAME",
  "SEREN_E2E_GITHUB_PASSWORD",
  "SEREN_E2E_GITHUB_PAT"
)

if (-not [string]::IsNullOrWhiteSpace($env:SEREN_E2E_API_BASE) -and $env:SEREN_E2E_API_BASE.TrimEnd("/") -ne "https://api.serendb.com") {
  Fail "Windows e2e must run against production. SEREN_E2E_API_BASE=$env:SEREN_E2E_API_BASE"
}
$env:SEREN_E2E_API_BASE = "https://api.serendb.com"
$env:SEREN_E2E_CDP_ENDPOINT = "http://127.0.0.1:$RemoteDebugPort"

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
Require-ValidSignature $resolvedInstaller "Windows NSIS installer"

Get-Process -Name "Seren" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $InstallDir) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "Installing SerenDesktop into $InstallDir"
$installArgs = @("/S", "/D=$InstallDir")
$install = Start-Process -FilePath $resolvedInstaller -ArgumentList $installArgs -Wait -PassThru
if ($install.ExitCode -ne 0) {
  Fail "NSIS installer exited with $($install.ExitCode)"
}

$appExe = Join-Path $InstallDir "Seren.exe"
if (-not (Test-Path -LiteralPath $appExe)) {
  $appExe = Find-RequiredFile $InstallDir "Seren.exe" "Seren.exe"
}
Require-ValidSignature $appExe "Installed Seren.exe"

$runtimeRoot = Join-Path $InstallDir "embedded-runtime"
if (-not (Test-Path -LiteralPath $runtimeRoot)) {
  Fail "Installed app is missing embedded-runtime at $runtimeRoot"
}
$nodeExe = Find-RequiredFile $runtimeRoot "node.exe" "bundled node.exe"
$npmCmd = Find-RequiredFile $runtimeRoot "npm.cmd" "bundled npm.cmd"
$providerRuntime = Find-RequiredFile $runtimeRoot "provider-runtime.mjs" "provider-runtime.mjs"

$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersion)) {
  Fail "Bundled node.exe did not execute successfully"
}
$npmVersion = & $npmCmd --version
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($npmVersion)) {
  Fail "Bundled npm.cmd did not execute successfully"
}
Write-Host "Bundled runtime verified: node=$nodeVersion npm=$npmVersion providerRuntime=$providerRuntime"

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$RemoteDebugPort --remote-allow-origins=*"
Write-Host "Launching Seren.exe with WebView2 remote debugging on port $RemoteDebugPort"
$app = Start-Process -FilePath $appExe -PassThru

try {
  Wait-ForCdp -Port $RemoteDebugPort -TimeoutSeconds $StartupTimeoutSeconds
  node "$PSScriptRoot/windows-e2e-app.mjs"
  if ($LASTEXITCODE -ne 0) {
    Fail "Windows app e2e script failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($null -ne $app -and -not $app.HasExited) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name "Seren" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
