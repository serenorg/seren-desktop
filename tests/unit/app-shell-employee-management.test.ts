// ABOUTME: Regression guards for temporarily hidden employee management surfaces.
// ABOUTME: Ensures AppShell does not expose catalog/inbox buttons in the sidebar.

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
  it("does not pass catalog and inbox handlers into ThreadSidebar", () => {
    const threadSidebarInvocation = appShellTsx.match(
      /<ThreadSidebar[\s\S]*?\/>/,
    )?.[0];

    expect(threadSidebarInvocation).toBeDefined();
    expect(threadSidebarInvocation).not.toContain("onOpenCatalog=");
    expect(threadSidebarInvocation).not.toContain("onOpenInbox=");
  });

  it("keeps ThreadSidebar support ready for the hidden buttons", () => {
    expect(sidebarTsx).toContain("onOpenCatalog={props.onOpenCatalog}");
    expect(sidebarTsx).toContain("onOpenInbox={props.onOpenInbox}");
  });
});
