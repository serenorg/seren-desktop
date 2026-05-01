// ABOUTME: Reactive provider-runtime state management for agent sessions.
// ABOUTME: Stores agent sessions, message streams, tool calls, and plan state.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import {
  isLocalProviderRuntime,
  onRuntimeEvent,
} from "@/lib/browser-local-runtime";
import { runtimeHasCapability } from "@/lib/runtime";
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

/** Session IDs that have been explicitly terminated. The global event subscriber
 *  drops events for these IDs to prevent stale errors from dead sessions leaking
 *  into new/live sessions. Cleared when the global subscriber is torn down. */
const terminatedSessionIds = new Set<string>();

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
 * Global cap = 1 simultaneous predictive compaction across the whole app.
 * Prevents 3x Sonnet 4 calls and 3x Node subprocesses when multiple threads
 * cross the threshold in the same promptComplete tick. #1631.
 */
let predictiveCompactBusy = false;

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
  'call list_agent_publishers with slug: "<name>" to enumerate its ' +
  "tools, then call_publisher to invoke. This live-query rule " +
  "overrides any prior belief about what tools you have.";

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

/** Wait for a session to return to 'ready' (not 'prompting') with a timeout.
 * Used after sending the compaction seed prompt to avoid racing with the retry. */
async function waitForSessionIdle(
  sessionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (state.sessions[sessionId]?.info.status === "prompting") {
    if (Date.now() >= deadline) {
      console.warn(
        `[AgentStore] waitForSessionIdle: timed out after ${timeoutMs}ms for session ${sessionId}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

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

/** Claude Code model IDs that ship a 1M-token context tier behind the
 * `[1m]` suffix. Bare IDs default to 200K — Anthropic gates the 1M tier on
 * the suffix, which the CLI translates into a `context-1m-2025-08-07` beta
 * header. The first promptComplete still upserts the CLI-reported window via
 * recordModelContextWindow, so this is just the cold-start default. #1761. */
const CLAUDE_1M_TIER_CAPABLE_MODELS = new Set([
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-7",
]);

function defaultContextWindowFor(agentType: string, modelId?: string): number {
  if (agentType === "codex") return 1_000_000;
  if (agentType === "gemini") return 1_000_000;
  if (agentType === "claude-code" && modelId) {
    if (/\[1m\]$/i.test(modelId)) {
      const stripped = modelId.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
      if (CLAUDE_1M_TIER_CAPABLE_MODELS.has(stripped)) return 1_000_000;
    }
  }
  return 200_000;
}

import { isLikelyAuthError } from "@/lib/auth-errors";
import { buildChatRequest, sendProviderMessage } from "@/lib/providers";
import {
  isPromptTooLongError,
  isRateLimitError,
  isTimeoutError,
  performAgentFallback,
} from "@/lib/rate-limit-fallback";
import { captureSupportError } from "@/lib/support/hook";
import {
  clearConversationHistory,
  createAgentConversation,
  type AgentConversation as DbAgentConversation,
  getAgentConversation,
  getAgentConversations,
  getMessages,
  getSerenApiKey,
  saveMessage,
  setAgentConversationMetadata as setAgentConversationMetadataDb,
  setAgentConversationModelId as setAgentConversationModelIdDb,
  setAgentConversationPermissionMode as setAgentConversationPermissionModeDb,
  setAgentConversationSessionId as setAgentConversationSessionIdDb,
  setAgentConversationTitle as setAgentConversationTitleDb,
} from "@/lib/tauri-bridge";
import { refreshAccessToken } from "@/services/auth";
import { claudeSessionExists } from "@/services/claudeMemory";
import {
  bootstrapMemoryContext,
  storeAssistantResponse,
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
  PermissionRequestEvent,
  PlanEntry,
  RemoteSessionInfo,
  SessionConfigOption,
  SessionStatus,
  SessionStatusEvent,
  ToolCallEvent,
} from "@/services/providers";
import * as providerService from "@/services/providers";
import { authStore, requestSignInModal } from "@/stores/auth.store";

/** Set once we've subscribed to `provider-runtime://ready` so repeated
 *  initialize() calls don't stack listeners. */
let providerRuntimeReadyListener: Promise<UnlistenFn> | null = null;

/** Set once we've subscribed to `provider-runtime://restarted` so repeated
 *  initialize() calls don't stack listeners. #1631. */
let providerRuntimeRestartedListener: Promise<UnlistenFn> | null = null;

/** Set once we've subscribed to `provider://cli-scan-rejected` so repeated
 *  initialize() calls don't stack listeners. #1646. */
let cliScanRejectedUnsub: (() => void) | null = null;

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
        const ts = state.threadStates[snap.conversationId];
        if (!ts?.turnInFlight || !ts.lastPromptText) continue;
        void (async () => {
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

// ============================================================================
// Types
// ============================================================================

export interface AgentCompactedSummary {
  content: string;
  originalMessageCount: number;
  compactedAt: number;
}

interface AgentConversationMetadata {
  pendingBootstrapPromptContext?: string;
  pendingBootstrapMessages?: AgentMessage[];
}

export interface AgentMessage {
  id: string;
  type: "user" | "assistant" | "thought" | "tool" | "diff" | "error";
  content: string;
  timestamp: number;
  toolCallId?: string;
  diff?: DiffEvent;
  toolCall?: ToolCallEvent;
  /** Duration in milliseconds for how long the response took */
  duration?: number;
  /** Total cost in SerenBucks for this message's query, reported by Gateway. */
  cost?: number;
  /** Names of documents processed via DocReader for this message. */
  docNames?: string[];
}

export interface AgentModelInfo {
  modelId: string;
  name: string;
  description?: string;
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
  /** Timestamp for current streaming thinking chunk buffer (ms epoch). */
  streamingThinkingTimestamp?: number;
  /** Buffered replay user text that may arrive as multiple chunks. */
  pendingUserMessage: string;
  /** Stable replay user message id for chunk aggregation. */
  pendingUserMessageId?: string;
  /** Timestamp for buffered replay user message (ms epoch). */
  pendingUserMessageTimestamp?: number;
  cwd: string;
  /** Local persisted conversation id (SQLite). */
  conversationId: string;
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
  /** Most recent user prompt text — used to retry after compaction. */
  lastUserPrompt?: string;
  /** Set after a compact-and-retry attempt so we only try once per prompt. */
  compactRetryAttempted?: boolean;
  /** In-flight compactAndRetry promise — awaited by sendPrompt catch block
   *  so compaction completes before the error handler gives up. */
  compactRetryPromise?: Promise<CompactionOutcome>;
  /** Transcript bootstrap injected into the first real prompt of a forked branch. */
  bootstrapPromptContext?: string;
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
    default:
      return agentType ?? "Agent";
  }
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
      metadata.pendingBootstrapMessages.length > 0)
    ? JSON.stringify(metadata)
    : null;
}

/**
 * Persist an agent message to SQLite so history survives session restarts.
 * Only user and assistant messages are stored — tool calls, diffs, and
 * internal events are transient and replayed by the provider.
 */
function persistAgentMessage(conversationId: string, msg: AgentMessage): void {
  if (msg.type !== "user" && msg.type !== "assistant") return;
  saveMessage(
    msg.id,
    conversationId,
    msg.type === "user" ? "user" : "assistant",
    msg.content,
    null,
    msg.timestamp,
    null,
  ).catch((error) =>
    console.warn("[AgentStore] Failed to persist agent message:", error),
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
      type: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
      timestamp: m.timestamp,
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
  | "seed_failed";

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
  /** Pending permission requests awaiting user response */
  pendingPermissions: PermissionRequestEvent[];
  /** Pending diff proposals awaiting user accept/reject */
  pendingDiffProposals: DiffProposalEvent[];
  /** Whether agent mode is active (vs chat mode) */
  agentModeEnabled: boolean;
}

const [state, setState] = createStore<AgentState>({
  availableAgents: [],
  sessions: {},
  threadStates: {},
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
  pendingPermissions: [],
  pendingDiffProposals: [],
  agentModeEnabled: false,
});

let globalUnsubscribe: UnlistenFn | null = null;
const pendingSessionEvents = new Map<string, AgentEvent[]>();

/** Guard against concurrent auto-recovery spawns in sendPrompt (per-session). */
const recoveryInFlightMap = new Map<string, Promise<string | null>>();
const LEGACY_CLAUDE_LOCAL_SESSION_ID_RE = /^session-\d+$/;

// Chunk accumulation buffers — plain JS, not reactive.
// Flushed to the SolidJS store at CHUNK_FLUSH_MS intervals to reduce
// per-chunk setState calls during high-velocity streaming bursts.
const CHUNK_FLUSH_MS = 50;
const chunkBufs = new Map<string, { content: string; thinking: string }>();
const chunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

function flushChunkBuf(sessionId: string): void {
  const timer = chunkFlushTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    chunkFlushTimers.delete(sessionId);
  }
  const buf = chunkBufs.get(sessionId);
  if (!buf) return;
  if (buf.content) {
    setState("sessions", sessionId, "streamingContent", (c) => c + buf.content);
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
  if (globalUnsubscribe) {
    globalUnsubscribe();
    globalUnsubscribe = null;
  }
  pendingSessionEvents.clear();
  sessionReadyPromises.clear();
  recoveryInFlightMap.clear();
  terminatedSessionIds.clear();
  spawnContextMap.clear();
  for (const timer of chunkFlushTimers.values()) {
    clearTimeout(timer);
  }
  chunkFlushTimers.clear();
  chunkBufs.clear();
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
    return session?.messages ?? [];
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
    // Surface CLI-updater scan rejections per #1646. Default-on, runs once
    // at app init, idempotent (the runtime emits the event at most once
    // per launch per CLI). System notification + state record so the user
    // can review what was rejected and why.
    subscribeToCliScanRejections();

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
      const rows = await getAgentConversations(limit, cwd);
      setState("recentAgentConversations", rows);
    } catch (error) {
      console.error("Failed to load agent conversation history:", error);
    }
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
      const [page, localRows] = await Promise.all([
        providerService.listRemoteSessions(resolvedAgentType, cwd),
        getAgentConversations(200),
      ]);

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
      console.error("Failed to list remote sessions:", msg);
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
      console.error("Failed to list more remote sessions:", msg);
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
      /** Warm-standby spawns are invisible to the UI — no session-selector
       *  entry, events buffered not rendered, does not steal active focus. */
      role?: "serving" | "standby";
    },
  ): Promise<string | null> {
    const resolvedAgentType = agentType ?? state.selectedAgentType;
    const localSessionId = opts?.localSessionId;
    const resumeAgentSessionId = opts?.resumeAgentSessionId;
    const initRetryAttempt = opts?.initRetryAttempt ?? 0;
    const reclaimedIdleClaude = opts?.reclaimedIdleClaude ?? false;
    const conversationTitle =
      opts?.conversationTitle ??
      (resolvedAgentType === "codex"
        ? "Codex Agent"
        : resolvedAgentType === "gemini"
          ? "Gemini Agent"
          : "Claude Agent");

    // Prevent concurrent spawns for the same conversation. Internal retries
    // (initRetryAttempt > 0) are allowed through because they are sequential
    // continuations of the same spawn attempt, not independent races.
    const spawnKey = localSessionId ?? `anon-${Date.now()}`;
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
      // recall from past sessions — agent transcripts (written via
      // storeAssistantResponse below) accumulate into memory, and this
      // pulls them back on every fresh spawn including post-compaction
      // spawns. Best-effort; a failure here must not block the spawn (#1625).
      let memoryContext: string | undefined;
      if (settingsStore.settings.memoryEnabled) {
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
            if (data.status === "ready" && resolveReady) {
              resolveReady(data.sessionId);
            } else if (data.status === "error" && rejectReady) {
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                "Agent session failed during initialization.";
              rejectReady(new Error(sessionError));
            } else if (data.status === "terminated" && rejectReady) {
              // Claude process exited before reaching "ready" — typically an
              // auth failure or binary-not-found on Windows.
              const sessionError =
                state.sessions[data.sessionId]?.error ??
                "Agent session terminated before initialization completed. Check that Claude Code is installed and authenticated.";
              rejectReady(new Error(sessionError));
            }
          },
        );

      // Subscribe once to all agent runtime events before spawning, so early replay events
      // from load_session are buffered instead of dropped.
      if (!globalUnsubscribe) {
        globalUnsubscribe = await providerService.subscribeToAllEvents(
          (event) => {
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
                `${
                  data.agentType === "gemini"
                    ? "Gemini"
                    : data.agentType === "codex"
                      ? "Codex"
                      : "Claude Code"
                } sign-in required. Opening a Terminal window — finish the login there, then click + New Agent → ${
                  data.agentType === "gemini"
                    ? "Gemini Agent"
                    : data.agentType === "codex"
                      ? "Codex Agent"
                      : "Claude Agent"
                } again.`,
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

            // Skip logging high-frequency messageChunk events to avoid flooding
            // DevTools. Other event types (sessionStatus, toolCall, etc.) are
            // still logged for debugging.
            if (event.type !== "messageChunk") {
              const session = state.sessions[eventSessionId];
              const spawnCtx = session
                ? undefined
                : spawnContextMap.get(eventSessionId);
              console.log(
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
          },
        );
      }

      try {
        // Ensure the underlying CLI is installed and up-to-date before spawning
        const ensureFn =
          resolvedAgentType === "claude-code"
            ? providerService.ensureClaudeCli
            : resolvedAgentType === "codex"
              ? providerService.ensureCodexCli
              : resolvedAgentType === "gemini"
                ? providerService.ensureGeminiCli
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

        // Get Seren API key to enable MCP tools for the agent.
        // If null, auth may still be initializing — wait briefly and retry
        // so the agent gets publisher access on cold start.
        let apiKey = await getSerenApiKey();
        if (!apiKey) {
          await new Promise((r) => setTimeout(r, 3000));
          apiKey = await getSerenApiKey();
          if (apiKey) {
            console.info(
              "[AgentStore] API key became available after waiting for auth",
            );
          }
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
        if (localSessionId) {
          spawnContextMap.set(localSessionId, {
            agentType: resolvedAgentType,
            conversationId: localSessionId,
          });
          terminatedSessionIds.delete(localSessionId);
        }

        const reasoningEffort =
          resolvedAgentType === "claude-code"
            ? settingsStore.settings.claudeReasoningEffort
            : undefined;

        console.log("[AgentStore] Spawning agent process...");
        const info = await providerService.spawnAgent(
          resolvedAgentType,
          cwd,
          settingsStore.settings.agentSandboxMode,
          apiKey ?? undefined,
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
        );
        console.log("[AgentStore] Spawn result:", info);

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
        if (opts?.role !== "standby") {
          try {
            await createAgentConversation(
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
              }) ?? undefined,
            );
          } catch (error) {
            console.warn("Failed to persist agent conversation", error);
          }
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
        const session: ActiveSession = {
          info,
          messages: opts?.restoredMessages ?? [],
          plan: [],
          pendingToolCalls: new Map(),
          streamingContent: "",
          streamingThinking: "",
          pendingUserMessage: "",
          cwd,
          conversationId: info.id,
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
                "Agent session terminated before initialization completed. Check that Claude Code is installed and authenticated.";
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

        return info.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Runtime RPC timeouts surface when the embedded provider-runtime is
        // unresponsive — the Rust runtime monitor will restart it and the
        // `provider-runtime://restarted` listener re-dispatches the in-flight
        // turn. This is a transient runtime-layer failure, not a code defect
        // the user can act on; pass strings (no Error) to console.error so
        // the support pipeline doesn't capture it as a public bug report.
        // #151.
        if (message.includes("Runtime RPC timed out")) {
          console.error(
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
   * Resume a persisted agent conversation by loading its remote agent session.
   *
   * Provider sessions own transcript history; Seren only restores local
   * bootstrap snapshots for forks that have not materialized provider history yet.
   */
  async resumeAgentConversation(
    conversationId: string,
    cwd?: string,
  ): Promise<string | null> {
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
      console.error(
        `[AgentStore] Spawn cascade detected for ${conversationId} — ${SPAWN_CASCADE_MAX_FAILURES} failures in ${SPAWN_CASCADE_WINDOW_MS / 1000}s. Stopping auto-resume.`,
      );
      setState(
        "error",
        "Agent failed to start after multiple attempts. Please try again or check Settings.",
      );
      setState("isLoading", false);
      return null;
    }

    setState("error", null);

    // Pre-emptively clean up any stale backend session with this conversation id.
    // If the frontend lost track of a session (e.g. after a crash or auth error),
    // the backend may still hold it, causing "Session already exists" on re-spawn.
    // Mark as terminated so late-arriving events from the old session are dropped.
    terminatedSessionIds.add(conversationId);
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
    if (!convo) {
      setState("error", "Agent conversation not found");
      return null;
    }
    const agentType: AgentType =
      convo.agent_type === "codex" ||
      convo.agent_type === "claude-code" ||
      convo.agent_type === "gemini"
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

    const sessionId = await this.spawnSession(resumeCwd, agentType, {
      localSessionId: conversationId,
      resumeAgentSessionId: effectiveResumeId,
      conversationTitle: convo.title,
      restoredMessages,
      bootstrapPromptContext: pendingBootstrapPromptContext,
      initialModelId: convo.agent_model_id ?? undefined,
      initialPermissionMode: convo.agent_permission_mode ?? undefined,
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

  async buildPromptContext(
    sessionId: string,
    context?: Array<Record<string, string>>,
  ): Promise<Array<Record<string, string>> | undefined> {
    const session = state.sessions[sessionId];
    if (!session) {
      return context && context.length > 0 ? [...context] : undefined;
    }

    let mergedContext = context ? [...context] : [];

    if (session.bootstrapPromptContext) {
      mergedContext = [
        { type: "text", text: session.bootstrapPromptContext },
        ...mergedContext,
      ];
    }

    try {
      const skillsContent = await skillsStore.getThreadSkillsContent(
        session.cwd,
        session.conversationId,
      );
      if (skillsContent) {
        mergedContext = [
          { type: "text", text: skillsContent },
          ...mergedContext,
        ];
      }
    } catch (error) {
      console.warn(
        "[AgentStore] Failed to load skills for agent prompt:",
        error,
      );
    }

    mergedContext = [
      { type: "text", text: PUBLISHER_LIVE_QUERY_INSTRUCTION },
      ...mergedContext,
    ];

    return mergedContext.length > 0 ? mergedContext : undefined;
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

    if (!opts?.skipProviderKill) {
      try {
        await providerService.terminateSession(sessionId);
      } catch (error) {
        console.error("Failed to terminate session:", error);
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
  },

  /**
   * Set the active session.
   */
  setActiveSession(sessionId: string | null) {
    console.log(
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
    opts?: { mode?: "reactive" | "predictive" },
  ): Promise<CompactAgentResult> {
    const mode = opts?.mode ?? "reactive";
    const session = state.sessions[sessionId];
    if (!session || session.isCompacting) {
      return { outcome: "skipped_nothing_to_compact" };
    }

    const messages = session.messages;
    if (messages.length <= preserveCount) {
      console.info(
        "[AgentStore] Not enough messages to compact (message count below preserve threshold)",
      );
      return { outcome: "skipped_nothing_to_compact" };
    }

    // isCompacting signals "this serving session is being torn down and
    // re-spawned" — it gates `sendPrompt` and the promptComplete drain so
    // a queued prompt is not dispatched onto a dying session. Predictive
    // mode warms a standby alongside a still-running serving session
    // (#1631); flipping isCompacting on the serving session there makes
    // the drain block at the bottom of promptComplete skip indefinitely
    // and queued prompts get stuck (#1673). Predictive mode has its own
    // gates (`predictiveCompactInFlight` per-session, `predictiveCompactBusy`
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
      // Split messages into those to summarize and those to keep
      const toCompact = messages.slice(0, messages.length - preserveCount);
      const toPreserve = messages.slice(-preserveCount);

      // Generate a structured summary via Gateway API (not via the agent —
      // its context is what's overloaded). Uses a hard-capped schema to keep
      // the summary under 200 tokens, down from ~700 with freeform "500 words".
      // This reduces prompt tokens on every subsequent call by ~70%.
      const summaryPrompt = `Summarize this AI agent conversation into EXACTLY this structured format. Each field must be 1-2 short sentences max. Total output must be under 150 tokens.

GOAL: <what the user is trying to accomplish>
FILES: <files created or modified, comma-separated paths only>
DECISIONS: <key technical decisions made>
STATE: <what is done vs in progress>
NEXT: <what the agent should do next to continue the work>

Conversation:
${toCompact.map((m) => `${m.type.toUpperCase()}: ${m.content}`).join("\n\n")}

Structured summary:`;

      // Always route the summary through the public Seren provider.
      // sendMessage() uses providerStore.activeProvider which may be
      // stale from a previous chat thread (e.g. seren-private). The
      // compaction summary is an internal operation — it must not
      // depend on UI provider state.
      const summaryModel = "anthropic/claude-sonnet-4";
      const summaryRequest = buildChatRequest(summaryPrompt, summaryModel);
      let summary: string;
      try {
        summary = await sendProviderMessage("seren", summaryRequest);
      } catch (firstErr) {
        // If auth expired, attempt a token refresh and retry once
        const msg = firstErr instanceof Error ? firstErr.message : "";
        if (msg.includes("Not authenticated") || msg.includes("401")) {
          const refreshed = await refreshAccessToken();
          if (!refreshed) throw firstErr;
          summary = await sendProviderMessage("seren", summaryRequest);
        } else {
          throw firstErr;
        }
      }

      const compactedSummary: AgentCompactedSummary = {
        content: summary,
        originalMessageCount: toCompact.length,
        compactedAt: Date.now(),
      };

      const queuedPrompts = session.pendingPrompts ?? [];

      // Build the structured seed prompt up-front — shared by both modes.
      const MAX_MSG_CHARS = 2000;
      const preservedContext = toPreserve
        .filter((m) => m.type === "user" || m.type === "assistant")
        .map((m) => {
          const content =
            m.content.length > MAX_MSG_CHARS
              ? `${m.content.slice(0, MAX_MSG_CHARS)}... [truncated]`
              : m.content;
          return `${m.type.toUpperCase()}: ${content}`;
        })
        .join("\n\n");
      const seedPrompt = preservedContext
        ? `Context restored after automatic compaction.\n\nPrior work summary:\n${summary}\n\nRecent messages:\n${preservedContext}\n\nConfirm you have this context in one sentence, then wait for the user's next message. Do not use any tools.`
        : `Context restored after automatic compaction.\n\nPrior work summary:\n${summary}\n\nConfirm you have this context in one sentence, then wait for the user's next message. Do not use any tools.`;

      if (mode === "predictive") {
        // Predictive path: spawn a STANDBY session alongside the live one.
        // No teardown, no UI side-effects — the next user submit promotes it.
        // isCompacting is intentionally NOT set on the serving session here
        // (#1673); concurrency is gated by `predictiveCompactInFlight` and
        // the module-level `predictiveCompactBusy` mutex.

        // #1713: synthetic-transcript pre-warm. When enabled, build a
        // synthetic JSONL on disk that splices the structured summary in
        // front of the parent's preserved tail and resume the standby
        // against THAT, so the standby's prior assistant turn is the real
        // prior assistant turn (no seed-ack misinterpretation).
        if (
          settingsStore.settings.compactSyntheticTranscript &&
          agentType === "claude-code"
        ) {
          try {
            const userTurnCount = Math.max(1, Math.ceil(toPreserve.length / 2));
            const syntheticAgentSessionId =
              await providerService.buildSyntheticTranscript(
                sessionId,
                summary,
                userTurnCount,
              );
            const syntheticStandbyId = await this.spawnSession(cwd, agentType, {
              role: "standby",
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
            // Mark seed-complete immediately so promotion does not stall on
            // a non-existent seed prompt.
            setState("sessions", syntheticStandbyId, "seedCompleted", true);
            predictiveCompactBusy = false;
            setState("sessions", sessionId, "predictiveCompactInFlight", false);
            console.info(
              `[compact.synthetic.success] standby ${syntheticStandbyId} resumed synthetic transcript ${syntheticAgentSessionId} for serving ${sessionId}`,
            );
            return { outcome: "succeeded", newSessionId: syntheticStandbyId };
          } catch (err) {
            // Defensive fallback: any failure (CLI rejects file, parent
            // JSONL unreadable, write fails) drops through to today's
            // seed-prompt path. The serving session is still alive.
            console.warn(
              `[compact.synthetic.fallback] ${err instanceof Error ? err.message : String(err)} — falling back to seed-prompt path`,
            );
          }
        }

        const standbyId = await this.spawnSession(cwd, agentType, {
          role: "standby",
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
        await providerService.sendPrompt(standbyId, seedPrompt);
        // promptComplete handler detects role==="standby" and sets
        // seedCompleted + releases predictiveCompactBusy.
        console.info(
          `[AgentStore] Predictive compaction: standby ${standbyId} seeding for serving ${sessionId}`,
        );
        return { outcome: "succeeded", newSessionId: standbyId };
      }

      // Reactive path: terminate old, spawn fresh serving, seed, retry.
      // Capture model id before terminate so the new session inherits the
      // cached per-model context window via #1700.
      const priorModelId = session.currentModelId;
      await this.terminateSession(sessionId);

      const newSessionId = await this.spawnSession(cwd, agentType, {
        localSessionId: conversationId,
        initialModelId: priorModelId,
      });

      if (!newSessionId) {
        console.error(
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

      // UI history is decoupled from model context (#1631). The new session
      // inherits the full transcript so users still see every earlier turn
      // on scroll-up — the model's context is the structured summary + the
      // preserved tail, seeded via the seed prompt below, not the transcript.
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
        `[AgentStore] Compacted ${toCompact.length} messages, preserved ${toPreserve.length}. Seeding new session.`,
      );

      // Wait for the new session to be ready, then restore settings and seed.
      // We deliberately stop here: dispatching the user's failed prompt is the
      // caller's job (`compactAndRetry`). Doing it inline produced two bugs in
      // one function — see #1757. The contract is "produce a fresh, idle,
      // seeded session and return its id"; nothing more.
      await waitForSessionReady(newSessionId);
      await this.restoreSessionSettings(session, newSessionId);
      await providerService.sendPrompt(newSessionId, seedPrompt);
      await waitForSessionIdle(newSessionId);

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
      const result = await this.compactAgentConversation(
        sessionId,
        settingsStore.settings.autoCompactPreserveMessages,
      );

      // Propagate non-success outcomes directly. "skipped" means the message
      // count was already under the preserve threshold (nothing to compact);
      // "failed_catastrophic" means spawn or summary threw. Chat fallback is
      // only correct for the latter; the former means a single prompt is too
      // large and Chat would fail identically — show an error instead.
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
        await providerService.sendPrompt(newSessionId, lastPrompt);
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
   * `predictiveCompactBusy`. #1631.
   */
  async kickPredictiveCompact(sessionId: string): Promise<void> {
    if (predictiveCompactBusy) return;
    const session = state.sessions[sessionId];
    if (!session || session.predictiveCompactInFlight) return;

    predictiveCompactBusy = true;
    setState("sessions", sessionId, "predictiveCompactInFlight", true);
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
        predictiveCompactBusy = false;
        setState("sessions", sessionId, "predictiveCompactInFlight", false);
        this.drainAfterPredictiveAbort(sessionId);
      }
      // On success, the standby's promptComplete handler clears both flags.
    } catch (err) {
      console.warn(
        "[AgentStore] kickPredictiveCompact failed (non-fatal):",
        err,
      );
      predictiveCompactBusy = false;
      setState("sessions", sessionId, "predictiveCompactInFlight", false);
      this.drainAfterPredictiveAbort(sessionId);
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
  ): Promise<void> {
    const serving = state.sessions[servingSessionId];
    const standbyId = serving?.standbySessionId;
    if (!serving || !standbyId) {
      // Fall through — caller will dispatch to serving.
      return;
    }
    const standby = state.sessions[standbyId];
    if (!standby) {
      return;
    }
    const conversationId = serving.conversationId;

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
        console.warn("[AgentStore] abortTurn cancelPrompt failed:", err);
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
    console.log("[AgentStore] sendPrompt called:", {
      sessionId,
      prompt: prompt.slice(0, 50),
    });

    const session = sessionId ? state.sessions[sessionId] : undefined;

    // Derive the thread id early so turnInFlight / turnError operate on the
    // right key across cold-start, promotion, and crash-recovery paths. #1631.
    const threadId = session?.conversationId;

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
        await this.promoteStandbyAndDispatch(
          sessionId,
          prompt,
          context,
          options,
        );
        return;
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
            await this.promoteStandbyAndDispatch(
              sessionId,
              prompt,
              context,
              options,
            );
            return;
          }
          console.info(
            `[AgentStore] Standby did not seed within ${STANDBY_SEED_WAIT_MS}ms — falling through to serving`,
          );
        }
        console.info(
          "[AgentStore] Standby not ready at submit; cancelling warm-up",
        );
        await this.terminateSession(session.standbySessionId).catch(() => {});
        setState("sessions", sessionId, "standbySessionId", null);
        predictiveCompactBusy = false;
        setState("sessions", sessionId, "predictiveCompactInFlight", false);
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

    console.log(
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
    if (convoId) persistAgentMessage(convoId, userMessage);
    // Discard any buffered chunks from the previous response
    clearChunkBuf(sessionId);
    setState("sessions", sessionId, "streamingContent", "");
    setState("sessions", sessionId, "streamingContentTimestamp", undefined);
    setState("sessions", sessionId, "streamingThinking", "");
    setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);

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

    console.log("[AgentStore] Calling providerService.sendPrompt...");
    try {
      const mergedContext = await this.buildPromptContext(sessionId, context);
      await providerService.sendPrompt(sessionId, prompt, mergedContext);
      this.clearBootstrapPromptContext(sessionId);
      console.log("[AgentStore] sendPrompt completed successfully");
    } catch (error) {
      const agentLabel = agentDisplayName(
        state.sessions[sessionId]?.info.agentType,
      );
      console.error(`[AgentStore] sendPrompt error (${agentLabel}):`, error);
      const message = error instanceof Error ? error.message : String(error);

      // Auto-recover from dead/zombie sessions.
      // "unresponsive" = agent force-stopped after timeout (prompt or cancel deadline).
      // Other patterns = session died unexpectedly.
      // NOTE: "Task cancelled" (graceful cancel) is excluded — not a dead session.
      const isForceStop = message.includes("unresponsive");
      const isDeadSession =
        message.includes("Worker thread dropped") ||
        message.includes("not found") ||
        message.includes("Session not initialized");
      if (
        isForceStop ||
        (!message.includes("Task cancelled") && isDeadSession)
      ) {
        // If another recovery is already in-flight for this session, wait
        // for it instead of spawning a duplicate session.
        const existingRecovery = recoveryInFlightMap.get(sessionId);
        if (existingRecovery) {
          console.info(
            `[AgentStore] Recovery already in-flight for ${sessionId}, waiting for it...`,
          );
          await existingRecovery;
          return;
        }

        console.info(
          "[AgentStore] Session appears dead, attempting auto-recovery...",
        );

        // Preserve conversation history and cwd before cleanup.
        // Filter out any "unresponsive" error messages that the event handler
        // may have added before this catch block ran — restoring them would
        // create duplicate banners in the new session.
        const existingMessages = [...session.messages].filter(
          (m) =>
            m.id !== userMessage.id &&
            !(m.type === "error" && m.content.includes("unresponsive")),
        );
        const cwd = session.cwd;
        const agentType = session.info.agentType;
        // Snapshot cancel intent before cleanup clears session state.
        const wasUserCancel = session.cancelRequested === true;

        // Clean up the dead session
        await this.terminateSession(sessionId);

        // Guard against concurrent recoveries: set the in-flight promise
        // before spawning so any parallel sendPrompt calls will wait.
        const doRecovery = async (): Promise<string | null> => {
          const newSessionId = await this.spawnSession(cwd, agentType, {
            localSessionId: session.conversationId,
            bootstrapPromptContext: session.bootstrapPromptContext,
            initialModelId: session.currentModelId,
          });
          if (newSessionId) {
            await this.restoreSessionSettings(session, newSessionId);

            // Restore conversation history to the new session.
            // Mark as restored so the message-count threshold ignores them.
            if (existingMessages.length > 0) {
              setState("sessions", newSessionId, "messages", existingMessages);
              setState(
                "sessions",
                newSessionId,
                "restoredMessageCount",
                existingMessages.length,
              );
            }

            if (wasUserCancel) {
              console.info(
                "[AgentStore] Agent unresponsive after cancel — spawned fresh session, skipping retry",
              );
            } else {
              setState("sessions", newSessionId, "messages", (msgs) => [
                ...msgs,
                userMessage,
              ]);
              const newConvoId = state.sessions[newSessionId]?.conversationId;
              if (newConvoId) {
                persistAgentMessage(newConvoId, userMessage);
              }

              console.info(
                `[AgentStore] Retrying prompt on new session ${newSessionId}`,
              );
              try {
                const retryContext = await this.buildPromptContext(
                  newSessionId,
                  context,
                );
                await providerService.sendPrompt(
                  newSessionId,
                  prompt,
                  retryContext,
                );
                this.clearBootstrapPromptContext(newSessionId);
                console.log("[AgentStore] Retry succeeded on new session");
              } catch (retryError) {
                console.error("[AgentStore] Retry failed:", retryError);
                this.setTurnError(
                  session.conversationId,
                  "restart_timeout",
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError),
                );
              }
            }
          }
          return newSessionId;
        };

        const recoveryPromise = doRecovery().finally(() => {
          recoveryInFlightMap.delete(sessionId);
        });
        recoveryInFlightMap.set(sessionId, recoveryPromise);

        const newSessionId = await recoveryPromise;
        if (!newSessionId) {
          setState("error", "Session died and could not be restarted.");
        }
        return;
      }

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
        }
        // Don't add error message — compactAndRetry handles fallback
      } else if (!message.includes("Task cancelled")) {
        this.addErrorMessage(sessionId, message);
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

    setState("sessions", sessionId, "pendingModelId", modelId);
    setState("sessions", sessionId, "userSelectedModelId", modelId);
    setState("sessions", sessionId, "currentModelId", modelId);
    try {
      await providerService.setModel(sessionId, modelId);
      const session = state.sessions[sessionId];
      if (session) {
        void setAgentConversationModelIdDb(
          session.conversationId,
          modelId,
        ).catch((error) => {
          console.warn("Failed to persist agent model selection", error);
        });
      }
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
      case "messageChunk":
        this.handleMessageChunk(
          sessionId,
          event.data.text,
          event.data.isThought,
          event.data.timestamp,
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
        this.appendReplayUserChunk(
          sessionId,
          event.data.text,
          event.data.messageId,
          event.data.timestamp,
        );
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
          predictiveCompactBusy = false;
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
            if (
              !sess?.contextWindowMismatchReported &&
              expectedFromPicker > reportedContextWindow &&
              /\[1m\]$/i.test(sess?.currentModelId ?? "")
            ) {
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
          if (inputTokens != null) {
            setState("sessions", sessionId, "lastInputTokens", inputTokens);
            const ctxSize =
              state.sessions[sessionId]?.contextWindowSize ?? 200_000;
            console.log(
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
                // flips `predictiveCompactBusy` and `predictiveCompactInFlight`
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

      case "error": {
        // Graceful "Task cancelled" is a system/user-initiated cancel
        // (predictive-compaction promotion teardown, Stop button, etc.) and
        // not a defect. Detect it before the diagnostic console.error so
        // the cancel branch can log strings only — the support hook's
        // capture filter requires an Error instance / stack-bearing object,
        // and a plain string skips the public-bug-report path. Mirrors the
        // RPC-timeout filter from #1699. #1708.
        const errorMessage = String(event.data.error);
        const isGracefulCancel = errorMessage.includes("Task cancelled");
        const errorPrefix = `[AgentStore] Error event for session ${sessionId} (${agentDisplayName(state.sessions[sessionId]?.info.agentType)}):`;
        if (isGracefulCancel) {
          console.error(errorPrefix, errorMessage);
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
          if (cancelConvoId) persistAgentMessage(cancelConvoId, cancelMsg);

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
            if (toConvoId) persistAgentMessage(toConvoId, timeoutMsg);
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
          // Guard with promptTooLongHandled to prevent duplicate fallbacks
          // when the error is also detected in streamed content.
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
                console.error(
                  "[AgentStore] Compaction failed catastrophically — falling back to Chat",
                );
                setState("sessions", sessionId, "promptTooLong", true);
                this.addErrorMessage(sessionId, event.data.error);
                this.acceptRateLimitFallback().catch((err) => {
                  console.error("[AgentStore] Auto-failover failed:", err);
                });
              } else if (outcome === "skipped_nothing_to_compact") {
                console.warn(
                  "[AgentStore] Compaction skipped (nothing to compact). Likely a single oversized prompt — surfacing error to user without Chat fallback.",
                );
                this.addErrorMessage(
                  sessionId,
                  "Your last message is too large for this agent's context window. Try shortening it, attaching files instead of pasting content, or starting a new thread.",
                );
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
          this.addErrorMessage(sessionId, event.data.error);
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
      return;
    }

    // Skill context can arrive as a userMessage event when the provider stores
    // context items as user turns. Discard it — same as in finalizeStreamingContent.
    if (session.pendingUserMessage.trimStart().startsWith("# Active Skills")) {
      setState("sessions", sessionId, "pendingUserMessage", "");
      setState("sessions", sessionId, "pendingUserMessageId", undefined);
      setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
      return;
    }

    const userMsg: AgentMessage = {
      id: crypto.randomUUID(),
      type: "user",
      content: session.pendingUserMessage,
      timestamp: session.pendingUserMessageTimestamp ?? Date.now(),
    };
    setState("sessions", sessionId, "messages", (msgs) => [...msgs, userMsg]);
    if (session.conversationId)
      persistAgentMessage(session.conversationId, userMsg);
    setState("sessions", sessionId, "pendingUserMessage", "");
    setState("sessions", sessionId, "pendingUserMessageId", undefined);
    setState("sessions", sessionId, "pendingUserMessageTimestamp", undefined);
  },

  appendReplayUserChunk(
    sessionId: string,
    text: string,
    messageId?: string,
    timestamp?: number,
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
  },

  handleMessageChunk(
    sessionId: string,
    text: string,
    isThought?: boolean,
    timestamp?: number,
  ) {
    const session = state.sessions[sessionId];
    if (!session) return;

    // Skip replay assistant/thought chunks when we have restored messages.
    if (session.skipHistoryReplay) return;

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
        persistAgentMessage(session.conversationId, thinkingMsg);
      setState("sessions", sessionId, "streamingThinking", "");
      setState("sessions", sessionId, "streamingThinkingTimestamp", undefined);
    }
    if (session.streamingContent) {
      const contentMsg: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        contentMsg,
      ]);
      // Do NOT persist this intermediate flush — it captures partial streaming
      // text (often raw file contents from tool results) that would pollute
      // the restored conversation history on restart. Only
      // finalizeStreamingContent (called at promptComplete) should persist
      // assistant messages.
      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
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
      persistAgentMessage(session.conversationId, message);
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
      persistAgentMessage(session.conversationId, updatedToolMsg);
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
          persistAgentMessage(session.conversationId, msg);
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
      persistAgentMessage(session.conversationId, storedDiff);
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
      setState(
        "sessions",
        sessionId,
        "availableModels",
        models.availableModels,
      );
    }

    // Extract mode state from session status events (e.g. ready with modes,
    // or CurrentModeUpdate notifications which only carry currentModeId)
    if (data?.modes) {
      const modes = data.modes as {
        currentModeId: string;
        availableModes?: AgentModeInfo[];
      };
      setState("sessions", sessionId, "currentModeId", modes.currentModeId);
      if (modes.availableModes) {
        setState("sessions", sessionId, "availableModes", modes.availableModes);
      }
    }

    if (data?.configOptions) {
      setState("sessions", sessionId, "configOptions", data.configOptions);
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
  },

  finalizeStreamingContent(sessionId: string, opts?: { isReplay?: boolean }) {
    const isReplay = opts?.isReplay ?? false;
    // Flush any buffered chunks before reading store state
    flushChunkBuf(sessionId);

    const session = state.sessions[sessionId];
    if (!session) return;

    // Finalize thinking content if any
    if (session.streamingThinking) {
      const thinkingMessage: AgentMessage = {
        id: crypto.randomUUID(),
        type: "thought",
        content: session.streamingThinking,
        timestamp: session.streamingThinkingTimestamp ?? Date.now(),
      };
      setState("sessions", sessionId, "messages", (msgs) => [
        ...msgs,
        thinkingMessage,
      ]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, thinkingMessage);
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
      const isSkillContextStart = session.streamingContent
        .trimStart()
        .startsWith("# Active Skills");
      if (isSkillContextStart || session.isSkippingSkillContext) {
        if (isSkillContextStart) {
          setState("sessions", sessionId, "isSkippingSkillContext", true);
        }
        setState("sessions", sessionId, "streamingContent", "");
        setState("sessions", sessionId, "streamingContentTimestamp", undefined);
        setState("sessions", sessionId, "promptStartTime", undefined);
        return;
      }

      // Calculate duration if we have a start time
      const duration = session.promptStartTime
        ? Date.now() - session.promptStartTime
        : undefined;

      const message: AgentMessage = {
        id: crypto.randomUUID(),
        type: "assistant",
        content: session.streamingContent,
        timestamp: session.streamingContentTimestamp ?? Date.now(),
        duration,
      };
      console.log(
        "[AgentRuntime] Adding assistant message to session:",
        sessionId,
        "conversationId:",
        session.conversationId,
        "content:",
        session.streamingContent.slice(0, 50),
      );
      setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
      if (session.conversationId)
        persistAgentMessage(session.conversationId, message);

      // Persist the assistant turn to Seren memory so future sessions (agent
      // or chat) can recall this conversation via memory_bootstrap. Gated by
      // memoryEnabled setting, guarded against empty / replay / error turns,
      // and best-effort — a failure must not affect the session (#1625).
      if (
        !isReplay &&
        settingsStore.settings.memoryEnabled &&
        session.streamingContent.trim().length > 0 &&
        !isLikelyAuthError(session.streamingContent)
      ) {
        storeAssistantResponse(session.streamingContent, {
          model: `agent:${session.info.agentType}`,
          userQuery: session.lastUserPrompt,
        }).catch((err) => {
          console.warn("[AgentStore] storeAssistantResponse failed:", err);
        });
      }

      // If the agent streamed a short auth error as text, surface it as a session error
      // so the error banner with the Login button appears. Long messages are skipped
      // to avoid false positives when the agent discusses auth topics in normal output.
      if (isLikelyAuthError(session.streamingContent)) {
        setState("sessions", sessionId, "error", session.streamingContent);
      }

      // If the agent's response is a prompt-too-long error (context window full),
      // try compaction + retry before falling back to Chat mode.
      // Guard with promptTooLongHandled to prevent duplicate fallbacks when
      // the error is detected in both streamed content and the error event.
      if (
        isPromptTooLongError(session.streamingContent) &&
        !session.promptTooLongHandled
      ) {
        console.info(
          "[AgentStore] Prompt too long detected in streamed content",
        );
        setState("sessions", sessionId, "promptTooLongHandled", true);
        const compactPromise = this.compactAndRetry(sessionId).then(
          (outcome) => {
            if (outcome === "failed_catastrophic") {
              console.error(
                "[AgentStore] Compaction failed catastrophically from streamed content — falling back to Chat",
              );
              setState("sessions", sessionId, "promptTooLong", true);
              this.acceptRateLimitFallback().catch((err) => {
                console.error(
                  "[AgentStore] Auto-failover from streamed content failed:",
                  err,
                );
              });
            } else if (outcome === "skipped_nothing_to_compact") {
              console.warn(
                "[AgentStore] Compaction skipped for streamed content — single prompt too large",
              );
              this.addErrorMessage(
                sessionId,
                "Your last message is too large for this agent's context window. Try shortening it, attaching files instead of pasting content, or starting a new thread.",
              );
            }
            return outcome;
          },
        );
        setState("sessions", sessionId, "compactRetryPromise", compactPromise);
      }

      setState("sessions", sessionId, "streamingContent", "");
      setState("sessions", sessionId, "streamingContentTimestamp", undefined);
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

    // 1. Collect messages up to the fork point.
    const allMessages = session.messages;
    const forkIndex = allMessages.findIndex((m) => m.id === fromMessageId);
    if (forkIndex === -1) {
      console.error(
        new Error("[AgentStore] forkConversation: message not found"),
      );
      return null;
    }
    const forkedMessages = allMessages.slice(0, forkIndex + 1);
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
    } else {
      bootstrapPromptContext =
        buildForkBootstrapContext(session, forkedMessages) ?? undefined;
    }

    // 2. Create a new local conversation in SQLite.
    const newConversationId = crypto.randomUUID();
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
        }) ?? undefined,
      );
    } catch (err) {
      console.error("[AgentStore] forkConversation: DB error:", err);
      return null;
    }

    // 3. Spawn a new local session for the fork.
    const newSessionId = await this.spawnSession(cwd, agentType, {
      localSessionId: newConversationId,
      resumeAgentSessionId: newAgentSessionId,
      conversationTitle: forkTitle,
      restoredMessages: forkedMessages,
      bootstrapPromptContext,
      initialModelId: session.currentModelId,
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

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      type: "error",
      content: prefixedError,
      timestamp: Date.now(),
    };

    setState("sessions", sessionId, "messages", (msgs) => [...msgs, message]);
    const errConvoId = session?.conversationId;
    if (errConvoId) persistAgentMessage(errConvoId, message);
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
