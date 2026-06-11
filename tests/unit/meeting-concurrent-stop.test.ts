// ABOUTME: Regression test for #2162 — concurrent stop sources must not double-run notes generation.
// ABOUTME: Two near-simultaneous stops (tray/panel) for one meeting should process it once. Routing is user-triggered (#2346).

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

describe("meetingStore concurrent stop guard (#2162)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockClear();
    m.listMeetings.mockResolvedValue([meeting()]);
  });

  it("processes a meeting once when two stops fire near-simultaneously", async () => {
    // Two stop sources race for the same meeting (e.g. tray relay + panel).
    await Promise.all([
      meetingStore.stopAndProcess(meeting()),
      meetingStore.stopAndProcess(meeting()),
    ]);

    expect(m.generateMeetingNotes).toHaveBeenCalledTimes(1);
    // Routing is now user-triggered, so a stop does not invoke the agent (#2346).
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("allows a fresh stop after the first one finishes", async () => {
    await meetingStore.stopAndProcess(meeting());
    await meetingStore.stopAndProcess(meeting());

    expect(m.generateMeetingNotes).toHaveBeenCalledTimes(2);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });
});
