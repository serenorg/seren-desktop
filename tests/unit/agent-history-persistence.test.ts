// ABOUTME: Tests that only finalized assistant messages are persisted to SQLite.
// ABOUTME: Prevents regression where intermediate tool-call flushes pollute restored history.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("agent message persistence guards", () => {
  it("persistAgentMessage only stores user, assistant, and handoff types", () => {
    const fnStart = agentStoreSource.indexOf(
      "function persistAgentMessage(",
    );
    const fnBody = agentStoreSource.slice(fnStart, fnStart + 700);
    expect(fnBody).toContain(
      'if (msg.type !== "user" && msg.type !== "assistant" && msg.type !== "handoff")',
    );
  });

  it("persistAgentMessage takes an explicit session agent type, not a state lookup", () => {
    // Walking `state.sessions` to discover a session's agent type from a
    // bare conversationId is racy when two sessions briefly coexist on
    // one thread (e.g. compaction-driven session swaps). The function
    // must accept the producer agent type as an argument so callers pass
    // their own `session.info.agentType` and there is no ambiguity.
    const fnStart = agentStoreSource.indexOf(
      "function persistAgentMessage(",
    );
    const fnEnd = agentStoreSource.indexOf(
      "\n}\n",
      agentStoreSource.indexOf("saveMessage(", fnStart),
    );
    const fnSource = agentStoreSource.slice(fnStart, fnEnd);

    expect(fnSource).toMatch(/sessionAgentType:\s*string\s*\|\s*null/);
    expect(fnSource).not.toContain("for (const session of Object.values");
    expect(fnSource).not.toContain(
      "session.conversationId === conversationId",
    );
  });

  it("every persistAgentMessage call site passes a producer agent type", () => {
    // Each call must include an `agentType` value within the call so the
    // refactor that removed the in-function `state.sessions` walk cannot
    // be partially reintroduced by adding a new call site that omits the
    // producer arg.
    const matches = Array.from(
      agentStoreSource.matchAll(/persistAgentMessage\(/g),
    );
    const defOffset = agentStoreSource.indexOf("function persistAgentMessage(");
    const callOffsets = matches
      .map((m) => m.index ?? -1)
      .filter((idx) => idx !== defOffset && idx >= 0);

    expect(callOffsets.length).toBeGreaterThan(0);
    for (const offset of callOffsets) {
      const callWindow = agentStoreSource.slice(offset, offset + 300);
      // Paired-workflow transcript events (setup declaration, handoffs) are
      // produced by Seren itself, so a literal "seren" producer satisfies
      // the explicit-producer rule (#2368).
      expect(
        /agentType|AgentType|"seren"/.test(callWindow),
        `call at offset ${offset} does not pass an agent type within 300 chars: ${callWindow.slice(0, 120)}…`,
      ).toBe(true);
    }
  });

  it("messageChunk forwards replay identity into handleMessageChunk", () => {
    const caseIdx = agentStoreSource.indexOf('case "messageChunk"');
    expect(caseIdx).toBeGreaterThan(0);
    const caseBody = agentStoreSource.slice(
      caseIdx,
      agentStoreSource.indexOf('case "toolCall"', caseIdx),
    );

    expect(caseBody).toContain("replay: event.data.replay === true");
    expect(caseBody).toContain("messageId: event.data.messageId");
  });

  it("handleMessageChunk uses replay message ids as assistant boundaries", () => {
    const handlerIdx = agentStoreSource.indexOf("\n  handleMessageChunk(");
    expect(handlerIdx).toBeGreaterThan(0);
    const handlerBody = agentStoreSource.slice(
      handlerIdx,
      agentStoreSource.indexOf("enqueueToolEvent(", handlerIdx),
    );

    expect(handlerBody).toContain("streamingContentMessageId");
    expect(handlerBody).toContain(
      "this.finalizeStreamingContent(sessionId, { isReplay: true })",
    );
  });

  it("replayed user and assistant messages reuse provider ids for SQLite upsert", () => {
    const userHandlerIdx = agentStoreSource.indexOf(
      "flushPendingUserMessage(sessionId: string)",
    );
    expect(userHandlerIdx).toBeGreaterThan(0);
    const userHandlerBody = agentStoreSource.slice(
      userHandlerIdx,
      agentStoreSource.indexOf("appendReplayUserChunk(", userHandlerIdx),
    );
    expect(userHandlerBody).toContain(
      "id: session.pendingUserMessageId ?? crypto.randomUUID()",
    );

    const finalizeIdx = agentStoreSource.indexOf(
      "finalizeStreamingContent(sessionId: string",
    );
    expect(finalizeIdx).toBeGreaterThan(0);
    const finalizeBody = agentStoreSource.slice(
      finalizeIdx,
      agentStoreSource.indexOf("async forkConversation(", finalizeIdx),
    );
    expect(finalizeBody).toMatch(
      /id:\s*session\.assistantDraftMessageId\s*\?\?\s*session\.streamingContentMessageId\s*\?\?\s*crypto\.randomUUID\(\)/,
    );
  });

  it("handleToolCall persists only replayed intermediate assistant flushes", () => {
    // Live handleToolCall still flushes streamingContent into the UI for
    // ordering without persisting partial text. History replay chunks are
    // different: they are complete historical assistant messages, so the
    // replay-marked flush must persist before the tool card interrupts it.
    const toolCallHandler = agentStoreSource.slice(
      agentStoreSource.indexOf("handleToolCall(sessionId: string, toolCall:"),
    );
    const handlerBody = toolCallHandler.slice(
      0,
      toolCallHandler.indexOf("handleToolResult("),
    );

    // Find the streaming content flush block within handleToolCall
    const flushBlock = handlerBody.slice(
      handlerBody.indexOf("if (session.streamingContent)"),
      handlerBody.indexOf("// Skip duplicate if a message"),
    );
    expect(flushBlock.length).toBeGreaterThan(0);

    expect(flushBlock).toContain("session.streamingContentReplay === true");
    const persistIdx = flushBlock.indexOf("persistAgentMessage(");
    const replayGuardIdx = flushBlock.indexOf(
      "session.streamingContentReplay === true",
    );
    expect(persistIdx).toBeGreaterThan(replayGuardIdx);
  });

  it("Codex resume lets provider replay repair partial SQLite history", () => {
    const resumeIdx = agentStoreSource.indexOf("async resumeAgentConversation");
    expect(resumeIdx).toBeGreaterThan(0);
    const resumeBody = agentStoreSource.slice(
      resumeIdx,
      agentStoreSource.indexOf("async resumeRemoteSession(", resumeIdx),
    );

    expect(resumeBody).toContain("const restoredMessagesForSpawn =");
    expect(resumeBody).toContain(
      'agentType === "codex" && effectiveResumeId ? [] : restoredMessages',
    );
    expect(resumeBody).toContain("restoredMessages: restoredMessagesForSpawn");
  });

  it("finalizeStreamingContent DOES persist assistant messages", () => {
    const finalizeHandler = agentStoreSource.slice(
      agentStoreSource.indexOf("finalizeStreamingContent(sessionId: string"),
    );
    const finalizeBody = finalizeHandler.slice(
      0,
      finalizeHandler.indexOf("handleToolCall(") > 0
        ? finalizeHandler.indexOf("handleToolCall(")
        : 2000,
    );

    // finalizeStreamingContent should persist — this is the real finalization
    expect(finalizeBody).toContain("persistAgentMessage(");
  });
});

describe("#1663 — agent thread history must not be wiped on resume or send", () => {
  it("clearLegacyAgentTranscript no longer exists — the function that wiped history every send and every resume is gone", () => {
    // Match the function definition itself, not historical NOTE comments.
    expect(agentStoreSource).not.toContain(
      "function clearLegacyAgentTranscript",
    );
  });

  it("resumeAgentConversation does not invoke any clear-history call on successful resume (#1663)", () => {
    const fnIdx = agentStoreSource.indexOf("async resumeAgentConversation");
    expect(fnIdx).toBeGreaterThan(0);
    const nextFn = agentStoreSource.indexOf("\n  async ", fnIdx + 30);
    const slice = agentStoreSource.slice(
      fnIdx,
      nextFn > fnIdx ? nextFn : fnIdx + 12000,
    );
    // Strip line comments so historical NOTEs documenting the fix don't
    // count as live calls.
    const code = slice.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/clearLegacyAgentTranscript\s*\(/);
  });

  it("clearBootstrapPromptContext does not invoke any clear-history call (#1663)", () => {
    const fnIdx = agentStoreSource.indexOf(
      "clearBootstrapPromptContext(sessionId",
    );
    expect(fnIdx).toBeGreaterThan(0);
    const slice = agentStoreSource.slice(fnIdx, fnIdx + 1200);
    const code = slice.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/clearLegacyAgentTranscript\s*\(/);
    expect(code).not.toMatch(/clearConversationHistory\s*\(/);
  });

  it("clearSessionMessages still clears persisted history — the user-initiated 'Clear messages' button must keep working", () => {
    const fnIdx = agentStoreSource.indexOf("clearSessionMessages(sessionId");
    expect(fnIdx).toBeGreaterThan(0);
    const slice = agentStoreSource.slice(fnIdx, fnIdx + 800);
    expect(slice).toContain(
      "clearConversationHistory(session.conversationId)",
    );
  });
});
