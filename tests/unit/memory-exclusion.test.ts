// ABOUTME: Verifies excluded conversations stop memory capture at the frontend choke point.
// ABOUTME: Protects the no-capture invariant without calling the memory API.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { processConversationMock, authStoreMock, projectStoreMock, settingsGetMock } =
  vi.hoisted(() => ({
    processConversationMock: vi.fn(),
    authStoreMock: {
      isAuthenticated: true,
      user: { id: "user-1" },
    },
    projectStoreMock: {
      activeProject: { id: "project-1" },
    },
    settingsGetMock: vi.fn((key: string) => key === "memoryEnabled"),
  }));

vi.mock("@/api/seren-memory", () => ({
  processConversation: processConversationMock,
}));

vi.mock("@/stores/auth.store", () => ({
  authStore: authStoreMock,
}));

vi.mock("@/stores/project.store", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: settingsGetMock,
  },
}));

import { processConversationMemory } from "@/services/memory";
import { privacyStore } from "@/stores/privacy.store";

describe("conversation memory exclusions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    privacyStore.setConversationPrivacy("excluded-conversation", {
      excludeMemory: true,
      excludeHistorySync: false,
    });
  });

  it("does not call process_conversation for an excluded conversation", async () => {
    await expect(
      processConversationMemory({
        conversationId: "excluded-conversation",
        transcript: "A private conversation that must not become memory.",
      }),
    ).resolves.toBeNull();

    expect(processConversationMock).not.toHaveBeenCalled();
  });
});
