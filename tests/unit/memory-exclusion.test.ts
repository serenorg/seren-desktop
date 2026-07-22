// ABOUTME: Verifies excluded conversations stop memory capture at the frontend choke point.
// ABOUTME: Protects the no-cache/no-sync invariant without invoking the backend command.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, authStoreMock, projectStoreMock, settingsGetMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    authStoreMock: {
      isAuthenticated: true,
      user: { id: "user-1" },
    },
    projectStoreMock: {
      activeProject: { id: "project-1" },
    },
    settingsGetMock: vi.fn((key: string) => key === "memoryEnabled"),
  }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
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

  it("does not invoke memory_process_conversation for an excluded conversation", async () => {
    await expect(
      processConversationMemory({
        conversationId: "excluded-conversation",
        transcript: "A private conversation that must not become memory.",
      }),
    ).resolves.toBeNull();

    expect(invokeMock).not.toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.anything(),
    );
  });
});
