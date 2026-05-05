// ABOUTME: Regression test for #1810 — Seren/Private (ChatContent) and Agent
// ABOUTME: chats must render the queued-message indicator with the same markup.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chatContentSource = readFileSync(
  resolve("src/components/chat/ChatContent.tsx"),
  "utf-8",
);
const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

const CANONICAL_PILL_CLASSES =
  "flex items-center gap-2 px-2 py-1 bg-surface-2 border border-border rounded text-xs text-muted-foreground";
const CANONICAL_CLEAR_CLASSES = "text-destructive hover:underline";

describe("#1810 — queued-message indicator is unified across chat surfaces", () => {
  it("AgentChat still renders the canonical pill (source of truth)", () => {
    expect(agentChatSource).toContain(CANONICAL_PILL_CLASSES);
    expect(agentChatSource).toContain(CANONICAL_CLEAR_CLASSES);
    expect(agentChatSource).toMatch(/>\s*Clear\s*</);
  });

  it("ChatContent renders the same canonical pill, not the legacy row", () => {
    expect(chatContentSource).toContain(CANONICAL_PILL_CLASSES);
    expect(chatContentSource).toContain(CANONICAL_CLEAR_CLASSES);
  });

  it("ChatContent no longer ships the divergent legacy markup", () => {
    // Old full-width row above the textarea — distinguishing tokens that only
    // appear in the pre-unification block.
    expect(chatContentSource).not.toContain("Clear Queue");
    expect(chatContentSource).not.toContain(
      "ml-auto bg-transparent border border-border text-muted-foreground px-2 py-0.5 rounded text-xs cursor-pointer",
    );
  });
});
