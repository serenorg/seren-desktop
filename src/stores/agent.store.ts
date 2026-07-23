// ABOUTME: Reactive provider-runtime state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createEffect, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  extractEvidenceFromAgentMessages,
  type FinalizationEvidence,
  type FinalOutputValidationReport,
  type ToolEvidence,
  validateFinalOutput,
} from "@/lib/agent-output-validation";
import { shouldLogAgentRuntimeEvent } from "@/lib/agent-runtime-debug";
import {
  disconnectLocalProviderRuntime,
  isLocalProviderRuntime,
  onRuntimeEvent,
} from "@/lib/browser-local-runtime";
import { isGeneratedPromptPrimer } from "@/lib/chat-history-export";
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
import { estimateAccountedMessageTokens } from "@/lib/compaction/token-accounting";
import {
  type CompactionWindowItem,
  selectCompactionWindow,
} from "@/lib/compaction/window";
import { openExternalLink } from "@/lib/external-link";
import { runtimeHasCapability } from "@/lib/runtime";
import { verboseRuntimeConsole } from "@/lib/runtime-console";
import { estimateTokens } from "@/lib/token-counter";
import { getEnabledMcpServers, settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

/** Per-session ready promises — resolved when backend emits "ready" status */
const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

/** Conversations with a spawn currently in progress. Prevents double-spawn
 *  when selectThread fires twice before the first spawn registers the session. */
const spawningConversations = new Set<string>();

/** Conversations with a live-session re-attach currently in progress.
 *  Multiple resume triggers can race before the adopted session reaches state. */
const reattachingConversations = new Map<string, Promise<boolean>>();

/** Session IDs that have been explicitly terminated. The global event subscriber
 *  drops events for these IDs to prevent stale errors from dead sessions leaking
 *  into new/live sessions. Cleared when the global subscriber is torn down. */
const terminatedSessionIds = new Set<string>();

/**
 * Monotonic fence for Happy-origin archives. Async list/spawn/reattach work
 * captures an epoch before it starts and may only commit while that epoch is
 * still current and the conversation is not tombstoned.
 */
export class HappyArchiveFence {
  private readonly entries = new Map<
    string,
    { generation: number; archived: boolean }
  >();

  capture(conversationId: string): number {
    return this.entries.get(conversationId)?.generation ?? 0;
  }

  archive(conversationId: string): number {
    const current = this.entries.get(conversationId);
    if (current?.archived) return current.generation;
    const generation = (current?.generation ?? 0) + 1;
    this.entries.set(conversationId, { generation, archived: true });
    return generation;
  }

  isArchived(conversationId: string): boolean {
    return this.entries.get(conversationId)?.archived === true;
  }

  allows(conversationId: string, capturedGeneration: number): boolean {
    const current = this.entries.get(conversationId);
    return (
      (current?.generation ?? 0) === capturedGeneration &&
      current?.archived !== true
    );
  }

  filterVisible<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => !this.isArchived(row.id));
  }
}

const happyArchiveFence = new HappyArchiveFence();

/** Exact provider sessions archived before a conversation owner was durable.
 * Kept separate from conversation fences so an unowned standby cannot evict
 * its healthy serving sibling. */
const happyProviderArchiveTombstones = new Set<string>();

/** Session IDs that the agent store just terminated programmatically. The
 *  runtime emits "Session terminated before request completed." (and other
 *  death-string `provider://error` events) when in-flight control requests
 *  reject during a programmatic kill — those are self-inflicted and must
 *  not surface as user-visible chat errors. The error handler short-circuits
 *  death-string events for ids in this set. Cleared at the end of
 *  terminateSession after the IPC kill completes. #1852. */
const expectedTerminateSessionIds = new Set<string>();

/** Lazy getter for the user's current navigation target, registered by
 *  thread.store. `getIdleClaudeSessionIds` consults this so a parallel spawn's
 *  preemptive idle-reclaim never targets the conversation the user is viewing —
 *  even when `state.activeSessionId` has not yet been updated for that thread.
 *  thread.store -> agent.store is the existing import direction; the reverse
 *  would cycle, so we use a registration callback instead. #1852. */
let activeNavigationThreadIdGetter: (() => string | null) | null = null;
export function registerActiveNavigationThreadIdGetter(
  getter: () => string | null,
): void {
  activeNavigationThreadIdGetter = getter;
}

/** Lightweight context for sessions that are mid-spawn (IPC call in flight).
 *  Populated before providerService.spawnAgent and cleaned up after the session
 *  is registered in state.sessions. The global event logger consults this map
 *  so early events show the correct agent type and conversation ID. */
const spawnContextMap = new Map<
  string,
  { agentType: string; conversationId?: string }
>();

/** Max time to wait for a session to become ready before giving up */
const SESSION_READY_TIMEOUT_MS = 30_000;

/**
 * Predictive-compaction trigger: fire when input tokens hit this fraction
 * of the agent's context window. Hard-coded — not exposed as a setting. #1631.
 */
export const PREDICTIVE_COMPACT_THRESHOLD = 0.7;

/**
 * Reactive compaction's last-ditch message-count guard. When the configured
 * `autoCompactPreserveMessages` leaves nothing to summarize (short session,
 * heavy per-message token cost), `compactAndRetry` retries with this lower
 * guard so the token-budgeted window selector can run on the session at all.
 * #2031.
 */
const AGGRESSIVE_RETRY_PRESERVE_COUNT = 2;

/**
 * Tail budget used on the aggressive retry. A tighter fraction of the context
 * window than the default so the post-compaction tail shrinks hard when an
 * earlier compaction (or the configured count) still left the prompt too
 * long. Replaces the old fixed retry preserve count with a token budget. #2104.
 */
const AGGRESSIVE_RETRY_TAIL_RATIO = 0.15;

/**
 * Primary and fallback models for the compaction summarizer. Both route through
 * the public "seren" provider. The fallback is tried when the primary errors,
 * times out, or returns an invalid summary, before the deterministic local
 * fallback. #2106.
 */
const SUMMARY_PRIMARY_MODEL = "anthropic/claude-sonnet-4";
// Fast, cheap model recognized by the seren provider catalog — ideal for a
// fallback summarizer. A model id outside the catalog/migration map would be
// rejected by the gateway, dead-ending the fallback tier before the
// deterministic local summary. #2111.
const SUMMARY_FALLBACK_MODELS = ["anthropic/claude-haiku-4.5"];

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
 * Global cap = 1 simultaneous predictive compaction across the whole app.
 * Prevents 3x Sonnet 4 calls and 3x Node subprocesses when multiple threads
 * cross the threshold in the same promptComplete tick. #1631.
 */
const predictiveCompactMutex = new PredictiveCompactMutex();

/**
 * Per-thread restart-timer handles. Cleared when the turn produces its
 * first stream chunk or when a terminal error flips the bubble. #1631.
 */
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Invisibility-budget constants per restart-dependent scenario (#1631). */
export const BUDGET_COLD_START_MS = 60_000;
export const BUDGET_REACTIVE_COMPACT_MS = 90_000;
export const BUDGET_CRASH_MS = 60_000;

/**
 * Predictive-compaction failure classifier (#1741). Errors thrown inside
 * `kickPredictiveCompact` fall into two buckets: transient races (spawn
 * returned null, "Session not found" mid-compaction, etc.) that the user
 * never notices, and structural CLI rejections that are 100% repro on the
 * affected install (model-poison from #1739, missing CLI binary, missing
 * parent transcript JSONL). The blanket downgrade in #152 silenced both.
 * This regex matches the structural class so those — and only those —
 * escalate to `captureSupportError` and open a serenorg/seren-core ticket.
 * Add new patterns here when a new structural failure mode is identified.
 */
export const PREDICTIVE_STRUCTURAL_FAILURE_RE =
  /issue with the selected model|model.*not exist|ENOENT|schema_drift|Parent JSONL transcript not found/i;

/**
 * Instruction prepended to every agent session telling Claude Code / Codex
 * that the Seren MCP gateway exists and MUST be queried live before refusing
 * any third-party service. Intentionally does NOT embed a snapshot of
 * publisher slugs — snapshots go stale at cold-start when the gateway's
 * discovery is still in-flight, and the agent then confidently refuses real
 * publishers while telling itself it's following instructions (#1622).
 */
export const PUBLISHER_LIVE_QUERY_INSTRUCTION =
  "You have access to a Seren MCP gateway with callable publishers via " +
  "your seren-mcp tools (list_agent_publishers, call_publisher). Before " +
  "stating that any third-party service (Google Docs, Gmail, GitHub, " +
  "Slack, Notion, Linear, Figma, and many others) is unavailable, you " +
  "MUST call list_agent_publishers with NO arguments to get the current " +
  "live publisher list — publishers are added frequently and any list " +
  "you may have seen is stale. After confirming a publisher exists, " +
  "filter that returned list client-side, then use the publisher's tool " +
  "enumeration metadata and call_publisher to invoke it. A failed or empty " +
  "parameterized discovery call is not evidence that a publisher is absent. " +
  "Authorization or allowlist rejection means the publisher exists but access " +
  "is blocked; report that actionable state instead of calling it unavailable. " +
  "This live-query rule " +
  "overrides any prior belief about what tools you have.";

/**
 * Defensive re-prime threshold. The primary re-prime trigger is a signature
 * change on the resolved skills + publisher-instruction block (handled in
 * `buildPromptContext`); this threshold is a backstop for the case the
 * desktop cannot observe directly: the CLI agents (Claude Code, Codex)
 * expose a user-invoked `/compact` that summarizes their internal
 * conversation history, and the resulting summary may drop the priming
 * block we delivered earlier. `/compact` does not change `messages.length`
 * on this side, so the threshold does not fire on the first prompt after
 * compact — it fires only once the session has accrued this many messages
 * past the last prime, at which point we re-include the priming block as
 * insurance. Message cadence varies by agent: a chat-only turn adds ~2
 * messages, an agentic turn with several tool calls can add 6-10, so this
 * fires more aggressively for tool-heavy sessions.
 *
 * TODO(skills/system-prompt): a deeper fix is to deliver the priming block
 * as the runtime's system prompt at spawn time. System prompts survive
 * `/compact` in both CLIs, which would obviate this threshold. The change
 * lives in this repo's bundled provider runtime — for Claude Code, thread
 * a `systemPromptAppend` arg through `buildClaudeArgs` in
 * `src-tauri/embedded-runtime/provider-runtime/browser-local/claude-runtime.mjs`
 * and emit `--append-system-prompt`; for Codex, add the equivalent flag in
 * the inline spawn in `.../browser-local/providers.mjs`. Then plumb
 * `systemPromptAppend` through `provider_spawn` and skip the per-prompt
 * priming block on sessions that received it.
 */
const REPRIME_AFTER_MESSAGES = 30;

/**
 * First-turn skill priming must leave real room for the user's prompt, tool
 * schemas, and the model's response. If a large active-skill set would exceed
 * this safe input budget, buildPromptContext sends a compact manifest instead
 * of every full SKILL.md body. #1960.
 */
export const PROMPT_PRIMING_CONTEXT_BUDGET_FRACTION = 0.8;
export const PROMPT_PRIMING_RESERVED_OUTPUT_TOKENS = 8_000;

function estimatePromptContextTokens(
  prompt: string | undefined,
  context: Array<Record<string, string>>,
): number {
  const contextText = context
    .flatMap((entry) => Object.values(entry))
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n\n");
  return estimateTokens(`${prompt ?? ""}\n\n${contextText}`);
}

/** Await a session ready promise with a timeout to prevent infinite hangs */
function waitForSessionReady(sessionId: string): Promise<void> {
  // Note: this only resolves the initial ready promise set up in spawnSession.
  // Use waitForSessionIdle for post-seed-prompt readiness.
  const entry = sessionReadyPromises.get(sessionId);
  if (!entry) return Promise.resolve();
  return Promise.race([
    entry.promise,
    new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Session ${sessionId} did not become ready within ${SESSION_READY_TIMEOUT_MS}ms`,
            ),
          ),
        SESSION_READY_TIMEOUT_MS,
      ),
    ),
  ]);
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
type CompactAgentResult = {
  outcome: Exclude<CompactionOutcome, "retried">;
  newSessionId?: string;
};

/** Maximum time sendPrompt waits for a predictive standby's seed prompt to
 * complete when the serving session is at critical context usage (#1675). */
const STANDBY_SEED_WAIT_MS = 5_000;

/** Wait for a standby session's seed prompt to complete (seedCompleted=true).
 * Returns true if the seed finished within the timeout, false otherwise.
 * Returns false immediately if the standby was removed (e.g. terminated).
 * #1675. */
async function waitForStandbySeed(
  standbyId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const standby = state.sessions[standbyId];
    if (!standby) return false;
    if (standby.seedCompleted === true) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return state.sessions[standbyId]?.seedCompleted === true;
}

/**
 * Read-and-clear the post-compaction prepend on a session. Returns the
 * prompt with the structured summary banner in front when a prepend is
 * pending, or the original prompt unchanged. Replaces the seed-prompt
 * mechanism — the model's first turn after compaction is the user's
 * actual prompt prefixed with restored context, not a meta-acknowledgement
 * round-trip that would persist in the on-disk JSONL. #1829.
 *
 * Both `sendPrompt` (predictive promotion / cold submit) and
 * `compactAndRetry` (reactive retry of the last failed prompt) call this.
 */
function consumeCompactionPrepend(sessionId: string, prompt: string): string {
  const session = state.sessions[sessionId];
  const prepend = session?.pendingCompactionPrepend;
  if (!prepend) return prompt;
  setState("sessions", sessionId, "pendingCompactionPrepend", undefined);
  return `[Auto-compaction restored prior context]\n${prepend}\n\n---\n\n${prompt}`;
}

function prunableAgentMessage(m: AgentMessage): PrunableMessage {
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

function applyPrunedAgentMessages(
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

function buildAgentCompactionPrepend(
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

/**
 * Drain the #1749 race-guard queue when a predictive standby finishes
 * warming. Pre-#1829 the seed-prompt path triggered this inside the standby's
 * first promptComplete handler. The synthetic and passive-prepend paths skip
 * the seed turn entirely (no promptComplete fires), so the drain has to be
 * triggered explicitly from compactAgentConversation. Without it, a prompt
 * the user enqueued during warm-up sits on the serving's pendingPrompts
 * until the next manual submit.
 *
 * Mirrors the body at the standby branch of the promptComplete handler.
 * Caller passes the standby's id; we pivot through the standbySessionId
 * backref to find the serving and drain its queue head onto its own
 * sendPrompt path (which will then find seedCompleted=true and promote).
 * #1829.
 */
function drainStandbyQueueIfPending(
  standbyId: string,
  doSendPrompt: (
    prompt: string,
    context?: Array<Record<string, string>>,
    options?: { displayContent?: string; docNames?: string[] },
    forSessionId?: string,
  ) => Promise<void>,
): void {
  let drainTarget: string | null = null;
  for (const [sid, s] of Object.entries(state.sessions)) {
    if (s.standbySessionId === standbyId && s.role === "serving") {
      if ((s.pendingPrompts ?? []).length > 0) {
        drainTarget = sid;
      }
    }
  }
  if (!drainTarget) return;
  const queue = state.sessions[drainTarget]?.pendingPrompts ?? [];
  const [nextPrompt, ...remaining] = queue;
  if (nextPrompt == null) return;
  setState("sessions", drainTarget, "pendingPrompts", remaining);
  console.info(
    `[AgentStore] Standby ${standbyId} ready — draining queued prompt on ${drainTarget} (#1749)`,
  );
  setTimeout(() => {
    void doSendPrompt(nextPrompt, undefined, undefined, drainTarget);
  }, 0);
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

function defaultContextWindowFor(agentType: string, modelId?: string): number {
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

import {
  type AgentThinkingMarkupParts,
  type AgentThinkingMarkupStreamState,
  consumeAgentThinkingMarkupChunk,
  createAgentThinkingMarkupStreamState,
  flushAgentThinkingMarkupRemainder,
} from "@/lib/agent-thinking-markup";
import { isLikelyAuthError } from "@/lib/auth-errors";
import { buildChatRequest, sendProviderMessage } from "@/lib/providers";
import {
  isPromptTooLongError,
  isRateLimitError,
  isTimeoutError,
  performAgentFallback,
} from "@/lib/rate-limit-fallback";
import { scrubAgentMarkup } from "@/lib/scrub-agent-markup";
import {
  benignConsoleError,
  captureSupportError,
  reportError,
} from "@/lib/support/hook";
import {
  claimHappyProviderSessionOwner,
  clearConversationHistory,
  createAgentConversation,
  type AgentConversation as DbAgentConversation,
  fenceHappyProviderSessionArchive,
  getAgentConversation,
  getMessages,
  listConversations,
  saveMessage,
  setAgentConversationMetadata as setAgentConversationMetadataDb,
  setAgentConversationModelId as setAgentConversationModelIdDb,
  setAgentConversationPermissionMode as setAgentConversationPermissionModeDb,
  setAgentConversationSessionId as setAgentConversationSessionIdDb,
  setAgentConversationTitle as setAgentConversationTitleDb,
  type UnifiedConversationRow,
} from "@/lib/tauri-bridge";
import { refreshAccessToken } from "@/services/auth";
import {
  type InterceptSuccessEvent as ClaudeMemoryInterceptSuccessEvent,
  claudeSessionExists,
  renderClaudeMemoryMd,
} from "@/services/claudeMemory";
import {
  createCredentialLease,
  revokeCredentialLease,
} from "@/services/credential-lease";
import {
  bootstrapMemoryContext,
  processAssistantResponseMemory,
  recallMemoryContext,
} from "@/services/memory";
import {
  getCachedModelContextWindow,
  recordModelContextWindow,
} from "@/services/modelContextCache";
import type {
  AgentEvent,
  AgentInfo,
  AgentSessionInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  PairedRole,
  PairedSpawnConfig,
  PairedStatus,
  PairedTranscriptEvent,
  PermissionRequestEvent,
  PlanEntry,
  ProviderOrigin,
  RemoteSessionInfo,
  SessionConfigOption,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/providers";
import * as providerService from "@/services/providers";
import { computeAgentOAuthRouting } from "@/services/publisher-oauth";
import { authStore, requestSignInModal } from "@/stores/auth.store";
import {
  oauthConnectionsRevision,
  oauthSelectionsRevision,
} from "@/stores/oauth-account.store";
import { privacyStore } from "@/stores/privacy.store";

/** Set once we've subscribed to `provider-runtime://ready` so repeated
 *  initialize() calls don't stack listeners. */
let providerRuntimeReadyListener: Promise<UnlistenFn> | null = null;

/** Set once we've subscribed to `provider-runtime://restarted` so repeated
 *  initialize() calls don't stack listeners. #1631. */
let providerRuntimeRestartedListener: Promise<UnlistenFn> | null = null;

/** Set once we've subscribed to remote Happy archive notifications so the
 *  sidebar and serving pointers cannot outlive the archived DB row. */
let agentConversationArchivedListener: Promise<UnlistenFn> | null = null;

/** Set once we've subscribed to `provider://cli-scan-rejected` so repeated
 *  initialize() calls don't stack listeners. #1646. */
let cliScanRejectedUnsub: (() => void) | null = null;

/** Set once we've subscribed to actionable CLI update/install failures. */
let cliUpdateActionRequiredUnsub: (() => void) | null = null;

/** Set once we've subscribed to `provider://synthetic-transcript-schema-drift`
 *  so a Claude CLI auto-update that breaks the splice invariants forces
 *  `compactSyntheticTranscript=false` at runtime. The per-call try/catch
 *  inside compactAgentConversation then falls back to passive prepend until
 *  the schema is reconciled. #1829. */
let syntheticSchemaDriftUnsub: (() => void) | null = null;

/** Set once we've subscribed to Rust Claude memory intercept events. */
let claudeMemoryInterceptedListener: Promise<UnlistenFn> | null = null;

let sessionResetGeneration = 0;
const CLAUDE_MEMORY_EVIDENCE_LIMIT = 20;
// Warm fast-path window for refreshing the Claude memory index before spawn.
// A responsive SerenDB renders the index well under this budget; a cold
// (scaled-to-zero) database takes far longer, so we cap the spawn wait here
// and let the render finish in the background instead of stalling the spawn.
const CLAUDE_MEMORY_RENDER_BEFORE_SPAWN_TIMEOUT_MS = 4_000;

function disposeTauriListener(
  listener: Promise<UnlistenFn> | null,
  label: string,
): void {
  if (!listener) return;
  void listener
    .then((unlisten) => unlisten())
    .catch((error) => {
      console.warn(`[AgentStore] Failed to dispose ${label} listener:`, error);
    });
}

function disposeAgentStoreSideChannelListeners(): void {
  const readyListener = providerRuntimeReadyListener;
  providerRuntimeReadyListener = null;
  disposeTauriListener(readyListener, "provider-runtime ready");

  const restartedListener = providerRuntimeRestartedListener;
  providerRuntimeRestartedListener = null;
  disposeTauriListener(restartedListener, "provider-runtime restarted");

  const archivedListener = agentConversationArchivedListener;
  agentConversationArchivedListener = null;
  disposeTauriListener(archivedListener, "agent-conversation archived");

  cliScanRejectedUnsub?.();
  cliScanRejectedUnsub = null;

  cliUpdateActionRequiredUnsub?.();
  cliUpdateActionRequiredUnsub = null;

  syntheticSchemaDriftUnsub?.();
  syntheticSchemaDriftUnsub = null;

  const claudeMemoryListener = claudeMemoryInterceptedListener;
  claudeMemoryInterceptedListener = null;
  disposeTauriListener(claudeMemoryListener, "claude-memory intercepted");
}

/** Commit an agent list into the store + settle the selected-agent fallback.
 *  Shared by `initialize()` and the `provider-runtime://ready` listener so
 *  they produce identical post-conditions. See GH #1587. */
function applyAgents(agents: providerService.AgentInfo[]): void {
  setState("availableAgents", agents);
  const currentAgent = agents.find(
    (agent) => agent.type === state.selectedAgentType,
  );
  if (!currentAgent?.available) {
    const fallbackAgent = agents.find((agent) => agent.available);
    if (fallbackAgent) {
      setState("selectedAgentType", fallbackAgent.type);
    }
  }
}

/** Subscribe once to `provider-runtime://ready` so late-arriving runtime
 *  startup (>backoff budget) still populates Codex/Gemini without a user
 *  reload. See GH #1587. */
function subscribeToProviderRuntimeReady(): void {
  if (providerRuntimeReadyListener) return;
  providerRuntimeReadyListener = listen(
    "provider-runtime://ready",
    async () => {
      try {
        const agents = await providerService.getAvailableAgents();
        if (agents.length > 0) {
          applyAgents(agents);
        }
        await hydratePendingCliUpdateAction();
      } catch (error) {
        console.error(
          "Failed to load agents on provider-runtime ready event:",
          error,
        );
      }
    },
  );
}

/**
 * Subscribe once to `provider-runtime://restarted`. The Rust monitor emits
 * this after the Node provider-runtime subprocess auto-restarts. We drop
 * every live session (all IDs belong to the dead process) and, for threads
 * with an in-flight turn, silently re-dispatch the last prompt on a fresh
 * spawn. Threads with no in-flight turn wait for the next user submit. #1631.
 */
function subscribeToProviderRuntimeRestarted(): void {
  if (providerRuntimeRestartedListener) return;
  providerRuntimeRestartedListener = listen(
    "provider-runtime://restarted",
    () => {
      console.info(
        "[AgentStore] provider-runtime://restarted — invalidating serving pointers",
      );
      const restartGeneration = sessionResetGeneration;
      const snapshot = Object.entries(state.sessions).map(([id, s]) => ({
        id,
        conversationId: s.conversationId,
        cwd: s.cwd,
        agentType: s.info.agentType,
        messages: s.messages,
        currentModelId: s.currentModelId,
      }));
      for (const { id } of snapshot) terminatedSessionIds.add(id);
      setState(
        produce((draft) => {
          for (const { id } of snapshot) delete draft.sessions[id];
        }),
      );
      setState("activeSessionId", null);

      for (const snap of snapshot) {
        void (async () => {
          // The provider runtime died, so its child can no longer use this
          // key. Revoke before a restart creates a fresh, per-session lease.
          await revokeCredentialLease(snap.id).catch((error) => {
            console.warn(
              "[AgentStore] Failed to revoke runtime-restart credential lease:",
              error,
            );
          });
          const ts = state.threadStates[snap.conversationId];
          if (!ts?.turnInFlight || !ts.lastPromptText) return;
          if (restartGeneration !== sessionResetGeneration) return;
          agentStore.armRestartTimer(
            snap.conversationId,
            BUDGET_CRASH_MS,
            "crash_ceiling",
          );
          const newId = await agentStore.spawnSession(
            snap.cwd,
            snap.agentType,
            {
              localSessionId: snap.conversationId,
              restoredMessages: snap.messages,
              initialModelId: snap.currentModelId,
            },
          );
          if (restartGeneration !== sessionResetGeneration) {
            if (newId) {
              await revokeCredentialLease(newId).catch((revokeError) => {
                console.warn(
                  "[AgentStore] Failed to revoke stale restart credential lease:",
                  revokeError,
                );
              });
              await providerService.terminateSession(newId).catch((error) => {
                console.warn(
                  "[AgentStore] Failed to terminate stale restart session:",
                  error,
                );
              });
            }
            return;
          }
          if (!newId) {
            agentStore.setTurnError(snap.conversationId, "crash_ceiling");
            return;
          }
          try {
            await agentStore.sendPrompt(
              ts.lastPromptText as string,
              ts.lastPromptContext,
              {
                displayContent: ts.lastPromptDisplay,
                docNames: ts.lastPromptDocNames,
              },
              newId,
            );
          } catch (err) {
            console.error("[AgentStore] crash re-dispatch failed:", err);
            agentStore.setTurnError(
              snap.conversationId,
              "crash_ceiling",
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      }
    },
  );
}

/**
 * Invalidate the frontend immediately after Rust archives an agent
 * conversation. A conversation may own more than one runtime session while a
 * predictive-compaction standby is warming, so every matching session must be
 * removed and tombstoned before a late runtime event can reach the UI.
 */
export function planHappyArchiveInvalidation(
  sessions: Record<
    string,
    {
      conversationId: string;
      role: "serving" | "standby";
      archiveOwnerConversationId?: string;
      standbySessionId?: string | null;
    }
  >,
  activeSessionId: string | null,
  conversationId: string,
): { archivedSessionIds: string[]; nextActiveSessionId: string | null } {
  const archivedSessionIdSet = new Set(
    Object.entries(sessions)
      .filter(
        ([, session]) =>
          session.conversationId === conversationId ||
          session.archiveOwnerConversationId === conversationId,
      )
      .map(([sessionId]) => sessionId),
  );
  // Include a registered warm standby even if it predates the explicit owner
  // field. The serving pointer is the durable sibling relationship until
  // promotion copies the persisted conversation id onto the standby.
  for (const sessionId of [...archivedSessionIdSet]) {
    const standbySessionId = sessions[sessionId]?.standbySessionId;
    if (standbySessionId && sessions[standbySessionId]) {
      archivedSessionIdSet.add(standbySessionId);
    }
  }
  const archivedSessionIds = [...archivedSessionIdSet];
  const nextActiveSessionId =
    activeSessionId && archivedSessionIdSet.has(activeSessionId)
      ? (Object.entries(sessions).find(
          ([sessionId, session]) =>
            !archivedSessionIdSet.has(sessionId) && session.role === "serving",
        )?.[0] ?? null)
      : activeSessionId;
  return { archivedSessionIds, nextActiveSessionId };
}

/**
 * Release the app-wide predictive-compaction mutex only when the archived
 * conversation owns the in-flight warmup. Clearing it for an unrelated
 * archive could allow a second compaction to start concurrently.
 */
export interface HappyArchivedSiblingRetirementResult {
  fenced: boolean;
  retired: boolean;
  forceKilled: boolean;
  lastError?: unknown;
}

/**
 * Retire a sibling of the Happy row archived on mobile. The durable local
 * fence is attempted before process teardown, and the PID-guarded Rust kill is
 * the immediate fallback when the provider runtime cannot service termination.
 */
export async function retireHappyArchivedSiblingProvider(
  sessionId: string,
  pid: number | null | undefined,
  operations: {
    fence: (sessionId: string) => Promise<void>;
    terminate: (sessionId: string) => Promise<void>;
    forceKill: (pid: number) => Promise<boolean>;
  },
): Promise<HappyArchivedSiblingRetirementResult> {
  let fenced = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !fenced; attempt += 1) {
    try {
      await operations.fence(sessionId);
      fenced = true;
    } catch (error) {
      lastError = error;
    }
  }

  try {
    await operations.terminate(sessionId);
    return { fenced, retired: true, forceKilled: false, lastError };
  } catch (error) {
    lastError = error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return { fenced, retired: true, forceKilled: false, lastError };
    }
  }

  if (pid != null) {
    try {
      const forceKilled = await operations.forceKill(pid);
      if (forceKilled) {
        return { fenced, retired: true, forceKilled: true, lastError };
      }
    } catch (error) {
      lastError = error;
    }
  }
  return { fenced, retired: false, forceKilled: false, lastError };
}

export function planHappyProviderArchiveInvalidation(
  sessions: Record<
    string,
    {
      role: "serving" | "standby";
      standbySessionId?: string | null;
    }
  >,
  activeSessionId: string | null,
  targetProviderSessionId: string,
): {
  archivedSessionIds: string[];
  linkedServingSessionIds: string[];
  nextActiveSessionId: string | null;
} {
  const linkedServingSessionIds = Object.entries(sessions)
    .filter(
      ([sessionId, session]) =>
        sessionId !== targetProviderSessionId &&
        session.role === "serving" &&
        session.standbySessionId === targetProviderSessionId,
    )
    .map(([sessionId]) => sessionId);
  const nextActiveSessionId =
    activeSessionId === targetProviderSessionId
      ? (Object.entries(sessions).find(
          ([sessionId, session]) =>
            sessionId !== targetProviderSessionId && session.role === "serving",
        )?.[0] ?? null)
      : activeSessionId;
  return {
    archivedSessionIds: [targetProviderSessionId],
    linkedServingSessionIds,
    nextActiveSessionId,
  };
}

function subscribeToAgentConversationArchived(): void {
  if (agentConversationArchivedListener) return;
  agentConversationArchivedListener = listen<
    | string
    | {
        conversationId: string | null;
        targetProviderSessionId: string;
      }
  >("happy-bridge://conversation-archived", (event) => {
    const payload = event.payload;
    const conversationId =
      typeof payload === "string" ? payload : payload?.conversationId;
    const targetProviderSessionId =
      typeof payload === "object" &&
      payload !== null &&
      typeof payload.targetProviderSessionId === "string"
        ? payload.targetProviderSessionId
        : null;
    if (targetProviderSessionId) {
      happyProviderArchiveTombstones.add(targetProviderSessionId);
    }
    if (
      (typeof conversationId !== "string" || conversationId.length === 0) &&
      targetProviderSessionId
    ) {
      const {
        archivedSessionIds,
        linkedServingSessionIds,
        nextActiveSessionId,
      } = planHappyProviderArchiveInvalidation(
        state.sessions,
        state.activeSessionId,
        targetProviderSessionId,
      );
      terminatedSessionIds.add(targetProviderSessionId);
      sessionReadyPromises.get(targetProviderSessionId)?.resolve();
      sessionReadyPromises.delete(targetProviderSessionId);
      pendingSessionEvents.delete(targetProviderSessionId);
      spawnContextMap.delete(targetProviderSessionId);
      recoveryInFlightMap.delete(targetProviderSessionId);
      clearChunkBuf(targetProviderSessionId);
      clearToolEventBuf(targetProviderSessionId);

      setState("pendingPermissions", (items) =>
        items.filter((item) => item.sessionId !== targetProviderSessionId),
      );
      setState("pendingDiffProposals", (items) =>
        items.filter((item) => item.sessionId !== targetProviderSessionId),
      );
      setState(
        produce((draft) => {
          for (const sessionId of archivedSessionIds) {
            delete draft.sessions[sessionId];
          }
          for (const sessionId of linkedServingSessionIds) {
            const serving = draft.sessions[sessionId];
            if (!serving) continue;
            serving.standbySessionId = null;
            serving.predictiveCompactInFlight = false;
          }
        }),
      );
      if (linkedServingSessionIds.length > 0) {
        predictiveCompactMutex.releaseCurrentForAny(linkedServingSessionIds);
        for (const servingSessionId of linkedServingSessionIds) {
          agentStore.drainAfterPredictiveAbort(servingSessionId);
        }
      }
      if (state.activeSessionId !== nextActiveSessionId) {
        setState("activeSessionId", nextActiveSessionId);
      }
      return;
    }
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return;
    }

    // Fence first: async refresh/resume work that started before this event
    // must observe the tombstone before it can commit any late result.
    happyArchiveFence.archive(conversationId);

    setState("recentAgentConversations", (rows) =>
      rows.filter((row) => row.id !== conversationId),
    );

    const { archivedSessionIds, nextActiveSessionId } =
      planHappyArchiveInvalidation(
        state.sessions,
        state.activeSessionId,
        conversationId,
      );
    const archivedSessionIdSet = new Set(archivedSessionIds);
    for (const sessionId of archivedSessionIds) {
      const archivedSession = state.sessions[sessionId];
      terminatedSessionIds.add(sessionId);
      sessionReadyPromises.get(sessionId)?.resolve();
      sessionReadyPromises.delete(sessionId);
      pendingSessionEvents.delete(sessionId);
      spawnContextMap.delete(sessionId);
      recoveryInFlightMap.delete(sessionId);
      clearChunkBuf(sessionId);
      clearToolEventBuf(sessionId);
      // Happy retires the provider that originated this archive. Reap every
      // other planned sibling explicitly, including a standby that was
      // promoted to serving while the old provider was winding down. Keep
      // the legacy-string fallback narrow for rolling upgrades.
      const shouldTerminateSibling = targetProviderSessionId
        ? sessionId !== targetProviderSessionId
        : archivedSession?.role === "standby";
      if (shouldTerminateSibling) {
        expectedTerminateSessionIds.add(sessionId);
        void retireHappyArchivedSiblingProvider(
          sessionId,
          archivedSession?.info.pid,
          {
            fence: fenceHappyProviderSessionArchive,
            terminate: async (providerSessionId) => {
              await revokeCredentialLease(providerSessionId).catch((error) => {
                console.warn(
                  "[AgentStore] Failed to revoke archived Happy sibling credential lease:",
                  error,
                );
              });
              return providerService.terminateSession(providerSessionId, {
                timeoutMs: 5_000,
              });
            },
            forceKill: providerService.forceKillSession,
          },
        )
          .then((result) => {
            if (!result.fenced) {
              console.error(
                "[AgentStore] Failed to persist archived Happy sibling fence:",
                result.lastError,
              );
            }
            if (!result.retired) {
              console.error(
                "[AgentStore] Failed to retire archived Happy sibling:",
                result.lastError,
              );
            }
          })
          .finally(() => expectedTerminateSessionIds.delete(sessionId));
      }
    }
    const restartTimer = restartTimers.get(conversationId);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimers.delete(conversationId);
    pairedConfigPersisted.delete(conversationId);

    setState("pendingPermissions", (items) =>
      items.filter((item) => !archivedSessionIdSet.has(item.sessionId)),
    );
    setState("pendingDiffProposals", (items) =>
      items.filter((item) => !archivedSessionIdSet.has(item.sessionId)),
    );

    setState(
      produce((draft) => {
        for (const sessionId of archivedSessionIds) {
          delete draft.sessions[sessionId];
        }
        delete draft.threadStates[conversationId];
        delete draft.persistedMessages[conversationId];
      }),
    );

    predictiveCompactMutex.releaseCurrentForAny(archivedSessionIds);

    if (state.activeSessionId !== nextActiveSessionId) {
      setState("activeSessionId", nextActiveSessionId);
    }
  });
}

function subscribeToClaudeMemoryIntercepts(): void {
  if (claudeMemoryInterceptedListener) return;
  claudeMemoryInterceptedListener = listen<ClaudeMemoryInterceptSuccessEvent>(
    "claude-memory-intercepted",
    (event) => {
      const payload = event.payload;
      if (!payload?.path) return;

      for (const [sessionId, session] of Object.entries(state.sessions)) {
        if (!usesClaudeMemory(session.info.agentType)) continue;
        if (!isClaudeMemoryPathForCwd(payload.path, session.cwd)) continue;

        const evidence: ToolEvidence = {
          id: `claude-memory:${sessionId}:${Date.now()}:${payload.path}`,
          name: "claude_memory_interceptor",
          title: "Claude Memory Interceptor",
          kind: "database",
          status: "completed",
          result: [
            "Persisted Claude memory to claude_agent_preferences",
            `source=${payload.path}`,
            payload.rendered_memory_md
              ? `memory_md=${payload.rendered_memory_md}`
              : null,
            payload.render_error
              ? `render_error=${payload.render_error}`
              : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join("; "),
          isError: false,
        };

        setState("sessions", sessionId, "claudeMemoryWriteEvidence", (prev) =>
          [...(prev ?? []), evidence].slice(-CLAUDE_MEMORY_EVIDENCE_LIMIT),
        );
      }
    },
  );
}

/**
 * Subscribe once to provider://cli-scan-rejected so the CLI auto-updater's
 * security gate (#1647) is never silent. The user stays on their previous
 * known-good version; we record the rejection in store state for any
 * diagnostics panel and fire a system notification per #1646.
 *
 * The subscription is idempotent — subscribeToCliScanRejections is safe to
 * call from initialize() across repeated runtime restarts.
 */
function subscribeToCliScanRejections(): void {
  if (cliScanRejectedUnsub) return;
  cliScanRejectedUnsub = onRuntimeEvent(
    "provider://cli-scan-rejected",
    (payload) => {
      const event = payload as {
        label?: string;
        packageName?: string;
        from?: string | null;
        to?: string;
        flags?: string[];
      };
      if (!event.packageName || !event.to) return;
      const rejection = {
        label: event.label ?? event.packageName,
        packageName: event.packageName,
        from: event.from ?? null,
        to: event.to,
        flags: Array.isArray(event.flags) ? event.flags : [],
        at: Date.now(),
      };
      setState("cliScanRejection", rejection);
      // Default-on local log line so the rejection lands in the user-
      // facing app log file even if the UI surface gets dismissed.
      console.warn(
        `[cli-updater] scan rejected for ${rejection.packageName} v${rejection.to}; flags=${rejection.flags.join(",")}`,
      );
      // System notification — minimum surface required by #1646. Falls
      // back silently when the platform denies permission.
      try {
        if (typeof Notification !== "undefined") {
          if (Notification.permission === "granted") {
            new Notification("Seren blocked a CLI update", {
              body: `${rejection.label} ${rejection.to} was rejected by the local supply-chain scanner. You stay on your previous version.`,
            });
          } else if (Notification.permission !== "denied") {
            void Notification.requestPermission().then((perm) => {
              if (perm === "granted") {
                new Notification("Seren blocked a CLI update", {
                  body: `${rejection.label} ${rejection.to} was rejected by the local supply-chain scanner. You stay on your previous version.`,
                });
              }
            });
          }
        }
      } catch {
        // Silent — best-effort surface, never fail the subscriber.
      }
    },
  );
}

/**
 * Surface verified-updater failures with a recoverable in-app action. Runtime
 * persistence deduplicates these events to one CLI/version per update TTL.
 */
function applyCliUpdateAction(payload: unknown, notify = true): void {
  const event = payload as Partial<providerService.CliUpdateActionRequired>;
  if (event.bareCommand !== "claude" && event.bareCommand !== "codex") {
    return;
  }
  const bareCommand = event.bareCommand;
  const expectedPackage =
    bareCommand === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
  const expectedInstructionsOrigin =
    bareCommand === "claude"
      ? "https://code.claude.com/"
      : "https://developers.openai.com/";
  const officialInstructionsUrl = event.officialInstructionsUrl;
  if (
    event.packageName !== expectedPackage ||
    typeof officialInstructionsUrl !== "string" ||
    !officialInstructionsUrl.startsWith(expectedInstructionsOrigin)
  ) {
    return;
  }
  if (
    state.cliUpdateActionRequired?.bareCommand === event.bareCommand &&
    state.cliUpdateActionRequired?.to === (event.to ?? null) &&
    state.cliUpdateActionRequired?.reason === event.reason
  ) {
    return;
  }
  const action = {
    label: event.label ?? event.packageName,
    bareCommand,
    packageName: event.packageName,
    from: event.from ?? null,
    to: event.to ?? null,
    reason: event.reason ?? "verification_required",
    officialInstructionsUrl,
    retrying: false,
    at: event.at ?? Date.now(),
  };
  setState("cliUpdateActionRequired", action);
  console.warn(
    `[cli-updater] action required for ${action.packageName}; reason=${action.reason}`,
  );
  try {
    if (
      notify &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      const notification = new Notification(`${action.label} needs attention`, {
        body: "Seren kept the previous verified version. Retry or review the official installation instructions in Seren.",
      });
      notification.onclick = () => {
        void openExternalLink(action.officialInstructionsUrl);
      };
    }
  } catch {
    // Best-effort OS notification; the in-app recovery card remains.
  }
}

async function hydratePendingCliUpdateAction(): Promise<void> {
  try {
    const action = await providerService.getPendingCliUpdateAction();
    if (action) applyCliUpdateAction(action, false);
  } catch {
    // Runtime startup retries will call this again after the ready event.
  }
}

function subscribeToCliUpdateActions(): void {
  if (cliUpdateActionRequiredUnsub) return;
  cliUpdateActionRequiredUnsub = onRuntimeEvent(
    "provider://cli-update-action-required",
    applyCliUpdateAction,
  );
}

/**
 * Subscribe once to `provider://synthetic-transcript-schema-drift`. Emitted
 * by `agent-registry.mjs` after a Claude CLI auto-update when
 * `runSyntheticTranscriptSelfCheck()` against a fixture detects that the
 * splice invariants no longer hold (uuid chain, sessionId rewrite,
 * record-shape). Force `compactSyntheticTranscript=false` so the next
 * compaction uses the passive-prepend path instead of throwing on every
 * call. The per-call try/catch already provides a runtime fallback; this
 * subscriber persists the off-state across the session so the user is not
 * paying the cost of a known-broken splice attempt every compaction. #1829.
 *
 * Idempotent — safe to call from initialize() across runtime restarts.
 */
function subscribeToSyntheticTranscriptSchemaDrift(): void {
  if (syntheticSchemaDriftUnsub) return;
  syntheticSchemaDriftUnsub = onRuntimeEvent(
    "provider://synthetic-transcript-schema-drift",
    (payload) => {
      const event = payload as {
        label?: string;
        from?: string | null;
        to?: string;
        reason?: string;
      };
      console.warn(
        `[compact.synthetic.schema_drift_disable] ${event.label ?? "Claude Code"} ${event.from ?? "?"} → ${event.to ?? "?"}: ${event.reason ?? "unknown"} — forcing compactSyntheticTranscript=false`,
      );
      settingsStore.set("compactSyntheticTranscript", false);
    },
  );
}

// ============================================================================
// Types
// ============================================================================

export interface AgentCompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
  /** Lineage across repeated compactions (#2103). Present from generation 1. */
  lineage?: SummaryLineage;
}

interface AgentConversationMetadata {
  pendingBootstrapPromptContext?: string;
  pendingBootstrapMessages?: AgentMessage[];
  /** Pinned Planner/Executor model + effort choices for paired threads. */
  pairedConfig?: PairedSpawnConfig;
}

export interface AgentMessage {
  id: string;
  type:
    | "user"
    | "assistant"
    | "thought"
    | "tool"
    | "diff"
    | "error"
    | "handoff";
  content: string;
  timestamp: number;
  toolCallId?: string;
  diff?: DiffEvent;
  toolCall?: ToolCallEvent;
  /** Duration in milliseconds for how long the response took */
  duration?: number;
  /** Total cost in SerenBucks for this message's query, reported by Gateway. */
  cost?: number;
  /** Verified Agent Output report for final assistant messages. */
  finalOutputValidation?: FinalOutputValidationReport;
  /** Names of documents processed via DocReader for this message. */
  docNames?: string[];
  /** Producer provenance — the agent type that emitted this message. */
  provider?: string;
  /** Prompt provenance for remote-control activity attribution. */
  origin?: ProviderOrigin;
}

export interface AgentModelInfo {
  modelId: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  supportsAdaptiveThinking?: boolean;
}

export interface AgentModeInfo {
  modeId: string;
  name: string;
  description?: string;
}

export interface ActiveSession {
  info: AgentSessionInfo;
  messages: AgentMessage[];
  plan: PlanEntry[];
  pendingToolCalls: Map<string, ToolCallEvent>;
  streamingContent: string;
  streamingThinking: string;
  /** Timestamp for current streaming assistant chunk buffer (ms epoch). */
  streamingContentTimestamp?: number;
  /** True when current streaming assistant content came from history replay. */
  streamingContentReplay?: boolean;
  /** Stable replay assistant message id for chunk/message boundaries. */
  streamingContentMessageId?: string;
  /** Stable SQLite row id for the in-flight assistant draft for this turn. */
  assistantDraftMessageId?: string;
  /** Timestamp for current streaming thinking chunk buffer (ms epoch). */
  streamingThinkingTimestamp?: number;
  /** Buffered replay user text that may arrive as multiple chunks. */
  pendingUserMessage: string;
  /** Stable replay user message id for chunk aggregation. */
  pendingUserMessageId?: string;
  /** Timestamp for buffered replay user message (ms epoch). */
  pendingUserMessageTimestamp?: number;
  /** Source of the buffered prompt, used for remote activity attribution. */
  pendingUserMessageOrigin?: ProviderOrigin;
  cwd: string;
  /** Local persisted conversation id (SQLite). */
  conversationId: string;
  /** Persisted owner used to fence an invisible predictive standby before
   * promotion copies that owner's conversationId onto the standby. */
  archiveOwnerConversationId?: string;
  /** Remote agent runtime session id (e.g., Codex thread id). */
  agentSessionId?: string;
  /** Session configuration options reported by the agent runtime. */
  configOptions?: SessionConfigOption[];
  /** Timestamp when the current prompt started */
  promptStartTime?: number;
  /** Currently selected model ID (if agent supports model selection) */
  currentModelId?: string;
  /**
   * Model ID of an in-flight setModel call, used to ignore stale
   * sessionStatus frames whose models.currentModelId reflects pre-switch
   * runtime state. Cleared once an event acknowledges the new value.
   */
  pendingModelId?: string;
  /**
   * Last model id the user explicitly clicked in the picker. Sticky: it
   * does NOT get overwritten by `message.model` ground truth from the
   * runtime (#1635). The picker label binds to this so the UI never
   * flickers as the CLI streams turns; only an explicit picker click
   * moves it. #1729.
   */
  userSelectedModelId?: string;
  /** Available models reported by the agent */
  availableModels?: AgentModelInfo[];
  /** Paired Claude + Codex workflow status (claude-codex sessions only). */
  paired?: PairedStatus;
  /** Producing agent for the current streaming buffer in a paired thread. */
  pairedStreamProvider?: string;
  /** Currently selected mode ID (if agent supports mode selection) */
  currentModeId?: string;
  /** Available modes reported by the agent */
  availableModes?: AgentModeInfo[];
  /** Session-specific error message */
  error?: string | null;
  /** Title derived from the first user prompt */
  title?: string;
  /** Set when the agent hits a rate limit — triggers the fallback-to-chat prompt. */
  rateLimitHit?: boolean;
  /** Set when the agent's context window is full — triggers the fallback-to-chat prompt. */
  promptTooLong?: boolean;
  /** Guards against duplicate fallback when prompt-too-long is detected in both streamed content and error event. */
  promptTooLongHandled?: boolean;
  /** When true, skip appending/persisting messages during history replay.
   *  Set when the session was spawned with restored messages from SQLite,
   *  cleared when the replay phase ends (promptComplete with historyReplay). */
  skipHistoryReplay?: boolean;
  /** Number of messages restored from SQLite at session start. The message-count
   *  auto-compaction check subtracts this so that display-only history does not
   *  re-trigger compaction on every restart. */
  restoredMessageCount?: number;
  /** Most recent input_tokens from the agent's usage metadata. */
  lastInputTokens?: number;
  /** Context window size for the agent model (tokens). */
  contextWindowSize: number;
  /** When true, a compaction is in progress. */
  isCompacting?: boolean;
  /** Compacted summary from older messages. */
  compactedSummary?: AgentCompactedSummary;
  /**
   * One-shot context prepend queued after a compaction. The next prompt
   * dispatched on this session is wrapped with this text in front of the
   * user's actual input (`[Auto-compaction restored prior context]\n…`)
   * and the field is cleared. Replaces the post-compaction seed turn —
   * eliminating the meta-acknowledgement turn from the on-disk JSONL.
   * #1829.
   */
  pendingCompactionPrepend?: string;
  /** Most recent user prompt text — used to retry after compaction. */
  lastUserPrompt?: string;
  /** Set after a compact-and-retry attempt so we only try once per prompt. */
  compactRetryAttempted?: boolean;
  /** In-flight compactAndRetry promise — awaited by sendPrompt catch block
   *  so compaction completes before the error handler gives up. */
  compactRetryPromise?: Promise<CompactionOutcome>;
  /** Transcript bootstrap injected into the first real prompt of a forked branch. */
  bootstrapPromptContext?: string;
  /**
   * Signature of the skills + publisher-instruction context block that has
   * already been delivered to the agent runtime. Subsequent prompts skip
   * resending this block while the signature is unchanged so we do not pay
   * the same SKILL.md token cost on every turn. Reset implicitly when the
   * runtime session is replaced (a fresh AgentSession is created without
   * this field set), and when the resolved skills set changes (signature
   * differs, the next prompt re-primes).
   */
  primedContextSignature?: string;
  /**
   * Message-count snapshot at the moment the priming context was last
   * delivered. Used to defensively re-prime after the runtime has likely
   * lost the priming text: e.g. user invokes `/compact` inside the CLI,
   * which we cannot observe directly. Once messages.length advances by
   * REPRIME_AFTER_MESSAGES beyond this snapshot, the next prompt re-primes
   * even when the signature is otherwise unchanged.
   */
  primedAtMessageCount?: number;
  /** Set when the user explicitly requested a cancel — suppresses auto-retry
   *  in the unresponsive-agent recovery path. */
  cancelRequested?: boolean;
  /** Config option values queued for restoration after the next configOptionsUpdate
   *  event from the new session. Prevents the agent's initial announcement from
   *  overwriting values restored during compaction or recovery. */
  pendingConfigRestore?: Record<string, string>;
  /** When true, keep discarding streaming content until the current turn ends
   *  (promptComplete). Set when the first chunk of skill context is filtered so
   *  that subsequent chunks of the same skill block — which arrive without the
   *  '# Active Skills' header — are also suppressed. */
  isSkippingSkillContext?: boolean;
  /** Queued prompts awaiting dispatch when the session returns to ready.
   *  Lives in the store (not the component) so background threads still drain. */
  pendingPrompts: string[];
  /** Scoped out-of-band DB write evidence from the Rust Claude memory watcher. */
  claudeMemoryWriteEvidence?: ToolEvidence[];
  /**
   * Serving = the session the user is talking to. Standby = a warm
   * replacement session being seeded via predictive compaction — invisible
   * to the UI, not dispatch-eligible until promoted. #1631.
   */
  role: "serving" | "standby";
  /**
   * True once the standby session finished its compaction seed prompt and
   * is eligible for `promoteStandbyAndDispatch`. Always false for serving
   * sessions. #1631.
   */
  seedCompleted?: boolean;
  /** In-flight predictive compaction flag — prevents double-kicking the
   *  same serving session into another warm-up. #1631. */
  predictiveCompactInFlight?: boolean;
  /** Sibling standby session id while predictive compaction is warming. */
  standbySessionId?: string | null;
  /** True once a tier-promise drift has been captured to the support
   *  pipeline, so the same session doesn't spam captureSupportError on every
   *  promptComplete. #1761. */
  contextWindowMismatchReported?: boolean;
}

// ============================================================================
// Agent message persistence helpers
// ============================================================================

const FORK_BOOTSTRAP_MAX_MSG_CHARS = 2_000;

export function agentDisplayName(agentType?: string): string {
  switch (agentType) {
    case "codex":
      return "Codex";
    case "claude-code":
      return "Claude Code";
    case "gemini":
      return "Gemini";
    case "grok":
      return "Grok";
    case "claude-codex":
      return "Claude + Codex";
    case "lmstudio":
      return "LM Studio";
    default:
      return agentType ?? "Agent";
  }
}

function agentInitializationFailureMessage(agentType?: string): string {
  const agentName = agentDisplayName(agentType);
  const remediation =
    agentType === "codex"
      ? "Codex is installed and signed in"
      : agentType === "gemini"
        ? "Gemini is installed and signed in"
        : agentType === "grok"
          ? "Grok is installed and signed in"
          : agentType === "lmstudio"
            ? "LM Studio is running and reachable"
            : agentType === "claude-codex"
              ? "Claude Code and Codex are installed and signed in"
              : `${agentName} is installed and authenticated`;

  return `Agent session terminated before initialization completed. Check that ${remediation}.`;
}

function truncateBootstrapText(content: string): string {
  return content.length > FORK_BOOTSTRAP_MAX_MSG_CHARS
    ? `${content.slice(0, FORK_BOOTSTRAP_MAX_MSG_CHARS)}... [truncated]`
    : content;
}

function formatForkBootstrapMessage(message: AgentMessage): string | null {
  const content = message.content.trim();

  switch (message.type) {
    case "user":
      return content ? `USER: ${truncateBootstrapText(content)}` : null;
    case "assistant":
      return content ? `ASSISTANT: ${truncateBootstrapText(content)}` : null;
    case "error":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "tool": {
      const label = message.toolCall?.status
        ? `TOOL (${message.toolCall.status})`
        : "TOOL";
      return content ? `${label}: ${truncateBootstrapText(content)}` : null;
    }
    case "diff": {
      const path = message.diff?.path;
      const summary = path ? `Modified ${path}` : content;
      return summary ? `DIFF: ${truncateBootstrapText(summary)}` : null;
    }
    case "handoff":
      return content ? `SYSTEM: ${truncateBootstrapText(content)}` : null;
    case "thought":
      return null;
  }
}

function buildForkBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript) {
    return null;
  }

  const sections = [
    "This prompt continues a forked branch of an earlier coding-agent conversation.",
    "Treat the summary and transcript below as the authoritative history for this branch.",
    "Anything that happened after the branch point is not part of this branch.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Branch transcript:\n${transcript}`);
  }

  sections.push(
    "Continue from the branch transcript's final message. Do not mention this bootstrap unless it helps answer the user.",
  );

  return sections.join("\n\n");
}

function isSessionDeathMessage(message: string): boolean {
  return (
    message.includes("Session terminated") ||
    message.includes("stopped before request completed") ||
    message.includes("stopped while prompt was active") ||
    message.includes("Worker thread dropped")
  );
}

function isRecoverableDeadSessionSendFailure(message: string): boolean {
  if (message.includes("Task cancelled")) {
    return false;
  }
  return (
    message.includes("unresponsive") ||
    message.includes("Worker thread dropped") ||
    message.includes("not found") ||
    message.includes("Session not initialized")
  );
}

function filterDroppedPromptRecoveryMessages(
  messages: AgentMessage[],
): AgentMessage[] {
  return messages.filter((message) => {
    if (message.type !== "error") {
      return true;
    }
    return (
      !message.content.includes("unresponsive") &&
      !isSessionDeathMessage(message.content)
    );
  });
}

function usesClaudeMemory(agentType: AgentType): boolean {
  return agentType === "claude-code" || agentType === "claude-codex";
}

function encodeClaudeProjectDirForPath(cwd: string): string {
  const normalized = cwd
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/:/g, "");
  return `-${normalized
    .split("")
    .map((char) => (/[A-Za-z0-9-]/.test(char) ? char : "-"))
    .join("")}`;
}

function isClaudeMemoryPathForCwd(path: string, cwd: string): boolean {
  const encoded = encodeClaudeProjectDirForPath(cwd);
  return path.replace(/\\/g, "/").split("/").includes(encoded);
}

function buildAgentFinalizationEvidence(
  session: ActiveSession,
): FinalizationEvidence {
  const evidence = extractEvidenceFromAgentMessages(session.messages);
  const memoryEvidence = session.claudeMemoryWriteEvidence ?? [];
  if (memoryEvidence.length === 0) {
    return evidence;
  }
  return {
    ...evidence,
    tools: [...evidence.tools, ...memoryEvidence],
  };
}

async function refreshClaudeMemoryMdBeforeSpawn(
  cwd: string,
  agentType: AgentType,
  hasSerenApiKey: boolean,
): Promise<void> {
  if (!usesClaudeMemory(agentType)) return;
  if (!hasSerenApiKey) return;
  if (!settingsStore.get("claudeMemoryInterceptEnabled")) return;

  // The on-disk MEMORY.md is what the agent reads at startup, and the
  // interceptor re-renders it after every local memory write, so it is already
  // current for a single-device user. This pre-spawn render only pulls in
  // cross-device / cross-session updates from SerenDB. We give it a short warm
  // fast-path window so a responsive DB refreshes the index before the agent
  // reads it, but we never stall the spawn on a cold SerenDB: the render keeps
  // running in the background and refreshes MEMORY.md for the next spawn.
  let settled = false;
  const renderPromise = renderClaudeMemoryMd(cwd)
    .then((result) => {
      settled = true;
      if (result) {
        console.info("[AgentStore] Refreshed Claude memory index:", result);
      }
      return result;
    })
    .catch((error) => {
      settled = true;
      console.warn("[AgentStore] Claude memory index refresh failed:", error);
      return null;
    });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(
      () => resolve("timeout"),
      CLAUDE_MEMORY_RENDER_BEFORE_SPAWN_TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([renderPromise, timeoutPromise]);
    if (result === "timeout" && !settled) {
      console.info(
        `[AgentStore] Claude memory index still refreshing after ${CLAUDE_MEMORY_RENDER_BEFORE_SPAWN_TIMEOUT_MS}ms; spawning with on-disk MEMORY.md while the refresh finishes in the background.`,
      );
    }
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function mergeRecoveryMessages(
  liveMessages: AgentMessage[],
  persistedMessages: AgentMessage[],
): AgentMessage[] {
  const byId = new Map<string, AgentMessage>();
  for (const message of persistedMessages) {
    byId.set(message.id, message);
  }
  for (const message of liveMessages) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function buildDroppedPromptRecoveryBootstrapContext(
  session: ActiveSession,
  messages: AgentMessage[],
  reason: string,
  persistedContext: string,
): string | null {
  const summary = session.compactedSummary?.content.trim();
  const transcript = messages
    .map(formatForkBootstrapMessage)
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  if (!summary && !transcript && !persistedContext.trim()) {
    return null;
  }

  const sections = [
    "Seren Desktop restarted the coding-agent worker while a prompt was active.",
    `Recovery reason: ${truncateBootstrapText(reason)}`,
    "Use the recovered history below as authoritative context for the restarted worker.",
    "The user's original prompt will be replayed automatically after this context; do not ask the user to type continue.",
  ];

  if (summary) {
    sections.push(`Earlier summary:\n${summary}`);
  }

  if (transcript) {
    sections.push(`Recovered transcript:\n${transcript}`);
  } else if (persistedContext.trim()) {
    sections.push(`Persisted transcript fallback:\n${persistedContext}`);
  }

  sections.push(
    "Continue the interrupted task from the recovered context and the replayed prompt.",
  );

  return sections.join("\n\n");
}

async function buildDroppedPromptRecoverySnapshot(
  session: ActiveSession,
  reason: string,
  currentUserMessageId?: string,
): Promise<{
  restoredMessages: AgentMessage[];
  bootstrapPromptContext?: string;
}> {
  const liveMessages = filterDroppedPromptRecoveryMessages([
    ...session.messages,
  ]);
  const persisted = await loadPersistedAgentHistory(session.conversationId);
  const restoredMessages = filterDroppedPromptRecoveryMessages(
    mergeRecoveryMessages(liveMessages, persisted.messages),
  );
  const bootstrapMessages = currentUserMessageId
    ? restoredMessages.filter((message) => message.id !== currentUserMessageId)
    : restoredMessages;
  const bootstrapPromptContext =
    buildDroppedPromptRecoveryBootstrapContext(
      session,
      bootstrapMessages,
      reason,
      persisted.context,
    ) ?? undefined;

  return { restoredMessages, bootstrapPromptContext };
}

function parseAgentConversationMetadata(
  raw: string | null | undefined,
): AgentConversationMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as AgentConversationMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serializeAgentConversationMetadata(
  metadata: AgentConversationMetadata,
): string | null {
  return metadata.pendingBootstrapPromptContext ||
    (metadata.pendingBootstrapMessages &&
      metadata.pendingBootstrapMessages.length > 0) ||
    metadata.pairedConfig
    ? JSON.stringify(metadata)
    : null;
}

function serializeAgentMessageMetadata(msg: AgentMessage): string | null {
  if (msg.type === "handoff") {
    return JSON.stringify({ v: 1, paired_handoff: true });
  }
  if (!msg.finalOutputValidation) return null;
  return JSON.stringify({
    v: 1,
    final_output_validation: msg.finalOutputValidation,
  });
}

function isPairedHandoffMetadata(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    return JSON.parse(metadata)?.paired_handoff === true;
  } catch {
    return false;
  }
}

/**
 * Persist an agent message to SQLite so history survives session restarts.
 * Only user and assistant messages are stored — tool calls, diffs, and
 * internal events are transient and replayed by the provider.
 */
function persistAgentMessage(
  conversationId: string,
  msg: AgentMessage,
  sessionAgentType: string | null,
): void {
  // Handoff activity lines persist as assistant rows with a metadata marker
  // so the paired transcript survives restarts (#2368).
  if (msg.type !== "user" && msg.type !== "assistant" && msg.type !== "handoff")
    return;
  // Producer provenance: prefer an explicit value on the message, otherwise
  // fall back to the agent type of the session that produced this turn —
  // which the caller passes in explicitly so we never walk `state.sessions`
  // and risk picking a stale session that briefly shares a conversationId
  // (e.g. during compaction-driven session swaps). User-authored rows are
  // never stamped with producer provenance.
  const provider =
    msg.type === "user" ? null : (msg.provider ?? sessionAgentType);
  const queueKey = `${conversationId}:${msg.id}`;
  const previous = messagePersistQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() =>
      saveMessage(
        msg.id,
        conversationId,
        msg.type === "user" ? "user" : "assistant",
        msg.content,
        null,
        msg.timestamp,
        serializeAgentMessageMetadata(msg),
        provider,
      ),
    );
  messagePersistQueues.set(queueKey, next);
  next
    .catch((error) =>
      console.warn("[AgentStore] Failed to persist agent message:", error),
    )
    .finally(() => {
      if (messagePersistQueues.get(queueKey) === next) {
        messagePersistQueues.delete(queueKey);
      }
    });
}

function persistStreamingAssistantDraft(sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session?.conversationId || !session.streamingContent) return;
  if (session.streamingContentReplay === true) return;

  const draftContent = scrubAgentMarkup(session.streamingContent);
  if (
    draftContent.length === 0 ||
    isGeneratedPromptPrimer(draftContent) ||
    session.isSkippingSkillContext
  ) {
    return;
  }

  const draftMessageId = session.assistantDraftMessageId ?? crypto.randomUUID();
  if (!session.assistantDraftMessageId) {
    setState("sessions", sessionId, "assistantDraftMessageId", draftMessageId);
  }

  persistAgentMessage(
    session.conversationId,
    {
      id: draftMessageId,
      type: "assistant",
      content: draftContent,
      timestamp: session.streamingContentTimestamp ?? Date.now(),
      provider: session.pairedStreamProvider ?? session.info.agentType,
    },
    session.info.agentType,
  );
}

/**
 * Load persisted agent messages from SQLite and build a conversation summary
 * for bootstrapping a fresh session. Returns { messages, context } where
 * messages are AgentMessage[] for the UI and context is a string for the agent.
 */
async function loadPersistedAgentHistory(
  conversationId: string,
): Promise<{ messages: AgentMessage[]; context: string }> {
  try {
    const stored = await getMessages(conversationId, 200);
    if (!stored || stored.length === 0) {
      return { messages: [], context: "" };
    }

    const messages: AgentMessage[] = stored.map((m) => ({
      id: m.id,
      type:
        m.role === "user"
          ? ("user" as const)
          : isPairedHandoffMetadata(m.metadata)
            ? ("handoff" as const)
            : ("assistant" as const),
      content: m.content,
      timestamp: m.timestamp,
      provider: m.provider ?? undefined,
    }));

    // Build a concise conversation summary for the agent's context
    const lines = stored.map(
      (m) =>
        `[${m.role}]: ${m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content}`,
    );
    const context =
      "Here is the conversation history from your previous session. " +
      "Continue from where you left off.\n\n" +
      lines.join("\n\n");

    return { messages, context };
  } catch (error) {
    console.warn("[AgentStore] Failed to load persisted agent history:", error);
    return { messages: [], context: "" };
  }
}

// ============================================================================
// State
// ============================================================================

/**
 * Terminal error classification for the inline-per-bubble error state.
 * Closed union — callers must map any new failure into one of these. #1631.
 */
export type ErrorKind =
  | "restart_timeout"
  | "spawn_failed"
  | "auth_expired"
  | "binary_missing"
  | "crash_ceiling"
  | "summary_call_failed"
  | "seed_failed"
  | "privileged_provider_blocked";

export interface TurnError {
  kind: ErrorKind;
  retryable: boolean;
  message?: string;
}

/**
 * Per-thread state that survives session swaps (predictive promotion,
 * reactive compact-and-retry, crash re-dispatch). Keyed by conversationId
 * so compaction — which mints a new sessionId but keeps conversationId —
 * preserves the in-flight signal and terminal-error state. #1631.
 */
export interface ThreadRuntimeState {
  turnInFlight: boolean;
  turnError: TurnError | null;
  /** Absolute ms epoch when the current restart-dependent turn must have
   *  produced a streaming chunk by. `null` outside restart-dependent paths. */
  restartTimerExpiresAt: number | null;
  /** Text + context of the last submitted user prompt so retry-link and
   *  crash re-dispatch can resend without relying on stale session state. */
  lastPromptText?: string;
  lastPromptContext?: Array<Record<string, string>>;
  lastPromptDisplay?: string;
  lastPromptDocNames?: string[];
}

interface AgentState {
  /** Available agents and their status */
  availableAgents: AgentInfo[];
  /** Active sessions keyed by session ID */
  sessions: Record<string, ActiveSession>;
  /** Per-thread runtime state keyed by conversationId (#1631). */
  threadStates: Record<string, ThreadRuntimeState>;
  /**
   * Durable transcript fallback keyed by conversationId, hydrated from the
   * SQLite `messages` table when a thread is viewed without a live session.
   * Lets an agent thread render its history on cold start, after an
   * idle-reclaim, or mid-spawn instead of showing blank. Live
   * `session.messages` take precedence once a session owns the transcript.
   * #2499.
   */
  persistedMessages: Record<string, AgentMessage[]>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Selected agent type for new sessions */
  selectedAgentType: AgentType;
  /** Recent persisted agent conversations for resuming. */
  recentAgentConversations: DbAgentConversation[];
  /** Remote sessions listed from the agent's underlying session store. */
  remoteSessions: RemoteSessionInfo[];
  remoteSessionsNextCursor: string | null;
  remoteSessionsLoading: boolean;
  remoteSessionsError: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** CLI install progress message */
  installStatus: string | null;
  /**
   * Most recent CLI auto-updater scan rejection (#1646). Null when no
   * rejection has been recorded this session. Set by
   * subscribeToCliScanRejections from a provider runtime event; the user
   * stays on their previous known-good version until cleared.
   */
  cliScanRejection: {
    label: string;
    packageName: string;
    from: string | null;
    to: string;
    flags: string[];
    at: number;
  } | null;
  /** Pending manual recovery for a failed or unverifiable CLI update. */
  cliUpdateActionRequired: {
    label: string;
    bareCommand: "claude" | "codex";
    packageName: string;
    from: string | null;
    to: string | null;
    reason: string;
    officialInstructionsUrl: string;
    retrying: boolean;
    at: number;
  } | null;
  /** Pending permission requests awaiting user response */
  pendingPermissions: PermissionRequestEvent[];
  /** Pending diff proposals awaiting user accept/reject */
  pendingDiffProposals: DiffProposalEvent[];
  /** Whether agent mode is active (vs chat mode) */
  agentModeEnabled: boolean;
}

/**
 * Project a unified-row read into the agent-typed row this store
 * caches. Drops fields that only apply to chat threads (employee_id,
 * selected_*); the `kind` filter on `listConversations({ kind: 'agent' })`
 * guarantees `agent_type` is non-null for rows that reach this path.
 */
function unifiedRowToAgent(row: UnifiedConversationRow): DbAgentConversation {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    agent_type: row.agent_type ?? "",
    agent_session_id: row.agent_session_id,
    agent_cwd: row.agent_cwd,
    agent_model_id: row.agent_model_id,
    agent_permission_mode: row.agent_permission_mode,
    agent_metadata: row.agent_metadata,
    project_id: row.project_id,
    project_root: row.project_root,
    is_archived: row.is_archived,
    privileged: row.privileged,
    counsel_direction: row.counsel_direction,
  };
}

const [state, setState] = createStore<AgentState>({
  availableAgents: [],
  sessions: {},
  threadStates: {},
  persistedMessages: {},
  activeSessionId: null,
  selectedAgentType: "claude-code",
  recentAgentConversations: [],
  remoteSessions: [],
  remoteSessionsNextCursor: null,
  remoteSessionsLoading: false,
  remoteSessionsError: null,
  isLoading: false,
  error: null,
  installStatus: null,
  cliScanRejection: null,
  cliUpdateActionRequired: null,
  pendingPermissions: [],
  pendingDiffProposals: [],
  agentModeEnabled: false,
});

/** Kill a provider that completed after its owning Happy conversation was
 * archived. This path can run before the session was ever registered in the
 * Solid store, so it must call the provider directly rather than delegate to
 * terminateSession (which intentionally no-ops for unknown session IDs). */
async function discardLateArchivedProviderSession(
  sessionId: string,
  conversationId: string,
): Promise<void> {
  const { archivedSessionIds, nextActiveSessionId } =
    planHappyArchiveInvalidation(
      state.sessions,
      state.activeSessionId,
      conversationId,
    );
  const allArchivedSessionIds = new Set([...archivedSessionIds, sessionId]);

  terminatedSessionIds.add(sessionId);
  terminatedSessionIds.add(conversationId);
  for (const archivedSessionId of allArchivedSessionIds) {
    terminatedSessionIds.add(archivedSessionId);
    sessionReadyPromises.get(archivedSessionId)?.resolve();
    sessionReadyPromises.delete(archivedSessionId);
    pendingSessionEvents.delete(archivedSessionId);
    spawnContextMap.delete(archivedSessionId);
    recoveryInFlightMap.delete(archivedSessionId);
    clearChunkBuf(archivedSessionId);
    clearToolEventBuf(archivedSessionId);
  }
  spawnContextMap.delete(conversationId);

  setState("recentAgentConversations", (rows) =>
    rows.filter((row) => row.id !== conversationId),
  );
  setState("pendingPermissions", (items) =>
    items.filter((item) => !allArchivedSessionIds.has(item.sessionId)),
  );
  setState("pendingDiffProposals", (items) =>
    items.filter((item) => !allArchivedSessionIds.has(item.sessionId)),
  );
  setState(
    produce((draft) => {
      for (const archivedSessionId of allArchivedSessionIds) {
        delete draft.sessions[archivedSessionId];
      }
      delete draft.threadStates[conversationId];
      delete draft.persistedMessages[conversationId];
    }),
  );
  if (state.activeSessionId !== nextActiveSessionId) {
    setState("activeSessionId", nextActiveSessionId);
  }

  await Promise.all(
    [...allArchivedSessionIds].map(async (archivedSessionId) => {
      expectedTerminateSessionIds.add(archivedSessionId);
      try {
        await revokeCredentialLease(archivedSessionId).catch((error) => {
          console.warn(
            "[AgentStore] Failed to revoke credential lease after Happy archive:",
            error,
          );
        });
        await providerService.terminateSession(archivedSessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("not found")) {
          console.warn(
            "[AgentStore] Failed to terminate provider after Happy archive:",
            error,
          );
        }
      } finally {
        expectedTerminateSessionIds.delete(archivedSessionId);
      }
    }),
  );
}

const agentOAuthRoutingRefreshes = new Map<string, Promise<boolean>>();
const agentOAuthRoutingAvailability = new Map<string, boolean>();
const agentOAuthRoutingDelivery = new Map<string, boolean>();
const agentOAuthRoutingRevisions = new Map<string, string>();
const agentOAuthRoutingSelectionThreads = new Map<string, string>();

function currentAgentOAuthRoutingRevision(): string {
  return `${oauthConnectionsRevision()}:${oauthSelectionsRevision()}`;
}

async function refreshAgentOAuthRouting(
  providerSessionId: string,
  selectionThreadId = providerSessionId,
): Promise<boolean> {
  const previous = agentOAuthRoutingRefreshes.get(providerSessionId);
  const refresh = (previous ?? Promise.resolve(true))
    .catch(() => false)
    .then(async () => {
      const revision = currentAgentOAuthRoutingRevision();
      try {
        const routing = await computeAgentOAuthRouting(selectionThreadId);
        await providerService.setOAuthRouting(providerSessionId, routing);
        agentOAuthRoutingAvailability.set(
          providerSessionId,
          routing.available !== false,
        );
        agentOAuthRoutingDelivery.set(providerSessionId, true);
        agentOAuthRoutingRevisions.set(providerSessionId, revision);
        agentOAuthRoutingSelectionThreads.set(
          providerSessionId,
          selectionThreadId,
        );
        return true;
      } catch (error) {
        agentOAuthRoutingAvailability.set(providerSessionId, false);
        agentOAuthRoutingDelivery.set(providerSessionId, false);
        console.warn(
          `[AgentStore] Failed to refresh OAuth routing for ${selectionThreadId}:`,
          error,
        );
        return false;
      }
    });
  agentOAuthRoutingRefreshes.set(providerSessionId, refresh);
  try {
    return await refresh;
  } finally {
    if (agentOAuthRoutingRefreshes.get(providerSessionId) === refresh) {
      agentOAuthRoutingRefreshes.delete(providerSessionId);
    }
  }
}

async function awaitAgentOAuthRoutingForPrompt(
  providerSessionId: string,
  selectionThreadId: string,
): Promise<boolean> {
  await agentOAuthRoutingRefreshes.get(providerSessionId);
  if (
    agentOAuthRoutingAvailability.get(providerSessionId) === false ||
    agentOAuthRoutingDelivery.get(providerSessionId) === false ||
    agentOAuthRoutingRevisions.get(providerSessionId) !==
      currentAgentOAuthRoutingRevision() ||
    agentOAuthRoutingSelectionThreads.get(providerSessionId) !==
      selectionThreadId
  ) {
    await refreshAgentOAuthRouting(providerSessionId, selectionThreadId);
  }
  return (
    agentOAuthRoutingDelivery.get(providerSessionId) === true &&
    agentOAuthRoutingRevisions.get(providerSessionId) ===
      currentAgentOAuthRoutingRevision() &&
    agentOAuthRoutingSelectionThreads.get(providerSessionId) ===
      selectionThreadId
  );
}

createRoot(() => {
  createEffect(() => {
    oauthConnectionsRevision();
    oauthSelectionsRevision();
    for (const session of Object.values(state.sessions)) {
      if (session.conversationId) {
        void refreshAgentOAuthRouting(session.info.id, session.conversationId);
      }
    }
  });
});

let globalUnsubscribe: UnlistenFn | null = null;
const pendingSessionEvents = new Map<string, AgentEvent[]>();

/** Guard against concurrent auto-recovery spawns in sendPrompt (per-session). */
const recoveryInFlightMap = new Map<string, Promise<string | null>>();
const LEGACY_CLAUDE_LOCAL_SESSION_ID_RE = /^session-\d+$/;
const messagePersistQueues = new Map<string, Promise<void>>();

/** Last pairedConfig JSON written per conversation, to skip no-op DB writes. */
const pairedConfigPersisted = new Map<string, string>();

// Chunk accumulation buffers — plain JS, not reactive.
// Flushed to the SolidJS store at CHUNK_FLUSH_MS intervals to reduce
// per-chunk setState calls during high-velocity streaming bursts.
const CHUNK_FLUSH_MS = 50;
const chunkBufs = new Map<string, { content: string; thinking: string }>();
const chunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const thinkingMarkupStreamStates = new Map<
  string,
  AgentThinkingMarkupStreamState
>();

// Tool event accumulation buffers — plain JS, not reactive.
// During high-velocity tool-call chains (e.g. Codex doing 20+ sequential
// tool calls), each toolCall/toolResult event triggers multiple setState
// calls (message append, status update, persistence). Batching these on
// the same CHUNK_FLUSH_MS interval as streaming chunks coalesces a burst
// of N tool events into a single SolidJS reconciliation pass. #1531.
interface PendingToolEvent {
  type: "toolCall" | "toolResult";
  data: unknown;
}
const toolEventBufs = new Map<string, PendingToolEvent[]>();
const toolEventFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function thinkingMarkupStateFor(
  sessionId: string,
): AgentThinkingMarkupStreamState {
  let parserState = thinkingMarkupStreamStates.get(sessionId);
  if (!parserState) {
    parserState = createAgentThinkingMarkupStreamState();
    thinkingMarkupStreamStates.set(sessionId, parserState);
  }
  return parserState;
}

function appendThinkingMarkupParts(
  sessionId: string,
  parts: AgentThinkingMarkupParts,
): void {
  if (parts.content) {
    setState(
      "sessions",
      sessionId,
      "streamingContent",
      (c) => c + parts.content,
    );
  }
  if (parts.thinking) {
    const session = state.sessions[sessionId];
    if (session && !session.streamingThinking) {
      setState(
        "sessions",
        sessionId,
        "streamingThinkingTimestamp",
        session.streamingThinkingTimestamp ??
          session.streamingContentTimestamp ??
          Date.now(),
      );
    }
    setState(
      "sessions",
      sessionId,
      "streamingThinking",
      (c) => c + parts.thinking,
    );
  }
}

function flushThinkingMarkupStreamState(sessionId: string): void {
  const parserState = thinkingMarkupStreamStates.get(sessionId);
  if (!parserState) return;
  appendThinkingMarkupParts(
    sessionId,
    flushAgentThinkingMarkupRemainder(parserState),
  );
  thinkingMarkupStreamStates.delete(sessionId);
}

function flushChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  const buf = chunkBufs.get(sessionId);
  if (!buf) return;
  if (buf.content) {
    appendThinkingMarkupParts(
      sessionId,
      consumeAgentThinkingMarkupChunk(
        thinkingMarkupStateFor(sessionId),
        buf.content,
      ),
    );
    persistStreamingAssistantDraft(sessionId);
    buf.content = "";
  }
  if (buf.thinking) {
    setState(
      "sessions",
      sessionId,
      "streamingThinking",
      (c) => c + buf.thinking,
    );
    buf.thinking = "";
  }
}

function clearChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  chunkBufs.delete(sessionId);
  thinkingMarkupStreamStates.delete(sessionId);
}

function clearToolEventBuf(sessionId: string): void {
  const timer = toolEventFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    toolEventFlushTimers.delete(sessionId);
  }
  toolEventBufs.delete(sessionId);
}

function disposeAgentStoreRuntimeBindings(): void {
  disposeAgentStoreSideChannelListeners();
  if (globalUnsubscribe) {
    globalUnsubscribe();
    globalUnsubscribe = null;
  }
  pendingSessionEvents.clear();
  sessionReadyPromises.clear();
  recoveryInFlightMap.clear();
  terminatedSessionIds.clear();
  happyProviderArchiveTombstones.clear();
  spawnContextMap.clear();
  for (const timer of chunkFlushTimers.values()) {
    clearTimeout(timer);
  }
  chunkFlushTimers.clear();
  chunkBufs.clear();
  thinkingMarkupStreamStates.clear();
  for (const timer of toolEventFlushTimers.values()) {
    clearTimeout(timer);
  }
  toolEventFlushTimers.clear();
  toolEventBufs.clear();
}

const agentStoreHot =
  (
    import.meta as ImportMeta & {
      hot?: { dispose: (callback: () => void) => void };
    }
  ).hot ?? null;

if (agentStoreHot) {
  const globalScope = globalThis as typeof globalThis & {
    __serenAgentStoreHmrDispose__?: (() => void) | undefined;
  };

  globalScope.__serenAgentStoreHmrDispose__?.();

  const dispose = () => {
    disposeAgentStoreRuntimeBindings();
    if (globalScope.__serenAgentStoreHmrDispose__ === dispose) {
      delete globalScope.__serenAgentStoreHmrDispose__;
    }
  };

  globalScope.__serenAgentStoreHmrDispose__ = dispose;
  agentStoreHot.dispose(dispose);
}

const PENDING_SESSION_EVENT_LIMIT = 500;
const CLAUDE_INIT_RETRY_DELAY_MS = 350;
const MAX_CLAUDE_INIT_RETRIES = 3;

/** Spawn cascade guard: track recent failures per conversation to prevent infinite loops. */
const SPAWN_CASCADE_WINDOW_MS = 30_000;
const SPAWN_CASCADE_MAX_FAILURES = 3;
const spawnFailureTimestamps = new Map<string, number[]>();

function recordSpawnFailure(conversationId: string): void {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  timestamps.push(now);
  // Keep only failures within the window
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  spawnFailureTimestamps.set(conversationId, recent);
}

function isSpawnCascading(conversationId: string): boolean {
  const now = Date.now();
  const timestamps = spawnFailureTimestamps.get(conversationId) ?? [];
  const cutoff = now - SPAWN_CASCADE_WINDOW_MS;
  const recent = timestamps.filter((t) => t >= cutoff);
  return recent.length >= SPAWN_CASCADE_MAX_FAILURES;
}

function clearSpawnFailures(conversationId: string): void {
  spawnFailureTimestamps.delete(conversationId);
}

function isRetryableClaudeInitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("server shut down unexpectedly") ||
    lower.includes("signal: 9") ||
    lower.includes("sigkill") ||
    // Claude MCP initialize handshake can time out under load (another session
    // active, slow startup, machine pressure). This is transient — retrying
    // with backoff succeeds without any user intervention needed.
    lower.includes("timed out waiting for claude control request initialize")
  );
}

function getIdleClaudeSessionIds(excludeConversationId?: string): string[] {
  const activeId = state.activeSessionId;
  const navTarget = activeNavigationThreadIdGetter?.() ?? null;
  return Object.entries(state.sessions)
    .filter(([id, session]) => {
      if (session.info.agentType !== "claude-code") return false;
      if (id === activeId) return false;
      // Warm standby sessions must NOT be reclaimed — they are the whole
      // point of predictive compaction. Killing one mid-warm-up defeats
      // the invisibility budget for the next user submit. #1631.
      if (session.role === "standby") return false;
      if (
        excludeConversationId &&
        session.conversationId === excludeConversationId
      ) {
        return false;
      }
      // Honour the user's navigation intent. selectThread sets the active
      // thread synchronously, but a freshly-clicked thread's session may not
      // yet be reflected in `state.activeSessionId` (the live-session branch
      // marks it synchronously after #1852, but a respawning thread is
      // briefly without an active session id). Excluding by conversationId
      // closes that window so a parallel spawn's preemptive reclaim cannot
      // kill the session the user just navigated to. #1852.
      if (navTarget && session.conversationId === navTarget) {
        return false;
      }
      // Keep actively prompting sessions alive; only reclaim idle/errored ones.
      return (
        session.info.status === "ready" ||
        session.info.status === "error" ||
        session.info.status === "terminated"
      );
    })
    .sort(([, a], [, b]) => a.info.createdAt.localeCompare(b.info.createdAt))
    .map(([id]) => id);
}

// ============================================================================
// Store
// ============================================================================

export const agentStore = {
  refreshAgentOAuthRouting,

  // ============================================================================
  // Getters
  // ============================================================================

  get availableAgents() {
    return state.availableAgents;
  },

  get sessions() {
    return state.sessions;
  },

  get activeSessionId() {
    return state.activeSessionId;
  },

  get activeSession(): ActiveSession | null {
    if (!state.activeSessionId) return null;
    return state.sessions[state.activeSessionId] ?? null;
  },

  get selectedAgentType() {
    return state.selectedAgentType;
  },

  get recentAgentConversations() {
    return state.recentAgentConversations;
  },

  get remoteSessions() {
    return state.remoteSessions;
  },

  get remoteSessionsNextCursor() {
    return state.remoteSessionsNextCursor;
  },

  get remoteSessionsLoading() {
    return state.remoteSessionsLoading;
  },

  get remoteSessionsError() {
    return state.remoteSessionsError;
  },

  get isLoading() {
    return state.isLoading;
  },

  get error() {
    // Return session-specific error for active session, fall back to global error
    const session = this.activeSession;
    return session?.error ?? state.error;
  },

  get installStatus() {
    return state.installStatus;
  },

  get cliUpdateActionRequired() {
    return state.cliUpdateActionRequired;
  },

  get pendingPermissions() {
    return state.pendingPermissions;
  },

  get pendingDiffProposals() {
    return state.pendingDiffProposals;
  },

  get agentModeEnabled() {
    return state.agentModeEnabled;
  },

  get supportsAgents() {
    return runtimeHasCapability("agents");
  },

  /**
   * Get messages for the active session.
   */
  get messages(): AgentMessage[] {
    const session = this.activeSession;
    return session?.messages ?? [];
  },

  /**
   * Get messages for a specific conversation ID (thread ID).
   * Use this instead of `messages` getter when you need messages for a specific thread,
   * not just the active session.
   */
  getMessagesForConversation(conversationId: string): AgentMessage[] {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    if (session && session.messages.length > 0) {
      return session.messages;
    }
    // No live session yet (cold start, idle-reclaim, mid-spawn) or it has not
    // hydrated: fall back to the durable transcript so the thread never renders
    // blank. Populated by hydratePersistedHistory. #2499.
    return state.persistedMessages[conversationId] ?? [];
  },

  /**
   * Load this thread's durable transcript from SQLite into the
   * `persistedMessages` fallback when no live session owns it, so an agent
   * thread renders its history immediately instead of blank. Reads fresh on
   * every call where no session has messages, so the fallback cannot go stale
   * after an idle-reclaim. No-op (and drops any stale fallback) once a live
   * session has messages — that source is authoritative. #2499.
   */
  async hydratePersistedHistory(conversationId: string): Promise<void> {
    const ownsTranscript = (id: string): boolean => {
      const session = this.getSessionForConversation(id);
      return !!session && session.messages.length > 0;
    };
    if (ownsTranscript(conversationId)) {
      if (state.persistedMessages[conversationId]) {
        setState("persistedMessages", conversationId, undefined as never);
      }
      return;
    }
    const { messages } = await loadPersistedAgentHistory(conversationId);
    // A session may have hydrated while awaiting the read; don't clobber it.
    if (ownsTranscript(conversationId)) return;
    setState("persistedMessages", conversationId, messages);
  },

  /**
   * Get streaming content for a specific conversation ID.
   */
  getStreamingContentForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingContent ?? "";
  },

  /**
   * Get streaming thinking for a specific conversation ID.
   */
  getStreamingThinkingForConversation(conversationId: string): string {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === conversationId,
    );
    return session?.streamingThinking ?? "";
  },

  /**
   * Get the active session for a specific conversation ID.
   * Returns null if no session is running for that conversation.
   */
  getSessionForConversation(conversationId: string): ActiveSession | null {
    return (
      Object.values(state.sessions).find(
        (s) => s.conversationId === conversationId,
      ) ?? null
    );
  },

  /**
   * Check if a conversation has pending permission requests or diff proposals.
   * Used by sidebar/tab indicators to show a blinking approval dot.
   */
  hasPendingApprovals(conversationId: string): boolean {
    const session = this.getSessionForConversation(conversationId);
    if (!session) return false;
    const sid = session.info.id;
    return (
      state.pendingPermissions.some((p) => p.sessionId === sid) ||
      state.pendingDiffProposals.some((p) => p.sessionId === sid)
    );
  },

  /** Enqueue a prompt for a session. Dispatched automatically on promptComplete. */
  enqueuePrompt(sessionId: string, prompt: string): void {
    if (!state.sessions[sessionId]) return;
    setState("sessions", sessionId, "pendingPrompts", (q) => [...q, prompt]);
  },

  // ============================================================================
  // Per-thread runtime state (turnInFlight / turnError / last-prompt) — #1631
  // ============================================================================

  getThreadState(threadId: string): ThreadRuntimeState {
    return (
      state.threadStates[threadId] ?? {
        turnInFlight: false,
        turnError: null,
        restartTimerExpiresAt: null,
      }
    );
  },

  isTurnInFlight(threadId: string): boolean {
    return state.threadStates[threadId]?.turnInFlight === true;
  },

  /** True while a spawn for this conversation is in flight. Backed by the
   *  spawnSession dedup guard (added before spawn, removed in finally), so it
   *  is never stale — used to reject duplicate cold-start sends (#2525). */
  isSpawning(conversationId: string): boolean {
    return spawningConversations.has(conversationId);
  },

  getTurnError(threadId: string): TurnError | null {
    return state.threadStates[threadId]?.turnError ?? null;
  },

  _ensureThreadState(threadId: string): void {
    if (!state.threadStates[threadId]) {
      setState("threadStates", threadId, {
        turnInFlight: false,
        turnError: null,
        restartTimerExpiresAt: null,
      });
    }
  },

  setTurnInFlight(threadId: string, value: boolean): void {
    this._ensureThreadState(threadId);
    setState("threadStates", threadId, "turnInFlight", value);
    if (!value) this.clearRestartTimer(threadId);
  },

  /** Record the last-submitted prompt so retry-link and crash re-dispatch
   *  can resend with the same text + attachments. */
  setLastPrompt(
    threadId: string,
    prompt: string,
    context?: Array<Record<string, string>>,
    display?: string,
    docNames?: string[],
  ): void {
    this._ensureThreadState(threadId);
    setState("threadStates", threadId, "lastPromptText", prompt);
    setState("threadStates", threadId, "lastPromptContext", context);
    setState("threadStates", threadId, "lastPromptDisplay", display);
    setState("threadStates", threadId, "lastPromptDocNames", docNames);
  },

  /**
   * Arm a per-turn invisibility budget. When it expires and the turn is
   * still in-flight and no stream chunk has landed, the bubble flips to
   * a terminal error — see #1631 failure-mode section.
   */
  armRestartTimer(threadId: string, budgetMs: number, reason: ErrorKind): void {
    this._ensureThreadState(threadId);
    this.clearRestartTimer(threadId);
    setState(
      "threadStates",
      threadId,
      "restartTimerExpiresAt",
      Date.now() + budgetMs,
    );
    const timer = setTimeout(() => {
      restartTimers.delete(threadId);
      const ts = state.threadStates[threadId];
      if (!ts?.turnInFlight) return;
      const session = Object.values(state.sessions).find(
        (s) => s.conversationId === threadId,
      );
      const streamingNow =
        !!session && (session.streamingContent || session.streamingThinking);
      if (streamingNow) {
        // A response started — drop the timer silently; the turn will
        // finalize normally.
        setState("threadStates", threadId, "restartTimerExpiresAt", null);
        return;
      }
      this.setTurnError(threadId, reason, `invisibility budget exceeded`);
    }, budgetMs);
    restartTimers.set(threadId, timer);
  },

  clearRestartTimer(threadId: string): void {
    const t = restartTimers.get(threadId);
    if (t) {
      clearTimeout(t);
      restartTimers.delete(threadId);
    }
    if (state.threadStates[threadId]) {
      setState("threadStates", threadId, "restartTimerExpiresAt", null);
    }
  },

  setTurnError(threadId: string, kind: ErrorKind, message?: string): void {
    this._ensureThreadState(threadId);
    const retryable = kind !== "auth_expired" && kind !== "binary_missing";
    setState("threadStates", threadId, "turnError", {
      kind,
      retryable,
      message,
    });
    // Surface the inline error — the thinking dots stop, the bubble turns red.
    setState("threadStates", threadId, "turnInFlight", false);
    this.clearRestartTimer(threadId);
    // Fire-and-forget auto-report through #1630's pipeline. If that
    // ticket is not yet merged, the invoke will throw and be swallowed.
    this._submitTurnErrorReport(threadId, kind, message);
  },

  clearTurnError(threadId: string): void {
    if (!state.threadStates[threadId]) return;
    setState("threadStates", threadId, "turnError", null);
  },

  failTurnForSession(
    sessionId: string,
    message: string,
    kind: ErrorKind = "crash_ceiling",
  ): void {
    const session = state.sessions[sessionId];
    const threadId = session?.conversationId;
    if (!threadId) return;

    const turnIsActive =
      this.isTurnInFlight(threadId) || session.info.status === "prompting";
    if (!turnIsActive) return;

    const existing = state.threadStates[threadId]?.turnError;
    if (
      existing?.kind === kind &&
      existing.message === message &&
      !this.isTurnInFlight(threadId)
    ) {
      if (state.sessions[sessionId]?.info.status === "prompting") {
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
      }
      return;
    }

    this.setTurnError(threadId, kind, message);
    if (state.sessions[sessionId]?.info.status === "prompting") {
      setState(
        "sessions",
        sessionId,
        "info",
        "status",
        "ready" as SessionStatus,
      );
    }
  },

  async recoverDroppedPrompt(
    sessionId: string,
    reason: string,
    replay?: {
      prompt?: string;
      context?: Array<Record<string, string>>;
      displayContent?: string;
      docNames?: string[];
      currentUserMessageId?: string;
      retry?: boolean;
    },
  ): Promise<string | null> {
    const existingRecovery = recoveryInFlightMap.get(sessionId);
    if (existingRecovery) {
      console.info(
        `[AgentStore] recoverDroppedPrompt: recovery already in-flight for ${sessionId}`,
      );
      return existingRecovery;
    }

    const recoveryPromise = (async (): Promise<string | null> => {
      const session = state.sessions[sessionId];
      if (!session) {
        return null;
      }

      const conversationId = session.conversationId;
      const threadState = state.threadStates[conversationId];
      const promptText = replay?.prompt ?? threadState?.lastPromptText;
      const promptContext = replay?.context ?? threadState?.lastPromptContext;
      const shouldRetry = replay?.retry ?? true;

      if (!conversationId || !threadState?.turnInFlight) {
        return null;
      }

      if (!promptText && shouldRetry) {
        console.warn(
          "[AgentStore] recoverDroppedPrompt: no last prompt to replay for",
          conversationId,
        );
        this.setTurnError(
          conversationId,
          "crash_ceiling",
          "Session died before a prompt could be recovered.",
        );
        return null;
      }

      const restartExpiresAt = threadState.restartTimerExpiresAt;
      if (restartExpiresAt != null && Date.now() > restartExpiresAt) {
        this.setTurnError(
          conversationId,
          "crash_ceiling",
          "Worker-drop recovery exceeded the restart budget.",
        );
        return null;
      }

      console.info(
        `[AgentStore] Recovering dropped ${agentDisplayName(session.info.agentType)} prompt silently: ${reason}`,
      );
      if (restartExpiresAt == null) {
        this.armRestartTimer(conversationId, BUDGET_CRASH_MS, "crash_ceiling");
      }

      const snapshot = await buildDroppedPromptRecoverySnapshot(
        session,
        reason,
        replay?.currentUserMessageId,
      );
      const wasActive = state.activeSessionId === sessionId;
      const { cwd } = session;
      const agentType = session.info.agentType;
      const initialModelId = session.currentModelId;

      await this.terminateSession(sessionId, { nextActiveSessionId: null });

      const newSessionId = await this.spawnSession(cwd, agentType, {
        localSessionId: conversationId,
        restoredMessages: snapshot.restoredMessages,
        bootstrapPromptContext: snapshot.bootstrapPromptContext,
        initialModelId,
      });

      if (!newSessionId) {
        this.setTurnError(
          conversationId,
          "crash_ceiling",
          "Session died and could not be restarted.",
        );
        return null;
      }

      if (wasActive) {
        setState("activeSessionId", newSessionId);
      }

      await this.restoreSessionSettings(session, newSessionId);

      if (!shouldRetry) {
        console.info(
          "[AgentStore] recoverDroppedPrompt: fresh session ready after cancel, skipping replay",
        );
        this.setTurnInFlight(conversationId, false);
        this.clearTurnError(conversationId);
        return newSessionId;
      }

      try {
        const { merged: retryContext, newSignature } =
          await this.buildPromptContext(
            newSessionId,
            promptContext,
            promptText as string,
          );
        await providerService.sendPrompt(
          newSessionId,
          promptText as string,
          retryContext,
        );
        this.clearBootstrapPromptContext(newSessionId);
        if (newSignature !== null) {
          this.markPromptContextPrimed(newSessionId, newSignature);
        }
        console.info(
          `[AgentStore] Dropped-prompt replay dispatched on ${newSessionId}`,
        );
      } catch (retryError) {
        const retryMessage =
          retryError instanceof Error ? retryError.message : String(retryError);
        if (
          isRecoverableDeadSessionSendFailure(retryMessage) &&
          state.threadStates[conversationId]?.restartTimerExpiresAt != null &&
          Date.now() <=
            (state.threadStates[conversationId]?.restartTimerExpiresAt ?? 0)
        ) {
          console.info(
            "[AgentStore] Dropped-prompt replay hit another recoverable session failure; retrying silently:",
            retryMessage,
          );
          return this.recoverDroppedPrompt(newSessionId, retryMessage, {
            prompt: promptText,
            context: promptContext,
            displayContent: replay?.displayContent,
            docNames: replay?.docNames,
          });
        }

        console.error("[AgentStore] Dropped-prompt replay failed:", retryError);
        this.setTurnError(conversationId, "restart_timeout", retryMessage);
      }

      return newSessionId;
    })().finally(() => {
      recoveryInFlightMap.delete(sessionId);
    });

    recoveryInFlightMap.set(sessionId, recoveryPromise);
    return recoveryPromise;
  },

  /**
   * Re-dispatch the last submitted prompt for a thread. Used by the inline
   * "Couldn't send. Retry" link after a turn fails (#1631) or after a
   * mid-prompt session death (#1805). Consolidates retry logic so callers
   * don't need to know whether the session is still alive.
   *
   * Path A — live ready session: dispatch directly via sendPrompt.
   * Path B — no live session (terminated, removed, or never created):
   *   resumeAgentConversation respawns from SQLite-persisted history, then
   *   sendPrompt dispatches against the new session id.
   */
  async retryLastPrompt(threadId: string): Promise<void> {
    const ts = state.threadStates[threadId];
    if (!ts?.lastPromptText) {
      console.warn(
        "[AgentStore] retryLastPrompt: no lastPromptText for thread",
        threadId,
      );
      return;
    }

    const promptText = ts.lastPromptText;
    const promptContext = ts.lastPromptContext;
    const promptDisplay = ts.lastPromptDisplay;
    const promptDocNames = ts.lastPromptDocNames;

    this.clearTurnError(threadId);

    const live = this.getSessionForConversation(threadId);
    const liveStatus = live?.info.status;
    const isUsable =
      live && liveStatus !== "error" && liveStatus !== "terminated";

    let targetSessionId: string | null | undefined = isUsable
      ? live.info.id
      : undefined;

    if (!targetSessionId) {
      try {
        targetSessionId = await this.resumeAgentConversation(threadId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // setTurnError below routes this through _submitTurnErrorReport ->
        // captureSupportError, so the report is already covered. Local diagnostic.
        console.warn("[AgentStore] retryLastPrompt: respawn failed:", message);
        this.setTurnError(threadId, "crash_ceiling", message);
        return;
      }
      if (!targetSessionId) {
        this.setTurnError(
          threadId,
          "crash_ceiling",
          "Session could not be respawned for retry.",
        );
        return;
      }
      // resumeAgentConversation returns the conversationId when the session
      // already exists; for a brand-new spawn the returned id is the new
      // sessionId. Either way, look up the live session for dispatch.
      const respawned = this.getSessionForConversation(threadId);
      if (!respawned) {
        this.setTurnError(
          threadId,
          "crash_ceiling",
          "Session respawn returned without a live session.",
        );
        return;
      }
      targetSessionId = respawned.info.id;
    }

    try {
      await this.sendPrompt(
        promptText,
        promptContext,
        {
          displayContent: promptDisplay,
          docNames: promptDocNames,
        },
        targetSessionId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Covered by setTurnError -> _submitTurnErrorReport below. Local diagnostic.
      console.warn("[AgentStore] retryLastPrompt: dispatch failed:", message);
      this.setTurnError(threadId, "crash_ceiling", message);
    }
  },

  _submitTurnErrorReport(
    threadId: string,
    kind: ErrorKind,
    message: string | undefined,
  ): void {
    try {
      const session = Object.values(state.sessions).find(
        (s) => s.conversationId === threadId,
      );
      const toolCalls =
        session?.messages
          .filter((msg) => msg.toolCall)
          .slice(-20)
          .map((msg) => ({
            name: msg.toolCall?.kind || msg.toolCall?.title || "tool",
            id: msg.toolCallId || msg.toolCall?.toolCallId || "unknown",
          })) ?? [];

      void captureSupportError({
        kind: `agent.${kind}`,
        message: message ?? kind,
        stack: [],
        agentContext: {
          model: session?.currentModelId,
          provider: session?.info.agentType,
          tool_calls: toolCalls,
        },
      });
    } catch (err) {
      console.warn(
        "[AgentStore] _submitTurnErrorReport failed (ignored):",
        err,
      );
    }
  },

  /** Get the pending prompt queue for a session (reactive). */
  getPendingPrompts(sessionId: string): string[] {
    return state.sessions[sessionId]?.pendingPrompts ?? [];
  },

  /** Clear the prompt queue for a session (e.g. on cancel). */
  clearPromptQueue(sessionId: string): void {
    if (!state.sessions[sessionId]) return;
    setState("sessions", sessionId, "pendingPrompts", []);
  },

  /**
   * Get plan entries for the active session.
   */
  get plan(): PlanEntry[] {
    const session = this.activeSession;
    return session?.plan ?? [];
  },

  /**
   * Get the current streaming content for the active session.
   */
  get streamingContent(): string {
    const session = this.activeSession;
    return session?.streamingContent ?? "";
  },

  /**
   * Get the current streaming thinking content for the active session.
   */
  get streamingThinking(): string {
    const session = this.activeSession;
    return session?.streamingThinking ?? "";
  },

  /**
   * Get the current working directory for the active session.
   */
  get cwd(): string | null {
    const session = this.activeSession;
    return session?.cwd ?? null;
  },

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize the agent store by loading available agents.
   *
   * Retries `getAvailableAgents()` with exponential backoff when it throws
   * or returns an empty list. The provider-runtime cold start can take
   * 20+ seconds when launched from Cursor/Claude Code terminals
   * (see GH #1568, #1587); without retry the sidebar misses Codex/Gemini
   * permanently until app reload. Additionally subscribes to the
   * `provider-runtime://ready` event so the agent list populates when
   * the runtime eventually comes up beyond the backoff budget.
   */
  async initialize() {
    if (!runtimeHasCapability("agents")) {
      setState("availableAgents", []);
      setState("agentModeEnabled", false);
      setState("remoteSessions", []);
      setState("remoteSessionsNextCursor", null);
      setState("remoteSessionsError", null);
      return;
    }

    // Fire-and-forget subscription: if the runtime comes up late, we
    // re-query the agent list then. Idempotent because repeated calls
    // to applyAgents just overwrite availableAgents with the same data.
    subscribeToProviderRuntimeReady();
    subscribeToProviderRuntimeRestarted();
    subscribeToAgentConversationArchived();
    // Surface CLI-updater scan rejections per #1646. Default-on, runs once
    // at app init, idempotent (the runtime emits the event at most once
    // per launch per CLI). System notification + state record so the user
    // can review what was rejected and why.
    subscribeToCliScanRejections();
    subscribeToCliUpdateActions();
    void hydratePendingCliUpdateAction();
    // #1829: consume the synthetic-transcript schema-drift event so a
    // breaking Claude CLI auto-update forces compactSyntheticTranscript=false
    // at runtime. Pre-#1829 the runtime emitted this event but no consumer
    // existed in the TS layer, so the gate was one-way.
    subscribeToSyntheticTranscriptSchemaDrift();
    subscribeToClaudeMemoryIntercepts();

    const backoffMs = [0, 1_000, 2_000, 4_000, 8_000];
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      if (backoffMs[attempt] > 0) {
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      }
      try {
        const agents = await providerService.getAvailableAgents();
        if (agents.length > 0) {
          applyAgents(agents);
          return;
        }
        // Empty list — runtime probably not ready yet, keep retrying.
      } catch (error) {
        if (attempt === backoffMs.length - 1) {
          console.error("Failed to load available agents:", error);
        }
      }
    }
    // Budget exhausted. The `provider-runtime://ready` listener may still
    // populate later; meanwhile the sidebar shows Seren Agent only.
  },

  /**
   * Load recent persisted agent conversations for resuming.
   */
  async refreshRecentAgentConversations(limit = 10, cwd?: string) {
    try {
      const rows = await listConversations({
        kind: "agent",
        projectRoot: cwd,
        limit,
      });
      const agentConversations = rows.map(unifiedRowToAgent);
      for (const conversation of agentConversations) {
        privacyStore.hydrateConversationPrivilege(
          conversation.id,
          conversation.privileged,
          conversation.counsel_direction,
        );
      }
      setState(
        "recentAgentConversations",
        happyArchiveFence.filterVisible(agentConversations),
      );
    } catch (error) {
      console.error("Failed to load agent conversation history:", error);
    }
  },

  /**
   * Drop an agent conversation from the in-memory cache. Used when a
   * thread crosses out of agent-kind on a cross-category provider
   * switch - the DB row's `kind` has just flipped to `chat`, and a
   * subsequent `listConversations({ kind: 'agent' })` read would not
   * return it anyway.
   */
  dropAgentConversationFromCache(id: string) {
    setState("recentAgentConversations", (rows) =>
      rows.filter((r) => r.id !== id),
    );
  },

  /**
   * Insert (or replace) an agent conversation row in the in-memory
   * cache from a freshly-read DB row. Used when a thread crosses INTO
   * agent-kind on a cross-category switch.
   */
  upsertAgentConversationFromDb(row: DbAgentConversation) {
    if (happyArchiveFence.isArchived(row.id)) return;
    privacyStore.hydrateConversationPrivilege(
      row.id,
      row.privileged,
      row.counsel_direction,
    );
    setState("recentAgentConversations", (rows) => {
      const without = rows.filter((r) => r.id !== row.id);
      return [row, ...without];
    });
  },
  /**
   * List remote sessions from the selected agent's underlying store.
   */
  async refreshRemoteSessions(cwd: string, agentType?: AgentType) {
    if (state.remoteSessionsLoading) {
      return;
    }
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const [page, rawLocalRows] = await Promise.all([
        providerService.listRemoteSessions(resolvedAgentType, cwd),
        listConversations({ kind: "agent", limit: 200 }),
      ]);
      const localRows = happyArchiveFence.filterVisible(
        rawLocalRows.map(unifiedRowToAgent),
      );

      for (const conversation of localRows) {
        privacyStore.hydrateConversationPrivilege(
          conversation.id,
          conversation.privileged,
          conversation.counsel_direction,
        );
      }

      setState("recentAgentConversations", localRows);
      const titleOverrides = new Map(
        localRows
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );

      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));

      setState("remoteSessions", mergedSessions);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Provider RPC failure (Tauri invoke) — not an HTTP call, so nothing
      // captures it centrally. This surfaces a user-facing error state, so it
      // is a reportable Gateway-feature failure.
      reportError("agent.remote_sessions_list_failed", msg, { cause: error });
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  async loadMoreRemoteSessions(cwd: string, agentType?: AgentType) {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const cursor = state.remoteSessionsNextCursor;
    if (!cursor) return;
    setState("remoteSessionsLoading", true);
    setState("remoteSessionsError", null);
    try {
      const page = await providerService.listRemoteSessions(
        resolvedAgentType,
        cwd,
        cursor,
      );
      const titleOverrides = new Map(
        state.recentAgentConversations
          .filter(
            (c) =>
              c.agent_type === resolvedAgentType &&
              c.agent_session_id &&
              c.title.trim().length > 0,
          )
          .map((c) => [c.agent_session_id as string, c.title]),
      );
      const mergedSessions = page.sessions.map((s) => ({
        ...s,
        title: titleOverrides.get(s.sessionId) ?? s.title,
      }));
      setState("remoteSessions", (prev) => [...prev, ...mergedSessions]);
      setState("remoteSessionsNextCursor", page.nextCursor ?? null);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Provider RPC failure (Tauri invoke) with no central capture; reportable.
      reportError("agent.remote_sessions_load_more_failed", msg, {
        cause: error,
      });
      setState("remoteSessionsError", msg);
    } finally {
      setState("remoteSessionsLoading", false);
    }
  },

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Spawn a new agent session.
   */
  async spawnSession(
    cwd: string,
    agentType?: AgentType,
    opts?: {
      localSessionId?: string;
      resumeAgentSessionId?: string;
      conversationTitle?: string;
      initRetryAttempt?: number;
      reclaimedIdleClaude?: boolean;
      restoredMessages?: AgentMessage[];
      bootstrapPromptContext?: string;
      initialModelId?: string;
      initialPermissionMode?: string;
      /** Pinned Planner/Executor model + effort for paired threads. */
      paired?: PairedSpawnConfig;
      /** Warm-standby spawns are invisible to the UI — no session-selector
       *  entry, events buffered not rendered, does not steal active focus. */
      role?: "serving" | "standby";
      /** Persisted serving conversation that owns a predictive standby. */
      archiveOwnerConversationId?: string;
    },
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    // Every agent process receives a stable session id before its credential
    // lease is created. Providers echo this id back as their session handle,
    // which lets one teardown path revoke the exact key used by the child.
    const localSessionId = opts?.localSessionId ?? crypto.randomUUID();
    try {
      providerService.assertPrivilegedConversationProvider(
        localSessionId,
        privacyStore.isPrivileged(localSessionId),
        resolvedAgentType,
        { lmStudioBaseUrl: settingsStore.get("lmStudioBaseUrl") },
      );
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error));
      return null;
    }
    const resumeAgentSessionId = opts?.resumeAgentSessionId;
    const happyArchiveOwnerConversationId =
      opts?.archiveOwnerConversationId ?? localSessionId;
    const happyArchiveGeneration = happyArchiveOwnerConversationId
      ? happyArchiveFence.capture(happyArchiveOwnerConversationId)
      : null;
    if (
      happyArchiveOwnerConversationId &&
      !happyArchiveFence.allows(
        happyArchiveOwnerConversationId,
        happyArchiveGeneration ?? 0,
      )
    ) {
      return null;
    }
    const initRetryAttempt = opts?.initRetryAttempt ?? 0;
    const reclaimedIdleClaude = opts?.reclaimedIdleClaude ?? false;
    const conversationTitle =
      opts?.conversationTitle ??
      (resolvedAgentType === "codex"
        ? "Codex Agent"
        : resolvedAgentType === "gemini"
          ? "Gemini Agent"
          : resolvedAgentType === "grok"
            ? "Grok Agent"
            : resolvedAgentType === "claude-codex"
              ? "Claude + Codex"
              : resolvedAgentType === "lmstudio"
                ? "LM Studio Agent"
                : "Claude Code Agent");

    // Prevent concurrent spawns for the same conversation. Internal retries
    // (initRetryAttempt > 0) are allowed through because they are sequential
    // continuations of the same spawn attempt, not independent races.
    const spawnKey = localSessionId;
    if (initRetryAttempt === 0 && spawningConversations.has(spawnKey)) {
      console.log(
        "[AgentStore] spawnSession: spawn already in progress for",
        spawnKey,
        "— skipping duplicate",
      );
      return null;
    }
    if (initRetryAttempt === 0) {
      spawningConversations.add(spawnKey);
    }

    let credentialLeaseCreated = false;
    let spawnedSessionId: string | null = null;

    try {
      setState("isLoading", true);
      setState("error", null);

      console.log("[AgentStore] Spawning session:", {
        agentType: resolvedAgentType,
        cwd,
        localSessionId,
        resumeAgentSessionId,
      });

      // Bootstrap Seren memory context so the agent starts with relevant
      // recall from past sessions. Completed turns are extracted into typed
      // memories after the answer lands, and this pulls them back on fresh
      // spawns including post-compaction spawns. Best-effort; a failure here
      // must not block the spawn (#1625).
      let memoryContext: string | undefined;
      if (
        settingsStore.settings.memoryEnabled &&
        !privacyStore.isMemoryExcluded(localSessionId)
      ) {
        try {
          const bootstrapped = await bootstrapMemoryContext();
          if (bootstrapped && bootstrapped.trim().length > 0) {
            memoryContext = bootstrapped;
          }
        } catch (err) {
          console.warn(
            "[AgentStore] memory bootstrap failed (non-fatal):",
            err,
          );
        }
      }
      const finalBootstrapContext = memoryContext
        ? opts?.bootstrapPromptContext
          ? `${memoryContext}\n\n${opts.bootstrapPromptContext}`
          : memoryContext
        : opts?.bootstrapPromptContext;

      // Preemptively terminate idle Claude sessions for other conversations
      // before spawning. Claude CLI cannot reliably initialize a second
      // instance while another is alive (see isRetryableClaudeInitError).
      // Without this, the new session times out 3x (60s) before the existing
      // post-failure idle-reclaim logic kicks in.
      //
      // Warm-standby spawns (#1631) are additive — they must NOT terminate
      // any other session. If Claude CLI fails to init while the serving
      // session is alive, the predictive path aborts silently and serving
      // stays intact. Killing serving here would catastrophically replace
      // the live session mid-turn.
      if (
        resolvedAgentType === "claude-code" &&
        initRetryAttempt === 0 &&
        opts?.role !== "standby"
      ) {
        const idleSessions = getIdleClaudeSessionIds(localSessionId);
        for (const idleId of idleSessions) {
          console.log(
            "[AgentStore] Reclaiming idle Claude session before spawn:",
            idleId,
          );
          await this.terminateSession(idleId);
        }
      }

      console.log("[AgentStore] Checking agent availability...");
      const agentAvailable =
        await providerService.checkAgentAvailable(resolvedAgentType);
      if (!agentAvailable) {
        const helper =
          state.availableAgents.find(
            (agent) => agent.type === resolvedAgentType,
          )?.unavailableReason ??
          `${agentDisplayName(resolvedAgentType)} is not available in this runtime.`;
        setState("error", helper);
        setState("isLoading", false);
        return null;
      }

      // Set up a global listener for session status events BEFORE spawning
      // This ensures we don't miss the "ready" event due to race conditions
      let resolveReady: ((sessionId: string) => void) | null = null;
      let rejectReady: ((error: Error) => void) | null = null;
      const readyPromise = new Promise<string>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });

      // Filter status events by the spawn's own session id. Without this
      // filter a `terminated`/`error` event from an unrelated session can
      // abort the new spawn, and a `ready` from an unrelated session can
      // resolve the readyPromise with the wrong id. Seeded from
      // localSessionId when the caller pre-allocated one (resume / re-spawn);
      // otherwise updated to info.id once spawnAgent returns. #1852.
      let expectedReadySessionId: string | null = localSessionId ?? null;

      // Listen to session status events temporarily so ready-state resolution does
      // not depend on global event routing order.
      const tempUnsubscribe =
        await providerService.subscribeToEvent<SessionStatusEvent>(
          "sessionStatus",
          (data) => {
            console.log("[AgentStore] Received session status event:", data);
            if (state.sessions[data.sessionId]) {
              this.handleStatusChange(data.sessionId, data.status, data);
            }
            if (
              expectedReadySessionId &&
              data.sessionId !== expectedReadySessionId
            ) {
              return;
            }
            if (data.status === "ready" && resolveReady) {
              resolveReady(data.sessionId);
            } else if (data.status === "error" && rejectReady) {
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                "Agent session failed during initialization.";
              rejectReady(new Error(sessionError));
            } else if (data.status === "terminated" && rejectReady) {
              // The provider process exited before reaching "ready" — typically
              // an auth failure or binary-not-found on Windows.
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                agentInitializationFailureMessage(resolvedAgentType);
              rejectReady(new Error(sessionError));
            }
          },
        );

      // Subscribe once to all agent runtime events before spawning, so early replay events
      // from load_session are buffered instead of dropped.
      await this.ensureAgentEventSubscription();

      try {
        // Ensure the underlying CLI is installed and up-to-date before spawning
        const ensureFn =
          resolvedAgentType === "claude-code"
            ? providerService.ensureClaudeCli
            : resolvedAgentType === "codex"
              ? providerService.ensureCodexCli
              : resolvedAgentType === "gemini"
                ? providerService.ensureGeminiCli
                : resolvedAgentType === "grok"
                  ? providerService.ensureGrokCli
                  : resolvedAgentType === "claude-codex"
                    ? providerService.ensurePairedCli
                    : null;

        if (ensureFn) {
          console.log("[AgentStore] Ensuring CLI is installed...");
          let progressUnsub: UnlistenFn = () => {};

          if (!isLocalProviderRuntime()) {
            setState(
              "error",
              "Local provider runtime is not configured for agent installation.",
            );
            setState("isLoading", false);
            return null;
          }

          progressUnsub = onRuntimeEvent(
            "provider://cli-install-progress",
            (payload) => {
              const event = payload as { stage?: string; message?: string };
              setState("installStatus", event.message ?? null);
            },
          );

          try {
            await ensureFn();
          } catch (error) {
            progressUnsub();
            tempUnsubscribe();
            const message =
              error instanceof Error
                ? error.message
                : `Failed to install ${agentDisplayName(resolvedAgentType)} CLI`;
            setState("error", message);
            setState("isLoading", false);
            setState("installStatus", null);
            return null;
          }

          progressUnsub();
          setState("installStatus", null);
        }

        // A child process receives an opaque loopback-broker capability, never
        // a publisher key. Rust owns the remote key id, the real key material,
        // the retry ledger, and revocation. #3194.
        let serenCredential:
          | { capability: string; mcpUrl: string; apiBaseUrl: string }
          | undefined;
        if (authStore.isAuthenticated) {
          const lease = await createCredentialLease(localSessionId);
          serenCredential = {
            capability: lease.capability,
            mcpUrl: lease.mcpUrl,
            apiBaseUrl: lease.apiBaseUrl,
          };
          credentialLeaseCreated = true;
        }
        const enabledMcpServers = getEnabledMcpServers();

        // No inactivity timeout — agent sessions wait indefinitely.
        // The agent may be waiting for tool approval, thinking, or the user
        // may have stepped away. Killing the session is never the right call.
        const timeoutSecs = undefined;

        // Codex defaults to "on-failure" (auto-approve safe ops) regardless of
        // the global agentApprovalPolicy setting, which applies to Claude Code.
        const approvalPolicy =
          resolvedAgentType === "codex"
            ? "on-failure"
            : settingsStore.settings.agentApprovalPolicy;

        // Register spawn context so the global event logger can identify
        // early events that arrive before the session is in state.sessions.
        // Also clear the terminated flag — this session ID is being reborn;
        // events from the new process must NOT be dropped by the stale filter.
        spawnContextMap.set(localSessionId, {
          agentType: resolvedAgentType,
          conversationId: localSessionId,
        });
        terminatedSessionIds.delete(localSessionId);

        // Paired threads seed the Claude planner with the same default effort
        // a direct Claude Code thread would get; per-role overrides ride in
        // opts.paired.
        const reasoningEffort =
          resolvedAgentType === "claude-code" ||
          resolvedAgentType === "claude-codex"
            ? settingsStore.settings.claudeReasoningEffort
            : undefined;

        await refreshClaudeMemoryMdBeforeSpawn(
          cwd,
          resolvedAgentType,
          Boolean(serenCredential),
        );

        console.log("[AgentStore] Spawning agent process...");
        const info = await providerService.spawnAgent(
          resolvedAgentType,
          cwd,
          settingsStore.settings.agentSandboxMode,
          serenCredential,
          approvalPolicy,
          settingsStore.settings.agentSearchEnabled,
          settingsStore.settings.agentNetworkEnabled,
          localSessionId,
          resumeAgentSessionId,
          timeoutSecs,
          enabledMcpServers,
          reasoningEffort,
          // Pass the persisted model through at spawn time so the CLI starts
          // on the user's selected model (vs. the runtime's hardcoded default).
          // The post-spawn setModel below remains a safety net for mid-session
          // picker changes. See #1635.
          opts?.initialModelId,
          opts?.paired,
          settingsStore.settings.lmStudioBaseUrl,
          settingsStore.settings.lmStudioApiKey,
          settingsStore.settings.agentAutoApproveReads,
        );
        spawnedSessionId = info.id;
        if (info.id !== localSessionId) {
          await revokeCredentialLease(localSessionId).catch((error) => {
            console.warn(
              "[AgentStore] Failed to revoke mismatched credential lease:",
              error,
            );
          });
          credentialLeaseCreated = false;
          throw new Error(
            "Agent spawn returned a session id that does not match its credential lease.",
          );
        }
        console.log("[AgentStore] Spawn result:", info);
        expectedReadySessionId = info.id;
        const guardedConversationId =
          happyArchiveOwnerConversationId ?? info.id;
        const happyArchiveAllowsCommit = () =>
          !happyProviderArchiveTombstones.has(info.id) &&
          !happyArchiveFence.isArchived(info.id) &&
          (!happyArchiveOwnerConversationId ||
            happyArchiveFence.allows(
              happyArchiveOwnerConversationId,
              happyArchiveGeneration ?? 0,
            ));
        const abortArchivedSpawn = async (): Promise<null> => {
          await discardLateArchivedProviderSession(
            info.id,
            guardedConversationId,
          );
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        };
        const abortProviderArchivedSpawn = async (): Promise<null> => {
          terminatedSessionIds.add(info.id);
          sessionReadyPromises.get(info.id)?.resolve();
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          spawnContextMap.delete(info.id);
          recoveryInFlightMap.delete(info.id);
          clearChunkBuf(info.id);
          clearToolEventBuf(info.id);
          await revokeCredentialLease(info.id).catch((error) => {
            console.warn(
              "[AgentStore] Failed to revoke provider-only archived spawn credential lease:",
              error,
            );
          });
          await providerService.terminateSession(info.id).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!message.includes("not found")) {
              console.warn(
                "[AgentStore] Failed to terminate provider-only archived spawn:",
                error,
              );
            }
          });
          if (state.sessions[info.id]) {
            setState(
              produce((draft) => {
                delete draft.sessions[info.id];
              }),
            );
          }
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        };
        const abortHappyArchivedSpawn = () =>
          happyProviderArchiveTombstones.has(info.id)
            ? abortProviderArchivedSpawn()
            : abortArchivedSpawn();

        if (!happyArchiveAllowsCommit()) {
          return abortHappyArchivedSpawn();
        }
        await refreshAgentOAuthRouting(info.id, guardedConversationId);
        if (!happyArchiveAllowsCommit()) {
          return abortHappyArchivedSpawn();
        }

        // The new session is alive — immediately clear the terminated flag so
        // early events (configOptionsUpdate, sessionStatus with models/modes)
        // are NOT dropped by the global subscriber's terminatedSessionIds guard.
        // Without this, the pre-cleanup terminateSession call marks the ID, and
        // events from the NEW session get silently dropped before registration.
        terminatedSessionIds.delete(info.id);

        // Persist an agent conversation record (safe to call repeatedly via INSERT OR IGNORE).
        //
        // Warm-standby spawns (#1631) must NOT write a DB row — the standby
        // is ephemeral. On promotion, the promoted session inherits the
        // serving session's conversationId (which already has a row); on
        // abort/cancel the standby is terminated and nothing is persisted.
        // Without this guard, every warm-up left an orphaned thread row that
        // re-surfaced as an idle agent thread in the sidebar after restart.
        let persistedConversation: DbAgentConversation | null = null;
        if (opts?.role !== "standby") {
          try {
            persistedConversation = await createAgentConversation(
              info.id,
              conversationTitle,
              resolvedAgentType,
              cwd,
              cwd,
              resumeAgentSessionId ?? undefined,
              serializeAgentConversationMetadata({
                pendingBootstrapPromptContext: opts?.bootstrapPromptContext,
                pendingBootstrapMessages: opts?.bootstrapPromptContext
                  ? opts?.restoredMessages
                  : undefined,
                pairedConfig: opts?.paired,
              }) ?? undefined,
            );
          } catch (error) {
            console.warn("Failed to persist agent conversation", error);
          }
        }
        if (persistedConversation?.is_archived) {
          happyArchiveFence.archive(info.id);
          happyArchiveFence.archive(guardedConversationId);
          return abortHappyArchivedSpawn();
        }
        if (!happyArchiveAllowsCommit()) {
          return abortHappyArchivedSpawn();
        }

        // Create session state
        const hasRestoredMessages =
          opts?.restoredMessages && opts.restoredMessages.length > 0;
        // Prefer the per-model context window we previously learned from CLI
        // metadata; fall back to the agent-type default. The first session of a
        // brand-new model still hits the default for one prompt, then the
        // promptComplete capture below upserts the real value for next time.
        const cachedContextWindow = opts?.initialModelId
          ? await getCachedModelContextWindow(
              resolvedAgentType,
              opts.initialModelId,
            )
          : null;
        if (!happyArchiveAllowsCommit()) {
          return abortHappyArchivedSpawn();
        }
        const session: ActiveSession = {
          info,
          // Only explicit titles belong in live state. Fresh conversations omit
          // this option so their first user prompt can still derive the title.
          title: opts?.conversationTitle,
          messages: opts?.restoredMessages ?? [],
          plan: [],
          pendingToolCalls: new Map(),
          streamingContent: "",
          streamingThinking: "",
          pendingUserMessage: "",
          cwd,
          conversationId: info.id,
          archiveOwnerConversationId: opts?.archiveOwnerConversationId,
          // When we already have a pending local bootstrap snapshot, skip the
          // provider's replay to avoid duplicates until that bootstrap state is
          // cleared and provider history becomes authoritative.
          skipHistoryReplay: hasRestoredMessages ? true : undefined,
          restoredMessageCount: hasRestoredMessages
            ? opts?.restoredMessages?.length
            : undefined,
          contextWindowSize:
            cachedContextWindow ??
            defaultContextWindowFor(resolvedAgentType, opts?.initialModelId),
          bootstrapPromptContext: finalBootstrapContext,
          pendingPrompts: [],
          role: opts?.role ?? "serving",
        };

        setState("sessions", info.id, session);

        // Session is now registered — spawn context no longer needed for logging.
        spawnContextMap.delete(info.id);
        // This session is alive — ensure it's not in the terminated set
        // (edge case: reused conversation ID from a prior terminated session).
        terminatedSessionIds.delete(info.id);

        // Only take focus if no session is currently active. Background spawns
        // (e.g. compaction of an inactive thread) must not steal focus from
        // the user's current thread. The caller (threadStore.selectThread,
        // resumeAgentConversation, etc.) is responsible for setting focus
        // after spawn when the user explicitly navigates to the thread.
        if (!state.activeSessionId) {
          setState("activeSessionId", info.id);
        }

        const pendingEvents = pendingSessionEvents.get(info.id);
        if (pendingEvents?.length) {
          for (const pendingEvent of pendingEvents) {
            this.handleSessionEvent(info.id, pendingEvent);
          }
          pendingSessionEvents.delete(info.id);
        }

        // Create a ready promise that sendPrompt can await
        let readyResolve: () => void;
        const readyPromiseObj = {
          promise: new Promise<void>((resolve) => {
            readyResolve = resolve;
          }),
          resolve: () => readyResolve(),
        };
        sessionReadyPromises.set(info.id, readyPromiseObj);

        // Buffered resume events can mark the session ready before this gate is
        // installed. If that already happened, don't leave sendPrompt blocked on
        // a promise that will never resolve.
        if (state.sessions[info.id]?.info.status === "ready") {
          readyPromiseObj.resolve();
          sessionReadyPromises.delete(info.id);
        }

        // Wait for ready event with timeout (agent initialization can take a moment)
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(
            () => reject(new Error("Agent initialization timed out")),
            30000,
          );
        });

        let initFailure: string | null = null;
        try {
          const readySessionId = await Promise.race([
            readyPromise,
            timeoutPromise,
          ]);
          console.log("[AgentStore] Session ready:", readySessionId);

          // Update status to ready
          if (readySessionId === info.id) {
            setState(
              "sessions",
              info.id,
              "info",
              "status",
              "ready" as SessionStatus,
            );
          }
        } catch (raceError) {
          const message =
            raceError instanceof Error ? raceError.message : String(raceError);
          if (message.toLowerCase().includes("timed out")) {
            // Check if the session has an error or was terminated — if so, this
            // is a real failure (e.g. unauthenticated Claude on Windows), not a
            // benign slow start that we can proceed past.
            const sessionState = state.sessions[info.id];
            const sessionDead =
              !sessionState ||
              sessionState.error ||
              sessionState.info.status === "error" ||
              sessionState.info.status === "terminated";

            if (sessionDead) {
              console.error(
                "[AgentStore] Session terminated or errored during init wait:",
                sessionState?.error ?? sessionState?.info.status,
              );
              initFailure =
                sessionState?.error ??
                agentInitializationFailureMessage(resolvedAgentType);
            } else {
              console.warn(
                "[AgentStore] Timeout waiting for ready, proceeding anyway",
              );
              // Resolve the ready promise so sendPrompt doesn't block forever
              const entry = sessionReadyPromises.get(info.id);
              if (entry) {
                entry.resolve();
                sessionReadyPromises.delete(info.id);
              }
            }
          } else {
            initFailure = message;
          }
        }

        if (initFailure) {
          if (!happyArchiveAllowsCommit()) {
            return abortHappyArchivedSpawn();
          }
          if (
            resolvedAgentType === "claude-code" &&
            initRetryAttempt < MAX_CLAUDE_INIT_RETRIES &&
            isRetryableClaudeInitError(initFailure)
          ) {
            console.warn(
              "[AgentStore] Claude init failed, retrying:",
              initFailure,
            );
            await this.terminateSession(info.id);
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            const delayMs =
              CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
              Math.floor(Math.random() * 200);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: initRetryAttempt + 1,
            });
          }
          if (
            resolvedAgentType === "claude-code" &&
            !reclaimedIdleClaude &&
            isRetryableClaudeInitError(initFailure)
          ) {
            const idleClaude = getIdleClaudeSessionIds(localSessionId);
            if (idleClaude.length > 0) {
              const evictedId = idleClaude[0];
              console.warn(
                "[AgentStore] Claude init failed under pressure; reclaiming idle Claude session and retrying:",
                evictedId,
              );
              await this.terminateSession(evictedId);
              await this.terminateSession(info.id);
              sessionReadyPromises.delete(info.id);
              pendingSessionEvents.delete(info.id);
              setState("isLoading", false);
              tempUnsubscribe();
              await new Promise((resolve) => setTimeout(resolve, 300));
              return this.spawnSession(cwd, resolvedAgentType, {
                ...opts,
                initRetryAttempt: 0,
                reclaimedIdleClaude: true,
              });
            }
          }

          setState("error", initFailure);
          await this.terminateSession(info.id);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        // Worker can fail fast and remove the session before timeout handling.
        // Treat that as an initialization failure instead of returning a dead id.
        if (!state.sessions[info.id]) {
          if (!happyArchiveAllowsCommit()) {
            return abortHappyArchivedSpawn();
          }
          const exitedMsg = "Agent session exited during initialization.";
          if (
            resolvedAgentType === "claude-code" &&
            initRetryAttempt < MAX_CLAUDE_INIT_RETRIES
          ) {
            console.warn(
              "[AgentStore] Claude session exited during init, retrying.",
            );
            sessionReadyPromises.delete(info.id);
            pendingSessionEvents.delete(info.id);
            setState("isLoading", false);
            tempUnsubscribe();
            const delayMs =
              CLAUDE_INIT_RETRY_DELAY_MS * (initRetryAttempt + 1) +
              Math.floor(Math.random() * 200);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return this.spawnSession(cwd, resolvedAgentType, {
              ...opts,
              initRetryAttempt: initRetryAttempt + 1,
            });
          }
          if (resolvedAgentType === "claude-code" && !reclaimedIdleClaude) {
            const idleClaude = getIdleClaudeSessionIds(localSessionId);
            if (idleClaude.length > 0) {
              const evictedId = idleClaude[0];
              console.warn(
                "[AgentStore] Claude init exited early; reclaiming idle Claude session and retrying:",
                evictedId,
              );
              await this.terminateSession(evictedId);
              sessionReadyPromises.delete(info.id);
              pendingSessionEvents.delete(info.id);
              setState("isLoading", false);
              tempUnsubscribe();
              await new Promise((resolve) => setTimeout(resolve, 300));
              return this.spawnSession(cwd, resolvedAgentType, {
                ...opts,
                initRetryAttempt: 0,
                reclaimedIdleClaude: true,
              });
            }
          }

          setState("error", exitedMsg);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        // If the worker reported an initialization error, treat spawn as failed.
        // This is especially important for resume flows where the sidecar can
        // accept the command but then fail load_session (e.g. missing Claude id).
        const spawned = state.sessions[info.id];
        const initError =
          spawned?.error ??
          (spawned?.info.status === "error"
            ? "Agent session failed during initialization."
            : null);
        if (initError) {
          setState("error", initError);
          await this.terminateSession(info.id);
          sessionReadyPromises.delete(info.id);
          pendingSessionEvents.delete(info.id);
          setState("isLoading", false);
          tempUnsubscribe();
          return null;
        }

        setState("isLoading", false);
        tempUnsubscribe();

        // Re-apply the user's persisted model + permission-mode choices so
        // that resume/compaction/app-restart preserve them across threads.
        if (opts?.initialModelId) {
          try {
            await this.setModel(opts.initialModelId, info.id);
          } catch (err) {
            console.warn(
              "[AgentStore] Failed to re-apply persisted model on spawn:",
              err,
            );
          }
        }
        if (opts?.initialPermissionMode) {
          try {
            await this.setPermissionMode(opts.initialPermissionMode, info.id);
          } catch (err) {
            console.warn(
              "[AgentStore] Failed to re-apply persisted permission mode on spawn:",
              err,
            );
          }
        }

        if (!happyArchiveAllowsCommit()) {
          return abortHappyArchivedSpawn();
        }
        return info.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Runtime RPC timeouts surface when the embedded provider-runtime is
        // unresponsive — the Rust runtime monitor will restart it and the
        // `provider-runtime://restarted` listener re-dispatches the in-flight
        // turn. This is a transient runtime-layer failure, not a code defect
        // the user can act on, so it is explicitly suppressed from the support
        // pipeline. #151.
        if (message.includes("Runtime RPC timed out")) {
          benignConsoleError(
            "agent.spawn_runtime_unresponsive",
            `[AgentStore] Spawn error (${agentDisplayName(resolvedAgentType)}) — runtime unresponsive: ${message}`,
          );
        } else {
          console.error(
            `[AgentStore] Spawn error (${agentDisplayName(resolvedAgentType)}):`,
            error,
          );
        }
        // Mark as terminated so the global event subscriber drops any
        // late-arriving events from this dead session. Without this,
        // stale errors leak into retried sessions that reuse the same ID.
        terminatedSessionIds.add(spawnKey);
        if (credentialLeaseCreated) {
          await revokeCredentialLease(localSessionId).catch((revokeError) => {
            console.warn(
              "[AgentStore] Failed to revoke failed spawn credential lease:",
              revokeError,
            );
          });
          credentialLeaseCreated = false;
        }
        if (spawnedSessionId) {
          await providerService
            .terminateSession(spawnedSessionId)
            .catch((terminateError) => {
              console.warn(
                "[AgentStore] Failed to terminate failed spawn session:",
                terminateError,
              );
            });
        }
        tempUnsubscribe();
        setState("error", message);
        setState("isLoading", false);
        return null;
      }
    } finally {
      // Release the spawn guard so future spawns for this conversation can proceed.
      // Only the outermost call (attempt 0) holds the guard, so only it cleans up.
      if (initRetryAttempt === 0) {
        spawningConversations.delete(spawnKey);
      }
    }
  },

  /**
   * Install the single global agent-runtime event subscription if it is not
   * already attached. The frontend loses this subscription on a full webview
   * reload (the module-level handle resets to null), while the provider
   * runtime — and its live sessions — survive. Both spawn and re-attach call
   * this so events from an already-running session are routed again.
   */
  async ensureAgentEventSubscription(): Promise<void> {
    if (globalUnsubscribe) return;
    globalUnsubscribe = await providerService.subscribeToAllEvents((event) => {
      const eventSessionId = event.data.sessionId;
      if (!eventSessionId) return;

      // Auth failure during spawn — handle BEFORE the session-routing
      // logic below, because the session is not yet registered in
      // state.sessions when this fires (the spawn promise is still
      // pending). Auto-trigger launchLogin so the user can finish
      // signing in without knowing the CLI command. (#1476)
      if (event.type === "loginRequired") {
        const data = event.data;
        console.log(
          "[AgentStore] Login required for",
          data.agentType,
          "— auto-launching login flow:",
          data.reason,
        );
        setState(
          "error",
          `${agentDisplayName(data.agentType)} sign-in required. Opening a Terminal window — finish the login there, then click + New Agent → ${agentDisplayName(data.agentType)} Agent again.`,
        );
        providerService
          .launchLogin(data.agentType)
          .catch((err) =>
            console.error("[AgentStore] launchLogin failed:", err),
          );
        return;
      }

      // Drop events for sessions that have been explicitly terminated —
      // UNLESS a new spawn is in progress for this ID (spawnContextMap).
      // Without the first check, late errors from dead sessions leak in.
      // Without the second check, config events from a respawned session
      // (same ID) are silently dropped, losing model/mode/effort data.
      if (
        terminatedSessionIds.has(eventSessionId) &&
        !spawnContextMap.has(eventSessionId)
      ) {
        return;
      }

      // Event receipt logs are high-volume during tool-heavy agent runs,
      // so they stay behind an explicit localStorage debug switch.
      if (shouldLogAgentRuntimeEvent(event.type)) {
        const session = state.sessions[eventSessionId];
        const spawnCtx = session
          ? undefined
          : spawnContextMap.get(eventSessionId);
        console.debug(
          "[AgentRuntime] Event received - type:",
          event.type,
          "agent:",
          session?.info?.agentType ?? spawnCtx?.agentType ?? "unknown",
          "sessionId:",
          eventSessionId,
          "conversationId:",
          session?.conversationId ?? spawnCtx?.conversationId,
        );
      }
      if (state.sessions[eventSessionId]) {
        this.handleSessionEvent(eventSessionId, event);
        return;
      }

      const pending = pendingSessionEvents.get(eventSessionId) ?? [];
      pending.push(event);
      if (pending.length > PENDING_SESSION_EVENT_LIMIT) {
        pending.shift();
      }
      pendingSessionEvents.set(eventSessionId, pending);
    });
  },

  /**
   * Re-adopt a live provider-runtime session for this conversation instead of
   * tearing it down. The provider runtime is app-scoped and outlives webview
   * reloads/reconnects, so after the frontend loses its in-memory handle the
   * backend can still hold a running CLI session — together with any in-flight
   * background subagents (`Agent(run_in_background: true)`) it spawned. The
   * resume path used to pre-emptively `terminateSession` here, which SIGKILLs
   * the whole CLI process tree and silently loses that background work; the
   * orphaned task then surfaces on the next turn as a false "stopped by user"
   * notification. Re-attaching keeps the process tree — and the background
   * work — alive. A killed grandchild cannot be recovered after the fact, so
   * not reaping it is the only fix that preserves it. #2669
   *
   * Returns true when a live session was adopted; false when there is no
   * usable live session and the caller should fall back to terminate+respawn.
   */
  async reattachLiveSession(conversationId: string): Promise<boolean> {
    const inFlight = reattachingConversations.get(conversationId);
    if (inFlight) {
      return inFlight;
    }
    const happyArchiveGeneration = happyArchiveFence.capture(conversationId);
    if (!happyArchiveFence.allows(conversationId, happyArchiveGeneration)) {
      return false;
    }

    const attempt = (async () => {
      let liveInfo: AgentSessionInfo | undefined;
      try {
        const backendSessions = await providerService.listSessions();
        liveInfo = backendSessions.find((s) => s.id === conversationId);
      } catch (err) {
        // If we cannot ask the runtime, fall back to the normal respawn path.
        console.warn(
          "[AgentStore] listSessions during re-attach probe failed:",
          err,
        );
        return false;
      }

      // No live session, or one the runtime already considers dead — let the
      // caller terminate (a no-op for a missing session) and respawn fresh.
      if (
        !liveInfo ||
        liveInfo.status === "terminated" ||
        liveInfo.status === "error"
      ) {
        return false;
      }

      // Paired (claude-codex) threads are a two-inner-session structure whose
      // PairedStatus the runtime's flat session info does not expose. Re-adopting
      // one would drop the paired UI, so leave paired resumes on the existing
      // terminate+respawn path (which reseeds pairedConfig from metadata). #2672
      if (liveInfo.agentType === "claude-codex") {
        return false;
      }

      // Restore the persisted transcript for display. The live session already
      // streamed these turns while connected; re-attach renders them from SQLite
      // rather than replaying from a fresh process.
      const restored = await loadPersistedAgentHistory(conversationId);
      let convo: DbAgentConversation | null = null;
      try {
        convo = await getAgentConversation(conversationId);
      } catch {
        // Non-fatal — the runtime is the source of truth for the live session.
      }
      if (convo?.privileged) {
        privacyStore.hydrateConversationPrivilege(
          convo.id,
          true,
          convo.counsel_direction,
        );
        try {
          providerService.assertPrivilegedConversationProvider(
            conversationId,
            true,
            liveInfo.agentType,
            { lmStudioBaseUrl: settingsStore.get("lmStudioBaseUrl") },
          );
        } catch (error) {
          setState(
            "error",
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }
      const agentType = liveInfo.agentType;
      const runtimeModelId =
        liveInfo.currentModelId ?? convo?.agent_model_id ?? undefined;
      const runtimeModeId =
        liveInfo.currentModeId ?? convo?.agent_permission_mode ?? undefined;
      const rehydratedPendingPermissions = (
        liveInfo.pendingPermissions ?? []
      ).filter(
        (permission) =>
          permission?.sessionId === conversationId &&
          typeof permission.requestId === "string" &&
          Array.isArray(permission.options),
      );

      // The webview reload that dropped our session handle also dropped the
      // global event subscription. Re-install it so events from the live
      // session (incl. background task completions) are routed again.
      await this.ensureAgentEventSubscription();
      await refreshAgentOAuthRouting(liveInfo.id, conversationId);

      if (convo?.is_archived) {
        happyArchiveFence.archive(conversationId);
      }
      if (!happyArchiveFence.allows(conversationId, happyArchiveGeneration)) {
        await discardLateArchivedProviderSession(liveInfo.id, conversationId);
        return false;
      }

      // This id is alive again — clear any stale terminated marker so the global
      // subscriber does not drop its events.
      terminatedSessionIds.delete(conversationId);
      spawnContextMap.delete(conversationId);

      const hasRestoredMessages = restored.messages.length > 0;
      // The live session may be mid-turn at re-attach time (e.g. a reload while
      // the agent is answering). The runtime reports this as "prompting".
      const liveTurnInFlight = liveInfo.status === "prompting";
      const session: ActiveSession = {
        info: liveInfo,
        messages: restored.messages,
        plan: [],
        pendingToolCalls: new Map(),
        streamingContent: "",
        streamingThinking: "",
        pendingUserMessage: "",
        cwd: liveInfo.cwd,
        conversationId,
        agentSessionId: liveInfo.agentSessionId,
        // Re-attach performs NO provider replay (it never respawns the CLI), so
        // there are no replay events to suppress — only live ones. Setting
        // skipHistoryReplay here would make every live event handler early-return
        // and silently drop the entire in-flight turn (and its persistence).
        // Leave it unset so live chunks/tool calls render; restored history won't
        // duplicate because the live session only emits new forward events. #2674
        skipHistoryReplay: undefined,
        restoredMessageCount: hasRestoredMessages
          ? restored.messages.length
          : undefined,
        // A mid-turn re-attach has no record of when the turn began; seed the
        // elapsed-time clock now so the "Thinking…" indicator reflects reality.
        promptStartTime: liveTurnInFlight ? Date.now() : undefined,
        contextWindowSize: defaultContextWindowFor(
          agentType,
          runtimeModelId ?? undefined,
        ),
        currentModelId: runtimeModelId ?? undefined,
        currentModeId: runtimeModeId ?? undefined,
        title: convo?.title,
        pendingPrompts: [],
        role: "serving",
      };
      setState("sessions", conversationId, session);
      setState("activeSessionId", conversationId);

      if (rehydratedPendingPermissions.length > 0) {
        const seenRequestIds = new Set(
          state.pendingPermissions.map((permission) => permission.requestId),
        );
        const nextPendingPermissions = [...state.pendingPermissions];
        for (const permission of rehydratedPendingPermissions) {
          if (seenRequestIds.has(permission.requestId)) {
            continue;
          }
          seenRequestIds.add(permission.requestId);
          nextPendingPermissions.push(permission);
        }
        setState("pendingPermissions", nextPendingPermissions);
      }

      // Reflect an in-flight turn so the UI shows activity instead of looking
      // idle while the re-attached agent is actually working. Cleared on the
      // turn's promptComplete/cancel like any other turn. #2674
      if (liveTurnInFlight) {
        this.setTurnInFlight(conversationId, true);
      }

      // Drain events buffered by the global subscriber while no session record
      // existed for this id.
      const pendingEvents = pendingSessionEvents.get(conversationId);
      if (pendingEvents?.length) {
        for (const pendingEvent of pendingEvents) {
          this.handleSessionEvent(conversationId, pendingEvent);
        }
        pendingSessionEvents.delete(conversationId);
      }

      // The live session is already past initialization — unblock any sendPrompt
      // that awaits a readiness gate keyed on this id.
      const readyEntry = sessionReadyPromises.get(conversationId);
      if (readyEntry) {
        readyEntry.resolve();
        sessionReadyPromises.delete(conversationId);
      }

      console.info(
        "[AgentStore] Re-attached to live runtime session for conversation",
        conversationId,
        "status:",
        liveInfo.status,
      );
      return true;
    })();

    reattachingConversations.set(conversationId, attempt);
    try {
      return await attempt;
    } finally {
      if (reattachingConversations.get(conversationId) === attempt) {
        reattachingConversations.delete(conversationId);
      }
    }
  },

  /**
   * Resume a persisted agent conversation by loading its remote agent session.
   *
   * Provider sessions own transcript history; Seren only restores local
   * bootstrap snapshots for forks that have not materialized provider history yet.
   */
  async resumeAgentConversation(
    conversationId: string,
    cwd?: string,
  ): Promise<string | null> {
    if (happyArchiveFence.isArchived(conversationId)) {
      return null;
    }
    // If already running, just focus it. Use the conversationId-aware helper
    // — state.sessions is keyed by sessionId, and after a predictive-compaction
    // promotion the running session id no longer matches the conversation. #1682.
    const existing = this.getSessionForConversation(conversationId);
    if (existing) {
      setState("activeSessionId", existing.info.id);
      return conversationId;
    }

    // Prevent infinite spawn-crash-respawn cascades: if this conversation
    // has failed too many times in a short window, stop retrying.
    if (isSpawnCascading(conversationId)) {
      // A cascade ceiling means the agent cannot start after repeated attempts
      // — a real degradation worth a ticket, and there is no Error object or
      // central capture on this computed path.
      reportError(
        "agent.spawn_cascade",
        `[AgentStore] Spawn cascade detected — ${SPAWN_CASCADE_MAX_FAILURES} failures in ${SPAWN_CASCADE_WINDOW_MS / 1000}s. Stopping auto-resume.`,
      );
      setState(
        "error",
        "Agent failed to start after multiple attempts. Please try again or check Settings.",
      );
      setState("isLoading", false);
      return null;
    }

    setState("error", null);

    // The provider runtime outlives webview reloads/reconnects, so the backend
    // may still hold a LIVE session for this conversation — along with any
    // in-flight background subagents it spawned. Adopt it instead of tearing it
    // down; the pre-emptive terminate below would otherwise SIGKILL the whole
    // CLI process tree and silently lose that background work. #2669
    try {
      const reattached = await this.reattachLiveSession(conversationId);
      if (reattached) {
        clearSpawnFailures(conversationId);
        return conversationId;
      }
    } catch (err) {
      console.warn(
        "[AgentStore] re-attach failed; falling back to respawn:",
        err,
      );
    }
    if (happyArchiveFence.isArchived(conversationId)) {
      return null;
    }

    // Pre-emptively clean up any stale backend session with this conversation id.
    // If the frontend lost track of a session (e.g. after a crash or auth error),
    // the backend may still hold it, causing "Session already exists" on re-spawn.
    // Mark as terminated so late-arriving events from the old session are dropped.
    terminatedSessionIds.add(conversationId);
    await revokeCredentialLease(conversationId).catch((error) => {
      console.warn(
        "[AgentStore] Failed to revoke stale-session credential lease:",
        error,
      );
    });
    try {
      await providerService.terminateSession(conversationId);
    } catch {
      // Ignore — session likely doesn't exist in the backend
    }

    let convo: DbAgentConversation | null = null;
    try {
      convo = await getAgentConversation(conversationId);
    } catch (error) {
      console.error("Failed to read agent conversation:", error);
    }
    if (convo?.is_archived) {
      happyArchiveFence.archive(conversationId);
      return null;
    }
    if (!convo) {
      setState("error", "Agent conversation not found");
      return null;
    }
    privacyStore.hydrateConversationPrivilege(
      convo.id,
      convo.privileged,
      convo.counsel_direction,
    );
    const agentType: AgentType =
      convo.agent_type === "codex" ||
      convo.agent_type === "claude-code" ||
      convo.agent_type === "gemini" ||
      convo.agent_type === "grok" ||
      convo.agent_type === "claude-codex" ||
      convo.agent_type === "lmstudio"
        ? (convo.agent_type as AgentType)
        : state.selectedAgentType;
    const convoMetadata = parseAgentConversationMetadata(convo.agent_metadata);
    let pendingBootstrapPromptContext =
      convoMetadata.pendingBootstrapPromptContext;
    let restoredMessages = Array.isArray(convoMetadata.pendingBootstrapMessages)
      ? convoMetadata.pendingBootstrapMessages
      : [];

    // Metadata messages are only populated when bootstrapPromptContext is
    // truthy (see spawnSession line ~1322). For Codex and Gemini sessions
    // that never went through the Claude Code resume-fallback path, metadata
    // messages are always empty even though the messages WERE persisted to
    // SQLite via persistAgentMessage during the session. Fall back to the
    // SQLite store so users see their conversation history when reopening a
    // thread after a crash, kill, or compaction failure. Resolves #1533.
    if (restoredMessages.length === 0) {
      const persisted = await loadPersistedAgentHistory(conversationId);
      if (persisted.messages.length > 0) {
        restoredMessages = persisted.messages;
        if (!pendingBootstrapPromptContext && persisted.context) {
          pendingBootstrapPromptContext = persisted.context;
        }
      }
    }

    const remoteSessionId = convo.agent_session_id?.trim();
    if (!remoteSessionId) {
      console.warn(
        "[AgentStore] Conversation has no stored remote session id; creating a fresh session.",
        conversationId,
      );
      const convoCwd =
        convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
      const freshCwd = convoCwd || cwd;
      if (!freshCwd) {
        setState(
          "error",
          "Unable to determine project path for this conversation.",
        );
        return null;
      }
      const freshSessionId = await this.spawnSession(freshCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
        restoredMessages,
        bootstrapPromptContext: pendingBootstrapPromptContext,
        initialModelId: convo.agent_model_id ?? undefined,
        initialPermissionMode: convo.agent_permission_mode ?? undefined,
        paired: convoMetadata.pairedConfig,
      });
      if (freshSessionId) {
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return freshSessionId;
    }
    if (
      agentType === "claude-code" &&
      LEGACY_CLAUDE_LOCAL_SESSION_ID_RE.test(remoteSessionId)
    ) {
      setState(
        "error",
        "This conversation references a legacy local Claude id. Use Browse Claude Sessions and resume the real remote session.",
      );
      return null;
    }

    const convoCwd =
      convo.project_root?.trim() || convo.agent_cwd?.trim() || undefined;
    const resumeCwd = convoCwd || cwd;
    if (!resumeCwd) {
      setState(
        "error",
        "Unable to determine project path for this conversation.",
      );
      return null;
    }

    // Pre-flight: skip --resume entirely when Claude CLI's session JSONL is
    // missing. The CLI cleans up old session files, app reinstalls drop the
    // ~/.claude dir, and cross-machine sync doesn't carry CLI session files —
    // so a stored remoteSessionId can routinely point at nothing. Without this
    // check, the spawn fails with `code=1: No conversation found with session
    // ID: <id>` and surfaces a "Claude Code request failed" error event before
    // the resume-fallback path takes over (#1657). Best-effort: if the IPC
    // check itself fails, fall through to the existing spawn-and-recover path
    // so we never regress.
    let effectiveResumeId: string | undefined = remoteSessionId;
    if (agentType === "claude-code") {
      try {
        const exists = await claudeSessionExists(resumeCwd, remoteSessionId);
        if (!exists) {
          console.info(
            "[AgentStore] Claude session file missing for",
            remoteSessionId,
            "— skipping --resume, spawning fresh",
          );
          effectiveResumeId = undefined;
        }
      } catch (err) {
        console.warn(
          "[AgentStore] claudeSessionExists check failed; spawning with --resume:",
          err,
        );
      }
    }

    // Codex provider replay is authoritative. A partial local SQLite cache
    // would otherwise suppress replay and leave only the final output visible.
    const restoredMessagesForSpawn =
      agentType === "codex" && effectiveResumeId ? [] : restoredMessages;
    const bootstrapPromptContextForSpawn =
      agentType === "codex" && effectiveResumeId
        ? undefined
        : pendingBootstrapPromptContext;
    const sessionId = await this.spawnSession(resumeCwd, agentType, {
      localSessionId: conversationId,
      resumeAgentSessionId: effectiveResumeId,
      conversationTitle: convo.title,
      restoredMessages: restoredMessagesForSpawn,
      bootstrapPromptContext: bootstrapPromptContextForSpawn,
      initialModelId: convo.agent_model_id ?? undefined,
      initialPermissionMode: convo.agent_permission_mode ?? undefined,
      paired: convoMetadata.pairedConfig,
    });

    // Legacy Claude conversations can reference session IDs that no longer
    // exist on disk. In that case, fall back to a fresh session for the same
    // persisted conversation instead of failing hard. (#1656: previously this
    // path retried with the SAME bad resumeAgentSessionId before giving up,
    // producing a wasted 2nd `--resume` attempt + a duplicate "Claude Code
    // request failed" error event. Drop --resume immediately.)
    if (!sessionId && agentType === "claude-code") {
      console.warn(
        "[AgentStore] Claude resume failed, spawning fresh session for conversation",
        conversationId,
        state.error,
      );
      const persisted = await loadPersistedAgentHistory(conversationId);
      const fallbackSessionId = await this.spawnSession(resumeCwd, agentType, {
        localSessionId: conversationId,
        conversationTitle: convo.title,
        restoredMessages:
          persisted.messages.length > 0 ? persisted.messages : undefined,
        bootstrapPromptContext: persisted.context || undefined,
        initialModelId: convo.agent_model_id ?? undefined,
        initialPermissionMode: convo.agent_permission_mode ?? undefined,
      });

      if (fallbackSessionId) {
        // Clear error state and remove stale error messages left by the
        // failed first spawn. Without this, "Claude Code request failed"
        // banners persist even though the retry session is healthy.
        setState("error", null);
        setState("sessions", fallbackSessionId, "error", undefined);
        setState("sessions", fallbackSessionId, "messages", (msgs) =>
          msgs.filter((m) => m.type !== "error"),
        );
        clearSpawnFailures(conversationId);
        void this.refreshRecentAgentConversations(200).catch(() => {});
      } else {
        recordSpawnFailure(conversationId);
      }
      return fallbackSessionId;
    }

    if (sessionId) {
      // NOTE (#1663): pre-fix code called clearLegacyAgentTranscript here on
      // every successful resume without a bootstrap context. That deleted
      // every row in the messages table for this conversation_id, wiping
      // the persisted user/assistant history that loadPersistedAgentHistory
      // had just loaded. Removed: persistAgentMessage is the source of
      // truth for thread history; nothing in the resume path should clear it.
      clearSpawnFailures(conversationId);
      void this.refreshRecentAgentConversations(200).catch(() => {});
    } else {
      recordSpawnFailure(conversationId);
    }
    return sessionId;
  },
  /**
   * Resume a remote agent session from the provider's stored session list.
   *
   * If a local persisted conversation already exists for this remote session,
   * we resume that; otherwise we create a new local conversation and resume it.
   */
  async resumeRemoteSession(
    remoteSession: RemoteSessionInfo,
    cwd: string,
    agentType?: AgentType,
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const existing = state.recentAgentConversations.find(
      (c) =>
        c.agent_type === resolvedAgentType &&
        c.agent_session_id === remoteSession.sessionId,
    );
    if (existing && state.sessions[existing.id]) {
      setState("activeSessionId", existing.id);
      return existing.id;
    }

    const title =
      remoteSession.title?.trim() ||
      `${agentDisplayName(resolvedAgentType)} Session ${remoteSession.sessionId.slice(0, 8)}`;
    const sessionId = await this.spawnSession(cwd, resolvedAgentType, {
      localSessionId: existing?.id,
      resumeAgentSessionId: remoteSession.sessionId,
      conversationTitle: existing?.title?.trim() || title,
    });
    if (sessionId) {
      void this.refreshRecentAgentConversations(200).catch(() => {});
    }
    return sessionId;
  },

  /**
   * Build the per-prompt context array.
   *
   * The skills + publisher-instruction block is large and stable across
   * turns within a single live runtime session, so we send it only when
   * the signature changes. The caller is expected to call
   * `markPromptContextPrimed(sessionId, newSignature)` after a successful
   * sendPrompt so the next turn can short-circuit. When the signature is
   * unchanged from the last primed value, this returns only the explicit
   * per-turn `context` (file selections, transcript bootstrap, etc.).
   */
  async buildPromptContext(
    sessionId: string,
    context?: Array<Record<string, string>>,
    promptForBudget?: string,
  ): Promise<{
    merged: Array<Record<string, string>> | undefined;
    newSignature: string | null;
  }> {
    const session = state.sessions[sessionId];
    if (!session) {
      return {
        merged: context && context.length > 0 ? [...context] : undefined,
        newSignature: null,
      };
    }

    let skillsContent = "";
    try {
      skillsContent =
        (await skillsStore.getThreadSkillsContent(
          session.cwd,
          session.conversationId,
        )) ?? "";
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to load skills for agent prompt:",
        error,
      );
    }

    const currentSignature = `${PUBLISHER_LIVE_QUERY_INSTRUCTION}\n\n${skillsContent}`;
    const messageCount = session.messages.length;
    const messagesSincePrimed =
      messageCount - (session.primedAtMessageCount ?? 0);
    const expired = messagesSincePrimed > REPRIME_AFTER_MESSAGES;
    const alreadyPrimed =
      !expired && session.primedContextSignature === currentSignature;

    let mergedContext = context ? [...context] : [];

    if (session.bootstrapPromptContext) {
      mergedContext = [
        { type: "text", text: session.bootstrapPromptContext },
        ...mergedContext,
      ];
    }

    if (
      settingsStore.settings.memoryEnabled &&
      !privacyStore.isMemoryExcluded(session.conversationId) &&
      promptForBudget?.trim()
    ) {
      try {
        const recall = await recallMemoryContext(promptForBudget);
        if (recall) {
          mergedContext = [
            { type: "text", text: recall.prompt },
            ...mergedContext,
          ];
        }
      } catch (error) {
        console.warn("[AgentStore] Memory recall failed (non-fatal):", error);
      }
    }

    if (!alreadyPrimed) {
      let deliveredSkillsContent = skillsContent;
      if (skillsContent) {
        const maxSafeInputTokens = Math.max(
          0,
          Math.floor(
            session.contextWindowSize * PROMPT_PRIMING_CONTEXT_BUDGET_FRACTION,
          ) - PROMPT_PRIMING_RESERVED_OUTPUT_TOKENS,
        );
        const projectedFullPrimingTokens =
          estimatePromptContextTokens(promptForBudget, mergedContext) +
          estimateTokens(PUBLISHER_LIVE_QUERY_INSTRUCTION) +
          estimateTokens(skillsContent);

        if (projectedFullPrimingTokens > maxSafeInputTokens) {
          console.warn(
            `[AgentStore] Active skill primer exceeds safe input budget (${projectedFullPrimingTokens.toLocaleString()} > ${maxSafeInputTokens.toLocaleString()} tokens); using compact skill manifest (#1960)`,
          );
          try {
            deliveredSkillsContent =
              (await skillsStore.getThreadSkillsContent(
                session.cwd,
                session.conversationId,
                { mode: "compact" },
              )) || skillsContent;
          } catch (error) {
            console.warn(
              "[AgentStore] Failed to load compact skill manifest; using full skill content:",
              error,
            );
          }
        }

        mergedContext = [
          { type: "text", text: deliveredSkillsContent },
          ...mergedContext,
        ];
      }
      mergedContext = [
        { type: "text", text: PUBLISHER_LIVE_QUERY_INSTRUCTION },
        ...mergedContext,
      ];
    }

    return {
      merged: mergedContext.length > 0 ? mergedContext : undefined,
      newSignature: alreadyPrimed ? null : currentSignature,
    };
  },

  markPromptContextPrimed(sessionId: string, signature: string): void {
    const session = state.sessions[sessionId];
    if (!session) return;
    setState("sessions", sessionId, {
      primedContextSignature: signature,
      primedAtMessageCount: session.messages.length,
    });
  },

  setBootstrapPromptContext(
    sessionId: string,
    bootstrapPromptContext?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) {
      return;
    }

    setState(
      "sessions",
      sessionId,
      "bootstrapPromptContext",
      bootstrapPromptContext,
    );
    const conversationId = session.conversationId;
    if (conversationId) {
      void setAgentConversationMetadataDb(
        conversationId,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? session.messages
            : undefined,
          pairedConfig: providerService.pairedSpawnConfigFromStatus(
            session.paired,
          ),
        }),
      ).catch((error) => {
        console.warn("Failed to persist agent bootstrap context", error);
      });
    }
  },

  clearBootstrapPromptContext(sessionId: string) {
    // NOTE (#1663): pre-fix code also called clearLegacyAgentTranscript on
    // the conversationId here, which fired after every successful sendPrompt
    // and wiped the messages table for the conversation. The clear was a
    // vestige of the pre-#1562 storage model where the metadata-bootstrap
    // path was the primary persistence and per-message rows were "legacy."
    // After #1562 made persistAgentMessage primary, this clear became
    // actively destructive. We keep the bootstrap-context clear (the
    // session has consumed its seed); we do NOT touch user/assistant
    // history.
    this.setBootstrapPromptContext(sessionId, undefined);
  },

  async restoreSessionSettings(
    sourceSession: ActiveSession,
    targetSessionId: string,
  ) {
    if (sourceSession.currentModeId) {
      await this.setPermissionMode(
        sourceSession.currentModeId,
        targetSessionId,
      );
    }
    if (sourceSession.currentModelId) {
      await this.setModel(sourceSession.currentModelId, targetSessionId);
    }
    if (sourceSession.configOptions) {
      const restore: Record<string, string> = {};
      for (const opt of sourceSession.configOptions) {
        if (opt.type === "select" && opt.currentValue) {
          restore[opt.id] = opt.currentValue;
        }
      }
      if (Object.keys(restore).length > 0) {
        setState("sessions", targetSessionId, "pendingConfigRestore", restore);
      }
    }
  },

  /**
   * Terminate a session.
   *
   * `opts.nextActiveSessionId` — when supplied and the terminated session was
   * the active one, the supplied id replaces the default first-remaining-key
   * fallback. Pass an explicit value (or `null` for "no active session") from
   * call sites that know where the user should land next, e.g. standby
   * promotion. #1686.
   *
   * `opts.skipProviderKill` — when true, the synchronous state cleanup runs
   * but the provider-IPC `terminateSession` call (which sends SIGTERM to the
   * child) is the caller's responsibility. Used by `promoteStandbyAndDispatch`
   * to defer the kill until the new prompt has been dispatched, so the
   * SIGTERM cannot race the standby's first turn. #1686.
   */
  async terminateSession(
    sessionId: string,
    opts?: {
      nextActiveSessionId?: string | null;
      skipProviderKill?: boolean;
    },
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Mark as terminated BEFORE the async IPC call so the global event
    // subscriber immediately starts dropping late-arriving events.
    terminatedSessionIds.add(sessionId);

    // Mark this kill as self-inflicted BEFORE the IPC fires, so any
    // death-string `provider://error` event the runtime emits while
    // tearing down (rejected control requests, etc.) is silently
    // discarded by the error handler instead of surfacing as chat noise.
    // The flag is cleared at the end of this function. #1852.
    expectedTerminateSessionIds.add(sessionId);

    // Dismiss any pending ActionConfirmation dialogs whose owning session is
    // going away — the user must not approve a tool call against a dead
    // session. If the promoted/new session still wants the tool, it will
    // emit a fresh permissionRequest. #1631.
    const hasPermissions = state.pendingPermissions.some(
      (p) => p.sessionId === sessionId,
    );
    const hasDiffs = state.pendingDiffProposals.some(
      (p) => p.sessionId === sessionId,
    );
    if (hasPermissions) {
      setState(
        "pendingPermissions",
        state.pendingPermissions.filter((p) => p.sessionId !== sessionId),
      );
    }
    if (hasDiffs) {
      setState(
        "pendingDiffProposals",
        state.pendingDiffProposals.filter((p) => p.sessionId !== sessionId),
      );
    }

    // Drop the session's local credential authority before asking the provider
    // runtime to kill its child. Rust retains only a non-secret retry ledger
    // if the remote API key revocation cannot complete immediately. #3194.
    try {
      await revokeCredentialLease(sessionId);
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to revoke session credential lease:",
        error,
      );
    }

    if (!opts?.skipProviderKill) {
      try {
        await providerService.terminateSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found")) {
          console.info(
            "[AgentStore] terminateSession: backend session already gone:",
            sessionId,
          );
        } else {
          console.error("Failed to terminate session:", error);
        }
      }
    }

    // Clean up ready promise if still pending
    sessionReadyPromises.delete(sessionId);
    pendingSessionEvents.delete(sessionId);
    spawnContextMap.delete(sessionId);

    // Remove from state using produce to properly delete the key
    setState(
      produce((draft) => {
        delete draft.sessions[sessionId];
      }),
    );

    // Switch to another session if this was active. Callers that know which
    // session should become active (e.g. standby promotion) pass it via
    // opts.nextActiveSessionId; otherwise fall back to the first remaining
    // key, which preserves the historical behaviour for ad-hoc terminations.
    // #1686.
    if (state.activeSessionId === sessionId) {
      let next: string | null;
      if (opts && "nextActiveSessionId" in opts) {
        next = opts.nextActiveSessionId ?? null;
      } else {
        const remainingIds = Object.keys(state.sessions).filter(
          (id) => id !== sessionId,
        );
        next = remainingIds[0] ?? null;
      }
      setState("activeSessionId", next);
    }

    // Stop global event subscription when no sessions remain.
    if (Object.keys(state.sessions).length === 0 && globalUnsubscribe) {
      globalUnsubscribe();
      globalUnsubscribe = null;
      pendingSessionEvents.clear();
      terminatedSessionIds.clear();
      spawnContextMap.clear();
    }

    // Self-inflicted death window is over: any further death-string events
    // for this id are no longer ours to suppress. #1852.
    expectedTerminateSessionIds.delete(sessionId);
  },

  /**
   * Set the active session.
   */
  setActiveSession(sessionId: string | null) {
    verboseRuntimeConsole.debug(
      "[AgentRuntime] setActiveSession - old:",
      state.activeSessionId,
      "new:",
      sessionId,
    );
    setState("activeSessionId", sessionId);
  },

  /**
   * Clear all messages in a session and respawn the CLI process.
   * Clearing UI messages alone is not enough — Claude Code CLI maintains its
   * own internal context, so the old session remains full. We terminate the
   * CLI session and spawn a fresh one to actually free up context.
   */
  clearSessionMessages(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Clear UI messages and persisted history. The CLI session stays alive —
    // its internal context is independent of our message store. Killing and
    // respawning caused an infinite loop: the new session got a different ID,
    // selectThread couldn't find it, triggered resumeAgentConversation on the
    // old conversation, which replayed all old messages and re-triggered clear.
    setState("sessions", sessionId, "messages", []);
    clearConversationHistory(session.conversationId).catch((err) =>
      console.error("[AgentStore] Failed to clear persisted messages:", err),
    );
  },

  /**
   * Compact an agent conversation: generate a summary of older messages via
   * Gateway API, terminate the current agent session, and spawn a fresh one
   * seeded with the summary. The user stays in the same conversation.
   */
  async compactAgentConversation(
    sessionId: string,
    preserveCount: number,
    /**
     * Predictive mode spawns a warm standby (role="standby") WITHOUT
     * terminating the old serving session. The new session is visible to
     * events but invisible to the UI until `promoteStandbyAndDispatch`
     * promotes it on the next user submit. #1631.
     */
    opts?: { mode?: "reactive" | "predictive"; tailRatio?: number },
  ): Promise<CompactAgentResult> {
    const mode = opts?.mode ?? "reactive";
    const session = state.sessions[sessionId];
    if (!session || session.isCompacting) {
      return { outcome: "skipped_nothing_to_compact" };
    }

    // Paired Claude + Codex threads span two inner sessions; the standby
    // swap, fork, and restoreSessionSettings machinery here assumes one.
    // The planner's 1M window makes overflow rare — skip rather than risk
    // a half-restored pair (#2368).
    if (session.info.agentType === "claude-codex") {
      console.info(
        "[AgentStore] Compaction skipped for paired Claude + Codex thread",
      );
      return { outcome: "skipped_nothing_to_compact" };
    }

    const messages = session.messages;
    if (messages.length <= preserveCount) {
      console.info(
        "[AgentStore] Not enough messages to compact (message count below preserve threshold)",
      );
      return { outcome: "skipped_nothing_to_compact" };
    }

    // Token-budgeted boundary instead of a fixed preserve count: walk back from
    // the newest message by token cost so a single huge tool result or model
    // response can't survive into the post-compaction tail and overflow the
    // window again. Tool results are grouped into their user-led turn so a
    // result is never split from the turn that produced it, and the latest
    // user message is always anchored into the tail. #2104.
    const compactContextLimit =
      session.contextWindowSize > 0
        ? session.contextWindowSize
        : defaultContextWindowFor(
            session.info.agentType,
            session.currentModelId,
          );
    let compactTurn = 0;
    const windowItems: CompactionWindowItem[] = messages.map((m) => {
      if (m.type === "user") compactTurn++;
      const role =
        m.type === "user" || m.type === "assistant" || m.type === "tool"
          ? m.type
          : "other";
      // Request-aware token cost: content + tool-call arguments + tool result,
      // so the boundary is accurate in tool-heavy turns where the arguments and
      // output dominate, not just the message text. #2105.
      return {
        tokens: estimateAccountedMessageTokens({
          content: m.content,
          toolArgs: m.toolCall?.parameters,
          toolResult: m.toolCall?.result,
        }),
        role,
        groupId: `t${compactTurn}`,
      };
    });
    const tailWindow = selectCompactionWindow(windowItems, {
      contextLimit: compactContextLimit,
      minTailMessages: 2,
      targetTailRatio: opts?.tailRatio,
    });
    const toCompact = messages.slice(0, tailWindow.cutIndex);
    let toPreserve = messages.slice(tailWindow.cutIndex);
    if (toCompact.length === 0) {
      if (tailWindow.overBudget) {
        const relief = relieveOverBudgetTail(
          toPreserve.map(prunableAgentMessage),
          tailWindow.tailBudget,
        );
        toPreserve = applyPrunedAgentMessages(toPreserve, relief.messages);
        console.warn(
          `[AgentStore] over-budget tail with no compactable prefix pruned ${relief.tailTokensBefore}->${relief.tailTokensAfter} tokens`,
        );
        if (
          mode === "reactive" &&
          relief.tailTokensAfter < relief.tailTokensBefore
        ) {
          // The agent runtime owns its own transcript, so mutating Solid state is
          // not enough to relieve Codex/Claude context pressure. Respawn a clean
          // session and queue the pruned, bounded tail as the one-shot prepend;
          // compactAndRetry will resend the failed user prompt on that session.
          const fullTranscript = toPreserve;
          const cwd = session.cwd;
          const agentType = session.info.agentType;
          const conversationId = session.conversationId;
          const priorModelId = session.currentModelId;
          const queuedPrompts = session.pendingPrompts ?? [];
          const tailReliefSummary = relief.stillOverBudget
            ? "No older transcript prefix was available to summarize. Reducible tool payloads in the preserved tail were pruned, but the retained context may still be close to the model limit."
            : "No older transcript prefix was available to summarize. Reducible tool payloads in the preserved tail were pruned before retrying the failed request.";
          const prependText = buildAgentCompactionPrepend(
            `${tailReliefSummary}\n\nVERIFY-BEFORE-ACTING: Files, projects, and databases mentioned above may not exist on disk. Re-read the workspace, list .worktrees/, and resolve SerenDB projects/tables before acting on any claim.`,
            toPreserve,
          );

          try {
            setState("sessions", sessionId, "isCompacting", true);
            await this.terminateSession(sessionId);
            const reliefSessionId = await this.spawnSession(cwd, agentType, {
              localSessionId: conversationId,
              initialModelId: priorModelId,
            });
            if (!reliefSessionId) {
              throw new Error(
                "CompactionFailure: tail-relief respawn returned null",
              );
            }
            if (!state.sessions[reliefSessionId]) {
              throw new Error(
                "CompactionFailure: tail-relief respawn was removed before settings could be restored",
              );
            }
            setState("sessions", reliefSessionId, "messages", fullTranscript);
            setState(
              "sessions",
              reliefSessionId,
              "restoredMessageCount",
              fullTranscript.length,
            );
            if (queuedPrompts.length > 0) {
              setState(
                "sessions",
                reliefSessionId,
                "pendingPrompts",
                queuedPrompts,
              );
            }
            await waitForSessionReady(reliefSessionId);
            await this.restoreSessionSettings(session, reliefSessionId);
            setState(
              "sessions",
              reliefSessionId,
              "pendingCompactionPrepend",
              prependText,
            );
            console.info(
              `[AgentStore] over-budget tail relief respawned ${reliefSessionId} after pruning ${relief.tailTokensBefore}->${relief.tailTokensAfter} tokens`,
            );
            return { outcome: "succeeded", newSessionId: reliefSessionId };
          } catch (error) {
            console.error(
              "[AgentStore] Tail-relief respawn failed (catastrophic):",
              error,
            );
            if (state.sessions[sessionId]) {
              setState("sessions", sessionId, "isCompacting", false);
            } else if (fullTranscript.length > 0) {
              console.warn(
                `[AgentStore] Tail-relief recovery — restoring ${fullTranscript.length} pruned messages to a new session`,
              );
              try {
                const recoveryId = await this.spawnSession(cwd, agentType, {
                  localSessionId: conversationId,
                  initialModelId: priorModelId,
                });
                if (recoveryId) {
                  setState("sessions", recoveryId, "messages", fullTranscript);
                  setState(
                    "sessions",
                    recoveryId,
                    "restoredMessageCount",
                    fullTranscript.length,
                  );
                }
              } catch (recoveryErr) {
                console.error(
                  "[AgentStore] Tail-relief recovery spawn also failed:",
                  recoveryErr,
                );
              }
            }
            return { outcome: "failed_catastrophic" };
          }
        }
        if (relief.stillOverBudget) {
          console.warn(
            "[AgentStore] over-budget tail still exceeds budget after pruning (irreducible content)",
          );
        }
      } else {
        console.info(
          "[AgentStore] Token budget preserves the whole tail — nothing to compact",
        );
      }
      return { outcome: "skipped_nothing_to_compact" };
    }

    // isCompacting signals "this serving session is being torn down and
    // re-spawned" — it gates `sendPrompt` and the promptComplete drain so
    // a queued prompt is not dispatched onto a dying session. Predictive
    // mode warms a standby alongside a still-running serving session
    // (#1631); flipping isCompacting on the serving session there makes
    // the drain block at the bottom of promptComplete skip indefinitely
    // and queued prompts get stuck (#1673). Predictive mode has its own
    // gates (`predictiveCompactInFlight` per-session, owner-aware global mutex
    // module-level) — only the reactive branch should set isCompacting.
    if (mode === "reactive") {
      setState("sessions", sessionId, "isCompacting", true);
    }

    // Hoisted for catch-handler access — the reactive path terminates the
    // old session, so recovery needs these if anything downstream throws. #1639.
    const fullTranscript = [...session.messages];
    const cwd = session.cwd;
    const agentType = session.info.agentType;
    const conversationId = session.conversationId;

    try {
      // toCompact / toPreserve were selected by token budget above (#2104).

      // Generate a structured summary via Gateway API (not via the agent —
      // its context is what's overloaded). Uses a hard-capped schema to keep
      // the summary under ~200 tokens, down from ~700 with freeform "500 words".
      // This reduces prompt tokens on every subsequent call by ~70%.
      //
      // #2103 — carry the prior compacted summary forward so a second (or
      // later) compaction iteratively updates it instead of rebuilding from
      // only the newest window; otherwise context summarized by an earlier
      // compaction silently disappears. The shared builder keeps the #1800
      // anti-fabrication language (explicit 'none', evidence-bucketed fields)
      // and the #1733 agent-action continuation framing, and it no longer
      // asks the model to predict the next user ask.
      const previousSummary = session.compactedSummary?.content ?? null;

      // Pre-prune the compacted history before summarization: dedupe repeated
      // tool output to back-references, summarize stale large results, and
      // bound oversized tool-call arguments. This both shrinks the summarizer
      // input and lets the summary capture tool outcomes (previously dropped,
      // since only message content was fed in). #2105.
      const prunable: PrunableMessage[] = toCompact.map(prunableAgentMessage);
      const pruned = pruneCompactedHistory(prunable, {
        protectedFromIndex: prunable.length,
      });
      console.info(
        `[compact.prune] ${pruned.stats.duplicateToolResults} dup, ${pruned.stats.summarizedToolResults} summarized, ${pruned.stats.truncatedToolArgs} args trimmed, tokens ${pruned.stats.tokensBefore}->${pruned.stats.tokensAfter}`,
      );
      const newTurns = pruned.messages
        .map((m) => {
          if (m.role === "tool" && m.toolResult) {
            return `TOOL(${m.toolName ?? "tool"}): ${m.toolResult}`;
          }
          return `${m.role.toUpperCase()}: ${m.content}`;
        })
        .join("\n\n");
      const summaryPrompt = buildIterativeCompactionPrompt({
        previousSummary,
        newTurns,
        mode: "agent",
        maxTokens: 200,
      });

      // Always route the summary through the public Seren provider.
      // sendMessage() uses providerStore.activeProvider which may be
      // stale from a previous chat thread (e.g. seren-private). The
      // compaction summary is an internal operation — it must not
      // depend on UI provider state.
      //
      // Resilient policy (#2106): primary model, auth-refresh retry, fallback
      // model, then a deterministic local summary. Only aborts (no-drop) when
      // none of those can produce a summary — the serving session is left
      // intact and a cooldown backs auto-compact off the failing summarizer.
      const summaryOutcome = await runSummarizerWithPolicy({
        primaryModel: SUMMARY_PRIMARY_MODEL,
        fallbackModels: SUMMARY_FALLBACK_MODELS,
        attempt: (model) =>
          sendProviderMessage("seren", buildChatRequest(summaryPrompt, model)),
        isAuthError: (e) => {
          const m = e instanceof Error ? e.message : String(e);
          return m.includes("Not authenticated") || m.includes("401");
        },
        refreshAuth: refreshAccessToken,
        deterministicFallback: () =>
          buildDeterministicFallbackSummary(prunable),
      });

      if (summaryOutcome.status === "aborted") {
        // No-drop abort: do NOT terminate or replace the serving session.
        // Cool down so auto-compact stops hammering the failing summarizer.
        compactionCooldown.enter(conversationId, Date.now());
        if (mode === "reactive") {
          setState("sessions", sessionId, "isCompacting", false);
          setState(
            "sessions",
            sessionId,
            "error",
            "Compaction paused — the summarizer is unavailable. Your conversation is intact.",
          );
        }
        console.warn(
          `[compact.abort] summarizer unavailable, history kept intact: ${summaryOutcome.reason}`,
        );
        return { outcome: "failed_catastrophic" };
      }
      if (summaryOutcome.status === "fallback") {
        // Deterministic local summary used — cool down and warn, but proceed
        // so compaction still relieves the context pressure.
        compactionCooldown.enter(conversationId, Date.now());
        console.warn(
          `[compact.fallback] using deterministic local summary: ${summaryOutcome.reason}`,
        );
      } else if (summaryOutcome.usedFallbackModel) {
        console.info(
          `[compact.fallback_model] summary produced by fallback model ${summaryOutcome.model}`,
        );
      }
      let summary = summaryOutcome.summary;

      // Post-generation verify-before-acting banner. Travels with `summary`
      // itself so BOTH downstream consumers carry it: the passive-prepend
      // path AND the synthetic-transcript JSONL path that
      // `buildSyntheticTranscript()` writes to disk. A banner placed only
      // on one consumer would miss the other. #1800.
      summary = `${summary.trim()}\n\nVERIFY-BEFORE-ACTING: Files, projects, and databases mentioned above may not exist on disk. Re-read the workspace, list .worktrees/, and resolve SerenDB projects/tables before acting on any claim.`;

      // Track summary lineage so repeated compactions are observably
      // iterative. The carried-forward `previousSummary` is normalized inside
      // buildSummaryLineage, so the VERIFY-BEFORE-ACTING banner does not
      // pollute the prior-hash or inflate the next prompt. #2103.
      const lineage = buildSummaryLineage({
        previousLineage: session.compactedSummary?.lineage ?? null,
        previousSummary,
        compactedMessageCount: toCompact.length,
        now: Date.now(),
      });

      const compactedSummary: AgentCompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: lineage.compactedAt,
        lineage,
      };

      const queuedPrompts = session.pendingPrompts ?? [];

      // Build the structured prepend up-front. This is what the next user
      // submit on the new session will receive in front of their actual
      // prompt — the post-compaction context-restore mechanism. No seed
      // turn is sent to the model; the prepend is consumed exactly once on
      // the first dispatch via `consumeCompactionPrepend`. #1829.
      //
      // Tool messages must ride along: MCP tool results carry the resource
      // handles the conversation is actually manipulating (Google Sheets
      // spreadsheet IDs, SerenDB project handles, R2 keys, ...). The
      // structured summary template has no slot for opaque identifiers and
      // caps each field at 1-2 sentences, so handles got summarized away
      // and the user had to re-supply them. Tighter cap on tool results
      // because they can be huge file contents / JSON dumps; user and
      // assistant text gets the original 2000-char ceiling. #1858.
      //
      // Items are wrapped in XML-style tags rather than `USER: ` /
      // `TOOL_RESULT (…): ` prefixes. Raw transcript prefixes match Claude
      // Code's own stream-json output verbatim — Opus 4.7 then continues
      // the transcript inside its assistant content instead of treating
      // the block as quoted context, bleeding the prepend into the chat
      // and starving the Thinking budget. #1941.
      const prependText = buildAgentCompactionPrepend(summary, toPreserve);

      // The synthetic-transcript builder interprets this as a count of REAL
      // user turns to keep from the parent JSONL (findCutIndex in
      // synthetic-transcript.mjs). Now that the tail is token-budgeted (#2104),
      // toPreserve has a variable mix of user/assistant/tool messages, so
      // `length / 2` no longer tracks its user-turn span — overcounting in a
      // tool-heavy tail would preserve older turns the summary already covers,
      // duplicating context and risking re-overflow. Count the real user turns
      // actually in the token-selected tail. #2111.
      const userTurnCount = Math.max(
        1,
        toPreserve.filter((m) => m.type === "user").length,
      );
      const syntheticEnabled =
        settingsStore.settings.compactSyntheticTranscript &&
        agentType === "claude-code";

      if (mode === "predictive") {
        // Predictive path: spawn a STANDBY session alongside the live one.
        // No teardown, no UI side-effects — the next user submit promotes it.
        // isCompacting is intentionally NOT set on the serving session here
        // (#1673); concurrency is gated by `predictiveCompactInFlight` and
        // the module-level predictive-compaction mutex.

        // #1713 / #1829: synthetic-transcript pre-warm. When enabled, build
        // a synthetic JSONL on disk that splices the structured summary in
        // front of the parent's preserved tail and resume the standby
        // against THAT — the standby's prior assistant turn is the real
        // prior assistant turn, no model-visible acknowledgement round-trip.
        if (syntheticEnabled) {
          try {
            const syntheticAgentSessionId =
              await providerService.buildSyntheticTranscript(
                sessionId,
                summary,
                userTurnCount,
              );
            const syntheticStandbyId = await this.spawnSession(cwd, agentType, {
              role: "standby",
              archiveOwnerConversationId: conversationId,
              resumeAgentSessionId: syntheticAgentSessionId,
              initialModelId: session.currentModelId,
            });
            if (syntheticStandbyId == null) {
              throw new Error("synthetic standby spawn returned null");
            }
            setState(
              "sessions",
              syntheticStandbyId,
              "compactedSummary",
              compactedSummary,
            );
            setState(
              "sessions",
              sessionId,
              "standbySessionId",
              syntheticStandbyId,
            );
            await waitForSessionReady(syntheticStandbyId);
            await this.restoreSessionSettings(session, syntheticStandbyId);
            // The synthetic JSONL already contains the real prior turn pair.
            // Mark seed-complete immediately so promotion does not stall.
            setState("sessions", syntheticStandbyId, "seedCompleted", true);
            // No promptComplete event fires for this standby (no seed turn),
            // so the drain that previously lived in the promptComplete
            // handler must be triggered explicitly. #1749 / #1829.
            drainStandbyQueueIfPending(
              syntheticStandbyId,
              this.sendPrompt.bind(this),
            );
            console.info(
              `[compact.synthetic.success] standby ${syntheticStandbyId} resumed synthetic transcript ${syntheticAgentSessionId} for serving ${sessionId}`,
            );
            return { outcome: "succeeded", newSessionId: syntheticStandbyId };
          } catch (err) {
            // Defensive fallback: any failure (CLI rejects file, parent
            // JSONL unreadable, write fails, schema drift) drops through to
            // the passive-prepend path below. Serving session is untouched.
            console.warn(
              `[compact.synthetic.fallback.predictive] ${err instanceof Error ? err.message : String(err)} — falling back to passive prepend`,
            );
          }
        }

        // Predictive non-synthetic path (passive prepend). Spawn a standby,
        // queue the structured summary as `pendingCompactionPrepend`, mark
        // seed-complete immediately. No seed turn is sent to the CLI — the
        // standby's JSONL is empty until promotion, when sendPrompt's
        // `consumeCompactionPrepend` injects the summary in front of the
        // user's actual prompt. #1829.
        const standbyId = await this.spawnSession(cwd, agentType, {
          role: "standby",
          archiveOwnerConversationId: conversationId,
          initialModelId: session.currentModelId,
        });
        if (!standbyId) {
          // Predictive warm-up is best-effort — the serving session is still
          // alive and the user can keep working. Throwing here would route
          // through the catastrophic catch and surface as a captured support
          // report; downgrade to a warn so the support pipeline ignores it
          // and let kickPredictiveCompact's normal flag-reset path run. #152.
          console.warn(
            "[AgentStore] Predictive standby spawn returned null — keeping serving session, will retry next turn",
          );
          return { outcome: "failed_catastrophic" };
        }
        setState("sessions", standbyId, "compactedSummary", compactedSummary);
        setState("sessions", sessionId, "standbySessionId", standbyId);
        await waitForSessionReady(standbyId);
        await this.restoreSessionSettings(session, standbyId);
        setState(
          "sessions",
          standbyId,
          "pendingCompactionPrepend",
          prependText,
        );
        // No seed turn — mark seed-complete directly so promotion's gate
        // (waitForStandbySeed) clears immediately on the next user submit.
        setState("sessions", standbyId, "seedCompleted", true);
        // Drain the #1749 race-guard queue explicitly — no promptComplete
        // fires for this standby because we never sent a seed turn. #1829.
        drainStandbyQueueIfPending(standbyId, this.sendPrompt.bind(this));
        console.info(
          `[AgentStore] Predictive compaction: standby ${standbyId} ready with passive prepend for serving ${sessionId}`,
        );
        return { outcome: "succeeded", newSessionId: standbyId };
      }

      // Reactive path. Two branches: synthetic-transcript (claude-code +
      // setting on) and passive prepend (everything else / synthetic
      // failure). Synthetic MUST run BEFORE terminate because
      // `buildSyntheticTranscript` reads the live session's agentSessionId
      // from the runtime's `sessions` map. After terminate the lookup
      // throws "Session not found". #1829.
      const priorModelId = session.currentModelId;

      if (syntheticEnabled) {
        try {
          const syntheticAgentSessionId =
            await providerService.buildSyntheticTranscript(
              sessionId,
              summary,
              userTurnCount,
            );
          // JSONL is now on disk; safe to terminate the old child.
          await this.terminateSession(sessionId);
          const syntheticSessionId = await this.spawnSession(cwd, agentType, {
            localSessionId: conversationId,
            initialModelId: priorModelId,
            resumeAgentSessionId: syntheticAgentSessionId,
          });
          if (!syntheticSessionId) {
            throw new Error(
              "CompactionFailure: synthetic respawn returned null",
            );
          }
          if (!state.sessions[syntheticSessionId]) {
            throw new Error(
              "CompactionFailure: synthetic respawn was removed before settings could be restored",
            );
          }
          setState(
            "sessions",
            syntheticSessionId,
            "compactedSummary",
            compactedSummary,
          );
          setState("sessions", syntheticSessionId, "messages", fullTranscript);
          setState(
            "sessions",
            syntheticSessionId,
            "restoredMessageCount",
            fullTranscript.length,
          );
          if (queuedPrompts.length > 0) {
            setState(
              "sessions",
              syntheticSessionId,
              "pendingPrompts",
              queuedPrompts,
            );
          }
          await waitForSessionReady(syntheticSessionId);
          await this.restoreSessionSettings(session, syntheticSessionId);
          console.info(
            `[compact.synthetic.success.reactive] session ${syntheticSessionId} resumed synthetic transcript ${syntheticAgentSessionId}`,
          );
          return { outcome: "succeeded", newSessionId: syntheticSessionId };
        } catch (err) {
          // Synthetic failed. If the failure happened BEFORE terminate, the
          // old session is still alive and we proceed with the passive-
          // prepend path's normal terminate-then-spawn. If it happened AFTER
          // terminate, the catch block at the end of the function runs the
          // recovery spawn (preserves the user's transcript). The boundary
          // is the `await this.terminateSession(sessionId)` above — anything
          // after that throwing routes to the outer catch. The branch below
          // covers the pre-terminate-failure case explicitly: we still need
          // to terminate before spawning a clean replacement.
          console.warn(
            `[compact.synthetic.fallback.reactive] ${err instanceof Error ? err.message : String(err)} — falling back to passive prepend`,
          );
          if (state.sessions[sessionId]) {
            // Pre-terminate failure path. Terminate now, then fall through
            // to the passive-prepend block below.
            await this.terminateSession(sessionId);
          }
        }
      } else {
        // Non-synthetic reactive: terminate before spawning the replacement
        // (synthetic-enabled callers already terminated above on success or
        // in the fallback branch).
        await this.terminateSession(sessionId);
      }

      // Reactive passive-prepend path. No role-standby gymnastics — there
      // is no seed-ack to suppress because no seed turn is sent. The user's
      // retry (`compactAndRetry`) consumes the prepend and dispatches their
      // failed prompt with the structured summary in front. #1829.
      const newSessionId = await this.spawnSession(cwd, agentType, {
        localSessionId: conversationId,
        initialModelId: priorModelId,
      });

      if (!newSessionId) {
        // Local diagnostic; the throw below is the reportable signal caught by
        // the compaction recovery path.
        console.warn(
          "[AgentStore] Failed to spawn new session after compaction — catastrophic",
        );
        throw new Error(
          "CompactionFailure: new session spawn returned null after compaction",
        );
      }

      // The new session entry can disappear between spawn return and the
      // first setState if `provider-runtime://restarted` fires (which drops
      // every session) or another path calls terminateSession on the same
      // id. Without this guard the next setState traverses
      // `state.sessions[newSessionId].compactedSummary` and throws an
      // unhelpful TypeError "undefined is not an object (evaluating 'e[r]')"
      // from inside the SolidJS store reconciler — captured as a public
      // support report. Throw a clean error so the catch block runs the
      // recovery path with a meaningful message. #150.
      if (!state.sessions[newSessionId]) {
        throw new Error(
          "CompactionFailure: new session was removed before settings could be restored",
        );
      }

      setState("sessions", newSessionId, "compactedSummary", compactedSummary);
      setState("sessions", newSessionId, "messages", fullTranscript);
      setState(
        "sessions",
        newSessionId,
        "restoredMessageCount",
        fullTranscript.length,
      );
      if (queuedPrompts.length > 0) {
        setState("sessions", newSessionId, "pendingPrompts", queuedPrompts);
      }

      console.info(
        `[AgentStore] Compacted ${toCompact.length} messages, preserved ${toPreserve.length}. Queueing passive prepend on new session.`,
      );

      await waitForSessionReady(newSessionId);
      await this.restoreSessionSettings(session, newSessionId);
      // Queue the structured summary for the next dispatch on this session.
      // compactAndRetry consumes it via consumeCompactionPrepend before its
      // direct providerService.sendPrompt call. #1829.
      setState(
        "sessions",
        newSessionId,
        "pendingCompactionPrepend",
        prependText,
      );

      return { outcome: "succeeded", newSessionId };
    } catch (error) {
      // Predictive warm-up failures are not catastrophic — the serving
      // session is still alive and the user can keep working. Downgrade the
      // log so the support pipeline doesn't capture every standby-spawn race
      // as a public bug report. The reactive path stays catastrophic. #152.
      if (mode === "predictive") {
        const errMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(
          "[AgentStore] Predictive standby compaction failed (non-fatal):",
          errMessage,
        );
        // Triage by error signature (#1741). The original blanket downgrade
        // (#152) silenced every standby-spawn race so the support pipeline
        // didn't get spammed by transient noise. But the same path also
        // swallowed STRUCTURAL CLI rejections that are 100% repro on the
        // affected user (e.g. #1739's `<synthetic>` model poison producing
        // "issue with the selected model"). Only the structural class
        // escalates to captureSupportError; transient races stay quiet.
        if (PREDICTIVE_STRUCTURAL_FAILURE_RE.test(errMessage)) {
          void captureSupportError({
            kind: "agent.predictive_compact_failed",
            message: errMessage,
            stack: error instanceof Error && error.stack ? [error.stack] : [],
            agentContext: {
              model: session.currentModelId,
              provider: session.info.agentType,
              tool_calls: [],
            },
          });
        }
        // Clear standbySessionId pointer if it was wired up before the throw
        // so the next sendPrompt doesn't try to promote a dead standby. The
        // serving session itself is untouched (isCompacting was never set in
        // predictive mode, #1673).
        if (state.sessions[sessionId]?.standbySessionId) {
          setState("sessions", sessionId, "standbySessionId", null);
        }
        return { outcome: "failed_catastrophic" };
      }
      console.error(
        "[AgentStore] Failed to compact agent conversation (catastrophic):",
        error,
      );
      if (state.sessions[sessionId]) {
        setState("sessions", sessionId, "isCompacting", false);
      } else if (fullTranscript && fullTranscript.length > 0) {
        // The old session was terminated but the new one failed. Respawn a
        // recovery session with the saved transcript so the user doesn't
        // lose their conversation. #1639.
        console.warn(
          `[AgentStore] Attempting recovery — restoring ${fullTranscript.length} messages to new session`,
        );
        try {
          const recoveryId = await this.spawnSession(cwd, agentType, {
            localSessionId: conversationId,
            initialModelId: session.currentModelId,
          });
          if (recoveryId) {
            setState("sessions", recoveryId, "messages", fullTranscript);
            setState(
              "sessions",
              recoveryId,
              "restoredMessageCount",
              fullTranscript.length,
            );
          }
        } catch (recoveryErr) {
          console.error(
            "[AgentStore] Recovery spawn also failed:",
            recoveryErr,
          );
        }
      }
      return { outcome: "failed_catastrophic" };
    }
  },

  /**
   * Compact the conversation and retry the last user prompt.
   * Returns true if compaction + retry succeeded, false if we should fall back.
   */
  async compactAndRetry(sessionId: string): Promise<CompactionOutcome> {
    const session = state.sessions[sessionId];
    if (!session || session.compactRetryAttempted || session.isCompacting) {
      return "skipped_nothing_to_compact";
    }

    setState("sessions", sessionId, "compactRetryAttempted", true);

    const lastPrompt = session.lastUserPrompt;
    console.info(
      `[AgentStore] Prompt too long — attempting compaction${lastPrompt ? " + retry" : " (no prompt to retry)"}`,
    );

    try {
      // compactAgentConversation returns the id of the fresh, seeded, idle
      // session. We trust that id and do the retry locally — splitting
      // dispatch across both functions, or re-deriving the id via a state
      // lookup, regressed for #1757.
      let result = await this.compactAgentConversation(
        sessionId,
        settingsStore.settings.autoCompactPreserveMessages,
      );

      // Reactive compaction must recover from short-but-token-heavy sessions
      // — a handful of tool turns can carry 200K+ tokens. When the configured
      // count guard leaves nothing to summarize, retry with a lower guard AND
      // a tighter tail budget so the token window shrinks the session below the
      // model window. Only give up when even that has nothing to act on. #2031/#2104.
      if (result.outcome === "skipped_nothing_to_compact") {
        const remaining = state.sessions[sessionId]?.messages.length ?? 0;
        if (remaining > AGGRESSIVE_RETRY_PRESERVE_COUNT) {
          console.info(
            `[AgentStore] compactAndRetry: configured count left nothing to compact (${remaining} messages); retrying with a tighter tail budget (ratio=${AGGRESSIVE_RETRY_TAIL_RATIO})`,
          );
          result = await this.compactAgentConversation(
            sessionId,
            AGGRESSIVE_RETRY_PRESERVE_COUNT,
            { tailRatio: AGGRESSIVE_RETRY_TAIL_RATIO },
          );
        }
      }

      // Propagate non-success outcomes directly. "skipped" after the
      // aggressive retry means the session is too small to compact at all
      // (one or two messages) — Chat would fail identically, so caller
      // surfaces an honest error. "failed_catastrophic" still routes to
      // the Chat fallback.
      if (result.outcome !== "succeeded") {
        return result.outcome;
      }

      const newSessionId = result.newSessionId;
      if (!newSessionId) {
        // Defensive: the type contract guarantees newSessionId on
        // "succeeded", but if it ever drifts we treat the absence as
        // catastrophic so the caller can fall back to Chat.
        console.warn(
          "[AgentStore] compactAndRetry: succeeded outcome without newSessionId — treating as catastrophic",
        );
        return "failed_catastrophic";
      }

      // Retry the original prompt if available; otherwise leave the
      // compacted session ready for the user's next input.
      if (lastPrompt) {
        console.info(
          `[AgentStore] Compaction complete, retrying prompt on session ${newSessionId}`,
        );
        setState("sessions", newSessionId, "lastUserPrompt", lastPrompt);
        // compactAndRetry bypasses store.sendPrompt (the user's UI message
        // is already on screen from the first failed attempt). Apply the
        // post-compaction prepend ourselves so the model receives the
        // structured summary banner in front of the retry. #1829.
        const retryPrompt = consumeCompactionPrepend(newSessionId, lastPrompt);
        await providerService.sendPrompt(newSessionId, retryPrompt);
        return "retried";
      }
      console.info(
        `[AgentStore] Compaction complete on session ${newSessionId} — no prompt to retry, session ready`,
      );
      return "succeeded";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Task cancelled")) {
        console.info(
          "[AgentStore] compactAndRetry cancelled — Stop / teardown propagated 'Task cancelled' through the retry; not a fallback condition",
        );
        return "cancelled";
      }
      console.error(
        "[AgentStore] compactAndRetry threw — treating as catastrophic:",
        error,
      );
      return "failed_catastrophic";
    }
  },

  /**
   * Warm a standby session in the background. Serving session keeps running;
   * the standby is seeded with the compaction summary so the next submit can
   * swap invisibly. Idempotent per-session and globally bounded via
   * owner-aware global mutex. #1631.
   */
  async kickPredictiveCompact(sessionId: string): Promise<void> {
    const session = state.sessions[sessionId];
    if (!session || session.predictiveCompactInFlight) return;

    // Back off after a recent summarizer failure so auto-compact (both the
    // 70% predictive and the 85% reactive-auto triggers route here) does not
    // hammer a failing summarizer every promptComplete tick. #2106.
    if (compactionCooldown.isCoolingDown(session.conversationId, Date.now())) {
      console.info(
        "[AgentStore] kickPredictiveCompact: in summarizer cooldown — skipping",
      );
      return;
    }

    const predictiveCompactLease = predictiveCompactMutex.tryAcquire(sessionId);
    if (!predictiveCompactLease) return;
    setState("sessions", sessionId, "predictiveCompactInFlight", true);
    let shouldDrainAfterAbort = false;
    try {
      const result = await this.compactAgentConversation(
        sessionId,
        settingsStore.settings.autoCompactPreserveMessages,
        { mode: "predictive" },
      );
      if (result.outcome !== "succeeded") {
        // Silent abort — serving session is still healthy.
        console.warn(
          "[AgentStore] kickPredictiveCompact: non-success outcome",
          result.outcome,
        );
        shouldDrainAfterAbort = true;
      }
    } catch (err) {
      console.warn(
        "[AgentStore] kickPredictiveCompact failed (non-fatal):",
        err,
      );
      shouldDrainAfterAbort = true;
    } finally {
      // Only the current generation may clear the per-session flag or drain
      // its queue. An archived generation may finish after the same serving
      // id has already acquired a newer lease.
      if (predictiveCompactMutex.release(predictiveCompactLease)) {
        if (state.sessions[sessionId]) {
          setState("sessions", sessionId, "predictiveCompactInFlight", false);
        }
        if (shouldDrainAfterAbort) this.drainAfterPredictiveAbort(sessionId);
      }
    }
  },

  /**
   * Drain the head of `pendingPrompts` after a predictive compaction aborts.
   * Prompts land in the queue via the #1749 race guard in `sendPrompt` while
   * a standby is being warmed; the standby-success drain at the bottom of
   * `promptComplete` only fires when the seed completes. When the seed fails
   * (e.g. Gateway 504), the queue is otherwise stranded forever. Mirror the
   * standard drain shape: dispatch the head, let its promptComplete drain
   * the next entry. #1769.
   */
  drainAfterPredictiveAbort(sessionId: string): void {
    const queue = state.sessions[sessionId]?.pendingPrompts ?? [];
    if (queue.length === 0) return;
    const [nextPrompt, ...remaining] = queue;
    if (nextPrompt == null) return;
    setState("sessions", sessionId, "pendingPrompts", remaining);
    console.info(
      `[AgentStore] Predictive compact aborted — draining queued prompt on ${sessionId} (#1769)`,
    );
    setTimeout(() => {
      void this.sendPrompt(nextPrompt, undefined, undefined, sessionId);
    }, 0);
  },

  /**
   * Promote the warm standby to serving and dispatch the user's new prompt
   * on it. Called from the send path at turn boundary. Old serving session
   * is terminated; UI transcript is transferred atomically to the promoted
   * session so the user sees no discontinuity. #1631.
   */
  async promoteStandbyAndDispatch(
    servingSessionId: string,
    prompt: string,
    context?: Array<Record<string, string>>,
    options?: { displayContent?: string; docNames?: string[] },
  ): Promise<boolean> {
    const serving = state.sessions[servingSessionId];
    const standbyId = serving?.standbySessionId;
    if (!serving || !standbyId) {
      // Fall through — caller will dispatch to serving.
      return false;
    }
    const standby = state.sessions[standbyId];
    if (!standby) {
      return false;
    }
    const conversationId = serving.conversationId;

    // Make the provider-to-conversation ownership durable before exposing the
    // standby as serving. If mobile archive won the race, Rust atomically
    // archives the conversation and reports that result instead of allowing a
    // promoted provider to resurrect it on the next refresh.
    try {
      const claim = await claimHappyProviderSessionOwner(
        conversationId,
        standbyId,
        standby.agentSessionId,
      );
      if (claim.archived) {
        happyProviderArchiveTombstones.add(standbyId);
        happyArchiveFence.archive(conversationId);
        return false;
      }
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to persist standby ownership; keeping the serving session:",
        error,
      );
      await this.terminateSession(standbyId).catch(() => {});
      if (state.sessions[servingSessionId]) {
        setState("sessions", servingSessionId, "standbySessionId", null);
        setState(
          "sessions",
          servingSessionId,
          "predictiveCompactInFlight",
          false,
        );
      }
      return false;
    }
    if (
      happyProviderArchiveTombstones.has(standbyId) ||
      happyArchiveFence.isArchived(conversationId) ||
      !state.sessions[standbyId] ||
      state.sessions[servingSessionId]?.standbySessionId !== standbyId
    ) {
      return false;
    }

    // Transfer the UI transcript to the promoted session so scroll-up is
    // preserved across the swap. The standby session was invisible until now.
    const fullTranscript = [...serving.messages];
    setState("sessions", standbyId, "messages", fullTranscript);
    setState(
      "sessions",
      standbyId,
      "restoredMessageCount",
      fullTranscript.length,
    );
    // Inherit persisted conversationId so SQLite keeps a single thread.
    setState("sessions", standbyId, "conversationId", conversationId);
    setState("sessions", standbyId, "archiveOwnerConversationId", undefined);
    setState("sessions", standbyId, "role", "serving");
    setState("sessions", standbyId, "seedCompleted", undefined);
    // Transfer queued prompts. The #1749 enqueue-during-spawn-race guard in
    // sendPrompt parks user prompts on the serving session while
    // predictiveCompactInFlight=true; without this transfer those prompts
    // would be lost when terminateSession deletes the serving session below.
    const carriedQueue = serving.pendingPrompts ?? [];
    if (carriedQueue.length > 0) {
      setState("sessions", standbyId, "pendingPrompts", [...carriedQueue]);
    }

    // Make the promoted standby the active session BEFORE the old serving
    // session is torn down. Without this, terminateSession's auto-pickup
    // branch lands on the first remaining key (an unrelated session) and the
    // UI's view of activeSessionId no longer matches the session actually
    // serving the user's prompt. #1686.
    setState("activeSessionId", standbyId);

    // Two-phase teardown of the old serving session. Phase 1 (synchronous
    // state cleanup) drops late events from the old child immediately, so
    // dispatch on the standby is unaffected. Phase 2 (the provider-IPC kill
    // that sends SIGTERM) is deferred to after sendPrompt resolves so the
    // SIGTERM cannot race the standby's first turn. #1686.
    await this.terminateSession(servingSessionId, {
      nextActiveSessionId: standbyId,
      skipProviderKill: true,
    });

    try {
      // Dispatch on the promoted session.
      await this.sendPrompt(prompt, context, options, standbyId);
    } finally {
      // Phase 2: now that dispatch has settled, reap the old child.
      try {
        await providerService.terminateSession(servingSessionId);
      } catch (error) {
        console.warn("[AgentStore] Deferred provider terminate failed:", error);
      }
    }
    return true;
  },

  /**
   * User-initiated cancel of the current turn across any restart-dependent
   * path. Cancels any warming standby, clears the prompt queue, drops the
   * in-flight turn, and leaves the composer enabled. Does NOT set turnError
   * — a user cancel is not a failure. #1631.
   */
  async abortTurn(threadId: string): Promise<void> {
    const session = Object.values(state.sessions).find(
      (s) => s.conversationId === threadId && s.role === "serving",
    );
    if (session?.standbySessionId) {
      await this.terminateSession(session.standbySessionId).catch(() => {});
      setState("sessions", session.info.id, "standbySessionId", null);
    }
    if (session) {
      setState("sessions", session.info.id, "pendingPrompts", []);
      try {
        await providerService.cancelPrompt(session.info.id);
      } catch (err) {
        // Cooperative cancel did not reach/stop the agent. Escalate to a hard
        // terminate: provider_terminate unconditionally kills the child process
        // tree, so the user's Stop actually stops the agent instead of leaving
        // it running behind an idle-looking UI. #2301.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          "[AgentStore] abortTurn cancelPrompt failed; escalating to terminate:",
          err,
        );
        // Only drop the socket when the failure looks like an unresponsive
        // runtime (RPC timeout / dead socket) — a stale socket must be
        // replaced before the terminate can land. For a logical error (e.g.
        // "Session not found") the socket is healthy, so dropping it would
        // needlessly reject other sessions' in-flight RPCs. #2306
        let forceKilled = false;
        if (/timed out|not connected|disconnected/i.test(message)) {
          disconnectLocalProviderRuntime();
          // The runtime WS is unreachable, so the terminate RPC below cannot
          // land either. Force-kill the agent's process directly via Rust —
          // the only escalation that works when the runtime can't process
          // RPCs. The Rust descendant-of-runtime guard keeps this safe even if
          // the PID is stale, and only the targeted session dies. #2313
          const pid = session.info.pid;
          if (pid != null) {
            forceKilled = await providerService
              .forceKillSession(pid)
              .catch((killErr) => {
                console.error(
                  "[AgentStore] abortTurn force-kill failed:",
                  killErr,
                );
                return false;
              });
            if (forceKilled) {
              console.warn(
                `[AgentStore] abortTurn force-killed agent pid=${pid}`,
              );
            }
          } else {
            // Runtime is unreachable AND we have no PID to fall back on, so the
            // agent cannot be force-killed. Surface it so the rare
            // unstoppable-agent case is diagnosable rather than silent. #2316
            console.warn(
              "[AgentStore] abortTurn: runtime unreachable and no agent PID available; cannot force-kill this session",
            );
          }
        }
        // If we force-killed the agent, the provider_terminate RPC would only
        // time out against the wedged runtime — skip it and clean up local
        // state only. Otherwise attempt the normal cooperative terminate. #2313
        await this.terminateSession(session.info.id, {
          skipProviderKill: forceKilled,
        }).catch((termErr) => {
          console.error(
            "[AgentStore] abortTurn terminate escalation failed:",
            termErr,
          );
        });
      }
    }
    this.setTurnInFlight(threadId, false);
    this.clearTurnError(threadId);
  },

  /**
   * Focus an already-running session that belongs to the given project cwd.
   * Returns true when a matching session is found.
   */
  focusProjectSession(cwd: string): boolean {
    const match = Object.entries(state.sessions).find(
      ([, session]) => session.cwd === cwd,
    );
    if (!match) return false;
    const [sessionId] = match;
    if (state.activeSessionId !== sessionId) {
      setState("activeSessionId", sessionId);
    }
    return true;
  },

  // ============================================================================
  // Messaging
  // ============================================================================

  /**
   * Send a prompt to the active session.
   * Auto-recovers from dead sessions by restarting and retrying.
   */
  async sendPrompt(
    prompt: string,
    context?: Array<Record<string, string>>,
    options?: { displayContent?: string; docNames?: string[] },
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    verboseRuntimeConsole.debug("[AgentStore] sendPrompt called:", {
      sessionId,
      prompt: prompt.slice(0, 50),
    });

    const session = sessionId ? state.sessions[sessionId] : undefined;

    // Derive the thread id early so turnInFlight / turnError operate on the
    // right key across cold-start, promotion, and crash-recovery paths. #1631.
    const threadId = session?.conversationId;

    if (threadId && session) {
      try {
        providerService.assertPrivilegedConversationProvider(
          threadId,
          privacyStore.isPrivileged(threadId),
          session.info.agentType,
          { lmStudioBaseUrl: settingsStore.get("lmStudioBaseUrl") },
        );
      } catch (error) {
        this.setTurnError(
          threadId,
          "privileged_provider_blocked",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }

    if (threadId) {
      this.setTurnInFlight(threadId, true);
      this.setLastPrompt(
        threadId,
        prompt,
        context,
        options?.displayContent,
        options?.docNames,
      );
      this.clearTurnError(threadId);
    }

    // Predictive-compact race guard (#1749): auto-compact kicks
    // `kickPredictiveCompact` which sets `predictiveCompactInFlight=true`
    // synchronously, but the standby session is only spawned ~10s later
    // (line ~3029). If the user submits during that window, the existing
    // standbySessionId block below is a no-op and the prompt would dispatch
    // on the overloaded serving session, growing context further (e.g. 127% →
    // 183%). Enqueue instead — the standby's promptComplete handler kicks a
    // drain once seedCompleted=true, which re-enters sendPrompt with the
    // standby ready and promotes-and-dispatches normally.
    if (
      sessionId &&
      session &&
      session.role === "serving" &&
      session.predictiveCompactInFlight &&
      !session.standbySessionId &&
      session.lastInputTokens != null &&
      session.contextWindowSize > 0 &&
      session.lastInputTokens / session.contextWindowSize >=
        settingsStore.settings.autoCompactThreshold / 100
    ) {
      console.info(
        `[AgentStore] sendPrompt: predictive compact in-flight at ${Math.round(
          (session.lastInputTokens / session.contextWindowSize) * 100,
        )}% — enqueuing prompt until standby is seeded (#1749)`,
      );
      // Keep turnInFlight=true (matching the #1623 isCompacting branch
      // below) so the UI keeps showing "sending..." until the dispatched
      // prompt actually completes on the promoted standby. The standby's
      // seed-complete handler kicks the drain that dispatches this prompt.
      this.enqueuePrompt(sessionId, prompt);
      return;
    }

    // Predictive swap: if a warm standby is ready, promote it at this turn
    // boundary before dispatching. The old serving session is terminated
    // inside promoteStandbyAndDispatch; transcript + conversationId transfer
    // so the user sees no break. #1631.
    if (
      sessionId &&
      session &&
      session.role === "serving" &&
      session.standbySessionId
    ) {
      const standby = state.sessions[session.standbySessionId];
      if (standby && standby.seedCompleted === true) {
        console.info(
          `[AgentStore] Promoting standby ${session.standbySessionId} for serving ${sessionId}`,
        );
        const promoted = await this.promoteStandbyAndDispatch(
          sessionId,
          prompt,
          context,
          options,
        );
        if (
          promoted ||
          happyProviderArchiveTombstones.has(standby.info.id) ||
          happyArchiveFence.isArchived(session.conversationId)
        ) {
          return;
        }
      }
      if (standby) {
        // Standby not ready yet. When the serving session is at or above the
        // auto-compact threshold (#1675), the next prompt is likely to overflow
        // the model context — falling through to dispatch on the overloaded
        // serving session would trigger compactAndRetry → reactive teardown →
        // chatbox flash. Wait briefly for the seed to complete instead, then
        // promote-and-dispatch on the standby. Below the threshold, retain the
        // original "cancel and dispatch on serving" behaviour so a fast user
        // is not held up unnecessarily.
        const usagePct =
          session.lastInputTokens && session.contextWindowSize
            ? session.lastInputTokens / session.contextWindowSize
            : 0;
        const criticalThreshold =
          settingsStore.settings.autoCompactThreshold / 100;
        if (usagePct >= criticalThreshold) {
          console.info(
            `[AgentStore] Standby not ready at submit but context critical (${Math.round(
              usagePct * 100,
            )}%) — awaiting seed`,
          );
          const seeded = await waitForStandbySeed(
            session.standbySessionId,
            STANDBY_SEED_WAIT_MS,
          );
          if (seeded) {
            console.info(
              `[AgentStore] Promoting just-seeded standby ${session.standbySessionId}`,
            );
            const promoted = await this.promoteStandbyAndDispatch(
              sessionId,
              prompt,
              context,
              options,
            );
            if (
              promoted ||
              happyProviderArchiveTombstones.has(standby.info.id) ||
              happyArchiveFence.isArchived(session.conversationId)
            ) {
              return;
            }
          }
          console.info(
            `[AgentStore] Standby did not seed within ${STANDBY_SEED_WAIT_MS}ms — falling through to serving`,
          );
        }
        console.info(
          "[AgentStore] Standby not ready at submit; cancelling warm-up",
        );
        const cancelledStandbyId = session.standbySessionId;
        // Relinquish this predictive generation before the termination await.
        // Releasing by session id afterward could clear a newer generation if
        // archive/restart work reacquired the mutex while termination waited.
        setState("sessions", sessionId, "standbySessionId", null);
        predictiveCompactMutex.releaseCurrentForAny([sessionId]);
        setState("sessions", sessionId, "predictiveCompactInFlight", false);
        await this.terminateSession(cancelledStandbyId).catch(() => {});
      }
    }

    // Defensive: if a caller races compaction (e.g. a stray setTimeout the
    // drain block scheduled before the auto-compact block set isCompacting),
    // re-enqueue rather than send. The session is about to be terminated
    // and re-spawned; compaction will transfer the queue to the new session
    // and its first promptComplete will drain it (#1623).
    if (session?.isCompacting) {
      console.info(
        "[AgentStore] sendPrompt: session is compacting, re-enqueuing",
        { sessionId: sessionId ?? "?", prompt: prompt.slice(0, 50) },
      );
      if (sessionId) this.enqueuePrompt(sessionId, prompt);
      return;
    }

    if (!sessionId || !session) {
      console.warn(
        "[AgentStore] sendPrompt: no session — caller must spawn first",
      );
      if (threadId) this.setTurnInFlight(threadId, false);
      return;
    }

    if (!session || session.info.status === "error") {
      // Set session-specific error if session exists
      if (session) {
        setState(
          "sessions",
          sessionId,
          "error",
          "Session has ended. Please start a new session.",
        );
      } else {
        setState("error", "Session has ended. Please start a new session.");
      }
      return;
    }

    if (
      session.conversationId &&
      !(await awaitAgentOAuthRoutingForPrompt(
        session.info.id,
        session.conversationId,
      ))
    ) {
      setState(
        "sessions",
        sessionId,
        "error",
        "Connected account routing is temporarily unavailable. Retry after your accounts finish loading.",
      );
      if (threadId) this.setTurnInFlight(threadId, false);
      return;
    }

    // If auto-recovery is in-flight for THIS session (triggered by another
    // sendPrompt call), wait for it. Recovery already retries the original
    // prompt, so proceeding would race and cause "Another prompt is already
    // active". Recovery on OTHER sessions must NOT block this one.
    const thisRecovery = recoveryInFlightMap.get(sessionId);
    if (thisRecovery) {
      console.info(
        `[AgentStore] sendPrompt: recovery in-flight for ${sessionId}, waiting before proceeding...`,
      );
      await thisRecovery;
      const refreshed = state.sessions[sessionId];
      if (!refreshed) {
        console.info(
          "[AgentStore] sendPrompt: session gone after recovery, aborting",
        );
        return;
      }
      if (refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session already prompting after recovery, aborting duplicate",
        );
        return;
      }
    }

    // Wait for session to be ready before sending prompt
    if (
      sessionReadyPromises.has(sessionId) &&
      state.sessions[sessionId]?.info.status !== "ready"
    ) {
      console.info(
        `[AgentStore] sendPrompt: waiting for session ${sessionId} to be ready...`,
      );
      await waitForSessionReady(sessionId);
      console.info("[AgentStore] sendPrompt: session is now ready");
    }

    // Re-check after async waits — recovery may have started while we waited.
    const thisRecoveryAfterWait = recoveryInFlightMap.get(sessionId);
    if (thisRecoveryAfterWait) {
      console.info(
        `[AgentStore] sendPrompt: recovery started during ready-wait for ${sessionId}, deferring...`,
      );
      await thisRecoveryAfterWait;
      const refreshed = state.sessions[sessionId];
      if (!refreshed || refreshed.info.status === "prompting") {
        console.info(
          "[AgentStore] sendPrompt: session busy after recovery, aborting duplicate",
        );
        return;
      }
    }

    // Optimistically mark as prompting so the UI can show a loading state
    // immediately, even before backend events arrive.
    setState(
      "sessions",
      sessionId,
      "info",
      "status",
      "prompting" as SessionStatus,
    );

    // Track when the prompt started for duration calculation
    setState("sessions", sessionId, "promptStartTime", Date.now());
    setState("sessions", sessionId, "claudeMemoryWriteEvidence", []);
    // Clear any prior cancel flag — user is submitting a new prompt.
    setState("sessions", sessionId, "cancelRequested", undefined);
    // Store the prompt so we can retry after compaction if needed
    setState("sessions", sessionId, "lastUserPrompt", prompt);
    setState("sessions", sessionId, "compactRetryAttempted", false);

    // Add user message — display only user's typed text, not extracted doc content
    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: options?.displayContent ?? prompt,
      timestamp: Date.now(),
      ...(options?.docNames?.length ? { docNames: options.docNames } : {}),
    };

    verboseRuntimeConsole.debug(
      "[AgentRuntime] Adding user message to session:",
      sessionId,
      "conversationId:",
      state.sessions[sessionId]?.conversationId,
      "content:",
      prompt.slice(0, 50),
    );
    setState("sessions", sessionId, "messages", (msgs) => [
      ...msgs,
      userMessage,
    ]);
    const convoId = state.sessions[sessionId]?.conversationId;
    const userAgentType = state.sessions[sessionId]?.info.agentType ?? null;
    if (convoId) persistAgentMessage(convoId, userMessage, userAgentType);
    // Discard any buffered chunks from the previous response
    clearChunkBuf(sessionId);
    setState("sessions", sessionId, "streamingContent", "");
    setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    setState("sessions", sessionId, "streamingContentReplay", undefined);
    setState("sessions", sessionId, "streamingContentMessageId", undefined);
    setState("sessions", sessionId, "assistantDraftMessageId", undefined);
    setState("sessions", sessionId, "streamingThinking", "");
    setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessageOrigin", undefined);

    // Derive tab title from the first user prompt
    if (!state.sessions[sessionId]?.title) {
      const maxLen = 30;
      const trimmed = prompt.trim().replace(/\s+/g, " ");
      const title =
        trimmed.length <= maxLen
          ? trimmed
          : (() => {
              const t = trimmed.slice(0, maxLen);
              const sp = t.lastIndexOf(" ");
              return `${sp > 10 ? t.slice(0, sp) : t}\u2026`;
            })();
      setState("sessions", sessionId, "title", title);

      // Persist derived title to DB so it survives app restarts
      const convoId = state.sessions[sessionId]?.conversationId;
      if (convoId) {
        setAgentConversationTitleDb(convoId, title).catch((err) => {
          console.warn("[AgentStore] Failed to persist title:", err);
        });
      }
    }

    verboseRuntimeConsole.debug(
      "[AgentStore] Calling providerService.sendPrompt...",
    );
    try {
      const { merged, newSignature } = await this.buildPromptContext(
        sessionId,
        context,
        prompt,
      );
      // Apply the post-compaction prepend (one-shot) AFTER the user message
      // is rendered in the UI but BEFORE the IPC dispatch — the user's chat
      // bubble shows their actual text; the model receives the structured
      // summary banner in front of it. #1829.
      const dispatchedPrompt = consumeCompactionPrepend(sessionId, prompt);
      await providerService.sendPrompt(sessionId, dispatchedPrompt, merged);
      this.clearBootstrapPromptContext(sessionId);
      if (newSignature !== null) {
        this.markPromptContextPrimed(sessionId, newSignature);
      }
      verboseRuntimeConsole.debug(
        "[AgentStore] sendPrompt completed successfully",
      );
    } catch (error) {
      const agentLabel = agentDisplayName(
        state.sessions[sessionId]?.info.agentType,
      );
      const message = error instanceof Error ? error.message : String(error);

      // Auto-recover from dead/zombie sessions.
      // "unresponsive" = agent force-stopped after timeout (prompt or cancel deadline).
      // Other patterns = session died unexpectedly.
      // NOTE: "Task cancelled" (graceful cancel) is excluded — not a dead session.
      if (isRecoverableDeadSessionSendFailure(message)) {
        console.info(
          `[AgentStore] sendPrompt recoverable ${agentLabel} failure:`,
          message,
        );
        await this.recoverDroppedPrompt(sessionId, message, {
          prompt,
          context,
          displayContent: options?.displayContent,
          docNames: options?.docNames,
          currentUserMessageId: userMessage.id,
          retry: session.cancelRequested !== true,
        });
        return;
      }

      console.error(`[AgentStore] sendPrompt error (${agentLabel}):`, error);

      // For prompt-too-long errors, wait for the in-flight compactAndRetry
      // to finish before giving up. Without this, sendPrompt rejects while
      // compaction is still running, and the compaction result is lost.
      if (isPromptTooLongError(message)) {
        const compactPromise = state.sessions[sessionId]?.compactRetryPromise;
        if (compactPromise) {
          console.info(
            "[AgentStore] sendPrompt: waiting for in-flight compaction to complete",
          );
          await compactPromise;
        } else {
          this.addErrorMessage(sessionId, message);
          this.failTurnForSession(sessionId, message);
        }
        // If compactAndRetry is active it owns the terminal fallback. Without
        // that promise this catch path is the only terminal failure signal.
      } else if (!message.includes("Task cancelled")) {
        this.addErrorMessage(sessionId, message);
        this.failTurnForSession(sessionId, message);
      }

      // Ensure the session is not stuck in "prompting" after any error —
      // UNLESS it's a transient reconnection attempt where the agent will
      // resume on its own. Setting "ready" during reconnection triggers
      // premature queue drain, injecting pending messages mid-reconnect.
      const isReconnecting = /^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(message);
      if (
        !isReconnecting &&
        state.sessions[sessionId]?.info.status === "prompting"
      ) {
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );
      }
    }
  },

  /**
   * Cancel the current prompt in the active session.
   */
  async cancelPrompt(forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) {
      console.warn("[AgentStore] cancelPrompt: no active session");
      return;
    }

    const session = state.sessions[sessionId];
    console.info(
      `[AgentStore] cancelPrompt: session=${sessionId}, status=${session?.info.status}`,
    );

    setState("sessions", sessionId, "cancelRequested", true);
    // Drop any already-buffered tool events — no point flushing them
    // when the user has requested cancel. #1531.
    clearToolEventBuf(sessionId);

    try {
      await providerService.cancelPrompt(sessionId);
      console.info("[AgentStore] cancelPrompt: backend acknowledged cancel");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("not found")) {
        console.warn(
          "[AgentStore] cancelPrompt: stale session, resetting status",
        );
        setState("sessions", sessionId, "info", "status", "ready");
      } else {
        console.error("[AgentStore] cancelPrompt failed:", error);
      }
    }
  },

  /**
   * Set permission mode for the active session.
   */
  async setPermissionMode(modeId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setPermissionMode(sessionId, modeId);
      // Optimistic update — the authoritative update arrives via
      // CurrentModeUpdate notification handled in handleStatusChange.
      setState("sessions", sessionId, "currentModeId", modeId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationPermissionModeDb(
          session.conversationId,
          modeId,
        ).catch((error) => {
          console.warn(
            "Failed to persist agent permission-mode selection",
            error,
          );
        });
      }
    } catch (error) {
      console.error(
        `[AgentStore] Failed to set permission mode to "${modeId}":`,
        error,
      );
    }
  },

  /**
   * Set the AI model for the active session.
   */
  async setModel(modelId: string, forSessionId?: string) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;
    const session = state.sessions[sessionId];
    if (!session) return;

    setState("sessions", sessionId, "pendingModelId", modelId);
    setState("sessions", sessionId, "userSelectedModelId", modelId);
    setState("sessions", sessionId, "currentModelId", modelId);
    // The auto-compact denominator must follow the picker. Prior fixes
    // (#1700, #1733, #1761, #1769, #1798) hardened the CLI-report path
    // into contextWindowSize. The picker-driven mid-session swap path
    // was never wired: switching `claude-opus-4-7` -> `claude-opus-4-7[1m]`
    // left the spawn-time 200K denominator in place, so compaction fired
    // at ~88% of 200K instead of waiting for ~88% of 1M — exactly 5x too
    // early on every 1M-tier upgrade. Recompute against the new tier here;
    // the next promptComplete's #1798 isOneMTierMismatch guard refines
    // the value if the runtime emits something different. Reset the
    // once-per-session alarm so the gate re-arms cleanly for the new
    // tier. #1858.
    setState(
      "sessions",
      sessionId,
      "contextWindowSize",
      defaultContextWindowFor(session.info.agentType, modelId),
    );
    setState("sessions", sessionId, "contextWindowMismatchReported", false);
    try {
      await providerService.setModel(sessionId, modelId);
      void setAgentConversationModelIdDb(session.conversationId, modelId).catch(
        (error) => {
          console.warn("Failed to persist agent model selection", error);
        },
      );
    } catch (error) {
      console.error("[AgentStore] Failed to set model:", error);
    }
  },

  /**
   * Set a session configuration option (e.g., reasoning effort).
   */
  async setConfigOption(
    configId: string,
    valueId: string,
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId) return;

    try {
      await providerService.setConfigOption(sessionId, configId, valueId);
      // Optimistically update local config option state (if present).
      setState("sessions", sessionId, "configOptions", (opts) => {
        if (!opts) return opts;
        return opts.map((o) => {
          if (o.id === configId && o.type === "select") {
            return { ...o, currentValue: valueId };
          }
          return o;
        });
      });
      // Persist Claude Code reasoning effort so the next spawn uses the new
      // value. Claude Code's --effort flag is spawn-time; mid-session changes
      // don't affect the running CLI, only the next session that starts.
      const agentType = state.sessions[sessionId]?.info.agentType;
      if (agentType === "claude-code" && configId === "reasoning_effort") {
        settingsStore.set("claudeReasoningEffort", valueId);
      }
    } catch (error) {
      console.error("[AgentStore] Failed to set config option:", error);
    }
  },

  /**
   * Role-scoped model selection for paired Claude + Codex threads (#2368).
   * The runtime applies the change to that role's inner session only and
   * echoes a refreshed paired status, which updates the selectors and
   * persists the pin via persistPairedConfig.
   */
  async setPairedModel(
    role: PairedRole,
    modelId: string,
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId || !state.sessions[sessionId]) return;
    try {
      await providerService.setModel(sessionId, modelId, role);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[AgentStore] Failed to set paired model:", error);
      setState("sessions", sessionId, "error", message);
    }
  },

  /** Role-scoped config (reasoning effort) for paired threads (#2368). */
  async setPairedConfigOption(
    role: PairedRole,
    configId: string,
    valueId: string,
    forSessionId?: string,
  ) {
    const sessionId = forSessionId ?? state.activeSessionId;
    if (!sessionId || !state.sessions[sessionId]) return;
    try {
      await providerService.setConfigOption(sessionId, configId, valueId, role);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[AgentStore] Failed to set paired config option:", error);
      setState("sessions", sessionId, "error", message);
    }
  },

  /**
   * Persist pinned paired model/effort choices into the conversation row's
   * agent_metadata so they restore when the thread reopens. Merge-writes so
   * pending-bootstrap metadata is preserved; skips no-op writes.
   */
  persistPairedConfig(sessionId: string, paired: PairedStatus) {
    const session = state.sessions[sessionId];
    const conversationId = session?.conversationId;
    if (!conversationId) return;

    const pairedConfig = providerService.pairedSpawnConfigFromStatus(paired);

    const serialized = JSON.stringify(pairedConfig ?? null);
    if (pairedConfigPersisted.get(conversationId) === serialized) return;
    pairedConfigPersisted.set(conversationId, serialized);

    void (async () => {
      const convo = await getAgentConversation(conversationId);
      const metadata = parseAgentConversationMetadata(
        convo?.agent_metadata ?? null,
      );
      metadata.pairedConfig = pairedConfig;
      await setAgentConversationMetadataDb(
        conversationId,
        serializeAgentConversationMetadata(metadata),
      );
    })().catch((error) => {
      pairedConfigPersisted.delete(conversationId);
      console.warn("[AgentStore] Failed to persist paired config:", error);
    });
  },

  async respondToPermission(requestId: string, optionId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (!permission) {
      console.warn(
        `[AgentStore] respondToPermission: request ${requestId} not found in pending list`,
      );
      return;
    }

    console.info(
      `[AgentStore] Responding to permission ${requestId}: session=${permission.sessionId}, option=${optionId}`,
    );

    try {
      await providerService.respondToPermission(
        permission.sessionId,
        requestId,
        optionId,
      );
      console.info(
        `[AgentStore] Permission ${requestId} response delivered to backend`,
      );
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes("not found") || errorMsg.includes("timed out")) {
        // Permission already timed out or was cleaned up on backend
        console.warn(
          `[AgentStore] Permission ${requestId} no longer valid (likely timed out)`,
        );
        // User was already notified by the timeout error handler above
      } else {
        console.error(
          `[AgentStore] Failed to respond to permission ${requestId}:`,
          error,
        );
      }
    }

    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async dismissPermission(requestId: string) {
    const permission = state.pendingPermissions.find(
      (p) => p.requestId === requestId,
    );
    if (permission) {
      console.info(
        `[AgentStore] Dismissing permission ${requestId}: session=${permission.sessionId}`,
      );
      try {
        await providerService.respondToPermission(
          permission.sessionId,
          requestId,
          "deny",
        );
      } catch (error) {
        console.error(
          `[AgentStore] Failed to send deny for permission ${requestId}:`,
          error,
        );
      }
    } else {
      console.warn(
        `[AgentStore] dismissPermission: request ${requestId} not found in pending list`,
      );
    }
    setState(
      "pendingPermissions",
      state.pendingPermissions.filter((p) => p.requestId !== requestId),
    );
  },

  async respondToDiffProposal(proposalId: string, accepted: boolean) {
    const proposal = state.pendingDiffProposals.find(
      (p) => p.proposalId === proposalId,
    );
    if (!proposal) return;

    try {
      await providerService.respondToDiffProposal(
        proposal.sessionId,
        proposalId,
        accepted,
      );
    } catch (error) {
      console.error("Failed to respond to diff proposal:", error);
    }

    setState(
      "pendingDiffProposals",
      state.pendingDiffProposals.filter((p) => p.proposalId !== proposalId),
    );
  },

  // ============================================================================
  // UI State
  // ============================================================================

  /**
   * Set the selected agent type for new sessions.
   */
  setAgentModeEnabled(enabled: boolean) {
    setState("agentModeEnabled", runtimeHasCapability("agents") && enabled);
  },

  setSelectedAgentType(agentType: AgentType) {
    setState("selectedAgentType", agentType);
    // Reset remote session listing when switching agents to avoid mixed results.
    setState("remoteSessions", []);
    setState("remoteSessionsNextCursor", null);
    setState("remoteSessionsError", null);
  },

  /**
   * Update the agent's working directory by sending a cd command.
   * Called when the user opens a different folder while a session is active.
   */
  async updateCwd(newCwd: string) {
    const sessionId = state.activeSessionId;
    if (!sessionId) return;

    const session = state.sessions[sessionId];
    if (!session || session.cwd === newCwd) return;

    // Update stored cwd
    setState("sessions", sessionId, "cwd", newCwd);

    // Send cd instruction to the agent if session is ready
    if (session.info.status === "ready") {
      await this.sendPrompt(
        `Please change your working directory to: ${newCwd}`,
      );
    }
  },

  /**
   * Whether the active session hit a rate limit (triggers chat fallback prompt).
   */
  get rateLimitHit(): boolean {
    const session = this.activeSession;
    return session?.rateLimitHit === true;
  },

  /**
   * Whether the active session's context window is full (triggers chat fallback prompt).
   */
  get promptTooLong(): boolean {
    const session = this.activeSession;
    return session?.promptTooLong === true;
  },

  /**
   * Whether any agent-level fallback banner should be shown (rate limit OR context full).
   */
  get agentFallbackNeeded(): boolean {
    return this.rateLimitHit || this.promptTooLong;
  },

  /**
   * The reason for the current fallback prompt, if any.
   */
  get agentFallbackReason(): "rate_limit" | "prompt_too_long" | null {
    if (this.promptTooLong) return "prompt_too_long";
    if (this.rateLimitHit) return "rate_limit";
    return null;
  },

  /**
   * Dismiss the fallback prompt without switching to Chat.
   */
  dismissRateLimitPrompt() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }
  },

  /**
   * Accept the fallback prompt: switch agent history to a Chat conversation.
   */
  async acceptRateLimitFallback(): Promise<string | null> {
    const session = this.activeSession;
    if (!session) return null;

    const agentType = session.info.agentType;
    const messages = [...session.messages];
    const agentModelId = session.currentModelId;
    const title = session.title;
    const reason = this.agentFallbackReason ?? "rate_limit";

    // Clear the flags first so the banner disappears immediately
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "rateLimitHit", false);
      setState("sessions", sessionId, "promptTooLong", false);
    }

    return performAgentFallback(
      agentType,
      messages,
      agentModelId,
      title,
      reason,
    );
  },

  /**
   * Clear error state for the active session.
   */
  clearError() {
    const sessionId = state.activeSessionId;
    if (sessionId) {
      setState("sessions", sessionId, "error", null);
    }
    // Also clear global error for backwards compatibility
    setState("error", null);
  },

  async retryCliUpdate() {
    const action = state.cliUpdateActionRequired;
    if (!action || action.retrying) return;
    setState("cliUpdateActionRequired", "retrying", true);
    try {
      const result = await providerService.retryCliUpdate(action.bareCommand);
      if (
        result.outcome === "success" ||
        result.outcome === "skipped:up_to_date"
      ) {
        setState("cliUpdateActionRequired", null);
        return;
      }
      setState("cliUpdateActionRequired", (current) =>
        current
          ? {
              ...current,
              reason: result.outcome.replace(/^skipped:/, ""),
              from: result.from ?? current.from,
              to: result.to ?? current.to,
              retrying: false,
            }
          : null,
      );
    } catch (error) {
      setState("cliUpdateActionRequired", "retrying", false);
      setState(
        "error",
        error instanceof Error ? error.message : "CLI update retry failed.",
      );
    }
  },

  openCliUpdateInstructions() {
    const url = state.cliUpdateActionRequired?.officialInstructionsUrl;
    if (
      url &&
      /^https:\/\/(code\.claude\.com|developers\.openai\.com)\//.test(url)
    ) {
      void openExternalLink(url);
    }
  },

  dismissCliUpdateActionRequired() {
    setState("cliUpdateActionRequired", null);
  },

  resetSessionState() {
    sessionResetGeneration += 1;
    disposeAgentStoreRuntimeBindings();
    spawningConversations.clear();
    reattachingConversations.clear();
    expectedTerminateSessionIds.clear();
    restartTimers.forEach((timer) => clearTimeout(timer));
    restartTimers.clear();
    spawnFailureTimestamps.clear();
    setState({
      availableAgents: state.availableAgents,
      sessions: {},
      threadStates: {},
      activeSessionId: null,
      selectedAgentType: state.selectedAgentType,
      recentAgentConversations: [],
      remoteSessions: [],
      remoteSessionsNextCursor: null,
      remoteSessionsLoading: false,
      remoteSessionsError: null,
      isLoading: false,
      error: null,
      installStatus: null,
      cliScanRejection: null,
      cliUpdateActionRequired: null,
      pendingPermissions: [],
      pendingDiffProposals: [],
      agentModeEnabled: false,
    });
  },

  // ============================================================================
  // Event Handling (Internal)
  // ============================================================================

  handleSessionEvent(sessionId: string, event: AgentEvent) {
    // Warm-standby sessions must stay invisible until they are promoted.
    // Only session-status / promptComplete / error events affect lifecycle;
    // every other event would otherwise leak the seed prompt into the UI. #1631.
    const session = state.sessions[sessionId];
    if (
      session?.role === "standby" &&
      event.type !== "sessionStatus" &&
      event.type !== "promptComplete" &&
      event.type !== "error"
    ) {
      return;
    }

    // User replay messages can arrive as multiple chunks; flush buffered user
    // text when the stream transitions to a non-user event.
    if (event.type !== "userMessage") {
      this.flushPendingUserMessage(sessionId);
    }

    switch (event.type) {
      case "pairedEvent":
        this.handlePairedTranscriptEvent(sessionId, event.data);
        break;

      case "messageChunk":
        this.handleMessageChunk(
          sessionId,
          event.data.text,
          event.data.isThought,
          event.data.timestamp,
          {
            replay: event.data.replay === true,
            messageId: event.data.messageId,
            recoveryReplay: event.data.recoveryReplay === true,
            agentProvider: event.data.agentProvider,
          },
        );
        break;

      case "toolCall":
      case "toolResult":
        // Buffer tool events and flush on the same interval as streaming
        // chunks so a burst of N tool calls produces one SolidJS
        // reconciliation pass instead of N. See #1531.
        this.enqueueToolEvent(sessionId, event.type, event.data);
        break;

      case "diff":
        this.handleDiff(sessionId, event.data);
        break;

      case "planUpdate":
        setState("sessions", sessionId, "plan", event.data.entries);
        break;

      case "userMessage":
        // Desktop prompts are already appended by sendPrompt's UI path.
        // Remote prompts and history replay are the provider's source of
        // truth and must be reflected in the thread.
        if (event.data.replay === true || event.data.origin === "remote") {
          this.appendReplayUserChunk(
            sessionId,
            event.data.text,
            event.data.messageId,
            event.data.timestamp,
            event.data.origin,
          );
        }
        break;

      case "promptComplete": {
        // Standby sessions exist only to seed their context. First promptComplete
        // marks the seed done and releases the predictive mutex — no UI effects,
        // no drain, no compaction re-trigger. #1631.
        if (state.sessions[sessionId]?.role === "standby") {
          setState("sessions", sessionId, "seedCompleted", true);
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );
          // Find the serving session via its standbySessionId backref. The
          // serving's conversationId is the persisted thread id (e.g.
          // 3fa906a4…), but the standby is spawned with conversationId =
          // info.id (its own session id) and only inherits the serving's
          // conversationId during promoteStandbyAndDispatch — i.e. AFTER
          // promotion, well past this seed-completion tick. So a
          // conversationId pivot finds zero matches and strands every
          // queued #1749 prompt. Pivot through the standbySessionId backref
          // set at agent.store.ts:3069 instead. #1772.
          let servingForDrain: string | null = null;
          for (const [sid, s] of Object.entries(state.sessions)) {
            if (s.standbySessionId === sessionId && s.role === "serving") {
              setState("sessions", sid, "predictiveCompactInFlight", false);
              if ((s.pendingPrompts ?? []).length > 0) {
                servingForDrain = sid;
              }
            }
          }
          // Drain any prompts the user enqueued via the #1749 race guard while
          // this standby was being spawned. The drained sendPrompt will see
          // standbySessionId set + seedCompleted=true and route through
          // promoteStandbyAndDispatch, which carries the remaining queue
          // across the swap.
          if (servingForDrain) {
            const drainTarget = servingForDrain;
            const queue = state.sessions[drainTarget]?.pendingPrompts ?? [];
            const [nextPrompt, ...remaining] = queue;
            if (nextPrompt != null) {
              setState("sessions", drainTarget, "pendingPrompts", remaining);
              console.info(
                `[AgentStore] Standby ${sessionId} seeded — draining queued prompt on ${drainTarget} (#1749)`,
              );
              setTimeout(() => {
                void this.sendPrompt(
                  nextPrompt,
                  undefined,
                  undefined,
                  drainTarget,
                );
              }, 0);
            }
          }
          break;
        }

        // Flush any buffered tool events before finalizing the turn so all
        // tool messages are visible in the UI before the prompt completes.
        this.flushToolEventBuf(sessionId);
        const isHistoryReplay =
          event.data.historyReplay === true ||
          event.data.stopReason === "HistoryReplay";
        // End the replay-skip window so subsequent real messages are processed.
        if (isHistoryReplay) {
          setState("sessions", sessionId, "skipHistoryReplay", undefined);
        }
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId, { isReplay: isHistoryReplay });
        setState("sessions", sessionId, "assistantDraftMessageId", undefined);

        // Turn finalized successfully → clear the thread's in-flight signal,
        // the inline error state (if any), and the restart timer. #1631.
        if (!isHistoryReplay) {
          const convoId = state.sessions[sessionId]?.conversationId;
          if (convoId) {
            this.setTurnInFlight(convoId, false);
            this.clearTurnError(convoId);
          }
        }
        // Each promptComplete ends a turn; the next turn may have real content.
        setState("sessions", sessionId, "isSkippingSkillContext", undefined);
        if (!isHistoryReplay) {
          this.markPendingToolCallsComplete(sessionId);

          // Mark any remaining in-progress plan entries as completed.
          // Plan entry status is set by planUpdate events from the backend,
          // but a final planUpdate may not arrive after the last tool finishes.
          const plan = state.sessions[sessionId]?.plan;
          const isInProgress = (s: string) =>
            s === "in_progress" || s === "inprogress" || s === "inProgress";
          if (plan?.some((e) => isInProgress(e.status))) {
            setState(
              "sessions",
              sessionId,
              "plan",
              plan.map((e) =>
                isInProgress(e.status) ? { ...e, status: "completed" } : e,
              ),
            );
          }
        }

        // Track agent usage metadata for compaction decisions
        if (!isHistoryReplay && event.data.meta) {
          const inputTokens = event.data.meta.usage?.input_tokens;
          // Update context window size from model metadata when available
          const reportedContextWindow = event.data.meta.contextWindow;
          if (
            typeof reportedContextWindow === "number" &&
            reportedContextWindow > 0
          ) {
            // Surface tier-promise drift to the support pipeline. If the
            // picker entry's id ends in `[1m]` but the runtime reported a
            // window below 1M, the request never opted into the 1M tier
            // upstream and the gauge will lie about every subsequent turn.
            // Capture once per session so we get a regression signal without
            // spamming. #1761.
            const sess = state.sessions[sessionId];
            const expectedFromPicker = defaultContextWindowFor(
              sess?.info?.agentType ?? "",
              sess?.currentModelId,
            );
            // The denominator of the auto-compact gauge. Mirror of the
            // cache-layer guard in modelContextCache.ts (#1769) at the
            // in-memory layer: when the CLI echoes a sub-1M window for a
            // [1m]-suffixed session, refuse the in-memory overwrite so the
            // spawn-time 1M denominator survives the whole session. Without
            // this, compaction fires at ~178K (89% of 200K) instead of
            // ~890K — exactly 5x too early — for every 1M-tier user. #1798.
            const isOneMTierMismatch =
              expectedFromPicker > reportedContextWindow &&
              /\[1m\]$/i.test(sess?.currentModelId ?? "");
            if (isOneMTierMismatch && !sess?.contextWindowMismatchReported) {
              setState(
                "sessions",
                sessionId,
                "contextWindowMismatchReported",
                true,
              );
              void captureSupportError({
                kind: "agent.context_window_tier_mismatch",
                message: `Picker promised ${expectedFromPicker.toLocaleString()} but CLI reported ${reportedContextWindow.toLocaleString()} for ${sess?.currentModelId}`,
                stack: [],
                agentContext: {
                  model: sess?.currentModelId,
                  provider: sess?.info?.agentType,
                  tool_calls: [],
                },
              });
            }
            if (!isOneMTierMismatch) {
              setState(
                "sessions",
                sessionId,
                "contextWindowSize",
                reportedContextWindow,
              );
              // Persist (provider, modelId) -> contextWindow so next spawn of
              // this model starts with the correct value instead of the
              // agent-type default. Fire-and-forget; failures are non-fatal.
              const modelKey = sess?.currentModelId;
              const provider = sess?.info?.agentType;
              if (modelKey && provider) {
                void recordModelContextWindow(
                  provider,
                  modelKey,
                  reportedContextWindow,
                );
              }
            }
          }
          if (inputTokens != null) {
            setState("sessions", sessionId, "lastInputTokens", inputTokens);
            const ctxSize =
              state.sessions[sessionId]?.contextWindowSize ?? 200_000;
            verboseRuntimeConsole.debug(
              `[AgentStore] Agent usage: ${inputTokens} input tokens`,
              `(${Math.round((inputTokens / ctxSize) * 100)}% of ${ctxSize.toLocaleString()} context)`,
            );
          }
        }

        // A successful prompt completion proves the session is healthy.
        // Clear any stale error (e.g. auth-expired banner after re-login).
        if (!isHistoryReplay && state.sessions[sessionId]?.error) {
          setState("sessions", sessionId, "error", null);
          setState("error", null);
        }

        // Transition status back to "ready" so queued messages can be processed
        setState(
          "sessions",
          sessionId,
          "info",
          "status",
          "ready" as SessionStatus,
        );

        // Auto-compact check runs BEFORE drain (#1623). The drain block below
        // schedules a setTimeout to send the next queued prompt — if we drained
        // first and compaction then kicked in, the queued sendPrompt would
        // race the session teardown, add a user message to the old session's
        // messages array, and then be overwritten by compaction's stale
        // `toPreserve` snapshot. Triggering compaction first sets isCompacting
        // synchronously (before the first await in compactAgentConversation),
        // so the drain block's existing guard will skip. The queue is then
        // transferred to the new session inside compactAgentConversation.
        if (!isHistoryReplay && !state.sessions[sessionId]?.isCompacting) {
          const sess = state.sessions[sessionId];
          if (settingsStore.settings.autoCompactEnabled && sess) {
            let shouldCompact = false;

            if (sess.lastInputTokens && sess.lastInputTokens > 0) {
              const usagePercent =
                sess.lastInputTokens / sess.contextWindowSize;
              const threshold =
                settingsStore.settings.autoCompactThreshold / 100;
              if (usagePercent >= threshold) {
                console.info(
                  `[AgentStore] Context usage at ${Math.round(usagePercent * 100)}% — triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            } else {
              // No token usage data at all — fall back to message count.
              // Only count messages added since session start.
              const activeCount = Math.max(
                0,
                sess.messages.length - (sess.restoredMessageCount ?? 0),
              );
              if (activeCount > 200) {
                console.info(
                  `[AgentStore] ${activeCount} active messages without token usage data — triggering auto-compaction`,
                );
                shouldCompact = true;
              }
            }

            if (shouldCompact) {
              if (!authStore.isAuthenticated) {
                console.warn(
                  "[AgentStore] Skipping auto-compaction — user is not authenticated",
                );
                // State is already false (the guard above proved it). The
                // pre-#1661 code called promptLogin() here, which was a
                // no-op state flip. The user needs visible escalation —
                // their context is already approaching the model limit and
                // we just declined to compact. Show the modal.
                requestSignInModal();
              } else {
                // Predictive mode (#1675): spawn a standby alongside the live
                // serving session instead of tearing it down. The next user
                // submit promotes the standby; the chatbox stays mounted so
                // there is no flash. The standby-not-ready fallback in
                // sendPrompt handles the race when the user submits before
                // the seed completes.
                //
                // #1716: route through `kickPredictiveCompact` rather than
                // calling `compactAgentConversation` directly. The helper
                // acquires the global mutex and flips `predictiveCompactInFlight`
                // synchronously before the first await, so the 70% predictive
                // block below short-circuits on the same `promptComplete`.
                // Calling `compactAgentConversation` directly bypassed both
                // flags and let the 70% block kick a second concurrent
                // standby that orphaned the first. Queued prompts and
                // pendingUserPrompt handling already live inside
                // `kickPredictiveCompact` -> `compactAgentConversation`.
                void this.kickPredictiveCompact(sessionId);
              }
            }
          }
        }

        // Predictive compaction — warm a replacement session in the background
        // when the serving session crosses 70% of its context window, so the
        // next user submit swaps invisibly instead of hitting prompt-too-long. #1631.
        if (!isHistoryReplay && authStore.isAuthenticated) {
          const sess = state.sessions[sessionId];
          if (
            sess &&
            sess.role === "serving" &&
            sess.info.agentType !== "claude-codex" &&
            !sess.standbySessionId &&
            !sess.isCompacting &&
            !sess.predictiveCompactInFlight &&
            sess.info.status !== "prompting" &&
            sess.lastInputTokens != null &&
            sess.contextWindowSize > 0 &&
            sess.lastInputTokens / sess.contextWindowSize >=
              PREDICTIVE_COMPACT_THRESHOLD
          ) {
            void this.kickPredictiveCompact(sessionId);
          }
        }

        // Drain the prompt queue for this session. This runs in the store
        // regardless of which thread the UI is showing, so background threads
        // don't stall. Guard against reactive compaction only — if the
        // auto-compact block above fired in reactive mode, `isCompacting`
        // was set synchronously (before the first await in
        // compactAgentConversation), the session is about to be terminated,
        // and the queue will be transferred to the new session inside
        // compactAgentConversation (#1623). Predictive compaction (#1631)
        // does NOT set isCompacting on the serving session (#1673), so the
        // guard correctly lets the drain proceed onto the still-running
        // serving session.
        if (!isHistoryReplay && !state.sessions[sessionId]?.isCompacting) {
          const queue = state.sessions[sessionId]?.pendingPrompts ?? [];
          if (queue.length > 0) {
            const [nextPrompt, ...remaining] = queue;
            setState("sessions", sessionId, "pendingPrompts", remaining);
            console.log(
              "[AgentStore] Draining queued prompt for session",
              sessionId,
              "remaining:",
              remaining.length,
            );
            // Dispatch asynchronously so the promptComplete handler finishes
            // before the next sendPrompt begins.
            setTimeout(() => {
              void this.sendPrompt(nextPrompt, undefined, undefined, sessionId);
            }, 100);
          }
        }

        break;
      }

      case "configOptionsUpdate": {
        const restore = state.sessions[sessionId]?.pendingConfigRestore;
        const incoming = event.data.configOptions;
        // Ignore a malformed frame whose configOptions is not an array — both
        // the `.map` below and the selector `.find` readers would throw on it,
        // tripping the workspace-recovery boundary. #2869.
        if (!Array.isArray(incoming)) break;
        const merged = restore
          ? incoming.map((opt) =>
              opt.type === "select" && restore[opt.id]
                ? { ...opt, currentValue: restore[opt.id] }
                : opt,
            )
          : incoming;
        setState("sessions", sessionId, "configOptions", merged);
        if (restore) {
          setState("sessions", sessionId, "pendingConfigRestore", undefined);
          for (const [id, value] of Object.entries(restore)) {
            void this.setConfigOption(id, value, sessionId);
          }
        }
        break;
      }
      case "sessionStatus":
        this.handleStatusChange(sessionId, event.data.status, event.data);
        break;

      case "mcpDegraded": {
        // The Seren gateway connected for this session (its instructions
        // loaded) but never registered its tools, and the runtime exhausted
        // its in-place reconnect attempts. Surface a calm, non-fatal notice —
        // the thread still works for non-publisher tasks, so this must NOT set
        // the persistent session error banner or freeze the composer — and
        // route it to the support pipeline so a persistent gateway
        // `tools/list` failure becomes ticketable rather than silent. #2802
        const degradedSession = state.sessions[sessionId];
        if (!degradedSession) {
          break;
        }
        const degradedNotice =
          "Seren publisher tools could not be loaded for this thread — the " +
          "Seren gateway was reachable but its tool list stayed unavailable " +
          "after several retries. Publisher actions may fail here; start a " +
          "new thread to try again.";
        const lastDegradedMessage = degradedSession.messages.at(-1);
        if (
          lastDegradedMessage?.type !== "error" ||
          lastDegradedMessage.content !== degradedNotice
        ) {
          const noticeMessage: AgentMessage = {
            id: crypto.randomUUID(),
            type: "error",
            content: degradedNotice,
            timestamp: Date.now(),
          };
          setState("sessions", sessionId, "messages", (msgs) => [
            ...msgs,
            noticeMessage,
          ]);
          const degradedConvoId = degradedSession.conversationId;
          if (degradedConvoId) {
            persistAgentMessage(
              degradedConvoId,
              noticeMessage,
              degradedSession.info.agentType ?? null,
            );
          }
        }
        void captureSupportError({
          kind: "agent.seren_mcp_tools_unavailable",
          message: `seren-mcp registered 0 tools after reconnect recovery (server: ${event.data.serverName})`,
          agentContext: {
            model: degradedSession.currentModelId,
            provider: degradedSession.info.agentType,
            tool_calls: [],
          },
        });
        break;
      }

      case "error": {
        // Graceful "Task cancelled" is a system/user-initiated cancel
        // (predictive-compaction promotion teardown, Stop button, etc.) and
        // not a defect, so it is explicitly suppressed from the support
        // pipeline. Mirrors the RPC-timeout filter from #1699. #1708.
        const errorMessage = String(event.data.error);
        const isGracefulCancel = errorMessage.includes("Task cancelled");
        const isRecoverableSessionDeath = isSessionDeathMessage(errorMessage);
        const errorPrefix = `[AgentStore] Error event for session ${sessionId} (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}):`;
        if (isGracefulCancel) {
          benignConsoleError(
            "agent.graceful_cancel",
            errorPrefix,
            errorMessage,
          );
        } else if (isRecoverableSessionDeath) {
          console.info(errorPrefix, errorMessage);
        } else {
          console.error(errorPrefix, event.data.error);
        }

        // Clean up any in-flight streaming and tool cards
        this.flushPendingUserMessage(sessionId);
        this.finalizeStreamingContent(sessionId);
        this.markPendingToolCallsComplete(sessionId);

        if (isGracefulCancel) {
          // User-initiated cancellation: record in chat history but don't
          // show the persistent error banner (it's not a real error).
          const cancelMsg: AgentMessage = {
            id: crypto.randomUUID(),
            type: "error",
            content: event.data.error,
            timestamp: Date.now(),
          };
          setState("sessions", sessionId, "messages", (msgs) => [
            ...msgs,
            cancelMsg,
          ]);
          const cancelConvoId = state.sessions[sessionId]?.conversationId;
          const cancelAgentType =
            state.sessions[sessionId]?.info.agentType ?? null;
          if (cancelConvoId)
            persistAgentMessage(cancelConvoId, cancelMsg, cancelAgentType);

          // Transition back to "ready" so the UI unfreezes and the send
          // button reappears.  Without this the session stays stuck in
          // "prompting" forever (the promptComplete event never fires
          // after a cancellation).
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          // promptComplete is the only other code path that clears thread
          // turnInFlight, and it does not fire after a cancellation. Without
          // this, the ThinkingStatus dots stay stuck on "Evaluating…" while
          // the composer unfreezes — particularly visible when ef3d0467's
          // "cancelled" CompactionOutcome falls through to this branch
          // during a Stop / predictive-promotion teardown. #1767.
          if (cancelConvoId) {
            this.setTurnInFlight(cancelConvoId, false);
            this.clearTurnError(cancelConvoId);
          }
        } else if (String(event.data.error).includes("unresponsive")) {
          // "Agent unresponsive" errors are handled by the sendPrompt catch
          // block which spawns a fresh session and retries. Adding the error
          // here would create duplicate banners when the recovery code
          // restores message history to the new session.
          console.info(
            "[AgentStore] Skipping error message for unresponsive agent — sendPrompt handles recovery",
          );
        } else if (
          String(event.data.error).includes("Permission request timed out")
        ) {
          // Permission timeout: clean up stale permission dialogs and notify user
          console.warn(
            "[AgentStore] Permission request timed out for session:",
            sessionId,
          );

          // Remove all pending permissions for this session (they've timed out on backend)
          const timedOutPermissions = state.pendingPermissions.filter(
            (p) => p.sessionId === sessionId,
          );
          setState(
            "pendingPermissions",
            state.pendingPermissions.filter((p) => p.sessionId !== sessionId),
          );

          // Add error message to notify user
          if (timedOutPermissions.length > 0) {
            const timeoutMsg: AgentMessage = {
              id: crypto.randomUUID(),
              type: "error",
              content:
                "Permission request timed out after 5 minutes. " +
                "Please try your request again.",
              timestamp: Date.now(),
            };
            setState("sessions", sessionId, "messages", (msgs) => [
              ...msgs,
              timeoutMsg,
            ]);
            const toConvoId = state.sessions[sessionId]?.conversationId;
            const toAgentType =
              state.sessions[sessionId]?.info.agentType ?? null;
            if (toConvoId)
              persistAgentMessage(toConvoId, timeoutMsg, toAgentType);
          }
        } else if (isTimeoutError(String(event.data.error))) {
          // Other timeout errors are often spurious race conditions where the error
          // event is emitted but the operation completes successfully. Skip
          // displaying these errors to avoid confusing the user with false
          // error messages when their request actually succeeded.
          console.info(
            "[AgentStore] Skipping non-permission timeout error — likely spurious race condition",
          );
        } else if (
          isPromptTooLongError(String(event.data.error)) &&
          !state.sessions[sessionId]?.promptTooLongHandled
        ) {
          // Context window full — try compaction + retry before falling back.
          // The structured is_error event from the runtime is the only signal
          // we trust for prompt-too-long; promptTooLongHandled prevents this
          // path from racing with the rejection-reason check in sendPrompt.
          console.info("[AgentStore] Prompt too long detected in error event");
          setState("sessions", sessionId, "promptTooLongHandled", true);

          // Reset to "ready" so the UI unfreezes — promptComplete never
          // fires after this error so the session would stay stuck in
          // "prompting" forever without this.
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          // Try compact-and-retry first. Fall back to Chat only on
          // catastrophic failure — "skipped" means the user's single prompt
          // is too large for the context, and Chat would fail the same way.
          const compactPromise = this.compactAndRetry(sessionId).then(
            (outcome) => {
              if (outcome === "failed_catastrophic") {
                // failTurnForSession below routes this through setTurnError ->
                // _submitTurnErrorReport -> captureSupportError. Local diagnostic.
                console.warn(
                  "[AgentStore] Compaction failed catastrophically — falling back to Chat",
                );
                setState("sessions", sessionId, "promptTooLong", true);
                this.addErrorMessage(sessionId, event.data.error);
                this.failTurnForSession(sessionId, String(event.data.error));
                this.acceptRateLimitFallback().catch((err) => {
                  console.error("[AgentStore] Auto-failover failed:", err);
                });
              } else if (outcome === "skipped_nothing_to_compact") {
                // After #2031, this branch is only reached when the session
                // has too few messages to compact even with the aggressive
                // preserve count (1-2 messages). The prior banner blamed the
                // user's last message specifically — accurate only when the
                // session is genuinely a single huge prompt, but misleading
                // when the user did not type a huge message. Speak to the
                // session as a whole and tell them what will actually help.
                console.warn(
                  "[AgentStore] Compaction skipped (nothing to compact). Session is too small to compact — surfacing error to user without Chat fallback.",
                );
                const terminalMessage =
                  "This thread is too full for the model's context window and there is nothing left to compact. Start a new thread to continue.";
                this.addErrorMessage(sessionId, terminalMessage);
                this.failTurnForSession(sessionId, terminalMessage);
              }
              return outcome;
            },
          );
          setState(
            "sessions",
            sessionId,
            "compactRetryPromise",
            compactPromise,
          );
        } else if (isRateLimitError(String(event.data.error))) {
          // Rate limit detected — automatically switch to chat mode
          console.info(
            "[AgentStore] Rate limit detected, automatically switching to chat mode",
          );
          setState("sessions", sessionId, "rateLimitHit", true);
          this.addErrorMessage(sessionId, event.data.error);

          // Reset to "ready" so the UI unfreezes (same reason as above).
          setState(
            "sessions",
            sessionId,
            "info",
            "status",
            "ready" as SessionStatus,
          );

          // Automatically trigger failover without user interaction
          this.acceptRateLimitFallback().catch((err) => {
            console.error("[AgentStore] Auto-failover failed:", err);
          });
        } else if (
          /^Reconnecting\.\.\.\s*\d+\/\d+$/i.test(String(event.data.error))
        ) {
          // Transient reconnection attempt — show in chat but keep session
          // in "prompting" state so the queue doesn't drain prematurely.
          // The agent will resume its task after reconnecting.
          console.info(
            `[AgentStore] (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}) Transient reconnection: ${event.data.error}`,
          );
          this.addErrorMessage(sessionId, event.data.error);
        } else {
          // Mid-prompt session death — runtime emits one of these strings
          // when the child process is terminated or exits while a control
          // request is pending. sendPrompt's catch block at line ~3819 only
          // fires for synchronous IPC failures; post-dispatch deaths arrive
          // here as async events and miss the existing recovery path.
          // Without this branch, session.info.status stays "prompting" and
          // turnInFlight stays true, so ThinkingStatus runs indefinitely.
          // Catalog covers all three providers (#1805).
          const errStr = String(event.data.error);
          const isSessionDeath = isSessionDeathMessage(errStr);

          // Self-inflicted death: agentStore.terminateSession just killed
          // this session (e.g. preemptive idle-reclaim before a parallel
          // spawn). The runtime emits the death string when in-flight
          // control requests reject; the user did not experience a crash
          // and must not see a stuck error banner. The cleanups above
          // (flushPendingUserMessage, finalizeStreamingContent,
          // markPendingToolCallsComplete) already ran; just return. #1852.
          if (isSessionDeath && expectedTerminateSessionIds.has(sessionId)) {
            console.info(
              "[AgentStore] Suppressing self-inflicted death-string event:",
              sessionId,
            );
            break;
          }

          const deathConvoId = state.sessions[sessionId]?.conversationId;
          if (
            isSessionDeath &&
            deathConvoId &&
            this.isTurnInFlight(deathConvoId)
          ) {
            void this.recoverDroppedPrompt(sessionId, errStr);
          } else {
            this.addErrorMessage(sessionId, event.data.error);
            this.failTurnForSession(sessionId, errStr);
          }
        }
        break;
      }

      case "permissionRequest": {
        const permEvent = event.data as PermissionRequestEvent;
        console.info(
          "[AgentStore] Permission request received: requestId=" +
            permEvent.requestId +
            ", session=" +
            permEvent.sessionId +
            ", tool=" +
            JSON.stringify(
              (permEvent.toolCall as Record<string, unknown>)?.name ??
                "unknown",
            ),
        );
        if (
          state.pendingPermissions.some(
            (permission) => permission.requestId === permEvent.requestId,
          )
        ) {
          break;
        }
        setState("pendingPermissions", [
          ...state.pendingPermissions,
          permEvent,
        ]);
        break;
      }

      case "diffProposal": {
        const proposalEvent = event.data as DiffProposalEvent;
        setState("pendingDiffProposals", [
          ...state.pendingDiffProposals,
          proposalEvent,
        ]);
        break;
      }

      case "permissionResolved":
        setState(
          "pendingPermissions",
          state.pendingPermissions.filter(
            (permission) => permission.requestId !== event.data.requestId,
          ),
        );
        break;

      case "diffProposalResolved":
        setState(
          "pendingDiffProposals",
          state.pendingDiffProposals.filter(
            (proposal) => proposal.proposalId !== event.data.proposalId,
          ),
        );
        break;
    }
  },

  flushPendingUserMessage(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session?.pendingUserMessage) return;

    // During history replay skip mode, discard the buffered replay text
    // instead of appending it (restored SQLite messages are authoritative).
    if (session.skipHistoryReplay) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      setState("sessions", sessionId, "pendingUserMessageOrigin", undefined);
      return;
    }

    // Provider replay can store prompt primers as user turns. Discard them,
    // including the #2212 shape where publisher text precedes Active Skills.
    if (isGeneratedPromptPrimer(session.pendingUserMessage)) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      setState("sessions", sessionId, "pendingUserMessageOrigin", undefined);
      return;
    }

    const userMsg: AgentMessage = {
      id: session.pendingUserMessageId ?? crypto.randomUUID(),
      type: "user",
      content: session.pendingUserMessage,
      timestamp: session.pendingUserMessageTimestamp ?? Date.now(),
      ...(session.pendingUserMessageOrigin
        ? { origin: session.pendingUserMessageOrigin }
        : {}),
    };
    setState("sessions", sessionId, "messages", (msgs) => [...msgs, userMsg]);
    if (session.conversationId)
      persistAgentMessage(
        session.conversationId,
        userMsg,
        session.info.agentType,
      );
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessageOrigin", undefined);
  },

  appendReplayUserChunk(
    sessionId: string,
    text: string,
    messageId?: string,
    timestamp?: number,
    origin?: ProviderOrigin,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replay user chunks when we have restored messages from SQLite.
    if (session.skipHistoryReplay) return;

    // Keep assistant/thought replay chunks and user chunks in strict order.
    this.finalizeStreamingContent(sessionId);

    const incomingMessageId = messageId?.trim() || undefined;
    if (
      session.pendingUserMessage &&
      incomingMessageId &&
      session.pendingUserMessageId &&
      session.pendingUserMessageId !== incomingMessageId
    ) {
      this.flushPendingUserMessage(sessionId);
    }

    setState(
      "sessions",
      sessionId,
      "pendingUserMessage",
      (current) => current + text,
    );

    if (!session.pendingUserMessageId && incomingMessageId) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageId",
        incomingMessageId,
      );
    }
    if (session.pendingUserMessageTimestamp === undefined) {
      setState(
        "sessions",
        sessionId,
        "pendingUserMessageTimestamp",
        timestamp ?? Date.now(),
      );
    }
    if (origin) {
      setState("sessions", sessionId, "pendingUserMessageOrigin", origin);
    }
  },

  handleMessageChunk(
    sessionId: string,
    text: string,
    isThought?: boolean,
    timestamp?: number,
    meta?: {
      replay?: boolean;
      messageId?: string;
      recoveryReplay?: boolean;
      agentProvider?: string;
    },
  ) {
    let session = state.sessions[sessionId];
    if (!session) return;

    const recoveryMessageId =
      meta?.recoveryReplay === true ? meta?.messageId?.trim() : undefined;
    if (
      recoveryMessageId &&
      session.messages.some((message) => message.id === recoveryMessageId)
    ) {
      return;
    }

    // Skip normal replay assistant/thought chunks when we have restored
    // messages. Recovered provider sidecar outputs are allowed through only
    // when their stable message id is absent from restored SQLite history.
    if (session.skipHistoryReplay && !recoveryMessageId) return;

    // Paired threads interleave Claude and Codex output in one stream. A
    // producer change is a message boundary: land the previous agent's
    // buffer (attributed to it) before accumulating the next one. #2368.
    const agentProvider = meta?.agentProvider;
    if (agentProvider && session.pairedStreamProvider !== agentProvider) {
      const buf = chunkBufs.get(sessionId);
      if (
        session.streamingContent ||
        session.streamingThinking ||
        buf?.content ||
        buf?.thinking
      ) {
        this.finalizeStreamingContent(sessionId);
      }
      setState("sessions", sessionId, "pairedStreamProvider", agentProvider);
      session = state.sessions[sessionId];
      if (!session) return;
    }

    const isReplayChunk = meta?.replay === true;
    const messageId = isReplayChunk ? meta?.messageId : undefined;

    let buf = chunkBufs.get(sessionId);
    if (!buf) {
      buf = { content: "", thinking: "" };
      chunkBufs.set(sessionId, buf);
    }

    if (isThought) {
      // Set timestamp on the very first thinking chunk (cheap — fires once)
      if (!session.streamingThinking && !buf.thinking) {
        setState(
          "sessions",
          sessionId,
          "streamingThinkingTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.thinking += text;
    } else {
      if (
        isReplayChunk &&
        messageId &&
        session.streamingContentMessageId &&
        session.streamingContentMessageId !== messageId
      ) {
        flushChunkBuf(sessionId);
        flushThinkingMarkupStreamState(sessionId);
        this.finalizeStreamingContent(sessionId, { isReplay: true });
        session = state.sessions[sessionId];
        if (!session) return;
        buf = chunkBufs.get(sessionId);
        if (!buf) {
          buf = { content: "", thinking: "" };
          chunkBufs.set(sessionId, buf);
        }
      }
      if (isReplayChunk) {
        setState("sessions", sessionId, "streamingContentReplay", true);
        if (messageId) {
          setState(
            "sessions",
            sessionId,
            "streamingContentMessageId",
            messageId,
          );
        }
      }
      // Set timestamp on the very first content chunk (cheap — fires once)
      if (!session.streamingContent && !buf.content) {
        setState(
          "sessions",
          sessionId,
          "streamingContentTimestamp",
          timestamp ?? Date.now(),
        );
      }
      buf.content += text;
    }

    // Schedule a flush if one isn't already pending
    if (!chunkFlushTimers.has(sessionId)) {
      chunkFlushTimers.set(
        sessionId,
        setTimeout(() => {
          chunkFlushTimers.delete(sessionId);
          flushChunkBuf(sessionId);
        }, CHUNK_FLUSH_MS),
      );
    }
  },

  /**
   * Paired-thread transcript events (#2368): the setup declaration (stable,
   * updated in place when models/effort change) and inline handoff activity
   * lines. Both persist so the workflow stays visible in thread history.
   */
  handlePairedTranscriptEvent(sessionId: string, data: PairedTranscriptEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Land any in-flight streaming first so the event appears after the
    // message that produced it.
    this.finalizeStreamingContent(sessionId);

    if (data.kind === "handoff") {
      const handoff: AgentMessage = {
        id: data.messageId,
        type: "handoff",
        content: data.text,
        timestamp: Date.now(),
        provider: "seren",
      };
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, handoff]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, handoff, "seren");
      return;
    }

    // Declaration: stable per-conversation id so refreshes (model/effort
    // changes, resume) update the original transcript message in place —
    // including its persisted SQLite row, which upserts by id.
    const declarationId = `paired-declaration-${session.conversationId}`;
    const existingIndex = session.messages.findIndex(
      (m) => m.id === declarationId,
    );
    const message: AgentMessage = {
      id: declarationId,
      type: "assistant",
      content: data.text,
      timestamp:
        existingIndex >= 0
          ? session.messages[existingIndex].timestamp
          : Date.now(),
      provider: "seren",
    };
    if (existingIndex >= 0) {
      setState("sessions", sessionId, "messages", existingIndex, message);
    } else {
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    }
    if (session.conversationId)
      persistAgentMessage(session.conversationId, message, "seren");
  },

  enqueueToolEvent(
    sessionId: string,
    type: "toolCall" | "toolResult",
    data: unknown,
  ) {
    // Drop tool events for sessions where cancel has been requested.
    // The agent process may still be finishing a tool chain after cancel
    // was sent — processing those events just wastes render cycles and
    // makes the UI feel unresponsive while the user is waiting for the
    // cancel to take effect. #1531.
    const session = state.sessions[sessionId];
    if (session?.cancelRequested) return;

    let buf = toolEventBufs.get(sessionId);
    if (!buf) {
      buf = [];
      toolEventBufs.set(sessionId, buf);
    }
    buf.push({ type, data });

    // Schedule a flush if one isn't already pending.
    if (!toolEventFlushTimers.has(sessionId)) {
      toolEventFlushTimers.set(
        sessionId,
        setTimeout(() => {
          toolEventFlushTimers.delete(sessionId);
          this.flushToolEventBuf(sessionId);
        }, CHUNK_FLUSH_MS),
      );
    }
  },

  flushToolEventBuf(sessionId: string) {
    const timer = toolEventFlushTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      toolEventFlushTimers.delete(sessionId);
    }
    const buf = toolEventBufs.get(sessionId);
    if (!buf || buf.length === 0) return;
    toolEventBufs.delete(sessionId);

    // Process all buffered events in order. This triggers setState calls,
    // but SolidJS batches synchronous updates within the same microtask,
    // so the entire flush produces a single reconciliation pass.
    for (const event of buf) {
      if (event.type === "toolCall") {
        this.handleToolCall(sessionId, event.data as ToolCallEvent);
      } else {
        const d = event.data as {
          toolCallId: string;
          status: string;
          result?: string;
          error?: string;
        };
        this.handleToolResult(
          sessionId,
          d.toolCallId,
          d.status,
          d.result,
          d.error,
        );
      }
    }
  },

  handleToolCall(sessionId: string, toolCall: ToolCallEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed tool calls when we have restored messages.
    if (session.skipHistoryReplay) return;

    // Flush buffered chunks before reading streamingContent so tool cards
    // appear in correct chronological order relative to assistant text.
    flushChunkBuf(sessionId);
    flushThinkingMarkupStreamState(sessionId);
    if (session.streamingThinking) {
      const thinkingMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMsg,
      ]);
      if (session.conversationId)
        persistAgentMessage(
          session.conversationId,
          thinkingMsg,
          session.info.agentType,
        );
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }
    if (session.streamingContent) {
      const scrubbed = scrubAgentMarkup(session.streamingContent);
      if (scrubbed) {
        const contentMsg: AgentMessage = {
          id: session.streamingContentMessageId ?? crypto.randomUUID(),
          type: "assistant",
          content: scrubbed,
          timestamp: session.streamingContentTimestamp ?? Date.now(),
        };
        setState("sessions", sessionId, "messages", (msgs) => [
          ...msgs,
          contentMsg,
        ]);
        if (session.streamingContentReplay === true && session.conversationId) {
          persistAgentMessage(
            session.conversationId,
            contentMsg,
            session.info.agentType,
          );
        }
      }
      // Live intermediate flushes capture partial streaming text and must
      // stay UI-only. Replay-marked chunks are complete historical assistant
      // messages, so they were persisted above before the tool card interrupts.
      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
      setState("sessions", sessionId, "streamingContentReplay", undefined);
      setState("sessions", sessionId, "streamingContentMessageId", undefined);
    }

    // Skip duplicate if a message with this toolCallId already exists
    if (session.messages.some((m) => m.toolCallId === toolCall.toolCallId)) {
      return;
    }

    // Store pending tool call
    session.pendingToolCalls.set(toolCall.toolCallId, toolCall);

    // Add tool call message
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "tool",
      content: toolCall.title,
      timestamp: Date.now(),
      toolCallId: toolCall.toolCallId,
      toolCall,
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    if (session.conversationId)
      persistAgentMessage(
        session.conversationId,
        message,
        session.info.agentType,
      );
  },

  handleToolResult(
    sessionId: string,
    toolCallId: string,
    status: string,
    result?: string,
    error?: string,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed tool results when we have restored messages.
    if (session.skipHistoryReplay) return;

    // Update the tool message status
    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (msg.toolCallId === toolCallId && msg.toolCall) {
          return {
            ...msg,
            toolCall: {
              ...msg.toolCall,
              status,
              ...(result !== undefined && { result }),
              ...(error !== undefined && { error }),
            },
          };
        }
        return msg;
      }),
    );
    // Persist the updated tool message
    const updatedToolMsg = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) => m.toolCallId === toolCallId,
    );
    if (updatedToolMsg && session.conversationId) {
      persistAgentMessage(
        session.conversationId,
        updatedToolMsg,
        session.info.agentType,
      );
    }

    // Remove from pending
    session.pendingToolCalls.delete(toolCallId);
  },

  /**
   * Mark all tool calls that are still "running" or "pending" as "completed".
   * Called when promptComplete fires — all tool calls must be done by then.
   */
  markPendingToolCallsComplete(sessionId: string) {
    const session = state.sessions[sessionId];
    if (!session) return;

    const runningStatuses = ["running", "pending", "in_progress"];
    const hasRunning = session.messages.some(
      (msg) =>
        msg.toolCall &&
        runningStatuses.includes(msg.toolCall.status.toLowerCase()),
    );

    if (!hasRunning) return;

    setState("sessions", sessionId, "messages", (msgs) =>
      msgs.map((msg) => {
        if (
          msg.toolCall &&
          runningStatuses.includes(msg.toolCall.status.toLowerCase())
        ) {
          return {
            ...msg,
            toolCall: { ...msg.toolCall, status: "completed" },
          };
        }
        return msg;
      }),
    );
    // Persist all completed tool messages
    if (session.conversationId) {
      for (const msg of state.sessions[sessionId]?.messages ?? []) {
        if (msg.toolCall && msg.toolCall.status === "completed") {
          persistAgentMessage(
            session.conversationId,
            msg,
            session.info.agentType,
          );
        }
      }
    }

    // Clear pending map
    session.pendingToolCalls.clear();
  },

  handleDiff(sessionId: string, diff: DiffEvent) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replayed diffs when we have restored messages.
    if (session.skipHistoryReplay) return;

    const nextMessage: AgentMessage = {
      id: crypto.randomUUID(),
      type: "diff",
      content: `Modified: ${diff.path}`,
      timestamp: Date.now(),
      toolCallId: diff.toolCallId,
      diff,
    };

    setState("sessions", sessionId, "messages", (msgs) => {
      // If we already have a diff message for this tool call + path, update it in place
      // so streaming diff updates don't spam the timeline.
      const existingIndex = msgs.findIndex(
        (m) =>
          m.type === "diff" &&
          m.toolCallId === diff.toolCallId &&
          m.diff?.path === diff.path,
      );

      if (existingIndex >= 0) {
        const next = msgs.slice();
        next[existingIndex] = {
          ...next[existingIndex],
          // Keep the existing message id so keyed lists remain stable.
          id: next[existingIndex].id,
          timestamp: next[existingIndex].timestamp,
          content: nextMessage.content,
          diff: nextMessage.diff,
        };
        return next;
      }

      return [...msgs, nextMessage];
    });
    // Persist the diff message (find the actual stored version which may have an existing id)
    const storedDiff = state.sessions[sessionId]?.messages.find(
      (m: AgentMessage) =>
        m.type === "diff" &&
        m.toolCallId === diff.toolCallId &&
        m.diff?.path === diff.path,
    );
    if (storedDiff && session.conversationId) {
      persistAgentMessage(
        session.conversationId,
        storedDiff,
        session.info.agentType,
      );
    }
  },

  handleStatusChange(
    sessionId: string,
    status: SessionStatus,
    data?: SessionStatusEvent,
  ) {
    setState("sessions", sessionId, "info", "status", status);

    // Safety net: clear the replay-skip flag when the session becomes ready,
    // in case no promptComplete(historyReplay) was emitted.
    if (status === "ready") {
      setState("sessions", sessionId, "skipHistoryReplay", undefined);
    }

    if (data?.agentSessionId) {
      setState("sessions", sessionId, "agentSessionId", data.agentSessionId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationSessionIdDb(
          session.conversationId,
          data.agentSessionId,
        ).catch((error) => {
          console.warn("Failed to persist agent session id", error);
        });
      }
    }

    // Extract model state from session status events (e.g. ready with models).
    // Stale frames in flight at the moment of a user-initiated setModel still
    // carry the pre-switch currentModelId — they must NOT clobber the new
    // selection. While a pendingModelId is set, only accept events whose
    // currentModelId matches the pending value (the runtime ack); otherwise
    // hold. availableModels is always safe to update.
    if (data?.models) {
      const models = data.models as {
        currentModelId: string;
        availableModels: AgentModelInfo[];
      };
      const pending = state.sessions[sessionId]?.pendingModelId;
      if (!pending || pending === models.currentModelId) {
        setState(
          "sessions",
          sessionId,
          "currentModelId",
          models.currentModelId,
        );
        if (pending) {
          setState("sessions", sessionId, "pendingModelId", undefined);
        }
      }
      // A partial/malformed status frame can carry these list fields as a
      // non-array shape (#2862). Only accept arrays so no downstream render
      // ever dereferences a non-array with `.find`/`.map`; a later clean frame
      // restores the real list. Ignoring (vs. coercing to []) keeps a prior
      // good list intact through a transient bad frame. #2869.
      if (Array.isArray(models.availableModels)) {
        setState(
          "sessions",
          sessionId,
          "availableModels",
          models.availableModels,
        );
      }
    }

    // Extract mode state from session status events (e.g. ready with modes,
    // or CurrentModeUpdate notifications which only carry currentModeId)
    if (data?.modes) {
      const modes = data.modes as {
        currentModeId: string;
        availableModes?: AgentModeInfo[];
      };
      setState("sessions", sessionId, "currentModeId", modes.currentModeId);
      if (Array.isArray(modes.availableModes)) {
        setState("sessions", sessionId, "availableModes", modes.availableModes);
      }
    }

    if (Array.isArray(data?.configOptions)) {
      setState("sessions", sessionId, "configOptions", data.configOptions);
    }

    if (data?.paired) {
      setState("sessions", sessionId, "paired", data.paired);
      this.persistPairedConfig(sessionId, data.paired);
    }

    if (status === "ready") {
      // Clear stale error banner when session recovers — a ready session has
      // no persistent error to surface. Error messages in chat history remain.
      setState("sessions", sessionId, "error", null);
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }

    // When a session is terminated (force-stopped, permission timeout, etc.),
    // resolve any pending ready promise so sendPrompt unblocks instead of
    // hanging forever. sendPrompt will then detect the dead session and
    // trigger recovery.
    if (status === "terminated") {
      const entry = sessionReadyPromises.get(sessionId);
      if (entry) {
        entry.resolve();
        sessionReadyPromises.delete(sessionId);
      }
    }

    // Belt-and-suspenders for the case where session-status: terminated/error
    // arrives without a paired provider://error event (e.g. no pending control
    // request at the moment of death). The error-event branch in
    // handleSessionEvent is the primary detector; this catches the gap.
    // #1805.
    if (status === "terminated" || status === "error") {
      const convoId = state.sessions[sessionId]?.conversationId;
      if (
        convoId &&
        this.isTurnInFlight(convoId) &&
        !this.getTurnError(convoId) &&
        !expectedTerminateSessionIds.has(sessionId)
      ) {
        void this.recoverDroppedPrompt(
          sessionId,
          `Session ${status} mid-prompt`,
        );
      }
    }
  },

  finalizeStreamingContent(sessionId: string, opts?: { isReplay?: boolean }) {
    const isReplay =
      opts?.isReplay === true ||
      state.sessions[sessionId]?.streamingContentReplay === true;
    // Flush any buffered chunks before reading store state
    flushChunkBuf(sessionId);
    flushThinkingMarkupStreamState(sessionId);

    const session = state.sessions[sessionId];
    if (!session) return;

    // Producer attribution for paired threads — the finalized message
    // belongs to the agent whose chunks filled the buffer (#2368).
    const pairedProvider = session.pairedStreamProvider;

    // Finalize thinking content if any
    if (session.streamingThinking) {
      const thinkingMessage: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
        ...(pairedProvider ? { provider: pairedProvider } : {}),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMessage,
      ]);
      if (session.conversationId)
        persistAgentMessage(
          session.conversationId,
          thinkingMessage,
          session.info.agentType,
        );
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }

    // Finalize assistant content if any
    if (session.streamingContent) {
      // Skill context is injected into every prompt as additional context and
      // echoed back by the provider as an assistant message during session
      // replay. Discard these — they are system prompts, not conversation
      // content, and should never appear as visible chat messages.
      //
      // The content can arrive split across multiple finalizeStreamingContent
      // calls: the first chunk starts with '# Active Skills' (caught here), but
      // subsequent chunks of the same block start mid-content. The
      // isSkippingSkillContext flag ensures those continuations are also dropped.
      const isSkillContextStart = isGeneratedPromptPrimer(
        session.streamingContent,
      );
      if (isSkillContextStart || session.isSkippingSkillContext) {
        if (isSkillContextStart) {
          setState("sessions", sessionId, "isSkippingSkillContext", true);
        }
        setState("sessions", sessionId, "streamingContent", "");
        setState("sessions", sessionId, "streamingContentTimestamp", undefined);
        setState("sessions", sessionId, "streamingContentReplay", undefined);
        setState("sessions", sessionId, "streamingContentMessageId", undefined);
        setState("sessions", sessionId, "assistantDraftMessageId", undefined);
        setState("sessions", sessionId, "promptStartTime", undefined);
        return;
      }

      // Strip Claude Code scaffolding tags (<system-reminder>, <command-*>)
      // before persisting or rendering. The model occasionally echoes those
      // tags into its assistant text when a CLI skill (e.g. /loop) is active;
      // letting them through pollutes the JSONL transcript and Seren memory,
      // which makes the model continue extending the pattern on every
      // subsequent turn. #1807.
      const scrubbed = scrubAgentMarkup(session.streamingContent);
      if (scrubbed.length === 0) {
        setState("sessions", sessionId, "streamingContent", "");
        setState("sessions", sessionId, "streamingContentTimestamp", undefined);
        setState("sessions", sessionId, "streamingContentReplay", undefined);
        setState("sessions", sessionId, "streamingContentMessageId", undefined);
        setState("sessions", sessionId, "assistantDraftMessageId", undefined);
        setState("sessions", sessionId, "promptStartTime", undefined);
        return;
      }

      // Calculate duration if we have a start time
      const duration = session.promptStartTime
        ? Date.now() - session.promptStartTime
        : undefined;
      const finalOutputValidation = validateFinalOutput({
        finalText: scrubbed,
        evidence: buildAgentFinalizationEvidence(session),
      });
      const safeContent = finalOutputValidation.safeDisplayText;

      const message: AgentMessage = {
        id:
          session.assistantDraftMessageId ??
          session.streamingContentMessageId ??
          crypto.randomUUID(),
        type: "assistant",
        content: safeContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
        duration,
        finalOutputValidation,
        ...(pairedProvider ? { provider: pairedProvider } : {}),
      };
      verboseRuntimeConsole.debug(
        "[AgentRuntime] Adding assistant message to session:",
        sessionId,
        "conversationId:",
        session.conversationId,
        "content:",
        safeContent.slice(0, 50),
      );
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
      if (session.conversationId)
        persistAgentMessage(
          session.conversationId,
          message,
          session.info.agentType,
        );

      // Extract structured memory from the completed assistant turn so future
      // sessions can recall project preferences, procedures, and error fixes.
      // Gated by memoryEnabled, guarded against empty / replay / error turns,
      // and best-effort — a failure must not affect the session (#1625).
      if (
        !isReplay &&
        settingsStore.settings.memoryEnabled &&
        !isLikelyAuthError(safeContent) &&
        finalOutputValidation.canStoreMemory
      ) {
        processAssistantResponseMemory(safeContent, {
          conversationId: session.conversationId,
          model: `agent:${session.info.agentType}`,
          userQuery: session.lastUserPrompt,
          sessionId: session.conversationId,
          sourceExternalId: `desktop:agent:${message.id}`,
          sourceUri: session.conversationId
            ? `seren://desktop/conversations/${session.conversationId}/messages/${message.id}`
            : undefined,
        }).catch((err) => {
          console.warn("[AgentStore] process memory failed:", err);
        });
      }

      // If the agent streamed a short auth error as text, surface it as a session error
      // so the error banner with the Login button appears. Long messages are skipped
      // to avoid false positives when the agent discusses auth topics in normal output.
      if (isLikelyAuthError(safeContent)) {
        setState("sessions", sessionId, "error", safeContent);
      }

      // Prompt-too-long is detected exclusively from the CLI's structured
      // is_error result event (handled at the "error" event branch above).
      // The runtime emits provider://error only when payload.is_error is set,
      // so that path is the canonical signal. Scanning streamed assistant
      // prose for context-window keywords self-triggered compaction whenever
      // the model discussed those topics in normal output (#1776).

      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
      setState("sessions", sessionId, "streamingContentReplay", undefined);
      setState("sessions", sessionId, "streamingContentMessageId", undefined);
      setState("sessions", sessionId, "assistantDraftMessageId", undefined);
      // Clear the start time
      setState("sessions", sessionId, "promptStartTime", undefined);
    }
  },

  // ============================================================================
  // Fork
  // ============================================================================

  /**
   * Fork the current agent conversation from a specific message.
   *
   * Creates a new local conversation containing messages up to `fromMessageId`.
   * When the fork point is the latest message in a Claude session, we can use
   * the provider's native session fork. Otherwise we branch to a fresh runtime
   * session and bootstrap the exact transcript on the next prompt so the
   * selected fork point is authoritative.
   */
  async forkConversation(
    conversationId: string,
    fromMessageId: string,
  ): Promise<string | null> {
    // state.sessions is keyed by runtime sessionId, which only matches the
    // conversationId on cold-start. After a predictive-compaction promotion
    // the two diverge — fork must resolve via the conversationId field. #1682.
    const session = this.getSessionForConversation(conversationId);
    if (!session) {
      console.error(
        new Error("[AgentStore] forkConversation: session not found"),
      );
      return null;
    }

    const agentType = session.info.agentType;
    const cwd = session.cwd;
    const newConversationId = crypto.randomUUID();
    const pairedConfig = providerService.pairedSpawnConfigFromStatus(
      session.paired,
    );

    // 1. Collect messages up to the fork point.
    const allMessages = session.messages;
    const forkIndex = allMessages.findIndex((m) => m.id === fromMessageId);
    if (forkIndex === -1) {
      console.error(
        new Error("[AgentStore] forkConversation: message not found"),
      );
      return null;
    }
    const forkedMessages = allMessages.slice(0, forkIndex + 1).map((message) =>
      agentType === "claude-codex" &&
      message.id === `paired-declaration-${session.conversationId}`
        ? {
            ...message,
            id: `paired-declaration-${newConversationId}`,
          }
        : message,
    );
    const isHeadFork = forkIndex === allMessages.length - 1;
    const useNativeFork =
      providerService.supportsNativeProviderFork(agentType) && isHeadFork;

    let newAgentSessionId: string | undefined;
    let bootstrapPromptContext: string | undefined;

    if (useNativeFork) {
      try {
        newAgentSessionId = await providerService.nativeForkSession(
          session.info.id,
        );
      } catch (err) {
        console.error(
          "[AgentStore] forkConversation: native fork failed:",
          err,
        );
        this.addErrorMessage(
          session.info.id,
          `Fork failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }

      // #1825 sanity gate: the native-fork helper claims success only when a
      // forked JSONL is durable on disk, but a CLI version skew or a write
      // failure could still leave us with a non-resumable id. If the file
      // cannot be confirmed, drop the resume id and fall back to the
      // bootstrap-context branch — the same shape useNativeFork=false uses.
      // Mirrors the protective gate resumeAgentConversation got in #1657.
      let resumableJsonlExists = true;
      if (agentType === "claude-code" && newAgentSessionId) {
        try {
          resumableJsonlExists = await claudeSessionExists(
            cwd,
            newAgentSessionId,
          );
        } catch (err) {
          console.warn(
            "[AgentStore] forkConversation: claudeSessionExists check failed; falling back to bootstrap context:",
            err,
          );
          resumableJsonlExists = false;
        }
      }
      if (!resumableJsonlExists) {
        console.warn(
          "[AgentStore] forkConversation: forked Claude JSONL missing for",
          newAgentSessionId,
          "— falling back to bootstrap context",
        );
        newAgentSessionId = undefined;
        bootstrapPromptContext =
          buildForkBootstrapContext(session, forkedMessages) ?? undefined;
      }
    } else {
      bootstrapPromptContext =
        buildForkBootstrapContext(session, forkedMessages) ?? undefined;
    }

    // 2. Create a new local conversation in SQLite.
    const forkTitle = `Fork of ${session.title ?? "Agent"}`;
    try {
      await createAgentConversation(
        newConversationId,
        forkTitle,
        agentType,
        cwd,
        undefined,
        newAgentSessionId ?? undefined,
        serializeAgentConversationMetadata({
          pendingBootstrapPromptContext: bootstrapPromptContext,
          pendingBootstrapMessages: bootstrapPromptContext
            ? forkedMessages
            : undefined,
          pairedConfig,
        }) ?? undefined,
      );
    } catch (err) {
      console.error("[AgentStore] forkConversation: DB error:", err);
      return null;
    }

    // 3. Spawn a new local session for the fork.
    const resumeAgentSessionId = newAgentSessionId;
    const newSessionId = await this.spawnSession(cwd, agentType, {
      localSessionId: newConversationId,
      resumeAgentSessionId,
      conversationTitle: forkTitle,
      restoredMessages: forkedMessages,
      bootstrapPromptContext,
      initialModelId: session.currentModelId,
      paired: pairedConfig,
    });

    if (!newSessionId) {
      console.error(new Error("[AgentStore] forkConversation: spawn failed"));
      return null;
    }

    await this.restoreSessionSettings(session, newSessionId);

    console.info(
      `[AgentStore] Forked conversation ${conversationId} -> ${newConversationId}${newAgentSessionId ? ` (agent session: ${newAgentSessionId})` : " (bootstrap branch)"}`,
    );

    return newConversationId;
  },

  addErrorMessage(sessionId: string, error: string) {
    const session = state.sessions[sessionId];
    const agentLabel = agentDisplayName(session?.info.agentType);
    const prefixedError = `[${agentLabel}] ${error}`;
    const lastMessage = session?.messages.at(-1);

    if (
      lastMessage?.type !== "error" ||
      lastMessage.content !== prefixedError
    ) {
      const message: AgentMessage = {
        id: crypto.randomUUID(),
        type: "error",
        content: prefixedError,
        timestamp: Date.now(),
      };

      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
      const errConvoId = session?.conversationId;
      const errAgentType = session?.info.agentType ?? null;
      if (errConvoId) persistAgentMessage(errConvoId, message, errAgentType);
    }
    // Set session-specific error instead of global error
    setState("sessions", sessionId, "error", prefixedError);
  },

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clean up all sessions (call on app unmount).
   */
  async cleanup() {
    for (const sessionId of Object.keys(state.sessions)) {
      await this.terminateSession(sessionId);
    }
  },
};

export type {
  AgentInfo,
  AgentSessionInfo,
  AgentType,
  DiffEvent,
  DiffProposalEvent,
  SessionStatus,
};
