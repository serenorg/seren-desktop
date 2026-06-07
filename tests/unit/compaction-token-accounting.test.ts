// ABOUTME: Unit tests for request-level token accounting (#2105).
// ABOUTME: System prompt, tool schemas, tool args, tool results, and flat image cost.

import { describe, expect, it } from "vitest";
import {
  estimateAccountedMessageTokens,
  estimateRequestTokens,
  IMAGE_TOKEN_COST,
} from "@/lib/compaction/token-accounting";

describe("#2105 request token accounting", () => {
  it("counts a single image at a flat cost, independent of base64 length", () => {
    const tiny = estimateAccountedMessageTokens({ content: "", imageParts: 1 });
    expect(tiny).toBe(IMAGE_TOKEN_COST);
    // Two identical-content messages differing only by image count differ by
    // exactly the flat cost — not by any base64 payload size.
    const two = estimateAccountedMessageTokens({ content: "hi", imageParts: 2 });
    const zero = estimateAccountedMessageTokens({ content: "hi", imageParts: 0 });
    expect(two - zero).toBe(2 * IMAGE_TOKEN_COST);
  });

  it("includes tool-call arguments and tool results in the message cost", () => {
    const withTools = estimateAccountedMessageTokens({
      content: "call it",
      toolArgs: { path: "/very/long/path/that/costs/tokens", mode: "w" },
      toolResult: "a".repeat(400),
    });
    const contentOnly = estimateAccountedMessageTokens({ content: "call it" });
    expect(withTools).toBeGreaterThan(contentOnly);
  });

  it("includes system prompt and tool schemas in the request total", () => {
    const base = estimateRequestTokens({
      messages: [{ content: "hello" }],
    });
    const withExtras = estimateRequestTokens({
      systemPrompt: "x".repeat(4000),
      toolSchemas: [{ name: "read_file", description: "y".repeat(4000) }],
      messages: [{ content: "hello" }],
    });
    // System prompt (~1000 tok) + tool schemas (~1000 tok) must be reflected.
    expect(withExtras - base).toBeGreaterThan(1_500);
  });
});
