// ABOUTME: Regression coverage for #2225 — native capture startup failures stay visible.
// ABOUTME: Rust persists the failed row; the renderer surfaces it without overwriting diagnostics.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  startMeetingCapture: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async () => {}),
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  getTranscriptSegments: vi.fn(async () => []),
  setTrayRecording: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  startMeetingCapture: m.startMeetingCapture,
  stopMeetingCapture: m.stopMeetingCapture,
  updateMeetingStatus: m.updateMeetingStatus,
  listMeetings: m.listMeetings,
  getTranscriptSegments: m.getTranscriptSegments,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: vi.fn() }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: m.setTrayRecording,
  onTrayToggleCapture: vi.fn(() => () => {}),
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
    title: "Sync",
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

describe("meetingStore capture startup failure visibility (#2209)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.startMeetingCapture.mockResolvedValue(undefined);
    m.startMeetingCapture.mockRejectedValueOnce(
      "native microphone capture unavailable: microphone permission denied",
    );
    m.listMeetings.mockResolvedValue([
      meeting({
        status: "failed",
        failureReason:
          "native microphone capture unavailable: microphone permission denied",
      }),
    ]);
    meetingStore.clearError();
  });

  it("surfaces backend mic startup failure without rewriting the persisted row", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await meetingStore.requestCaptureStart(meeting());

    expect(m.startMeetingCapture).toHaveBeenCalledWith("m1");
    expect(m.stopMeetingCapture).not.toHaveBeenCalled();
    expect(m.updateMeetingStatus).not.toHaveBeenCalled();
    expect(m.setTrayRecording).toHaveBeenCalledWith(false);
    expect(meetingStore.state.error).toContain("Microphone access is blocked");
    expect(consoleInfo).toHaveBeenCalledWith(
      "[meeting] capture start requested",
      { meetingId: "m1" },
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[meeting] capture startup failed",
      expect.objectContaining({ meetingId: "m1" }),
      expect.any(String),
    );

    consoleError.mockRestore();
    consoleInfo.mockRestore();
  });

  it("surfaces native system-audio startup failures as system-audio errors", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    m.startMeetingCapture.mockReset();
    m.startMeetingCapture.mockRejectedValueOnce(
      "system-audio capture unavailable: audio capture permission denied: AudioHardwareCreateProcessTap failed",
    );
    m.listMeetings.mockResolvedValue([
      meeting({
        status: "failed",
        failureReason:
          "System audio capture could not start. Allow system-audio recording for Seren and make sure an output device is available, then start capture again.",
      }),
    ]);

    await meetingStore.requestCaptureStart(meeting());

    expect(m.startMeetingCapture).toHaveBeenCalledWith("m1");
    expect(m.stopMeetingCapture).not.toHaveBeenCalled();
    expect(m.updateMeetingStatus).not.toHaveBeenCalled();
    expect(meetingStore.state.error).toContain(
      "System audio capture could not start",
    );

    consoleError.mockRestore();
    consoleInfo.mockRestore();
  });
});
