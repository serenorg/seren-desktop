// ABOUTME: Mission Control's authoritative roster and launch-time model choices.
// ABOUTME: Combines safe built-in runtime IDs with live session and hosted catalogs.

import type { ProviderModel } from "@/lib/providers";
import {
  allowsClaudeAgent,
  allowsCodexAgent,
  allowsGeminiAgent,
  allowsGrokAgent,
  allowsLmStudioAgent,
  allowsSerenPrivateAgent,
  allowsSerenPublicModels,
  type OrganizationPrivateModelsPolicy,
} from "@/services/organization-policy";
import { privateModelsService } from "@/services/private-models";
import { type AgentType, testLmStudioConnection } from "@/services/providers";
import { getLiveSerenModelCatalog } from "@/services/seren-model-catalog";
import { type AgentModelInfo, agentStore } from "@/stores/agent.store";
import { authStore } from "@/stores/auth.store";
import { settingsStore } from "@/stores/settings.store";

export type MissionAgentType = AgentType | "seren" | "seren-private";
export type MissionModelTarget =
  | Exclude<MissionAgentType, "claude-codex">
  | "claude-codex:planner"
  | "claude-codex:executor";

export interface MissionAgentDefinition {
  id: MissionAgentType;
  label: string;
  source: string;
  description: string;
  defaultSelected: boolean;
}

export interface MissionModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface MissionModelCatalog {
  models: MissionModelOption[];
  note: string | null;
}

export interface MissionPermissionOption {
  value: string;
  label: string;
}

export const MISSION_AGENT_DEFINITIONS: readonly MissionAgentDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    source: "Anthropic",
    description: "Claude's local coding agent",
    defaultSelected: true,
  },
  {
    id: "codex",
    label: "Codex",
    source: "OpenAI",
    description: "OpenAI's local coding agent",
    defaultSelected: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    source: "Google",
    description: "Gemini CLI coding agent",
    defaultSelected: false,
  },
  {
    id: "grok",
    label: "Grok",
    source: "xAI",
    description: "Grok Build coding agent",
    defaultSelected: false,
  },
  {
    id: "seren",
    label: "Seren",
    source: "Seren Models",
    description: "Hosted Seren model with tools",
    defaultSelected: true,
  },
  {
    id: "seren-private",
    label: "Seren Private Models",
    source: "Seren",
    description: "Organization-private inference",
    defaultSelected: false,
  },
  {
    id: "claude-codex",
    label: "Claude + Codex",
    source: "Anthropic + OpenAI",
    description: "Claude plans; Codex executes",
    defaultSelected: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    source: "Local",
    description: "Models running on this device",
    defaultSelected: false,
  },
] as const;

export const MISSION_AGENT_TYPES = MISSION_AGENT_DEFINITIONS.map(
  (definition) => definition.id,
);

export const MISSION_MODEL_TARGETS: readonly MissionModelTarget[] = [
  "claude-code",
  "codex",
  "gemini",
  "grok",
  "seren",
  "seren-private",
  "claude-codex:planner",
  "claude-codex:executor",
  "lmstudio",
] as const;

export function createEmptyMissionModelCatalogs(): Record<
  MissionModelTarget,
  MissionModelCatalog
> {
  return Object.fromEntries(
    MISSION_MODEL_TARGETS.map((target) => [target, { models: [], note: null }]),
  ) as Record<MissionModelTarget, MissionModelCatalog>;
}

const CLAUDE_MODELS: readonly MissionModelOption[] = [
  {
    id: "claude-opus-4-8[1m]",
    name: "Claude Opus 4.8 · 1M context",
    description: "SerenDesktop's preferred Claude Code model",
  },
  {
    id: "claude-opus-4-7[1m]",
    name: "Claude Opus 4.7 · 1M context",
    description: "Previous Opus generation with a 1M context window",
  },
  {
    id: "claude-sonnet-4-7[1m]",
    name: "Claude Sonnet 4.7 · 1M context",
    description: "Faster Claude model with a 1M context window",
  },
] as const;

const CODEX_MODELS: readonly MissionModelOption[] = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description: "Flagship Codex model",
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description: "Fast, lower-cost Codex model",
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    description: "Balanced Codex model",
  },
] as const;

const GEMINI_MODELS: readonly MissionModelOption[] = [
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Most capable Gemini CLI model",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast Gemini CLI model",
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Lowest-latency Gemini CLI model",
  },
] as const;

const GROK_MODELS: readonly MissionModelOption[] = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "Grok Build's coding-agent model",
  },
] as const;

export const MISSION_PERMISSION_OPTIONS: Record<
  MissionAgentType,
  readonly MissionPermissionOption[]
> = {
  "claude-code": [
    { value: "", label: "Runtime default" },
    { value: "plan", label: "Plan only" },
    { value: "acceptEdits", label: "Allow workspace edits" },
  ],
  codex: [
    { value: "", label: "Runtime default" },
    { value: "ask", label: "Ask before actions" },
    { value: "auto", label: "Allow workspace edits" },
  ],
  gemini: [
    { value: "", label: "Runtime default" },
    { value: "plan", label: "Plan only" },
    { value: "auto_edit", label: "Allow workspace edits" },
  ],
  grok: [
    { value: "", label: "Runtime default" },
    { value: "plan", label: "Plan only" },
    { value: "acceptEdits", label: "Allow workspace edits" },
  ],
  seren: [{ value: "", label: "Review first (fixed)" }],
  "seren-private": [{ value: "", label: "Review first (fixed)" }],
  "claude-codex": [
    { value: "", label: "Runtime default" },
    { value: "ask", label: "Ask before actions" },
    { value: "auto", label: "Allow workspace edits" },
  ],
  lmstudio: [
    { value: "", label: "Runtime default" },
    { value: "ask", label: "Ask before actions" },
    { value: "auto", label: "Allow workspace edits" },
  ],
};

function builtinModels(
  target: MissionModelTarget,
): readonly MissionModelOption[] {
  switch (target) {
    case "claude-code":
    case "claude-codex:planner":
      return CLAUDE_MODELS;
    case "codex":
    case "claude-codex:executor":
      return CODEX_MODELS;
    case "gemini":
      return GEMINI_MODELS;
    case "grok":
      return GROK_MODELS;
    default:
      return [];
  }
}

function toMissionModel(
  model: AgentModelInfo | ProviderModel,
): MissionModelOption {
  if ("modelId" in model) {
    return {
      id: model.modelId,
      name: model.name,
      description: model.description,
    };
  }
  return { id: model.id, name: model.name, description: model.description };
}

export function mergeMissionModels(
  ...groups: ReadonlyArray<readonly MissionModelOption[]>
): MissionModelOption[] {
  const merged = new Map<string, MissionModelOption>();
  for (const group of groups) {
    for (const model of group) {
      const id = model.id.trim();
      if (!id || merged.has(id.toLowerCase())) continue;
      merged.set(id.toLowerCase(), { ...model, id });
    }
  }
  return [...merged.values()];
}

function liveSessionModels(target: MissionModelTarget): MissionModelOption[] {
  const models: MissionModelOption[] = [];
  for (const session of Object.values(agentStore.sessions)) {
    if (target === "claude-codex:planner") {
      const roleModels = session.paired?.planner.models?.availableModels ?? [];
      models.push(...roleModels.map(toMissionModel));
      continue;
    }
    if (target === "claude-codex:executor") {
      const roleModels = session.paired?.executor.models?.availableModels ?? [];
      models.push(...roleModels.map(toMissionModel));
      continue;
    }
    if (session.info.agentType !== target) continue;
    models.push(...(session.availableModels ?? []).map(toMissionModel));
  }
  return models;
}

export function missionAgentAllowed(
  agentType: MissionAgentType,
  policy: OrganizationPrivateModelsPolicy | null | undefined,
): boolean {
  switch (agentType) {
    case "seren":
      return allowsSerenPublicModels(policy);
    case "seren-private":
      return allowsSerenPrivateAgent(policy);
    case "claude-code":
      return allowsClaudeAgent(policy);
    case "codex":
      return allowsCodexAgent(policy);
    case "gemini":
      return allowsGeminiAgent(policy);
    case "grok":
      return allowsGrokAgent(policy);
    case "claude-codex":
      return allowsClaudeAgent(policy) && allowsCodexAgent(policy);
    case "lmstudio":
      return allowsLmStudioAgent(policy);
  }
}

export function missionAgentRequiresSignIn(
  agentType: MissionAgentType,
): boolean {
  return agentType === "seren" || agentType === "seren-private";
}

export async function loadMissionModelCatalog(
  target: MissionModelTarget,
): Promise<MissionModelCatalog> {
  const builtins = builtinModels(target);
  const runtimeModels = liveSessionModels(target);

  if (target === "seren") {
    if (!authStore.isAuthenticated) {
      return { models: [], note: "Sign in to load Seren Models." };
    }
    try {
      const models = (await getLiveSerenModelCatalog()).map(toMissionModel);
      return { models: mergeMissionModels(models), note: null };
    } catch {
      return {
        models: [],
        note: "The Seren model catalog could not be loaded. System default remains available.",
      };
    }
  }

  if (target === "seren-private") {
    if (!authStore.isAuthenticated) {
      return {
        models: [],
        note: "Sign in to load organization-private models.",
      };
    }
    try {
      const models = (await privateModelsService.listAvailable()).map(
        toMissionModel,
      );
      return {
        models: mergeMissionModels(models),
        note:
          models.length > 0
            ? null
            : "No private models are enabled for this organization.",
      };
    } catch {
      return {
        models: [],
        note: "The private model catalog could not be loaded for this organization.",
      };
    }
  }

  if (target === "lmstudio") {
    try {
      const result = await testLmStudioConnection(
        settingsStore.get("lmStudioBaseUrl"),
        settingsStore.get("lmStudioApiKey"),
      );
      const models = (result.models ?? []).map((model) => ({
        id: model.modelId,
        name: model.name,
        description: model.description,
      }));
      return {
        models: mergeMissionModels(runtimeModels, models),
        note:
          models.length > 0
            ? null
            : "Start LM Studio and load a model to pin one here.",
      };
    } catch {
      return {
        models: mergeMissionModels(runtimeModels),
        note: "Start LM Studio to load models downloaded on this device.",
      };
    }
  }

  return {
    models: mergeMissionModels(runtimeModels, builtins),
    note:
      runtimeModels.length > 0
        ? "Includes models reported by the live runtime."
        : null,
  };
}
