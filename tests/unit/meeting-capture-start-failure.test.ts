// ABOUTME: Regression coverage for #2209 — capture startup failures must be loud and persistent.
// ABOUTME: A mic/WebAudio failure should not leave only a silent Failed row.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  startMeetingCapture: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async () => {}),
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  getTranscriptSegments: vi.fn(async () => []),
  startMeetingMicCapture: vi.fn(async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  }),
  closeCaptureWidget: vi.fn(),
  openCaptureWidget: vi.fn(),
  setTrayRecording: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/lib/audio/meetingCapture", () => ({
  startMeetingMicCapture: m.startMeetingMicCapture,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  startMeetingCapture: m.startMeetingCapture,
  stopMeetingCapture: m.stopMeetingCapture,
  updateMeetingStatus: m.updateMeetingStatus,
  listMeetings: m.listMeetings,
  getTranscriptSegments: m.getTranscriptSegments,
}));
vi.mock("@/services/captureWidget", () => ({
  closeCaptureWidget: m.closeCaptureWidget,
  openCaptureWidget: m.openCaptureWidget,
  onWidgetStopRequest: vi.fn(() => () => {}),
}));
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
    m.startMeetingMicCapture.mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    m.listMeetings.mockResolvedValue([
      meeting({
        status: "failed",
        failureReason:
          "Microphone access is blocked. Allow microphone access for Seren, then start capture again.",
      }),
    ]);
    meetingStore.clearError();
  });

  it("marks the meeting failed with an actionable reason and logs the startup error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await meetingStore.requestCaptureStart(meeting());

    expect(m.startMeetingCapture).toHaveBeenCalledWith("m1");
    expect(m.stopMeetingCapture).toHaveBeenCalledWith("m1");
    expect(m.updateMeetingStatus).toHaveBeenCalledWith(
      "m1",
      "failed",
      expect.any(Number),
      expect.stringContaining("Microphone access is blocked"),
    );
    expect(m.openCaptureWidget).not.toHaveBeenCalled();
    expect(m.closeCaptureWidget).toHaveBeenCalled();
    expect(m.setTrayRecording).toHaveBeenCalledWith(false);
    expect(meetingStore.state.error).toContain("Microphone access is blocked");
    expect(consoleInfo).toHaveBeenCalledWith(
      "[meeting] capture start requested",
      { meetingId: "m1" },
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[meeting] capture startup failed",
      expect.objectContaining({ meetingId: "m1" }),
      expect.any(DOMException),
    );

    consoleError.mockRestore();
    consoleInfo.mockRestore();
  });
});
