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
const releaseWorkflow = readFileSync(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);
const manualPublishWorkflow = existsSync(manualPublishWorkflowPath)
  ? readFileSync(manualPublishWorkflowPath, "utf8")
  : "";
const runner = readFileSync(join(root, "scripts/windows-e2e-app.ps1"), "utf8");
const probe = readFileSync(join(root, "scripts/windows-e2e-app.mjs"), "utf8");

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

  it("requires real production credentials and a live history-sync tenant", () => {
    for (const required of [
      "SEREN_E2E_EMAIL",
      "SEREN_E2E_PASSWORD",
      "SEREN_E2E_HISTORY_PROJECT_ID",
      "SEREN_E2E_HISTORY_BRANCH_ID",
      "SEREN_E2E_HISTORY_DATABASE_NAME",
      "SEREN_E2E_GITHUB_USERNAME",
      "SEREN_E2E_GITHUB_PASSWORD",
      "SEREN_E2E_GITHUB_PAT",
    ]) {
      expect(runner).toContain(required);
      expect(probe).toContain(required);
    }
    expect(runner).toContain("https://api.serendb.com");
    expect(probe).toContain("https://api.serendb.com");
  });

  it("installs and probes the signed Windows app instead of running a browser mock", () => {
    expect(runner).toContain("Get-AuthenticodeSignature");
    expect(runner).toContain("/S");
    expect(runner).toContain("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    expect(runner).toContain("node.exe");
    expect(runner).toContain("npm.cmd");
    expect(runner).toContain("windows-e2e-app.mjs");
    expect(probe).toContain("connectOverCDP");
    expect(probe).toContain("__TAURI_INTERNALS__");
  });

  it("covers the required production journeys", () => {
    for (const required of [
      "provider_runtime_get_config",
      "provider_spawn",
      "provider_prompt",
      "history_sync_run_now",
      "history_sync_wipe_remote",
      "get_oauth_redirect_url",
      "/oauth/connections",
      "create_meeting",
      "start_meeting_capture",
      "stop_meeting_capture",
    ]) {
      expect(probe).toContain(required);
    }
    expect(probe).toContain("SEREN_WINDOWS_E2E_OK");
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
