// ABOUTME: Unit tests for shared chat UI transcript parsing helpers.
// ABOUTME: Guards markdown-like fence parsing against hangs and regressions.

import { describe, expect, it } from "vitest";
import { parseChatStructuredText } from "../../packages/chat-ui/src/structured-text";

describe("parseChatStructuredText", () => {
  it("parses fenced code blocks with info strings", () => {
    const blocks = parseChatStructuredText(
      ['```ts title="example.ts"', "const answer = 42;", "```"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        kind: "code",
        language: "ts",
        text: "const answer = 42;",
      },
    ]);
  });

  it("parses longer backtick fences", () => {
    const blocks = parseChatStructuredText(
      ["````python {.line-numbers}", "print('hello')", "````"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        kind: "code",
        language: "python",
        text: "print('hello')",
      },
    ]);
  });

  it("parses tilde fences", () => {
    const blocks = parseChatStructuredText(
      ["~~~rust", "fn main() {}", "~~~"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        kind: "code",
        language: "rust",
        text: "fn main() {}",
      },
    ]);
  });

  it("consumes malformed block starts instead of stalling", () => {
    const blocks = parseChatStructuredText(
      ["```ts title=\"unterminated\"", "const value = 1;"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        kind: "code",
        language: "ts",
        text: "const value = 1;",
      },
    ]);
  });
});
