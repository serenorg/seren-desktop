// ABOUTME: Regression test for #2158 — a handed-off meeting must reach done/failed, not sit at agent_running forever.
// ABOUTME: Drives the real stopAndProcess -> runHandoff flow with the agent run mocked.

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

describe("meetingStore handoff terminal status (#2158)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.listMeetings.mockResolvedValue([meeting()]);
  });

  it("sets done after the agent run resolves", async () => {
    m.orchestrate.mockResolvedValueOnce(undefined);

    await meetingStore.stopAndProcess(meeting());

    expect(m.orchestrate).toHaveBeenCalledTimes(1);
    // Terminal transition carries no ended_at so the capture-end time survives (#2174).
    expect(m.updateMeetingStatus).toHaveBeenCalledWith("m1", "done");
  });

  it("sets failed when the agent run rejects", async () => {
    m.orchestrate.mockRejectedValueOnce(new Error("boom"));

    await meetingStore.stopAndProcess(meeting());

    expect(m.updateMeetingStatus).toHaveBeenCalledWith("m1", "failed");
    expect(m.updateMeetingStatus).not.toHaveBeenCalledWith("m1", "done");
  });
});
