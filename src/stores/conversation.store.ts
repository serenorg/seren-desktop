// ABOUTME: Unified conversation store for the orchestrator.
// ABOUTME: Replaces separate chat and local-agent message state with UnifiedMessage types.

import { createStore } from "solid-js/store";
import type { ProviderId } from "@/lib/providers/types";
import {
  archiveConversation as archiveConversationDb,
  clearAllHistory as clearAllHistoryDb,
  clearConversationHistory as clearConversationHistoryDb,
  createConversation as createConversationDb,
  type Conversation as DbConversation,
  getMessages as getMessagesDb,
  listConversations,
  saveMessage as saveMessageDb,
  switchThreadProvider as switchThreadProviderBridge,
  type UnifiedConversationRow,
  updateConversation as updateConversationDb,
} from "@/lib/tauri-bridge";
import type { AgentType } from "@/services/providers";
import type { UnifiedMessage } from "@/types/conversation";
import { deserializeMetadata, serializeMetadata } from "@/types/conversation";

const DEFAULT_MODEL = "arcee-ai/trinity-large-thinking";
const MAX_MESSAGES_PER_CONVERSATION = 1000;

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  selectedModel: string;
  selectedProvider: ProviderId | AgentType | null;
  projectRoot: string | null;
  isArchived: boolean;
  employeeId: string | null;
}

interface ConversationState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Record<string, UnifiedMessage[]>;
  loading: Record<string, boolean>;
  rlmProcessing: Record<string, boolean>;
  error: string | null;
  streamingContent: Record<string, string>;
  streamingThinking: Record<string, string>;
  streamingStalled: Record<string, boolean>;
}

const [state, setState] = createStore<ConversationState>({
  conversations: [],
  activeConversationId: null,
  messages: {},
  loading: {},
  rlmProcessing: {},
  error: null,
  streamingContent: {},
  streamingThinking: {},
  streamingStalled: {},
});

type DbMessage = Awaited<ReturnType<typeof getMessagesDb>>[number];

function dbToUnifiedMessage(m: DbMessage): UnifiedMessage {
  const metaFields = deserializeMetadata(m.metadata);
  return {
    id: m.id,
    type: (metaFields.type
      ? metaFields.type
      : metaFields.workerType
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
    provider: m.provider ?? undefined,
    taskType: metaFields.taskType,
    duration: metaFields.duration,
    cost: metaFields.cost,
    toolCall: metaFields.toolCall,
    diff: metaFields.diff,
  };
}

function dbToConversation(db: DbConversation): Conversation {
  return {
    id: db.id,
    title: db.title,
    createdAt: db.created_at,
    selectedModel: db.selected_model ?? DEFAULT_MODEL,
    selectedProvider: (db.selected_provider as ProviderId | AgentType) ?? null,
    projectRoot: db.project_root ?? null,
    isArchived: db.is_archived,
    employeeId: db.employee_id ?? null,
  };
}

function unifiedRowToConversation(row: UnifiedConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    selectedModel: row.selected_model ?? DEFAULT_MODEL,
    selectedProvider: (row.selected_provider as ProviderId | AgentType) ?? null,
    projectRoot: row.project_root,
    isArchived: row.is_archived,
    employeeId: row.employee_id,
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
    if (!state.activeConversationId) return false;
    return state.loading[state.activeConversationId] ?? false;
  },

  getLoadingFor(conversationId: string): boolean {
    return state.loading[conversationId] ?? false;
  },

  get isRLMProcessing(): boolean {
    if (!state.activeConversationId) return false;
    return state.rlmProcessing[state.activeConversationId] ?? false;
  },

  getRLMProcessingFor(conversationId: string): boolean {
    return state.rlmProcessing[conversationId] ?? false;
  },

  setRLMProcessing(
    value: boolean,
    conversationId = state.activeConversationId,
  ) {
    if (!conversationId) return;
    setState("rlmProcessing", conversationId, value);
  },

  get error(): string | null {
    return state.error;
  },

  get streamingContent(): string {
    if (!state.activeConversationId) return "";
    return state.streamingContent[state.activeConversationId] ?? "";
  },

  get streamingThinking(): string {
    if (!state.activeConversationId) return "";
    return state.streamingThinking[state.activeConversationId] ?? "";
  },

  getStreamingContentFor(conversationId: string): string {
    return state.streamingContent[conversationId] ?? "";
  },

  getStreamingThinkingFor(conversationId: string): string {
    return state.streamingThinking[conversationId] ?? "";
  },

  /**
   * True when a streaming run has gone quiet for long enough that the
   * caller wants to surface a "this may take a while" hint. Set by the
   * orchestrator's stall detector; unset on each token / on finalize.
   */
  get streamingStalled(): boolean {
    if (!state.activeConversationId) return false;
    return state.streamingStalled[state.activeConversationId] ?? false;
  },

  getStreamingStalledFor(conversationId: string): boolean {
    return state.streamingStalled[conversationId] ?? false;
  },

  setStreamingStalled(stalled: boolean, conversationId?: string) {
    const id = conversationId ?? state.activeConversationId;
    if (!id) return;
    setState("streamingStalled", id, stalled);
  },

  // === Conversation management ===

  async createConversation(
    title = "New Chat",
    projectRoot?: string,
  ): Promise<Conversation> {
    return this.createConversationWithModel(title, DEFAULT_MODEL, projectRoot);
  },

  async createConversationWithModel(
    title: string,
    model: string,
    projectRoot?: string,
    selectedProvider?: ProviderId | AgentType | null,
    employeeId?: string | null,
  ): Promise<Conversation> {
    const id = crypto.randomUUID();

    try {
      await createConversationDb(
        id,
        title,
        model,
        selectedProvider ?? undefined,
        projectRoot,
        employeeId ?? undefined,
      );
    } catch (error) {
      console.warn("Failed to persist conversation", error);
    }

    const conversation: Conversation = {
      id,
      title,
      createdAt: Date.now(),
      selectedModel: model,
      selectedProvider: selectedProvider ?? null,
      projectRoot: projectRoot ?? null,
      isArchived: false,
      employeeId: employeeId ?? null,
    };

    setState("conversations", (convos) => [conversation, ...convos]);
    setState("messages", id, []);
    setState("activeConversationId", id);

    return conversation;
  },

  setActiveConversation(id: string | null) {
    setState("activeConversationId", id);
  },

  forgetByEmployee(employeeId: string) {
    // Drop conversations whose link is the given employee. The caller is
    // responsible for the SQLite cascade-delete; this only updates the
    // in-memory state so the sidebar reflects the wipe immediately.
    const removedIds = new Set(
      state.conversations
        .filter((c) => c.employeeId === employeeId)
        .map((c) => c.id),
    );
    if (removedIds.size === 0) return;
    setState("conversations", (convos) =>
      convos.filter((c) => !removedIds.has(c.id)),
    );
    for (const key of [
      "messages",
      "loading",
      "rlmProcessing",
      "streamingContent",
      "streamingThinking",
      "streamingStalled",
    ] as const) {
      setState(key, (prev) => {
        const next = { ...prev };
        for (const id of removedIds) {
          delete next[id];
        }
        return next;
      });
    }
    if (
      state.activeConversationId !== null &&
      removedIds.has(state.activeConversationId)
    ) {
      setState("activeConversationId", null);
    }
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
        // Allow closing the last thread - don't auto-create a new one
        setState("activeConversationId", null);
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

  async updateConversationSelection(
    id: string,
    selectedModel: string,
    selectedProvider: ProviderId | AgentType | null,
  ) {
    // Auto-reroute and other programmatic writers land here mid-stream;
    // the bridge command is unguarded by design (the TS-side guard lives
    // in the user-initiated `switchChatProvider` service). Route through
    // the atomic switch when we have a provider so the runtime row and
    // compatibility columns stay paired. Threads with no recorded
    // provider fall back to the legacy direct update.
    try {
      if (selectedProvider) {
        await switchThreadProviderBridge(id, selectedProvider, selectedModel);
      } else {
        await updateConversationDb(id, undefined, selectedModel, undefined);
      }
    } catch (error) {
      // Persist failed (e.g. stale runtime binding, thread not found).
      // Leave the in-memory row alone so the cached binding keeps matching
      // the persisted row instead of silently diverging.
      console.warn("Failed to update conversation selection", error);
      return;
    }

    setState("conversations", (convos) =>
      convos.map((c) =>
        c.id === id
          ? {
              ...c,
              selectedModel,
              selectedProvider,
            }
          : c,
      ),
    );
  },

  /**
   * Synchronize the in-memory conversation entry after a per-thread
   * provider runtime switch. The DB row was already mutated atomically by
   * `switch_thread_provider`; this just keeps the SolidJS cache in step
   * so the next orchestrator turn reads the new binding without a reload.
   */
  applyRuntimeBindingSync(
    id: string,
    selectedProvider: ProviderId | AgentType,
    selectedModel: string,
  ) {
    setState("conversations", (convos) =>
      convos.map((c) =>
        c.id === id ? { ...c, selectedProvider, selectedModel } : c,
      ),
    );
  },

  /**
   * Drop a conversation from the in-memory cache. Used when a thread
   * crosses out of chat-kind on a cross-category provider switch - the
   * DB row's `kind` has just flipped to `agent`, so a subsequent
   * `listConversations({ kind: 'chat' })` read would not return it
   * anyway. Removes the per-thread message bucket, loading flag, and
   * streaming state so the chat shell does not leak stale state into
   * the next thread that takes its place.
   */
  dropFromCache(id: string) {
    setState("conversations", (convos) => convos.filter((c) => c.id !== id));
    for (const key of [
      "messages",
      "loading",
      "rlmProcessing",
      "streamingContent",
      "streamingThinking",
      "streamingStalled",
    ] as const) {
      setState(key, id, undefined as never);
    }
    if (state.activeConversationId === id) {
      setState("activeConversationId", null);
    }
  },

  /**
   * Insert (or replace) a conversation in the in-memory cache from a
   * freshly-read DB row. Used when a thread crosses INTO chat-kind on a
   * cross-category switch; the row was previously rendered through the
   * agent shell and needs to surface in the chat sidebar now.
   */
  upsertFromDb(row: DbConversation) {
    const conv = dbToConversation(row);
    setState("conversations", (convos) => {
      const without = convos.filter((c) => c.id !== conv.id);
      return [conv, ...without];
    });
    if (!state.messages[conv.id]) {
      setState("messages", conv.id, []);
    }
  },

  /**
   * Read this thread's messages from the DB and replace the in-memory
   * bucket. Used by `loadHistory` to populate caches on app start and by
   * the agent-to-chat transition to pre-hydrate the chat shell with the
   * prior agent transcript - the messages table is shared across kinds,
   * so the agent's saved turns become the chat shell's recap the moment
   * the binding flips.
   */
  async loadMessagesFor(id: string): Promise<void> {
    try {
      const dbMessages = await getMessagesDb(id, MAX_MESSAGES_PER_CONVERSATION);
      setState("messages", id, dbMessages.map(dbToUnifiedMessage));
    } catch (error) {
      console.warn(`Failed to load messages for conversation ${id}`, error);
    }
  },

  // === Message management ===

  addMessage(
    message: UnifiedMessage,
    conversationId = state.activeConversationId,
  ) {
    if (!conversationId) return;

    setState("messages", conversationId, (existing = []) => {
      const next = [...existing, message];
      if (next.length > MAX_MESSAGES_PER_CONVERSATION) {
        return next.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }
      return next;
    });

    const conversation = state.conversations.find(
      (c) => c.id === conversationId,
    );
    if (
      conversation &&
      message.role === "user" &&
      conversation.title === "New Chat"
    ) {
      const title = generateTitle(message.content);
      this.updateConversationTitle(conversationId, title);
    }
  },

  updateMessage(
    id: string,
    patch: Partial<UnifiedMessage>,
    conversationId = state.activeConversationId,
  ) {
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

  clearMessages(conversationId = state.activeConversationId) {
    if (!conversationId) return;
    setState("messages", conversationId, []);
  },

  // === Streaming state ===

  appendStreamingContent(
    text: string,
    conversationId = state.activeConversationId,
  ) {
    if (!conversationId) return;
    setState("streamingContent", conversationId, (prev = "") => prev + text);
  },

  appendStreamingThinking(
    text: string,
    conversationId = state.activeConversationId,
  ) {
    if (!conversationId) return;
    setState("streamingThinking", conversationId, (prev = "") => prev + text);
  },

  clearStreamingContent(conversationId = state.activeConversationId) {
    if (!conversationId) return;
    setState("streamingContent", conversationId, "");
  },

  finalizeStreaming(conversationId = state.activeConversationId) {
    if (!conversationId) return;
    setState("streamingContent", conversationId, "");
    setState("streamingThinking", conversationId, "");
    setState("streamingStalled", conversationId, false);
  },

  // === Loading/error ===

  setLoading(loading: boolean, conversationId = state.activeConversationId) {
    if (!conversationId) return;
    setState("loading", conversationId, loading);
  },

  setError(error: string | null) {
    setState("error", error);
  },

  // === Persistence ===

  async persistMessage(
    message: UnifiedMessage,
    conversationId = state.activeConversationId,
  ) {
    if (!conversationId) return;

    const convo = state.conversations.find((c) => c.id === conversationId);
    const provider =
      message.role === "user"
        ? null
        : (message.provider ?? convo?.selectedProvider ?? null);

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
        provider,
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
      const rows = await listConversations({ kind: "chat" });
      const conversations = rows.map(unifiedRowToConversation);

      setState("conversations", conversations);

      for (const convo of conversations) {
        await this.loadMessagesFor(convo.id);
      }

      // Only set active conversation if none is currently selected
      if (!state.activeConversationId && conversations.length > 0) {
        setState("activeConversationId", conversations[0].id);
      } else if (conversations.length === 0) {
        await this.createConversation();
      }
    } catch (error) {
      console.warn("Unable to load history", error);
      // First-launch UX: only seed a default conversation when there are
      // none in the in-memory store. Without this guard, every loadHistory
      // failure (e.g. browser-fallback / `pnpm browser:local` where the
      // SQLite-backed DB throws "Conversation operations require Tauri
      // runtime") spawns yet another "New Chat" on every ChatContent
      // re-mount — see #1630 follow-up.
      if (state.conversations.length === 0) {
        await this.createConversation();
      }
    }
  },

  async clearHistory(conversationId = state.activeConversationId) {
    if (!conversationId) return;

    try {
      await clearConversationHistoryDb(conversationId);
    } catch (error) {
      console.warn("Unable to clear history", error);
    }
    this.clearMessages(conversationId);
    setState("streamingContent", conversationId, "");
    setState("streamingThinking", conversationId, "");
    setState("loading", conversationId, false);
    setState("rlmProcessing", conversationId, false);
  },

  async clearAllHistory() {
    try {
      await clearAllHistoryDb();
    } catch (error) {
      console.warn("Unable to clear all history", error);
    }

    setState("conversations", []);
    setState("messages", {});
    setState("streamingContent", {});
    setState("streamingThinking", {});
    setState("loading", {});
    setState("rlmProcessing", {});
    setState("activeConversationId", null);

    await this.createConversation();
  },
};
