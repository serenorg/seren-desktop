// ABOUTME: Regression coverage for #2806 recording indicator default placement.
// ABOUTME: Ensures the first-run pill clears the chat composer controls.

import { describe, expect, it } from "vitest";
import { defaultRecordingIndicatorPosition } from "@/components/meeting/recordingIndicatorPlacement";

describe("recording indicator placement (#2806)", () => {
  it("places the default indicator above a visible chat composer", () => {
    const position = defaultRecordingIndicatorPosition({
      viewportWidth: 1440,
      viewportHeight: 900,
      indicatorWidth: 320,
      indicatorHeight: 40,
      composerTop: 720,
      titlebarHeight: 40,
    });

    expect(position.x).toBe(1104);
    expect(position.y + 40).toBeLessThanOrEqual(708);
  });

  it("keeps the old bottom-right default when no chat composer is visible", () => {
    const position = defaultRecordingIndicatorPosition({
      viewportWidth: 1440,
      viewportHeight: 900,
      indicatorWidth: 320,
      indicatorHeight: 40,
      composerTop: null,
      titlebarHeight: 40,
    });

    expect(position).toEqual({ x: 1104, y: 844 });
  });
});
