// ABOUTME: Source-level guards for the conversation-native memory UI.
// ABOUTME: Verifies #2083 uses existing chat rows + SlidePanel, not a memory manager screen.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);

describe("#2083 chat memory affordance", () => {
  it("renders answer-level memory controls through the existing SlidePanel", () => {
    expect(chatContentSource).toContain(
      'import { SlidePanel } from "@/components/layout/SlidePanel"',
    );
    expect(chatContentSource).toContain("Used ");
    expect(chatContentSource).toContain(" remembered detail");
    expect(chatContentSource).toContain("Memory used in this answer");
    expect(chatContentSource).toContain("Something is wrong");
    expect(chatContentSource).toContain("Undo remember");
    expect(chatContentSource).toContain("Do not use here");
    expect(chatContentSource).not.toContain("Memory Control Center");
  });
});
