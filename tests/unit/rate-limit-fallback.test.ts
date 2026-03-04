// ABOUTME: Tests for rate-limit and prompt-too-long error detection functions.
// ABOUTME: Verifies pattern matching catches all known API error forms.

import { describe, expect, it } from "vitest";
import {
  isPromptTooLongError,
  isRateLimitError,
} from "@/lib/rate-limit-fallback";

describe("isPromptTooLongError", () => {
  it("detects bare 'Prompt is too long' from CLI", () => {
    expect(isPromptTooLongError("Prompt is too long")).toBe(true);
  });

  it("detects case-insensitive variants", () => {
    expect(isPromptTooLongError("PROMPT IS TOO LONG")).toBe(true);
    expect(isPromptTooLongError("prompt too long")).toBe(true);
  });

  it("detects Anthropic API error wrapped by CLI", () => {
    const apiError =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}';
    expect(isPromptTooLongError(apiError)).toBe(true);
  });

  it("detects API Error 400 + invalid_request_error without recognizable message", () => {
    // When the inner message doesn't match any keyword patterns,
    // the compound check (api error: 400 + invalid_request_error) should still catch it
    const apiError =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"something unexpected"}}';
    expect(isPromptTooLongError(apiError)).toBe(true);
  });

  it("detects 'too many tokens' phrasing", () => {
    expect(
      isPromptTooLongError(
        "Number of input tokens 250000 exceeds the maximum of 200000 for this model. Too many tokens.",
      ),
    ).toBe(true);
  });

  it("detects 'exceeds the maximum' phrasing", () => {
    expect(
      isPromptTooLongError(
        "Number of input tokens exceeds the maximum for this model",
      ),
    ).toBe(true);
  });

  it("detects 'reduce your prompt' phrasing", () => {
    expect(
      isPromptTooLongError(
        "Please reduce your prompt and try again.",
      ),
    ).toBe(true);
  });

  it("detects 'reduce the number of messages' phrasing", () => {
    expect(
      isPromptTooLongError(
        "Please reduce the number of messages or the length of your system prompt.",
      ),
    ).toBe(true);
  });

  it("detects context_length_exceeded", () => {
    expect(isPromptTooLongError("context_length_exceeded")).toBe(true);
  });

  it("detects 'maximum context length' phrasing", () => {
    expect(
      isPromptTooLongError(
        "This model's maximum context length is 200000 tokens",
      ),
    ).toBe(true);
  });

  it("does not false-positive on normal assistant content", () => {
    expect(
      isPromptTooLongError(
        "I can help you write that function. Here's an implementation:",
      ),
    ).toBe(false);
  });

  it("does not false-positive on unrelated 400 errors", () => {
    expect(
      isPromptTooLongError(
        'API Error: 400 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}',
      ),
    ).toBe(false);
  });

  it("does not false-positive on 400 without invalid_request_error", () => {
    expect(
      isPromptTooLongError(
        "API Error: 400 Bad Request",
      ),
    ).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("detects 429 status", () => {
    expect(isRateLimitError("429 Too Many Requests")).toBe(true);
  });

  it("detects rate limit phrasing", () => {
    expect(isRateLimitError("You have hit your rate limit")).toBe(true);
  });

  it("detects overloaded", () => {
    expect(isRateLimitError("API is overloaded")).toBe(true);
  });

  it("does not false-positive on unrelated errors", () => {
    expect(
      isRateLimitError("Invalid JSON in request body"),
    ).toBe(false);
  });
});
