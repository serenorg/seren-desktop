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

const getAgentPermissionCatalog = vi.hoisted(() =>
  vi.fn(async (agentType: string) => ({
    defaultModeId: agentType === "lmstudio" ? "ask" : "native-default",
    modes:
      agentType === "lmstudio"
        ? [
            {
              modeId: "ask",
              name: "Suggest",
              description: "Ask before each tool call",
            },
            {
              modeId: "auto",
              name: "Auto",
              description: "Approve tool calls automatically",
            },
          ]
        : [
            {
              modeId: "native-default",
              name: `${agentType} Default`,
              description: `${agentType} default behavior`,
            },
          ],
  })),
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
  getAgentPermissionCatalog,
}));
vi.mock("@/services/seren-model-catalog", () => ({
  getLiveSerenModelCatalog: vi.fn(async () => []),
}));
vi.mock("@/stores/auth.store", () => ({
  authStore: { isAuthenticated: false, privateChatPolicy: null },
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) => {
      if (key === "lmStudioBaseUrl") return "http://localhost:1234";
      if (key === "agentApprovalPolicy") return "on-request";
      if (key === "agentSandboxMode") return "workspace-write";
      if (key === "agentNetworkEnabled") return true;
      return "";
    },
  },
}));

import {
  createEmptyMissionModelCatalogs,
  loadMissionPermissionCatalog,
  loadMissionModelCatalog,
  MISSION_AGENT_TYPES,
  MISSION_MODEL_TARGETS,
  mergeMissionModels,
  missionModelTargetsToLoad,
  resolveMissionModelSelection,
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
        loadMissionModelCatalog("lmstudio", "/workspace"),
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
      {
        models: [{ id: "lmstudio-cli-model", name: "lmstudio CLI model" }],
        note: null,
      },
    ]);

    expect(getAgentModelCatalog).toHaveBeenCalledTimes(5);
    expect(getAgentModelCatalog).toHaveBeenCalledWith(
      "lmstudio",
      "/workspace",
      {
        lmStudioBaseUrl: "http://localhost:1234",
        lmStudioApiKey: "",
      },
    );
  });

  it("pins the first downloaded LM Studio model as the runtime default", () => {
    const catalog = {
      models: [
        { id: "first-model", name: "First model" },
        { id: "second-model", name: "Second model" },
      ],
      note: null,
    };

    expect(resolveMissionModelSelection("lmstudio", "", catalog)).toBe(
      "first-model",
    );
    expect(
      resolveMissionModelSelection("lmstudio", "second-model", catalog),
    ).toBe("second-model");
    expect(resolveMissionModelSelection("codex", "", catalog)).toBe("");
  });

  it("retries only an unavailable LM Studio catalog after the initial load", () => {
    const catalogs = createEmptyMissionModelCatalogs();
    catalogs.codex.models = [{ id: "codex-model", name: "Codex model" }];

    expect(missionModelTargetsToLoad(null, false, catalogs)).toEqual(
      MISSION_MODEL_TARGETS,
    );
    expect(missionModelTargetsToLoad(false, false, catalogs)).toEqual([
      "lmstudio",
    ]);

    catalogs.lmstudio.models = [{ id: "local-model", name: "Local model" }];
    expect(missionModelTargetsToLoad(false, false, catalogs)).toEqual([]);
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

  it("uses LM Studio's native permission names and explains the settings default", async () => {
    await expect(loadMissionPermissionCatalog("lmstudio")).resolves.toEqual({
      options: [
        {
          value: "",
          label: "Agent Settings · Suggest",
          description:
            "Uses Agent Settings, currently Suggest: Ask before each tool call",
        },
        {
          value: "ask",
          label: "Suggest",
          description: "Ask before each tool call",
        },
        {
          value: "auto",
          label: "Auto",
          description: "Approve tool calls automatically",
        },
      ],
      note: null,
    });
    expect(getAgentPermissionCatalog).toHaveBeenCalledWith("lmstudio", {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      networkEnabled: true,
    });
  });

  it("keeps hosted permission policy fixed and out of the local runtime RPC", async () => {
    await expect(loadMissionPermissionCatalog("seren")).resolves.toEqual({
      options: [
        {
          value: "",
          label: "Review First",
          description:
            "External actions pause for review; this hosted mode is fixed.",
        },
      ],
      note: null,
    });
    expect(getAgentPermissionCatalog).not.toHaveBeenCalledWith(
      "seren",
      expect.anything(),
    );
  });

  it("uses Antigravity's product name when its model catalog is unavailable", async () => {
    getAgentModelCatalog.mockRejectedValueOnce(new Error("signed out"));

    await expect(loadMissionModelCatalog("gemini", "/workspace")).resolves.toEqual({
      models: [],
      note: "The installed Antigravity CLI model catalog could not be loaded. System default remains available.",
    });
  });

  it("keeps each runtime catalog isolated while live choices load", () => {
    const catalogs = createEmptyMissionModelCatalogs();

    catalogs.lmstudio.note = "LM Studio is not running";

    expect(catalogs.lmstudio).not.toBe(catalogs["claude-code"]);
    expect(catalogs["claude-code"].note).toBeNull();
    expect(catalogs.codex.note).toBeNull();
  });
});
