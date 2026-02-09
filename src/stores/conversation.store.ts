// ABOUTME: Unified conversation store for the orchestrator.
// ABOUTME: Replaces chatStore/acpStore for message management with UnifiedMessage types.

import { createStore } from "solid-js/store";
import type { ProviderId } from "@/lib/providers/types";
import {
  archiveConversation as archiveConversationDb,
  clearAllHistory as clearAllHistoryDb,
  clearConversationHistory as clearConversationHistoryDb,
  createConversation as createConversationDb,
  type Conversation as DbConversation,
  getConversations as getConversationsDb,
  getMessages as getMessagesDb,
  saveMessage as saveMessageDb,
  updateConversation as updateConversationDb,
} from "@/lib/tauri-bridge";
import type { UnifiedMessage } from "@/types/conversation";
import { deserializeMetadata, serializeMetadata } from "@/types/conversation";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
const MAX_MESSAGES_PER_CONVERSATION = 1000;

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  selectedModel: string;
  selectedProvider: ProviderId | null;
  isArchived: boolean;
}

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, UnifiedMessage[]>;
  isLoading: boolean;
  error: string | null;
  streamingContent: string;
  streamingThinking: string;
}

const [state, setState] = createStore<ConversationState>({
  conversations: [],
  activeConversationId: null,
  messages: {},
  isLoading: false,
  error: null,
  streamingContent: "",
  streamingThinking: "",
});

function dbToConversation(db: DbConversation): Conversation {
  return {
    id: db.id,
    title: db.title,
    createdAt: db.created_at,
    selectedModel: db.selected_model ?? DEFAULT_MODEL,
    selectedProvider: (db.selected_provider as ProviderId) ?? null,
    isArchived: db.is_archived,
  };
}

function generateTitle(content: string): string {
  const maxLen = 30;
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  const truncated = trimmed.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated}…`;
}

export const conversationStore = {
  // === Getters ===

  get conversations(): Conversation[] {
    return state.conversations;
  },

  get activeConversationId(): string | null {
    return state.activeConversationId;
  },

  get activeConversation(): Conversation | null {
    if (!state.activeConversationId) return null;
    return (
      state.conversations.find((c) => c.id === state.activeConversationId) ??
      null
    );
  },

  get messages(): UnifiedMessage[] {
    if (!state.activeConversationId) return [];
    return state.messages[state.activeConversationId] ?? [];
  },

  getMessagesFor(conversationId: string): UnifiedMessage[] {
    return state.messages[conversationId] ?? [];
  },

  get isLoading(): boolean {
    return state.isLoading;
  },

  get error(): string | null {
    return state.error;
  },

  get streamingContent(): string {
    return state.streamingContent;
  },

  get streamingThinking(): string {
    return state.streamingThinking;
  },

  // === Conversation management ===

  async createConversation(title = "New Chat"): Promise<Conversation> {
    const id = crypto.randomUUID();
    const model = DEFAULT_MODEL;

    try {
      await createConversationDb(id, title, model);
    } catch (error) {
      console.warn("Failed to persist conversation", error);
    }

    const conversation: Conversation = {
      id,
      title,
      createdAt: Date.now(),
      selectedModel: model,
      selectedProvider: null,
      isArchived: false,
    };

    setState("conversations", (convos) => [conversation, ...convos]);
    setState("messages", id, []);
    setState("activeConversationId", id);

    return conversation;
  },

  setActiveConversation(id: string | null) {
    setState("activeConversationId", id);
  },

  async archiveConversation(id: string) {
    try {
      await archiveConversationDb(id);
    } catch (error) {
      console.warn("Failed to archive conversation", error);
    }

    setState("conversations", (convos) =>
      convos.map((c) => (c.id === id ? { ...c, isArchived: true } : c)),
    );

    if (state.activeConversationId === id) {
      const remaining = state.conversations.filter(
        (c) => c.id !== id && !c.isArchived,
      );
      if (remaining.length > 0) {
        setState("activeConversationId", remaining[0].id);
      } else {
        await this.createConversation();
      }
    }
  },

  async updateConversationTitle(id: string, title: string) {
    try {
      await updateConversationDb(id, title);
    } catch (error) {
      console.warn("Failed to update conversation title", error);
    }

    setState("conversations", (convos) =>
      convos.map((c) => (c.id === id ? { ...c, title } : c)),
    );
  },

  // === Message management ===

  addMessage(message: UnifiedMessage) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("messages", conversationId, (existing = []) => {
      const next = [...existing, message];
      if (next.length > MAX_MESSAGES_PER_CONVERSATION) {
        return next.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }
      return next;
    });

    const conversation = this.activeConversation;
    if (
      conversation &&
      message.role === "user" &&
      conversation.title === "New Chat"
    ) {
      const title = generateTitle(message.content);
      this.updateConversationTitle(conversationId, title);
    }
  },

  updateMessage(id: string, patch: Partial<UnifiedMessage>) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("messages", conversationId, (msgs = []) =>
      msgs.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)),
    );
  },

  setMessages(conversationId: string, messages: UnifiedMessage[]) {
    setState(
      "messages",
      conversationId,
      messages.slice(-MAX_MESSAGES_PER_CONVERSATION),
    );
  },

  clearMessages() {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;
    setState("messages", conversationId, []);
  },

  // === Streaming state ===

  appendStreamingContent(text: string) {
    setState("streamingContent", (prev) => prev + text);
  },

  appendStreamingThinking(text: string) {
    setState("streamingThinking", (prev) => prev + text);
  },

  finalizeStreaming() {
    setState("streamingContent", "");
    setState("streamingThinking", "");
  },

  // === Loading/error ===

  setLoading(loading: boolean) {
    setState("isLoading", loading);
  },

  setError(error: string | null) {
    setState("error", error);
  },

  // === Persistence ===

  async persistMessage(message: UnifiedMessage) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    try {
      const metadata = serializeMetadata(message);
      await saveMessageDb(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.modelId ?? null,
        message.timestamp,
        metadata,
      );
    } catch (error) {
      console.error("[conversationStore] Failed to persist message:", error);
      setState(
        "error",
        "Failed to save message. Chat history may be incomplete.",
      );
    }
  },

  async loadHistory() {
    try {
      const dbConversations = await getConversationsDb();
      const conversations = dbConversations.map(dbToConversation);

      setState("conversations", conversations);

      for (const convo of conversations) {
        try {
          const dbMessages = await getMessagesDb(
            convo.id,
            MAX_MESSAGES_PER_CONVERSATION,
          );
          const messages: UnifiedMessage[] = dbMessages.map((m) => {
            const metaFields = deserializeMetadata(m.metadata);
            return {
              id: m.id,
              type: (metaFields.workerType
                ? "assistant"
                : m.role === "user"
                  ? "user"
                  : "assistant") as UnifiedMessage["type"],
              role: m.role as UnifiedMessage["role"],
              content: m.content,
              timestamp: m.timestamp,
              status: "complete" as const,
              workerType: metaFields.workerType ?? "chat_model",
              modelId: metaFields.modelId ?? m.model ?? undefined,
              taskType: metaFields.taskType,
              duration: metaFields.duration,
              cost: metaFields.cost,
              toolCall: metaFields.toolCall,
              diff: metaFields.diff,
            };
          });
          setState("messages", convo.id, messages);
        } catch (error) {
          console.warn(
            `Failed to load messages for conversation ${convo.id}`,
            error,
          );
        }
      }

      if (conversations.length > 0) {
        setState("activeConversationId", conversations[0].id);
      } else {
        await this.createConversation();
      }
    } catch (error) {
      console.warn("Unable to load history", error);
      await this.createConversation();
    }
  },

  async clearHistory() {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    try {
      await clearConversationHistoryDb(conversationId);
    } catch (error) {
      console.warn("Unable to clear history", error);
    }
    this.clearMessages();
  },

  async clearAllHistory() {
    try {
      await clearAllHistoryDb();
    } catch (error) {
      console.warn("Unable to clear all history", error);
    }

    setState("conversations", []);
    setState("messages", {});
    setState("activeConversationId", null);

    await this.createConversation();
  },
};
