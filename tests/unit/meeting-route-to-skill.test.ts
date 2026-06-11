// ABOUTME: Coverage for #2346 — meetings only hand off to a skill on user action.
// ABOUTME: routeMeetingToSkill is the single entry point; empty transcript / unknown slug abort safely.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getMeetingTranscriptText: vi.fn(async () => "speaker: hello there"),
  selectMeetingSkills: vi.fn(async () => ["glide/affinity-proposals"]),
  setMeetingRoutedSkill: vi.fn(async () => {}),
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  createConversationWithModel: vi.fn(async () => ({ id: "conv-1" })),
  setActiveConversation: vi.fn(),
  orchestrate: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  getMeetingTranscriptText: m.getMeetingTranscriptText,
  selectMeetingSkills: m.selectMeetingSkills,
  setMeetingRoutedSkill: m.setMeetingRoutedSkill,
  updateMeetingStatus: m.updateMeetingStatus,
  listMeetings: m.listMeetings,
}));
vi.mock("@/services/orchestrator", () => ({ orchestrate: m.orchestrate }));
vi.mock("@/services/tray", () => ({
  setTrayRecording: vi.fn(),
  onTrayToggleCapture: vi.fn(() => () => {}),
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: () => undefined,
    set: vi.fn(),
  },
}));
vi.mock("@/stores/conversation.store", () => ({
  conversationStore: {
    createConversationWithModel: m.createConversationWithModel,
    setActiveConversation: m.setActiveConversation,
  },
}));
vi.mock("@/stores/provider.store", () => ({
  providerStore: { resolvedModel: () => "model", activeModel: "model" },
}));
vi.mock("@/stores/skills.store", () => ({
  skillsStore: {
    enabledSkills: [
      {
        slug: "glide/affinity-proposals",
        name: "Glide Affinity Proposals",
        description: "",
        tags: ["meeting"],
        path: "/skills/glide",
      },
    ],
  },
}));

import type { Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "Discovery sync",
    sourceApp: "Manual",
    startedAt: 0,
    endedAt: 100,
    status: "notes_ready",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: "# Notes",
    notesStructJson: null,
    failureReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("meetingStore.routeMeetingToSkill (#2346)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) {
      if ("mockClear" in fn) fn.mockClear();
    }
    m.getMeetingTranscriptText.mockResolvedValue("speaker: hello there");
    meetingStore.clearError();
  });

  it("creates a conversation, marks routed, and orchestrates the chosen skill", async () => {
    await meetingStore.routeMeetingToSkill(
      meeting(),
      "glide/affinity-proposals",
    );

    expect(m.createConversationWithModel).toHaveBeenCalledTimes(1);
    expect(m.setMeetingRoutedSkill).toHaveBeenCalledWith(
      "m1",
      "glide/affinity-proposals",
      "conv-1",
    );
    expect(m.orchestrate).toHaveBeenCalledWith(
      "conv-1",
      expect.stringContaining("Glide Affinity Proposals"),
    );
    expect(m.setActiveConversation).toHaveBeenCalledWith("conv-1");
    expect(m.updateMeetingStatus).toHaveBeenCalledWith("m1", "done");
  });

  it("aborts safely when the transcript is empty", async () => {
    m.getMeetingTranscriptText.mockResolvedValueOnce("");

    await meetingStore.routeMeetingToSkill(
      meeting(),
      "glide/affinity-proposals",
    );

    expect(m.createConversationWithModel).not.toHaveBeenCalled();
    expect(m.setMeetingRoutedSkill).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
    expect(meetingStore.state.error).toMatch(/transcript/i);
  });

  it("aborts safely when the slug is not installed", async () => {
    await meetingStore.routeMeetingToSkill(meeting(), "unknown/skill");

    expect(m.createConversationWithModel).not.toHaveBeenCalled();
    expect(m.setMeetingRoutedSkill).not.toHaveBeenCalled();
    expect(m.orchestrate).not.toHaveBeenCalled();
    expect(meetingStore.state.error).toMatch(/not installed/i);
  });
});
