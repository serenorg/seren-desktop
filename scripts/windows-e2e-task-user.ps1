param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$WorkDir,

  [Parameter(Mandatory = $true)]
  [string]$SecretParameterPrefix,

  [int]$RemoteDebugPort = 9222,

  [int]$StartupTimeoutSeconds = 120,

  [int]$InstallerTimeoutSeconds = 1200,

  [int]$ProbeTimeoutSeconds = 1800,

  [int]$TaskTimeoutSeconds = 4800,

  [switch]$AllowUnsignedPrArtifact,

  [switch]$AllowUnsignedBudgetBlockedArtifact,

  [switch]$AllowMissingAgentCredentials
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  Write-Host "::error::$Message"
  exit 1
}

function Write-Stage([string]$Message) {
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Write-Host "[windows-e2e:task-user] $timestamp $Message"
}

function Convert-ToSingleQuotedPowerShellString([string]$Value) {
  return "'$($Value.Replace("'", "''"))'"
}

function New-TemporaryPassword() {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    do {
      $bytes = New-Object byte[] 18
      $rng.GetBytes($bytes)
      $token = ([Convert]::ToBase64String($bytes) -replace "[^A-Za-z0-9]", "")
    } while ($token.Length -lt 16)
    return "S3ren-$($token.Substring(0, 16))!9a"
  } finally {
    $rng.Dispose()
  }
}

function Invoke-CleanupWithTimeout {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [scriptblock]$ScriptBlock,

    [object[]]$ArgumentList = @(),

    [int]$TimeoutSeconds = 30
  )

  $job = $null
  try {
    $job = Start-Job -ScriptBlock $ScriptBlock -ArgumentList $ArgumentList
    $completed = Wait-Job -Job $job -Timeout $TimeoutSeconds
    if (-not $completed) {
      Write-Host "::warning::$Label timed out after ${TimeoutSeconds}s; continuing cleanup"
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      return
    }
    Receive-Job -Job $job -ErrorAction Continue | Out-Host
  } catch {
    Write-Host "::warning::$Label failed: $($_.Exception.Message)"
  } finally {
    if ($job) {
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-E2EProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
  )

  $normalizedInstallDir = $InstallDir.TrimEnd("\")
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $name = [string]$_.Name
        $path = [string]$_.ExecutablePath
        $commandLine = [string]$_.CommandLine
        $inInstallDir =
          $path.StartsWith($normalizedInstallDir, [StringComparison]::OrdinalIgnoreCase) -or
          ($commandLine.IndexOf($normalizedInstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0)
        $isAppProcess = @("Seren.exe", "msedgewebview2.exe") -contains $name
        $isRuntimeNode = $name -eq "node.exe" -and $inInstallDir
        $isAppProcess -or $isRuntimeNode
      } |
      ForEach-Object {
        Write-Stage "Stopping leftover e2e process $($_.Name) pid=$($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
  } catch {
    Write-Host "::warning::Unable to stop leftover e2e process tree: $($_.Exception.Message)"
  }
}

function Remove-LocalE2EUser([string]$UserName) {
  if ([string]::IsNullOrWhiteSpace($UserName)) {
    return
  }
  $profilePath = Join-Path "C:\Users" $UserName
  Invoke-CleanupWithTimeout `
    -Label "Delete temporary Windows user $UserName" `
    -ScriptBlock { param($Name) & net user $Name /delete 2>$null | Out-Null } `
    -ArgumentList @($UserName) `
    -TimeoutSeconds 15
  Invoke-CleanupWithTimeout `
    -Label "Remove temporary Windows profile registration $profilePath" `
    -ScriptBlock {
      param($Path)
      Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPath -eq $Path } |
        Remove-CimInstance -ErrorAction SilentlyContinue
    } `
    -ArgumentList @($profilePath) `
    -TimeoutSeconds 30
  Invoke-CleanupWithTimeout `
    -Label "Remove temporary Windows profile directory $profilePath" `
    -ScriptBlock {
      param($Path)
      if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
      }
    } `
    -ArgumentList @($profilePath) `
    -TimeoutSeconds 30
}

function Remove-StaleE2EUsers() {
  # A cancelled/superseded release run (or a killed SSM step) skips the finally
  # teardown, leaking its temporary SerenE2E* admin account and profile dir.
  # Reap every existing SerenE2E* account and orphaned profile dir before this
  # run creates its user, so leaks self-heal instead of accumulating.
  # windows-app-e2e is serialized (group: release), so no concurrent run owns
  # one of these accounts. #2468
  try {
    foreach ($staleUser in @(Get-LocalUser -Name "SerenE2E*" -ErrorAction SilentlyContinue)) {
      Write-Stage "Reaping stale e2e user $($staleUser.Name)"
      Remove-LocalE2EUser $staleUser.Name
    }
    Get-ChildItem -LiteralPath "C:\Users" -Directory -Filter "SerenE2E*" -ErrorAction SilentlyContinue |
      ForEach-Object {
        $orphanPath = $_.FullName
        Invoke-CleanupWithTimeout `
          -Label "Remove orphaned e2e profile directory $orphanPath" `
          -ScriptBlock {
            param($Path)
            Get-CimInstance Win32_UserProfile -ErrorAction SilentlyContinue |
              Where-Object { $_.LocalPath -eq $Path } |
              Remove-CimInstance -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $Path) {
              Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
            }
          } `
          -ArgumentList @($orphanPath) `
          -TimeoutSeconds 30
      }
  } catch {
    Write-Host "::warning::Stale e2e user reap failed: $($_.Exception.Message)"
  }
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedWorkDir = (Resolve-Path -LiteralPath $WorkDir).Path
$runnerPath = Join-Path $resolvedWorkDir "scripts\windows-e2e-app.ps1"
if (-not (Test-Path -LiteralPath $runnerPath)) {
  Fail "Windows app harness missing from e2e payload: $runnerPath"
}

$taskName = "SerenDesktopE2E-$([Guid]::NewGuid().ToString("N").Substring(0, 8))"
$userName = "SerenE2E$([Guid]::NewGuid().ToString("N").Substring(0, 6))"
$qualifiedUserName = "$env:COMPUTERNAME\$userName"
$password = New-TemporaryPassword
$taskScriptPath = Join-Path $resolvedWorkDir "windows-e2e-task.ps1"
$taskLogPath = Join-Path $resolvedWorkDir "windows-e2e-task.log"
$e2eInstallDir = Join-Path $env:SystemDrive "SerenDesktopE2E"

try {
  Remove-StaleE2EUsers
  Write-Stage "Creating temporary Windows user $qualifiedUserName"
  Remove-LocalE2EUser $userName
  & net user $userName $password /add /Y | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "Failed to create temporary Windows e2e user $qualifiedUserName"
  }
  & net localgroup Administrators $userName /add | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "Failed to grant Administrators membership to $qualifiedUserName"
  }

  Write-Stage "Granting temporary user access to $resolvedWorkDir"
  $grant = "$($env:COMPUTERNAME)\$($userName):(OI)(CI)M"
  & icacls $resolvedWorkDir /grant $grant /T | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "Failed to grant $qualifiedUserName access to $resolvedWorkDir"
  }

  $psWorkDir = Convert-ToSingleQuotedPowerShellString $resolvedWorkDir
  $psInstaller = Convert-ToSingleQuotedPowerShellString $resolvedInstaller
  $psSecretPrefix = Convert-ToSingleQuotedPowerShellString $SecretParameterPrefix.TrimEnd("/")
  $psTaskLog = Convert-ToSingleQuotedPowerShellString $taskLogPath
  $psAllowUnsignedPrArtifact = if ($AllowUnsignedPrArtifact) { "`$true" } else { "`$false" }
  $psAllowUnsignedBudgetBlockedArtifact = if ($AllowUnsignedBudgetBlockedArtifact) { "`$true" } else { "`$false" }
  $psAllowMissingAgentCredentials = if ($AllowMissingAgentCredentials) { "`$true" } else { "`$false" }
  $taskScript = @"
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
`$ProgressPreference = "SilentlyContinue"
`$work = $psWorkDir
`$installerPath = $psInstaller
`$secretPrefix = $psSecretPrefix
`$taskLog = $psTaskLog
`$remoteDebugPort = $RemoteDebugPort
`$startupTimeoutSeconds = $StartupTimeoutSeconds
`$probeTimeoutSeconds = $ProbeTimeoutSeconds
`$allowUnsignedPrArtifact = $psAllowUnsignedPrArtifact
`$allowUnsignedBudgetBlockedArtifact = $psAllowUnsignedBudgetBlockedArtifact
`$allowMissingAgentCredentials = $psAllowMissingAgentCredentials
`$installDir = Join-Path `$env:SystemDrive "SerenDesktopE2E"
`$installerTimeoutSeconds = $InstallerTimeoutSeconds
`$awsCliTimeoutArgs = @("--cli-connect-timeout", "10", "--cli-read-timeout", "30")

function Write-TaskLog([string]`$Message) {
  `$timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Add-Content -LiteralPath `$taskLog -Value "[windows-e2e:task] `$timestamp `$Message"
}

function Invoke-LoggedNative([string]`$Label, [string]`$FilePath, [string[]]`$ArgumentList, [int]`$TimeoutSeconds = 600) {
  Write-TaskLog "Starting `$Label"
  `$job = `$null
  try {
    `$workingDirectory = (Get-Location).Path
    `$job = Start-Job -ScriptBlock {
      param([string]`$Command, [string[]]`$CommandArgs, [string]`$WorkingDirectory)
      try {
        Set-Location `$WorkingDirectory
        `$output = & `$Command @CommandArgs 2>&1
        `$exitCode = if (`$null -eq `$LASTEXITCODE) { 0 } else { [int]`$LASTEXITCODE }
      } catch {
        `$output = @(`$_.Exception.Message)
        `$exitCode = 1
      }
      foreach (`$line in `$output) {
        [pscustomobject]@{ Kind = "output"; Value = [string]`$line }
      }
      [pscustomobject]@{ Kind = "exit"; Value = [string]`$exitCode }
    } -ArgumentList `$FilePath, `$ArgumentList, `$workingDirectory

    `$completed = Wait-Job -Job `$job -Timeout `$TimeoutSeconds
    if (-not `$completed) {
      Receive-Job -Job `$job -Keep -ErrorAction SilentlyContinue | Where-Object { `$_.Kind -eq "output" } | ForEach-Object {
        Add-Content -LiteralPath `$taskLog -Value ([string]`$_.Value)
      }
      Stop-Job -Job `$job -ErrorAction SilentlyContinue
      throw "`$Label timed out after `$TimeoutSeconds seconds"
    }
    `$records = @(Receive-Job -Job `$job -ErrorAction SilentlyContinue)
    `$records | Where-Object { `$_.Kind -eq "output" } | ForEach-Object {
      Add-Content -LiteralPath `$taskLog -Value ([string]`$_.Value)
    }
    `$exitRecord = `$records | Where-Object { `$_.Kind -eq "exit" } | Select-Object -Last 1
    `$exitCode = if (`$exitRecord) { [int]`$exitRecord.Value } else { 1 }
    if (`$exitCode -ne 0) {
      throw "`$Label failed with exit code `$exitCode"
    }
  } finally {
    if (`$job) {
      Remove-Job -Job `$job -Force -ErrorAction SilentlyContinue
    }
  }
  Write-TaskLog "`$Label completed"
}

function Get-EnvValue([string]`$Name) {
  return [Environment]::GetEnvironmentVariable(`$Name, "Process")
}

function Convert-EnvFlag([string]`$Value, [bool]`$Default) {
  if ([string]::IsNullOrWhiteSpace(`$Value)) {
    return `$Default
  }
  return @("1", "true", "yes", "on") -contains `$Value.Trim().ToLowerInvariant()
}

function Test-AnyCredentialPath([string[]]`$Paths) {
  foreach (`$candidate in `$Paths) {
    if (-not [string]::IsNullOrWhiteSpace(`$candidate) -and (Test-Path -LiteralPath `$candidate -PathType Leaf)) {
      return `$true
    }
  }
  return `$false
}

function Get-ConfiguredAgentJourneys() {
  `$configured = Get-EnvValue "SEREN_E2E_AGENT_JOURNEYS"
  if ([string]::IsNullOrWhiteSpace(`$configured)) {
    return @("codex", "claude-code", "claude-codex")
  }
  return @(
    `$configured.Split(",") |
      ForEach-Object { `$_.Trim().ToLowerInvariant() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace(`$_) } |
      Select-Object -Unique
  )
}

function Get-MissingAgentCredentialNames() {
  `$journeys = @(Get-ConfiguredAgentJourneys)
  `$requiresClaude = `$journeys -contains "claude-code" -or `$journeys -contains "claude-codex"
  `$requiresCodex = `$journeys -contains "codex" -or `$journeys -contains "claude-codex"
  `$home = [Environment]::GetEnvironmentVariable("USERPROFILE")
  `$appData = [Environment]::GetEnvironmentVariable("APPDATA")
  `$missing = @()

  if (`$requiresClaude) {
    `$claudePaths = @(
      (Join-Path `$home ".claude\.credentials.json"),
      (Join-Path `$home ".claude.json")
    )
    if (-not [string]::IsNullOrWhiteSpace(`$appData)) {
      `$claudePaths += @(
        (Join-Path `$appData "Claude\.credentials.json"),
        (Join-Path `$appData "Claude\credentials.json")
      )
    }
    if (-not (Test-AnyCredentialPath `$claudePaths)) {
      `$missing += "Claude Code (.claude/.credentials.json or equivalent)"
    }
  }

  if (`$requiresCodex) {
    `$codexHasEnvKey = -not [string]::IsNullOrWhiteSpace((Get-EnvValue "OPENAI_API_KEY"))
    `$codexPaths = @(
      (Join-Path `$home ".codex\auth.json"),
      (Join-Path `$home ".codex\credentials.json")
    )
    if (-not [string]::IsNullOrWhiteSpace(`$appData)) {
      `$codexPaths += @(
        (Join-Path `$appData "Codex\auth.json"),
        (Join-Path `$appData "OpenAI\Codex\auth.json")
      )
    }
    if (-not `$codexHasEnvKey -and -not (Test-AnyCredentialPath `$codexPaths)) {
      `$missing += "Codex (.codex/auth.json or equivalent)"
    }
  }

  return `$missing
}

function Assert-AgentCredentialsPresent() {
  `$credentialsRequired = Convert-EnvFlag (Get-EnvValue "SEREN_E2E_AGENT_CREDENTIALS_REQUIRED") `$true
  if (-not `$credentialsRequired) {
    Write-TaskLog "Skipping agent credential validation because SEREN_E2E_AGENT_CREDENTIALS_REQUIRED is false"
    return
  }
  `$missing = @(Get-MissingAgentCredentialNames)
  if (`$missing.Count -gt 0) {
    throw "Windows e2e agent credential archive did not provision required CLI credential file(s): `$(`$missing -join ', '). Store a profile-root zip at `$secretPrefix/SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI or `$secretPrefix/SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64. The archive should expand directly into USERPROFILE without an extra top-level folder."
  }
  Write-TaskLog "Validated agent CLI credentials for configured journey(s)"
}

function Import-AgentCredentialArchive() {
  `$archiveS3Uri = Get-EnvValue "SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI"
  `$archiveB64 = Get-EnvValue "SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64"
  `$credentialsRequired = Convert-EnvFlag (Get-EnvValue "SEREN_E2E_AGENT_CREDENTIALS_REQUIRED") `$true

  if ([string]::IsNullOrWhiteSpace(`$archiveS3Uri) -and [string]::IsNullOrWhiteSpace(`$archiveB64)) {
    if (`$credentialsRequired) {
      throw "Missing Windows e2e agent credential archive. Store a profile-root zip at `$secretPrefix/SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI or `$secretPrefix/SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64 before running agent journeys."
    }
    Write-TaskLog "Agent credential archive not configured; continuing because SEREN_E2E_AGENT_CREDENTIALS_REQUIRED is false"
    return
  }

  `$archivePath = Join-Path `$env:TEMP "seren-agent-credentials.zip"
  Remove-Item -LiteralPath `$archivePath -Force -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace(`$archiveS3Uri)) {
    Invoke-LoggedNative "Agent credential archive download" "aws" (@("s3", "cp", `$archiveS3Uri, `$archivePath, "--only-show-errors") + `$awsCliTimeoutArgs) 300
  } else {
    Write-TaskLog "Decoding agent credential archive from SSM"
    [System.IO.File]::WriteAllBytes(`$archivePath, [Convert]::FromBase64String(`$archiveB64))
  }

  Write-TaskLog "Expanding agent credential archive into temporary user profile"
  Expand-Archive -LiteralPath `$archivePath -DestinationPath `$env:USERPROFILE -Force
  Remove-Item -LiteralPath `$archivePath -Force -ErrorAction SilentlyContinue
  Write-TaskLog "Imported agent credential archive into temporary user profile"
  Assert-AgentCredentialsPresent
}

try {
  Set-Content -LiteralPath `$taskLog -Value "[windows-e2e:task] `$((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")) task-user=`$(whoami)"
  [Environment]::SetEnvironmentVariable("AWS_METADATA_SERVICE_TIMEOUT", "2", "Process")
  [Environment]::SetEnvironmentVariable("AWS_METADATA_SERVICE_NUM_ATTEMPTS", "2", "Process")
  Write-TaskLog "Hydrating e2e secrets from SSM Parameter Store"
  `$secretNames = @(
    "SEREN_E2E_EMAIL",
    "SEREN_E2E_PASSWORD",
    "SEREN_E2E_HISTORY_PROJECT_ID",
    "SEREN_E2E_HISTORY_BRANCH_ID",
    "SEREN_E2E_HISTORY_DATABASE_NAME",
    "SEREN_E2E_GITHUB_PAT",
    "SEREN_E2E_AGENT_TYPE",
    "SEREN_E2E_AGENT_CWD",
    "SEREN_E2E_AGENT_JOURNEYS",
    "SEREN_E2E_AGENT_PROMPT",
    "SEREN_E2E_AGENT_CREDENTIALS_REQUIRED",
    "SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI",
    "SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64",
    "SEREN_E2E_AGENT_MODEL",
    "SEREN_E2E_AGENT_USE_BEDROCK",
    "SEREN_E2E_AGENT_BEDROCK_REGION",
    "SEREN_E2E_AGENT_SMALL_FAST_MODEL"
  )
  foreach (`$name in `$secretNames) {
    `$parameterName = "`$secretPrefix/`$name"
    `$value = & { `$ErrorActionPreference = "Continue"; aws ssm get-parameter --with-decryption --name `$parameterName --query "Parameter.Value" --output text @awsCliTimeoutArgs 2>`$null }
    if (`$LASTEXITCODE -eq 0 -and `$value -and `$value -ne "None") {
      [Environment]::SetEnvironmentVariable(`$name, `$value, "Process")
    }
  }
  [Environment]::SetEnvironmentVariable("SEREN_E2E_API_BASE", "https://api.serendb.com", "Process")
  if (`$allowUnsignedBudgetBlockedArtifact) {
    [Environment]::SetEnvironmentVariable("SEREN_E2E_RELEASE_RUN", "1", "Process")
    [Environment]::SetEnvironmentVariable("SEREN_E2E_WINDOWS_SIGNING_BLOCKED", "1", "Process")
  } elseif (`$allowUnsignedPrArtifact) {
    [Environment]::SetEnvironmentVariable("SEREN_E2E_UNSIGNED_PR_RUN", "1", "Process")
  } else {
    [Environment]::SetEnvironmentVariable("SEREN_E2E_RELEASE_RUN", "1", "Process")
  }
  if (`$allowMissingAgentCredentials) {
    [Environment]::SetEnvironmentVariable("SEREN_E2E_AGENT_CREDENTIALS_REQUIRED", "0", "Process")
  }
  # Bedrock-backed agent journeys (claude-code): authenticate via the EC2
  # instance role instead of a stored login file. The runtime always forwards
  # --model, so the spawned model id (SEREN_E2E_AGENT_MODEL, read by the probe)
  # must be a Bedrock inference-profile id; ANTHROPIC_SMALL_FAST_MODEL covers the
  # CLI's background small-model calls, which --model does not override.
  if (Convert-EnvFlag (Get-EnvValue "SEREN_E2E_AGENT_USE_BEDROCK") `$true) {
    `$bedrockRegion = Get-EnvValue "SEREN_E2E_AGENT_BEDROCK_REGION"
    if ([string]::IsNullOrWhiteSpace(`$bedrockRegion)) { `$bedrockRegion = "us-east-1" }
    # Only the global Opus 4.6 inference profile carries Bedrock quota in this
    # account (4.32B tokens/day); the us.* profiles and every Haiku/Sonnet
    # profile are provisioned at 0 and throttle on the first call. Use the
    # global profile for both the main and small-fast model - the e2e is one
    # short prompt, so the small-fast model just needs a quota-bearing id.
    `$bedrockModel = Get-EnvValue "SEREN_E2E_AGENT_MODEL"
    if ([string]::IsNullOrWhiteSpace(`$bedrockModel)) { `$bedrockModel = "global.anthropic.claude-opus-4-6-v1" }
    `$bedrockSmallModel = Get-EnvValue "SEREN_E2E_AGENT_SMALL_FAST_MODEL"
    if ([string]::IsNullOrWhiteSpace(`$bedrockSmallModel)) { `$bedrockSmallModel = "global.anthropic.claude-opus-4-6-v1" }
    [Environment]::SetEnvironmentVariable("CLAUDE_CODE_USE_BEDROCK", "1", "Process")
    [Environment]::SetEnvironmentVariable("AWS_REGION", `$bedrockRegion, "Process")
    [Environment]::SetEnvironmentVariable("ANTHROPIC_MODEL", `$bedrockModel, "Process")
    [Environment]::SetEnvironmentVariable("ANTHROPIC_SMALL_FAST_MODEL", `$bedrockSmallModel, "Process")
    [Environment]::SetEnvironmentVariable("SEREN_E2E_AGENT_MODEL", `$bedrockModel, "Process")
    # Bedrock uses the AWS credential chain; no Claude login file is required.
    [Environment]::SetEnvironmentVariable("SEREN_E2E_AGENT_CREDENTIALS_REQUIRED", "0", "Process")
    # A brand-new profile's first claude-code run on the e2e host fetches the
    # autoupdater/telemetry/feature-gate catalog over the network at startup;
    # any of those stalling can wedge the stream-json initialize handshake on a
    # cold box. Disable that non-essential startup traffic so the handshake only
    # depends on the local catalog. The runtime still kills+respawns a wedged
    # process as a backstop. #2452
    [Environment]::SetEnvironmentVariable("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1", "Process")
    Write-TaskLog "Configured Bedrock agent backend: region=`$bedrockRegion model=`$bedrockModel small=`$bedrockSmallModel"
  }
  Import-AgentCredentialArchive

  Set-Location `$work
  Write-TaskLog "Using install directory `$installDir"
  Invoke-LoggedNative "Corepack enable" "corepack" @("enable") 120
  Invoke-LoggedNative "Corepack prepare pnpm" "corepack" @("prepare", "pnpm@9", "--activate") 180
  Invoke-LoggedNative "pnpm install" "pnpm" @("install", "--frozen-lockfile") 1200
  # #3096 intentionally removed provider-startup installation. The release
  # user is disposable and starts empty, so provision its real CLI prerequisites
  # explicitly as test setup using the vendors' documented npm packages. This
  # must remain outside provider_ensure_agent_cli: production startup should
  # continue to hand a missing CLI to the user for review/manual installation.
  `$agentCliPackages = @(
    @{ Label = "Claude Code"; Package = "@anthropic-ai/claude-code@latest"; Binary = "claude.cmd" },
    @{ Label = "Codex"; Package = "@openai/codex@latest"; Binary = "codex.cmd" },
    @{ Label = "Gemini"; Package = "@google/gemini-cli@latest"; Binary = "gemini.cmd" },
    @{ Label = "Grok"; Package = "@xai-official/grok@latest"; Binary = "grok.cmd" }
  )
  `$agentCliInstallArgs = @("install", "--global", "--no-audit", "--no-fund") + @(
    `$agentCliPackages | ForEach-Object { `$_.Package }
  )
  Invoke-LoggedNative "Install e2e agent CLIs" "npm" `$agentCliInstallArgs 1200
  `$npmGlobalPrefix = [string](& npm prefix --global | Select-Object -Last 1)
  `$npmGlobalPrefix = `$npmGlobalPrefix.Trim()
  if ([string]::IsNullOrWhiteSpace(`$npmGlobalPrefix)) {
    throw "npm did not report a global prefix after installing the e2e agent CLIs"
  }
  foreach (`$agentCli in `$agentCliPackages) {
    `$cliPath = Join-Path `$npmGlobalPrefix `$agentCli.Binary
    if (-not (Test-Path -LiteralPath `$cliPath)) {
      throw "Required `$(`$agentCli.Label) e2e agent CLI was not installed at the npm global prefix"
    }
    Invoke-LoggedNative "Verify `$(`$agentCli.Label) CLI" `$cliPath @("--version") 120
  }
  Invoke-LoggedNative "Playwright Chromium install" "pnpm" @("exec", "playwright", "install", "chromium") 600
  `$harnessArgs = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ".\scripts\windows-e2e-app.ps1",
    "-InstallerPath",
    `$installerPath,
    "-InstallDir",
    `$installDir,
    "-InstallerTimeoutSeconds",
    [string]`$installerTimeoutSeconds,
    "-RemoteDebugPort",
    [string]`$remoteDebugPort,
    "-StartupTimeoutSeconds",
    [string]`$startupTimeoutSeconds,
    "-ProbeTimeoutSeconds",
    [string]`$probeTimeoutSeconds
  )
  if (`$allowUnsignedPrArtifact) {
    `$harnessArgs += "-AllowUnsignedPrArtifact"
  }
  if (`$allowUnsignedBudgetBlockedArtifact) {
    `$harnessArgs += "-AllowUnsignedBudgetBlockedArtifact"
  }
  `$harnessTimeoutSeconds = [Math]::Max(600, `$installerTimeoutSeconds + `$probeTimeoutSeconds + 300)
  Invoke-LoggedNative "Windows app harness" "powershell" `$harnessArgs `$harnessTimeoutSeconds
  Write-TaskLog "Windows app scheduled-task harness completed"
} catch {
  Write-TaskLog "::error::`$(`$_.Exception.Message)"
  exit 1
}
"@
  Set-Content -LiteralPath $taskScriptPath -Value $taskScript -Encoding UTF8

  Write-Stage "Registering scheduled task $taskName"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$taskScriptPath`""
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Seconds $TaskTimeoutSeconds) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Settings $settings `
    -User $qualifiedUserName `
    -Password $password `
    -RunLevel Highest `
    -Force |
    Out-Null

  Write-Stage "Starting scheduled task $taskName"
  Start-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds($TaskTimeoutSeconds + 60)
  $lastStatus = ""
  # LastTaskResult of a task that has not yet produced a run result. Once the
  # action runs to completion this becomes the action's exit code, so it is the
  # reliable "the task finished" signal. LastRunTime is not: it lags and can sit
  # at its own sentinel after a fast run, which previously let the loop spin to
  # the full deadline on a task that had already failed in seconds.
  $taskNeverRanResult = 267011  # SCHED_S_TASK_HAS_NOT_RUN (0x00041303)
  $observedRunning = $false
  do {
    Start-Sleep -Seconds 5
    $task = Get-ScheduledTask -TaskName $taskName
    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
    if ($task.State -eq "Running") {
      $observedRunning = $true
    }
    $status = "state=$($task.State) lastResult=$($taskInfo.LastTaskResult)"
    if ($status -ne $lastStatus) {
      Write-Stage "Scheduled task $status"
      $lastStatus = $status
    }
    # Done once the task is no longer Running and we have evidence it actually
    # ran — either we caught it in the Running state, or it has recorded a run
    # result other than the never-ran sentinel.
    $taskFinished = $task.State -ne "Running" -and
      ($observedRunning -or $taskInfo.LastTaskResult -ne $taskNeverRanResult)
    if ($taskFinished) {
      break
    }
  } while ((Get-Date) -lt $deadline)

  $task = Get-ScheduledTask -TaskName $taskName
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
  if ($task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Fail "Windows app scheduled-task harness timed out after ${TaskTimeoutSeconds}s"
  }

  Write-Stage "Scheduled task log follows"
  if (Test-Path -LiteralPath $taskLogPath) {
    Get-Content -LiteralPath $taskLogPath -Tail 800 | Write-Host
  } else {
    Write-Host "::warning::Scheduled task log was not created: $taskLogPath"
  }

  if ($taskInfo.LastTaskResult -ne 0) {
    Fail "Windows app scheduled-task harness failed with result $($taskInfo.LastTaskResult)"
  }
  Write-Stage "Windows app scheduled-task harness passed"
} finally {
  Write-Stage "Cleaning up scheduled task, temporary user, and app processes"
  try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  } catch {
  }
  try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch {
  }
  Stop-E2EProcessTree -InstallDir $e2eInstallDir
  Remove-Item -LiteralPath $taskScriptPath -Force -ErrorAction SilentlyContinue
  Remove-LocalE2EUser $userName
}
