# ABOUTME: Enforces the cumulative per-release Windows cloud-signing budget before signtool can run.
# ABOUTME: Persists fail-closed block telemetry so later signing sources skip while the unsigned release remains buildable.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][int]$Discovered,
  [Parameter(Mandatory = $true)][int]$Skipped,
  [Parameter(Mandatory = $true)][int]$WouldSign,
  [int]$UniqueHashes = 0,
  [int]$AliasesRestored = 0,
  [int]$MaxSignatures = -1,
  [string]$TelemetryFile = "",
  [string]$BlockFile = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Host "::error::$Message"
  exit 1
}

function Resolve-MaxSignatures([int]$Explicit) {
  if ($Explicit -ge 0) { return $Explicit }
  $raw = $env:MAX_SIGNATURES
  if ([string]::IsNullOrWhiteSpace($raw)) {
    Fail "MAX_SIGNATURES is required and must be a non-negative integer."
  }
  [int]$parsed = 0
  if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 0) {
    Fail "MAX_SIGNATURES must be a non-negative integer, got '$raw'."
  }
  return $parsed
}

function Read-PreviousSignedCount([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  [int]$total = 0
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try {
      $record = $trimmed | ConvertFrom-Json
    } catch {
      Fail "Malformed Windows signing telemetry line in ${Path}: $trimmed"
    }
    if ($null -eq $record.signed) {
      Fail "Windows signing telemetry line has no signed count in ${Path}: $trimmed"
    }
    $total += [int]$record.signed
  }
  return $total
}

function Write-Telemetry(
  [string]$Path,
  [string]$Status,
  [int]$PreviousSigned,
  [int]$Max,
  [int]$ProjectedTotal
) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $record = [PSCustomObject]@{
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    status = $Status
    source = $Source
    discovered = $Discovered
    skipped = $Skipped
    would_sign = $WouldSign
    signed = 0
    unique_hashes = $UniqueHashes
    aliases_restored = $AliasesRestored
    previous_signed = $PreviousSigned
    max_signatures = $Max
    projected_total = $ProjectedTotal
    blocked = $true
  }
  ($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $Path
}

$max = Resolve-MaxSignatures $MaxSignatures
if (-not $TelemetryFile) { $TelemetryFile = $env:WINDOWS_SIGN_TELEMETRY_FILE }
if ([string]::IsNullOrWhiteSpace($TelemetryFile)) {
  Fail "WINDOWS_SIGN_TELEMETRY_FILE is required for fail-closed signing-budget enforcement."
}
if (-not $BlockFile) { $BlockFile = $env:WINDOWS_SIGNING_BLOCK_FILE }
if ([string]::IsNullOrWhiteSpace($BlockFile)) {
  Fail "WINDOWS_SIGNING_BLOCK_FILE is required for fail-closed signing-budget enforcement."
}

$previousSigned = Read-PreviousSignedCount $TelemetryFile
$projectedTotal = $previousSigned + $WouldSign

if (Test-Path -LiteralPath $BlockFile) {
  Write-Telemetry $TelemetryFile "skipped_budget_blocked" $previousSigned $max $projectedTotal
  Write-Host "Windows signing remains blocked; source '$Source' will not invoke signtool."
  exit 2
}

Write-Host "Windows signing budget: source='$Source' previous=$previousSigned would_sign=$WouldSign projected=$projectedTotal max=$max."
if ($projectedTotal -le $max) { exit 0 }

Write-Telemetry $TelemetryFile "blocked_over_budget" $previousSigned $max $projectedTotal
$blockDir = Split-Path -Parent $BlockFile
if ($blockDir -and -not (Test-Path -LiteralPath $blockDir)) {
  New-Item -ItemType Directory -Force -Path $blockDir | Out-Null
}
$state = [PSCustomObject]@{
  schema_version = 1
  created_at = (Get-Date).ToUniversalTime().ToString("o")
  status = "blocked_over_budget"
  source = $Source
  previous_signed = $previousSigned
  would_sign = $WouldSign
  projected_total = $projectedTotal
  max_signatures = $max
}
($state | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $BlockFile
if ($env:GITHUB_ENV) {
  "WINDOWS_SIGNING_BLOCKED=true" | Add-Content -LiteralPath $env:GITHUB_ENV
}
Write-Host "::error::Windows signing blocked before signtool: source '$Source' would bring this release to $projectedTotal cloud signature(s), above MAX_SIGNATURES=$max. The release will continue with a transparently unsigned Windows artifact."
exit 2
