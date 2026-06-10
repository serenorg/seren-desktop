# ABOUTME: Signs Windows PE binaries in place with signtool using the eSigner CKA-loaded EV cert (#2276).
# ABOUTME: Replaces CodeSignTool batch_sign (100-file/batch cap); enumerates signables under roots, signs in batches, fails loud if any file is left unsigned.

[CmdletBinding()]
param(
  # Authenticode cert thumbprint loaded into Cert:\CurrentUser\My by eSigner CKA.
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  # Directories to recurse for signable PE files.
  [string[]]$Root = @(),
  # Explicit files to sign (in addition to anything found under -Root).
  [string[]]$File = @(),
  # Files per signtool invocation — amortizes process startup while staying well
  # under the Windows command-line length limit.
  [int]$BatchSize = 50,
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

$targets = @($targets | Sort-Object -Unique)
if ($targets.Count -eq 0) {
  Write-Host "::error::No signable files found under roots [$($Root -join ', ')] / files [$($File -join ', ')]."
  exit 1
}
Write-Host "Signing $($targets.Count) file(s) in batches of $BatchSize..."

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
