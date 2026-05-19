// ABOUTME: Source-string wiring assertions for #1807 — the scrubber must run
// ABOUTME: before validation, assistant-message construction, and memory.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1807 — scrubAgentMarkup is wired into agent.store.ts", () => {
  it("agent.store.ts imports scrubAgentMarkup", () => {
    expect(agentStoreSource).toContain(
      'import { scrubAgentMarkup } from "@/lib/scrub-agent-markup"',
    );
  });

  it("finalizeStreamingContent scrubs streamingContent before validation and assistant persistence", () => {
    const fnStart = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    expect(fnStart, "finalizeStreamingContent must exist").toBeGreaterThan(0);
    const fnSlice = agentStoreSource.slice(fnStart, fnStart + 6000);
    expect(fnSlice).toContain("scrubAgentMarkup(session.streamingContent)");
    expect(fnSlice.indexOf("scrubAgentMarkup(session.streamingContent)")).toBeLessThan(
      fnSlice.indexOf("validateFinalOutput({"),
    );
    expect(fnSlice).toContain("finalText: scrubbed,");
    expect(fnSlice).toContain(
      "const safeContent = finalOutputValidation.safeDisplayText;",
    );
    // The persisted message must be built from validated scrubbed text.
    const messageBlock = fnSlice.slice(
      fnSlice.indexOf("const message: AgentMessage = {"),
      fnSlice.indexOf("setState(\"sessions\", sessionId, \"messages\", (msgs) => [...msgs, message]);"),
    );
    expect(messageBlock).toContain("content: safeContent,");
    expect(messageBlock).not.toContain("content: session.streamingContent,");
  });

  it("finalizeStreamingContent drops the message when scrubbed content is empty", () => {
    const fnStart = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    const fnSlice = agentStoreSource.slice(fnStart, fnStart + 6000);
    // An early-return on length===0 prevents an empty bubble from rendering
    // and keeps Seren memory from receiving a blank assistant turn.
    expect(fnSlice).toMatch(/scrubbed\.length\s*===\s*0/);
  });

  it("storeAssistantResponse is called with validated scrubbed content, not raw streamingContent", () => {
    const fnStart = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    const fnSlice = agentStoreSource.slice(fnStart, fnStart + 6000);
    const memoryCallStart = fnSlice.indexOf("storeAssistantResponse(");
    expect(memoryCallStart).toBeGreaterThan(0);
    const memoryCall = fnSlice.slice(memoryCallStart, memoryCallStart + 200);
    expect(memoryCall).toContain("storeAssistantResponse(safeContent,");
    expect(memoryCall).not.toContain("session.streamingContent");
    expect(fnSlice).toContain("finalOutputValidation.canStoreMemory");
  });

  it("handleToolCall intermediate flush scrubs streamingContent before constructing the visible message", () => {
    const fnStart = agentStoreSource.indexOf(
      "handleToolCall(sessionId: string, toolCall:",
    );
    expect(fnStart, "handleToolCall must exist").toBeGreaterThan(0);
    const fnSlice = agentStoreSource.slice(
      fnStart,
      agentStoreSource.indexOf("handleToolResult(", fnStart),
    );
    expect(fnSlice).toContain("scrubAgentMarkup(session.streamingContent)");
    // The intermediate contentMsg must be built from the scrubbed value too,
    // and skipped entirely when scrubbing leaves nothing.
    expect(fnSlice).toContain("content: scrubbed,");
  });
});
