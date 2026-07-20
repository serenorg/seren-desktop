// ABOUTME: Pins the producer-boundary detection that drives the transcript's
// ABOUTME: provider/model badge between consecutive assistant messages.

import { describe, expect, it } from "vitest";
import {
  computeProviderBoundaries,
  providerDisplayName,
} from "@/lib/provider-boundaries";
import type { UnifiedMessage } from "@/types/conversation";

function assistant(
  id: string,
  provider: string | null,
  modelId: string | null,
): UnifiedMessage {
  return {
    id,
    type: "assistant",
    role: "assistant",
    content: "hi",
    timestamp: Number(id),
    status: "complete",
    workerType: "chat_model",
    modelId: modelId ?? undefined,
    provider: provider ?? undefined,
  };
}

function user(id: string): UnifiedMessage {
  return {
    id,
    type: "user",
    role: "user",
    content: "msg",
    timestamp: Number(id),
    status: "complete",
    workerType: "chat_model",
  };
}

function assistantToolRow(id: string): UnifiedMessage {
  return {
    id,
    type: "tool_call",
    role: "assistant",
    content: "tool",
    timestamp: Number(id),
    status: "complete",
    workerType: "chat_model",
  };
}

describe("providerDisplayName", () => {
  it("renders chat-provider ids with their PROVIDER_CONFIGS name", () => {
    expect(providerDisplayName("seren")).toBe("Seren Models");
    expect(providerDisplayName("seren-private")).toBe("Seren Private Models");
    expect(providerDisplayName("anthropic")).toBe("Anthropic");
    expect(providerDisplayName("openai")).toBe("OpenAI");
  });

  it("renders external agent types with friendly labels", () => {
    expect(providerDisplayName("claude-code")).toBe("Claude Code");
    expect(providerDisplayName("codex")).toBe("Codex");
    expect(providerDisplayName("gemini")).toBe("Gemini");
    expect(providerDisplayName("grok")).toBe("Grok");
    expect(providerDisplayName("lmstudio")).toBe("LM Studio");
  });

  it("falls back to a title-cased label for unknown ids", () => {
    expect(providerDisplayName("future_provider")).toBe("Future Provider");
    expect(providerDisplayName("future-provider")).toBe("Future Provider");
  });

  it("trims empty segments from malformed separator runs", () => {
    expect(providerDisplayName("-future-provider")).toBe("Future Provider");
    expect(providerDisplayName("future-provider-")).toBe("Future Provider");
    expect(providerDisplayName("future--provider")).toBe("Future Provider");
    expect(providerDisplayName("__foo")).toBe("Foo");
  });

  it("returns Unknown when the id has no usable segments", () => {
    expect(providerDisplayName("---")).toBe("Unknown");
  });

  it("handles null/undefined input without throwing", () => {
    expect(providerDisplayName(null)).toBe("Unknown");
    expect(providerDisplayName(undefined)).toBe("Unknown");
  });
});

describe("computeProviderBoundaries", () => {
  it("returns no boundaries for a single-provider thread", () => {
    const messages = [
      user("1"),
      assistant("2", "seren", "model-a"),
      user("3"),
      assistant("4", "seren", "model-a"),
    ];
    expect(computeProviderBoundaries(messages).size).toBe(0);
  });

  it("does not emit a boundary on the very first assistant message", () => {
    const messages = [user("1"), assistant("2", "seren", "model-a")];
    const map = computeProviderBoundaries(messages);
    expect(map.has("2")).toBe(false);
  });

  it("emits a boundary keyed by the message that follows a provider change", () => {
    const messages = [
      user("1"),
      assistant("2", "seren", "model-a"),
      user("3"),
      assistant("4", "seren-private", "model-b"),
    ];
    const map = computeProviderBoundaries(messages);
    expect(map.get("4")).toEqual({
      fromProvider: "seren",
      fromModel: "model-a",
      toProvider: "seren-private",
      toModel: "model-b",
    });
  });

  it("emits a boundary when the model changes but the provider does not", () => {
    const messages = [
      assistant("1", "seren", "model-a"),
      assistant("2", "seren", "model-b"),
    ];
    const map = computeProviderBoundaries(messages);
    expect(map.get("2")?.fromModel).toBe("model-a");
    expect(map.get("2")?.toModel).toBe("model-b");
    expect(map.get("2")?.fromProvider).toBe("seren");
    expect(map.get("2")?.toProvider).toBe("seren");
  });

  it("ignores user/tool/system rows when chaining producer history", () => {
    // A user message between two same-provider assistants must NOT
    // produce a phantom boundary — only assistant-to-assistant
    // transitions count.
    const messages = [
      assistant("1", "seren", "model-a"),
      user("2"),
      assistantToolRow("3"),
      user("4"),
      assistant("5", "seren", "model-a"),
    ];
    expect(computeProviderBoundaries(messages).size).toBe(0);
  });

  it("does not let assistant-role tool rows reset the previous producer", () => {
    const messages = [
      assistant("1", "seren", "model-a"),
      assistantToolRow("2"),
      user("3"),
      assistant("4", "seren", "model-a"),
    ];
    expect(computeProviderBoundaries(messages).size).toBe(0);
  });

  it("treats a missing provider as null so missing→known is a boundary", () => {
    // Legacy assistant rows persisted before Phase 1 may have null
    // provider. A subsequent run on a known provider should still show
    // the badge so users see the historical transition surface.
    const messages = [
      assistant("1", null, "legacy-model"),
      assistant("2", "seren", "model-a"),
    ];
    const map = computeProviderBoundaries(messages);
    expect(map.get("2")?.fromProvider).toBeNull();
    expect(map.get("2")?.toProvider).toBe("seren");
  });

  it("records every boundary along a multi-switch transcript", () => {
    const messages = [
      assistant("1", "seren", "m1"),
      assistant("2", "seren-private", "m2"),
      assistant("3", "claude-code", "m3"),
      assistant("4", "claude-code", "m3"),
      assistant("5", "seren", "m1"),
    ];
    const map = computeProviderBoundaries(messages);
    expect(Array.from(map.keys()).sort()).toEqual(["2", "3", "5"]);
    expect(map.get("3")?.fromProvider).toBe("seren-private");
    expect(map.get("3")?.toProvider).toBe("claude-code");
    expect(map.get("5")?.fromProvider).toBe("claude-code");
    expect(map.get("5")?.toProvider).toBe("seren");
  });
});
