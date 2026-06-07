// ABOUTME: Tests dictation cleanup behavior for filler removal and vocabulary casing.
// ABOUTME: Covers local text rules used by the upgraded voice input hook.

import { describe, expect, it } from "vitest";
import { cleanupDictationText } from "@/lib/audio/dictationCleanup";

describe("cleanupDictationText", () => {
  it("removes fillers and normalizes spacing", () => {
    expect(cleanupDictationText("um send this, uh, today")).toBe(
      "Send this, today",
    );
  });

  it("applies custom vocabulary casing", () => {
    expect(
      cleanupDictationText("tell serenbucks to route this", ["SerenBucks"]),
    ).toBe("Tell SerenBucks to route this");
  });
});
