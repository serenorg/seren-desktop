# ABOUTME: Hard-gates Windows release signing when an unchanged embedded-runtime manifest re-signs too many files.
# ABOUTME: Persists the manifest hash as a release asset so cache-restore regressions do not hide the comparison state.

[CmdletBinding()]
param(
  # Newline-delimited signable set produced by scripts/print-windows-signables.ts.
  [Parameter(Mandatory = $true)][string]$ListFile,
  # Pre-sign hash manifest written by scripts/windows-signature-cache.ps1 restore mode.
  [Parameter(Mandatory = $true)][string]$Manifest,
  # JSONL telemetry written by scripts/sign-windows-payload.ps1.
  [string]$TelemetryFile = "",
  # Previous release state downloaded from the GitHub release asset, when present.
  [string]$PreviousState = "",
  # State to upload with this release for the next release's comparison.
  [Parameter(Mandatory = $true)][string]$OutputState,
  # Maximum fresh embedded-runtime signatures allowed when the manifest is unchanged.
  # Defaults from WINDOWS_EMBEDDED_RUNTIME_CACHE_HIT_MAX_SIGNED, then 25.
  [int]$MaxSignedWhenUnchanged = -1,
  # Minimum percent of embedded-runtime signables that must restore from the
  # per-file cache when the manifest changed. Below this, the R2 cache is
  # treated as collapsed and the release fails (#2922). Defaults from
  # WINDOWS_EMBEDDED_RUNTIME_CACHE_MIN_RESTORE_RATE, then 75.
  [int]$MinRestoreRateWhenChanged = -1,
  # Stable base for turning absolute manifest paths into release-invariant paths.
  [string]$Workspace = ""
)

$ErrorActionPreference = "Stop"

function Resolve-NonNegativeInt {
  param(
    [string]$Raw,
    [string]$Name,
    [int]$Default
  )
  if (-not $Raw) { return $Default }
  [int]$parsed = 0
  if (-not [int]::TryParse($Raw, [ref]$parsed) -or $parsed -lt 0) {
    Write-Host "::error::$Name must be a non-negative integer, got '$Raw'."
    exit 1
  }
  return $parsed
}

function Get-StableManifestPath {
  param(
    [string]$Path,
    [string]$WorkspaceRoot
  )

  $full = [IO.Path]::GetFullPath($Path)
  if ($WorkspaceRoot) {
    $root = [IO.Path]::GetFullPath($WorkspaceRoot)
    $separators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $root = $root.TrimEnd($separators)
    if ($full.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return "."
    }
    $rootWithSeparator = "$root$([IO.Path]::DirectorySeparatorChar)"
    $rootWithAltSeparator = "$root$([IO.Path]::AltDirectorySeparatorChar)"
    if (
      $full.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($rootWithAltSeparator, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      return ([IO.Path]::GetRelativePath($root, $full)).Replace("\", "/")
    }
  }
  return $full.Replace("\", "/")
}

function Get-Sha256Hex {
  param([string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToUpperInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Read-ManifestSummary {
  param(
    [string]$Path,
    [string]$WorkspaceRoot
  )

  if (-not (Test-Path -LiteralPath $Path)) { throw "Manifest not found: $Path" }
  $entries = [System.Collections.Generic.List[string]]::new()
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    $parts = $trimmed -split "`t", 2
    if ($parts.Count -ne 2 -or -not $parts[0] -or -not $parts[1]) {
      throw "Malformed Windows signature cache manifest line: $trimmed"
    }
    $hash = $parts[0].Trim().ToUpperInvariant()
    $stablePath = Get-StableManifestPath -Path $parts[1].Trim() -WorkspaceRoot $WorkspaceRoot
    $entries.Add("$hash`t$stablePath")
  }
  if ($entries.Count -eq 0) { throw "Manifest has no signable entries: $Path" }
  $sorted = @($entries | Sort-Object)
  $payload = $sorted -join "`n"
  [PSCustomObject]@{
    hash = Get-Sha256Hex -Value $payload
    entries = $sorted.Count
  }
}

function Read-TelemetrySummary {
  param([string]$Path)

  if (-not $Path) { throw "TelemetryFile is required for the Windows signature cache gate." }
  if (-not (Test-Path -LiteralPath $Path)) { throw "TelemetryFile not found: $Path" }

  [int]$totalSigned = 0
  [int]$embeddedDiscovered = 0
  [int]$embeddedSkipped = 0
  [int]$embeddedWouldSign = 0
  [int]$embeddedSigned = 0
  [int]$embeddedRecords = 0

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try {
      $record = $trimmed | ConvertFrom-Json
    } catch {
      throw "Malformed Windows signing telemetry line in ${Path}: $trimmed"
    }
    if ($null -ne $record.signed) { $totalSigned += [int]$record.signed }
    $source = [string]$record.source
    if ($source.StartsWith("list:", [System.StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith("embedded-runtime", [System.StringComparison]::OrdinalIgnoreCase)) {
      $embeddedRecords++
      if ($null -ne $record.discovered) { $embeddedDiscovered += [int]$record.discovered }
      if ($null -ne $record.skipped) { $embeddedSkipped += [int]$record.skipped }
      if ($null -ne $record.would_sign) { $embeddedWouldSign += [int]$record.would_sign }
      if ($null -ne $record.signed) { $embeddedSigned += [int]$record.signed }
    }
  }

  if ($embeddedRecords -eq 0) {
    throw "No embedded-runtime signing telemetry found in $Path."
  }

  [PSCustomObject]@{
    total_signed = $totalSigned
    embedded_records = $embeddedRecords
    embedded_discovered = $embeddedDiscovered
    embedded_skipped = $embeddedSkipped
    embedded_would_sign = $embeddedWouldSign
    embedded_signed = $embeddedSigned
  }
}

function Read-PreviousState {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    Write-Host "::warning::Ignoring malformed previous Windows signing cache state at ${Path}: $($_.Exception.Message)"
    return $null
  }
}

function Write-CurrentState {
  param(
    [string]$Path,
    [object]$State
  )
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  ($State | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $Path
}

if (-not $TelemetryFile) { $TelemetryFile = $env:WINDOWS_SIGN_TELEMETRY_FILE }
if (-not $Workspace) { $Workspace = $env:GITHUB_WORKSPACE }
if (-not $Workspace) { $Workspace = (Get-Location).Path }
if ($MaxSignedWhenUnchanged -lt 0) {
  $MaxSignedWhenUnchanged = Resolve-NonNegativeInt `
    -Raw $env:WINDOWS_EMBEDDED_RUNTIME_CACHE_HIT_MAX_SIGNED `
    -Name "WINDOWS_EMBEDDED_RUNTIME_CACHE_HIT_MAX_SIGNED" `
    -Default 25
}
if ($MinRestoreRateWhenChanged -lt 0) {
  $MinRestoreRateWhenChanged = Resolve-NonNegativeInt `
    -Raw $env:WINDOWS_EMBEDDED_RUNTIME_CACHE_MIN_RESTORE_RATE `
    -Name "WINDOWS_EMBEDDED_RUNTIME_CACHE_MIN_RESTORE_RATE" `
    -Default 75
}

if (-not (Test-Path -LiteralPath $ListFile)) { throw "ListFile not found: $ListFile" }
$manifestSummary = Read-ManifestSummary -Path $Manifest -WorkspaceRoot $Workspace
$telemetrySummary = Read-TelemetrySummary -Path $TelemetryFile
$previous = Read-PreviousState -Path $PreviousState

$previousHash = if ($previous -and $previous.manifest_hash) {
  ([string]$previous.manifest_hash).ToUpperInvariant()
} else {
  ""
}

$status = "skipped_no_previous_state"
$currentHash = [string]$manifestSummary.hash
$restoreRate = if ($telemetrySummary.embedded_discovered -gt 0) {
  [math]::Round(100.0 * $telemetrySummary.embedded_skipped / $telemetrySummary.embedded_discovered, 2)
} else {
  100.0
}
if ($previousHash) {
  if ($previousHash -eq $currentHash) {
    $status = "passed_unchanged_manifest"
    if ($telemetrySummary.embedded_signed -gt $MaxSignedWhenUnchanged) {
      $status = "failed_unchanged_manifest_over_floor"
    }
  } else {
    # The manifest changed, but a previous release means the per-file R2 cache
    # should still restore the ~99% of embedded-runtime files that did not
    # change. A collapsed restore rate is the silent-overage signal (#2922):
    # the aggregate hash changing every release must not disable the guard.
    if ($telemetrySummary.embedded_discovered -gt 0 -and $restoreRate -lt $MinRestoreRateWhenChanged) {
      $status = "failed_changed_manifest_restore_collapsed"
    } else {
      $status = "passed_changed_manifest"
    }
  }
}

$state = [PSCustomObject]@{
  schema_version = 1
  created_at = (Get-Date).ToUniversalTime().ToString("o")
  github_ref = $env:GITHUB_REF
  github_sha = $env:GITHUB_SHA
  github_run_id = $env:GITHUB_RUN_ID
  manifest_hash = $currentHash
  manifest_entries = [int]$manifestSummary.entries
  previous_manifest_hash = if ($previousHash) { $previousHash } else { $null }
  cache_gate_status = $status
  max_signed_when_unchanged = $MaxSignedWhenUnchanged
  min_restore_rate_when_changed = $MinRestoreRateWhenChanged
  embedded_runtime_discovered = [int]$telemetrySummary.embedded_discovered
  embedded_runtime_skipped = [int]$telemetrySummary.embedded_skipped
  embedded_runtime_would_sign = [int]$telemetrySummary.embedded_would_sign
  embedded_runtime_signed = [int]$telemetrySummary.embedded_signed
  embedded_runtime_restore_rate = $restoreRate
  total_signed_so_far = [int]$telemetrySummary.total_signed
}
Write-CurrentState -Path $OutputState -State $state

if ($status -eq "failed_unchanged_manifest_over_floor") {
  Write-Host "::error::Windows signature cache regression: embedded-runtime manifest hash $currentHash matches the previous release, but $($telemetrySummary.embedded_signed) embedded-runtime file(s) were freshly signed; expected <= $MaxSignedWhenUnchanged."
  Write-Host "::error::Inspect telemetry '$TelemetryFile', cache manifest '$Manifest', previous state '$PreviousState', and current state '$OutputState'. The R2 signature-cache restore may be broken or returning an empty cache."
  exit 1
}

if ($status -eq "failed_changed_manifest_restore_collapsed") {
  Write-Host "::error::Windows signature cache regression: embedded-runtime manifest changed, but only $($telemetrySummary.embedded_skipped)/$($telemetrySummary.embedded_discovered) ($restoreRate%) signable(s) restored from the per-file cache; below the $MinRestoreRateWhenChanged% floor. This release would freshly sign $($telemetrySummary.embedded_signed) file(s) and silently bill SSL.com (#2922)."
  Write-Host "::error::Inspect telemetry '$TelemetryFile', cache manifest '$Manifest', and the R2 signature-cache restore. If this release intentionally overhauls the embedded runtime, lower WINDOWS_EMBEDDED_RUNTIME_CACHE_MIN_RESTORE_RATE for this run."
  exit 1
}

if ($status -eq "passed_unchanged_manifest") {
  Write-Host "Windows signature cache gate passed: unchanged embedded-runtime manifest $currentHash signed $($telemetrySummary.embedded_signed) file(s), max $MaxSignedWhenUnchanged."
} elseif ($status -eq "passed_changed_manifest") {
  Write-Host "Windows signature cache gate passed: embedded-runtime manifest changed from $previousHash to $currentHash, but $restoreRate% of signables restored from cache (min $MinRestoreRateWhenChanged%); signed $($telemetrySummary.embedded_signed) file(s)."
} else {
  Write-Host "Windows signature cache gate skipped: no previous release state was available."
}
Write-Host "Windows signature cache state written: $OutputState"
