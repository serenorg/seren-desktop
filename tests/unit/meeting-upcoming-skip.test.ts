// ABOUTME: Regression coverage for skipped calendar events hijacking later auto-record titles.
// ABOUTME: Skipped upcoming entries must disappear from UI state and from auto-match.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  set: vi.fn((key: string, value: unknown) => {
    settings.values.set(key, value);
  }),
}));

const m = vi.hoisted(() => ({
  createMeeting: vi.fn(async (input: Record<string, unknown>) => ({
    id: "created",
    title: input.title,
    sourceApp: input.sourceApp ?? null,
    startedAt: Date.now(),
    endedAt: null,
    status: "pending_capture",
    templateId: input.templateId ?? null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    failureReason: null,
    triggerSource: input.triggerSource ?? null,
    calendarEventId: input.calendarEventId ?? null,
    calendarProvider: input.calendarProvider ?? null,
    attendeesJson: input.attendeesJson ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })),
  getUpcomingEvents: vi.fn(async (): Promise<unknown> => ({
    status: "connected",
    events: [],
  })),
  getTranscriptSegments: vi.fn(async () => []),
  listMeetings: vi.fn(async () => []),
  meetingAutodetect: vi.fn(async (): Promise<unknown> => ({
    detected: false,
    sourceApp: null,
  })),
  meetingLifecycleNoteCaptureStarted: vi.fn(async () => {}),
  meetingLifecycleNoteManualStop: vi.fn(async () => {}),
  meetingLifecycleNoteStartFailed: vi.fn(async () => {}),
  meetingLifecycleTick: vi.fn(async (): Promise<unknown> => null),
  setTrayRecording: vi.fn(),
  startMeetingCapture: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/calendar")>()),
  getUpcomingEvents: m.getUpcomingEvents,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  createMeeting: m.createMeeting,
  getTranscriptSegments: m.getTranscriptSegments,
  listMeetings: m.listMeetings,
  meetingAutodetect: m.meetingAutodetect,
  meetingLifecycleNoteCaptureStarted: m.meetingLifecycleNoteCaptureStarted,
  meetingLifecycleNoteManualStop: m.meetingLifecycleNoteManualStop,
  meetingLifecycleNoteStartFailed: m.meetingLifecycleNoteStartFailed,
  meetingLifecycleTick: m.meetingLifecycleTick,
  startMeetingCapture: m.startMeetingCapture,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: vi.fn() }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: m.setTrayRecording,
  onTrayToggleCapture: vi.fn(() => () => {}),
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) => settings.values.get(key),
    set: settings.set,
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

import type { CalendarEvent } from "@/services/calendar";
import { meetingStore } from "@/stores/meeting.store";

async function flushPoll(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("meeting upcoming calendar skip", () => {
  const now = Date.parse("2026-06-30T10:00:00-07:00");
  const peterEvent: CalendarEvent = {
    id: "peter",
    title: "2026 Tues Meetings w/ Peter Bernhardt",
    startMs: now - 5 * 60_000,
    endMs: now + 25 * 60_000,
    attendees: ["Peter Bernhardt"],
    meetingUrl: "https://us02web.zoom.us/j/123",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    settings.values.clear();
    settings.values.set("meetingAutoDetectEnabled", true);
    settings.values.set("meetingAudioPrimed", true);
    settings.values.set("meetingCustomTemplates", []);
    settings.values.set("meetingSkippedCalendarEvents", []);
    settings.set.mockClear();
    for (const fn of Object.values(m)) fn.mockClear();
    m.getUpcomingEvents.mockResolvedValue({
      status: "connected",
      events: [peterEvent],
    });
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

  it("removes a skipped event from Upcoming and excludes it from auto-match", async () => {
    meetingStore.startAutoDetect();
    await flushPoll();

    expect(meetingStore.state.upcomingEvents.map((event) => event.id)).toEqual([
      "peter",
    ]);

    meetingStore.skipUpcomingEvent(peterEvent);

    expect(meetingStore.state.upcomingEvents).toEqual([]);
    expect(settings.values.get("meetingSkippedCalendarEvents")).toEqual([
      { id: "peter", untilMs: peterEvent.endMs },
    ]);

    m.meetingLifecycleTick.mockResolvedValueOnce({
      kind: "start_capture",
      sourceApp: "Zoom",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPoll();

    expect(m.createMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarEventId: null,
        title: expect.not.stringContaining("Peter Bernhardt"),
      }),
    );
    expect(m.meetingLifecycleNoteCaptureStarted).toHaveBeenCalledWith(true);
  });
});
