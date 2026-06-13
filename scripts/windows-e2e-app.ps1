param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [switch]$AllowUnsignedPrArtifact,

  [int]$RemoteDebugPort = 9222,

  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "SerenDesktopE2E"),

  [int]$StartupTimeoutSeconds = 120,

  [int]$InstallerTimeoutSeconds = 180,

  [int]$ProbeTimeoutSeconds = 1800
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "::error::$Message"
  exit 1
}

function Write-Stage([string]$Message) {
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Write-Host "[windows-e2e] $timestamp $Message"
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
    $subject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "<none>" }
    Fail "$Label is not validly Authenticode signed. Status=$($signature.Status) Subject=$subject"
  }
  Write-Host "$Label signature valid: $Path"
}

function Require-SignedOrExplicitPrArtifact([string]$Path, [string]$Label) {
  if (-not $AllowUnsignedPrArtifact) {
    Require-ValidSignature $Path $Label
    return
  }

  if ($env:SEREN_E2E_UNSIGNED_PR_RUN -ne "1") {
    Fail "-AllowUnsignedPrArtifact requires SEREN_E2E_UNSIGNED_PR_RUN=1 so release signature checks cannot be bypassed accidentally."
  }
  if ($env:SEREN_E2E_RELEASE_RUN -eq "1" -or $env:GITHUB_REF -like "refs/tags/v*") {
    Fail "-AllowUnsignedPrArtifact is forbidden for release Windows e2e runs."
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "$Label not found: $Path"
  }

  Write-Host "::warning::$Label Authenticode validation skipped for explicit unsigned PR artifact run: $Path"
}

function Clear-DownloadMark([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "$Label not found: $Path"
  }
  try {
    Unblock-File -LiteralPath $Path -ErrorAction Stop
    Write-Host "Cleared download mark for ${Label}: $Path"
  } catch {
    Write-Host "::warning::Unable to clear download mark for ${Label}: $($_.Exception.Message)"
  }
}

function Clear-DownloadMarksUnder([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) {
    return
  }
  Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Unblock-File -LiteralPath $_.FullName -ErrorAction Stop
    } catch {
      Write-Host "::warning::Unable to clear download mark for installed file $($_.FullName): $($_.Exception.Message)"
    }
  }
}

function Invoke-ProcessWithTimeout([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSeconds, [string]$Label, [switch]$NoNewWindow) {
  Write-Stage "Starting ${Label} with ${TimeoutSeconds}s timeout"
  $startArgs = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    PassThru = $true
  }
  if ($NoNewWindow) {
    $startArgs.NoNewWindow = $true
  }
  $process = Start-Process @startArgs
  $timeoutMs = [int]([Math]::Min([int]::MaxValue, [int64]$TimeoutSeconds * 1000))
  if (-not $process.WaitForExit($timeoutMs)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Fail "$Label timed out after ${TimeoutSeconds}s and was killed."
  }
  Write-Stage "${Label} exited with code $($process.ExitCode)"
  return $process.ExitCode
}

function Write-DirectorySnapshot([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host "Install directory does not exist: $Root"
    return
  }
  Write-Host "Install directory snapshot for ${Root}:"
  Get-ChildItem -Path $Root -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object -First 80 FullName, Length, LastWriteTime |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
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

Write-Stage "Validating required production e2e environment"
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

Write-Stage "Preparing installer artifact"
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
Clear-DownloadMark $resolvedInstaller "Windows NSIS installer"
Require-SignedOrExplicitPrArtifact $resolvedInstaller "Windows NSIS installer"

Write-Stage "Cleaning existing Seren processes and install directory"
Get-Process -Name "Seren" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $InstallDir) {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Stage "Installing SerenDesktop into $InstallDir"
$installArgs = @("/S", "/D=$InstallDir")
$installExitCode = Invoke-ProcessWithTimeout $resolvedInstaller $installArgs $InstallerTimeoutSeconds "NSIS installer"
if ($installExitCode -ne 0) {
  Fail "NSIS installer exited with $installExitCode"
}
if ($AllowUnsignedPrArtifact) {
  Clear-DownloadMarksUnder $InstallDir
}

Write-Stage "Validating installed app payload"
$appExe = Join-Path $InstallDir "Seren.exe"
if (-not (Test-Path -LiteralPath $appExe)) {
  Write-DirectorySnapshot $InstallDir
  $appExe = Find-RequiredFile $InstallDir "Seren.exe" "Seren.exe"
}
Require-SignedOrExplicitPrArtifact $appExe "Installed Seren.exe"

$runtimeRoot = Join-Path $InstallDir "embedded-runtime"
if (-not (Test-Path -LiteralPath $runtimeRoot)) {
  Fail "Installed app is missing embedded-runtime at $runtimeRoot"
}
Write-Stage "Validating bundled runtime"
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
Write-Stage "Launching Seren.exe with WebView2 remote debugging on port $RemoteDebugPort"
$app = Start-Process -FilePath $appExe -PassThru

try {
  Write-Stage "Waiting for WebView2 CDP endpoint"
  Wait-ForCdp -Port $RemoteDebugPort -TimeoutSeconds $StartupTimeoutSeconds
  Write-Stage "Running Node app e2e probe"
  $probeExitCode = Invoke-ProcessWithTimeout "node" @("$PSScriptRoot/windows-e2e-app.mjs") $ProbeTimeoutSeconds "Windows app e2e probe" -NoNewWindow
  if ($probeExitCode -ne 0) {
    Fail "Windows app e2e script failed with exit code $probeExitCode"
  }
} finally {
  Write-Stage "Cleaning up Seren processes"
  if ($null -ne $app -and -not $app.HasExited) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name "Seren" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
