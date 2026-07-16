// ABOUTME: Guards first-turn OAuth account selection in native agent chats.
// ABOUTME: Ensures history-only actions cannot hide the account switcher on an empty thread.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("AgentChat OAuth account switcher", () => {
  it("renders once outside the message-dependent history actions", () => {
    const source = readFileSync(
      resolve("src/components/chat/AgentChat.tsx"),
      "utf8",
    );
    const headerStart = source.indexOf("data-testid=\"agent-chat-account-header\"");
    const headerEnd = source.indexOf("{/* Messages Area */}", headerStart);
    const header = source.slice(headerStart, headerEnd);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(headerEnd).toBeGreaterThan(headerStart);
    expect(header.match(/<OAuthAccountSwitcher/g)).toHaveLength(1);
    expect(header).toMatch(
      /<Show when=\{threadMessages\(\)\.length > 0\}>[\s\S]*<\/Show>\s*<OAuthAccountSwitcher/,
    );
  });
});
