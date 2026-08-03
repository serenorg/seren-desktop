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
import {
  type AgentModelCatalogEntry,
  type AgentType,
  getAgentModelCatalog,
  getAgentPermissionCatalog,
  testLmStudioConnection,
} from "@/services/providers";
import { getLiveSerenModelCatalog } from "@/services/seren-model-catalog";
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
  description: string;
}

export interface MissionPermissionCatalog {
  options: MissionPermissionOption[];
  note: string | null;
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
    label: "Antigravity",
    source: "Google",
    description: "Google's Antigravity coding agent",
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
  ) as unknown as Record<MissionModelTarget, MissionModelCatalog>;
}

export function createEmptyMissionPermissionCatalogs(): Record<
  MissionAgentType,
  MissionPermissionCatalog
> {
  return Object.fromEntries(
    MISSION_AGENT_TYPES.map((agentType) => [
      agentType,
      {
        options: [
          {
            value: "",
            label: "Loading runtime modes…",
            description: "Reading this provider's approval modes.",
          },
        ],
        note: null,
      },
    ]),
  ) as Record<MissionAgentType, MissionPermissionCatalog>;
}

export async function loadMissionPermissionCatalog(
  agentType: MissionAgentType,
): Promise<MissionPermissionCatalog> {
  if (agentType === "seren" || agentType === "seren-private") {
    return {
      options: [
        {
          value: "",
          label: "Review First",
          description:
            "External actions pause for review; this hosted mode is fixed.",
        },
      ],
      note: null,
    };
  }

  try {
    const catalog = await getAgentPermissionCatalog(agentType, {
      approvalPolicy: settingsStore.get("agentApprovalPolicy"),
      sandboxMode: settingsStore.get("agentSandboxMode"),
      networkEnabled: settingsStore.get("agentNetworkEnabled"),
    });
    const defaultMode = catalog.modes.find(
      (mode) => mode.modeId === catalog.defaultModeId,
    );
    const defaultName = defaultMode?.name ?? catalog.defaultModeId;
    return {
      options: [
        {
          value: "",
          label: `Agent Settings · ${defaultName}`,
          description: defaultMode?.description
            ? `Uses Agent Settings, currently ${defaultName}: ${defaultMode.description}`
            : `Uses Agent Settings, currently ${defaultName}.`,
        },
        ...catalog.modes.map((mode) => ({
          value: mode.modeId,
          label: mode.name,
          description: mode.description ?? mode.name,
        })),
      ],
      note: null,
    };
  } catch {
    return {
      options: [
        {
          value: "",
          label: "Agent Settings",
          description: "Uses the approval policy configured in Agent Settings.",
        },
      ],
      note: "Runtime permission modes could not be loaded.",
    };
  }
}

function localAgentForTarget(
  target: MissionModelTarget,
): Exclude<AgentType, "claude-codex" | "lmstudio"> | null {
  switch (target) {
    case "claude-code":
    case "claude-codex:planner":
      return "claude-code";
    case "codex":
    case "claude-codex:executor":
      return "codex";
    case "gemini":
      return "gemini";
    case "grok":
      return "grok";
    default:
      return null;
  }
}

const localCatalogLoads = new Map<string, Promise<AgentModelCatalogEntry[]>>();

function loadLocalCatalog(
  agentType: Exclude<AgentType, "claude-codex" | "lmstudio">,
  cwd: string,
): Promise<AgentModelCatalogEntry[]> {
  const key = `${agentType}:${cwd}`;
  const existing = localCatalogLoads.get(key);
  if (existing) return existing;

  const pending = getAgentModelCatalog(agentType, cwd);
  localCatalogLoads.set(key, pending);
  void pending.then(
    () => localCatalogLoads.delete(key),
    () => localCatalogLoads.delete(key),
  );
  return pending;
}

function toMissionModel(
  model: AgentModelCatalogEntry | ProviderModel,
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
  cwd = ".",
): Promise<MissionModelCatalog> {
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
        models: mergeMissionModels(models),
        note:
          models.length > 0
            ? null
            : "Start LM Studio and load a model to pin one here.",
      };
    } catch {
      return {
        models: [],
        note: "Start LM Studio to load models downloaded on this device.",
      };
    }
  }

  const localAgent = localAgentForTarget(target);
  if (localAgent) {
    try {
      const models = (await loadLocalCatalog(localAgent, cwd)).map(
        toMissionModel,
      );
      return {
        models: mergeMissionModels(models),
        note:
          models.length > 0
            ? null
            : `The installed ${localAgent} CLI reported no selectable models. System default remains available.`,
      };
    } catch {
      return {
        models: [],
        note: `The installed ${localAgent} CLI model catalog could not be loaded. System default remains available.`,
      };
    }
  }

  return { models: [], note: null };
}
