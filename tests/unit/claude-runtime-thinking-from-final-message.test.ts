// ABOUTME: Critical regression for #1935 — final-message thinking blocks must
// ABOUTME: reach the UI when only text_delta partials streamed in the same turn.

import { describe, expect, it, vi } from "vitest";

const runtimeUrl = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const mod = await import(/* @vite-ignore */ runtimeUrl);

const handleAssistantMessage = mod._handleAssistantMessage as (
  emit: (channel: string, payload: Record<string, unknown>) => void,
  session: Record<string, unknown>,
  payload: Record<string, unknown>,
) => void;
const handleStreamEvent = mod._handleStreamEvent as (
  emit: (channel: string, payload: Record<string, unknown>) => void,
  session: Record<string, unknown>,
  payload: Record<string, unknown>,
) => void;

function makeSession(): Record<string, unknown> {
  return {
    id: "session-1",
    agentSessionId: "agent-1",
    currentPrompt: { resolve: () => {}, reject: () => {} },
    currentPromptHasStreamedText: false,
    currentPromptHasStreamedThinking: false,
    currentPromptHasChunks: false,
    currentModelId: "claude-opus-4-7[1m]",
    availableModelRecords: [],
    peakInputTokens: 0,
  };
}

describe("#1935 thinking-block emission from final assistant message", () => {
  it("emits thinking-block when only text_delta streamed (Opus 4.7 with --effort medium)", () => {
    // Reproduces the production failure: Claude Code's stream-json reliably
    // emits text_delta partials but does NOT emit thinking_delta partials for
    // Opus 4.7. The pre-fix single-flag guard suppressed BOTH text and
    // thinking blocks from the final aggregated assistant message once any
    // streamed chunk arrived — silently dropping the only carrier of
    // reasoning content. Post-fix, text and thinking suppression are tracked
    // independently.
    const session = makeSession();
    const emit = vi.fn();

    handleStreamEvent(emit, session, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello " },
      },
    });

    emit.mockClear();

    handleAssistantMessage(emit, session, {
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        content: [
          { type: "thinking", thinking: "Reasoning step.", signature: "sig" },
          { type: "text", text: "Hello world" },
        ],
      },
    });

    const chunks = emit.mock.calls.filter(
      ([channel]) => channel === "provider://message-chunk",
    );
    const thinkingEmit = chunks.find(([, payload]) => payload.isThought);
    const textEmit = chunks.find(
      ([, payload]) => !payload.isThought && payload.text === "Hello world",
    );

    expect(thinkingEmit, "thinking block must be emitted").toBeDefined();
    expect(thinkingEmit?.[1]).toMatchObject({
      sessionId: "session-1",
      text: "Reasoning step.",
      isThought: true,
    });
    expect(
      textEmit,
      "text block must NOT be re-emitted (already streamed)",
    ).toBeUndefined();
  });

  it("does not duplicate thinking when thinking_delta also streamed", () => {
    // De-dup safety: when partials cover both block types, the final message
    // must suppress both. Guards against the fix over-correcting.
    const session = makeSession();
    const emit = vi.fn();

    handleStreamEvent(emit, session, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning " },
      },
    });
    handleStreamEvent(emit, session, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello " },
      },
    });

    emit.mockClear();

    handleAssistantMessage(emit, session, {
      type: "assistant",
      message: {
        model: "claude-opus-4-7",
        content: [
          { type: "thinking", thinking: "Reasoning step.", signature: "sig" },
          { type: "text", text: "Hello world" },
        ],
      },
    });

    const chunks = emit.mock.calls.filter(
      ([channel]) => channel === "provider://message-chunk",
    );
    expect(chunks, "neither block may re-emit when both streamed").toHaveLength(
      0,
    );
  });
});
