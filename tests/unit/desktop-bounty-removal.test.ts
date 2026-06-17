// ABOUTME: Regression guard for removing the retired desktop bounty UI.
// ABOUTME: Keeps the interview landing as the main replacement surface.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("retired desktop bounty UI", () => {
  it("has no remaining source references", () => {
    const result = spawnSync("rg", ["-i", "bounty", "src"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("");
  });

  it("keeps the interview landing wired as the replacement main surface", () => {
    const appShell = readFileSync(
      resolve("src/components/layout/AppShell.tsx"),
      "utf8",
    );
    const sidebar = readFileSync(
      resolve("src/components/layout/ThreadSidebar.tsx"),
      "utf8",
    );

    expect(appShell).toContain("InterviewLanding");
    expect(appShell).toContain("interviewLandingOpen");
    expect(sidebar).toContain("EmployeesSection");
  });
});
