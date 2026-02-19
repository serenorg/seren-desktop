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
    enabled: true,
  },
  settingsGetMock: vi.fn((key: string) =>
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
  recallMemories,
  rememberMemory,
  storeAssistantResponse,
} from "@/services/memory";

describe("memory service integration path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryEnabledState.enabled = true;
    authStoreMock.isAuthenticated = true;
    projectStoreMock.activeProject = { id: "project-1" };
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

  it("stores assistant responses as semantic memories", async () => {
    invokeMock.mockResolvedValue("memory-write-ok");

    await storeAssistantResponse("Answer", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
    });

    expect(invokeMock).toHaveBeenCalledWith("memory_remember", {
      content:
        "User: Question\n\nAssistant: Answer\n\nModel: anthropic/claude-sonnet-4",
      memoryType: "semantic",
      projectId: "project-1",
    });
  });

  it("does not write empty assistant responses", async () => {
    await storeAssistantResponse("   ", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
