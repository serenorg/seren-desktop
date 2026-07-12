param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [switch]$AllowUnsignedPrArtifact,

  [switch]$AllowUnsignedBudgetBlockedArtifact,

  [int]$RemoteDebugPort = 9222,

  [string]$InstallDir = "",

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

function Get-DefaultInstallDir() {
  $localAppData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  $systemDrive = if ([string]::IsNullOrWhiteSpace($env:SystemDrive)) { "C:" } else { $env:SystemDrive }
  if ([string]::IsNullOrWhiteSpace($localAppData) -or $localAppData -like "*\Windows\system32\config\systemprofile\AppData\Local") {
    return (Join-Path $systemDrive "SerenDesktopE2E")
  }
  return (Join-Path $localAppData "SerenDesktopE2E")
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
  if (-not $AllowUnsignedPrArtifact -and -not $AllowUnsignedBudgetBlockedArtifact) {
    Require-ValidSignature $Path $Label
    return
  }

  if ($AllowUnsignedBudgetBlockedArtifact) {
    if ($env:SEREN_E2E_RELEASE_RUN -ne "1" -or $env:SEREN_E2E_WINDOWS_SIGNING_BLOCKED -ne "1") {
      Fail "-AllowUnsignedBudgetBlockedArtifact requires an explicit budget-blocked release run."
    }
    if (-not (Test-Path -LiteralPath $Path)) {
      Fail "$Label not found: $Path"
    }
    Write-Host "::warning::$Label Authenticode validation skipped for explicit MAX_SIGNATURES-blocked release: $Path"
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

function Get-WebView2RuntimeVersion() {
  $runtimeClientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  $candidatePaths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$runtimeClientId",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$runtimeClientId",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeClientId"
  )
  foreach ($path in $candidatePaths) {
    try {
      if (-not (Test-Path -LiteralPath $path)) {
        continue
      }
      $runtime = Get-ItemProperty -LiteralPath $path -ErrorAction Stop
      if (-not [string]::IsNullOrWhiteSpace($runtime.pv) -and $runtime.pv -ne "0.0.0.0") {
        return "$($runtime.pv) ($path)"
      }
    } catch {
      Write-Host "::warning::Unable to inspect WebView2 runtime registry key ${path}: $($_.Exception.Message)"
    }
  }
  return $null
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

function Invoke-ProcessWithTimeout([string]$FilePath, [string[]]$ArgumentList, [int]$TimeoutSeconds, [string]$Label, [switch]$NoNewWindow, [scriptblock]$OnTimeout = $null, [string]$StdoutPath = "", [string]$StderrPath = "") {
  Write-Stage "Starting ${Label} with ${TimeoutSeconds}s timeout"
  $startArgs = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    PassThru = $true
  }
  if ($NoNewWindow) {
    $startArgs.NoNewWindow = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($StdoutPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StdoutPath) | Out-Null
    $startArgs.RedirectStandardOutput = $StdoutPath
  }
  if (-not [string]::IsNullOrWhiteSpace($StderrPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StderrPath) | Out-Null
    $startArgs.RedirectStandardError = $StderrPath
  }
  $process = Start-Process @startArgs
  $timeoutMs = [int]([Math]::Min([int]::MaxValue, [int64]$TimeoutSeconds * 1000))
  if (-not $process.WaitForExit($timeoutMs)) {
    Write-Stage "${Label} exceeded ${TimeoutSeconds}s timeout; collecting timeout diagnostics"
    if ($null -ne $OnTimeout) {
      try {
        & $OnTimeout
      } catch {
        Write-Host "::warning::Timeout diagnostics for ${Label} failed: $($_.Exception.Message)"
      }
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Write-FileTail $StdoutPath 200
    Write-FileTail $StderrPath 200
    Fail "$Label timed out after ${TimeoutSeconds}s and was killed."
  }
  try {
    $process.WaitForExit()
    $process.Refresh()
  } catch {
    Write-Host "::warning::Unable to refresh ${Label} process exit status: $($_.Exception.Message)"
  }
  if ($null -eq $process.ExitCode) {
    Write-Stage "${Label} exited without reporting an exit code"
    return $null
  }
  $exitCode = [int]$process.ExitCode
  Write-Stage "${Label} exited with code $exitCode"
  return $exitCode
}

function Write-FileTail([string]$Path, [int]$Tail = 200) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) {
    return
  }
  Write-Host "Tail of ${Path}:"
  Get-Content -LiteralPath $Path -Tail $Tail -ErrorAction SilentlyContinue | Write-Host
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

function Write-WindowsLaunchDiagnostics([System.Diagnostics.Process]$AppProcess) {
  Write-Stage "Collecting Windows launch diagnostics"
  if ($null -ne $AppProcess) {
    try {
      $AppProcess.Refresh()
      Write-Host "Seren process: pid=$($AppProcess.Id) exited=$($AppProcess.HasExited) exitCode=$(if ($AppProcess.HasExited) { $AppProcess.ExitCode } else { '<running>' })"
    } catch {
      Write-Host "::warning::Unable to refresh Seren process state: $($_.Exception.Message)"
    }
  }

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("Seren.exe", "msedgewebview2.exe") } |
    Select-Object ProcessId, ParentProcessId, SessionId, Name, CommandLine |
    Format-List |
    Out-String |
    Write-Host

  Write-Host "Windows identity:"
  & { $ErrorActionPreference = "Continue"; whoami 2>&1 } | Out-String | Write-Host
  Write-Host "Windows sessions:"
  & { $ErrorActionPreference = "Continue"; query session 2>&1 } | Out-String | Write-Host
  Write-Host "Logged-on users:"
  & { $ErrorActionPreference = "Continue"; quser 2>&1 } | Out-String | Write-Host
}

function Write-ProbeTimeoutDiagnostics([System.Diagnostics.Process]$AppProcess) {
  Write-Stage "Collecting probe timeout diagnostics"
  Write-WindowsLaunchDiagnostics $AppProcess

  Write-Host "Windows e2e probe process snapshot:"
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("node.exe", "npm.cmd", "powershell.exe", "cmd.exe", "claude.exe", "codex.exe", "Seren.exe", "msedgewebview2.exe") } |
    Select-Object ProcessId, ParentProcessId, SessionId, Name, CreationDate |
    Sort-Object Name, ProcessId |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
}

function Copy-E2EAppLogs([string]$DestinationDir) {
  New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  $roots = @()
  foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
    if ([string]::IsNullOrWhiteSpace($base)) {
      continue
    }
    $roots += @(
      (Join-Path $base "com.serendb.desktop\logs"),
      (Join-Path $base "SerenDesktop\logs"),
      (Join-Path $base "Seren\logs")
    )
  }

  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }
    try {
      $safeName = ($root -replace "[:\\\/]+", "_").Trim("_")
      $target = Join-Path $DestinationDir "app-logs-$safeName"
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      Copy-Item -Path (Join-Path $root "*") -Destination $target -Recurse -Force -ErrorAction Stop
      Write-Stage "Copied app logs from $root to $target"
    } catch {
      Write-Host "::warning::Unable to copy app logs from ${root}: $($_.Exception.Message)"
    }
  }
}

function Get-WebView2UserDataDirs() {
  # WebView2 stores its profile (including DevToolsActivePort) under the app's
  # bundle-identifier folder. Mirror the roots Copy-E2EAppLogs already trusts.
  $dirs = @()
  foreach ($base in @($env:LOCALAPPDATA, $env:APPDATA)) {
    if ([string]::IsNullOrWhiteSpace($base)) {
      continue
    }
    $dirs += (Join-Path $base "com.serendb.desktop\EBWebView")
  }
  return @($dirs | Select-Object -Unique)
}

function Get-DevToolsActivePort([string[]]$UserDataDirs) {
  # WebView2/Chromium writes the actually-bound remote-debugging port into
  # <user-data-dir>\DevToolsActivePort (first line). Returns 0 when no readable
  # port file exists yet.
  foreach ($dir in $UserDataDirs) {
    $portFile = Join-Path $dir "DevToolsActivePort"
    if (-not (Test-Path -LiteralPath $portFile)) {
      continue
    }
    try {
      $firstLine = Get-Content -LiteralPath $portFile -TotalCount 1 -ErrorAction Stop | Select-Object -First 1
      $parsed = 0
      if (-not [string]::IsNullOrWhiteSpace($firstLine) -and [int]::TryParse($firstLine.Trim(), [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
      }
    } catch {
      Write-Host "::warning::Unable to read DevToolsActivePort at ${portFile}: $($_.Exception.Message)"
    }
  }
  return 0
}

function Write-DevToolsActivePortDiagnostics([string[]]$UserDataDirs) {
  Write-Host "DevToolsActivePort probe:"
  foreach ($dir in $UserDataDirs) {
    $portFile = Join-Path $dir "DevToolsActivePort"
    if (Test-Path -LiteralPath $portFile) {
      $contents = (Get-Content -LiteralPath $portFile -ErrorAction SilentlyContinue) -join " | "
      Write-Host "  present: $portFile -> [$contents]"
    } else {
      Write-Host "  missing: $portFile"
    }
  }
}

function Wait-ForCdp([int]$Port, [int]$TimeoutSeconds, [System.Diagnostics.Process]$AppProcess, [string[]]$UserDataDirs) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $portsTried = [System.Collections.Generic.List[int]]::new()
  $portsTried.Add($Port)
  do {
    if ($null -ne $AppProcess) {
      $AppProcess.Refresh()
      if ($AppProcess.HasExited) {
        Write-WindowsLaunchDiagnostics $AppProcess
        Write-DevToolsActivePortDiagnostics $UserDataDirs
        Fail "Seren.exe exited before WebView2 CDP became available. ExitCode=$($AppProcess.ExitCode)"
      }
    }

    # Prefer the port WebView2 actually bound. If it declined the requested port
    # (busy, ephemeral fallback, or a version-specific behavior change like the
    # Evergreen 149->150 bump in #2902), DevToolsActivePort names the real one;
    # poll it too instead of the fixed 9222 forever.
    $filePort = Get-DevToolsActivePort $UserDataDirs
    if ($filePort -gt 0 -and -not $portsTried.Contains($filePort)) {
      Write-Stage "DevToolsActivePort reports WebView2 bound port $filePort (requested $Port); adding it to the CDP probe set"
      $portsTried.Add($filePort)
    }

    foreach ($candidate in $portsTried) {
      try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/json/version" -Method Get -TimeoutSec 2
        if ($response.webSocketDebuggerUrl) {
          if ($candidate -ne $Port) {
            Write-Stage "WebView2 CDP came up on port $candidate (requested $Port)"
          }
          return $candidate
        }
      } catch {
        # endpoint not ready yet; retry every candidate until the deadline
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  $webViewCount = @(Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue).Count
  Write-WindowsLaunchDiagnostics $AppProcess
  Write-DevToolsActivePortDiagnostics $UserDataDirs
  Fail "Timed out waiting for WebView2 remote debugging endpoint on port(s) $($portsTried -join ', '). msedgewebview2 process count=$webViewCount"
}

function Find-RequiredFile([string]$Root, [string]$Filter, [string]$Label) {
  $match = Get-ChildItem -Path $Root -Filter $Filter -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $match) {
    Fail "Installed app is missing $Label under $Root"
  }
  return $match.FullName
}

$e2eLogDir = Join-Path (Split-Path -Parent $PSScriptRoot) "windows-e2e-logs"
New-Item -ItemType Directory -Force -Path $e2eLogDir | Out-Null
$probeStdoutPath = Join-Path $e2eLogDir "windows-e2e-probe.stdout.log"
$probeStderrPath = Join-Path $e2eLogDir "windows-e2e-probe.stderr.log"

Write-Stage "Validating required production e2e environment"
Require-Env @(
  "SEREN_E2E_EMAIL",
  "SEREN_E2E_PASSWORD",
  "SEREN_E2E_GITHUB_PAT"
)

if (-not [string]::IsNullOrWhiteSpace($env:SEREN_E2E_API_BASE) -and $env:SEREN_E2E_API_BASE.TrimEnd("/") -ne "https://api.serendb.com") {
  Fail "Windows e2e must run against production. SEREN_E2E_API_BASE=$env:SEREN_E2E_API_BASE"
}
$env:SEREN_E2E_API_BASE = "https://api.serendb.com"
$env:SEREN_E2E_CDP_ENDPOINT = "http://127.0.0.1:$RemoteDebugPort"

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Get-DefaultInstallDir
}
Write-Stage "Using Windows e2e install directory $InstallDir"

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
if ($AllowUnsignedPrArtifact -or $AllowUnsignedBudgetBlockedArtifact) {
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

$webView2Runtime = Get-WebView2RuntimeVersion
if ([string]::IsNullOrWhiteSpace($webView2Runtime)) {
  Fail "Microsoft Edge WebView2 Runtime is not installed. The Windows app cannot create a WebView2/CDP endpoint without the Evergreen Runtime."
}
Write-Stage "WebView2 runtime detected: $webView2Runtime"

# SEREN_E2E_REMOTE_DEBUG_PORT is the primary switch: the app reads it at startup
# and enables WebView2 remote debugging through its own AdditionalBrowserArguments.
# WebView2 150 ignores the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var once the
# host app sets browser args, so that env var no longer reaches the browser
# process (#2902). We keep setting it too as a fallback for WebView2 149-era
# runtimes that still honor it. --remote-allow-origins stays a wildcard: it only
# gates the WebSocket upgrade, not the /json/version HTTP discovery, and an
# explicit fixed-port origin would reject the non-9222 DevToolsActivePort fallback.
$env:SEREN_E2E_REMOTE_DEBUG_PORT = "$RemoteDebugPort"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$RemoteDebugPort --remote-allow-origins=*"
$env:SEREN_E2E_CAPTURE_INJECTION = "1"
$webViewUserDataDirs = Get-WebView2UserDataDirs
Write-Stage "Launching Seren.exe with WebView2 remote debugging on port $RemoteDebugPort"
$app = Start-Process -FilePath $appExe -PassThru

try {
  Write-Stage "Waiting for WebView2 CDP endpoint"
  $cdpPort = Wait-ForCdp -Port $RemoteDebugPort -TimeoutSeconds $StartupTimeoutSeconds -AppProcess $app -UserDataDirs $webViewUserDataDirs
  # Thread the port WebView2 actually bound through to the probe (#2902); it may
  # differ from $RemoteDebugPort when DevToolsActivePort resolved a fallback.
  $env:SEREN_E2E_CDP_ENDPOINT = "http://127.0.0.1:$cdpPort"
  Write-Stage "Using CDP endpoint $env:SEREN_E2E_CDP_ENDPOINT for the Windows app e2e probe"
  Write-Stage "Running Node app e2e probe"
  $probeExitCode = Invoke-ProcessWithTimeout "node" @("$PSScriptRoot/windows-e2e-app.mjs") $ProbeTimeoutSeconds "Windows app e2e probe" -NoNewWindow -StdoutPath $probeStdoutPath -StderrPath $probeStderrPath -OnTimeout {
    Write-ProbeTimeoutDiagnostics $app
  }
  if ($null -eq $probeExitCode -and (Test-Path -LiteralPath $probeStdoutPath)) {
    $probePassed = Select-String -LiteralPath $probeStdoutPath -SimpleMatch "[windows-e2e] full Windows production e2e passed" -Quiet
    if ($probePassed) {
      Write-Stage "Windows app e2e probe exit code was blank but success sentinel was observed"
      $probeExitCode = 0
    }
  }
  if ($probeExitCode -ne 0) {
    Write-FileTail $probeStdoutPath 200
    Write-FileTail $probeStderrPath 200
    Fail "Windows app e2e script failed with exit code $probeExitCode"
  }
} finally {
  Copy-E2EAppLogs $e2eLogDir
  Write-Stage "Cleaning up Seren processes"
  if ($null -ne $app -and -not $app.HasExited) {
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  Get-Process -Name "Seren" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Copy-E2EAppLogs $e2eLogDir
}
