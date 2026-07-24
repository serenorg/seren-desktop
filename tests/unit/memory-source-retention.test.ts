// ABOUTME: Verifies verbatim source retention is opt-in at the memory capture choke point.
// ABOUTME: Keeps conversation-level memory exclusion ahead of all memory API calls.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  processConversationMock,
  authStoreMock,
  projectStoreMock,
  sourceRetentionState,
  settingsGetMock,
} = vi.hoisted(() => {
  const sourceRetentionState = { enabled: false };
  return {
    processConversationMock: vi.fn(),
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

import {
  conversationSourceUri,
  processAssistantResponseMemory,
} from "@/services/memory";
import { privacyStore } from "@/stores/privacy.store";

describe("conversation source URI", () => {
  // This exact string is the cascade key. The Rust delete path
  // (`conversation_source_uri` in src-tauri/src/commands/chat.rs) rebuilds the
  // identical value to erase a conversation's retained sources; a mismatch means
  // `delete_memories_by_source` matches nothing and transcripts silently survive
  // a delete.
  it("is conversation-level, with no per-message segment", () => {
    expect(conversationSourceUri("abc-123")).toBe(
      "seren://desktop/conversations/abc-123",
    );
    expect(conversationSourceUri("abc-123")).not.toContain("/messages/");
  });
});

describe("verbatim source retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processConversationMock.mockResolvedValue({
      data: { data: {} },
      error: undefined,
    });
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

    expect(processConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          retain_source: false,
          source_external_id: "desktop:conversation:off",
        }),
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

    expect(processConversationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          retain_source: true,
          source_external_id: "desktop:conversation:on",
        }),
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

    expect(processConversationMock).not.toHaveBeenCalled();
  });
});
