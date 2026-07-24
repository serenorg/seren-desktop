// ABOUTME: Shared mutable runtime state for the agent store and its seams.
// ABOUTME: Owns the SolidJS store instance plus cross-cutting coordination maps.

import { createStore } from "solid-js/store";
import { HappyArchiveFence } from "@/lib/agent/happy-archive";
import type { AgentEvent } from "@/services/providers";
import type { AgentState } from "@/stores/agent.store";

/** Per-session ready promises — resolved when backend emits "ready" status */
export const sessionReadyPromises = new Map<
  string,
  { promise: Promise<void>; resolve: () => void }
>();

/** Conversations with a spawn currently in progress. Prevents double-spawn
 *  when selectThread fires twice before the first spawn registers the session. */
export const spawningConversations = new Set<string>();

/** Conversations with a live-session re-attach currently in progress.
 *  Multiple resume triggers can race before the adopted session reaches state. */
export const reattachingConversations = new Map<string, Promise<boolean>>();

/** Session IDs that have been explicitly terminated. The global event subscriber
 *  drops events for these IDs to prevent stale errors from dead sessions leaking
 *  into new/live sessions. Cleared when the global subscriber is torn down. */
export const terminatedSessionIds = new Set<string>();

export const happyArchiveFence = new HappyArchiveFence();

/** Exact provider sessions archived before a conversation owner was durable.
 * Kept separate from conversation fences so an unowned standby cannot evict
 * its healthy serving sibling. */
export const happyProviderArchiveTombstones = new Set<string>();

/** Session IDs that the agent store just terminated programmatically. The
 *  runtime emits "Session terminated before request completed." (and other
 *  death-string `provider://error` events) when in-flight control requests
 *  reject during a programmatic kill — those are self-inflicted and must
 *  not surface as user-visible chat errors. The error handler short-circuits
 *  death-string events for ids in this set. Cleared at the end of
 *  terminateSession after the IPC kill completes. #1852. */
export const expectedTerminateSessionIds = new Set<string>();

/** Lightweight context for sessions that are mid-spawn (IPC call in flight).
 *  Populated before providerService.spawnAgent and cleaned up after the session
 *  is registered in state.sessions. The global event logger consults this map
 *  so early events show the correct agent type and conversation ID. */
export const spawnContextMap = new Map<
  string,
  { agentType: string; conversationId?: string }
>();

/**
 * Per-thread restart-timer handles. Cleared when the turn produces its
 * first stream chunk or when a terminal error flips the bubble. #1631.
 */
export const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const [state, setState] = createStore<AgentState>({
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

export const agentOAuthRoutingRefreshes = new Map<string, Promise<boolean>>();
export const agentOAuthRoutingAvailability = new Map<string, boolean>();
export const agentOAuthRoutingDelivery = new Map<string, boolean>();
export const agentOAuthRoutingRevisions = new Map<string, string>();
export const agentOAuthRoutingSelectionThreads = new Map<string, string>();

export const pendingSessionEvents = new Map<string, AgentEvent[]>();

/** Guard against concurrent auto-recovery spawns in sendPrompt (per-session). */
export const recoveryInFlightMap = new Map<string, Promise<string | null>>();

export const messagePersistQueues = new Map<string, Promise<void>>();

/** Last pairedConfig JSON written per conversation, to skip no-op DB writes. */
export const pairedConfigPersisted = new Map<string, string>();

export const spawnFailureTimestamps = new Map<string, number[]>();
