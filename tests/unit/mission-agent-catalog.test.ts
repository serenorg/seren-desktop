// ABOUTME: Protects Mission Control's complete agent roster and safe model choices.
// ABOUTME: Ensures launch controls use named system catalogs instead of free-form IDs.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  testLmStudioConnection: vi.fn(async () => ({ ok: true, models: [] })),
}));
vi.mock("@/services/seren-model-catalog", () => ({
  getLiveSerenModelCatalog: vi.fn(async () => []),
}));
vi.mock("@/stores/agent.store", () => ({
  agentStore: { sessions: {} },
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

  it("provides named built-in choices for each bundled local runtime", async () => {
    await expect(loadMissionModelCatalog("claude-code")).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "claude-opus-4-8[1m]" }),
      ]),
    });
    await expect(loadMissionModelCatalog("codex")).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-sol" }),
      ]),
    });
    await expect(loadMissionModelCatalog("gemini")).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gemini-2.5-pro" }),
      ]),
    });
    await expect(loadMissionModelCatalog("grok")).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "grok-4.5" })],
    });
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
