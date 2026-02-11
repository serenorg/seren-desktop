// ABOUTME: Tests for the unified conversation store.
// ABOUTME: Verifies conversation/message CRUD, persistence, and metadata handling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Tauri bridge before importing the store
vi.mock("@/lib/tauri-bridge", () => ({
  createConversation: vi.fn().mockResolvedValue(undefined),
  getConversations: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  updateConversation: vi.fn().mockResolvedValue(undefined),
  archiveConversation: vi.fn().mockResolvedValue(undefined),
  clearConversationHistory: vi.fn().mockResolvedValue(undefined),
  clearAllHistory: vi.fn().mockResolvedValue(undefined),
}));

// Mock crypto.randomUUID for deterministic IDs
let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

import { conversationStore } from "@/stores/conversation.store";
import type { UnifiedMessage } from "@/types/conversation";

function makeMessage(
  overrides: Partial<UnifiedMessage> = {},
): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    type: "assistant",
    role: "assistant",
    content: "hello",
    timestamp: Date.now(),
    status: "complete",
    ...overrides,
  };
}

describe("conversationStore", () => {
  beforeEach(() => {
    uuidCounter = 0;
    // Reset store state by clearing all history (mock, so fast)
    // We need to create a fresh state for each test
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createConversation", () => {
    it("returns a valid conversation with UUID id", async () => {
      const convo = await conversationStore.createConversation("Test");
      expect(convo.id).toBe("test-uuid-1");
      expect(convo.title).toBe("Test");
      expect(convo.isArchived).toBe(false);
      expect(convo.selectedModel).toBe("anthropic/claude-sonnet-4");
    });

    it("sets new conversation as active", async () => {
      const convo = await conversationStore.createConversation();
      expect(conversationStore.activeConversationId).toBe(convo.id);
    });

    it("prepends to conversations list", async () => {
      await conversationStore.createConversation("First");
      await conversationStore.createConversation("Second");
      expect(conversationStore.conversations[0].title).toBe("Second");
    });
  });

  describe("addMessage", () => {
    it("adds message to active conversation", async () => {
      await conversationStore.createConversation();
      const msg = makeMessage({ content: "test message" });
      conversationStore.addMessage(msg);
      expect(conversationStore.messages).toHaveLength(1);
      expect(conversationStore.messages[0].content).toBe("test message");
    });

    it("does nothing when no active conversation", () => {
      conversationStore.setActiveConversation(null);
      const msg = makeMessage();
      conversationStore.addMessage(msg);
      // Should not throw
    });

    it("auto-generates title from first user message", async () => {
      const convo = await conversationStore.createConversation("New Chat");
      const msg = makeMessage({
        type: "user",
        role: "user",
        content: "How do I use TypeScript?",
      });
      conversationStore.addMessage(msg);

      // updateConversationTitle is async (fire-and-forget in addMessage)
      // flush microtask queue so the setState inside it executes
      await new Promise((r) => setTimeout(r, 0));

      const updated = conversationStore.conversations.find(
        (c) => c.id === convo.id,
      );
      expect(updated?.title).toBe("How do I use TypeScript?");
    });
  });

  describe("updateMessage", () => {
    it("patches a message by id", async () => {
      await conversationStore.createConversation();
      const msg = makeMessage({ content: "initial" });
      conversationStore.addMessage(msg);
      conversationStore.updateMessage(msg.id, {
        content: "updated",
        status: "complete",
      });
      expect(conversationStore.messages[0].content).toBe("updated");
      expect(conversationStore.messages[0].status).toBe("complete");
    });

    it("does not affect other messages", async () => {
      await conversationStore.createConversation();
      const msg1 = makeMessage({ content: "first" });
      const msg2 = makeMessage({ content: "second" });
      conversationStore.addMessage(msg1);
      conversationStore.addMessage(msg2);
      conversationStore.updateMessage(msg1.id, { content: "modified" });
      expect(conversationStore.messages[1].content).toBe("second");
    });
  });

  describe("message isolation between conversations", () => {
    it("messages for inactive conversations are isolated", async () => {
      const convoA = await conversationStore.createConversation("A");
      conversationStore.addMessage(
        makeMessage({ content: "message in A" }),
      );

      await conversationStore.createConversation("B");
      // convoB is now active, its messages should be empty
      expect(conversationStore.messages).toHaveLength(0);

      // convoA messages still accessible via getMessagesFor
      expect(
        conversationStore.getMessagesFor(convoA.id),
      ).toHaveLength(1);
      expect(
        conversationStore.getMessagesFor(convoA.id)[0].content,
      ).toBe("message in A");
    });
  });

  describe("streaming state", () => {
    it("appends streaming content", () => {
      conversationStore.appendStreamingContent("Hello ");
      conversationStore.appendStreamingContent("world");
      expect(conversationStore.streamingContent).toBe("Hello world");
    });

    it("appends streaming thinking", () => {
      conversationStore.appendStreamingThinking("Let me think...");
      expect(conversationStore.streamingThinking).toBe("Let me think...");
    });

    it("finalizeStreaming resets both", () => {
      conversationStore.appendStreamingContent("text");
      conversationStore.appendStreamingThinking("thought");
      conversationStore.finalizeStreaming();
      expect(conversationStore.streamingContent).toBe("");
      expect(conversationStore.streamingThinking).toBe("");
    });
  });

  describe("loading and error state", () => {
    it("setLoading toggles loading state", () => {
      conversationStore.setLoading(true);
      expect(conversationStore.isLoading).toBe(true);
      conversationStore.setLoading(false);
      expect(conversationStore.isLoading).toBe(false);
    });

    it("setError sets and clears error", () => {
      conversationStore.setError("Something went wrong");
      expect(conversationStore.error).toBe("Something went wrong");
      conversationStore.setError(null);
      expect(conversationStore.error).toBeNull();
    });
  });

  describe("persistMessage", () => {
    it("calls saveMessage with serialized metadata", async () => {
      const { saveMessage } = await import("@/lib/tauri-bridge");
      const convo = await conversationStore.createConversation();

      const msg = makeMessage({
        workerType: "acp_agent",
        modelId: "claude-opus-4-6",
        taskType: "research",
      });
      conversationStore.addMessage(msg);
      await conversationStore.persistMessage(msg);

      expect(saveMessage).toHaveBeenCalledWith(
        msg.id,
        convo.id,
        msg.role,
        msg.content,
        "claude-opus-4-6",
        msg.timestamp,
        expect.stringContaining('"worker_type":"acp_agent"'),
      );
    });

    it("passes null metadata for plain messages", async () => {
      const { saveMessage } = await import("@/lib/tauri-bridge");
      await conversationStore.createConversation();

      const msg = makeMessage({ type: "user", role: "user" });
      conversationStore.addMessage(msg);
      await conversationStore.persistMessage(msg);

      expect(saveMessage).toHaveBeenCalledWith(
        msg.id,
        expect.any(String),
        "user",
        msg.content,
        null,
        msg.timestamp,
        null,
      );
    });
  });

  describe("loadHistory", () => {
    it("defaults workerType to chat_model for null metadata", async () => {
      const bridge = await import("@/lib/tauri-bridge");
      vi.mocked(bridge.getConversations).mockResolvedValueOnce([
        {
          id: "conv-1",
          title: "Old Chat",
          created_at: 1000,
          selected_model: null,
          selected_provider: null,
          project_root: null,
          is_archived: false,
        },
      ]);
      vi.mocked(bridge.getMessages).mockResolvedValueOnce([
        {
          id: "msg-1",
          conversation_id: "conv-1",
          role: "assistant",
          content: "Hello",
          model: "claude-sonnet-4",
          timestamp: 2000,
          metadata: null,
        },
      ]);

      await conversationStore.loadHistory();

      const msgs = conversationStore.getMessagesFor("conv-1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].workerType).toBe("chat_model");
      expect(msgs[0].modelId).toBe("claude-sonnet-4");
    });

    it("deserializes metadata from database", async () => {
      const bridge = await import("@/lib/tauri-bridge");
      vi.mocked(bridge.getConversations).mockResolvedValueOnce([
        {
          id: "conv-2",
          title: "Agent Chat",
          created_at: 1000,
          selected_model: null,
          selected_provider: null,
          project_root: null,
          is_archived: false,
        },
      ]);
      vi.mocked(bridge.getMessages).mockResolvedValueOnce([
        {
          id: "msg-2",
          conversation_id: "conv-2",
          role: "assistant",
          content: "Result",
          model: null,
          timestamp: 3000,
          metadata: JSON.stringify({
            v: 1,
            worker_type: "acp_agent",
            model_id: "gemini-2.5-flash",
            task_type: "code_generation",
          }),
        },
      ]);

      await conversationStore.loadHistory();

      const msgs = conversationStore.getMessagesFor("conv-2");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].workerType).toBe("acp_agent");
      expect(msgs[0].modelId).toBe("gemini-2.5-flash");
      expect(msgs[0].taskType).toBe("code_generation");
    });
  });
});
