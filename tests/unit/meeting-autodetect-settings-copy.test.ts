// ABOUTME: Regression coverage for #2215 auto-detect settings copy.
// ABOUTME: Prevents no-op meeting-app allowlist controls after input gating.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("meeting auto-detect settings (#2215)", () => {
  it("describes active input detection without exposing a no-op app allowlist", () => {
    const settingsSource = source("src/components/meeting/MeetingSettings.tsx");
    const settingsStoreSource = source("src/stores/settings.store.ts");
    const meetingStoreSource = source("src/stores/meeting.store.ts");
    const serviceSource = source("src/services/meetings.ts");
    const nativeCommandSource = source("src-tauri/src/commands/audio.rs");
    const detectionSource = source("src-tauri/src/audio/detect.rs");

    expect(settingsSource).toContain("active microphone input");
    expect(settingsSource).not.toContain("meetingAppAllowlist");
    expect(settingsSource).not.toContain("known meeting app");
    expect(settingsSource).not.toContain("Add a meeting app");
    expect(settingsStoreSource).not.toContain("meetingAppAllowlist");
    expect(meetingStoreSource).not.toContain("meetingAppAllowlist");
    expect(serviceSource).toContain("MeetingAutodetectResult");
    expect(nativeCommandSource).toContain(
      "pub fn meeting_autodetect() -> MeetingAutodetectResult",
    );
    expect(detectionSource).toContain(
      "pub fn should_start_capture(activity: AudioActivity) -> bool",
    );
  });
});
