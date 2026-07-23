// ABOUTME: Verifies verbatim source retention is opt-in at the memory capture choke point.
// ABOUTME: Keeps conversation-level memory exclusion ahead of all memory-service invokes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeMock,
  authStoreMock,
  projectStoreMock,
  sourceRetentionState,
  settingsGetMock,
} = vi.hoisted(() => {
  const sourceRetentionState = { enabled: false };
  return {
    invokeMock: vi.fn(),
    authStoreMock: {
      isAuthenticated: true,
      user: { id: "user-1" },
    },
    projectStoreMock: {
      activeProject: { id: "project-1" },
    },
    sourceRetentionState,
    settingsGetMock: vi.fn((key: string): boolean | undefined => {
      if (key === "memoryEnabled") return true;
      if (key === "sourceRetentionEnabled") {
        return sourceRetentionState.enabled;
      }
      return undefined;
    }),
  };
});

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

import { processAssistantResponseMemory } from "@/services/memory";
import { privacyStore } from "@/stores/privacy.store";

describe("verbatim source retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue({ extracted_count: 0 });
    sourceRetentionState.enabled = false;
    privacyStore.setConversationPrivacy("source-retention-off", {
      excludeMemory: false,
      excludeHistorySync: false,
    });
    privacyStore.setConversationPrivacy("source-retention-on", {
      excludeMemory: false,
      excludeHistorySync: false,
    });
    privacyStore.setConversationPrivacy("source-retention-excluded", {
      excludeMemory: false,
      excludeHistorySync: false,
    });
  });

  it("sends retain_source false when verbatim source retention is off", async () => {
    await processAssistantResponseMemory("Answer", {
      conversationId: "source-retention-off",
      userQuery: "Question",
      sourceExternalId: "desktop:conversation:off",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.objectContaining({
        retainSource: false,
        sourceExternalId: "desktop:conversation:off",
      }),
    );
  });

  it("sends retain_source true when verbatim source retention is enabled", async () => {
    sourceRetentionState.enabled = true;

    await processAssistantResponseMemory("Answer", {
      conversationId: "source-retention-on",
      userQuery: "Question",
      sourceExternalId: "desktop:conversation:on",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.objectContaining({
        retainSource: true,
        sourceExternalId: "desktop:conversation:on",
      }),
    );
  });

  it("does not invoke process_conversation for a memory-excluded conversation", async () => {
    sourceRetentionState.enabled = true;
    privacyStore.setConversationPrivacy("source-retention-excluded", {
      excludeMemory: true,
      excludeHistorySync: false,
    });

    await expect(
      processAssistantResponseMemory("Answer", {
        conversationId: "source-retention-excluded",
        userQuery: "Question",
        sourceExternalId: "desktop:conversation:excluded",
      }),
    ).resolves.toBeNull();

    expect(invokeMock).not.toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.anything(),
    );
  });
});
