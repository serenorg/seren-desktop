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
    // budget (TaskTimeoutSeconds + 60 = 3660s) plus pre-task overhead, so a valid
    // slow run is not killed by the harness before it finishes.
    expect(job).toContain('executionTimeout: ["6000"]');
    expect(job).toContain("SECONDS + 6300");
    expect(job).not.toContain("deadline=$((SECONDS + 3600))");
  });

  it("requires real production credentials and a live history-sync tenant", () => {
    for (const required of [
      "SEREN_E2E_EMAIL",
      "SEREN_E2E_PASSWORD",
      "SEREN_E2E_HISTORY_PROJECT_ID",
      "SEREN_E2E_HISTORY_BRANCH_ID",
      "SEREN_E2E_HISTORY_DATABASE_NAME",
      "SEREN_E2E_GITHUB_PAT",
    ]) {
      expect(runner).toContain(required);
      expect(probe).toContain(required);
    }
    expect(runner).toContain("https://api.serendb.com");
    expect(probe).toContain("https://api.serendb.com");
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
    expect(taskUserRunner).toContain("InstallerTimeoutSeconds = 600");
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

  it("keeps unsigned PR artifact mode explicit and forbidden for release runs", () => {
    expect(runner).toContain("[switch]$AllowUnsignedPrArtifact");
    expect(runner).toContain("SEREN_E2E_UNSIGNED_PR_RUN");
    expect(runner).toContain("SEREN_E2E_RELEASE_RUN");
    expect(runner).toContain("is forbidden for release Windows e2e runs");

    const releaseGate = workflowJob("windows-app-e2e");
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
    expect(releaseWorkflow).toContain("Download Windows e2e log bundle");
    expect(releaseWorkflow).toContain("Upload Windows e2e logs");
    expect(releaseWorkflow).toContain("windows-app-e2e-logs");
  });

  it("provisions agent CLIs before checking release-gate availability (#2481)", () => {
    // A Bedrock-backed Claude run still needs a launchable local Claude Code
    // binary. The release probe must use the same install contract as the
    // desktop spawn path before it asks whether the provider can launch.
    expect(probe).toContain("provider_ensure_agent_cli");
    expect(probe).toContain("ensureAgentCli");
    expect(probe).toContain("ensuring provider CLI");
    expect(probe).toContain("provider CLI ready");

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
    expect(manualPublishWorkflow).toContain("latest.json");
    expect(manualPublishWorkflow).not.toContain("windows-app-e2e");
  });
});
