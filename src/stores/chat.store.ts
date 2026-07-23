// ABOUTME: Reactive chat state management with multi-conversation support.
// ABOUTME: Stores conversations, messages, and provides persistence via Tauri.

import { createStore } from "solid-js/store";
import { isLikelyAuthError } from "@/lib/auth-errors";
import {
  type ChatSkillEstimate,
  estimateChatRequestTokens,
} from "@/lib/compaction/chat-request-accounting";
import {
  type PrunableMessage,
  pruneCompactedHistory,
  relieveOverBudgetTail,
} from "@/lib/compaction/prune";
import {
  buildDeterministicFallbackSummary,
  compactionCooldown,
  runSummarizerWithPolicy,
} from "@/lib/compaction/summarizer-policy";
import {
  buildIterativeCompactionPrompt,
  buildSummaryLineage,
  type SummaryLineage,
} from "@/lib/compaction/summary";
import {
  type AccountedMessage,
  estimateAccountedMessageTokens,
} from "@/lib/compaction/token-accounting";
import {
  type CompactionWindowItem,
  selectCompactionWindow,
} from "@/lib/compaction/window";
import { PROVIDER_CONFIGS, type ProviderId } from "@/lib/providers/types";
import {
  archiveConversation as archiveConversationDb,
  clearAllHistory as clearAllHistoryDb,
  clearConversationHistory as clearConversationHistoryDb,
  createConversation as createConversationDb,
  getMessages as getMessagesDb,
  listConversations,
  saveMessage as saveMessageDb,
  switchThreadProvider as switchThreadProviderBridge,
  type UnifiedConversationRow,
  updateConversation as updateConversationDb,
} from "@/lib/tauri-bridge";
import { getModelContextLimit } from "@/lib/token-counter";
import { getAllTools } from "@/lib/tools";
import { refreshAccessToken } from "@/services/auth";
import type { Message } from "@/services/chat";
import { sendMessage } from "@/services/chat";
import type { AgentType } from "@/services/providers";
import { authStore } from "@/stores/auth.store";
import { fileTreeState } from "@/stores/fileTree";
import { providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

const DEFAULT_MODEL = "arcee-ai/trinity-large-thinking";
const MAX_MESSAGES_PER_CONVERSATION = 1000;

function isChatProvider(
  provider: ProviderId | AgentType | null,
): provider is ProviderId {
  return !!provider && provider in PROVIDER_CONFIGS;
}

/**
 * A pre-compaction user/assistant message preserved under the summary card so
 * the user retains read access to their scrollback after compaction.
 */
export interface PreCompactionMessage {
  id: string;
  type: "user" | "assistant";
  content: string;
  timestamp: number;
}

/**
 * A compacted summary of older messages.
 */
export interface CompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
  /** Original user/assistant text preserved for the expand-scrollback UI. */
  preCompactionMessages?: PreCompactionMessage[];
  /** Lineage across repeated compactions (#2103). Present from generation 1. */
  lineage?: SummaryLineage;
}

/**
 * A chat conversation that groups messages together.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  selectedModel: string;
  selectedProvider: ProviderId | AgentType | null;
  isArchived: boolean;
  privileged?: boolean;
  counselDirection?: string | null;
  compactedSummary?: CompactedSummary;
  /** Reasoning effort level: "minimal" | "low" | "medium" | "high" | "xhigh". */
  reasoningEffort?: string;
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
 * Convert a unified-row read into the frontend chat conversation shape.
 */
function unifiedRowToConversation(row: UnifiedConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    selectedModel: row.selected_model ?? DEFAULT_MODEL,
    selectedProvider: (row.selected_provider as ProviderId | AgentType) ?? null,
    isArchived: row.is_archived,
    privileged: row.privileged,
    counselDirection: row.counsel_direction,
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

/**
 * Reduce a chat message to its token-bearing parts so the gauge and the
 * compaction trigger count attached images at a flat cost instead of ignoring
 * them — the source of context-gauge misses in multimodal chats. #2105.
 */
function accountedChatMessage(m: Message): AccountedMessage {
  return { content: m.content, imageParts: m.images?.length ?? 0 };
}

const MEMORY_CONTEXT_RESERVE_TOKENS = 2048;
const PROJECT_CONTEXT_RESERVE_TOKENS = 2048;

function skillToEstimate(skill: {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  path?: string;
}): ChatSkillEstimate {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    path: skill.path,
  };
}

function estimateDynamicChatContextReserve(projectRoot: string | null): number {
  let reserve = 0;
  if (settingsStore.get("memoryEnabled") && authStore.isAuthenticated) {
    reserve += MEMORY_CONTEXT_RESERVE_TOKENS;
  }
  // The Rust worker can inject live repo context, and the legacy JS path can
  // inject semantic code context, when a project is open. Exact bytes are async
  // and query-dependent, so reserve a conservative synchronous budget. #2115.
  if (projectRoot) {
    reserve += PROJECT_CONTEXT_RESERVE_TOKENS;
  }
  return reserve;
}

function estimateActiveChatRequestTokens({
  conversationId,
  messages,
  compactedSummary,
}: {
  conversationId: string | null;
  messages: Message[];
  compactedSummary?: CompactedSummary;
}): number {
  const projectRoot = fileTreeState.rootPath;
  const skills = skillsStore
    .getThreadSkills(projectRoot, conversationId)
    .map(skillToEstimate);

  return estimateChatRequestTokens({
    messages: messages.map(accountedChatMessage),
    toolSchemas: getAllTools(),
    skills,
    compactedSummary: compactedSummary?.content,
    dynamicContextReserveTokens: estimateDynamicChatContextReserve(projectRoot),
  }).totalTokens;
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
   * Get the reasoning effort for the active conversation.
   */
  get reasoningEffort(): string | undefined {
    const active = this.activeConversation;
    return active?.reasoningEffort;
  },

  /**
   * Get estimated token count for the active conversation, including attached
   * images at a flat per-image cost (#2105).
   */
  get estimatedTokens(): number {
    return estimateActiveChatRequestTokens({
      conversationId: state.activeConversationId,
      messages: this.messages,
      compactedSummary: this.compactedSummary,
    });
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
   * Update conversation's selected model. When the conversation has (or
   * the caller supplies) a bound provider, write through
   * `switch_thread_provider` so the runtime row and the compatibility
   * columns stay in lockstep. Legacy threads with no provider binding fall
   * back to the direct `conversations` update so we do not invent a
   * provider value just to satisfy the runtime row.
   */
  async updateConversationModel(
    id: string,
    model: string,
    provider?: ProviderId | AgentType,
  ) {
    const existing = state.conversations.find((c) => c.id === id);
    const effectiveProvider = provider ?? existing?.selectedProvider ?? null;

    try {
      if (effectiveProvider) {
        await switchThreadProviderBridge(id, effectiveProvider, model);
      } else {
        await updateConversationDb(id, undefined, model, undefined);
      }
    } catch (error) {
      // Persist failed (e.g. stale runtime binding, thread not found).
      // Leave the in-memory row alone so the cached binding keeps matching
      // the persisted row instead of silently diverging.
      console.warn("Failed to update conversation model", error);
      return;
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

  /**
   * Sync the in-memory chat conversation after the per-thread runtime
   * binding has been rewritten atomically by the Rust side.
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

  setReasoningEffort(effort: string | undefined) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    setState("conversations", (convos) =>
      convos.map((c) =>
        c.id === conversationId ? { ...c, reasoningEffort: effort } : c,
      ),
    );
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

  resetSessionState() {
    setState({
      conversations: [],
      activeConversationId: null,
      messages: {},
      isLoading: false,
      error: null,
      retryingMessageId: null,
      isCompacting: false,
      pendingInput: null,
    });
  },

  // ============================================================================
  // Persistence
  // ============================================================================

  async persistMessage(message: Message) {
    const conversationId = state.activeConversationId;
    if (!conversationId) return;

    // Producer provenance: prefer an explicit value on the message, otherwise
    // fall back to the conversation's selected provider so historical reads
    // can attribute the row even before Phase 2 plumbs runtime state through
    // every send path.
    const convo = state.conversations.find((c) => c.id === conversationId);
    const provider =
      message.role === "user"
        ? null
        : (message.provider ?? convo?.selectedProvider ?? null);

    try {
      await saveMessageDb(
        message.id,
        conversationId,
        message.role,
        message.content,
        message.model ?? null,
        message.timestamp,
        undefined,
        provider,
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
      const rows = await listConversations({ kind: "chat" });
      const conversations = rows.map(unifiedRowToConversation);

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
            provider: m.provider ?? undefined,
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
   * Counts attached images so multimodal chats don't under-read the gauge. #2105.
   */
  shouldCompact(thresholdPercent: number): boolean {
    const limit = getModelContextLimit(this.selectedModel);
    if (limit <= 0) return false;
    const tokens = estimateActiveChatRequestTokens({
      conversationId: state.activeConversationId,
      messages: this.messages,
      compactedSummary: this.compactedSummary,
    });
    return (tokens / limit) * 100 >= thresholdPercent;
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
      // Use the active conversation's bound provider/model to compact so
      // the thread's selected runtime — not a global default — produces
      // the summary.
      const activeConvo = state.conversations.find(
        (c) => c.id === conversationId,
      );

      // Token-budgeted boundary instead of a fixed preserve count: keep the
      // recent tail by token budget so one oversized message can't overflow
      // the model after compaction, and lightweight chats keep more of their
      // tail when the budget allows. The latest user message is always
      // anchored into the preserved tail. #2104.
      const items: CompactionWindowItem[] = messages.map((m) => ({
        tokens: estimateAccountedMessageTokens(accountedChatMessage(m)),
        role:
          m.role === "user" || m.role === "assistant" || m.role === "system"
            ? m.role
            : "other",
        groupId: null,
      }));
      const tailWindow = selectCompactionWindow(items, {
        contextLimit: getModelContextLimit(
          activeConvo?.selectedModel ?? this.selectedModel,
        ),
        minTailMessages: 2,
      });
      const toCompact = messages.slice(0, tailWindow.cutIndex);
      let toPreserve = messages.slice(tailWindow.cutIndex);

      // Act on the soft-ceiling flag (#2113). When the anchored tail itself
      // exceeds the budget, summarizing the prefix cannot clear it — so prune
      // the tail's reducible payloads (stale media) in place. Plain user text is
      // never truncated, so a verbatim oversized message can stay over budget;
      // surface that instead of silently leaving the context gauge pegged.
      if (tailWindow.overBudget) {
        const relief = relieveOverBudgetTail(
          toPreserve.map((m) => ({
            id: m.id,
            role:
              m.role === "user" || m.role === "assistant" || m.role === "system"
                ? m.role
                : "other",
            content: m.content,
            imageParts: m.images?.length ?? 0,
          })),
          tailWindow.tailBudget,
        );
        toPreserve = toPreserve.map((m, i) => {
          const pruned = relief.messages[i];
          if ((m.images?.length ?? 0) > 0 && (pruned.imageParts ?? 0) === 0) {
            return { ...m, images: [], content: pruned.content };
          }
          return m;
        });
        console.log(
          `[chatStore] over-budget tail pruned ${relief.tailTokensBefore}->${relief.tailTokensAfter} tokens`,
        );
        if (relief.stillOverBudget) {
          console.warn(
            "[chatStore] preserved tail still exceeds budget after pruning (irreducible content) — gauge may stay elevated",
          );
        }
      }

      if (toCompact.length === 0) {
        if (tailWindow.overBudget) {
          // No older prefix to summarize, but the tail relief above shrank
          // reducible payloads — persist it so the gauge reflects the drop.
          setState("messages", conversationId, toPreserve);
          console.log(
            "[chatStore] no compactable prefix; persisted pruned over-budget tail",
          );
        } else {
          // The whole tail fits the budget — usage is low enough that there is
          // nothing worth compacting this pass.
          console.log(
            "[chatStore] Token budget preserves the whole tail — nothing to compact",
          );
        }
        return;
      }

      // Carry the prior compacted summary forward so a second (or later)
      // compaction iteratively updates it instead of rebuilding from only
      // the newest window — otherwise context summarized by an earlier
      // compaction silently disappears. #2103.
      const previousSummary = activeConvo?.compactedSummary?.content ?? null;

      // Pre-prune the compacted history before summarization: strip stale image
      // payloads outside the latest media-bearing turn so multimodal chats feed
      // a leaner transcript into the summarizer. #2105.
      const prunable: PrunableMessage[] = toCompact.map((m) => ({
        id: m.id,
        role:
          m.role === "user" || m.role === "assistant" || m.role === "system"
            ? m.role
            : "other",
        content: m.content,
        imageParts: m.images?.length ?? 0,
      }));
      const pruned = pruneCompactedHistory(prunable, {
        protectedFromIndex: prunable.length,
      });
      const newTurns = pruned.messages
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n\n");
      const summaryPrompt = buildIterativeCompactionPrompt({
        previousSummary,
        newTurns,
        mode: "chat",
        maxTokens: 200,
      });

      const selectedProvider = activeConvo?.selectedProvider ?? null;
      const compactionProvider: ProviderId = isChatProvider(selectedProvider)
        ? selectedProvider
        : providerStore.activeProvider;

      // Resilient policy (#2106): primary attempt, auth-refresh retry, then a
      // deterministic local summary. On abort the messages are NOT replaced —
      // the conversation is kept intact (no-drop) and a cooldown backs the
      // auto-compact trigger off the failing summarizer. The conversation's
      // bound model/provider is single-sourced, so there is no safe alternate
      // chat model to try; the deterministic fallback covers provider outages.
      const summaryOutcome = await runSummarizerWithPolicy({
        primaryModel: activeConvo?.selectedModel ?? this.selectedModel,
        attempt: (model) =>
          sendMessage(summaryPrompt, model, compactionProvider, undefined),
        isAuthError: (e) =>
          isLikelyAuthError(e instanceof Error ? e.message : String(e)),
        refreshAuth: refreshAccessToken,
        deterministicFallback: () =>
          buildDeterministicFallbackSummary(prunable),
      });

      if (summaryOutcome.status === "aborted") {
        compactionCooldown.enter(conversationId, Date.now());
        setState(
          "error",
          "Compaction paused — the summarizer is unavailable. Your conversation is intact.",
        );
        console.warn(
          `[chatStore] compaction aborted (no-drop): ${summaryOutcome.reason}`,
        );
        return;
      }
      if (summaryOutcome.status === "fallback") {
        compactionCooldown.enter(conversationId, Date.now());
        console.warn(
          `[chatStore] using deterministic local summary: ${summaryOutcome.reason}`,
        );
      }
      const summary = summaryOutcome.summary;

      const preCompactionMessages: PreCompactionMessage[] = toCompact
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          type: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.timestamp,
        }));

      // Track summary lineage so repeated compactions are observably
      // iterative and the carried-forward summary can be verified. #2103.
      const lineage = buildSummaryLineage({
        previousLineage: activeConvo?.compactedSummary?.lineage ?? null,
        previousSummary,
        compactedMessageCount: toCompact.length,
        now: Date.now(),
      });

      // Create the compacted summary
      const compactedSummary: CompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: lineage.compactedAt,
        preCompactionMessages,
        lineage,
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

    // Back off auto-compaction after a recent summarizer failure so we don't
    // call a failing summarizer on every message. Manual compaction is not
    // gated — the user asked for it explicitly. #2106.
    const conversationId = state.activeConversationId;
    if (
      conversationId &&
      compactionCooldown.isCoolingDown(conversationId, Date.now())
    ) {
      return;
    }

    if (this.shouldCompact(threshold)) {
      await this.compactConversation(preserveCount);
    }
  },
};

export type { Message };
export const MAX_CHAT_MESSAGES = MAX_MESSAGES_PER_CONVERSATION;
