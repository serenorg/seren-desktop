// ABOUTME: Reactive chat state management with multi-conversation support.
// ABOUTME: Stores conversations, messages, and provides persistence via Tauri.

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
import {
  estimateConversationTokens,
  getModelContextLimit,
  shouldTriggerCompaction,
} from "@/lib/token-counter";
import type { Message } from "@/services/chat";
import { sendMessage } from "@/services/chat";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4";
const MAX_MESSAGES_PER_CONVERSATION = 1000;

/**
 * A compacted summary of older messages.
 */
export interface CompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
}

/**
 * A chat conversation that groups messages together.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  selectedModel: string;
  selectedProvider: ProviderId | null;
  isArchived: boolean;
  compactedSummary?: CompactedSummary;
}

type MessagePatch = Partial<
  Omit<Message, "id" | "timestamp" | "role" | "model" | "content">
> &
  Partial<
    Pick<
      Message,
      | "content"
      | "model"
      | "timestamp"
      | "role"
      | "error"
      | "status"
      | "attemptCount"
    >
  >;

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, Message[]>;
  selectedModel: string;
  isLoading: boolean;
  error: string | null;
  retryingMessageId: string | null;
  isCompacting: boolean;
  /** Pending input to pre-fill in the chat input field */
  pendingInput: string | null;
}

const [state, setState] = createStore<ChatState>({
  conversations: [],
  activeConversationId: null,
  messages: {},
  selectedModel: DEFAULT_MODEL,
  isLoading: false,
  error: null,
  retryingMessageId: null,
  isCompacting: false,
  pendingInput: null,
});

/**
 * Convert database conversation to frontend format.
 */
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

/**
 * Generate a title from the first user message.
 */
function generateTitle(content: string): string {
  const maxLen = 30;
  const trimmed = content.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  // Truncate at word boundary
  const truncated = trimmed.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated}…`;
}

export const chatStore = {
  // ============================================================================
  // Getters
  // ============================================================================

  get conversations() {
    return state.conversations;
  },

  get activeConversationId() {
    return state.activeConversationId;
  },

  get activeConversation(): Conversation | null {
    if (!state.activeConversationId) return null;
    return (
      state.conversations.find((c) => c.id === state.activeConversationId) ??
      null
    );
  },

  /**
   * Get messages for the active conversation.
   */
  get messages(): Message[] {
    if (!state.activeConversationId) return [];
    return state.messages[state.activeConversationId] ?? [];
  },

  /**
   * Get messages for a specific conversation.
   */
  getMessagesFor(conversationId: string): Message[] {
    return state.messages[conversationId] ?? [];
  },

  get selectedModel() {
    // Return active conversation's model or global default
    const active = this.activeConversation;
    return active?.selectedModel ?? state.selectedModel;
  },

  get isLoading() {
    return state.isLoading;
  },

  get error() {
    return state.error;
  },

  get retryingMessageId() {
    return state.retryingMessageId;
  },

  get isCompacting() {
    return state.isCompacting;
  },

  get pendingInput() {
    return state.pendingInput;
  },

  /**
   * Get the compacted summary for the active conversation.
   */
  get compactedSummary(): CompactedSummary | undefined {
    const active = this.activeConversation;
    return active?.compactedSummary;
  },

  /**
   * Get estimated token count for the active conversation.
   */
  get estimatedTokens(): number {
    return estimateConversationTokens(this.messages);
  },

  /**
   * Get context limit for the active conversation's model.
   */
  get contextLimit(): number {
    return getModelContextLimit(this.selectedModel);
  },

  /**
   * Get context usage percentage.
   */
  get contextUsagePercent(): number {
    const limit = this.contextLimit;
    if (limit === 0) return 0;
    return Math.min(100, Math.round((this.estimatedTokens / limit) * 100));
  },

  // ============================================================================
  // Conversation Management
  // ============================================================================

  /**
   * Create a new conversation and switch to it.
   */
  async createConversation(title = "New Chat"): Promise<Conversation> {
    const id = crypto.randomUUID();
    const model = state.selectedModel;
    const provider = null; // Will be determined from model

    try {
      await createConversationDb(id, title, model, provider ?? undefined);
    } catch (error) {
      console.warn("Failed to persist conversation", error);
    }

    const conversation: Conversation = {
      id,
      title,
      createdAt: Date.now(),
      selectedModel: model,
      selectedProvider: provider,
      isArchived: false,
    };

    setState("conversations", (convos) => [conversation, ...convos]);
    setState("messages", id, []);
    setState("activeConversationId", id);

    return conversation;
  },

  /**
   * Switch to a different conversation.
   */
  setActiveConversation(id: string | null) {
    setState("activeConversationId", id);
  },

  /**
   * Archive a conversation (hide from tabs but keep data).
   */
  async archiveConversation(id: string) {
    try {
      await archiveConversationDb(id);
    } catch (error) {
      console.warn("Failed to archive conversation", error);
    }

    setState("conversations", (convos) =>
      convos.map((c) => (c.id === id ? { ...c, isArchived: true } : c)),
    );

    // If archiving the active conversation, switch to another
    if (state.activeConversationId === id) {
      const remaining = state.conversations.filter(
        (c) => c.id !== id && !c.isArchived,
      );
      if (remaining.length > 0) {
        setState("activeConversationId", remaining[0].id);
      } else {
        // Create a new conversation if none remain
        await this.createConversation();
      }
    }
  },

  /**
   * Update conversation title.
   */
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

  /**
   * Update conversation's selected model.
   */
  async updateConversationModel(
    id: string,
    model: string,
    provider?: ProviderId,
  ) {
    try {
      await updateConversationDb(id, undefined, model, provider);
    } catch (error) {
      console.warn("Failed to update conversation model", error);
    }

    setState("conversations", (convos) =>
      convos.map((c) =>
        c.id === id
          ? {
              ...c,
              selectedModel: model,
              selectedProvider: provider ?? c.selectedProvider,
            }
          : c,
      ),
    );
  },

  // ============================================================================
  // Message Management
  // ============================================================================

  addMessage(message: Message) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("messages", conversationId, (existing = []) => {
      const next = [...existing, message];
      if (next.length > MAX_MESSAGES_PER_CONVERSATION) {
        return next.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }
      return next;
    });

    // Auto-generate title from first user message
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

  updateMessage(id: string, patch: MessagePatch) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("messages", conversationId, (msgs = []) =>
      msgs.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)),
    );
  },

  setMessages(conversationId: string, messages: Message[]) {
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

  // ============================================================================
  // Global State
  // ============================================================================

  setModel(modelId: string) {
    setState("selectedModel", modelId);

    // Also update the active conversation's model
    const activeId = state.activeConversationId;
    if (activeId) {
      this.updateConversationModel(activeId, modelId);
    }
  },

  setLoading(isLoading: boolean) {
    setState("isLoading", isLoading);
  },

  setError(error: string | null) {
    setState("error", error);
  },

  setRetrying(id: string | null) {
    setState("retryingMessageId", id);
  },

  setPendingInput(input: string | null) {
    setState("pendingInput", input);
  },

  // ============================================================================
  // Persistence
  // ============================================================================

  async persistMessage(message: Message) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    try {
      await saveMessageDb(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.model ?? null,
        message.timestamp,
      );
    } catch (error) {
      console.error("[chatStore] Failed to persist message:", error);
      setState(
        "error",
        "Failed to save message. Chat history may be incomplete.",
      );
    }
  },

  /**
   * Load all conversations and messages from the database.
   */
  async loadHistory() {
    try {
      // Load conversations
      const dbConversations = await getConversationsDb();
      const conversations = dbConversations.map(dbToConversation);

      setState("conversations", conversations);

      // Load messages for each conversation
      for (const convo of conversations) {
        try {
          const dbMessages = await getMessagesDb(
            convo.id,
            MAX_MESSAGES_PER_CONVERSATION,
          );
          const messages: Message[] = dbMessages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            model: m.model ?? undefined,
            timestamp: m.timestamp,
            status: "complete" as const,
          }));
          setState("messages", convo.id, messages);
        } catch (error) {
          console.warn(
            `Failed to load messages for conversation ${convo.id}`,
            error,
          );
        }
      }

      // Set active conversation to the most recent one, or create new if none
      if (conversations.length > 0) {
        setState("activeConversationId", conversations[0].id);
      } else {
        await this.createConversation();
      }
    } catch (error) {
      console.warn("Unable to load history", error);
      // Create a default conversation on error
      await this.createConversation();
    }
  },

  /**
   * Clear messages for the active conversation.
   */
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

  /**
   * Clear all conversations and messages (full reset).
   */
  async clearAllHistory() {
    try {
      await clearAllHistoryDb();
    } catch (error) {
      console.warn("Unable to clear all history", error);
    }

    setState("conversations", []);
    setState("messages", {});
    setState("activeConversationId", null);

    // Create a fresh conversation
    await this.createConversation();
  },

  // ============================================================================
  // Auto-Compact
  // ============================================================================

  /**
   * Check if compaction should be triggered for the active conversation.
   */
  shouldCompact(thresholdPercent: number): boolean {
    return shouldTriggerCompaction(
      this.messages,
      this.selectedModel,
      thresholdPercent,
    );
  },

  /**
   * Compact older messages into a summary.
   * Preserves the most recent N messages and summarizes the rest.
   */
  async compactConversation(preserveCount: number): Promise<void> {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    const messages = this.messages;
    if (messages.length <= preserveCount) {
      // Nothing to compact
      return;
    }

    setState("isCompacting", true);

    try {
      // Split messages into those to compact and those to preserve
      const toCompact = messages.slice(0, messages.length - preserveCount);
      const toPreserve = messages.slice(-preserveCount);

      // Generate summary prompt
      const summaryPrompt = `Please provide a concise summary of the following conversation. Focus on key topics discussed, decisions made, and important context that would be useful for continuing the conversation. Keep the summary under 500 words.

Conversation to summarize:
${toCompact.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")}

Summary:`;

      // Use the current model to generate summary
      const summary = await sendMessage(
        summaryPrompt,
        this.selectedModel,
        undefined,
      );

      // Create the compacted summary
      const compactedSummary: CompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: Date.now(),
      };

      // Update conversation with compacted summary
      setState("conversations", (convos) =>
        convos.map((c) =>
          c.id === conversationId ? { ...c, compactedSummary } : c,
        ),
      );

      // Replace messages with only the preserved ones
      setState("messages", conversationId, toPreserve);

      console.log(
        `[chatStore] Compacted ${toCompact.length} messages, preserved ${toPreserve.length}`,
      );
    } catch (error) {
      console.error("[chatStore] Failed to compact conversation:", error);
      setState("error", "Failed to compact conversation");
    } finally {
      setState("isCompacting", false);
    }
  },

  /**
   * Create a new conversation with an initial user message and switch to it.
   * The message is added to state and persisted, but NOT sent to the AI.
   * The caller is responsible for navigating to the chat panel where the
   * message will be displayed and can be sent.
   */
  async createConversationWithMessage(
    title: string,
    initialMessage: string,
  ): Promise<Conversation> {
    const conversation = await this.createConversation(title);

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: initialMessage,
      timestamp: Date.now(),
      model: conversation.selectedModel,
      status: "complete",
    };

    this.addMessage(userMessage);
    await this.persistMessage(userMessage);

    return conversation;
  },

  /**
   * Clear the compacted summary for the active conversation.
   */
  clearCompactedSummary() {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("conversations", (convos) =>
      convos.map((c) =>
        c.id === conversationId ? { ...c, compactedSummary: undefined } : c,
      ),
    );
  },

  /**
   * Check and trigger auto-compact if needed.
   * Called after adding messages.
   */
  async checkAutoCompact(
    enabled: boolean,
    threshold: number,
    preserveCount: number,
  ): Promise<void> {
    if (!enabled) return;
    if (state.isCompacting) return;
    if (state.isLoading) return;

    if (this.shouldCompact(threshold)) {
      await this.compactConversation(preserveCount);
    }
  },
};

export type { Message };
export const MAX_CHAT_MESSAGES = MAX_MESSAGES_PER_CONVERSATION;
