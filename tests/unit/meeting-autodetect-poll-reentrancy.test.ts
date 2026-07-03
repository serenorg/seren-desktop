// ABOUTME: Regression coverage for #2814 — the auto-detect poll is single-flight.
// ABOUTME: Overlapping ticks during an in-flight capture start must not desync the lifecycle or orphan meetings.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  meetingLifecycleTick: vi.fn(async () => ({
    kind: "start_capture" as const,
    sourceApp: "Teams",
  })),
  meetingLifecycleNoteManualStop: vi.fn(async () => {}),
  meetingLifecycleNoteCaptureStarted: vi.fn(async () => {}),
  meetingLifecycleNoteStartFailed: vi.fn(async () => {}),
  meetingAutodetect: vi.fn(async () => ({ detected: false, sourceApp: null })),
  createMeeting: vi.fn(),
  startMeetingCapture: vi.fn(),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  getUpcomingEvents: vi.fn(async () => ({
    events: [],
    status: "connected" as const,
  })),
  setTrayRecording: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  meetingLifecycleTick: m.meetingLifecycleTick,
  meetingLifecycleNoteManualStop: m.meetingLifecycleNoteManualStop,
  meetingLifecycleNoteCaptureStarted: m.meetingLifecycleNoteCaptureStarted,
  meetingLifecycleNoteStartFailed: m.meetingLifecycleNoteStartFailed,
  meetingAutodetect: m.meetingAutodetect,
  createMeeting: m.createMeeting,
  startMeetingCapture: m.startMeetingCapture,
  listMeetings: m.listMeetings,
}));
vi.mock("@/services/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/calendar")>()),
  getUpcomingEvents: m.getUpcomingEvents,
}));
vi.mock("@/services/transcript-search", () => ({
  backfillTranscriptIndex: vi.fn(),
  deleteMeetingIndex: vi.fn(),
  indexMeeting: vi.fn(async () => {}),
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: vi.fn() }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: m.setTrayRecording,
  onTrayToggleCapture: vi.fn(() => () => {}),
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) =>
      key === "meetingAutoDetectEnabled" || key === "meetingAudioPrimed"
        ? true
        : null,
    set: vi.fn(),
  },
}));
vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    createConversationWithModel: vi.fn(async () => ({ id: "c1" })),
    setActiveConversation: vi.fn(),
  },
}));
vi.mock("@/stores/provider.store", () => ({
  providerStore: { resolvedModel: () => "model", activeModel: "model" },
}));
vi.mock("@/stores/skills.store", () => ({
  skillsStore: { enabledSkills: [] },
}));

import type { Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

const AUTO_DETECT_POLL_MS = 5_000;

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "auto-1",
    title: "Meeting",
    sourceApp: "Teams",
    startedAt: 0,
    endedAt: null,
    status: "pending_capture",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("auto-detect poll re-entrancy (#2814)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.createMeeting.mockResolvedValue(meeting());
    m.listMeetings.mockResolvedValue([]);
    m.meetingLifecycleTick.mockResolvedValue({
      kind: "start_capture",
      sourceApp: "Teams",
    });
  });

  it("skips ticks while a capture start is in flight, never orphaning meetings or faking a manual stop", async () => {
    vi.useFakeTimers();
    // startAutoDetect drives the poll off window.setInterval; in the node test
    // env, point window at globalThis so it resolves to the fake-timer globals.
    const hadWindow = "window" in globalThis;
    if (!hadWindow) {
      (globalThis as { window?: typeof globalThis }).window = globalThis;
    }
    // The auto-started capture parks on native mic init: startMeetingCapture stays
    // pending for the whole window, exactly like the ~4-minute block in the report.
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    m.startMeetingCapture.mockReturnValue(startGate);

    try {
      // First tick fires synchronously and parks inside requestCaptureStart.
      meetingStore.startAutoDetect();
      await vi.advanceTimersByTimeAsync(1);

      // Three more interval ticks fire while the start is still in flight.
      await vi.advanceTimersByTimeAsync(AUTO_DETECT_POLL_MS * 3);

      // Exactly one capture was created and started; the overlapping ticks were
      // skipped rather than churning new pending_capture rows.
      expect(m.createMeeting).toHaveBeenCalledTimes(1);
      expect(m.startMeetingCapture).toHaveBeenCalledTimes(1);
      // The in-flight start must never be mistaken for a manual stop.
      expect(m.meetingLifecycleNoteManualStop).not.toHaveBeenCalled();
    } finally {
      releaseStart();
      await vi.advanceTimersByTimeAsync(1);
      meetingStore.stopAutoDetect();
      vi.useRealTimers();
      if (!hadWindow) {
        (globalThis as { window?: typeof globalThis }).window = undefined;
      }
    }
  });
});
