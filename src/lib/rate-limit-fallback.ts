// ABOUTME: Detects agent rate-limit errors and orchestrates fallback to Chat mode.
// ABOUTME: Converts agent messages to unified format and creates a chat conversation.

import type { AgentType } from "@/services/acp";
import type { AgentMessage } from "@/stores/acp.store";
import type { UnifiedMessage } from "@/types/conversation";

/** Patterns that indicate an agent has hit a rate limit. */
const RATE_LIMIT_PATTERNS = [
  "429",
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "limit exceeded",
  "hit your limit",
  "hit the limit",
  "exceeded your",
  "capacity",
  "try again later",
];

/**
 * Check whether an error message indicates a rate limit was hit.
 */
export function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Keywords extracted from agent model IDs mapped to their Seren chat equivalents.
 * Order matters — first match wins, so more specific patterns come first.
 */
const AGENT_TO_SEREN_MODEL: Array<[pattern: string, serenId: string]> = [
  ["opus-4", "anthropic/claude-opus-4.5"],
  ["opus", "anthropic/claude-opus-4.5"],
  ["sonnet-4", "anthropic/claude-sonnet-4"],
  ["sonnet", "anthropic/claude-sonnet-4"],
  ["haiku", "anthropic/claude-haiku-4.5"],
  ["gpt-5", "openai/gpt-5"],
  ["gpt-4o-mini", "openai/gpt-4o-mini"],
  ["gpt-4o", "openai/gpt-4o"],
  ["o1-mini", "openai/gpt-4o-mini"],
  ["o1", "openai/gpt-4o"],
  ["gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["gemini-2.5-flash", "google/gemini-2.5-flash"],
  ["gemini-3", "google/gemini-3-flash-preview"],
  ["gemini", "google/gemini-2.5-pro"],
];

/** Default Seren model per agent type when no match is found. */
const DEFAULT_SEREN_MODELS: Record<AgentType, string> = {
  "claude-code": "anthropic/claude-sonnet-4",
  codex: "openai/gpt-4o",
};

/**
 * Map an agent's current model ID to the equivalent Seren chat model ID.
 * Falls back to a sensible default for the agent type if no match.
 */
export function mapAgentModelToChat(
  agentModelId: string | undefined,
  agentType: AgentType,
): string {
  if (agentModelId) {
    const lower = agentModelId.toLowerCase();
    for (const [pattern, serenId] of AGENT_TO_SEREN_MODEL) {
      if (lower.includes(pattern)) {
        return serenId;
      }
    }
  }
  return DEFAULT_SEREN_MODELS[agentType] ?? "anthropic/claude-sonnet-4";
}

/**
 * Get a human-readable display name for a Seren model ID.
 */
export function getModelDisplayName(serenModelId: string): string {
  const names: Record<string, string> = {
    "anthropic/claude-opus-4.5": "Claude Opus 4.5",
    "anthropic/claude-sonnet-4": "Claude Sonnet 4",
    "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
    "openai/gpt-5": "GPT-5",
    "openai/gpt-4o": "GPT-4o",
    "openai/gpt-4o-mini": "GPT-4o Mini",
    "google/gemini-2.5-pro": "Gemini 2.5 Pro",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash",
    "google/gemini-3-flash-preview": "Gemini 3 Flash",
  };
  return names[serenModelId] ?? serenModelId;
}

/**
 * Convert agent messages into UnifiedMessage[] suitable for the chat conversation store.
 * Only user and assistant messages carry over — tool calls, diffs, and thoughts
 * are agent-specific artifacts that don't render in chat.
 */
export function agentMessagesToUnified(
  messages: AgentMessage[],
): UnifiedMessage[] {
  const unified: UnifiedMessage[] = [];

  for (const msg of messages) {
    if (msg.type === "user") {
      unified.push({
        id: msg.id,
        type: "user",
        role: "user",
        content: msg.content,
        timestamp: msg.timestamp,
        status: "complete",
        workerType: "acp_agent",
      });
    } else if (msg.type === "assistant") {
      unified.push({
        id: msg.id,
        type: "assistant",
        role: "assistant",
        content: msg.content,
        timestamp: msg.timestamp,
        status: "complete",
        workerType: "acp_agent",
        duration: msg.duration,
        cost: msg.cost,
      });
    }
  }

  return unified;
}

/**
 * Build the redirect notice shown at the top of the new chat conversation.
 */
export function buildRedirectMessage(
  agentType: AgentType,
  modelDisplayName: string,
): UnifiedMessage {
  const agentName = agentType === "codex" ? "Codex" : "Claude Code";

  return {
    id: crypto.randomUUID(),
    type: "reroute",
    role: "system",
    content:
      `${agentName} agent hit its rate limit. ` +
      `Your conversation has been moved here so you can continue in Chat with ${modelDisplayName}. ` +
      "Pick up where you left off — your full history is preserved above.",
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
  };
}

/**
 * Orchestrate the full agent-to-chat switchover.
 *
 * 1. Map the agent's current model to its Seren chat equivalent
 * 2. Convert agent messages to UnifiedMessage[]
 * 3. Create a new chat conversation with the matched model
 * 4. Import the message history + redirect notice
 * 5. Switch the UI from Agent → Chat mode
 *
 * Returns the new conversation ID, or null if the switchover failed.
 */
export async function performRateLimitFallback(
  agentType: AgentType,
  agentMessages: AgentMessage[],
  agentModelId?: string,
  sessionTitle?: string,
): Promise<string | null> {
  // Lazy imports to avoid circular dependency between stores
  const { conversationStore } = await import("@/stores/conversation.store");
  const { acpStore } = await import("@/stores/acp.store");
  const { providerStore } = await import("@/stores/provider.store");

  const chatModelId = mapAgentModelToChat(agentModelId, agentType);
  const modelDisplayName = getModelDisplayName(chatModelId);
  const agentName = agentType === "codex" ? "Codex" : "Claude";
  const title = sessionTitle || `${agentName} Agent (continued)`;

  try {
    // Create the chat conversation with the matched model
    const conversation = await conversationStore.createConversationWithModel(
      title,
      chatModelId,
    );

    // Convert and import agent history
    const unifiedMessages = agentMessagesToUnified(agentMessages);
    const redirectNotice = buildRedirectMessage(agentType, modelDisplayName);

    conversationStore.setMessages(conversation.id, [
      ...unifiedMessages,
      redirectNotice,
    ]);

    // Persist each message
    const currentActiveId = conversationStore.activeConversationId;
    conversationStore.setActiveConversation(conversation.id);
    for (const msg of [...unifiedMessages, redirectNotice]) {
      await conversationStore.persistMessage(msg);
    }
    // Restore active conversation if it changed during persistence
    if (currentActiveId !== conversation.id) {
      conversationStore.setActiveConversation(conversation.id);
    }

    // Switch global model selection to the matched model
    providerStore.setActiveProvider("seren");
    providerStore.setActiveModel(chatModelId);

    // Switch UI from Agent → Chat
    acpStore.setAgentModeEnabled(false);

    console.info(
      `[RateLimitFallback] Switched to chat: conversation=${conversation.id}, model=${chatModelId} (from agent model ${agentModelId ?? "unknown"})`,
    );

    return conversation.id;
  } catch (error) {
    console.error("[RateLimitFallback] Failed to perform fallback:", error);
    return null;
  }
}
