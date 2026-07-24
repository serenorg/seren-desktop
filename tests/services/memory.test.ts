// ABOUTME: Integration-style tests for the generated Seren Memory API service.
// ABOUTME: Verifies typed REST writes and reads preserve desktop context.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appendMemoryMock,
  deleteMemoryMock,
  forgetMemoryMock,
  getMemoryMock,
  learnFromErrorMock,
  listMemoriesMock,
  memoryTimelineMock,
  processConversationMock,
  recallMock,
  rememberMock,
  sessionBootstrapMock,
  authStoreMock,
  projectStoreMock,
  memoryEnabledState,
  settingsGetMock,
} = vi.hoisted(() => ({
  appendMemoryMock: vi.fn(),
  deleteMemoryMock: vi.fn(),
  forgetMemoryMock: vi.fn(),
  getMemoryMock: vi.fn(),
  learnFromErrorMock: vi.fn(),
  listMemoriesMock: vi.fn(),
  memoryTimelineMock: vi.fn(),
  processConversationMock: vi.fn(),
  recallMock: vi.fn(),
  rememberMock: vi.fn(),
  sessionBootstrapMock: vi.fn(),
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
  settingsGetMock: vi.fn(),
}));

vi.mock("@/api/seren-memory", () => ({
  appendMemory: appendMemoryMock,
  deleteMemory: deleteMemoryMock,
  forgetMemory: forgetMemoryMock,
  getMemory: getMemoryMock,
  learnFromError: learnFromErrorMock,
  listMemories: listMemoriesMock,
  memoryTimeline: memoryTimelineMock,
  processConversation: processConversationMock,
  recall: recallMock,
  remember: rememberMock,
  sessionBootstrap: sessionBootstrapMock,
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
  appendToMemory,
  bootstrapMemoryContextDetails,
  correctAnswerMemory,
  deleteMemory,
  recallMemories,
  rememberMemory,
  storeAssistantResponse,
  suppressMemoryForAnswer,
} from "@/services/memory";

function apiResult<T>(data: T) {
  return { data: { data }, error: undefined };
}

describe("memory service integration path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryEnabledState.enabled = true;
    authStoreMock.isAuthenticated = true;
    authStoreMock.user = {
      id: "user-1",
      email: "user@example.com",
      name: "User",
    };
    projectStoreMock.activeProject = { id: "project-1" };
    settingsGetMock.mockImplementation((key: string) => {
      if (key === "memoryEnabled") {
        return memoryEnabledState.enabled;
      }
      return undefined;
    });
  });

  it("writes then reads memory with project context", async () => {
    rememberMock.mockResolvedValue(
      apiResult({
        action_taken: "add",
        edges_created: 0,
        enrichments_triggered: 0,
        memory_id: "memory-write-ok",
      }),
    );
    recallMock.mockResolvedValue(
      apiResult({
        memories: [
          {
            id: "memory-write-ok",
            content: "marker memory",
            memory_type: "semantic",
            relevance_score: 0.99,
          },
        ],
        signals: {
          augmenter_hits: 0,
          graph_hits: 0,
          keyword_hits: 1,
          semantic_available: true,
          vector_hits: 1,
        },
      }),
    );

    const writeResult = await rememberMemory("marker memory");
    const recalled = await recallMemories("marker", 3);

    expect(writeResult).toBe("memory-write-ok");
    expect(recalled[0]?.content).toBe("marker memory");
    expect(rememberMock).toHaveBeenCalledWith({
      body: {
        content: "marker memory",
        memory_type: "semantic",
        metadata: undefined,
        pin: undefined,
        project_id: "project-1",
        session_id: undefined,
        skip_conflict_check: undefined,
        skip_enrichment: undefined,
      },
      throwOnError: false,
    });
    expect(recallMock).toHaveBeenCalledWith({
      body: {
        query: "marker",
        project_id: "project-1",
        limit: 3,
      },
      throwOnError: false,
    });
  });

  it("builds prompt context from the typed bootstrap response", async () => {
    sessionBootstrapMock.mockResolvedValue(
      apiResult({
        memories_by_type: {
          preference: ["Prefers concise answers."],
        },
        total_memories: 1,
      }),
    );

    const result = await bootstrapMemoryContextDetails({ tokenBudget: 1200 });

    expect(sessionBootstrapMock).toHaveBeenCalledWith({
      body: {
        project_id: "project-1",
        org_id: undefined,
        token_budget: 1200,
      },
      signal: expect.any(AbortSignal),
      throwOnError: false,
    });
    expect(result).toEqual(
      expect.objectContaining({
        prompt:
          "## Relevant memories\n- [preference] Prefers concise answers.",
        source: "seren-memory",
        totalMemories: 1,
      }),
    );
  });

  it("processes assistant responses through structured conversation extraction", async () => {
    processConversationMock.mockResolvedValue(
      apiResult({
        preferences: [
          {
            content: "Prefers narrow TDD coverage.",
            metadata: {},
          },
        ],
        stored_memory_ids: ["mem-1"],
      }),
    );

    const result = await storeAssistantResponse("Answer", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
      sourceExternalId: "desktop:test:message-1",
      sourceRevision: "1",
      sourceUri: "seren://desktop/conversations/test/messages/message-1",
    });

    expect(processConversationMock).toHaveBeenCalledWith({
      body: {
        transcript:
          "User: Question\n\nAssistant: Answer\n\nMetadata:\nModel: anthropic/claude-sonnet-4",
        project_id: "project-1",
        session_id: undefined,
        org_id: undefined,
        project_context: undefined,
        retain_source: false,
        source_external_id: "desktop:test:message-1",
        source_revision: "1",
        source_uri: "seren://desktop/conversations/test/messages/message-1",
      },
      throwOnError: false,
    });
    expect(result?.messageMemory?.captured).toEqual([
      expect.objectContaining({
        id: "mem-1",
        type: "preference",
        summary: "Prefers narrow TDD coverage.",
      }),
    ]);
  });

  it("does not write empty assistant responses", async () => {
    await storeAssistantResponse("   ", {
      model: "anthropic/claude-sonnet-4",
      userQuery: "Question",
    });

    expect(processConversationMock).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before permanent delete", async () => {
    await expect(
      deleteMemory("mem-1", { confirm: false }),
    ).rejects.toThrow("Permanent memory delete requires confirmation");
    expect(deleteMemoryMock).not.toHaveBeenCalled();

    deleteMemoryMock.mockResolvedValue(apiResult({ deleted: true }));
    await deleteMemory("mem-1", { confirm: true });

    expect(deleteMemoryMock).toHaveBeenCalledWith({
      path: { id: "mem-1" },
      throwOnError: false,
    });
  });

  it("surfaces the service error envelope instead of a bare failure", async () => {
    rememberMock.mockResolvedValue({
      data: undefined,
      error: { error: "validation", message: "content must not be empty" },
    });

    await expect(rememberMemory("marker")).rejects.toThrow(
      "Failed to remember memory: content must not be empty",
    );
  });

  it("labels captured memories only when stored ids cover every extraction", async () => {
    processConversationMock.mockResolvedValue(
      apiResult({
        episodic: [{ content: "Shipped the migration.", metadata: {} }],
        preferences: [{ content: "Prefers pnpm.", metadata: {} }],
        // The engine stores episodic before preference, so a full id list
        // correlates positionally.
        stored_memory_ids: ["mem-episodic", "mem-preference"],
      }),
    );

    const result = await storeAssistantResponse("Answer", {
      userQuery: "Question",
    });

    expect(result?.messageMemory?.captured).toEqual([
      expect.objectContaining({ id: "mem-episodic", type: "episodic" }),
      expect.objectContaining({ id: "mem-preference", type: "preference" }),
    ]);
    expect(result?.extractedCount).toBe(2);
  });

  it("correlates stored ids across every extraction group in engine order", async () => {
    // seren-memory's engine.process_conversation concatenates the groups as
    // episodic, semantic, procedural, error_fix, preference and pushes one
    // stored id per memory in that order. Drift on either side mislabels every
    // captured memory after the first divergence.
    processConversationMock.mockResolvedValue(
      apiResult({
        episodic: [{ content: "Shipped it.", metadata: {} }],
        semantic: [{ content: "The gateway fronts publishers.", metadata: {} }],
        procedural: [{ content: "Run pnpm check first.", metadata: {} }],
        error_fixes: [{ content: "Reinstall on ELIFECYCLE.", metadata: {} }],
        preferences: [{ content: "Prefers pnpm.", metadata: {} }],
        stored_memory_ids: ["id-ep", "id-se", "id-pr", "id-ef", "id-pf"],
      }),
    );

    const result = await storeAssistantResponse("Answer", {
      userQuery: "Question",
    });

    expect(
      result?.messageMemory?.captured?.map((d) => [d.id, d.type]),
    ).toEqual([
      ["id-ep", "episodic"],
      ["id-se", "semantic"],
      ["id-pr", "procedural"],
      ["id-ef", "error_fix"],
      ["id-pf", "preference"],
    ]);
  });

  it("drops ids from a deduplicated conversation source with no extraction", async () => {
    // engine.process_conversation returns previously linked ids and no groups
    // when a retained source is unchanged.
    processConversationMock.mockResolvedValue(
      apiResult({
        conversation_source_id: "source-1",
        stored_memory_ids: ["mem-linked-earlier"],
      }),
    );

    const result = await storeAssistantResponse("Answer", {
      userQuery: "Question",
    });

    expect(result?.messageMemory).toBeUndefined();
  });

  it("leaves captured memories unlabelled when stored ids do not line up", async () => {
    processConversationMock.mockResolvedValue(
      apiResult({
        episodic: [{ content: "Shipped the migration.", metadata: {} }],
        preferences: [{ content: "Prefers pnpm.", metadata: {} }],
        // A deduplicated conversation source returns previously linked ids that
        // do not correspond to this extraction.
        stored_memory_ids: ["mem-from-an-earlier-turn"],
      }),
    );

    const result = await storeAssistantResponse("Answer", {
      userQuery: "Question",
    });

    expect(
      result?.messageMemory?.captured?.map((detail) => detail.id),
    ).toEqual([undefined, undefined]);
  });

  it("appends to a memory rather than replacing its content", async () => {
    appendMemoryMock.mockResolvedValue(
      apiResult({ id: "mem-1", content: "old\n\nextra" }),
    );

    await appendToMemory("mem-1", "extra");

    expect(appendMemoryMock).toHaveBeenCalledWith({
      path: { id: "mem-1" },
      body: { content: "extra" },
      throwOnError: false,
    });
    await expect(appendToMemory("mem-1", "   ")).rejects.toThrow(
      "Appending to a memory requires content",
    );
  });

  it("suppresses a memory for one answer without calling the service", () => {
    const suppressed = suppressMemoryForAnswer("mem-1", "message-1");

    expect(suppressed).toEqual({
      memoryId: "mem-1",
      messageId: "message-1",
      reason: "operator requested contextual suppression",
    });
    expect(appendMemoryMock).not.toHaveBeenCalled();
    expect(rememberMock).not.toHaveBeenCalled();
    expect(forgetMemoryMock).not.toHaveBeenCalled();
  });

  it("replaces a wrong memory instead of appending the contradiction", async () => {
    forgetMemoryMock.mockResolvedValue(apiResult({ forgotten: true }));
    rememberMock.mockResolvedValue(
      apiResult({
        action_taken: "add",
        edges_created: 0,
        enrichments_triggered: 0,
        memory_id: "mem-2",
      }),
    );

    const result = await correctAnswerMemory({
      messageId: "message-1",
      correction: "I use pnpm, not npm",
      memories: [{ id: "mem-1", type: "preference", summary: "Uses npm" }],
    });

    expect(appendMemoryMock).not.toHaveBeenCalled();
    expect(forgetMemoryMock).toHaveBeenCalledWith({
      body: { memory_id: "mem-1" },
      throwOnError: false,
    });
    expect(rememberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          content: "I use pnpm, not npm",
          memory_type: "preference",
          // Conflict resolution off: the caller named the memory to replace,
          // and the engine would otherwise treat a close correction as a
          // duplicate and store nothing.
          skip_conflict_check: true,
          metadata: {
            corrected_from_answer: "message-1",
            supersedes_memory_id: "mem-1",
          },
        }),
      }),
    );
    expect(result).toEqual({
      notice: "Replaced the remembered detail with your correction.",
      droppedMemoryId: "mem-1",
    });
  });

  it("stores the correction before forgetting what it replaces", async () => {
    const calls: string[] = [];
    rememberMock.mockImplementation(async () => {
      calls.push("remember");
      return apiResult({
        action_taken: "add",
        edges_created: 0,
        enrichments_triggered: 0,
        memory_id: "mem-2",
      });
    });
    forgetMemoryMock.mockImplementation(async () => {
      calls.push("forget");
      return apiResult({ forgotten: true });
    });

    await correctAnswerMemory({
      messageId: "message-1",
      correction: "I use pnpm, not npm",
      memories: [{ id: "mem-1", type: "preference", summary: "Uses npm" }],
    });

    expect(calls).toEqual(["remember", "forget"]);
  });

  it("keeps the original memory when storing the correction fails", async () => {
    rememberMock.mockResolvedValue({
      data: undefined,
      error: { error: "internal", message: "embedding backend unavailable" },
    });

    await expect(
      correctAnswerMemory({
        messageId: "message-1",
        correction: "I use pnpm, not npm",
        memories: [{ id: "mem-1", type: "preference", summary: "Uses npm" }],
      }),
    ).rejects.toThrow("Failed to remember memory: embedding backend unavailable");

    // Nothing was forgotten, so the detail the operator corrected survives and
    // they can retry instead of losing both it and the correction.
    expect(forgetMemoryMock).not.toHaveBeenCalled();
  });

  it("reports a partial correction when the replaced memory survives", async () => {
    rememberMock.mockResolvedValue(
      apiResult({
        action_taken: "add",
        edges_created: 0,
        enrichments_triggered: 0,
        memory_id: "mem-2",
      }),
    );
    forgetMemoryMock.mockResolvedValue({
      data: undefined,
      error: { error: "not_found", message: "memory not found" },
    });

    const result = await correctAnswerMemory({
      messageId: "message-1",
      correction: "I use pnpm, not npm",
      memories: [{ id: "mem-1", type: "preference", summary: "Uses npm" }],
    });

    expect(result).toEqual({
      notice:
        "Stored your correction, but the outdated detail could not be removed.",
    });
    // The stale memory is still recallable, so the answer must keep citing it.
    expect(result.droppedMemoryId).toBeUndefined();
  });

  it("falls back to a valid memory type when the detail carries none", async () => {
    forgetMemoryMock.mockResolvedValue(apiResult({ forgotten: true }));
    rememberMock.mockResolvedValue(
      apiResult({
        action_taken: "add",
        edges_created: 0,
        enrichments_triggered: 0,
        memory_id: "mem-2",
      }),
    );

    await correctAnswerMemory({
      messageId: "message-1",
      correction: "That detail is stale",
      memories: [{ id: "mem-1", type: "memory", summary: "Stale detail" }],
    });

    expect(rememberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ memory_type: "semantic" }),
      }),
    );
  });

  it("returns no memories when the feature is disabled", async () => {
    memoryEnabledState.enabled = false;

    await expect(recallMemories("marker")).resolves.toEqual([]);
    await expect(
      bootstrapMemoryContextDetails(),
    ).resolves.toBeNull();
    await expect(rememberMemory("marker")).rejects.toThrow(
      "Memory feature not available - sign in to Seren",
    );
    expect(recallMock).not.toHaveBeenCalled();
    expect(sessionBootstrapMock).not.toHaveBeenCalled();
    expect(rememberMock).not.toHaveBeenCalled();
  });
});
