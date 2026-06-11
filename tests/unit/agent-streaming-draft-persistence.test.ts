// ABOUTME: Regression tests for #2333 — visible streamed assistant text must survive reload.
// ABOUTME: Pins the agent-store contract that checkpoints live assistant chunks before promptComplete.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

const agentStoreSource = readSource("src/stores/agent.store.ts");

describe("#2333 — live assistant stream drafts are recoverable after reload", () => {
  it("flushChunkBuf checkpoints visible live assistant text to SQLite", () => {
    const flushIdx = agentStoreSource.indexOf(
      "function flushChunkBuf(sessionId: string)",
    );
    expect(flushIdx).toBeGreaterThan(0);
    const flushBody = agentStoreSource.slice(flushIdx, flushIdx + 1400);

    expect(flushBody).toContain("persistStreamingAssistantDraft(sessionId)");
    expect(flushBody).toContain("consumeAgentThinkingMarkupChunk(");

    const checkpointIdx = flushBody.indexOf(
      "persistStreamingAssistantDraft(sessionId)",
    );
    const visibleAppendIdx = flushBody.indexOf(
      "consumeAgentThinkingMarkupChunk(",
    );
    expect(checkpointIdx).toBeGreaterThan(visibleAppendIdx);
  });

  it("draft persistence skips replay/primer text and reuses the final assistant message id", () => {
    const helperIdx = agentStoreSource.indexOf(
      "function persistStreamingAssistantDraft(",
    );
    expect(helperIdx).toBeGreaterThan(0);
    const helperBody = agentStoreSource.slice(helperIdx, helperIdx + 2200);

    expect(helperBody).toContain("session.streamingContentReplay === true");
    expect(helperBody).toContain("isGeneratedPromptPrimer(draftContent)");
    expect(helperBody).toContain("session.assistantDraftMessageId");
    expect(helperBody).toContain('type: "assistant"');
    expect(helperBody).toContain("persistAgentMessage(");

    const finalizeIdx = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    expect(finalizeIdx).toBeGreaterThan(0);
    const finalizeBody = agentStoreSource.slice(finalizeIdx, finalizeIdx + 4200);
    expect(finalizeBody).toMatch(
      /id:\s*session\.assistantDraftMessageId\s*\?\?\s*session\.streamingContentMessageId\s*\?\?\s*crypto\.randomUUID\(\)/,
    );
  });

  it("serializes draft and final saves for the same assistant message id", () => {
    expect(agentStoreSource).toContain(
      "const messagePersistQueues = new Map<string, Promise<void>>()",
    );

    const persistIdx = agentStoreSource.indexOf(
      "function persistAgentMessage(",
    );
    expect(persistIdx).toBeGreaterThan(0);
    const persistBody = agentStoreSource.slice(persistIdx, persistIdx + 2600);

    expect(persistBody).toContain('const queueKey = `${conversationId}:${msg.id}`');
    expect(persistBody).toContain("messagePersistQueues.get(queueKey)");
    expect(persistBody).toContain(".catch(() => undefined)");
    expect(persistBody).toContain(".then(() =>");
    expect(persistBody).toContain("messagePersistQueues.set(queueKey, next)");
  });
});
