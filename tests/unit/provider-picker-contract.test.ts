// ABOUTME: Static contract tests for the thread provider/model pickers.
// ABOUTME: Pins the browse-vs-commit split that is hard to exercise without UI.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const modelSelectorSource = readSource("src/components/chat/ModelSelector.tsx");
const providerStoreSource = readSource("src/stores/provider.store.ts");
const serenProviderSource = readSource("src/lib/providers/seren.ts");
const threadProviderSwitcherSource = readSource("src/components/chat/ThreadProviderSwitcher.tsx");
const chatContentSource = readSource("src/components/chat/ChatContent.tsx");

function sourceBetween(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("provider picker switch contract", () => {
  it("hydrates the empty Seren picker from the live curated catalog", () => {
    const catalogLoading = sourceBetween(
      modelSelectorSource,
      "// Load full model list from the Seren catalog or private models catalog.",
      "// Filter models: show the live list when no search, filter it when typing",
    );

    expect(catalogLoading).toContain("getLiveSerenModelCatalog()");
    expect(catalogLoading).toContain(
      'providerStore.setProviderModels("seren", models)',
    );
    // A transient discovery failure must not wipe models already hydrated
    // from the live catalog; the empty startup default alone keeps retired
    // static ids out of the picker. #3614
    expect(catalogLoading).not.toContain(
      'providerStore.setProviderModels("seren", [])',
    );
    // Search filters the same live catalog — no second, broader discovery
    // list may reintroduce IDs the publisher cannot route. #3683
    expect(catalogLoading).not.toContain("modelsService.getAvailable()");
    expect(providerStoreSource).toMatch(/seren:\s*\[\]/);
    expect(serenProviderSource).not.toContain("const DEFAULT_MODELS");
    expect(serenProviderSource).toContain("return fetchSerenModelCatalog()");
  });

  it("keeps ModelSelector provider chips as draft filters until a model commits", () => {
    const selectProvider = sourceBetween(
      modelSelectorSource,
      "const selectProvider = (providerId: ProviderId) => {",
      "/**\n   * Switch the active thread INTO a native-agent provider",
    );
    expect(selectProvider).toContain("setDraftProvider(providerId)");
    expect(selectProvider).not.toContain("providerStore.setActiveProvider");

    const selectModel = sourceBetween(
      modelSelectorSource,
      "const selectModel = (modelId: string) => {",
      "/**\n   * Toggle which provider's models are visible",
    );
    expect(selectModel).toContain("const targetProvider = currentProvider()");
    expect(selectModel).toContain("const conversationId = activeThreadId()");
    expect(selectModel).toContain(
      "switchChatProvider(conversationId, targetProvider, modelId)",
    );
  });

  it("scopes ModelSelector selection state to the owning pane thread", () => {
    expect(chatContentSource).toContain(
      "<ModelSelector threadId={conversationId()} />",
    );
    expect(modelSelectorSource).toContain(
      "export const ModelSelector: Component<ModelSelectorProps>",
    );
    expect(modelSelectorSource).toContain("props.threadId ??");
    expect(modelSelectorSource).toContain("const activeConversation = ()");
    expect(modelSelectorSource).not.toContain(
      "const conversationId = conversationStore.activeConversationId;",
    );
  });

  it("does not drive private-model selection from a global chat model", () => {
    expect(modelSelectorSource).toContain("const committedModel = () =>");
    expect(modelSelectorSource).toContain("activeConversation()?.selectedModel");
    expect(modelSelectorSource).not.toContain(
      "const current = untrack(() => chatStore.selectedModel?.trim())",
    );
    expect(modelSelectorSource).not.toContain(
      "? model.id === chatStore.selectedModel",
    );
  });

  it("lets the agent-side switcher resolve seren-private models before committing", () => {
    const selectChatProvider = sourceBetween(
      threadProviderSwitcherSource,
      "const selectChatProvider = async (providerId: ProviderId) => {",
      "const selectAgent = (agentType: AgentType) => {",
    );
    expect(selectChatProvider).toContain('providerId === "seren-private"');
    expect(selectChatProvider).toContain(
      "privateModelsService.listAvailable()",
    );
    // The Seren branch must hydrate the runtime-owned catalog the same way —
    // agent threads mount no ModelSelector, so nothing else populates it and
    // the sync store read refused every cold switch. #3614
    expect(selectChatProvider).toContain('providerId === "seren"');
    expect(selectChatProvider).toContain("getLiveSerenModelCatalog()");
    expect(selectChatProvider).toContain(
      "switchChatProvider(props.threadId, providerId, fallbackModel)",
    );
  });
});
