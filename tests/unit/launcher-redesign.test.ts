// ABOUTME: Critical regression guards for the +New launcher redesign (#1832).
// ABOUTME: Asserts UX invariants — sections, chips, testids, copy — and preserves gating + dispatch.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getNativeAgentLaunchers,
  NATIVE_AGENT_LAUNCHER_METADATA,
} from "@/components/layout/native-agent-launchers";
import type { OrganizationPrivateModelsPolicy } from "@/services/organization-policy";
import type { AgentInfo, AgentType } from "@/services/providers";

const sidebarTsx = readFileSync(
  resolve("src/components/layout/ThreadSidebar.tsx"),
  "utf-8",
);
const tabBarTsx = readFileSync(
  resolve("src/components/layout/ThreadTabBar.tsx"),
  "utf-8",
);

const runtimeAgentTypes: AgentType[] = [
  "codex",
  "claude-code",
  "claude-codex",
  "planner-runner",
  "gemini",
  "grok",
  "lmstudio",
];

const runtimeAgents = runtimeAgentTypes.map<AgentInfo>((type) => ({
  type,
  name: type,
  description: type,
  command: type,
  available: true,
}));

describe("ThreadSidebar — launcher sections (#1832)", () => {
  it("renders the four section labels", () => {
    expect(sidebarTsx).toContain(">Chat<");
    expect(sidebarTsx).toContain(">Coding agents<");
    expect(sidebarTsx).toContain(">Command line<");
    expect(sidebarTsx).toContain(">Shell<");
  });
});

describe("ThreadSidebar — terminal YOLO state stays out of the thread list", () => {
  it("does not render a sidebar YOLO badge for terminal threads", () => {
    expect(sidebarTsx).not.toContain('data-testid="sidebar-yolo-badge"');
    expect(sidebarTsx).not.toMatch(/thread\.launchMode === "yolo"/);
  });
});

describe("ThreadSidebar — stable testids on every row (#1832)", () => {
  const staticTestids = [
    "new-seren-chat",
    "new-seren-private-agent",
    "new-claude-cli",
    "new-codex-cli",
    "new-terminal",
  ];
  for (const id of staticTestids) {
    it(`row has data-testid="${id}"`, () => {
      expect(sidebarTsx).toContain(`data-testid="${id}"`);
    });
  }

  it("keeps a unique test id for every runtime agent", () => {
    const testIds = Object.values(NATIVE_AGENT_LAUNCHER_METADATA).map(
      (metadata) => metadata.testId,
    );
    expect(new Set(testIds).size).toBe(runtimeAgentTypes.length);
    expect(testIds).toContain("new-lmstudio-agent");
  });
});

describe("ThreadSidebar — chip vocabulary (#1832)", () => {
  // Biome formats JSX text content onto its own line, so the closing-tag
  // child can be on a separate line from the opening tag — match across whitespace.
  it("uses 'Pay-as-you-go' for both Seren tiers", () => {
    const chips = sidebarTsx.match(/>\s*Pay-as-you-go\s*</g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(2);
  });

  it("uses 'Subscription' for Claude / Codex / Gemini / Grok coding-agent rows", () => {
    const hosted = Object.values(NATIVE_AGENT_LAUNCHER_METADATA).filter(
      (metadata) => metadata.chip.variant === "subscription",
    );
    expect(hosted).toHaveLength(6);
    expect(
      hosted.every((metadata) =>
        metadata.chip.label.startsWith("Subscription"),
      ),
    ).toBe(true);
  });

  it("uses 'Local' for LM Studio", () => {
    expect(NATIVE_AGENT_LAUNCHER_METADATA.lmstudio.chip).toEqual({
      label: "Local",
      variant: "local",
    });
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
  it("retains the Seren chat org-policy gates", () => {
    expect(sidebarTsx).toContain("allowsSerenPublicModels(authStore.privateChatPolicy)");
    expect(sidebarTsx).toContain("allowsSerenPrivateAgent(authStore.privateChatPolicy)");
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

  it("runtime coding-agent rows dispatch their authoritative type", () => {
    expect(sidebarTsx).toContain("handleNewAgent(launcher.type)");
  });

  it("CLI rows dispatch via createTerminalThread without hardcoding launch mode", () => {
    expect(sidebarTsx).toMatch(
      /handleNewTerminal\(\{\s*cliKind:\s*"claude",?\s*\}\)/s,
    );
    expect(sidebarTsx).toMatch(
      /handleNewTerminal\(\{\s*cliKind:\s*"codex",?\s*\}\)/s,
    );
    expect(sidebarTsx).not.toContain('data-testid="new-claude-cli-yolo"');
    expect(sidebarTsx).not.toContain('data-testid="new-codex-cli-yolo"');
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

  it("retains existing org-policy gates", () => {
    expect(tabBarTsx).toContain("allowsSerenPublicModels(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsSerenPrivateAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsClaudeAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsCodexAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsGeminiAgent(authStore.privateChatPolicy)");
    expect(tabBarTsx).toContain("allowsGrokAgent(authStore.privateChatPolicy)");
  });

  it("does not add LM Studio to the secondary top-tab +New menu", () => {
    expect(tabBarTsx).not.toContain('data-testid="new-lmstudio-agent"');
    expect(tabBarTsx).not.toContain('handleNewAgent("lmstudio")');
    expect(tabBarTsx).not.toContain("allowsLmStudioAgent");
  });
});

describe("ThreadSidebar — JSX text uses real · char, never literal \\u00B7", () => {
  // JSX text content is plain HTML, not a JS string literal: `\uXXXX` is
  // 6 visible characters, not an escape. Use the actual char (see L603).
  it("contains no literal '\\u00B7' byte sequence", () => {
    expect(sidebarTsx).not.toMatch(/\\u00B7/i);
  });
});

describe("ThreadSidebar — Seren Agent clarification + Claude + Codex row (#2368)", () => {
  it("keeps a single Seren Agent Chat row with Pay-as-you-go", () => {
    const rows = sidebarTsx.match(/data-testid="new-seren-chat"/g) ?? [];
    expect(rows.length).toBe(1);
  });

  it("Seren Agent subtitle declares Seren models + local tools", () => {
    expect(sidebarTsx).toContain("Seren models + local tools");
  });

  it("does NOT add a separate 'Seren Agent + Tools' row", () => {
    expect(sidebarTsx).not.toContain("Seren Agent + Tools");
  });

  it("renders Claude + Codex in the Coding agents section with Subscription", () => {
    expect(NATIVE_AGENT_LAUNCHER_METADATA["claude-codex"]).toMatchObject({
      label: "Claude + Codex",
      description: "Anthropic + OpenAI · paired coding agents",
      testId: "new-claude-codex-agent",
      chip: { label: "Subscription", variant: "subscription" },
    });
    // Inside the Coding agents section (after its label, before Command line).
    const codingIdx = sidebarTsx.indexOf(">Coding agents<");
    const cliIdx = sidebarTsx.indexOf(">Command line<");
    const rowIdx = sidebarTsx.indexOf("<For each={nativeAgentLaunchers()}>");
    expect(rowIdx).toBeGreaterThan(codingIdx);
    expect(rowIdx).toBeLessThan(cliIdx);
  });

  it("Claude + Codex routes through the native coding-agent path", () => {
    expect(sidebarTsx).toContain("handleNewAgent(launcher.type)");
  });

  it("Claude + Codex requires both organization policy gates", () => {
    for (const denied of ["allow_claude_agent", "allow_codex_agent"] as const) {
      const policy = {
        allow_claude_agent: true,
        allow_codex_agent: true,
      } as OrganizationPrivateModelsPolicy;
      policy[denied] = false;
      expect(
        getNativeAgentLaunchers(runtimeAgents, policy).map(
          (launcher) => launcher.type,
        ),
      ).not.toContain("claude-codex");
    }
  });

  it("Seren Agent still creates a chat thread (no agent_type stamp)", () => {
    const handler = sidebarTsx.slice(
      sidebarTsx.indexOf("const handleNewChat"),
      sidebarTsx.indexOf("const handleNewPrivateChat"),
    );
    expect(handler).toContain("createChatThreadWithOptions");
    expect(handler).not.toContain("createAgentThread");
    expect(handler).not.toContain("agentType");
  });

  it("ThreadTabBar +New menu carries the same Claude + Codex row", () => {
    expect(tabBarTsx).toContain('data-testid="new-claude-codex-agent"');
    expect(tabBarTsx).toContain('handleNewAgent("claude-codex")');
  });

  it("ThreadTabBar +New menu carries command-line launch rows", () => {
    for (const id of [
      "new-claude-cli",
      "new-codex-cli",
      "new-terminal",
    ]) {
      expect(tabBarTsx).toContain(`data-testid="${id}"`);
    }
    expect(tabBarTsx).toContain('cliKind: "claude"');
    expect(tabBarTsx).toContain('cliKind: "codex"');
    expect(tabBarTsx).not.toContain('data-testid="new-claude-cli-yolo"');
    expect(tabBarTsx).not.toContain('data-testid="new-codex-cli-yolo"');
    expect(tabBarTsx).not.toContain('launchMode: "yolo"');
    expect(tabBarTsx).toContain("createTerminalThread");
  });
});

describe("ThreadSidebar — runtime-derived native launcher inventory (#3656)", () => {
  it("preserves runtime order and removes unavailable or policy-blocked agents", () => {
    const agents = runtimeAgents.map((agent) =>
      agent.type === "gemini" ? { ...agent, available: false } : agent,
    );
    const policy = {
      allow_codex_agent: false,
      allow_lmstudio_agent: false,
    } as OrganizationPrivateModelsPolicy;
    expect(
      getNativeAgentLaunchers(agents, policy).map(
        (launcher) => launcher.type,
      ),
    ).toEqual(["claude-code", "grok"]);
  });

  it("keeps CLI terminal rows separate from runtime availability", () => {
    const section = sidebarTsx.slice(
      sidebarTsx.indexOf("const showCliLaunchers"),
      sidebarTsx.indexOf("const showCliLaunchers") + 220,
    );
    expect(section).toContain("disable_local_agents");
    expect(section).not.toContain("availableAgents");
    expect(section).not.toContain("Available()");
  });
});

describe("Launcher policy freshness", () => {
  it("refreshes private chat policy when either +New menu opens", () => {
    expect(sidebarTsx).toContain("refreshPrivateChatPolicy");
    expect(tabBarTsx).toContain("refreshPrivateChatPolicy");
  });
});

describe("Coding-agent launch failures (#3089)", () => {
  it("reopens both launch menus and renders the existing agent error", () => {
    expect(sidebarTsx).toContain("if (!threadId && agentStore.error)");
    expect(sidebarTsx).toContain("setShowLauncher(true)");
    expect(tabBarTsx).toContain("if (!threadId && agentStore.error)");
    expect(tabBarTsx).toContain("setShowNewMenu(true)");
    for (const source of [sidebarTsx, tabBarTsx]) {
      expect(source).toContain('data-testid="agent-launch-error"');
      expect(source).toContain('role="alert"');
      expect(source).toContain("agentStore.clearError()");
    }
  });
});

describe("ThreadSidebar — LM Studio local agent row (#2444)", () => {
  it("renders LM Studio in Coding agents with local copy and dispatch", () => {
    expect(NATIVE_AGENT_LAUNCHER_METADATA.lmstudio).toMatchObject({
      label: "LM Studio Agent",
      description: "Local models · OpenAI-compatible HTTP",
      testId: "new-lmstudio-agent",
      chip: { label: "Local", variant: "local" },
    });
    const codingIdx = sidebarTsx.indexOf(">Coding agents<");
    const cliIdx = sidebarTsx.indexOf(">Command line<");
    const rowIdx = sidebarTsx.indexOf("<For each={nativeAgentLaunchers()}>");
    expect(rowIdx).toBeGreaterThan(codingIdx);
    expect(rowIdx).toBeLessThan(cliIdx);
    expect(sidebarTsx).toContain("handleNewAgent(launcher.type)");
  });
});

describe("AgentChat — paired thread surfaces (#2368)", () => {
  const agentChatTsx = readFileSync(
    resolve("src/components/chat/AgentChat.tsx"),
    "utf-8",
  );

  it("renders role-scoped Planner/Executor model + effort selectors in the composer bottom row", () => {
    const toolbarIdx = agentChatTsx.indexOf("COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES}");
    const toolbar = agentChatTsx.slice(toolbarIdx, toolbarIdx + 2500);
    expect(toolbar).toContain('pairedRole="planner"');
    expect(toolbar).toContain('pairedRole="executor"');
    expect(toolbar).toContain("PairedModelSelector");
    expect(toolbar).toContain("PairedEffortSelector");
  });

  it("shows the compact paired header states", () => {
    // Role labels come from the live paired status so a swapped pairing names
    // its own agents; Claude/Codex remain the defaults (#3748).
    expect(agentChatTsx).toContain("${plannerLabel} planning");
    expect(agentChatTsx).toContain("${executorLabel} editing");
    expect(agentChatTsx).toContain("${plannerLabel} reviewing");
    expect(agentChatTsx).toContain('"Waiting for approval"');
    expect(agentChatTsx).toContain('?? "Claude"');
    expect(agentChatTsx).toContain('?? "Codex"');
  });

  it("renders handoff events as inline transcript activity lines", () => {
    expect(agentChatTsx).toContain('case "handoff"');
    expect(agentChatTsx).toContain('data-testid="paired-handoff"');
  });

  it("labels assistant messages with Claude / Codex / Seren attribution", () => {
    expect(agentChatTsx).toContain('data-testid="paired-attribution"');
  });
});
