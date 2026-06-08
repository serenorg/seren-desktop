// ABOUTME: Regression coverage for #2209 — dismissed auto-record prompts must re-arm after calls end.
// ABOUTME: The poll must still probe while dismissed so a later call can prompt again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  meetingAutodetect: vi.fn(async () => false),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  meetingAutodetect: m.meetingAutodetect,
  listMeetings: m.listMeetings,
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) => {
      if (key === "meetingAutoDetectEnabled") return true;
      if (key === "meetingAppAllowlist") return ["zoom"];
      return undefined;
    },
    set: vi.fn(),
  },
}));

import type { Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

describe("meeting auto-detect dismissal reset (#2209)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    m.meetingAutodetect.mockReset();
    m.listMeetings.mockResolvedValue([]);
    meetingStore.stopAutoDetect();
    meetingStore.resetAutoDetectDismissal();
  });

  afterEach(() => {
    meetingStore.stopAutoDetect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("re-arms the record prompt after the previously dismissed call app disappears", async () => {
    m.meetingAutodetect.mockResolvedValueOnce(true);
    meetingStore.startAutoDetect();
    await Promise.resolve();

    expect(meetingStore.state.autoDetectSuggested).toBe(true);
    meetingStore.dismissAutoDetect();
    expect(meetingStore.state.autoDetectSuggested).toBe(false);

    m.meetingAutodetect.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(meetingStore.state.autoDetectSuggested).toBe(false);

    m.meetingAutodetect.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(m.meetingAutodetect).toHaveBeenCalledTimes(3);
    expect(meetingStore.state.autoDetectSuggested).toBe(true);
  });
});
