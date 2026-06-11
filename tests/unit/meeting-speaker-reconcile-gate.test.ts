// ABOUTME: Regression test for #2186 — post-call speaker reconciliation must be opt-in.
// ABOUTME: The pass re-transcribes Them audio, so default-off avoids unused 2x cost.

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
  selectMeetingSkills: vi.fn(async () => []),
  setMeetingRoutedSkill: vi.fn(async () => {}),
  stopMeetingCapture: vi.fn(async () => {}),
  listMeetingTemplates: vi.fn(async () => []),
  reconcileMeetingSpeakers: vi.fn(async () => 1),
  settings: {
    meetingStableSpeakers: false,
  },
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
  reconcileMeetingSpeakers: m.reconcileMeetingSpeakers,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: vi.fn() }));
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
    get: (key: string) => {
      if (key === "meetingCustomTemplates" || key === "voiceCustomVocabulary") {
        return [];
      }
      if (key === "meetingStableSpeakers") {
        return m.settings.meetingStableSpeakers;
      }
      return undefined;
    },
    set: vi.fn(),
  },
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
    endedAt: 100,
    status: "capturing",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: "notes",
    notesStructJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("meetingStore post-call speaker reconciliation gate (#2186)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) {
      if (typeof fn === "function") fn.mockClear();
    }
    m.settings.meetingStableSpeakers = false;
    m.listMeetings.mockResolvedValue([meeting()]);
  });

  it("skips post-call speaker reconciliation by default", async () => {
    await meetingStore.stopAndProcess(meeting());

    expect(m.generateMeetingNotes).toHaveBeenCalledTimes(1);
    expect(m.reconcileMeetingSpeakers).not.toHaveBeenCalled();
  });

  it("runs post-call speaker reconciliation when explicitly enabled", async () => {
    m.settings.meetingStableSpeakers = true;

    await meetingStore.stopAndProcess(meeting());

    expect(m.reconcileMeetingSpeakers).toHaveBeenCalledWith("m1");
  });
});
