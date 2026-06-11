// ABOUTME: Source-level guards for #2335 — meeting rename plumbing and the titlebar recording indicator.
// ABOUTME: Locks the wiring so the rename path and live-capture affordance can't silently regress.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Meeting rename plumbing (#2335)", () => {
  it("wires updateMeetingTitle from the service to a Rust command", () => {
    const service = source("src/services/meetings.ts");
    expect(service).toContain("export function updateMeetingTitle");
    expect(service).toContain('invoke("update_meeting_title"');
  });

  it("registers the Rust update_meeting_title command", () => {
    expect(source("src-tauri/src/commands/audio.rs")).toContain(
      "pub async fn update_meeting_title",
    );
    expect(source("src-tauri/src/lib.rs")).toContain(
      "commands::audio::update_meeting_title",
    );
  });

  it("adds a renameMeeting store action over updateMeetingTitle", () => {
    const store = source("src/stores/meeting.store.ts");
    expect(store).toContain("renameMeeting");
    expect(store).toContain("updateMeetingTitle");
  });

  it("makes the detail title editable, committing on Enter and canceling on Escape", () => {
    const detail = source("src/components/meeting/MeetingDetail.tsx");
    expect(detail).toContain("renameMeeting");
    expect(detail).toContain('"Enter"');
    expect(detail).toContain('"Escape"');
  });

  it("starts capture on Enter in the new-meeting title field (no dead key)", () => {
    const panel = source("src/components/meeting/MeetingPanel.tsx");
    expect(panel).toContain("onKeyDown");
    expect(panel).toContain("startManualCapture");
  });
});

describe("Titlebar recording indicator when the drawer is closed (#2335)", () => {
  it("drives the meetings button from live capture state", () => {
    const titlebar = source("src/components/layout/Titlebar.tsx");
    expect(titlebar).toContain("meetingRecording");
    expect(titlebar).toContain("meeting-recording-glow");
  });

  it("derives capturing state in AppShell and passes it to the titlebar", () => {
    const appShell = source("src/components/layout/AppShell.tsx");
    expect(appShell).toContain("meetingRecording={");
  });

  it("defines the green recording-glow animation", () => {
    expect(source("src/styles.css")).toContain("meeting-recording-glow");
  });
});
