# ABOUTME: Signs Windows PE binaries in place with signtool using the eSigner CKA-loaded EV cert (#2276).
# ABOUTME: Takes signables from -Root/-File/-ListFile, skips already-signed, signs in throttled batches (#2282), fails loud if any file is left unsigned.

[CmdletBinding()]
param(
  # Authenticode cert thumbprint loaded into Cert:\CurrentUser\My by eSigner CKA.
  [Parameter(Mandatory = $true)][string]$Thumbprint,
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
  [int]$MaxRetries = 3
)

$ErrorActionPreference = "Stop"

# Authenticode-signable PE extensions. .pyd/.node are ordinary DLLs; signtool
# signs them in place by content, so (unlike CodeSignTool) no extension rewrite
# is needed.
$signableExt = @(".exe", ".dll", ".node", ".pyd")

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
$discovered = $targets.Count
$targets = @($targets | Where-Object {
  (Get-AuthenticodeSignature -FilePath $_).Status -ne "Valid"
})
$skipped = $discovered - $targets.Count
if ($skipped -gt 0) {
  Write-Host "Skipping $skipped already-validly-signed file(s)."
}
if ($targets.Count -eq 0) {
  Write-Host "All $discovered discovered file(s) already validly signed; nothing to do."
  exit 0
}
Write-Host "Signing $($targets.Count) file(s) in batches of $BatchSize (delay ${DelaySeconds}s between batches)..."

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
  $sig = Get-AuthenticodeSignature -FilePath $t
  if ($sig.Status -ne "Valid") { $unsigned += "$t : $($sig.Status)" }
}
if ($unsigned.Count -gt 0) {
  Write-Host "::error::$($unsigned.Count) file(s) are not validly signed after signing:"
  $unsigned | ForEach-Object { Write-Host "    $_" }
  exit 1
}
Write-Host "All $($targets.Count) file(s) carry a Valid Authenticode signature."
