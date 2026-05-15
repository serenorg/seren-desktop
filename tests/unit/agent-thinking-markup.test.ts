// ABOUTME: Regression tests for Claude <think> blocks leaking into chat text. #1911.
// ABOUTME: Pure string/state transformations only; UI/store wiring is tested separately.

import { describe, expect, it } from "vitest";
import {
  consumeAgentThinkingMarkupChunk,
  createAgentThinkingMarkupStreamState,
  extractAgentThinkingMarkup,
  flushAgentThinkingMarkupRemainder,
} from "@/lib/agent-thinking-markup";

describe("agent thinking markup normalizer", () => {
  it("extracts finalized <think> blocks without losing assistant text", () => {
    const input = [
      "First, I will inspect the runtime.",
      "<think>",
      "The parser needs to split this from visible content.",
      "</think>",
      "The fix is to render this answer normally.",
    ].join("\n");

    expect(extractAgentThinkingMarkup(input)).toEqual({
      thinking: "The parser needs to split this from visible content.",
      content:
        "First, I will inspect the runtime.\n\nThe fix is to render this answer normally.",
    });
  });

  it("streams split <think> tags into thinking instead of visible content", () => {
    const state = createAgentThinkingMarkupStreamState();

    const first = consumeAgentThinkingMarkupChunk(
      state,
      "Visible before.\n<thi",
    );
    const second = consumeAgentThinkingMarkupChunk(
      state,
      "nk>internal plan</th",
    );
    const third = consumeAgentThinkingMarkupChunk(
      state,
      "ink>\nVisible after.",
    );

    expect(first).toEqual({ content: "Visible before.\n", thinking: "" });
    expect(second).toEqual({ content: "", thinking: "internal plan" });
    expect(third).toEqual({ content: "\nVisible after.", thinking: "" });
    expect(flushAgentThinkingMarkupRemainder(state)).toEqual({
      content: "",
      thinking: "",
    });
  });

  it("treats an unclosed final <think> block as thinking", () => {
    const state = createAgentThinkingMarkupStreamState();
    const chunk = consumeAgentThinkingMarkupChunk(
      state,
      "<think>still reasoning",
    );

    expect(chunk).toEqual({ content: "", thinking: "still reasoning" });
    expect(flushAgentThinkingMarkupRemainder(state)).toEqual({
      content: "",
      thinking: "",
    });
  });
});
