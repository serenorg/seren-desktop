# ABOUTME: Atomically reserves SSL.com operations in a billing-cycle R2 ledger before every cloud-signing call.
# ABOUTME: Uses conditional PutObject requests so concurrent release jobs cannot overspend the configured monthly budget.

[CmdletBinding()]
param(
  [ValidateSet("Reserve", "Bootstrap")][string]$Mode = "Reserve",
  [string]$Source = "",
  [int]$Invocation = 0,
  [int]$Operations = 0,
  [int]$BootstrapOperations = -1,
  [string]$BootstrapSource = "",
  [string]$BootstrapApprovedBy = "",
  [string]$OutputFile = "",
  [int]$MaxCasAttempts = 8
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
  Write-Host "::error::$Message"
  exit 1
}

function Require-Text([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { Fail "$Name is required for monthly signing-budget enforcement." }
  return $value.Trim()
}

function Require-NonNegativeInt([string]$Name) {
  $raw = Require-Text $Name
  [int64]$value = 0
  if (-not [int64]::TryParse($raw, [ref]$value) -or $value -lt 0) {
    Fail "$Name must be a non-negative integer, got '$raw'."
  }
  return $value
}

function Get-Cycle([datetimeoffset]$Now, [int]$AnchorDay, [string]$TimeZoneId) {
  try { $zone = [TimeZoneInfo]::FindSystemTimeZoneById($TimeZoneId) } catch { Fail "Invalid SSL_SIGNING_BILLING_TIMEZONE '$TimeZoneId': $($_.Exception.Message)" }
  $local = [TimeZoneInfo]::ConvertTime($Now, $zone)
  $monthStart = [datetime]::new($local.Year, $local.Month, 1, 0, 0, 0, [DateTimeKind]::Unspecified)
  $days = [DateTime]::DaysInMonth($monthStart.Year, $monthStart.Month)
  if ($AnchorDay -gt $days) { Fail "SSL_SIGNING_BILLING_ANCHOR_DAY=$AnchorDay does not exist in $($monthStart.ToString('yyyy-MM'))." }
  $boundary = $monthStart.AddDays($AnchorDay - 1)
  if ($local.DateTime -lt $boundary) {
    $monthStart = $monthStart.AddMonths(-1)
    $days = [DateTime]::DaysInMonth($monthStart.Year, $monthStart.Month)
    if ($AnchorDay -gt $days) { Fail "SSL_SIGNING_BILLING_ANCHOR_DAY=$AnchorDay does not exist in $($monthStart.ToString('yyyy-MM'))." }
    $boundary = $monthStart.AddDays($AnchorDay - 1)
  }
  $nextMonth = $monthStart.AddMonths(1)
  $nextDays = [DateTime]::DaysInMonth($nextMonth.Year, $nextMonth.Month)
  if ($AnchorDay -gt $nextDays) { Fail "SSL_SIGNING_BILLING_ANCHOR_DAY=$AnchorDay does not exist in $($nextMonth.ToString('yyyy-MM'))." }
  $nextBoundary = $nextMonth.AddDays($AnchorDay - 1)
  return [PSCustomObject]@{
    id = $boundary.ToString("yyyy-MM-dd")
    starts_at = ([TimeZoneInfo]::ConvertTimeToUtc($boundary, $zone)).ToString("o")
    ends_at = ([TimeZoneInfo]::ConvertTimeToUtc($nextBoundary, $zone)).ToString("o")
    timezone = $TimeZoneId
    anchor_day = $AnchorDay
  }
}

function Project-Cost([int64]$ProjectedOperations, [int64]$Base, [int64]$Included, [int64]$Overage, [int64]$Fixed) {
  return $Base + $Fixed + ([Math]::Max([int64]0, $ProjectedOperations - $Included) * $Overage)
}

function Invoke-Aws([string[]]$Arguments, [switch]$AllowFailure) {
  $output = & aws @Arguments 2>&1 | Out-String
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFailure) { Fail "R2 ledger request failed (aws $($Arguments[0..1] -join ' ')): $($output.Trim())" }
  return [PSCustomObject]@{ code = $code; output = $output.Trim() }
}

$budget = Require-NonNegativeInt "SSL_SIGNING_MONTHLY_BUDGET_CENTS"
$base = Require-NonNegativeInt "SSL_SIGNING_TIER_BASE_CENTS"
$included = Require-NonNegativeInt "SSL_SIGNING_TIER_INCLUDED_OPERATIONS"
$overage = Require-NonNegativeInt "SSL_SIGNING_TIER_OVERAGE_CENTS"
$fixed = Require-NonNegativeInt "SSL_SIGNING_OTHER_FIXED_MONTHLY_CENTS"
$anchorRaw = Require-Text "SSL_SIGNING_BILLING_ANCHOR_DAY"
[int]$anchor = 0
if (-not [int]::TryParse($anchorRaw, [ref]$anchor) -or $anchor -lt 1 -or $anchor -gt 28) { Fail "SSL_SIGNING_BILLING_ANCHOR_DAY must be an integer from 1 through 28, got '$anchorRaw'." }
$timezone = Require-Text "SSL_SIGNING_BILLING_TIMEZONE"
$account = Require-Text "SSL_SIGNING_ACCOUNT"
$certificate = Require-Text "SSL_SIGNING_CERTIFICATE"
$bucket = Require-Text "R2_BUCKET"
$endpoint = Require-Text "AWS_ENDPOINT_URL"
$prefix = Require-Text "SSL_SIGNING_LEDGER_R2_PREFIX"
if ($base + $fixed -gt $budget) { Fail "Fixed Tier 1 costs ($($base + $fixed) cents) already exceed SSL_SIGNING_MONTHLY_BUDGET_CENTS=$budget." }
if ($overage -eq 0) { Fail "SSL_SIGNING_TIER_OVERAGE_CENTS must be greater than zero so the operation ceiling is finite." }

$cycle = Get-Cycle ([DateTimeOffset]::UtcNow) $anchor $timezone
$safeAccount = ($account -replace '[^A-Za-z0-9._-]', '_')
$safeCertificate = ($certificate -replace '[^A-Za-z0-9._-]', '_')
$key = "$($prefix.Trim('/'))/$safeAccount/$safeCertificate/$($cycle.id).json"
$uri = "s3://$bucket/$key"
$configuration = [ordered]@{ budget_cents=$budget; base_cents=$base; included_operations=$included; overage_cents=$overage; other_fixed_monthly_cents=$fixed }

if ($Mode -eq "Bootstrap") {
  if ($BootstrapOperations -lt 0) { Fail "BootstrapOperations must be supplied from authoritative current-cycle SSL.com usage." }
  if ([string]::IsNullOrWhiteSpace($BootstrapSource) -or [string]::IsNullOrWhiteSpace($BootstrapApprovedBy)) { Fail "BootstrapSource and BootstrapApprovedBy are required for an audited bootstrap." }
  $cost = Project-Cost $BootstrapOperations $base $included $overage $fixed
  if ($cost -gt $budget) { Fail "Bootstrap usage projects $cost cents, above the $budget-cent monthly budget." }
  $now = [DateTimeOffset]::UtcNow.ToString("o")
  $ledger = [ordered]@{
    schema_version=1; account=$account; certificate=$certificate; billing_cycle=$cycle.id
    cycle_starts_at=$cycle.starts_at; cycle_ends_at=$cycle.ends_at; billing_timezone=$cycle.timezone; billing_anchor_day=$cycle.anchor_day
    configuration=$configuration; committed_or_reserved_operations=$BootstrapOperations; projected_cost_cents=$cost
    bootstrap=[ordered]@{ operations=$BootstrapOperations; source=$BootstrapSource; recorded_at=$now; approved_by=$BootstrapApprovedBy }
    updated_at=$now; version=1; entries=@()
  }
  $temp = Join-Path ([IO.Path]::GetTempPath()) "ssl-ledger-bootstrap-$([guid]::NewGuid()).json"
  try {
    ($ledger | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $temp -Encoding utf8
    $result = Invoke-Aws @("s3api","put-object","--bucket",$bucket,"--key",$key,"--body",$temp,"--if-none-match","*","--endpoint-url",$endpoint,"--output","json") -AllowFailure
    if ($result.code -ne 0) { Fail "The active-cycle ledger already exists or R2 rejected atomic bootstrap. Inspect it instead of overwriting it: $($result.output)" }
  } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  Write-Host "Bootstrapped SSL.com ledger $uri with $BootstrapOperations authoritative operation(s), projected cost $cost cents."
  exit 0
}

if ($Mode -eq "Reserve" -and ($Operations -lt 1 -or [string]::IsNullOrWhiteSpace($Source) -or $Invocation -lt 1)) { Fail "Reserve requires Source, Invocation >= 1, and Operations >= 1." }
$runId = Require-Text "GITHUB_RUN_ID"
$runAttempt = Require-Text "GITHUB_RUN_ATTEMPT"
$idempotencyKey = "$runId/$runAttempt/$Source/$Invocation"

for ($attempt = 1; $attempt -le $MaxCasAttempts; $attempt++) {
  $head = Invoke-Aws @("s3api","head-object","--bucket",$bucket,"--key",$key,"--endpoint-url",$endpoint,"--output","json") -AllowFailure
  if ($head.code -ne 0) { Fail "Monthly ledger $uri is missing or unreachable. Bootstrap authoritative active-cycle usage before signing. $($head.output)" }
  try { $etag = ([string](($head.output | ConvertFrom-Json).ETag)).Trim('"') } catch { Fail "Could not parse the R2 ETag for $uri." }
  if ([string]::IsNullOrWhiteSpace($etag)) { Fail "R2 returned no ETag for $uri; atomicity cannot be proven." }
  $current = Join-Path ([IO.Path]::GetTempPath()) "ssl-ledger-current-$([guid]::NewGuid()).json"
  $next = Join-Path ([IO.Path]::GetTempPath()) "ssl-ledger-next-$([guid]::NewGuid()).json"
  try {
    $get = Invoke-Aws @("s3api","get-object","--bucket",$bucket,"--key",$key,"--if-match",$etag,"--endpoint-url",$endpoint,$current,"--output","json") -AllowFailure
    if ($get.code -ne 0) { continue }
    try { $ledger = Get-Content -Raw -LiteralPath $current | ConvertFrom-Json } catch { Fail "Monthly ledger $uri is corrupt: $($_.Exception.Message)" }
    if ($ledger.schema_version -ne 1 -or $ledger.account -ne $account -or $ledger.certificate -ne $certificate -or $ledger.billing_cycle -ne $cycle.id) { Fail "Monthly ledger identity/schema does not match the configured account, certificate, and billing cycle." }
    if ($ledger.cycle_starts_at -ne $cycle.starts_at -or $ledger.cycle_ends_at -ne $cycle.ends_at -or $ledger.billing_timezone -ne $timezone -or [int]$ledger.billing_anchor_day -ne $anchor) { Fail "Monthly ledger billing boundary is stale or conflicts with repository configuration." }
    foreach ($name in $configuration.Keys) { if ([int64]$ledger.configuration.$name -ne [int64]$configuration[$name]) { Fail "Monthly ledger configuration '$name' conflicts with repository configuration." } }
    if ($null -eq $ledger.bootstrap -or [string]::IsNullOrWhiteSpace([string]$ledger.bootstrap.source) -or [string]::IsNullOrWhiteSpace([string]$ledger.bootstrap.approved_by)) { Fail "Monthly ledger has no authoritative audited bootstrap." }
    $existing = @($ledger.entries | Where-Object { $_.idempotency_key -eq $idempotencyKey })
    if ($existing.Count -gt 0) {
      if ([int]$existing[0].operations -ne $Operations) { Fail "Idempotency key $idempotencyKey was already reserved with a different operation count." }
      Write-Host "Monthly reservation already committed (idempotent): $idempotencyKey."
      if ($OutputFile) { Copy-Item -LiteralPath $current -Destination $OutputFile -Force }
      exit 0
    }
    $projectedOperations = [int64]$ledger.committed_or_reserved_operations + $Operations
    $cost = Project-Cost $projectedOperations $base $included $overage $fixed
    if ($cost -gt $budget) {
      if ($OutputFile) { Copy-Item -LiteralPath $current -Destination $OutputFile -Force }
      Write-Host "::warning::Monthly SSL.com signing blocked before cloud call: cycle=$($cycle.id) used=$($ledger.committed_or_reserved_operations) requested=$Operations projected_cost_cents=$cost budget_cents=$budget."
      exit 2
    }
    $entry = [PSCustomObject]@{ run_id=$runId; run_attempt=[int]$runAttempt; source=$Source; invocation=$Invocation; operations=$Operations; idempotency_key=$idempotencyKey; status="reserved_before_cloud_call"; reserved_at=[DateTimeOffset]::UtcNow.ToString("o") }
    $ledger.entries = @($ledger.entries) + $entry
    $ledger.committed_or_reserved_operations = $projectedOperations
    $ledger.projected_cost_cents = $cost
    $ledger.updated_at = [DateTimeOffset]::UtcNow.ToString("o")
    $ledger.version = [int64]$ledger.version + 1
    ($ledger | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $next -Encoding utf8
    $put = Invoke-Aws @("s3api","put-object","--bucket",$bucket,"--key",$key,"--body",$next,"--if-match",$etag,"--endpoint-url",$endpoint,"--output","json") -AllowFailure
    if ($put.code -eq 0) {
      if ($OutputFile) { Copy-Item -LiteralPath $next -Destination $OutputFile -Force }
      Write-Host "Reserved $Operations SSL.com operation(s): cycle=$($cycle.id) total=$projectedOperations projected_cost_cents=$cost ledger_version=$($ledger.version)."
      $percent = [Math]::Floor(($cost * 100) / $budget)
      if ($percent -ge 100) { Write-Host "::warning::SSL.com monthly signing budget is 100% consumed; later billable operations will be blocked." }
      elseif ($percent -ge 90) { Write-Host "::warning::SSL.com monthly signing budget has reached at least 90% ($percent%)." }
      elseif ($percent -ge 75) { Write-Host "::notice::SSL.com monthly signing budget has reached at least 75% ($percent%)." }
      elseif ($percent -ge 50) { Write-Host "::notice::SSL.com monthly signing budget has reached at least 50% ($percent%)." }
      exit 0
    }
    if ($put.output -notmatch "PreconditionFailed|412|ConditionalRequestConflict|409") { Fail "R2 conditional ledger write failed: $($put.output)" }
  } finally {
    Remove-Item -LiteralPath $current,$next -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds ([Math]::Min(1000, 50 * [Math]::Pow(2, $attempt - 1)))
}
Fail "Monthly ledger CAS conflicted $MaxCasAttempts times; signing is blocked because atomic reservation could not be proven."
