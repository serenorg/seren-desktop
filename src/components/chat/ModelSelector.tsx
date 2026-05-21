// ABOUTME: Model selector dropdown for choosing AI models in chat.
// ABOUTME: Shows searchable model list from OpenRouter with provider filtering.

import type { Component } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { ProviderIcon } from "@/components/chat/ProviderIcon";
import {
  PROVIDER_CONFIGS,
  type ProviderId,
  type ProviderModel,
} from "@/lib/providers";
import { type Model, modelsService } from "@/services/models";
import {
  allowsSerenPrivateAgent,
  allowsSerenPublicModels,
} from "@/services/organization-policy";
import { privateModelsService } from "@/services/private-models";
import {
  evaluateChatSwitchGuard,
  type SwitchBlockedReason,
  switchChatProvider,
} from "@/services/provider-bindings";
import type { AgentType } from "@/services/providers";
import { agentDisplayName, agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";
import type { Conversation as ChatConversation } from "@/stores/chat.store";
import { chatStore } from "@/stores/chat.store";
import type { Conversation as StoreConversation } from "@/stores/conversation.store";
import { conversationStore } from "@/stores/conversation.store";
import { AUTO_MODEL_ID, providerStore } from "@/stores/provider.store";

interface ModelSelectorProps {
  threadId?: string | null;
}

function isProviderId(provider: unknown): provider is ProviderId {
  return (
    provider === "seren" ||
    provider === "seren-private" ||
    provider === "anthropic" ||
    provider === "openai"
  );
}

type PickerConversation = ChatConversation | StoreConversation;

export const ModelSelector: Component<ModelSelectorProps> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [draftProvider, setDraftProvider] = createSignal<ProviderId | null>(
    null,
  );
  const [openRouterModels, setOpenRouterModels] = createSignal<Model[]>([]);
  const [isLoadingModels, setIsLoadingModels] = createSignal(false);
  const [privateModels, setPrivateModels] = createSignal<ProviderModel[]>([]);
  let containerRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const activeThreadId = () =>
    props.threadId ??
    conversationStore.activeConversationId ??
    chatStore.activeConversationId;
  const activeConversation = (): PickerConversation | null => {
    const id = activeThreadId();
    if (!id) return null;
    return (
      conversationStore.conversations.find((c) => c.id === id) ??
      chatStore.conversations.find((c) => c.id === id) ??
      null
    );
  };
  const committedProvider = () => {
    const provider = activeConversation()?.selectedProvider;
    return isProviderId(provider) ? provider : providerStore.activeProvider;
  };
  const currentProvider = () => draftProvider() ?? committedProvider();
  const isPrivateChat = createMemo(() => currentProvider() === "seren-private");
  const committedModel = () =>
    activeConversation()?.selectedModel ??
    providerStore.activeModel ??
    chatStore.selectedModel;
  const committedAutoModel = () => committedModel() === AUTO_MODEL_ID;

  // Composite provider list for the chip rail. `seren-private` is gated
  // by org policy and never appears in `providerStore.configuredProviders`
  // (no API key / no OAuth — auth is via the user's session). Inject it
  // explicitly after `seren` when the policy allows so the rail shows
  // both Seren Models and Seren Private Models as peer options.
  const railProviders = createMemo<ProviderId[]>(() => {
    const policy = authStore.privateChatPolicy;
    const includePrivate = allowsSerenPrivateAgent(policy);
    const out: ProviderId[] = [];
    for (const id of providerStore.configuredProviders) {
      out.push(id);
      if (id === "seren" && includePrivate) out.push("seren-private");
    }
    if (includePrivate && !out.includes("seren-private")) {
      out.unshift("seren-private");
    }
    return out;
  });

  // Default models from provider store (curated list)
  const defaultModels = () => providerStore.getModels(currentProvider());

  // Load full model list from OpenRouter or private models catalog.
  createEffect(() => {
    const privatePolicy = authStore.privateChatPolicy;
    const privateEnabled = isPrivateChat();
    const committedPrivate = committedProvider() === "seren-private";
    void (async () => {
      setIsLoadingModels(true);
      try {
        if (privateEnabled) {
          const models = await privateModelsService.listAvailable();
          setPrivateModels(models);

          if (!committedPrivate) {
            return;
          }

          const current = untrack(() => committedModel()?.trim());
          const policyDefault = privatePolicy?.model_id?.trim();
          const hasCurrent =
            !!current && models.some((model) => model.id === current);
          if (!hasCurrent) {
            const fallback =
              (policyDefault &&
                models.find((model) => model.id === policyDefault)?.id) ||
              models[0]?.id;
            if (fallback) {
              const conversationId = untrack(() => activeThreadId());
              if (conversationId && !evaluateChatSwitchGuard(conversationId)) {
                void switchChatProvider(
                  conversationId,
                  "seren-private",
                  fallback,
                ).catch((error) => {
                  console.warn(
                    "[ModelSelector] private model fallback switch failed:",
                    error,
                  );
                });
              } else if (!conversationId) {
                providerStore.setActiveModel(fallback);
                chatStore.setModel(fallback);
              }
            }
          }
          return;
        }

        const models = await modelsService.getAvailable();
        setOpenRouterModels(models);
      } catch (err) {
        console.error("Failed to load available models:", err);
      } finally {
        setIsLoadingModels(false);
      }
    })();
  });

  // Filter models: show defaults when no search, search full catalog when typing
  const filteredModels = createMemo(() => {
    const query = searchQuery().toLowerCase().trim();

    if (isPrivateChat()) {
      const models = privateModels();
      if (!query) {
        return models;
      }
      return models.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query),
      );
    }

    // No search query - show curated defaults
    if (!query) {
      return defaultModels();
    }

    // Searching - use full OpenRouter catalog for Seren provider
    if (currentProvider() === "seren" && openRouterModels().length > 0) {
      const allModels = openRouterModels().map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        description: m.provider,
      }));
      return allModels.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          model.id.toLowerCase().includes(query),
      );
    }

    // For other providers, search within their models
    return defaultModels().filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query),
    );
  });

  const currentModel = () => {
    if (isPrivateChat()) {
      const selected = committedModel();
      return (
        privateModels().find((model) => model.id === selected) ?? {
          id: selected,
          name:
            authStore.privateChatPolicy?.model_id === selected
              ? "Organization default"
              : selected || "Select private model",
          contextWindow: 0,
          description: "Private model",
        }
      );
    }

    const activeModel = committedModel();
    if (activeModel === AUTO_MODEL_ID) {
      return { id: AUTO_MODEL_ID, name: "Auto", contextWindow: 0 };
    }

    const models = defaultModels();
    // First check defaults, then check full OpenRouter list for Seren
    const found = models.find((model) => model.id === activeModel);
    if (found) return found;

    // Check full catalog for Seren provider (user may have selected a non-default model)
    if (currentProvider() === "seren") {
      const orModel = openRouterModels().find((m) => m.id === activeModel);
      if (orModel) {
        return {
          id: orModel.id,
          name: orModel.name,
          contextWindow: orModel.contextWindow,
          description: orModel.provider,
        };
      }
    }

    return models[0];
  };

  const describeSwitchBlock = (reason: SwitchBlockedReason): string => {
    switch (reason.kind) {
      case "streaming":
        return "Cannot switch model while a response is streaming.";
      case "loading":
        return "Cannot switch model while a turn is in flight.";
      case "rlm-processing":
        return "Cannot switch model while the router is processing.";
      case "compacting":
        return "Cannot switch model while the thread is compacting.";
      case "retrying":
        return "Cannot switch model while a message is retrying.";
      case "agent-turn":
        return "Cannot switch model while an agent turn is in flight.";
      case "agent-approval":
        return "Cannot switch model while an agent approval is pending.";
      case "no-active-thread":
        return "No active conversation to switch.";
    }
  };

  const reportSwitchFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // The Rust optimistic-currency check rejects with a stable sentinel
    // when another window has already rewritten the runtime row. Swap
    // the developer-flavored sentinel for plain English the user can
    // act on. Everything else falls through to the raw message.
    const friendly = message.includes("stale runtime binding")
      ? "This thread's model was changed in another window. Refresh and try again."
      : `Switching provider failed: ${message}`;
    conversationStore.setError(friendly);
    console.warn("[ModelSelector] switch failed:", error);
  };

  /**
   * Switch the active thread to a new model on its current provider. If
   * no chat thread is active, fall back to mutating the global picker
   * (used by the welcome screen before any thread exists).
   */
  const selectModel = (modelId: string) => {
    const conversationId = activeThreadId();
    const targetProvider = currentProvider();
    if (!conversationId) {
      providerStore.setActiveProvider(targetProvider);
      providerStore.setActiveModel(modelId);
      chatStore.setModel(modelId);
      setIsOpen(false);
      setDraftProvider(null);
      return;
    }

    const blocked = evaluateChatSwitchGuard(conversationId);
    if (blocked) {
      conversationStore.setError(describeSwitchBlock(blocked));
      setIsOpen(false);
      return;
    }

    void switchChatProvider(conversationId, targetProvider, modelId).catch(
      reportSwitchFailure,
    );
    setIsOpen(false);
    setDraftProvider(null);
  };

  /**
   * Toggle which provider's models are visible in the list below.
   * Does NOT commit a thread switch — that happens only when the user
   * actually picks a model. This decouples "show me this provider's
   * models" from the destructive act of switching the thread's bound
   * runtime, which keeps clicking through the chips browsable and
   * lets the seren-private case work even when its model list is
   * fetched asynchronously (clicking the chip triggers the load).
   */
  const selectProvider = (providerId: ProviderId) => {
    setDraftProvider(providerId);
    setSearchQuery("");
  };

  /**
   * Switch the active thread INTO a native-agent provider (claude-code /
   * codex / gemini). Passes a null model so the agent's runtime decides
   * which model to spawn with; the user can refine via AgentChat's
   * AgentModelSelector after the session is live. The cross-category
   * machinery in `switchChatProvider` handles the cache move, native
   * session spawn with the persisted bootstrap, and shell remount.
   */
  const selectAgentProvider = (agentType: AgentType) => {
    const conversationId = activeThreadId();
    if (!conversationId) {
      conversationStore.setError(
        "Open a thread before switching to an external agent.",
      );
      return;
    }

    const blocked = evaluateChatSwitchGuard(conversationId);
    if (blocked) {
      conversationStore.setError(describeSwitchBlock(blocked));
      return;
    }

    void switchChatProvider(conversationId, agentType, null).catch(
      reportSwitchFailure,
    );
    setIsOpen(false);
    setDraftProvider(null);
  };

  const closeDropdown = () => {
    setIsOpen(false);
    setDraftProvider(null);
    setSearchQuery("");
  };

  const handleDocumentClick = (event: MouseEvent) => {
    if (!isOpen()) return;
    if (
      containerRef &&
      event.target instanceof Node &&
      !containerRef.contains(event.target)
    ) {
      closeDropdown();
    }
  };

  const formatContextWindow = (tokens: number): string => {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(tokens / 1000)}K`;
  };

  onMount(() => {
    document.addEventListener("click", handleDocumentClick);
  });

  onCleanup(() => {
    document.removeEventListener("click", handleDocumentClick);
  });

  if (isPrivateChat() && authStore.privateChatPolicy?.hide_model_picker) {
    return null;
  }

  return (
    <div class="relative min-w-0" ref={containerRef}>
      <button
        class="flex h-[38px] max-w-[170px] min-w-[136px] items-center gap-2 px-3 py-1.5 bg-popover border border-muted rounded-md text-sm text-foreground cursor-pointer transition-colors hover:border-muted-foreground/40"
        onClick={() => {
          const opening = !isOpen();
          setIsOpen(opening);
          if (opening) {
            setDraftProvider(committedProvider());
            setSearchQuery("");
            // Focus search input after dropdown opens
            setTimeout(() => searchInputRef?.focus(), 0);
          } else {
            setDraftProvider(null);
            setSearchQuery("");
          }
        }}
      >
        <ProviderIcon provider={currentProvider()} size={14} />
        <span
          class={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left ${committedAutoModel() ? "text-success" : "text-foreground"}`}
          title={currentModel()?.name || "Select model"}
        >
          {currentModel()?.name || "Select model"}
        </span>
        <span class="text-[10px] text-muted-foreground flex-none">
          {isOpen() ? "▲" : "▼"}
        </span>
      </button>

      <Show when={isOpen()}>
        <div class="absolute bottom-[calc(100%+8px)] left-0 min-w-[320px] bg-surface-2 border border-surface-3 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] z-[1000] overflow-hidden">
          {/* Search input */}
          <div class="p-2 bg-surface-2 border-b border-surface-3">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search models"
              value={searchQuery()}
              class="w-full px-3 py-2 bg-surface-3 border border-surface-3 rounded-md text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-accent"
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  closeDropdown();
                }
              }}
            />
          </div>

          <div class="flex gap-0.5 p-2 bg-surface-3 border-b border-surface-3 flex-wrap">
            <For each={railProviders()}>
              {(providerId) => (
                <Show
                  when={
                    !(
                      providerId === "seren" &&
                      !allowsSerenPublicModels(authStore.privateChatPolicy)
                    ) &&
                    !(
                      providerId !== "seren" &&
                      providerId !== "seren-private" &&
                      authStore.privateChatPolicy
                        ?.disable_external_model_providers
                    )
                  }
                >
                  <button
                    type="button"
                    aria-pressed={providerId === currentProvider()}
                    class="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors no-underline border"
                    classList={{
                      "bg-primary text-primary-foreground border-primary font-medium":
                        providerId === currentProvider(),
                      "bg-transparent text-muted-foreground border-transparent hover:bg-border hover:text-foreground":
                        providerId !== currentProvider(),
                    }}
                    onClick={() => selectProvider(providerId)}
                    title={PROVIDER_CONFIGS[providerId].name}
                  >
                    <ProviderIcon provider={providerId} size={14} />
                    <span class="whitespace-nowrap">
                      {PROVIDER_CONFIGS[providerId].name}
                    </span>
                  </button>
                </Show>
              )}
            </For>
          </div>

          {/* External-agent rail: clicking switches the active thread to a
              native-agent provider. The cross-category machinery in
              switchChatProvider flips conversations.kind, moves the row
              between caches, and spawns the native session with the
              persisted bootstrap context. The thread's UI shell remounts
              from ChatContent to AgentChat in place. Models within the
              agent are picked from AgentChat's AgentModelSelector after
              spawn — the agent's runtime is the source of truth there. */}
          <Show
            when={
              !searchQuery() &&
              agentStore.availableAgents.some((a) => a.available)
            }
          >
            <div class="flex flex-wrap gap-0.5 p-2 bg-surface-3 border-b border-surface-3">
              <span class="w-full text-[10px] uppercase tracking-wider text-muted-foreground/80 font-medium pb-1">
                External agents
              </span>
              <For each={agentStore.availableAgents}>
                {(agent) => (
                  <Show when={agent.available}>
                    <button
                      type="button"
                      class="flex items-center gap-1 px-2.5 py-1.5 bg-transparent border border-transparent rounded text-xs text-muted-foreground cursor-pointer transition-all no-underline hover:bg-border hover:text-foreground"
                      onClick={() => selectAgentProvider(agent.type)}
                      title={`Switch to ${agentDisplayName(agent.type)} — opens an external agent session for this thread`}
                    >
                      <ProviderIcon provider={agent.type} size={14} />
                      <span class="max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {agentDisplayName(agent.type)}
                      </span>
                    </button>
                  </Show>
                )}
              </For>
            </div>
          </Show>

          {/* Models for selected provider */}
          <div class="max-h-[300px] overflow-y-auto py-1 bg-surface-2">
            {/* Auto option — only when not searching and only for public models */}
            <Show when={!isPrivateChat() && !searchQuery()}>
              <button
                type="button"
                class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border border-b border-b-surface-3 ${committedAutoModel() ? "bg-success/15" : ""}`}
                onClick={() => selectModel(AUTO_MODEL_ID)}
              >
                <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                  <span class="text-success font-medium">Auto</span>
                  <span class="text-[11px] text-muted-foreground">
                    Best model for each task
                  </span>
                </div>
                <Show when={committedAutoModel()}>
                  <span class="text-success text-sm font-semibold">
                    &#10003;
                  </span>
                </Show>
              </button>
            </Show>
            <Show
              when={filteredModels().length > 0}
              fallback={
                <div class="p-4 text-center text-muted-foreground text-[13px]">
                  {isLoadingModels()
                    ? "Loading models..."
                    : searchQuery()
                      ? `No models matching "${searchQuery()}"`
                      : isPrivateChat()
                        ? "No private models available"
                        : `No models available for ${PROVIDER_CONFIGS[currentProvider()].name}`}
                </div>
              }
            >
              <For each={filteredModels()}>
                {(model) => (
                  <button
                    type="button"
                    class={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-transparent border-none text-left text-[13px] cursor-pointer transition-colors hover:bg-border ${model.id === committedModel() ? "bg-primary/[0.12]" : ""}`}
                    onClick={() => selectModel(model.id)}
                  >
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-foreground font-medium">
                        {model.name}
                      </span>
                      <Show when={model.description}>
                        <span class="text-[11px] text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                          {model.description}
                        </span>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <Show when={model.id === committedModel()}>
                        <span class="text-success text-sm font-semibold">
                          &#10003;
                        </span>
                      </Show>
                      <Show when={model.contextWindow > 0}>
                        <span class="text-[11px] text-muted-foreground px-1.5 py-0.5 bg-surface-3 rounded whitespace-nowrap">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ModelSelector;
