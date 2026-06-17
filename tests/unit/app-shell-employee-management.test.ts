// ABOUTME: Regression guards for employee management surface wiring.
// ABOUTME: Ensures AppShell exposes catalog/inbox buttons through the sidebar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appShellTsx = readFileSync(
  resolve("src/components/layout/AppShell.tsx"),
  "utf-8",
);
const sidebarTsx = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf-8",
);

describe("AppShell employee management wiring", () => {
  it("passes catalog and inbox handlers into ThreadSidebar", () => {
    const threadSidebarInvocation = appShellTsx.match(
      /<ThreadSidebar[\s\S]*?\/>/,
    )?.[0];

    expect(threadSidebarInvocation).toBeDefined();
    expect(threadSidebarInvocation).toContain(
      "onOpenCatalog={handleOpenCatalog}",
    );
    expect(threadSidebarInvocation).toContain("onOpenInbox={handleOpenInbox}");
  });

  it("keeps ThreadSidebar catalog and inbox callbacks wired", () => {
    expect(sidebarTsx).toContain("onOpenCatalog={props.onOpenCatalog}");
    expect(sidebarTsx).toContain("onOpenInbox={props.onOpenInbox}");
  });
});
