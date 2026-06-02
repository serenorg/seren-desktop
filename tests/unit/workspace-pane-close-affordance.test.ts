// ABOUTME: Source-level guard for #2084 direct per-pane close affordance.
// ABOUTME: Closing a vertical pane must not archive or terminate its thread.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const threadContentSource = readFileSync(
  resolve("src/components/layout/ThreadContent.tsx"),
  "utf-8",
);

describe("#2084 workspace pane close affordance", () => {
  it("renders a direct pane close action wired to workspaceStore.closeWindow", () => {
    expect(threadContentSource).toContain("Close pane");
    expect(threadContentSource).toContain("workspaceStore.closeWindow(target.id)");
    expect(threadContentSource).not.toContain("archiveThread(");
    expect(threadContentSource).not.toContain("terminateSession(");
  });
});
