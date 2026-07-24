// ABOUTME: Pure compaction helpers — mutex, prune/prepend transforms, window defaults.
// ABOUTME: Behavior-preserving extraction from agent.store; no store state closure.

import type { PrunableMessage } from "@/lib/compaction/prune";
import type { AgentMessage } from "@/stores/agent.store";

/** Owner-aware global cap for predictive compaction. An archived run can
 * release its own slot immediately, but a stale completion from that run must
 * never release a newer thread's slot. */
export class PredictiveCompactMutex {
  private owner: { sessionId: string; generation: number } | null = null;
  private nextGeneration = 0;

  tryAcquire(
    sessionId: string,
  ): Readonly<{ sessionId: string; generation: number }> | null {
    if (this.owner !== null) return null;
    this.nextGeneration += 1;
    this.owner = { sessionId, generation: this.nextGeneration };
    return this.owner;
  }

  release(lease: Readonly<{ sessionId: string; generation: number }>): boolean {
    if (
      this.owner?.sessionId !== lease.sessionId ||
      this.owner.generation !== lease.generation
    ) {
      return false;
    }
    this.owner = null;
    return true;
  }

  releaseCurrentForAny(sessionIds: Iterable<string>): boolean {
    if (!this.owner) return false;
    for (const sessionId of sessionIds) {
      if (this.owner.sessionId === sessionId) {
        this.owner = null;
        return true;
      }
    }
    return false;
  }
}

/**
 * Outcome of an auto-compaction attempt. Callers use this to decide whether
 * to fall back to Seren Chat. Only `failed_catastrophic` fires the fallback;
 * transient or "no-op" outcomes keep the user inside the agent session.
 *
 * - `retried`: compaction succeeded AND the user's last prompt was re-sent.
 *   Returned by `compactAndRetry` only — `compactAgentConversation` never
 *   retries; that responsibility lives with the caller.
 * - `succeeded`: compaction succeeded, no prompt to retry.
 * - `skipped_nothing_to_compact`: message count is below `preserveCount`;
 *   the session was already too small to compact. Usually means a single
 *   message is gigantic — Chat fallback would not help.
 * - `cancelled`: a Stop / predictive-promotion teardown / other graceful
 *   cancel propagated up as "Task cancelled" while compaction or the
 *   retry was in flight. Not a defect — the error event handler's
 *   graceful-cancel branch already restores UI state. Chat fallback would
 *   be wrong, since the user's intent was to stop, not to switch modes.
 * - `failed_catastrophic`: unrecoverable failure (spawn failed, summary API
 *   threw after refresh, agent runtime broken). Chat fallback is correct.
 */
export type CompactionOutcome =
  | "retried"
  | "succeeded"
  | "skipped_nothing_to_compact"
  | "cancelled"
  | "failed_catastrophic";

/**
 * Return shape of `compactAgentConversation`. The new session id is plumbed
 * back to callers so they don't have to re-derive it by searching
 * `state.sessions` for a matching `conversationId` — that lookup falsely
 * fails for agents like Codex where `sessionId === conversationId` (#1757).
 *
 * `newSessionId` is set on reactive success (the post-compaction serving
 * session). On predictive success the standby id is stored on the parent
 * via `standbySessionId`; predictive callers consult that pointer instead.
 */
export type CompactAgentResult = {
  outcome: Exclude<CompactionOutcome, "retried">;
  newSessionId?: string;
};

export function prunableAgentMessage(m: AgentMessage): PrunableMessage {
  return {
    id: m.id,
    role:
      m.type === "user" || m.type === "assistant" || m.type === "tool"
        ? m.type
        : "other",
    content: m.content,
    toolResult: m.toolCall?.result,
    toolName: m.toolCall?.title,
    toolArgs: m.toolCall?.parameters
      ? JSON.stringify(m.toolCall.parameters)
      : undefined,
  };
}

export function applyPrunedAgentMessages(
  messages: AgentMessage[],
  pruned: PrunableMessage[],
): AgentMessage[] {
  return messages.map((m, i) => {
    const p = pruned[i];
    if (!p) return m;
    const next: AgentMessage = { ...m, content: p.content };
    if (m.toolCall) {
      let parameters = m.toolCall.parameters;
      if (p.toolArgs !== undefined) {
        try {
          parameters = JSON.parse(p.toolArgs) as Record<string, unknown>;
        } catch {
          parameters = m.toolCall.parameters;
        }
      }
      next.toolCall = {
        ...m.toolCall,
        parameters,
        ...(p.toolResult !== undefined ? { result: p.toolResult } : {}),
      };
    }
    return next;
  });
}

export function buildAgentCompactionPrepend(
  summary: string,
  toPreserve: AgentMessage[],
): string {
  // Tool messages can be enormous file contents / JSON dumps; user and
  // assistant text keep the original ceiling used by the long-standing
  // post-compaction prepend path.
  const MAX_MSG_CHARS = 2000;
  const MAX_TOOL_CHARS = 500;
  const preservedContext = toPreserve
    .map((m) => {
      if (m.type === "user" || m.type === "assistant") {
        const content =
          m.content.length > MAX_MSG_CHARS
            ? `${m.content.slice(0, MAX_MSG_CHARS)}... [truncated]`
            : m.content;
        if (m.type === "user") {
          return `<prior_user>${content}</prior_user>`;
        }
        return `<prior_assistant>${content}</prior_assistant>`;
      }
      if (m.type === "tool" && m.toolCall?.result) {
        const title = (m.toolCall.title || "tool").replace(/"/g, "'");
        const result = m.toolCall.result;
        const trimmed =
          result.length > MAX_TOOL_CHARS
            ? `${result.slice(0, MAX_TOOL_CHARS)}... [truncated]`
            : result;
        return `<prior_tool name="${title}">${trimmed}</prior_tool>`;
      }
      return null;
    })
    .filter((s): s is string => s !== null)
    .join("\n\n");
  return preservedContext
    ? `Prior work summary:\n${summary}\n\n<prior_messages>\n${preservedContext}\n</prior_messages>`
    : `Prior work summary:\n${summary}`;
}

/** Claude Code model IDs that ship a 1M-token context tier behind the
 * `[1m]` suffix. Bare IDs default to 200K — Anthropic gates the 1M tier on
 * the suffix, which the CLI translates into a `context-1m-2025-08-07` beta
 * header. The first promptComplete still upserts the CLI-reported window via
 * recordModelContextWindow, so this is just the cold-start default. #1761. */
const CLAUDE_1M_TIER_CAPABLE_MODELS = new Set([
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-7",
]);

export function defaultContextWindowFor(
  agentType: string,
  modelId?: string,
): number {
  if (agentType === "codex") return 1_000_000;
  if (agentType === "gemini") return 1_000_000;
  if (agentType === "grok") return 1_000_000;
  if (agentType === "lmstudio") return 128_000;
  // Paired threads gauge against the planner (Claude defaults to the 1M
  // tier); the runtime-reported contextWindow corrects this per turn.
  if (agentType === "claude-codex") return 1_000_000;
  if (agentType === "claude-code" && modelId) {
    if (/\[1m\]$/i.test(modelId)) {
      const stripped = modelId.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
      if (CLAUDE_1M_TIER_CAPABLE_MODELS.has(stripped)) return 1_000_000;
    }
  }
  return 200_000;
}
