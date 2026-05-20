// ABOUTME: Pins file-drag cleanup behavior shared by chat and agent panes.
// ABOUTME: Modal drop zones may stop propagation, so cleanup must run in capture.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve("src/lib/drag-drop.ts"), "utf-8");

describe("createDragDrop", () => {
  it("clears global file-drag state even when nested drop zones stop propagation", () => {
    expect(source).toContain("const handleDropCapture =");
    expect(source).toContain(
      'document.addEventListener("drop", handleDropCapture, true);',
    );
  });

  it("clears stale file-drag state when the drag ends outside the pane", () => {
    expect(source).toContain(
      'document.addEventListener("dragend", clearDragState, true);',
    );
    expect(source).toContain('window.addEventListener("blur", clearDragState);');
  });
});
