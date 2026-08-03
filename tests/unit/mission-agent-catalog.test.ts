// ABOUTME: Protects Mission Control's complete agent roster and safe model choices.
// ABOUTME: Ensures launch controls use named system catalogs instead of free-form IDs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const getAgentModelCatalog = vi.hoisted(() =>
  vi.fn(async (agentType: string) => [
    {
      modelId: `${agentType}-cli-model`,
      name: `${agentType} CLI model`,
    },
  ]),
);

vi.mock("@/services/organization-policy", () => ({
  allowsClaudeAgent: () => true,
  allowsCodexAgent: () => true,
  allowsGeminiAgent: () => true,
  allowsGrokAgent: () => true,
  allowsLmStudioAgent: () => true,
  allowsSerenPrivateAgent: () => true,
  allowsSerenPublicModels: () => true,
}));
vi.mock("@/services/private-models", () => ({
  privateModelsService: { listAvailable: vi.fn(async () => []) },
}));
vi.mock("@/services/providers", () => ({
  getAgentModelCatalog,
  testLmStudioConnection: vi.fn(async () => ({ ok: true, models: [] })),
}));
vi.mock("@/services/seren-model-catalog", () => ({
  getLiveSerenModelCatalog: vi.fn(async () => []),
}));
vi.mock("@/stores/auth.store", () => ({
  authStore: { isAuthenticated: false, privateChatPolicy: null },
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) =>
      key === "lmStudioBaseUrl" ? "http://localhost:1234" : "",
  },
}));

import {
  createEmptyMissionModelCatalogs,
  loadMissionModelCatalog,
  MISSION_AGENT_TYPES,
  mergeMissionModels,
} from "@/services/mission-agent-catalog";

describe("Mission Control agent catalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes every supported Mission Control agent", () => {
    expect(MISSION_AGENT_TYPES).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "grok",
      "seren",
      "seren-private",
      "claude-codex",
      "lmstudio",
    ]);
  });

  it("uses each local CLI catalog exactly, including paired roles", async () => {
    await expect(
      Promise.all([
        loadMissionModelCatalog("claude-code", "/workspace"),
        loadMissionModelCatalog("codex", "/workspace"),
        loadMissionModelCatalog("gemini", "/workspace"),
        loadMissionModelCatalog("grok", "/workspace"),
        loadMissionModelCatalog("claude-codex:planner", "/workspace"),
        loadMissionModelCatalog("claude-codex:executor", "/workspace"),
      ]),
    ).resolves.toEqual([
      {
        models: [
          { id: "claude-code-cli-model", name: "claude-code CLI model" },
        ],
        note: null,
      },
      {
        models: [{ id: "codex-cli-model", name: "codex CLI model" }],
        note: null,
      },
      {
        models: [{ id: "gemini-cli-model", name: "gemini CLI model" }],
        note: null,
      },
      {
        models: [{ id: "grok-cli-model", name: "grok CLI model" }],
        note: null,
      },
      {
        models: [
          { id: "claude-code-cli-model", name: "claude-code CLI model" },
        ],
        note: null,
      },
      {
        models: [{ id: "codex-cli-model", name: "codex CLI model" }],
        note: null,
      },
    ]);

    expect(getAgentModelCatalog).toHaveBeenCalledTimes(4);
  });

  it("deduplicates runtime and built-in choices without changing priority", () => {
    expect(
      mergeMissionModels(
        [{ id: "model-a", name: "Live name" }],
        [
          { id: "MODEL-A", name: "Fallback name" },
          { id: "model-b", name: "Second" },
        ],
      ),
    ).toEqual([
      { id: "model-a", name: "Live name" },
      { id: "model-b", name: "Second" },
    ]);
  });

  it("keeps each runtime catalog isolated while live choices load", () => {
    const catalogs = createEmptyMissionModelCatalogs();

    catalogs.lmstudio.note = "LM Studio is not running";

    expect(catalogs.lmstudio).not.toBe(catalogs["claude-code"]);
    expect(catalogs["claude-code"].note).toBeNull();
    expect(catalogs.codex.note).toBeNull();
  });
});
