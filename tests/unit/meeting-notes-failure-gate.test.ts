// ABOUTME: Regression test for #2159 — a notes-generation failure (or empty transcript) must not trigger agent handoff.
// ABOUTME: Otherwise the meeting stays `transcribing` and a skill auto-runs on an empty prompt.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  generateMeetingNotes: vi.fn(async () => ({
    markdown: "notes",
    structured: { summary: "s", actionItems: [], fields: {} },
  })),
  getMeetingTranscriptText: vi.fn(async () => "hello transcript"),
  getTranscriptSegments: vi.fn(async () => []),
  selectMeetingSkills: vi.fn(async () => ["s"]),
  setMeetingRoutedSkill: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async (): Promise<unknown> => null),
  listMeetingTemplates: vi.fn(async () => []),
  orchestrate: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  updateMeetingStatus: m.updateMeetingStatus,
  listMeetings: m.listMeetings,
  generateMeetingNotes: m.generateMeetingNotes,
  getMeetingTranscriptText: m.getMeetingTranscriptText,
  getTranscriptSegments: m.getTranscriptSegments,
  selectMeetingSkills: m.selectMeetingSkills,
  setMeetingRoutedSkill: m.setMeetingRoutedSkill,
  stopMeetingCapture: m.stopMeetingCapture,
  listMeetingTemplates: m.listMeetingTemplates,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: m.orchestrate }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: vi.fn(),
  onTrayToggleCapture: vi.fn(() => () => {}),
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
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) =>
      key === "meetingCustomTemplates" || key === "voiceCustomVocabulary"
        ? []
        : undefined,
    set: vi.fn(),
  },
}));
vi.mock("@/stores/skills.store", () => ({
  skillsStore: {
    enabledSkills: [
      { slug: "s", name: "S", description: "", tags: ["meeting"], path: "/p" },
    ],
  },
}));

import type { Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "Sync",
    sourceApp: "Manual",
    startedAt: 0,
    endedAt: 100,
    status: "transcribing",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("meetingStore notes-failure gates handoff (#2159 / #2227)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.listMeetings.mockResolvedValue([meeting()]);
    m.getMeetingTranscriptText.mockResolvedValue("hello transcript");
  });

  it("keeps a transcripted meeting usable and skips handoff when notes generation throws", async () => {
    m.generateMeetingNotes.mockRejectedValueOnce(
      new Error("chat completion returned no content"),
    );

    await meetingStore.stopAndProcess(meeting());

    expect(m.updateMeetingStatus).toHaveBeenCalledWith(
      "m1",
      "transcript_ready",
      null,
      expect.stringContaining("Meeting notes could not be generated"),
    );
    // No handoff: the skill router and agent run must never fire.
    expect(m.selectMeetingSkills).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("still marks failed when notes generation fails because no transcript exists", async () => {
    m.generateMeetingNotes.mockRejectedValueOnce(
      new Error("no transcript to summarize"),
    );
    m.getMeetingTranscriptText.mockResolvedValueOnce("   ");

    await meetingStore.stopAndProcess(meeting());

    expect(m.updateMeetingStatus).toHaveBeenCalledWith(
      "m1",
      "failed",
      expect.any(Number),
      expect.stringContaining("No transcript was captured"),
    );
    expect(m.selectMeetingSkills).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("marks failed and skips notes when capture stop reports no transcript output", async () => {
    m.stopMeetingCapture.mockResolvedValueOnce({
      hadCapture: true,
      pushFrameCount: 0,
      acceptedPushFrameCount: 0,
      droppedPushFrameCount: 0,
      droppedPushSampleCount: 0,
      frameCount: 0,
      sampleCount: 0,
      speechFrameCount: 0,
      chunkCount: 0,
      emittedSegmentCount: 0,
      emittedGapCount: 0,
      persistedSegmentCount: 0,
      persistedTextSegmentCount: 0,
      nativeMicReady: true,
      systemAudioReady: false,
      apmReady: true,
      apmActive: true,
      nativeMicFrameCount: 0,
      systemAudioFrameCount: 0,
      levelEventCount: 0,
      apm: {
        initialized: true,
        active: true,
        renderFrameCount: 0,
        captureFrameCount: 0,
        processedSampleCount: 0,
        lastError: null,
      },
      captureDiagnosticsJson: "{}",
      failureReason:
        "No audio reached Meeting capture. Check microphone and system-audio permissions, then start capture again.",
    });

    await meetingStore.stopAndProcess(meeting());

    expect(m.generateMeetingNotes).not.toHaveBeenCalled();
    expect(m.updateMeetingStatus).toHaveBeenCalledWith(
      "m1",
      "failed",
      null,
      expect.stringContaining("No audio reached Meeting capture"),
    );
    expect(m.selectMeetingSkills).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("does not hand off when the transcript is empty", async () => {
    m.getMeetingTranscriptText.mockResolvedValue("   ");

    await meetingStore.stopAndProcess(meeting());

    expect(m.selectMeetingSkills).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
  });
});
