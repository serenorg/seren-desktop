// ABOUTME: Tests claude-code full-turn history persistence to SQLite (#3247) —
// ABOUTME: tool calls, diffs, and every intermediate assistant block survive reload.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StoredMessage } from "@/lib/tauri-bridge";
import {
  type AgentMessage,
  reconstructStoredAgentMessage,
  serializeAgentMessageMetadata,
} from "@/stores/agent.store";
import type { DiffEvent, ToolCallEvent } from "@/services/providers";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("agent message persistence guards", () => {
  it("persistAgentMessage persists claude-code tool/diff blocks but drops them for other providers", () => {
    // #3247 supersedes the old "final assistant text only" intent for
    // claude-code: the full turn now persists. The guard must (a) still drop
    // non-prose blocks by default, (b) admit tool/diff, and (c) gate that on
    // claude-code so provider-replay agents (codex/gemini) are not duplicated
    // on every --resume.
    const fnStart = agentStoreSource.indexOf("function persistAgentMessage(");
    const fnBody = agentStoreSource.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain(
      'msg.type !== "user" &&\n    msg.type !== "assistant" &&\n    msg.type !== "handoff"',
    );
    expect(fnBody).toContain('if (sessionAgentType !== "claude-code") return;');
    expect(fnBody).toContain(
      'if (msg.type !== "tool" && msg.type !== "diff") return;',
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
    expect(caseBody).toContain(
      "recoveryReplay: event.data.recoveryReplay === true",
    );
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

  it("recovered provider sidecar chunks can repair missing SQLite history", () => {
    const handlerIdx = agentStoreSource.indexOf("\n  handleMessageChunk(");
    expect(handlerIdx).toBeGreaterThan(0);
    const handlerBody = agentStoreSource.slice(
      handlerIdx,
      agentStoreSource.indexOf("enqueueToolEvent(", handlerIdx),
    );

    expect(handlerBody).toContain("meta?.recoveryReplay === true");
    expect(handlerBody).toContain(
      "session.messages.some((message) => message.id === recoveryMessageId)",
    );
    expect(handlerBody).toContain(
      "if (session.skipHistoryReplay && !recoveryMessageId) return",
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

  it("handleToolCall seals each claude-code assistant block into its own row", () => {
    // Replay chunks are complete historical messages, so the replay-marked
    // flush still persists before the tool card interrupts it. Live claude-code
    // blocks were already checkpointed under assistantDraftMessageId by
    // persistStreamingAssistantDraft; the fix (#3247) is to RETIRE that draft
    // id at the tool boundary so the next block after the tool card lands in a
    // fresh row instead of overwriting this one — the reused draft id was what
    // collapsed a multi-block turn down to its final answer.
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

    // Replay flush still persists before the tool card.
    expect(flushBlock).toContain("session.streamingContentReplay === true");
    const persistIdx = flushBlock.indexOf("persistAgentMessage(");
    const replayGuardIdx = flushBlock.indexOf(
      "session.streamingContentReplay === true",
    );
    expect(persistIdx).toBeGreaterThan(replayGuardIdx);

    // The claude-code seal retires the draft id so blocks append, not overwrite.
    expect(flushBlock).toContain(
      'const sealsClaudeBlock = session.info.agentType === "claude-code"',
    );
    expect(flushBlock).toContain(
      'setState("sessions", sessionId, "assistantDraftMessageId", undefined)',
    );
    const sealIdx = flushBlock.indexOf(
      'setState("sessions", sessionId, "assistantDraftMessageId", undefined)',
    );
    expect(sealIdx).toBeGreaterThan(flushBlock.indexOf("if (sealsClaudeBlock)"));
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

describe("#2499 — agent thread transcript must fall back to durable history when no live session", () => {
  it("getMessagesForConversation falls back to the persistedMessages cache, not just live session.messages", () => {
    const fnIdx = agentStoreSource.indexOf(
      "getMessagesForConversation(conversationId: string): AgentMessage[]",
    );
    expect(fnIdx).toBeGreaterThan(0);
    const fnBody = agentStoreSource.slice(fnIdx, fnIdx + 600);
    // Live session wins when it owns the transcript...
    expect(fnBody).toContain("session.messages.length > 0");
    // ...otherwise the durable cache is the source so the panel is never blank.
    expect(fnBody).toContain("state.persistedMessages[conversationId]");
    // The old blank-prone implementation returned bare session messages.
    expect(fnBody).not.toMatch(/return\s+session\?\.messages\s*\?\?\s*\[\];/);
  });

  it("persistedMessages is part of agent store state and initialized", () => {
    expect(agentStoreSource).toContain(
      "persistedMessages: Record<string, AgentMessage[]>;",
    );
    expect(agentStoreSource).toContain("persistedMessages: {},");
  });

  it("hydratePersistedHistory loads from SQLite, respects live-session precedence, and re-reads fresh", () => {
    const fnIdx = agentStoreSource.indexOf(
      "async hydratePersistedHistory(conversationId: string)",
    );
    expect(fnIdx).toBeGreaterThan(0);
    const fnBody = agentStoreSource.slice(fnIdx, fnIdx + 900);
    // Reads the durable transcript from SQLite.
    expect(fnBody).toContain("loadPersistedAgentHistory(conversationId)");
    // Writes into the fallback cache.
    expect(fnBody).toContain('setState("persistedMessages", conversationId');
    // Does not clobber a live session that already owns the transcript
    // (guarded both before and after the awaited read).
    expect(fnBody).toContain("ownsTranscript");
  });

  it("AgentChat hydrates the durable transcript when the viewed thread has no live session", () => {
    expect(agentChatSource).toContain(
      "agentStore.hydratePersistedHistory(thread.id)",
    );
    // The hydrate must trigger only when there is no live transcript to show.
    const callIdx = agentChatSource.indexOf(
      "agentStore.hydratePersistedHistory(thread.id)",
    );
    const window = agentChatSource.slice(callIdx - 220, callIdx);
    expect(window).toContain("session.messages.length === 0");
  });
});

describe("#3247 — claude-code tool/diff blocks round-trip through SQLite", () => {
  const row = (
    over: Partial<StoredMessage> & Pick<StoredMessage, "role" | "content">,
  ): StoredMessage => ({
    id: "m1",
    conversation_id: "c1",
    model: null,
    timestamp: 1000,
    metadata: null,
    provider: "claude-code",
    ...over,
  });

  // Persist a produced AgentMessage exactly as persistAgentMessage would (role
  // "assistant" for anything non-user, metadata from serializeAgentMessageMetadata)
  // then reconstruct it — the real serialize→store→read path, no mocks.
  const persistThenReconstruct = (msg: AgentMessage): AgentMessage =>
    reconstructStoredAgentMessage(
      row({
        id: msg.id,
        role: msg.type === "user" ? "user" : "assistant",
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: serializeAgentMessageMetadata(msg),
        provider: msg.type === "user" ? null : (msg.provider ?? "claude-code"),
      }),
    );

  it("restores a tool call with its payload and toolCallId", () => {
    const toolCall: ToolCallEvent = {
      sessionId: "s1",
      toolCallId: "toolu_abc",
      title: "Read file src/main.rs",
      name: "Read",
      kind: "read",
      status: "completed",
      parameters: { path: "src/main.rs" },
      result: "fn main() {}",
    };
    const original: AgentMessage = {
      id: "t1",
      type: "tool",
      content: toolCall.title,
      timestamp: 1234,
      toolCallId: toolCall.toolCallId,
      toolCall,
    };

    const restored = persistThenReconstruct(original);
    expect(restored.type).toBe("tool");
    expect(restored.toolCallId).toBe("toolu_abc");
    expect(restored.toolCall).toEqual(toolCall);
    expect(restored.content).toBe("Read file src/main.rs");
    expect(restored.provider).toBe("claude-code");
  });

  it("restores a diff block with its path and text", () => {
    const diff: DiffEvent = {
      sessionId: "s1",
      toolCallId: "toolu_edit",
      path: "src/lib.rs",
      oldText: "let x = 1;",
      newText: "let x = 2;",
    };
    const original: AgentMessage = {
      id: "d1",
      type: "diff",
      content: "Modified: src/lib.rs",
      timestamp: 1235,
      toolCallId: diff.toolCallId,
      diff,
    };

    const restored = persistThenReconstruct(original);
    expect(restored.type).toBe("diff");
    expect(restored.toolCallId).toBe("toolu_edit");
    expect(restored.diff).toEqual(diff);
    expect(restored.content).toBe("Modified: src/lib.rs");
  });

  it("keeps assistant, handoff, and user rows classified correctly", () => {
    const handoff = persistThenReconstruct({
      id: "h1",
      type: "handoff",
      content: "Claude → Codex",
      timestamp: 2,
      provider: "seren",
    });
    expect(handoff.type).toBe("handoff");

    expect(
      reconstructStoredAgentMessage(row({ role: "user", content: "hi" })).type,
    ).toBe("user");
    // A bare assistant row (no metadata) must not be misread as a tool/diff.
    const bare = reconstructStoredAgentMessage(
      row({ role: "assistant", content: "ok" }),
    );
    expect(bare.type).toBe("assistant");
    expect(bare.toolCall).toBeUndefined();
    expect(bare.diff).toBeUndefined();
    // An assistant row carrying final_output_validation metadata stays assistant.
    expect(
      reconstructStoredAgentMessage(
        row({
          role: "assistant",
          content: "answer",
          metadata: JSON.stringify({
            v: 1,
            final_output_validation: {
              displayText: "answer",
              safeDisplayText: "answer",
            },
          }),
        }),
      ).type,
    ).toBe("assistant");
  });

  it("serializes tool/diff payloads into block metadata, prose stays null", () => {
    const toolMeta = serializeAgentMessageMetadata({
      id: "t",
      type: "tool",
      content: "x",
      timestamp: 0,
      toolCall: {
        sessionId: "s",
        toolCallId: "tc",
        title: "x",
        kind: "read",
        status: "completed",
      },
    });
    expect(JSON.parse(toolMeta as string).block_type).toBe("tool");

    const plainAssistant = serializeAgentMessageMetadata({
      id: "a",
      type: "assistant",
      content: "hi",
      timestamp: 0,
    });
    expect(plainAssistant).toBeNull();
  });
});

describe("#3247 — loadPersistedAgentHistory wiring", () => {
  it("reconstructs blocks, reads the full cap, and keeps tool payloads out of the bootstrap context", () => {
    const fnIdx = agentStoreSource.indexOf(
      "async function loadPersistedAgentHistory(",
    );
    expect(fnIdx).toBeGreaterThan(0);
    const fnBody = agentStoreSource.slice(fnIdx, fnIdx + 1600);
    // Uses the shared reconstruction helper for the UI messages.
    expect(fnBody).toContain("stored.map(reconstructStoredAgentMessage)");
    // Restores the full stored transcript, not the old 200-row window.
    expect(fnBody).toContain("AGENT_HISTORY_READ_LIMIT");
    // Bootstrap context is prose-only — tool/diff rows are filtered out.
    expect(fnBody).toContain(
      "parsePersistedBlockMetadata(m.metadata)?.block_type === undefined",
    );
  });
});
