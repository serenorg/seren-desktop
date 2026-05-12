// ABOUTME: Critical regression guards for the +New launcher redesign (#1832).
// ABOUTME: Asserts UX invariants — sections, chips, testids, copy — and preserves gating + dispatch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sidebarTsx = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf-8",
);
const tabBarTsx = readFileSync(
  resolve("src/components/layout/ThreadTabBar.tsx"),
  "utf-8",
);

describe("ThreadSidebar — launcher sections (#1832)", () => {
  it("renders the four section labels", () => {
    expect(sidebarTsx).toContain(">Chat<");
    expect(sidebarTsx).toContain(">Coding agents<");
    expect(sidebarTsx).toContain(">Command line<");
    expect(sidebarTsx).toContain(">Shell<");
  });
});

describe("ThreadSidebar — stable testids on every row (#1832)", () => {
  const testids = [
    "new-seren-chat",
    "new-seren-private-agent",
    "new-claude-agent",
    "new-codex-agent",
    "new-gemini-agent",
    "new-claude-cli",
    "new-codex-cli",
    "new-terminal",
  ];
  for (const id of testids) {
    it(`row has data-testid="${id}"`, () => {
      expect(sidebarTsx).toContain(`data-testid="${id}"`);
    });
  }
});

describe("ThreadSidebar — chip vocabulary (#1832)", () => {
  // Biome formats JSX text content onto its own line, so the closing-tag
  // child can be on a separate line from the opening tag — match across whitespace.
  it("uses 'Pay-as-you-go' for both Seren tiers", () => {
    const chips = sidebarTsx.match(/>\s*Pay-as-you-go\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(2);
  });

  it("uses 'Subscription' for Claude / Codex / Gemini coding-agent rows", () => {
    const chips = sidebarTsx.match(/>\s*Subscription\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(3);
  });

  it("uses 'CLI' chip for the two CLI rows", () => {
    const chips = sidebarTsx.match(/>\s*CLI\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ThreadSidebar — Seren Private subtitle clarifies AWS Bedrock & Azure (#1832)", () => {
  it("subtitle mentions both Bedrock and Azure (not BYOK)", () => {
    const privateRow = sidebarTsx.slice(
      sidebarTsx.indexOf('data-testid="new-seren-private-agent"'),
      sidebarTsx.indexOf('data-testid="new-seren-private-agent"') + 1200,
    );
    expect(privateRow).toContain("Bedrock");
    expect(privateRow).toContain("Azure");
    expect(privateRow).not.toMatch(/\bBYOK\b/);
  });
});

describe("ThreadSidebar — gating preserved (#1832)", () => {
  it("retains all five org-policy gates", () => {
    expect(sidebarTsx).toContain("allowsSerenPublicModels(authStore.privateChatPolicy)");
    expect(sidebarTsx).toContain("allowsSerenPrivateAgent(authStore.privateChatPolicy)");
    expect(sidebarTsx).toContain("allowsClaudeAgent(authStore.privateChatPolicy)");
    expect(sidebarTsx).toContain("allowsCodexAgent(authStore.privateChatPolicy)");
    expect(sidebarTsx).toContain("allowsGeminiAgent(authStore.privateChatPolicy)");
  });
});

describe("ThreadSidebar — dispatch preserved (#1832)", () => {
  it("public Seren chat still calls createChatThreadWithOptions with provider 'seren'", () => {
    expect(sidebarTsx).toMatch(
      /createChatThreadWithOptions\("New Chat",\s*\{[^}]*provider:\s*"seren"/s,
    );
  });

  it("private Seren chat still calls createChatThreadWithOptions with provider 'seren-private'", () => {
    expect(sidebarTsx).toMatch(
      /createChatThreadWithOptions\("New Private Chat",\s*\{[^}]*provider:\s*"seren-private"/s,
    );
  });

  it("agent dispatch helper still calls createAgentThread with cwd", () => {
    expect(sidebarTsx).toMatch(
      /createAgentThread\(\s*agentType\s*,\s*cwd\s*\)/,
    );
  });

  it("each coding agent row routes through handleNewAgent with the right type", () => {
    expect(sidebarTsx).toContain('handleNewAgent("claude-code")');
    expect(sidebarTsx).toContain('handleNewAgent("codex")');
    expect(sidebarTsx).toContain('handleNewAgent("gemini")');
  });

  it("CLI rows dispatch via createTerminalThread with the correct title and command", () => {
    expect(sidebarTsx).toMatch(
      /handleNewTerminal\(\{\s*title:\s*"Claude Code CLI",\s*command:\s*"claude",?\s*\}\)/s,
    );
    expect(sidebarTsx).toMatch(
      /handleNewTerminal\(\{\s*title:\s*"Codex CLI",\s*command:\s*"codex",?\s*\}\)/s,
    );
  });

  it("plain Terminal still dispatches via createTerminalThread with title 'Terminal'", () => {
    expect(sidebarTsx).toMatch(/handleNewTerminal\(\{\s*title:\s*"Terminal"\s*\}\)/);
  });
});

describe("ThreadTabBar — chip vocabulary on the secondary +New menu (#1832)", () => {
  it("Seren rows carry 'Pay-as-you-go' chip", () => {
    const chips = tabBarTsx.match(/>\s*Pay-as-you-go\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(2);
  });

  it("Claude / Codex / Gemini rows carry 'Subscription' chip", () => {
    const chips = tabBarTsx.match(/>\s*Subscription\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(3);
  });

  it("retains the same five org-policy gates as the sidebar", () => {
    expect(tabBarTsx).toContain("allowsSerenPublicModels(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsSerenPrivateAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsClaudeAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsCodexAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsGeminiAgent(authStore.privateChatPolicy)");
  });
});

describe("ThreadSidebar — JSX text uses real · char, never literal \\u00B7", () => {
  // JSX text content is plain HTML, not a JS string literal: `\uXXXX` is
  // 6 visible characters, not an escape. Use the actual char (see L603).
  it("contains no literal '\\u00B7' byte sequence", () => {
    expect(sidebarTsx).not.toMatch(/\\u00B7/i);
  });
});
