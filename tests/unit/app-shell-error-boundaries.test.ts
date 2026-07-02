// ABOUTME: Guards #2797 so recoverable shell errors do not blank chat threads.
// ABOUTME: Keeps the root fallback as last resort while AppShell owns scoped recovery.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("AppShell scoped error recovery (#2797)", () => {
  const appShell = source("src/components/layout/AppShell.tsx");
  const app = source("src/App.tsx");

  it("keeps the app-wide recovery screen as a last-resort boundary only", () => {
    expect(app).toContain("Something went wrong. Seren is recovering.");
    expect(appShell).toContain("ShellSurfaceBoundary");
    expect(appShell).toContain("ShellSilentBoundary");
  });

  it("wraps major shell surfaces in local boundaries so ThreadSidebar survives main view faults", () => {
    const sidebarIndex = appShell.indexOf("<ThreadSidebar");
    const mainIndex = appShell.indexOf(
      '<main class="flex-1 overflow-auto flex flex-col min-w-0">',
    );
    const mainBoundaryIndex = appShell.indexOf('surface="main"', mainIndex);
    const threadContentIndex = appShell.indexOf("<ThreadContent", mainIndex);

    expect(sidebarIndex).toBeGreaterThan(0);
    expect(mainIndex).toBeGreaterThan(sidebarIndex);
    expect(mainBoundaryIndex).toBeGreaterThan(mainIndex);
    expect(threadContentIndex).toBeGreaterThan(mainBoundaryIndex);
  });

  it("defines recovery fallbacks for titlebar, threads, workspace, panels, and overlays", () => {
    for (const marker of [
      'surface="titlebar"',
      'reportShellBoundaryError("thread_sidebar"',
      'surface="main"',
      'surface="slide_panel"',
      'surface="publish_modals"',
      'surface="global_overlays"',
      "Titlebar is recovering.",
      "Threads are recovering.",
      "Workspace is recovering.",
      "Panel is recovering.",
    ]) {
      expect(appShell).toContain(marker);
    }
  });
});
