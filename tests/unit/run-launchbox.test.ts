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
    expect(launchBoxSource).toContain("run-agent-${agentType}");
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
  });

  it("sends objective, tasks, agents, and workspace root to the store", async () => {
    const launch = vi.spyOn(runStore, "launch").mockResolvedValue(undefined);

    await launchMission({
      objective: "  Reconcile the billing records  ",
      rootPath: "/tmp/project",
      tasks: [{ title: "Inspect invoices", brief: "Compare totals." }],
      agents: ["codex", "seren"],
    });

    expect(launch).toHaveBeenCalledWith({
      objective: "  Reconcile the billing records  ",
      rootPath: "/tmp/project",
      tasks: [{ title: "Inspect invoices", brief: "Compare totals." }],
      agents: ["codex", "seren"],
    });
  });
});
