// ABOUTME: Covers the first-run Mission Control launch surface.
// ABOUTME: Confirms the plain-language controls and launch service handoff.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_STATE,
  launchMission,
  runStore,
  setRunState,
} from "@/stores/run.store";

const launchBoxSource = readFileSync(
  resolve("src/components/run/RunLaunchBox.tsx"),
  "utf8",
);
const missionControlSource = readFileSync(
  resolve("src/components/run/MissionControlPanel.tsx"),
  "utf8",
);

describe("RunLaunchBox", () => {
  beforeEach(() => {
    setRunState(INITIAL_STATE);
    vi.restoreAllMocks();
  });

  it("defines an objective input and advanced disclosure", () => {
    expect(launchBoxSource).toContain('id="mission-objective"');
    expect(launchBoxSource).toContain('data-testid="run-objective"');
    expect(launchBoxSource).toContain("<details");
    expect(launchBoxSource).toContain("Seren will");
    expect(launchBoxSource).toContain("It will not");
    expect(launchBoxSource).toContain("run-task-title-${slot}");
    expect(launchBoxSource).toContain("run-task-brief-${slot}");
    expect(launchBoxSource).toContain("run-agent-${definition.id}");
    expect(launchBoxSource).toContain('data-testid="run-isolation-mode"');
    expect(launchBoxSource).toContain('data-testid="run-max-attempts"');
    expect(launchBoxSource).toContain("run-model-${agentType}");
    expect(launchBoxSource).toContain('pickerProps.target !== "lmstudio"');
    expect(launchBoxSource).toContain("No downloaded chat models");
    expect(launchBoxSource).toContain("resolveMissionModelSelection");
    expect(launchBoxSource).toContain("run-model-claude-codex-planner");
    expect(launchBoxSource).toContain("run-model-claude-codex-executor");
    expect(launchBoxSource).not.toContain("Pin an exact runtime model ID");
    expect(launchBoxSource).toContain("run-permission-${agentType}");
    expect(launchBoxSource).toContain(
      '"Claude + Codex · Codex executor"',
    );
    expect(launchBoxSource).toContain(
      "Approval prompts are separate from Isolation",
    );
    expect(launchBoxSource).not.toContain("Runtime default");
    expect(launchBoxSource).not.toContain("Allow workspace edits");
    expect(launchBoxSource).toContain('data-testid="run-launch-start"');
    expect(launchBoxSource).toContain("await launchMission({");
  });

  it("keeps the launch form in a visible, stable scroll region", () => {
    expect(missionControlSource).toContain(
      'data-testid="mission-launch-scroll-region"',
    );
    expect(missionControlSource).toContain("overflow-y-scroll");
    expect(missionControlSource).toContain("[scrollbar-gutter:stable]");
    expect(missionControlSource).toContain("[&::-webkit-scrollbar-thumb]");
    expect(missionControlSource).toContain(
      'data-testid="mission-launch-scrollbar"',
    );
    expect(missionControlSource).toContain(
      'data-testid="mission-launch-scrollbar-thumb"',
    );
    expect(missionControlSource).toContain("new ResizeObserver");
    expect(missionControlSource).toContain("onScroll={updateLaunchScroll}");
    // The overlay observer must attach whenever the launch region renders —
    // the form can appear after mount, when hydrateLatest clears a settled
    // run's stale snapshot, and a one-shot mount hook missed it. #3618
    expect(missionControlSource).toContain("ref={attachLaunchScrollRegion}");
    expect(missionControlSource).not.toContain("ref={launchScrollRegion}");
  });

  it("sends every editable launch policy to the store", async () => {
    const launch = vi.spyOn(runStore, "launch").mockResolvedValue(undefined);

    await launchMission({
      objective: "  Reconcile the billing records  ",
      rootPath: "/tmp/project",
      tasks: [{ title: "Inspect invoices", brief: "Compare totals." }],
      agents: [
        {
          agentType: "codex",
          modelId: "gpt-5.4",
          secondaryModelId: null,
          permissionMode: "ask",
        },
        {
          agentType: "seren",
          modelId: null,
          secondaryModelId: null,
          permissionMode: null,
        },
      ],
      workspaceMode: "worktree",
      maxAttempts: 2,
    });

    expect(launch).toHaveBeenCalledWith({
      objective: "  Reconcile the billing records  ",
      rootPath: "/tmp/project",
      tasks: [{ title: "Inspect invoices", brief: "Compare totals." }],
      agents: [
        {
          agentType: "codex",
          modelId: "gpt-5.4",
          secondaryModelId: null,
          permissionMode: "ask",
        },
        {
          agentType: "seren",
          modelId: null,
          secondaryModelId: null,
          permissionMode: null,
        },
      ],
      workspaceMode: "worktree",
      maxAttempts: 2,
    });
  });
});
