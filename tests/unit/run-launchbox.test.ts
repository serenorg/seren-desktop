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

describe("RunLaunchBox", () => {
  beforeEach(() => {
    setRunState(INITIAL_STATE);
    vi.restoreAllMocks();
  });

  it("defines an objective input and advanced disclosure", () => {
    expect(launchBoxSource).toContain('id="mission-objective"');
    expect(launchBoxSource).toContain("<details");
    expect(launchBoxSource).toContain("Seren will");
    expect(launchBoxSource).toContain("It will not");
    expect(launchBoxSource).toContain("await launchMission(value)");
  });

  it("sends the typed objective to the store launch action", async () => {
    const launch = vi.spyOn(runStore, "launch").mockResolvedValue(undefined);

    await launchMission("  Reconcile the billing records  ");

    expect(launch).toHaveBeenCalledWith("  Reconcile the billing records  ");
  });
});
