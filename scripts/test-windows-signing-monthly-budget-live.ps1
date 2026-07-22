# ABOUTME: Runs the monthly SSL.com budget barrier against real R2 conditional writes; no storage mock is used.
# ABOUTME: Verifies 14x7 admission, the fifteenth block, concurrent near-limit exclusion, and cross-process persistence.

$ErrorActionPreference = "Stop"
$barrier = (Resolve-Path (Join-Path $PSScriptRoot "windows-signing-monthly-budget.ps1")).Path
$env:SSL_SIGNING_MONTHLY_BUDGET_CENTS = "10000"
$env:SSL_SIGNING_TIER_BASE_CENTS = "2000"
$env:SSL_SIGNING_TIER_INCLUDED_OPERATIONS = "20"
$env:SSL_SIGNING_TIER_OVERAGE_CENTS = "100"
$env:SSL_SIGNING_OTHER_FIXED_MONTHLY_CENTS = "0"
$env:SSL_SIGNING_BILLING_ANCHOR_DAY = "1"
$env:SSL_SIGNING_BILLING_TIMEZONE = "UTC"
$env:SSL_SIGNING_ACCOUNT = "live-cas-test"
$env:SSL_SIGNING_CERTIFICATE = "$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT-sequential"
$env:SSL_SIGNING_LEDGER_R2_PREFIX = "windows-signing-ledgers/live-tests"

& $barrier -Mode Bootstrap -BootstrapOperations 0 -BootstrapSource "live workflow sequential budget test" -BootstrapApprovedBy $env:GITHUB_ACTOR -BillingReference "synthetic live-test sequential cycle" -ConfirmZeroUsage
if ($LASTEXITCODE -ne 0) { throw "Could not bootstrap the isolated sequential live-test ledger." }
foreach ($release in 1..14) {
  & $barrier -Mode Reserve -Source "seven-operation-release-$release" -Invocation 1 -Operations 7
  if ($LASTEXITCODE -ne 0) { throw "Sequential reservation $release should have been admitted." }
}
& $barrier -Mode Reserve -Source "seven-operation-release-15" -Invocation 1 -Operations 7
if ($LASTEXITCODE -ne 2) { throw "The fifteenth seven-operation release was not blocked." }

$env:SSL_SIGNING_MONTHLY_BUDGET_CENTS = "2000"
$env:SSL_SIGNING_TIER_BASE_CENTS = "0"
$env:SSL_SIGNING_TIER_INCLUDED_OPERATIONS = "0"
$env:SSL_SIGNING_TIER_OVERAGE_CENTS = "2000"
$env:SSL_SIGNING_CERTIFICATE = "$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT-concurrent"
& $barrier -Mode Bootstrap -BootstrapOperations 0 -BootstrapSource "live workflow concurrent CAS test" -BootstrapApprovedBy $env:GITHUB_ACTOR -BillingReference "synthetic live-test concurrent cycle" -ConfirmZeroUsage
if ($LASTEXITCODE -ne 0) { throw "Could not bootstrap the isolated concurrent live-test ledger." }

$aOut = Join-Path $env:RUNNER_TEMP "a.out"; $aErr = Join-Path $env:RUNNER_TEMP "a.err"
$bOut = Join-Path $env:RUNNER_TEMP "b.out"; $bErr = Join-Path $env:RUNNER_TEMP "b.err"
$a = Start-Process pwsh -PassThru -ArgumentList @('-NoProfile','-File',$barrier,'-Mode','Reserve','-Source','concurrent-a','-Invocation','1','-Operations','1') -RedirectStandardOutput $aOut -RedirectStandardError $aErr
$b = Start-Process pwsh -PassThru -ArgumentList @('-NoProfile','-File',$barrier,'-Mode','Reserve','-Source','concurrent-b','-Invocation','1','-Operations','1') -RedirectStandardOutput $bOut -RedirectStandardError $bErr
$a.WaitForExit(); $b.WaitForExit()
Get-Content $aOut,$aErr,$bOut,$bErr -ErrorAction SilentlyContinue
$codes = @($a.ExitCode, $b.ExitCode) | Sort-Object
if (($codes -join ',') -ne '0,2') { throw "CAS test expected one admission and one budget block, got $($codes -join ',')." }

& $barrier -Mode Reserve -Source "persistence-check" -Invocation 1 -Operations 1
if ($LASTEXITCODE -ne 2) { throw "A separate process did not observe the persisted reservation." }

$env:SSL_SIGNING_MONTHLY_BUDGET_CENTS = "10000"
$env:SSL_SIGNING_TIER_BASE_CENTS = "2000"
$env:SSL_SIGNING_TIER_INCLUDED_OPERATIONS = "20"
$env:SSL_SIGNING_TIER_OVERAGE_CENTS = "100"
$env:SSL_SIGNING_OTHER_FIXED_MONTHLY_CENTS = "0"
$env:SSL_SIGNING_CERTIFICATE = "$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT-adjust"

& $barrier -Mode Bootstrap -BootstrapOperations 0 -BootstrapSource "live workflow adjust zero-confirmation control" -BootstrapApprovedBy $env:GITHUB_ACTOR -BillingReference "synthetic adjust zero control"
if ($LASTEXITCODE -ne 1) { throw "A zero bootstrap without -ConfirmZeroUsage was not rejected." }

& $barrier -Mode Bootstrap -BootstrapOperations 0 -BootstrapSource "live workflow adjust billing-reference control" -BootstrapApprovedBy $env:GITHUB_ACTOR -ConfirmZeroUsage
if ($LASTEXITCODE -ne 1) { throw "A zero bootstrap without -BillingReference was not rejected." }

& $barrier -Mode Bootstrap -BootstrapOperations 0 -BootstrapSource "live workflow adjust baseline test" -BootstrapApprovedBy $env:GITHUB_ACTOR -BillingReference "synthetic adjust baseline cycle" -ConfirmZeroUsage
if ($LASTEXITCODE -ne 0) { throw "Could not bootstrap the isolated adjust live-test ledger." }

& $barrier -Mode Reserve -Source "adjust-baseline-seed" -Invocation 1 -Operations 7
if ($LASTEXITCODE -ne 0) { throw "The adjust live-test seed reservation should have been admitted." }

& $barrier -Mode Adjust -AdjustedBaselineOperations 90 -BillingReference "synthetic adjust reference" -AdjustApprovedBy $env:GITHUB_ACTOR
if ($LASTEXITCODE -ne 0) { throw "The audited baseline adjustment should have succeeded." }

& $barrier -Mode Reserve -Source "adjusted-baseline-block" -Invocation 1 -Operations 7
if ($LASTEXITCODE -ne 2) { throw "The reservation above the adjusted baseline was not blocked." }

Write-Host "Live R2 monthly signing ledger validation passed without mocks."
exit 0
