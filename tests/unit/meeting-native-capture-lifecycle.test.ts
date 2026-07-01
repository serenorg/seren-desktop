// ABOUTME: Regression coverage for #2225 native Meeting Mode capture ownership.
// ABOUTME: The WebView may control lifecycle, but it must not own production mic frames.

import { beforeEach, describe, expect, it, vi } from "vitest";

const eventBus = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

const tray = vi.hoisted(() => ({
  handler: null as (() => void) | null,
}));

const m = vi.hoisted(() => ({
  createMeeting: vi.fn(async (): Promise<Meeting> => ({
    id: "created-from-tray",
    title: "Tray",
    sourceApp: "Tray",
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
  })),
  startMeetingCapture: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async () => ({
    hadCapture: true,
    pushFrameCount: 0,
    acceptedPushFrameCount: 0,
    droppedPushFrameCount: 0,
    droppedPushSampleCount: 0,
    frameCount: 10,
    sampleCount: 1600,
    speechFrameCount: 8,
    chunkCount: 1,
    emittedSegmentCount: 1,
    emittedGapCount: 0,
    persistedSegmentCount: 1,
    persistedTextSegmentCount: 1,
    nativeMicReady: true,
    systemAudioReady: false,
    apmReady: true,
    apmActive: true,
    nativeMicFrameCount: 10,
    systemAudioFrameCount: 0,
    levelEventCount: 1,
    apm: {
      initialized: true,
      active: true,
      renderFrameCount: 0,
      captureFrameCount: 10,
      processedSampleCount: 1600,
      lastError: null,
    },
    captureDiagnosticsJson: "{}",
    failureReason: null,
  })),
  meetingLifecycleNoteCaptureStarted: vi.fn(async () => {}),
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  getTranscriptSegments: vi.fn(async () => []),
  isMeetingCaptureActive: vi.fn(async () => false),
  setTrayRecording: vi.fn(),
  onTrayToggleCapture: vi.fn((handler: () => void) => {
    tray.handler = handler;
    return () => {
      tray.handler = null;
    };
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      eventBus.listeners.set(event, handler);
      return () => eventBus.listeners.delete(event);
    },
  ),
}));
vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  createMeeting: m.createMeeting,
  startMeetingCapture: m.startMeetingCapture,
  stopMeetingCapture: m.stopMeetingCapture,
  meetingLifecycleNoteCaptureStarted: m.meetingLifecycleNoteCaptureStarted,
  updateMeetingStatus: m.updateMeetingStatus,
  listMeetings: m.listMeetings,
  getTranscriptSegments: m.getTranscriptSegments,
  isMeetingCaptureActive: m.isMeetingCaptureActive,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: vi.fn() }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: m.setTrayRecording,
  onTrayToggleCapture: m.onTrayToggleCapture,
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) => key === "meetingAudioPrimed",
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

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "Native capture",
    sourceApp: "Manual",
    startedAt: 0,
    endedAt: null,
    status: "capturing",
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

describe("meetingStore native capture lifecycle (#2225)", () => {
  beforeEach(async () => {
    for (const fn of Object.values(m)) fn.mockClear();
    eventBus.listeners.clear();
    tray.handler = null;
    m.listMeetings.mockResolvedValue([]);
    m.isMeetingCaptureActive.mockResolvedValue(false);
    await meetingStore.loadMeetings();
    await meetingStore.setActiveMeeting(null);
    meetingStore.clearError();
  });

  it("starts capture through Rust and the tray indicator only", async () => {
    m.listMeetings.mockResolvedValue([meeting()]);

    await meetingStore.requestCaptureStart(meeting());

    expect(m.startMeetingCapture).toHaveBeenCalledWith("m1");
    expect(m.meetingLifecycleNoteCaptureStarted).toHaveBeenCalledWith(false);
    expect(m.setTrayRecording).toHaveBeenCalledWith(true);
  });

  it("does not block its own pending row during backend startup", async () => {
    m.listMeetings.mockResolvedValue([meeting({ status: "pending_capture" })]);
    await meetingStore.loadMeetings();

    await meetingStore.requestCaptureStart(meeting({ status: "pending_capture" }));

    expect(m.startMeetingCapture).toHaveBeenCalledWith("m1");
  });

  it("updates captureLevel from backend level events", async () => {
    await meetingStore.startMeetingEventListeners();
    await meetingStore.setActiveMeeting(meeting());

    eventBus.listeners.get("meeting://capture-level")?.({
      payload: { meetingId: "m1", speaker: "me", level: 0.42 },
    });

    expect(meetingStore.state.captureLevel).toBe(0.42);
    meetingStore.stopMeetingEventListeners();
  });

  it("reattaches to a live backend capture during startup reconcile", async () => {
    m.listMeetings.mockResolvedValue([meeting({ id: "active" })]);
    m.isMeetingCaptureActive.mockResolvedValue(true);

    await meetingStore.reconcileStaleCaptures();

    expect(m.isMeetingCaptureActive).toHaveBeenCalledWith("active");
    expect(m.setTrayRecording).toHaveBeenCalledWith(true);
    expect(m.meetingLifecycleNoteCaptureStarted).toHaveBeenCalledWith(false);
    expect(m.updateMeetingStatus).not.toHaveBeenCalledWith(
      "active",
      "failed",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not create a second meeting from the tray while startup is pending", async () => {
    m.listMeetings.mockResolvedValue([meeting({ status: "pending_capture" })]);

    await meetingStore.loadMeetings();
    await meetingStore.startMeetingEventListeners();
    tray.handler?.();

    expect(m.createMeeting).not.toHaveBeenCalled();
    expect(m.startMeetingCapture).not.toHaveBeenCalled();
    meetingStore.stopMeetingEventListeners();
  });
});
