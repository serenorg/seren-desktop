// ABOUTME: Regression coverage for #2209 — dismissed auto-record prompts must re-arm after calls end.
// ABOUTME: Known apps now auto-start via the lifecycle; the prompt is for unrecognized apps, and must still re-arm.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  meetingAutodetect: vi.fn(async (): Promise<MeetingAutodetectResult> => ({
    detected: false,
    sourceApp: null,
  })),
  // The lifecycle takes no action for an unrecognized app, so the poll falls
  // through to the arm prompt — the path this regression guards.
  meetingLifecycleTick: vi.fn(async (): Promise<null> => null),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  meetingAutodetect: m.meetingAutodetect,
  meetingLifecycleTick: m.meetingLifecycleTick,
  listMeetings: m.listMeetings,
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) => {
      if (key === "meetingAutoDetectEnabled") return true;
      return undefined;
    },
    set: vi.fn(),
  },
}));

import type { Meeting, MeetingAutodetectResult } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

// Flush the microtasks of one poll (lifecycle tick + autodetect + state set).
async function flushPoll(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("meeting auto-detect dismissal reset (#2209)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    m.meetingAutodetect.mockReset();
    m.meetingLifecycleTick.mockReset();
    m.meetingLifecycleTick.mockResolvedValue(null);
    m.listMeetings.mockResolvedValue([]);
    meetingStore.stopAutoDetect();
    meetingStore.resetAutoDetectDismissal();
  });

  afterEach(() => {
    meetingStore.stopAutoDetect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("re-arms the record prompt after a dismissed unrecognized call disappears", async () => {
    // An unrecognized call app (no known source) the lifecycle won't auto-start.
    m.meetingAutodetect.mockResolvedValueOnce({
      detected: true,
      sourceApp: null,
    });
    meetingStore.startAutoDetect();
    await flushPoll();

    expect(meetingStore.state.autoDetectSuggested).toBe(true);
    meetingStore.dismissAutoDetect();
    expect(meetingStore.state.autoDetectSuggested).toBe(false);

    // Call ends: while dismissed, the poll keeps probing and clears the dismissal.
    m.meetingAutodetect.mockResolvedValueOnce({
      detected: false,
      sourceApp: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(meetingStore.state.autoDetectSuggested).toBe(false);
    expect(meetingStore.state.autoDetectSourceApp).toBeNull();

    // A later unrecognized call re-arms the prompt.
    m.meetingAutodetect.mockResolvedValueOnce({
      detected: true,
      sourceApp: null,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(m.meetingAutodetect).toHaveBeenCalledTimes(3);
    expect(meetingStore.state.autoDetectSuggested).toBe(true);
  });
});
