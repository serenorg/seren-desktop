// ABOUTME: Verifies Privileged Matter Mode composes the existing local egress exclusions.
// ABOUTME: Ensures a privileged conversation never reaches memory capture.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, setConversationPrivilegedMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setConversationPrivilegedMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => false,
  setConversationPrivileged: setConversationPrivilegedMock,
}));

vi.mock("@/stores/auth.store", () => ({
  authStore: { isAuthenticated: true, user: { id: "user-1" } },
}));

vi.mock("@/stores/project.store", () => ({
  projectStore: { activeProject: { id: "project-1" } },
}));

vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) =>
      key === "memoryEnabled" || key === "sourceRetentionEnabled",
  },
}));

import { processAssistantResponseMemory } from "@/services/memory";
import { privacyStore } from "@/stores/privacy.store";

describe("Privileged Matter Mode", () => {
  const conversationId = "privileged-matter-mode-test";

  beforeEach(() => {
    vi.clearAllMocks();
    privacyStore.setConversationPrivacy(conversationId, {
      excludeMemory: false,
      excludeHistorySync: false,
      privileged: true,
      counselDirection: "Counsel-directed analysis",
    });
  });

  it("makes privileged conversations memory and history-sync excluded", () => {
    expect(privacyStore.isPrivileged(conversationId)).toBe(true);
    expect(privacyStore.isMemoryExcluded(conversationId)).toBe(true);
    expect(privacyStore.isHistorySyncExcluded(conversationId)).toBe(true);
    expect(privacyStore.excludedHistorySyncIds()).toContain(conversationId);
  });

  it("honors the durable database privilege flag before privacy settings reload", () => {
    const restoredConversationId = "privileged-matter-restored-test";
    privacyStore.hydrateConversationPrivilege(
      restoredConversationId,
      true,
      "Counsel-directed analysis",
    );

    expect(privacyStore.isPrivileged(restoredConversationId)).toBe(true);
    expect(privacyStore.isMemoryExcluded(restoredConversationId)).toBe(true);
    expect(privacyStore.isHistorySyncExcluded(restoredConversationId)).toBe(
      true,
    );
  });

  it("does not invoke process_conversation for a privileged conversation", async () => {
    await expect(
      processAssistantResponseMemory("Privileged response", {
        conversationId,
        userQuery: "Privileged prompt",
        sourceExternalId: "desktop:conversation:privileged",
      }),
    ).resolves.toBeNull();

    expect(invokeMock).not.toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.anything(),
    );
  });
});
