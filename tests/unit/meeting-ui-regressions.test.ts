// ABOUTME: Source-level guards for Meeting Mode usability regressions from #2228.
// ABOUTME: Keeps capture controls reachable and transcript review out of the narrow sidebar layout.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Meeting Mode top-right entry point (#2228)", () => {
  it("opens Meetings from a titlebar icon instead of the lower-left text row", () => {
    const titlebar = source("src/components/layout/Titlebar.tsx");
    const appShell = source("src/components/layout/AppShell.tsx");
    const sidebar = source("src/components/layout/ThreadSidebar.tsx");

    expect(titlebar).toContain("onToggleMeetings");
    expect(titlebar).toContain('data-testid="titlebar-meetings-button"');
    expect(titlebar.indexOf('title="Meetings"')).toBeLessThan(
      titlebar.indexOf('title="Settings"'),
    );
    expect(appShell).toContain("handleToggleMeetings");
    expect(appShell).toContain("onToggleMeetings={handleToggleMeetings}");
    expect(sidebar).not.toContain('data-testid="meetings-button"');
  });
});

describe("Meeting Mode transcript layout (#2228)", () => {
  it("uses a reader-width slide panel and removes the narrow detail max-width", () => {
    const appShell = source("src/components/layout/AppShell.tsx");
    const slidePanel = source("src/components/layout/SlidePanel.tsx");
    const detail = source("src/components/meeting/MeetingDetail.tsx");

    expect(appShell).toContain('reader={slidePanel() === "meetings"}');
    expect(slidePanel).toContain("reader?: boolean");
    expect(slidePanel).toContain('props.reader ? "1040px"');
    expect(detail).toContain("max-w-none");
    expect(detail).not.toContain("max-w-[760px]");
  });
});

describe("Meeting capture controls (#2325)", () => {
  it("does not create a separate floating capture widget", () => {
    const index = source("src/index.tsx");
    const store = source("src/stores/meeting.store.ts");

    expect(index).not.toContain("CaptureWidget");
    expect(index).not.toContain("widget=1");
    expect(store).not.toContain("openCaptureWidget");
    expect(store).not.toContain("onWidgetStopRequest");
    expect(
      existsSync(resolve(repoRoot, "src/services/captureWidget.ts")),
    ).toBe(false);
    expect(
      existsSync(resolve(repoRoot, "src/components/meeting/CaptureWidget.tsx")),
    ).toBe(false);
  });
});

describe("Meeting auto-detect consent prompt (#2231)", () => {
  it("surfaces the detected app name while keeping capture consent-first", () => {
    const prompt = source("src/components/meeting/RecordPrompt.tsx");
    const appShell = source("src/components/layout/AppShell.tsx");
    const store = source("src/stores/meeting.store.ts");
    const service = source("src/services/meetings.ts");
    const nativeCommand = source("src-tauri/src/commands/audio.rs");

    expect(prompt).toContain("sourceApp");
    expect(prompt).toContain("Call detected");
    expect(prompt).toContain("Take notes");
    expect(prompt).not.toContain("Active input detected");
    expect(appShell).toContain("recordPromptSourceApp");
    expect(store).toContain("autoDetectSourceApp");
    expect(store).toContain("sourceApp: meetingState.autoDetectSourceApp");
    expect(service).toContain("MeetingAutodetectResult");
    expect(nativeCommand).toContain("MeetingAutodetectResult");
  });
});

describe("Meeting delete affordance (#2231)", () => {
  it("wires confirmed deletion through the UI, store, service, and native command", () => {
    const panel = source("src/components/meeting/MeetingPanel.tsx");
    const detail = source("src/components/meeting/MeetingDetail.tsx");
    const store = source("src/stores/meeting.store.ts");
    const service = source("src/services/meetings.ts");
    const nativeCommand = source("src-tauri/src/commands/audio.rs");
    const lib = source("src-tauri/src/lib.rs");

    expect(panel).toContain("ConfirmDialog");
    expect(panel).toContain("pendingDelete");
    expect(panel).toContain("deleteSelectedMeeting");
    expect(detail).toContain("onRequestDelete");
    expect(detail).toContain("Delete meeting");
    expect(store).toContain("deleteMeeting");
    expect(service).toContain('invoke("delete_meeting"');
    expect(nativeCommand).toContain("pub async fn delete_meeting");
    expect(nativeCommand).toContain("delete_meeting_record");
    expect(lib).toContain("commands::audio::delete_meeting");
  });
});

describe("Meeting pending capture ownership (#2745)", () => {
  it("treats pending capture as owning the start controls without exposing stop", () => {
    const panel = source("src/components/meeting/MeetingPanel.tsx");
    const store = source("src/stores/meeting.store.ts");

    expect(panel).toContain("const captureOwner = createMemo");
    expect(panel).toContain('meeting.status === "pending_capture"');
    expect(panel).toContain("if (captureOwner()) return;");
    expect(panel).toContain("disabled={captureOwner() !== undefined}");
    expect(panel).toContain('title="Starting capture"');
    expect(panel).toContain('meeting().status === "capturing"');
    expect(store).toContain("if (isCapturing()) return;");
  });
});
