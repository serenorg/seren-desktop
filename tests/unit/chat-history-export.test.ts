// ABOUTME: Verifies chat export excludes tool calls and tool results.
// ABOUTME: Regression guard for #573 — exports leaked raw tool JSON as "Assistant:" lines.

import { describe, expect, it } from "vitest";
import {
  formatChatHistoryMarkdown,
  hasExportableMessages,
} from "@/lib/chat-history-export";
import type { ChatHistoryExportMessage } from "@/lib/chat-history-export";

describe("formatChatHistoryMarkdown", () => {
  it("excludes tool_call and tool_result messages", () => {
    const messages: ChatHistoryExportMessage[] = [
      { type: "user", content: "/prophet-arb-bot" },
      { type: "assistant", content: "I'll help you set up the Prophet Arb Bot." },
      { type: "tool_call", content: "seren__list_projects" },
      { type: "tool_result", content: '[{"text":"{\\"data\\":[...]}"}]' },
      { type: "assistant", content: "You're authenticated." },
    ];

    const md = formatChatHistoryMarkdown(messages);

    expect(md).toContain("**You:** /prophet-arb-bot");
    expect(md).toContain("**Assistant:** I'll help you set up");
    expect(md).toContain("**Assistant:** You're authenticated.");
    expect(md).not.toContain("seren__list_projects");
    expect(md).not.toContain('[{"text"');
  });

  it("excludes non-chat message types", () => {
    const messages: ChatHistoryExportMessage[] = [
      { type: "user", content: "edit foo.ts" },
      { type: "thought", content: "internal reasoning" },
      { type: "diff", content: "--- a\n+++ b" },
      { type: "transition", content: "routing to worker" },
      { type: "reroute", content: "switching model" },
      { type: "error", content: "rate limited" },
      { type: "assistant", content: "Done." },
    ];

    const md = formatChatHistoryMarkdown(messages);

    expect(md).toContain("**You:** edit foo.ts");
    expect(md).toContain("**Assistant:** Done.");
    expect(md).not.toContain("internal reasoning");
    expect(md).not.toContain("--- a");
    expect(md).not.toContain("routing to worker");
    expect(md).not.toContain("switching model");
    expect(md).not.toContain("rate limited");
  });

  it("hasExportableMessages returns false when only tool messages exist", () => {
    const messages: ChatHistoryExportMessage[] = [
      { type: "tool_call", content: "seren__list_projects" },
      { type: "tool_result", content: '{"data":[]}' },
    ];
    expect(hasExportableMessages(messages)).toBe(false);
  });

  it("hasExportableMessages returns true when chat messages exist", () => {
    const messages: ChatHistoryExportMessage[] = [
      { type: "tool_call", content: "x" },
      { type: "user", content: "hi" },
    ];
    expect(hasExportableMessages(messages)).toBe(true);
  });
});
