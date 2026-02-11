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

/** Maps agent type to the best available Seren chat model. */
const FALLBACK_MODELS: Record<AgentType, string> = {
  "claude-code": "anthropic/claude-opus-4.5",
  codex: "openai/gpt-5",
};

/**
 * Get the fallback chat model for the given agent type.
 */
export function getFallbackModel(agentType: AgentType): string {
  return FALLBACK_MODELS[agentType] ?? "anthropic/claude-opus-4.5";
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
export function buildRedirectMessage(agentType: AgentType): UnifiedMessage {
  const agentName = agentType === "codex" ? "Codex" : "Claude Code";
  const modelName = agentType === "codex" ? "GPT-5" : "Claude Opus 4.5";

  return {
    id: crypto.randomUUID(),
    type: "reroute",
    role: "system",
    content:
      `${agentName} agent hit its rate limit. ` +
      `Your conversation has been moved here so you can continue in Chat with ${modelName}. ` +
      "Pick up where you left off — your full history is preserved above.",
    timestamp: Date.now(),
    status: "complete",
    workerType: "orchestrator",
  };
}

/**
 * Orchestrate the full agent-to-chat switchover.
 *
 * 1. Convert agent messages to UnifiedMessage[]
 * 2. Create a new chat conversation with the fallback model
 * 3. Import the message history + redirect notice
 * 4. Switch the UI from Agent → Chat mode
 * 5. Set the provider/model selection to the fallback model
 *
 * Returns the new conversation ID, or null if the switchover failed.
 */
export async function performRateLimitFallback(
  agentType: AgentType,
  agentMessages: AgentMessage[],
  sessionTitle?: string,
): Promise<string | null> {
  // Lazy imports to avoid circular dependency between stores
  const { conversationStore } = await import("@/stores/conversation.store");
  const { acpStore } = await import("@/stores/acp.store");
  const { providerStore } = await import("@/stores/provider.store");

  const fallbackModel = getFallbackModel(agentType);
  const agentName = agentType === "codex" ? "Codex" : "Claude";
  const title = sessionTitle || `${agentName} Agent (continued)`;

  try {
    // Create the chat conversation with the fallback model
    const conversation = await conversationStore.createConversationWithModel(
      title,
      fallbackModel,
    );

    // Convert and import agent history
    const unifiedMessages = agentMessagesToUnified(agentMessages);
    const redirectNotice = buildRedirectMessage(agentType);

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

    // Switch global model selection to the fallback
    providerStore.setActiveProvider("seren");
    providerStore.setActiveModel(fallbackModel);

    // Switch UI from Agent → Chat
    acpStore.setAgentModeEnabled(false);

    console.info(
      `[RateLimitFallback] Switched to chat: conversation=${conversation.id}, model=${fallbackModel}`,
    );

    return conversation.id;
  } catch (error) {
    console.error("[RateLimitFallback] Failed to perform fallback:", error);
    return null;
  }
}
