// ABOUTME: Source-level wiring checks for #1911 thinking markup normalization.
// ABOUTME: Keeps the pure parser test connected to the agent store and renderer.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("#1911 — Claude <think> markup is routed to ThinkingBlock", () => {
  it("agent.store.ts routes raw content chunks through the streaming thinking parser", () => {
    expect(agentStoreSource).toContain(
      'from "@/lib/agent-thinking-markup"',
    );

    const flushStart = agentStoreSource.indexOf(
      "function flushChunkBuf(sessionId: string)",
    );
    expect(flushStart, "flushChunkBuf must exist").toBeGreaterThan(0);
    const flushSlice = agentStoreSource.slice(flushStart, flushStart + 1400);
    const appendStart = agentStoreSource.indexOf(
      "function appendThinkingMarkupParts(",
    );
    expect(appendStart, "appendThinkingMarkupParts must exist").toBeGreaterThan(
      0,
    );
    const appendSlice = agentStoreSource.slice(appendStart, appendStart + 1600);

    expect(flushSlice).toContain("consumeAgentThinkingMarkupChunk(");
    expect(appendSlice).toContain('"streamingContent"');
    expect(appendSlice).toContain('"streamingThinking"');
  });

  it("finalization drains pending partial <think> markup before constructing messages", () => {
    const fnStart = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    expect(fnStart, "finalizeStreamingContent must exist").toBeGreaterThan(0);
    const fnSlice = agentStoreSource.slice(fnStart, fnStart + 1200);

    expect(fnSlice).toContain("flushChunkBuf(sessionId)");
    expect(fnSlice).toContain("flushThinkingMarkupStreamState(sessionId)");
  });

  it("AgentChat renders legacy persisted <think> markup as a ThinkingBlock fallback", () => {
    expect(agentChatSource).toContain("extractAgentThinkingMarkup");

    const assistantStart = agentChatSource.indexOf('case "assistant":');
    expect(assistantStart, "assistant render branch must exist").toBeGreaterThan(
      0,
    );
    const assistantSlice = agentChatSource.slice(
      assistantStart,
      agentChatSource.indexOf('case "thought":', assistantStart),
    );

    expect(assistantSlice).toContain("<ThinkingBlock");
    expect(assistantSlice).not.toContain("markdown: msg.content");
  });
});
