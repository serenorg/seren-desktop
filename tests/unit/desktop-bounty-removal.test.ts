// ABOUTME: Regression guard for removing the retired desktop bounty UI.
// ABOUTME: Keeps the interview landing as the main replacement surface.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      return sourceFiles(path);
    }

    return stat.isFile() ? [path] : [];
  });
}

describe("retired desktop bounty UI", () => {
  it("has no remaining source references", () => {
    const matches = sourceFiles(resolve("src")).filter((path) =>
      readFileSync(path, "utf8").toLowerCase().includes("bounty"),
    );

    expect(matches).toEqual([]);
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
