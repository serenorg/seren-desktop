// ABOUTME: Runtime-derived launcher inventory for the active native-agent New menu.
// ABOUTME: Centralizes agent presentation and organization-policy filtering.

import {
  allowsClaudeAgent,
  allowsCodexAgent,
  allowsGeminiAgent,
  allowsGrokAgent,
  allowsLmStudioAgent,
  type OrganizationPrivateModelsPolicy,
} from "@/services/organization-policy";
import type { AgentInfo, AgentType } from "@/services/providers";

export type NativeAgentLauncherChipVariant = "subscription" | "local";

export interface NativeAgentLauncherMetadata {
  label: string;
  description: string;
  glyph: string;
  testId: string;
  chip: {
    label: string;
    variant: NativeAgentLauncherChipVariant;
  };
}

export const NATIVE_AGENT_LAUNCHER_METADATA = {
  "claude-code": {
    label: "Claude Code",
    description: "Anthropic · chat-style coding agent",
    glyph: "🤖",
    testId: "new-claude-agent",
    chip: { label: "Subscription", variant: "subscription" },
  },
  codex: {
    label: "Codex",
    description: "OpenAI · chat-style coding agent",
    glyph: "⚡",
    testId: "new-codex-agent",
    chip: { label: "Subscription", variant: "subscription" },
  },
  "claude-codex": {
    label: "Claude + Codex",
    description: "Anthropic + OpenAI · paired coding agents",
    glyph: "🤝",
    testId: "new-claude-codex-agent",
    chip: { label: "Subscription", variant: "subscription" },
  },
  gemini: {
    label: "Antigravity",
    description: "Google · Antigravity coding agent",
    glyph: "✨",
    testId: "new-gemini-agent",
    chip: { label: "Subscription", variant: "subscription" },
  },
  grok: {
    label: "Grok",
    description: "xAI · chat-style coding agent",
    glyph: "𝕏",
    testId: "new-grok-agent",
    chip: { label: "Subscription / API key", variant: "subscription" },
  },
  lmstudio: {
    label: "LM Studio Agent",
    description: "Local models · OpenAI-compatible HTTP",
    glyph: "🖥️",
    testId: "new-lmstudio-agent",
    chip: { label: "Local", variant: "local" },
  },
} satisfies Record<AgentType, NativeAgentLauncherMetadata>;

function isAllowedByOrganizationPolicy(
  agentType: AgentType,
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  switch (agentType) {
    case "claude-code":
      return allowsClaudeAgent(policy);
    case "codex":
      return allowsCodexAgent(policy);
    case "claude-codex":
      return allowsClaudeAgent(policy) && allowsCodexAgent(policy);
    case "gemini":
      return allowsGeminiAgent(policy);
    case "grok":
      return allowsGrokAgent(policy);
    case "lmstudio":
      return allowsLmStudioAgent(policy);
  }
}

export interface NativeAgentLauncher extends NativeAgentLauncherMetadata {
  type: AgentType;
  runtime: AgentInfo;
}

export function getNativeAgentLaunchers(
  agents: readonly AgentInfo[],
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): NativeAgentLauncher[] {
  return agents
    .filter(
      (agent) =>
        agent.available && isAllowedByOrganizationPolicy(agent.type, policy),
    )
    .map((agent) => ({
      type: agent.type,
      runtime: agent,
      ...NATIVE_AGENT_LAUNCHER_METADATA[agent.type],
    }));
}
