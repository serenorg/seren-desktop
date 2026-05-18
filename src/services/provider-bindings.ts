// ABOUTME: Frontend wrapper around the per-thread provider-runtime binding.
// ABOUTME: Hosts the safe-turn-boundary guard and the in-memory sync after a switch.

import {
  type BootstrapMessage,
  buildProviderBootstrapContext,
  providerNeedsBootstrap,
} from "@/lib/provider-bootstrap";
import type { ProviderId } from "@/lib/providers/types";
import {
  type ProviderSessionRuntime,
  switchThreadProvider as switchThreadProviderBridge,
} from "@/lib/tauri-bridge";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { providerStore } from "@/stores/provider.store";

export interface SwitchBlockedReason {
  kind: "streaming" | "loading" | "rlm-processing" | "no-active-thread";
}

/**
 * Decide whether the picker is allowed to mutate the active thread's
 * runtime binding right now. Chat-side switching is only safe at a turn
 * boundary; the native-agent guard (pending approvals, diffs, spawn
 * locks) lands with native-agent switching.
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
  targetProvider: ProviderId,
  targetModel: string,
): Promise<SwitchChatProviderResult> {
  const blocked = evaluateChatSwitchGuard(threadId);
  if (blocked) {
    throw new Error(
      `Cannot switch provider while thread is ${blocked.kind.replace("-", " ")}`,
    );
  }

  // Build a deterministic bootstrap when switching into a provider that
  // owns a fresh native session — claude-code / codex / gemini have no
  // way to see the prior chat transcript otherwise. Chat-side switches
  // skip this: they re-read the canonical Seren transcript directly.
  const bootstrap = providerNeedsBootstrap(targetProvider)
    ? buildProviderBootstrapContext(collectTranscriptForBootstrap(threadId))
    : null;

  const runtime = await switchThreadProviderBridge(
    threadId,
    targetProvider,
    targetModel,
    bootstrap,
  );

  // Sync frontend caches so reads (orchestrator, transcript, picker)
  // reflect the new binding before the next turn fires.
  conversationStore.applyRuntimeBindingSync(
    threadId,
    targetProvider,
    targetModel,
  );
  chatStore.applyRuntimeBindingSync(threadId, targetProvider, targetModel);

  // The picker UI mirrors the active thread; keep providerStore aligned
  // so the dropdown label matches the runtime row.
  providerStore.setActiveProvider(targetProvider);
  providerStore.setActiveModel(targetModel);

  return { runtime };
}

/**
 * Collect the canonical transcript for bootstrap purposes from whichever
 * store currently owns the thread's messages. Both chat and conversation
 * stores carry user/assistant rows; we deduplicate by id and order by
 * timestamp.
 */
function collectTranscriptForBootstrap(threadId: string): BootstrapMessage[] {
  const fromConversation = conversationStore.getMessagesFor(threadId);
  const fromChat = chatStore.messages;
  const merged = new Map<string, BootstrapMessage & { timestamp: number }>();

  for (const m of fromConversation) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    merged.set(m.id, {
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    });
  }
  for (const m of fromChat) {
    if (
      threadId === chatStore.activeConversationId &&
      (m.role === "user" || m.role === "assistant") &&
      !merged.has(m.id)
    ) {
      merged.set(m.id, {
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      });
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(({ role, content }) => ({ role, content }));
}
