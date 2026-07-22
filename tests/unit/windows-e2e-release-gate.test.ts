// ABOUTME: Guardrail for the Windows release gate added for #2265.
// ABOUTME: Prevents the release workflow from drifting back to build-only certification.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const manualPublishWorkflowPath = join(
  root,
  ".github/workflows/publish-release-manual.yml",
);
const esignerPreflightWorkflowPath = join(
  root,
  ".github/workflows/esigner-cka-preflight.yml",
);
const releaseWorkflow = readFileSync(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);
const manualPublishWorkflow = existsSync(manualPublishWorkflowPath)
  ? readFileSync(manualPublishWorkflowPath, "utf8")
  : "";
const esignerPreflightWorkflow = existsSync(esignerPreflightWorkflowPath)
  ? readFileSync(esignerPreflightWorkflowPath, "utf8")
  : "";
const runner = readFileSync(join(root, "scripts/windows-e2e-app.ps1"), "utf8");
const taskUserRunner = readFileSync(
  join(root, "scripts/windows-e2e-task-user.ps1"),
  "utf8",
);
const probe = readFileSync(join(root, "scripts/windows-e2e-app.mjs"), "utf8");
const agentRegistry = readFileSync(
  join(root, "bin/browser-local/agent-registry.mjs"),
  "utf8",
);

function workflowJob(name: string): string {
  const start = releaseWorkflow.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = releaseWorkflow
    .slice(start + 1)
    .search(/\n  [a-zA-Z0-9_-]+:\n/);
  return next === -1
    ? releaseWorkflow.slice(start)
    : releaseWorkflow.slice(start, start + 1 + next);
}

describe("Windows production e2e release gate", () => {
  it("blocks release publishing on the AWS Windows e2e job", () => {
    expect(releaseWorkflow).toContain("windows-app-e2e:");
    expect(releaseWorkflow).toContain("needs: build");
    expect(releaseWorkflow).toContain("aws ssm send-command");
    expect(releaseWorkflow).toContain("aws ssm get-command-invocation");
    expect(releaseWorkflow).toContain("WINDOWS_E2E_INSTANCE_ID");
    expect(releaseWorkflow).toContain("WINDOWS_E2E_S3_BUCKET");
    expect(releaseWorkflow).toMatch(
      /publish-release:\s*\n\s*needs:\s*\[create-release, build, windows-app-e2e\]/,
    );
    expect(workflowJob("windows-app-e2e")).not.toContain(
      "continue-on-error: true",
    );
  });

  it("preflights box prerequisites before the SSM command and bounds the run above the on-box budget (#2432)", () => {
    const job = workflowJob("windows-app-e2e");
    // The fast preflight must exist and run before the SSM command is sent, so a
    // missing parameter fails in seconds rather than after the full SSM budget.
    expect(job).toContain("Preflight Windows e2e box prerequisites");
    const preflightAt = job.indexOf("Preflight Windows e2e box prerequisites");
    const sendAt = job.indexOf("aws ssm send-command");
    expect(preflightAt).toBeGreaterThanOrEqual(0);
    expect(sendAt).toBeGreaterThanOrEqual(0);
    expect(preflightAt).toBeLessThan(sendAt);
    // The SSM doc and the runner poll deadline must both exceed the on-box wait
    // budget (TaskTimeoutSeconds + 60 = 4860s) plus wrapper overhead, so a valid
    // slow run is not killed by the harness before it finishes.
    expect(job).toContain('executionTimeout: ["6000"]');
    expect(job).toContain("SECONDS + 6300");
    expect(job).not.toContain("deadline=$((SECONDS + 3600))");
  });

  it("requires real production credentials and self-provisions a history-sync tenant (#2549)", () => {
    for (const required of [
      "SEREN_E2E_EMAIL",
      "SEREN_E2E_PASSWORD",
      "SEREN_E2E_GITHUB_PAT",
    ]) {
      expect(runner).toContain(required);
      expect(probe).toContain(required);
    }
    for (const optionalHistoryOverride of [
      "SEREN_E2E_HISTORY_PROJECT_ID",
      "SEREN_E2E_HISTORY_BRANCH_ID",
      "SEREN_E2E_HISTORY_DATABASE_NAME",
    ]) {
      expect(runner).not.toContain(`"${optionalHistoryOverride}"`);
      expect(probe).toContain(optionalHistoryOverride);
    }
    expect(probe).toContain("SEREN_E2E_HISTORY_PROJECT_NAME");
    expect(probe).toContain("windows-e2e-history");
    expect(probe).toContain("resolveHistoryDestination");
    expect(probe).toContain("connection-string?pooled=true");
    expect(probe).toContain("explicit history destination returned HTTP 404");
    expect(runner).toContain("https://api.serendb.com");
    expect(probe).toContain("https://api.serendb.com");
  });

  it("submits Windows sign-in without relying on WebView2 pointer click completion (#2553)", () => {
    expect(probe).toContain("submitSignInForm");
    expect(probe).toContain("enabled sign-in submit button");
    expect(probe).toContain("form.requestSubmit(button)");
    expect(probe).not.toContain(
      'form.getByRole("button", { name: /^Sign In$/ }).click();',
    );
  });

  it("uses spoken system audio for the Windows Meeting capture stimulus (#2555)", () => {
    expect(probe).toContain("powerShellSingleQuoted");
    expect(probe).toContain("SAPI.SpVoice");
    expect(probe).toContain("$voice.Speak");
    expect(probe).toContain("spoken system audio");
    expect(probe).toContain("$playedSpeech");
    expect(probe).toContain("[Console]::Beep");

    const stimulusStart = probe.indexOf("function playWindowsAudio");
    const captureStart = probe.indexOf("async function exerciseMeetingCapture");
    expect(stimulusStart).toBeGreaterThanOrEqual(0);
    expect(captureStart).toBeGreaterThan(stimulusStart);
    const stimulus = probe.slice(stimulusStart, captureStart);
    expect(stimulus.indexOf("SAPI.SpVoice")).toBeLessThan(
      stimulus.indexOf("[Console]::Beep"),
    );
  });

  it("enables deterministic Meeting capture injection only for Windows e2e (#2557)", () => {
    expect(runner).toContain("SEREN_E2E_CAPTURE_INJECTION");
    expect(probe).toContain("e2e_inject_meeting_capture_audio");
    expect(probe).toContain("injectMeetingCaptureAudio");

    const captureStart = probe.indexOf('tauriInvoke(page, "start_meeting_capture"');
    const injectAt = probe.indexOf("injectMeetingCaptureAudio(page, meeting.id)");
    const stopAt = probe.indexOf('tauriInvoke(page, "stop_meeting_capture"');
    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(injectAt).toBeGreaterThan(captureStart);
    expect(stopAt).toBeGreaterThan(injectAt);
  });

  it("does not fail a successful Windows probe solely because PowerShell reported a blank exit code (#2559)", () => {
    expect(runner).toContain("$process.Refresh()");
    expect(runner).toContain(
      'Select-String -LiteralPath $probeStdoutPath -SimpleMatch "[windows-e2e] full Windows production e2e passed" -Quiet',
    );
    expect(runner).toContain(
      "Windows app e2e probe exit code was blank but success sentinel was observed",
    );

    const fallbackAt = runner.indexOf("$null -eq $probeExitCode");
    const failureAt = runner.indexOf("Windows app e2e script failed with exit code");
    expect(fallbackAt).toBeGreaterThanOrEqual(0);
    expect(failureAt).toBeGreaterThan(fallbackAt);
  });

  it("ignores only transient provider runtime startup WebSocket console noise after successful auth (#2561)", () => {
    expect(probe).toContain("isTransientProviderRuntimeStartupError");
    expect(probe).toContain("assertNoUnexpectedBrowserErrors");
    expect(probe).toContain("net::ERR_CONNECTION_REFUSED");
    expect(probe).toContain(
      "transient provider runtime startup WebSocket error(s) after runtime auth succeeded",
    );
    expect(probe).toContain("unexpectedErrors.length === 0");
    expect(probe).not.toContain("browserErrors.length === 0");

    const mainAt = probe.indexOf("async function main()");
    const agentRuntimeAt = probe.indexOf("await exerciseAgentRuntime(page);", mainAt);
    const meetingCaptureAt = probe.indexOf("await exerciseMeetingCapture(page);", mainAt);
    const auditAt = probe.indexOf(
      "assertNoUnexpectedBrowserErrors(browserErrors);",
      mainAt,
    );
    expect(mainAt).toBeGreaterThanOrEqual(0);
    expect(agentRuntimeAt).toBeGreaterThan(mainAt);
    expect(meetingCaptureAt).toBeGreaterThan(agentRuntimeAt);
    expect(auditAt).toBeGreaterThan(meetingCaptureAt);
  });

  it("fails eSigner CKA login/load commands at their native failure point (#2483)", () => {
    const buildJob = workflowJob("build");
    expect(buildJob).toContain("function Invoke-EsignerCka");
    expect(buildJob).toContain("eSignerCKATool.exe not found");
    expect(buildJob).toContain("eSigner CKA config/login failed");
    expect(buildJob).toContain(
      "Validate or rotate ES_USERNAME, ES_PASSWORD, and ES_TOTP_SECRET",
    );
    expect(buildJob).toContain('Invoke-EsignerCka "config/login"');
    expect(buildJob).toContain('Invoke-EsignerCka "unload"');
    expect(buildJob).toContain('Invoke-EsignerCka "load"');

    const configAt = buildJob.indexOf('Invoke-EsignerCka "config/login"');
    const unloadAt = buildJob.indexOf('Invoke-EsignerCka "unload"');
    const loadAt = buildJob.indexOf('Invoke-EsignerCka "load"');
    const certCheckAt = buildJob.indexOf("eSigner CKA did not load");
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(unloadAt).toBeGreaterThan(configAt);
    expect(loadAt).toBeGreaterThan(unloadAt);
    expect(certCheckAt).toBeGreaterThan(loadAt);
  });

  it("keeps the eSigner CKA auth preflight manual and side-effect free (#2485)", () => {
    expect(existsSync(esignerPreflightWorkflowPath)).toBe(true);
    expect(esignerPreflightWorkflow).toContain("workflow_dispatch:");
    expect(esignerPreflightWorkflow).toContain("runs-on: windows-latest");
    expect(esignerPreflightWorkflow).toContain("ES_USERNAME");
    expect(esignerPreflightWorkflow).toContain("ES_PASSWORD");
    expect(esignerPreflightWorkflow).toContain("ES_TOTP_SECRET");
    expect(esignerPreflightWorkflow).toContain("eSignerCKATool.exe");
    expect(esignerPreflightWorkflow).toContain('Invoke-EsignerCka "config/login"');
    expect(esignerPreflightWorkflow).toContain('Invoke-EsignerCka "unload"');
    expect(esignerPreflightWorkflow).toContain('Invoke-EsignerCka "load"');
    expect(esignerPreflightWorkflow).toContain("Cert:\\CurrentUser\\My");
    expect(esignerPreflightWorkflow).toContain("code-signing certificate");
    expect(esignerPreflightWorkflow).not.toContain("actions/checkout");
    expect(esignerPreflightWorkflow).not.toContain("softprops/action-gh-release");
    expect(esignerPreflightWorkflow).not.toContain("aws s3 cp");
    expect(esignerPreflightWorkflow).not.toContain("R2_BUCKET");
    expect(esignerPreflightWorkflow).not.toContain("latest.json");
    expect(esignerPreflightWorkflow).not.toContain("tauri build");
  });

  it("installs and probes the signed Windows app instead of running a browser mock", () => {
    expect(runner).toContain("Get-AuthenticodeSignature");
    expect(runner).toContain("/S");
    expect(runner).toContain("Unblock-File");
    expect(runner).toContain("InstallerTimeoutSeconds");
    expect(runner).toContain("ProbeTimeoutSeconds");
    expect(runner).toContain("Get-DefaultInstallDir");
    expect(runner).toContain("systemprofile");
    expect(runner).toContain("SerenDesktopE2E");
    expect(runner).toContain("WaitForExit");
    expect(runner).toContain("Write-Stage");
    expect(runner).toContain("Windows app e2e probe");
    expect(runner).toContain("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    expect(runner).toContain("Write-WindowsLaunchDiagnostics");
    expect(runner).toContain("Write-ProbeTimeoutDiagnostics");
    expect(runner).toContain("Collecting probe timeout diagnostics");
    expect(runner).toContain("OnTimeout");
    expect(runner).toContain("msedgewebview2.exe");
    expect(runner).toContain("query session");
    expect(runner).toContain("quser");
    expect(runner).toContain("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    expect(runner).toContain("WebView2 runtime detected");
    expect(runner).toContain("node.exe");
    expect(runner).toContain("npm.cmd");
    expect(runner).toContain("windows-e2e-app.mjs");
    expect(probe).toContain("connectOverCDP");
    expect(probe).toContain("webSocketDebuggerUrl");
    expect(probe).toContain("120_000");
    expect(probe).toContain("__TAURI_INTERNALS__");
  });

  it("runs the Windows app harness as a temporary scheduled-task user", () => {
    expect(releaseWorkflow).toContain("scripts/windows-e2e-task-user.ps1");
    expect(releaseWorkflow).toContain(
      "[windows-e2e:ssm] Running Windows app harness as scheduled task user",
    );
    expect(taskUserRunner).toContain("Register-ScheduledTask");
    expect(taskUserRunner).toContain("Start-ScheduledTask");
    expect(taskUserRunner).toContain("Get-ScheduledTaskInfo");
    expect(taskUserRunner).toContain("Unregister-ScheduledTask");
    expect(taskUserRunner).toContain("net user");
    expect(taskUserRunner).toContain("Administrators");
    expect(taskUserRunner).toContain("SEREN_E2E_RELEASE_RUN");
    expect(taskUserRunner).toContain("AllowUnsignedPrArtifact");
    expect(taskUserRunner).toContain("AllowMissingAgentCredentials");
    expect(taskUserRunner).toContain("SEREN_E2E_UNSIGNED_PR_RUN");
    expect(taskUserRunner).toContain("SerenDesktopE2E");
    expect(taskUserRunner).toContain("-InstallDir");
    expect(runner).toContain("InstallerTimeoutSeconds = 1200");
    expect(taskUserRunner).toContain("InstallerTimeoutSeconds = 1200");
    expect(taskUserRunner).toContain("TaskTimeoutSeconds = 4800");
    expect(releaseWorkflow).toContain("-TaskTimeoutSeconds 4800");
    expect(taskUserRunner).toContain("windows-e2e-app.ps1");
    expect(taskUserRunner).toContain("Windows app scheduled-task harness failed");
    expect(taskUserRunner).toContain("Stop-E2EProcessTree");
    expect(taskUserRunner).toContain("node.exe");
    expect(taskUserRunner).toContain("Invoke-CleanupWithTimeout");
    expect(taskUserRunner).toContain("Start-Job");
    expect(taskUserRunner).toContain("SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI");
    expect(taskUserRunner).toContain("SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_B64");
    expect(taskUserRunner).toContain("SEREN_E2E_AGENT_CREDENTIALS_REQUIRED");
    expect(taskUserRunner).toContain("Assert-AgentCredentialsPresent");
    expect(taskUserRunner).toContain("did not provision required CLI credential file");
    expect(taskUserRunner).toContain("without an extra top-level folder");
    expect(taskUserRunner).toContain(".codex\\auth.json");
    expect(taskUserRunner).toContain(".claude\\.credentials.json");
    expect(taskUserRunner).toContain("Expand-Archive");
    expect(taskUserRunner).toContain("AWS_METADATA_SERVICE_TIMEOUT");
    expect(taskUserRunner).toContain("--cli-connect-timeout");
    expect(taskUserRunner).toContain("--cli-read-timeout");
    expect(taskUserRunner).toContain("Start-Job");
    expect(taskUserRunner).toContain("Wait-Job");
    expect(taskUserRunner).toContain("Stop-Job");
    expect(taskUserRunner).toContain("pnpm install");
    expect(taskUserRunner).toContain("1200");
  });

  it("detects a finished scheduled task immediately instead of spinning to the deadline (#2431)", () => {
    // A fast-failed task must surface in ~seconds, not burn the full SSM/runner
    // budget. The completion check must not depend on Get-ScheduledTaskInfo
    // LastRunTime updating (it lags and can sit at its sentinel after a quick
    // run); it latches on the Running state and the never-ran result sentinel.
    expect(taskUserRunner).toContain("267011");
    expect(taskUserRunner).toContain("SCHED_S_TASK_HAS_NOT_RUN");
    expect(taskUserRunner).toContain("observedRunning");
    expect(taskUserRunner).toContain("taskFinished");
    // The brittle LastRunTime-vs-startedAt break condition is gone.
    expect(taskUserRunner).not.toContain("LastRunTime -gt");
    expect(taskUserRunner).not.toContain("$startedAt");
  });

  it("authenticates the claude-code journey via Bedrock without a login file (#2433)", () => {
    // Bedrock authenticates the Claude Code CLI through the AWS credential chain,
    // so the auth gate must treat Claude as authenticated when
    // CLAUDE_CODE_USE_BEDROCK is set, rather than requiring a login file.
    expect(agentRegistry).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(agentRegistry).toContain("isClaudeBedrockConfigured");
    // The harness configures the Bedrock backend (region + models) and the probe
    // forwards the model id as the spawn --model (the runtime always passes
    // --model, which overrides ANTHROPIC_MODEL).
    expect(taskUserRunner).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(taskUserRunner).toContain("ANTHROPIC_SMALL_FAST_MODEL");
    expect(taskUserRunner).toContain("SEREN_E2E_AGENT_USE_BEDROCK");
    expect(probe).toContain("SEREN_E2E_AGENT_MODEL");
    expect(probe).toContain("initialModelId");
  });

  it("allows unsigned release walkthroughs only for an explicit MAX_SIGNATURES block", () => {
    expect(runner).toContain("[switch]$AllowUnsignedPrArtifact");
    expect(runner).toContain("[switch]$AllowUnsignedBudgetBlockedArtifact");
    expect(runner).toContain("SEREN_E2E_UNSIGNED_PR_RUN");
    expect(runner).toContain("SEREN_E2E_RELEASE_RUN");
    expect(runner).toContain("SEREN_E2E_WINDOWS_SIGNING_BLOCKED");
    expect(runner).toContain("is forbidden for release Windows e2e runs");
    expect(runner).toContain("requires an explicit budget-blocked release run");
    expect(taskUserRunner).toContain("AllowUnsignedBudgetBlockedArtifact");

    const releaseGate = workflowJob("windows-app-e2e");
    expect(releaseGate).toContain("Download Windows signing budget state");
    expect(releaseGate).toContain("windows-signing-budget-state.json");
    expect(releaseGate).toContain("aws s3 presign");
    expect(releaseGate).toContain("Invoke-WebRequest -Uri");
    expect(releaseGate).toContain(
      "[windows-e2e:ssm] Running Windows app harness as scheduled task user",
    );
    expect(releaseGate).toContain("-ProbeTimeoutSeconds 1800");
    expect(releaseGate).toContain("$LASTEXITCODE");
    expect(releaseGate).toContain(
      "Windows app scheduled-task harness failed with exit code",
    );
    expect(releaseGate).not.toContain("-AllowUnsignedPrArtifact");
    expect(releaseGate).toContain("-AllowUnsignedBudgetBlockedArtifact");
    expect(releaseGate).not.toContain("-AllowMissingAgentCredentials");
    expect(releaseGate).not.toContain("SEREN_E2E_UNSIGNED_PR_RUN");
  });

  it("covers the required production journeys", () => {
    for (const required of [
      "provider_runtime_get_config",
      "provider_spawn",
      "provider_prompt",
      "history_sync_run_now",
      "history_sync_wipe_remote",
      "api.github.com/user",
      "create_meeting",
      "start_meeting_capture",
      "stop_meeting_capture",
    ]) {
      expect(probe).toContain(required);
    }
    expect(probe).toContain("SEREN_WINDOWS_E2E_OK");
  });

  it("bounds provider runtime waits and preserves diagnostic breadcrumbs (#2475)", () => {
    for (const required of [
      "PROVIDER_CONFIG_TIMEOUT_MS",
      "PROVIDER_CONFIG_REFRESH_TIMEOUT_MS",
      "PROVIDER_HEALTH_TIMEOUT_MS",
      "PROVIDER_HEALTH_REQUEST_TIMEOUT_MS",
      "PROVIDER_WS_OPEN_TIMEOUT_MS",
      "PROVIDER_RPC_TIMEOUT_MS",
      "PROVIDER_ENSURE_CLI_TIMEOUT_MS",
      "PROVIDER_SPAWN_TIMEOUT_MS",
      "PROVIDER_TERMINATE_TIMEOUT_MS",
      "rpcWithTimeout",
      "provider runtime auth",
      "provider runtime config",
      "provider runtime WebSocket open",
      "journey starting",
      "spawning provider session",
      "prompt-complete event observed",
      "Last provider runtime events",
    ]) {
      expect(probe).toContain(required);
    }
  });

  it("refreshes provider-runtime config while waiting for health (#2539)", () => {
    expect(probe).toContain("resolveProviderRuntimeConfig");
    expect(probe).toContain("fetchProviderRuntimeHealth");
    expect(probe).toContain("refreshProviderRuntimeConfig");
    expect(probe).toContain("Provider runtime health miss");
    expect(probe).toContain("provider runtime config refresh");
    expect(probe).toContain("connectProviderRuntime(page, config)");

    const connectStart = probe.indexOf("async function connectProviderRuntime");
    expect(connectStart).toBeGreaterThanOrEqual(0);
    const connectBody = probe.slice(connectStart, probe.indexOf("function assistantText"));
    expect(connectBody.indexOf("fetchProviderRuntimeHealth")).toBeLessThan(
      connectBody.indexOf("refreshProviderRuntimeConfig"),
    );
  });

  it("uploads complete Windows e2e probe and runtime logs (#2539)", () => {
    expect(runner).toContain("windows-e2e-logs");
    expect(runner).toContain("windows-e2e-probe.stdout.log");
    expect(runner).toContain("windows-e2e-probe.stderr.log");
    expect(runner).toContain("RedirectStandardOutput");
    expect(runner).toContain("RedirectStandardError");
    expect(runner).toContain("Copy-E2EAppLogs");
    expect(runner).toContain("com.serendb.desktop\\logs");

    expect(releaseWorkflow).toContain("windows-e2e-logs.zip");
    expect(releaseWorkflow).toContain("Bundling Windows app harness logs");
    expect(releaseWorkflow).toContain("logs_upload_url");
    expect(releaseWorkflow).toContain("generate_presigned_url");
    expect(releaseWorkflow).toContain("put_object");
    expect(releaseWorkflow).toContain("Invoke-WebRequest -Uri $logsUploadUrl -Method Put");
    expect(releaseWorkflow).toContain("          import os\n");
    expect(releaseWorkflow).toContain("          PY\n");
    expect(releaseWorkflow).not.toContain("\nimport os\nimport subprocess\n");
    expect(releaseWorkflow).not.toContain("aws s3 cp $logBundle $logsS3Uri");
    expect(releaseWorkflow).toContain("Download Windows e2e log bundle");
    expect(releaseWorkflow).toContain("Upload Windows e2e logs");
    expect(releaseWorkflow).toContain("windows-app-e2e-logs");
  });

  it("preprovisions real agent CLIs outside provider startup before checking release-gate availability (#2481, #3100)", () => {
    // #3096 removed automatic provider-startup installers. The disposable
    // Windows release user must install its explicit test prerequisites before
    // app launch, while the production RPC only verifies resolution.
    const cliSetupAt = taskUserRunner.indexOf(
      'Invoke-LoggedNative "Install e2e agent CLIs"',
    );
    const appHarnessAt = taskUserRunner.indexOf(
      'Invoke-LoggedNative "Windows app harness"',
    );
    expect(cliSetupAt).toBeGreaterThanOrEqual(0);
    expect(appHarnessAt).toBeGreaterThanOrEqual(0);
    expect(cliSetupAt).toBeLessThan(appHarnessAt);
    expect(taskUserRunner).toContain("@anthropic-ai/claude-code@latest");
    expect(taskUserRunner).toContain("@openai/codex@latest");
    expect(taskUserRunner).toContain("@google/gemini-cli@latest");
    expect(taskUserRunner).toContain("@xai-official/grok@latest");
    for (const [label, binary] of [
      ["Claude Code", "claude.cmd"],
      ["Codex", "codex.cmd"],
      ["Gemini", "gemini.cmd"],
      ["Grok", "grok.cmd"],
    ]) {
      expect(taskUserRunner).toContain(
        `Label = "${label}"; Package =`,
      );
      expect(taskUserRunner).toContain(`Binary = "${binary}"`);
    }
    expect(taskUserRunner).toContain(
      'Invoke-LoggedNative "Verify `$(`$agentCli.Label) CLI"',
    );

    expect(probe).toContain("provider_ensure_agent_cli");
    expect(probe).toContain("ensureAgentCli");
    expect(probe).toContain("ensuring provider CLI");
    expect(probe).toContain("provider CLI ready");
    expect(probe).toContain("CLI_COMPATIBILITY_AGENT_TYPES");
    expect(probe).toContain("verifyAgentCliCompatibility");
    expect(probe).toContain("all provider CLI resolution checks passed");
    for (const agentType of [
      "codex",
      "claude-code",
      "claude-codex",
      "gemini",
      "grok",
    ]) {
      expect(probe).toContain(`"${agentType}"`);
    }
    const runtimeExerciseAt = probe.indexOf("async function exerciseAgentRuntime");
    const compatibilityCheckAt = probe.indexOf(
      "await verifyAgentCliCompatibility(ws)",
      runtimeExerciseAt,
    );
    const authenticatedJourneysAt = probe.indexOf(
      "for (const journey of AGENT_JOURNEYS)",
      runtimeExerciseAt,
    );
    expect(runtimeExerciseAt).toBeGreaterThanOrEqual(0);
    expect(compatibilityCheckAt).toBeGreaterThan(runtimeExerciseAt);
    expect(compatibilityCheckAt).toBeLessThan(authenticatedJourneysAt);

    const singleJourneyStart = probe.indexOf("async function runSingleAgentJourney");
    const pairedJourneyStart = probe.indexOf("async function runPairedJourney");
    expect(singleJourneyStart).toBeGreaterThanOrEqual(0);
    expect(pairedJourneyStart).toBeGreaterThanOrEqual(0);

    const singleJourney = probe.slice(singleJourneyStart, pairedJourneyStart);
    const pairedJourney = probe.slice(pairedJourneyStart);
    expect(singleJourney.indexOf("ensureAgentCli")).toBeLessThan(
      singleJourney.indexOf("provider_check_agent_available"),
    );
    expect(pairedJourney.indexOf("ensureAgentCli")).toBeLessThan(
      pairedJourney.indexOf("provider_check_agent_available"),
    );
  });

  it("certifies every shipped agent journey, not one env-selected type (#2375)", () => {
    // The harness iterates a journey list; it must not regress to a single
    // SEREN_E2E_AGENT_TYPE spawn.
    expect(probe).toContain("AGENT_JOURNEYS");
    expect(probe).toContain("SEREN_E2E_AGENT_JOURNEYS");
    expect(probe).toContain("runSingleAgentJourney");
    expect(probe).toContain("runPairedJourney");
    for (const journey of ["codex", "claude-code", "claude-codex"]) {
      expect(probe).toContain(journey);
    }
  });

  it("asserts the paired pipeline structurally, not by marker text (#2375)", () => {
    // Claude reframes the prompt into a plan and the reviewer summarizes, so
    // the literal marker cannot survive the paired pipeline — coverage is the
    // declaration + two handoffs + single prompt-complete + held status.
    expect(probe).toContain("provider://paired-event");
    expect(probe).toContain("declaration");
    expect(probe).toContain("handoff");
    expect(probe).toContain("provider://prompt-complete");
    // Guards the #2372 mid-turn "ready" regression on Windows.
    expect(probe).toContain("prompting");
    expect(probe).toMatch(/planning.*executing.*reviewing/s);
  });

  it("surfaces an unauthenticated CLI as a distinct login failure (#2375)", () => {
    // An expired or unprovisioned credential must read as a login problem, not
    // a generic spawn/timeout failure.
    expect(probe).toContain("AgentAuthError");
    expect(probe).toContain("AgentProvisioningError");
    expect(probe).toContain("provider_check_agent_authenticated");
    expect(probe).toContain(
      "provider_check_agent_authenticated returned false before prompt",
    );
    expect(probe).toContain("not authenticated");
    expect(probe).toContain("provider://error");
    expect(probe).toContain("app server stopped before request completed");
    expect(probe).toContain("SEREN_E2E_AGENT_CREDENTIAL_ARCHIVE_S3_URI");
  });

  it("has a manual publish override for already-built release artifacts", () => {
    expect(existsSync(manualPublishWorkflowPath)).toBe(true);
    expect(manualPublishWorkflow).toContain("workflow_dispatch:");
    expect(manualPublishWorkflow).toContain("run_id:");
    expect(manualPublishWorkflow).toContain("tag:");
    expect(manualPublishWorkflow).toContain("actions/download-artifact@v8");
    expect(manualPublishWorkflow).toContain("run-id: ${{ inputs.run_id }}");
    expect(manualPublishWorkflow).toContain(
      "github-token: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(manualPublishWorkflow).toContain("WINDOWS_SIGNING_NOTE");
    expect(manualPublishWorkflow).toContain("windows-signing-budget-state.json");
    expect(manualPublishWorkflow).toContain("windowsSigningBlocked");
    expect(manualPublishWorkflow).toContain("latest.json");
    expect(manualPublishWorkflow).not.toContain("windows-app-e2e");
  });

  it("self-prunes leaked on-box scratch dirs and removes this run's on both paths (#2901)", () => {
    const job = workflowJob("windows-app-e2e");
    // Prune ALL prior scratch dirs (not just this run-id), so a crash before the
    // finally-cleanup can't silently fill the box drive across runs.
    expect(job).toContain(
      "Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'seren-release-windows-e2e-*'",
    );
    expect(job).toContain(
      "$stale | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }",
    );
    // The leaky start-only, same-run-id-only cleanup must not come back.
    expect(job).not.toContain(
      "if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }",
    );
    // Scratch is removed on success AND failure, after logs upload; Set-Location
    // out of $work first because Windows can't delete a process's CWD.
    expect(job).toContain(
      "} finally { Set-Location -LiteralPath $env:TEMP; Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue;",
    );
    // Disk pressure surfaces explicitly instead of as a mystery CDP timeout.
    expect(job).toContain("Low disk:");
  });

  it("resolves the real WebView2 CDP port via DevToolsActivePort (#2902)", () => {
    // The gate must not hard-code 9222 forever: when WebView2 binds a different
    // port (busy/ephemeral/Evergreen bump), DevToolsActivePort names the real one.
    expect(runner).toContain("function Get-DevToolsActivePort");
    expect(runner).toContain("function Get-WebView2UserDataDirs");
    expect(runner).toContain("com.serendb.desktop\\EBWebView");
    expect(runner).toContain("DevToolsActivePort");
    expect(runner).toContain("-UserDataDirs $webViewUserDataDirs");
    // The resolved port is threaded through to the Node probe.
    expect(runner).toContain(
      '$env:SEREN_E2E_CDP_ENDPOINT = "http://127.0.0.1:$cdpPort"',
    );
    // Timeout must state whether DevToolsActivePort existed and what it named.
    expect(runner).toContain("function Write-DevToolsActivePortDiagnostics");
    expect(runner).toContain("Write-DevToolsActivePortDiagnostics $UserDataDirs");
    // Origin stays a wildcard: it only gates the WS upgrade, not /json/version,
    // and a fixed-port origin would reject the non-9222 fallback we attach to.
    expect(runner).toContain("--remote-allow-origins=*");
  });

  it("enables WebView2 remote debugging via the app's own AdditionalBrowserArguments (#2902)", () => {
    // WebView2 150 drops the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var once
    // the host app sets browser args, so --remote-debugging-port never reaches
    // the browser process. The port must be injected through the app's own
    // programmatic additional_browser_args, gated on an e2e-only env flag.
    expect(runner).toContain("SEREN_E2E_REMOTE_DEBUG_PORT");

    const libRs = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
    expect(libRs).toContain("SEREN_E2E_REMOTE_DEBUG_PORT");
    expect(libRs).toContain("additional_browser_args");
    expect(libRs).toContain("WebviewWindowBuilder::from_config");
    // additional_browser_args REPLACES wry's default, so the e2e string must
    // reproduce it or the e2e webview would diverge from production.
    expect(libRs).toContain(
      "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    );
    expect(libRs).toContain("--autoplay-policy=no-user-gesture-required");

    // The window is created in the setup hook, so auto-creation must be off.
    const tauriConf = readFileSync(
      join(root, "src-tauri/tauri.conf.json"),
      "utf8",
    );
    expect(tauriConf).toContain('"create": false');
  });

  it("signs stock NSIS plugins on a cold cache instead of exiting 0 on a null $LASTEXITCODE (#2900)", () => {
    // windows-signature-cache.ps1 runs only cmdlets, so it must exit with a
    // deterministic code — otherwise a `&`-invoking caller inherits a $null
    // $LASTEXITCODE, and `$null -ne 0` ($true in PowerShell) trips its failure
    // guard, exiting 0 before signing and shipping an unsigned nsExec.dll.
    const cacheScript = readFileSync(
      join(root, "scripts/windows-signature-cache.ps1"),
      "utf8",
    );
    expect(cacheScript.trimEnd().endsWith("exit 0")).toBe(true);

    // The stage script's cache guards must be null-safe (`if ($LASTEXITCODE)`),
    // never the `-ne 0` form that fires on a clean run.
    const stage = readFileSync(
      join(root, "scripts/stage-signed-nsis-toolset.ps1"),
      "utf8",
    );
    expect(stage).toContain("if ($LASTEXITCODE) { exit $LASTEXITCODE }");
    expect(stage).not.toContain("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }");
  });

  it("activates the same pnpm major on the e2e box as the release build", () => {
    // The box runs `pnpm install --frozen-lockfile`. pnpm 10 moved
    // patchedDependencies from package.json into pnpm-workspace.yaml, so a
    // pnpm 9 box reads an empty config, sees the key in the lockfile, and
    // aborts with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH — failing the gate that
    // publish-release needs, so the tag never publishes (#3136).
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
    const patchesAreWorkspaceScoped =
      /^patchedDependencies:/m.test(workspace) &&
      /^patchedDependencies:/m.test(lockfile);

    const activated = taskUserRunner.match(
      /"prepare",\s*"pnpm@(\d+)"/,
    );
    expect(activated).not.toBeNull();
    const boxMajor = Number(activated?.[1]);

    const releaseMajor = Number(
      releaseWorkflow.match(
        /uses: pnpm\/action-setup@v\d+\s+with:\s+version: (\d+)/,
      )?.[1],
    );
    expect(releaseMajor).toBeGreaterThan(0);
    expect(boxMajor).toBe(releaseMajor);

    // The mismatch above is only silent-fatal while patches live in the
    // workspace file; assert the precondition so this test explains itself
    // if the patch declaration ever moves back.
    expect(patchesAreWorkspaceScoped).toBe(true);
    expect(boxMajor).toBeGreaterThanOrEqual(10);
  });

  it("ships every file the box's frozen install needs", () => {
    // The box runs `pnpm install --frozen-lockfile` against the payload zip.
    // pnpm 11 reads patchedDependencies from pnpm-workspace.yaml and the
    // lockfile references patches/happy@1.2.0.patch. A payload with only
    // package.json + pnpm-lock.yaml aborts with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
    // (no workspace config) or ENOENT (no patch), failing the gate that
    // publish-release needs. #3136
    const stageJob = workflowJob("windows-app-e2e");
    const zipCmd = stageJob.slice(
      stageJob.indexOf('zip -q -r "$payload"'),
    );
    const line = zipCmd.slice(0, zipCmd.indexOf("prefix="));

    for (const required of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches",
    ]) {
      expect(line).toContain(required);
    }
  });

  it("provisions a Node the box's pnpm can actually run on", () => {
    // pnpm 11 imports node:sqlite and refuses to run on Node < 22.13. #3136
    // moved the box to pnpm 11 but left it on the baked Node 20, so the frozen
    // install crashed with ERR_UNKNOWN_BUILTIN_MODULE and the gate failed the
    // publish. The harness must provision its own Node, first on PATH, before
    // the corepack/pnpm steps — and it has to be recent enough for pnpm 11.
    const provisioned = taskUserRunner.match(
      /\$nodeVersion\s*=\s*"v(\d+)\.\d+\.\d+"/,
    );
    expect(provisioned).not.toBeNull();
    const nodeMajor = Number(provisioned?.[1]);

    // pnpm 11's floor is Node 22.13; require the major that ships node:sqlite.
    expect(nodeMajor).toBeGreaterThanOrEqual(22);

    // The provision must precede the corepack/pnpm activation, or the box's
    // baked Node is still what runs the install.
    const provisionAt = taskUserRunner.indexOf("$nodeVersion");
    const corepackAt = taskUserRunner.indexOf('"Corepack enable"');
    expect(provisionAt).toBeGreaterThanOrEqual(0);
    expect(corepackAt).toBeGreaterThan(provisionAt);

    // And it must actually lead PATH, not just be downloaded. The task body is
    // a here-string, so `$` is backtick-escaped in the raw file.
    expect(taskUserRunner).toContain('"`$nodeDir;`$env:PATH"');

    // Keep the harness Node major aligned with the pipeline's.
    const releaseNodeMajor = Number(
      releaseWorkflow.match(/node-version:\s*(\d+)/)?.[1],
    );
    expect(releaseNodeMajor).toBeGreaterThan(0);
    expect(nodeMajor).toBe(releaseNodeMajor);
  });
});
