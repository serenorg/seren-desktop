// ABOUTME: #1941 — compaction prepend must not look like a Claude Code transcript.
// ABOUTME: Raw "USER:" / "TOOL_RESULT (" prefixes prime Opus 4.7 to continue the
// ABOUTME: transcript inside its assistant content, bleeding into the chat.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compactionSource = readFileSync(
  resolve("src/lib/agent/compaction.ts"),
  "utf-8",
);

function preservedContextBlock(): string {
  // Narrow to the preserved-context formatter and prepend wrapper. The
  // summarizer-input prompt earlier in compactAgentConversation legitimately
  // uses `${m.type.toUpperCase()}: ${m.content}` because that text feeds a
  // summarization request, not a continuation request — different codepath,
  // not the bleed source. Anchor on the formatter's variable name so
  // assertions are scoped to the bug surface.
  const start = compactionSource.indexOf("const preservedContext = toPreserve");
  if (start < 0) {
    throw new Error("preservedContext formatter not found in compaction.ts");
  }
  const end = compactionSource.indexOf("/** Claude Code model IDs", start);
  if (end < 0) {
    throw new Error("could not find prepend-wrapper end");
  }
  return compactionSource.slice(start, end);
}

describe("#1941 — preserved-context format does not mimic Claude Code stream-json", () => {
  it("does not emit raw USER:/ASSISTANT: line prefixes for preserved messages", () => {
    // The bleed in wut.png matched these literal prefixes verbatim. The
    // template that produced them was `${m.type.toUpperCase()}: ${content}`
    // which expanded to `USER: …` / `ASSISTANT: …`. Banning the template
    // string itself is the durable check — banning the expanded output
    // would false-positive on legitimate uses of "USER:" elsewhere.
    const body = preservedContextBlock();
    expect(
      body,
      "Recent-messages formatter must not concatenate `<TYPE>: ` style prefixes",
    ).not.toMatch(/m\.type\.toUpperCase\(\)\s*\}\s*:/);
  });

  it("does not emit raw TOOL_RESULT (title): prefix for preserved tool results", () => {
    const body = preservedContextBlock();
    expect(
      body,
      "Recent-messages formatter must not produce TOOL_RESULT (title): output",
    ).not.toMatch(/TOOL_RESULT\s*\(\$\{/);
  });

  it("wraps preserved messages in <prior_user>/<prior_assistant>/<prior_tool> tags", () => {
    const body = preservedContextBlock();
    expect(body).toMatch(/<prior_user>/);
    expect(body).toMatch(/<\/prior_user>/);
    expect(body).toMatch(/<prior_assistant>/);
    expect(body).toMatch(/<\/prior_assistant>/);
    expect(body).toMatch(/<prior_tool\b/);
    expect(body).toMatch(/<\/prior_tool>/);
  });

  it("wraps the recent-messages window in a <prior_messages> block, not a 'Recent messages:' label", () => {
    const body = preservedContextBlock();
    expect(
      body,
      "Block label 'Recent messages:' reads as transcript framing; use <prior_messages> instead",
    ).not.toMatch(/Recent messages:/);
    expect(body).toMatch(/<prior_messages>/);
    expect(body).toMatch(/<\/prior_messages>/);
  });
});
