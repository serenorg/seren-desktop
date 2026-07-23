// ABOUTME: Integration-style tests for memory service write/read flow.
// ABOUTME: Verifies memory writes use valid types and reads return expected results.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeMock,
  authStoreMock,
  projectStoreMock,
  memoryEnabledState,
  settingsGetMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  authStoreMock: {
    isAuthenticated: true,
    user: { id: "user-1", email: "user@example.com", name: "User" },
  },
  projectStoreMock: {
    activeProject: { id: "project-1" },
  },
  memoryEnabledState: {
    enabled: true as boolean,
  },
  settingsGetMock: vi.fn((key: string): boolean | undefined =>
    key === "memoryEnabled" ? true : undefined,
  ),
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

settingsGetMock.mockImplementation((key: string) => {
  if (key === "memoryEnabled") {
    return memoryEnabledState.enabled;
  }
  return undefined;
});

import {
  deleteMemory,
  MEMORY_TOOL_NAMES,
  processAssistantResponseMemory,
  recallMemories,
  rememberMemory,
  storeAssistantResponse,
  syncMemories,
} from "@/services/memory";

describe("memory service integration path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryEnabledState.enabled = true;
    authStoreMock.isAuthenticated = true;
    authStoreMock.user = { id: "user-1", email: "user@example.com", name: "User" };
    projectStoreMock.activeProject = { id: "project-1" };
  });

  it("skips sync when the authenticated state has no user id", async () => {
    authStoreMock.user = { id: "", email: "user@example.com", name: "User" };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(syncMemories()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      "[Memory] Skipping sync: no authenticated user id",
    );

    warning.mockRestore();
  });

  it("writes then reads memory with project context", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "memory_remember") {
        return "memory-write-ok";
      }
      if (command === "memory_recall") {
        return [
          {
            content: "marker memory",
            memory_type: "semantic",
            relevance_score: 0.99,
          },
        ];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const writeResult = await rememberMemory("marker memory");
    const recalled = await recallMemories("marker", 3);

    expect(writeResult).toBe("memory-write-ok");
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toBe("marker memory");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "memory_remember", {
      content: "marker memory",
      memoryType: "semantic",
      projectId: "project-1",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(2, "memory_recall", {
      query: "marker",
      projectId: "project-1",
      limit: 3,
    });
  });

  it("exposes the full live Seren Memory MCP surface", () => {
    expect(MEMORY_TOOL_NAMES).toEqual([
      "session_bootstrap",
      "remember",
      "create_memory",
      "recall",
      "process_conversation",
      "learn_from_error",
      "list_memories",
      "get_memory",
      "update_memory",
      "forget",
      "delete_memory",
      "get_memory_graph",
      "memory_timeline",
      "consolidate",
      "configure_publishers",
    ]);
  });

  it("processes assistant responses through structured conversation extraction", async () => {
    invokeMock.mockResolvedValue({
      extracted_count: 2,
      memories: [
        {
          id: "mem-1",
          memory_type: "preference",
          summary: "Prefers narrow TDD coverage.",
        },
      ],
    });

    await storeAssistantResponse("Answer", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
      sourceExternalId: "desktop:test:message-1",
      sourceRevision: "1",
      sourceUri: "seren://desktop/conversations/test/messages/message-1",
    });

    expect(invokeMock).toHaveBeenCalledWith("memory_process_conversation", {
      transcript:
        "User: Question\n\nAssistant: Answer\n\nMetadata:\nModel: anthropic/claude-sonnet-4",
      projectId: "project-1",
      sessionId: undefined,
      orgId: undefined,
      projectContext: undefined,
      retainSource: false,
      sourceExternalId: "desktop:test:message-1",
      sourceRevision: "1",
      sourceUri: "seren://desktop/conversations/test/messages/message-1",
    });
  });

  it("extracts without retaining a source when no stable ID is available", async () => {
    invokeMock.mockResolvedValue({ extracted_count: 0 });

    await storeAssistantResponse("Answer", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "memory_process_conversation",
      expect.objectContaining({
        retainSource: false,
        sourceExternalId: undefined,
      }),
    );
  });

  it("does not write empty assistant responses", async () => {
    await storeAssistantResponse("   ", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("returns structured capture metadata for answer-level UI", async () => {
    invokeMock.mockResolvedValue({
      memories: [
        {
          id: "mem-1",
          memory_type: "preference",
          summary: "Prefers concise answers.",
          confidence: 0.91,
          source: { session_id: "session-1" },
        },
      ],
    });

    const result = await processAssistantResponseMemory("Short answer", {
      userQuery: "Please be concise",
    });

    expect(result?.messageMemory?.captured).toEqual([
      expect.objectContaining({
        id: "mem-1",
        type: "preference",
        summary: "Prefers concise answers.",
        confidence: 0.91,
        source: "session-1",
      }),
    ]);
  });

  it("requires explicit confirmation before permanent delete", async () => {
    await expect(
      deleteMemory("mem-1", { confirm: false }),
    ).rejects.toThrow("Permanent memory delete requires confirmation");

    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValue({ deleted: true });
    await deleteMemory("mem-1", { confirm: true });

    expect(invokeMock).toHaveBeenCalledWith("memory_delete_memory", {
      memoryId: "mem-1",
      confirm: true,
    });
  });
});
