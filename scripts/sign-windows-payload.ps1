# ABOUTME: Signs Windows PE binaries in place with signtool using the eSigner CKA-loaded EV cert (#2276).
# ABOUTME: Takes signables from -Root/-File/-ListFile, skips already-signed, signs in throttled batches (#2282), fails loud if any file is left unsigned.
# ABOUTME: Reports the Windows release signature budget and writes per-invocation telemetry (#2818/#2821).

[CmdletBinding()]
param(
  # Authenticode cert thumbprint loaded into Cert:\CurrentUser\My by eSigner CKA.
  # Defaults from WINDOWS_SIGN_THUMBPRINT so tauri's signCommand (static args,
  # no secrets) can invoke this wrapper per file (#2294).
  [string]$Thumbprint = "",
  # Directories to recurse for signable PE files.
  [string[]]$Root = @(),
  # Explicit files to sign (in addition to anything found under -Root).
  [string[]]$File = @(),
  # Newline-delimited file produced by scripts/windows-signables.ts — the
  # discovered embedded-runtime signable set. Each non-empty line is a path.
  [string]$ListFile = "",
  # Files per signtool invocation — amortizes process startup while staying well
  # under the Windows command-line length limit.
  [int]$BatchSize = 50,
  # Seconds to pause between batches. Each signtool call signs one cloud hash per
  # file, so bursting the whole payload trips SSL.com's per-minute rate limit
  # (#2282). Pausing between batches holds the request rate under that ceiling.
  [int]$DelaySeconds = 0,
  # Maximum cumulative cloud hash-signing operations expected for this release job.
  # Defaults from MAX_SIGNATURES; unset/-1 disables the warning for local ad-hoc use.
  [int]$MaxSignatures = -1,
  # JSONL telemetry file shared across signer invocations in one release job.
  # Defaults from WINDOWS_SIGN_TELEMETRY_FILE.
  [string]$TelemetryFile = "",
  [int]$MaxRetries = 3
)

$ErrorActionPreference = "Stop"

function Resolve-MaxSignatureBudget {
  param([int]$Explicit)
  if ($Explicit -ge 0) { return $Explicit }
  $raw = $env:MAX_SIGNATURES
  if (-not $raw) { return -1 }
  [int]$parsed = 0
  if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 0) {
    Write-Host "::error::MAX_SIGNATURES must be a non-negative integer, got '$raw'."
    exit 1
  }
  return $parsed
}

function Get-SigningSource {
  if ($ListFile) { return "list:$ListFile" }
  if ($File.Count -gt 0 -and $Root.Count -eq 0) { return "file" }
  if ($Root.Count -gt 0 -and $File.Count -eq 0) { return "root" }
  return "mixed"
}

function Read-PreviousSignedCount {
  param([string]$Path)
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return 0 }
  [int]$total = 0
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    try {
      $record = $trimmed | ConvertFrom-Json
      if ($null -ne $record.signed) { $total += [int]$record.signed }
    } catch {
      Write-Host "::warning::Ignoring malformed Windows signing telemetry line in ${Path}: $trimmed"
    }
  }
  return $total
}

function Write-SigningTelemetry {
  param(
    [string]$Path,
    [string]$Status,
    [string]$Source,
    [int]$Discovered,
    [int]$Skipped,
    [int]$WouldSign,
    [int]$Signed,
    [int]$PreviousSigned,
    [int]$Max
  )
  if (-not $Path) { return }
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
    signed = $Signed
    previous_signed = $PreviousSigned
    max_signatures = if ($Max -ge 0) { $Max } else { $null }
  }
  ($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $Path
}

# Resolve the thumbprint before anything else so a missing credential fails
# fast with an actionable error instead of a confusing signtool failure.
if (-not $Thumbprint) { $Thumbprint = $env:WINDOWS_SIGN_THUMBPRINT }
if (-not $Thumbprint) {
  Write-Host "::error::No certificate thumbprint: pass -Thumbprint or set WINDOWS_SIGN_THUMBPRINT (exported by the eSigner CKA setup step)."
  exit 1
}
$maxSignatureBudget = Resolve-MaxSignatureBudget -Explicit $MaxSignatures
if (-not $TelemetryFile) { $TelemetryFile = $env:WINDOWS_SIGN_TELEMETRY_FILE }
$signingSource = Get-SigningSource

# Authenticode-signable PE extensions. .pyd/.node are ordinary DLLs; signtool
# signs them in place by content, so (unlike CodeSignTool) no extension rewrite
# is needed.
$signableExt = @(".exe", ".dll", ".node", ".pyd")

# Build the target set: explicit files + every signable under each root.
$targets = [System.Collections.Generic.List[string]]::new()
foreach ($f in $File) {
  if (-not (Test-Path -LiteralPath $f)) {
    Write-Host "::error::Signable file not found: $f"
    exit 1
  }
  $targets.Add((Resolve-Path -LiteralPath $f).Path)
}
foreach ($r in $Root) {
  if (-not (Test-Path -LiteralPath $r)) {
    Write-Host "Skipping missing root: $r"
    continue
  }
  Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($signableExt -contains $_.Extension.ToLower()) { $targets.Add($_.FullName) }
  }
}
if ($ListFile) {
  if (-not (Test-Path -LiteralPath $ListFile)) {
    Write-Host "::error::ListFile not found: $ListFile"
    exit 1
  }
  Get-Content -LiteralPath $ListFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line) { return }
    if (-not (Test-Path -LiteralPath $line)) {
      Write-Host "::error::Listed signable not found: $line"
      exit 1
    }
    $targets.Add((Resolve-Path -LiteralPath $line).Path)
  }
}

$targets = @($targets | Sort-Object -Unique)
if ($targets.Count -eq 0) {
  Write-Host "::error::No signable files found under roots [$($Root -join ', ')] / files [$($File -join ', ')] / list [$ListFile]."
  exit 1
}

# Skip files that already carry a valid Authenticode signature — Smart App
# Control honors any valid signature regardless of publisher, so re-signing
# them only burns cloud signatures against the rate limit (#2282).
# -LiteralPath, not -FilePath: the runtime ships binaries like "[.exe" whose
# brackets -FilePath would mis-parse as a wildcard pattern (#2286).
$discovered = $targets.Count
$targets = @($targets | Where-Object {
  (Get-AuthenticodeSignature -LiteralPath $_).Status -ne "Valid"
})
$skipped = $discovered - $targets.Count
if ($skipped -gt 0) {
  Write-Host "Skipping $skipped already-validly-signed file(s)."
}
if ($targets.Count -eq 0) {
  Write-Host "All $discovered discovered file(s) already validly signed; nothing to do."
  $previousSigned = Read-PreviousSignedCount -Path $TelemetryFile
  Write-SigningTelemetry -Path $TelemetryFile -Status "success" -Source $signingSource -Discovered $discovered -Skipped $skipped -WouldSign 0 -Signed 0 -PreviousSigned $previousSigned -Max $maxSignatureBudget
  exit 0
}
$previousSigned = Read-PreviousSignedCount -Path $TelemetryFile
$projectedSigned = $previousSigned + $targets.Count
$telemetryStatus = "success"
if ($maxSignatureBudget -ge 0) {
  Write-Host "Windows signing budget: $previousSigned already signed, this invocation would sign $($targets.Count), max $maxSignatureBudget."
  if ($projectedSigned -gt $maxSignatureBudget) {
    Write-Host "::warning::Windows signing budget exceeded: signing $($targets.Count) more file(s) would bring this release to $projectedSigned cloud signature(s), above MAX_SIGNATURES=$maxSignatureBudget."
    Write-Host "::warning::Release signing will continue. Audit sign-targets.txt / Windows signing telemetry and raise MAX_SIGNATURES if this release intentionally needs the extra signatures."
    $telemetryStatus = "over_budget"
  }
}
Write-Host "Signing $($targets.Count) file(s) in batches of $BatchSize (delay ${DelaySeconds}s between batches)..."

# Discover the newest x64 signtool.exe from the installed Windows 10 SDK rather
# than hardcoding an SDK version that drifts on the hosted runner.
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\x64\\" } |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $signtool) {
  Write-Host "::error::Could not locate an x64 signtool.exe under the Windows 10 SDK."
  exit 1
}
Write-Host "Using signtool: $($signtool.FullName)"

# signtool signs each file by sending only its hash to the SSL.com cloud (one op
# per file). Retry each batch for transient cloud/timestamp failures.
$ts = "http://ts.ssl.com"
for ($i = 0; $i -lt $targets.Count; $i += $BatchSize) {
  $end = [Math]::Min($i + $BatchSize - 1, $targets.Count - 1)
  $batch = @($targets[$i..$end])
  $attempt = 0
  while ($true) {
    $attempt++
    & $signtool.FullName sign /fd sha256 /tr $ts /td sha256 /sha1 $Thumbprint $batch
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -ge $MaxRetries) {
      Write-Host "::error::signtool failed for the batch starting at index $i after $MaxRetries attempt(s) (exit $LASTEXITCODE)."
      exit 1
    }
    Write-Host "signtool batch failed (exit $LASTEXITCODE); retry $attempt/$MaxRetries after backoff..."
    Start-Sleep -Seconds (5 * $attempt)
  }
  Write-Host "  signed $([Math]::Min($i + $BatchSize, $targets.Count))/$($targets.Count)"
  # Throttle between batches (not after the last) to stay under the rate limit.
  if ($DelaySeconds -gt 0 -and ($i + $BatchSize) -lt $targets.Count) {
    Start-Sleep -Seconds $DelaySeconds
  }
}

# Fail loud if the signer silently dropped any file (the #2223 guarantee): every
# target must carry a Valid Authenticode signature before we proceed.
$unsigned = @()
foreach ($t in $targets) {
  $sig = Get-AuthenticodeSignature -LiteralPath $t
  if ($sig.Status -ne "Valid") { $unsigned += "$t : $($sig.Status)" }
}
if ($unsigned.Count -gt 0) {
  Write-Host "::error::$($unsigned.Count) file(s) are not validly signed after signing:"
  $unsigned | ForEach-Object { Write-Host "    $_" }
  exit 1
}
Write-SigningTelemetry -Path $TelemetryFile -Status $telemetryStatus -Source $signingSource -Discovered $discovered -Skipped $skipped -WouldSign $targets.Count -Signed $targets.Count -PreviousSigned $previousSigned -Max $maxSignatureBudget
Write-Host "All $($targets.Count) file(s) carry a Valid Authenticode signature."
