// ABOUTME: Per-thread provider switcher rendered in agent shells.
// ABOUTME: Lets the user move a thread back to chat or across native agents
// ABOUTME: in one click via switchChatProvider.

import type { Component } from "solid-js";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { PROVIDER_CONFIGS, type ProviderId } from "@/lib/providers";
import { allowsSerenPublicModels } from "@/services/organization-policy";
import {
  evaluateChatSwitchGuard,
  type SwitchBlockedReason,
  switchChatProvider,
} from "@/services/provider-bindings";
import type { AgentType } from "@/services/providers";
import { agentDisplayName, agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";
import { conversationStore } from "@/stores/conversation.store";
import { providerStore } from "@/stores/provider.store";
import { threadStore } from "@/stores/thread.store";

interface Props {
  threadId: string;
}

function describeSwitchBlock(reason: SwitchBlockedReason): string {
  switch (reason.kind) {
    case "streaming":
      return "Cannot switch provider while a response is streaming.";
    case "loading":
      return "Cannot switch provider while a turn is in flight.";
    case "rlm-processing":
      return "Cannot switch provider while the router is processing.";
    case "compacting":
      return "Cannot switch provider while the thread is compacting.";
    case "retrying":
      return "Cannot switch provider while a message is retrying.";
    case "agent-turn":
      return "Cannot switch provider while an agent turn is in flight.";
    case "agent-approval":
      return "Cannot switch provider while an agent approval is pending.";
    case "no-active-thread":
      return "No active conversation to switch.";
  }
}

function reportSwitchFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const friendly = message.includes("stale runtime binding")
    ? "This thread's provider was changed in another window. Refresh and try again."
    : `Switching provider failed: ${message}`;
  conversationStore.setError(friendly);
  console.warn("[ThreadProviderSwitcher] switch failed:", error);
}

export const ThreadProviderSwitcher: Component<Props> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const current = createMemo(() =>
    threadStore.findConversation(props.threadId),
  );
  const currentLabel = createMemo(() => {
    const row = current();
    if (!row) return "Provider";
    if (row.kind === "agent" && row.agentType) {
      return agentDisplayName(row.agentType);
    }
    if (row.provider && row.provider in PROVIDER_CONFIGS) {
      return PROVIDER_CONFIGS[row.provider as ProviderId].name;
    }
    return row.provider ?? "Provider";
  });

  // Chat-side providers visible in the dropdown. Mirrors the gating in
  // ModelSelector's chat rail so the two pickers agree on availability.
  const chatProviders = createMemo<ProviderId[]>(() => {
    const policy = authStore.privateChatPolicy;
    const publicAllowed = allowsSerenPublicModels(policy);
    return providerStore.configuredProviders.filter((id) => {
      if (id === "seren-private") return false;
      if (id === "seren" && !publicAllowed) return false;
      if (id !== "seren" && policy?.disable_external_model_providers)
        return false;
      return true;
    });
  });

  const availableAgents = createMemo(() =>
    agentStore.availableAgents.filter((a) => a.available),
  );

  const handleDocumentClick = (event: MouseEvent) => {
    if (!isOpen()) return;
    if (
      containerRef &&
      event.target instanceof Node &&
      !containerRef.contains(event.target)
    ) {
      setIsOpen(false);
    }
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });
  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  const selectChatProvider = (providerId: ProviderId) => {
    if (current()?.kind === "chat" && current()?.provider === providerId) {
      setIsOpen(false);
      return;
    }
    const blocked = evaluateChatSwitchGuard(props.threadId);
    if (blocked) {
      conversationStore.setError(describeSwitchBlock(blocked));
      return;
    }
    const models = providerStore.getModels(providerId);
    const fallbackModel = models[0]?.id;
    if (!fallbackModel) {
      conversationStore.setError(
        `No models available for ${PROVIDER_CONFIGS[providerId].name}.`,
      );
      return;
    }
    setIsOpen(false);
    void switchChatProvider(props.threadId, providerId, fallbackModel).catch(
      reportSwitchFailure,
    );
  };

  const selectAgent = (agentType: AgentType) => {
    if (current()?.kind === "agent" && current()?.agentType === agentType) {
      setIsOpen(false);
      return;
    }
    const blocked = evaluateChatSwitchGuard(props.threadId);
    if (blocked) {
      conversationStore.setError(describeSwitchBlock(blocked));
      return;
    }
    setIsOpen(false);
    void switchChatProvider(props.threadId, agentType, null).catch(
      reportSwitchFailure,
    );
  };

  return (
    <div class="relative" ref={containerRef}>
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 py-1 bg-surface-2 border border-surface-3 rounded-md text-xs text-foreground cursor-pointer hover:bg-surface-3 transition-colors"
        onClick={() => setIsOpen(!isOpen())}
        title="Switch provider"
      >
        <span class="font-medium max-w-[160px] truncate">{currentLabel()}</span>
        <span class="text-[10px] text-muted-foreground">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-full left-0 mb-1 min-w-[220px] bg-surface-0 border border-surface-3 rounded-lg shadow-lg z-50 overflow-hidden">
          <Show when={chatProviders().length > 0}>
            <div class="px-3 py-1.5 bg-surface-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Chat
            </div>
            <For each={chatProviders()}>
              {(providerId) => {
                const isCurrent = () =>
                  current()?.kind === "chat" &&
                  current()?.provider === providerId;
                return (
                  <button
                    type="button"
                    class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                      isCurrent() ? "bg-surface-2" : ""
                    }`}
                    onClick={() => selectChatProvider(providerId)}
                  >
                    <span class="text-sm text-foreground">
                      {PROVIDER_CONFIGS[providerId].name}
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
          <Show when={availableAgents().length > 0}>
            <div class="px-3 py-1.5 bg-surface-3 text-[10px] uppercase tracking-wider text-muted-foreground font-medium border-t border-surface-2">
              External agents
            </div>
            <For each={availableAgents()}>
              {(agent) => {
                const isCurrent = () =>
                  current()?.kind === "agent" &&
                  current()?.agentType === agent.type;
                return (
                  <button
                    type="button"
                    class={`w-full text-left px-3 py-2 border-b border-surface-2 last:border-b-0 transition-colors cursor-pointer hover:bg-surface-2 ${
                      isCurrent() ? "bg-surface-2" : ""
                    }`}
                    onClick={() => selectAgent(agent.type)}
                  >
                    <span class="text-sm text-foreground">
                      {agentDisplayName(agent.type)}
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};
