# ABOUTME: Content-addressed cache for Windows Authenticode signatures so unchanged release payload binaries are signed once.
# ABOUTME: Restores only valid, trusted cached signatures before the existing signer runs, then saves newly signed cache misses.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet("restore", "save")][string]$Mode,
  # Newline-delimited signable set produced by scripts/print-windows-signables.ts.
  [Parameter(Mandatory = $true)][string]$ListFile,
  # Persistent cache directory restored/saved by the release workflow's R2 sync.
  [Parameter(Mandatory = $true)][string]$CacheDir,
  # Pre-sign hash manifest written by restore and consumed by save.
  [Parameter(Mandatory = $true)][string]$Manifest,
  # Only trust cached signatures produced by this certificate. Defaults from CI.
  [string]$Thumbprint = ""
)

$ErrorActionPreference = "Stop"
if (-not $Thumbprint) { $Thumbprint = $env:WINDOWS_SIGN_THUMBPRINT }
$trustedThumbprint = if ($Thumbprint) { $Thumbprint.Replace(" ", "").ToUpperInvariant() } else { "" }

function Get-Signables {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "ListFile not found: $Path" }
  Get-Content -LiteralPath $Path | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

function Test-TrustedSignature {
  param([string]$Path)
  $sig = Get-AuthenticodeSignature -LiteralPath $Path
  if ($sig.Status -ne "Valid" -or -not $sig.SignerCertificate) { return $false }
  if ($trustedThumbprint) {
    $actual = ([string]$sig.SignerCertificate.Thumbprint).Replace(" ", "").ToUpperInvariant()
    if ($actual -ne $trustedThumbprint) { return $false }
  }
  return $true
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
$manifestDir = Split-Path -Parent $Manifest
if ($manifestDir -and -not (Test-Path -LiteralPath $manifestDir)) {
  New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null
}

if ($Mode -eq "restore") {
  $lines = [System.Collections.Generic.List[string]]::new()
  [int]$restored = 0
  [int]$total = 0

  foreach ($raw in Get-Signables $ListFile) {
    if (-not (Test-Path -LiteralPath $raw)) { throw "Listed signable not found: $raw" }
    $file = (Resolve-Path -LiteralPath $raw).Path
    $total++

    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToUpperInvariant()
    $lines.Add("$hash`t$file")
    $blob = Join-Path $CacheDir "$hash.signed"
    if (-not (Test-Path -LiteralPath $blob)) { continue }

    $tmp = "$file.sigcache.tmp"
    Copy-Item -LiteralPath $blob -Destination $tmp -Force
    if (Test-TrustedSignature $tmp) {
      Move-Item -LiteralPath $tmp -Destination $file -Force
      $restored++
    } else {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $blob -Force -ErrorAction SilentlyContinue
      Write-Host "::warning::Discarded untrusted Windows signature-cache entry for $([IO.Path]::GetFileName($file))."
    }
  }

  Set-Content -LiteralPath $Manifest -Value $lines
  Write-Host "Windows signature cache: restored $restored of $total signable(s)."
} elseif ($Mode -eq "save") {
  if (-not (Test-Path -LiteralPath $Manifest)) { throw "Manifest not found: $Manifest" }

  [int]$saved = 0
  foreach ($line in Get-Content -LiteralPath $Manifest) {
    $parts = $line -split "`t", 2
    if ($parts.Count -ne 2) { continue }
    $hash = $parts[0]
    $file = $parts[1]
    $blob = Join-Path $CacheDir "$hash.signed"
    if (Test-Path -LiteralPath $blob) { continue }
    if (-not (Test-Path -LiteralPath $file)) { continue }
    if (-not (Test-TrustedSignature $file)) { continue }

    Copy-Item -LiteralPath $file -Destination $blob -Force
    $saved++
  }

  Write-Host "Windows signature cache: saved $saved newly signed blob(s)."
}
