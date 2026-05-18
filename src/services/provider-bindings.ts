// ABOUTME: Frontend wrapper around the per-thread provider-runtime binding.
// ABOUTME: Hosts the safe-turn-boundary guard and the in-memory sync after a switch.

import {
  type BootstrapMessage,
  buildProviderBootstrapContext,
  providerNeedsBootstrap,
} from "@/lib/provider-bootstrap";
import type { ProviderId } from "@/lib/providers/types";
import { PROVIDER_CONFIGS } from "@/lib/providers/types";
import {
  getAgentConversation,
  getConversation,
  getProviderSessionRuntime,
  type ProviderSessionRuntime,
  switchThreadProvider as switchThreadProviderBridge,
} from "@/lib/tauri-bridge";
import type { AgentType } from "@/services/providers";
import { type AgentMessage, agentStore } from "@/stores/agent.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { fileTreeState } from "@/stores/fileTree";
import { providerStore } from "@/stores/provider.store";
import { threadStore } from "@/stores/thread.store";

type RuntimeProviderId = ProviderId | AgentType;

function isPickerProvider(provider: RuntimeProviderId): provider is ProviderId {
  return provider in PROVIDER_CONFIGS;
}

function isActivePickerThread(threadId: string): boolean {
  return (
    threadId === conversationStore.activeConversationId ||
    threadId === chatStore.activeConversationId
  );
}

export interface SwitchBlockedReason {
  kind:
    | "streaming"
    | "loading"
    | "rlm-processing"
    | "compacting"
    | "retrying"
    | "agent-turn"
    | "agent-approval"
    | "no-active-thread";
}

/**
 * Decide whether the picker is allowed to mutate the active thread's
 * runtime binding right now. Chat-side switching is only safe at a turn
 * boundary; the native-agent guard (pending approvals, diffs, spawn
 * locks) lands with native-agent switching.
 *
 * `compacting` and `retrying` live on chatStore and are tracked for the
 * currently-active conversation only, so we only block on them when the
 * caller is asking about that same thread.
 */
export function evaluateChatSwitchGuard(
  threadId: string,
): SwitchBlockedReason | null {
  if (!threadId) return { kind: "no-active-thread" };
  if (conversationStore.getLoadingFor(threadId)) return { kind: "loading" };
  if (conversationStore.getStreamingContentFor(threadId)) {
    return { kind: "streaming" };
  }
  if (conversationStore.getRLMProcessingFor(threadId)) {
    return { kind: "rlm-processing" };
  }
  if (threadId === chatStore.activeConversationId) {
    if (chatStore.isCompacting) return { kind: "compacting" };
    if (chatStore.retryingMessageId) return { kind: "retrying" };
  }
  const agentSession = agentStore.getSessionForConversation(threadId);
  if (
    agentStore.isTurnInFlight(threadId) ||
    agentSession?.streamingContent ||
    agentSession?.streamingThinking
  ) {
    return { kind: "agent-turn" };
  }
  if (agentStore.hasPendingApprovals(threadId)) {
    return { kind: "agent-approval" };
  }
  return null;
}

export interface SwitchChatProviderResult {
  runtime: ProviderSessionRuntime;
}

/**
 * Rebind a chat thread to a new provider+model. The Rust command writes
 * `provider_session_runtime` and mirrors `conversations.selected_*`
 * atomically; this wrapper then syncs the in-memory stores so the next
 * orchestrator turn picks up the new binding without a reload.
 *
 * Throws if the thread is busy. UI callers should consult
 * {@link evaluateChatSwitchGuard} first and disable the picker.
 */
export async function switchChatProvider(
  threadId: string,
  targetProvider: RuntimeProviderId,
  targetModel: string | null,
): Promise<SwitchChatProviderResult> {
  const blocked = evaluateChatSwitchGuard(threadId);
  if (blocked) {
    throw new Error(
      `Cannot switch provider while thread is ${blocked.kind.replace("-", " ")}`,
    );
  }

  // Build a deterministic bootstrap when switching into a provider that
  // owns a fresh native session - claude-code / codex / gemini have no
  // way to see the prior chat transcript otherwise. Chat-side switches
  // skip this: they re-read the canonical Seren transcript directly.
  const bootstrap = providerNeedsBootstrap(targetProvider)
    ? buildProviderBootstrapContext(collectTranscriptForBootstrap(threadId))
    : null;

  // Optimistic-concurrency token: read the current runtime row and ask
  // the Rust command to refuse if another window has rewritten the
  // binding in the meantime. First-time switches return `null` and run
  // unconditionally; subsequent switches pass the freshest `updated_at`
  // so a stale window cannot silently clobber a peer's write. The Rust
  // side surfaces a stable "stale runtime binding" error string that
  // callers can match on and prompt the user to retry.
  const existing = await getProviderSessionRuntime(threadId);
  const expectedUpdatedAt = existing?.updated_at ?? null;

  // Snapshot the pre-switch row so a cross-category transition can
  // move the in-memory row between the chat and agent caches after the
  // bridge call commits.
  const beforeRow = threadStore.findConversation(threadId);
  const currentKind = beforeRow?.kind ?? null;
  const targetKind: "chat" | "agent" = isPickerProvider(targetProvider)
    ? "chat"
    : "agent";

  const runtime = await switchThreadProviderBridge(
    threadId,
    targetProvider,
    targetModel,
    bootstrap,
    expectedUpdatedAt,
  );

  // Sync frontend caches so reads (orchestrator, transcript, picker)
  // reflect the new binding before the next turn fires. A null
  // targetModel means "the agent's runtime decides on spawn" and the
  // Rust mirror keeps the previous selected_model in the compat
  // column (COALESCE); mirror that here so the in-memory row does not
  // get cleared during a chat→agent switch.
  const effectiveModel = targetModel ?? beforeRow?.model ?? "";
  conversationStore.applyRuntimeBindingSync(
    threadId,
    targetProvider,
    effectiveModel,
  );
  chatStore.applyRuntimeBindingSync(threadId, targetProvider, effectiveModel);

  // Cross-category move. The Rust mirror has already flipped
  // `conversations.kind` and stamped/cleared `agent_type`; the in-memory
  // stores still hold the row in its OLD category until we move it.
  // Without this, the unified view returns the stale row and the
  // binding-driven shell selection in ThreadContent renders the wrong
  // shell.
  if (currentKind && currentKind !== targetKind) {
    if (targetKind === "agent") {
      await transitionChatToAgent(
        threadId,
        targetProvider as AgentType,
        runtime,
      );
    } else {
      await transitionAgentToChat(threadId);
    }
  }

  // The picker UI mirrors the active thread. Keep providerStore aligned
  // only for the active thread and only for picker-backed chat providers;
  // non-active pane switches and native-agent bindings must not mutate
  // global defaults.
  if (isActivePickerThread(threadId) && isPickerProvider(targetProvider)) {
    providerStore.setActiveProvider(targetProvider);
    if (targetModel !== null) {
      providerStore.setActiveModel(targetModel);
    }
  }

  return { runtime };
}

/**
 * Drop the row from the chat cache, fetch the new agent row from DB,
 * insert into the agent cache, then spawn a native session seeded with
 * the persisted bootstrap context so the new provider sees a usable
 * recap of the prior chat transcript. Ordering matters: the cache move
 * has to complete before the spawn so `threadStore.findConversation`
 * resolves to the agent row when ThreadContent re-renders.
 */
async function transitionChatToAgent(
  threadId: string,
  targetAgentType: AgentType,
  runtime: ProviderSessionRuntime,
): Promise<void> {
  // Capture the chat row BEFORE dropping it so we know which project
  // root to spawn against.
  const chatRow = threadStore.findConversation(threadId);
  const restoredMessages = collectRestoredAgentMessages(threadId);

  // Fetch the agent row BEFORE dropping the chat row so the unified
  // view can flip kinds without an empty window in between. With the
  // drop-first ordering, `threadStore.findConversation(threadId)`
  // returns undefined for the duration of the DB round-trip and
  // ThreadContent's binding-driven shell falls back to the pane's
  // static `chat` kind, briefly mounting an empty ChatContent before
  // the agent row arrives.
  let agentRow: Awaited<ReturnType<typeof getAgentConversation>> = null;
  try {
    agentRow = await getAgentConversation(threadId);
  } catch (error) {
    console.warn(
      "[provider-bindings] Failed to load agent row after chat→agent switch:",
      error,
    );
  }

  conversationStore.dropFromCache(threadId);
  if (agentRow) {
    agentStore.upsertAgentConversationFromDb(agentRow);
  }

  const cwd = chatRow?.projectRoot ?? fileTreeState.rootPath ?? null;
  if (!cwd) {
    // Without a cwd we can't spawn the native session; the user will
    // need to pick a project root before sending the next turn. The
    // bootstrap stays persisted on the runtime row and will be
    // consumed by the next spawn.
    console.warn(
      "[provider-bindings] Cross-category switch into agent without a cwd; spawn deferred until project root is set",
    );
    return;
  }

  try {
    await agentStore.spawnSession(cwd, targetAgentType, {
      localSessionId: threadId,
      conversationTitle: chatRow?.title,
      restoredMessages:
        restoredMessages.length > 0 ? restoredMessages : undefined,
      bootstrapPromptContext: runtime.bootstrap_context ?? undefined,
    });
  } catch (error) {
    console.warn(
      "[provider-bindings] Spawn after chat→agent switch failed:",
      error,
    );
  }
}

/**
 * Tear down any live native session for this thread, drop the agent
 * row from the agent cache, then fetch and insert the freshly-flipped
 * chat row so the chat shell takes over. Tear-down has to happen
 * before the cache move so pending approvals/diffs keyed to the old
 * session get dismissed cleanly.
 */
async function transitionAgentToChat(threadId: string): Promise<void> {
  const liveSession = Object.values(agentStore.sessions).find(
    (s) => s.conversationId === threadId,
  );
  if (liveSession) {
    try {
      await agentStore.terminateSession(liveSession.info.id, {
        nextActiveSessionId: null,
      });
    } catch (error) {
      console.warn(
        "[provider-bindings] Failed to terminate agent session on agent→chat switch:",
        error,
      );
    }
  }

  agentStore.dropAgentConversationFromCache(threadId);

  try {
    const chatRow = await getConversation(threadId);
    if (chatRow) {
      conversationStore.upsertFromDb(chatRow);
    }
  } catch (error) {
    console.warn(
      "[provider-bindings] Failed to load chat row after agent→chat switch:",
      error,
    );
  }
}

/**
 * Collect the canonical transcript for bootstrap purposes from whichever
 * store currently owns the thread's messages. Both chat and conversation
 * stores carry user/assistant rows; we deduplicate by id and order by
 * timestamp. Reads are keyed by `threadId` for both stores so a switch
 * fired on a non-active thread (multi-pane) does not silently drop the
 * chat-side messages.
 */
function collectTranscriptForBootstrap(threadId: string): BootstrapMessage[] {
  return collectTranscriptEntries(threadId).map(({ role, content }) => ({
    role,
    content,
  }));
}

function collectRestoredAgentMessages(threadId: string): AgentMessage[] {
  return collectTranscriptEntries(threadId).map((message) => ({
    id: message.id,
    type: message.role,
    content: message.content,
    timestamp: message.timestamp,
    provider: message.provider,
  }));
}

type TranscriptSourceMessage = {
  id: string;
  role: string;
  type?: string;
  content: string;
  timestamp: number;
  provider?: string;
};
type TranscriptTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  provider?: string;
};

function isTranscriptTurn(
  message: TranscriptSourceMessage,
): message is TranscriptSourceMessage & { role: "user" | "assistant" } {
  if (message.role !== "user" && message.role !== "assistant") return false;
  return message.type === undefined || message.type === message.role;
}

function collectTranscriptEntries(threadId: string): TranscriptTurn[] {
  const fromConversation = conversationStore.getMessagesFor(threadId);
  const fromChat = chatStore.getMessagesFor(threadId);
  const merged = new Map<string, TranscriptTurn>();

  for (const m of fromConversation) {
    if (!isTranscriptTurn(m)) continue;
    merged.set(m.id, {
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      provider: m.provider,
    });
  }
  for (const m of fromChat) {
    if (isTranscriptTurn(m) && !merged.has(m.id)) {
      merged.set(m.id, {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        provider: m.provider,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
}
