// ABOUTME: Regression test for #2159 — a notes-generation failure (or empty transcript) must not trigger agent handoff.
// ABOUTME: Otherwise the meeting stays `transcribing` and a skill auto-runs on an empty prompt.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async () => []),
  generateMeetingNotes: vi.fn(async () => ({
    markdown: "notes",
    structured: { summary: "s", actionItems: [], fields: {} },
  })),
  getMeetingTranscriptText: vi.fn(async () => "hello transcript"),
  getTranscriptSegments: vi.fn(async () => []),
  selectMeetingSkills: vi.fn(async () => ["s"]),
  setMeetingRoutedSkill: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async () => {}),
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
vi.mock("@/services/captureWidget", () => ({
  closeCaptureWidget: vi.fn(),
  openCaptureWidget: vi.fn(),
  onWidgetStopRequest: vi.fn(() => () => {}),
}));
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

describe("meetingStore notes-failure gates handoff (#2159)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.listMeetings.mockResolvedValue([meeting()]);
    m.getMeetingTranscriptText.mockResolvedValue("hello transcript");
  });

  it("marks failed and skips handoff when notes generation throws", async () => {
    m.generateMeetingNotes.mockRejectedValueOnce(new Error("notes boom"));

    await meetingStore.stopAndProcess(meeting());

    expect(m.updateMeetingStatus).toHaveBeenCalledWith(
      "m1",
      "failed",
      expect.any(Number),
    );
    // No handoff: the skill router and agent run must never fire.
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
