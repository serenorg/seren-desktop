// ABOUTME: Static contract tests for the thread provider/model pickers.
// ABOUTME: Pins the browse-vs-commit split that is hard to exercise without UI.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modelSelectorSource = readFileSync(
  resolve("src/components/chat/ModelSelector.tsx"),
  "utf-8",
);
const threadProviderSwitcherSource = readFileSync(
  resolve("src/components/chat/ThreadProviderSwitcher.tsx"),
  "utf-8",
);

function sourceBetween(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("provider picker switch contract", () => {
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
    expect(selectModel).toContain(
      "switchChatProvider(conversationId, targetProvider, modelId)",
    );
  });

  it("does not drive private-model selection from chatStore.selectedModel", () => {
    expect(modelSelectorSource).toContain("const committedModel = () =>");
    expect(modelSelectorSource).toContain(
      "conversationStore.activeConversation?.selectedModel",
    );
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
    expect(selectChatProvider).toContain(
      "switchChatProvider(props.threadId, providerId, fallbackModel)",
    );
  });
});
