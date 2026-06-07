// ABOUTME: Static guardrails for per-thread provider provenance.
// ABOUTME: Pins the live paths that are hard to exercise without the full UI.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const chatContentSource = readSource("src/components/chat/ChatContent.tsx");
const orchestratorSource = readSource("src/services/orchestrator.ts");

function sourceBetween(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("thread provider runtime contract", () => {
  it("gates chat sends using the thread binding, not the global picker", () => {
    expect(chatContentSource).toContain("const activeThreadProvider = ");
    expect(chatContentSource).toContain("selectedProvider === \"seren-private\"");

    const sendHandler = sourceBetween(
      chatContentSource,
      "const sendMessage = async",
      "// If currently streaming, queue the message instead",
    );
    expect(sendHandler).toContain("const provider = activeThreadProvider()");
    expect(sendHandler).not.toContain("providerStore.activeProvider ===");
  });

  it("persists live orchestrator assistant rows with provider and model provenance", () => {
    expect(orchestratorSource).toContain("provider?: ProviderId");
    expect(orchestratorSource).toContain("modelId?: string | null");

    const handleComplete = sourceBetween(
      orchestratorSource,
      "function handleComplete(",
      "// Extract structured memories from the transcript after the answer lands.",
    );
    expect(handleComplete).toContain("provider: stream.provider");
    expect(handleComplete).toContain("modelId: stream.modelId ?? undefined");

    const flushStreaming = sourceBetween(
      orchestratorSource,
      "function flushStreamingToMessage(",
      "/**\n * Build the capabilities object",
    );
    expect(flushStreaming).toContain("provider: stream.provider");
    expect(flushStreaming).toContain("modelId: stream.modelId ?? undefined");
  });
});
