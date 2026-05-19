// ABOUTME: Pins the slash-palette contract: skills first, fuzzy ranking, built-in
// ABOUTME: shadow safety (a skill named `clear` cannot replace the `/clear` builtin).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSkillsService = vi.hoisted(() => ({
  fetchAllSkills: vi.fn().mockResolvedValue([]),
  fetchOwnedSkills: vi.fn().mockResolvedValue([]),
  listAllInstalled: vi.fn().mockResolvedValue([]),
  backfillSyncState: vi.fn().mockResolvedValue(0),
  inspectSyncStatus: vi.fn().mockResolvedValue({ updateAvailable: false }),
  refreshInstalledSkill: vi
    .fn()
    .mockResolvedValue({ installed: {}, syncStatus: null }),
  isUpstreamManagedSkill: vi.fn().mockReturnValue(false),
  renameSkillDir: vi.fn().mockResolvedValue("/skills/renamed/SKILL.md"),
  clearCache: vi.fn(),
  install: vi.fn(),
  readProjectConfig: vi.fn().mockResolvedValue(null),
  writeProjectConfig: vi.fn().mockResolvedValue(undefined),
  clearProjectConfig: vi.fn().mockResolvedValue(undefined),
  getThreadSkills: vi.fn().mockResolvedValue(null),
  setThreadSkills: vi.fn().mockResolvedValue(undefined),
  clearThreadSkills: vi.fn().mockResolvedValue(undefined),
  getEnabledSkillsContent: vi.fn().mockResolvedValue(""),
}));

vi.mock("solid-js/store", () => ({
  createStore: <T extends Record<string, unknown>>(initial: T) => {
    const state = { ...initial } as Record<string, unknown>;
    const setState = (key: string, value: unknown) => {
      state[key] = value;
    };
    return [state, setState];
  },
}));

vi.mock("@/stores/fileTree", () => ({
  getFileTreeState: () => ({ rootPath: "/test/project" }),
  get fileTreeState() {
    return { rootPath: "/test/project" };
  },
}));

vi.mock("@/stores/auth.store", () => ({
  authStore: { isAuthenticated: true },
  requestSignInModal: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/services/skills", () => {
  class SkillsApiError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "SkillsApiError";
      this.status = status;
    }
  }
  return {
    skills: {
      fetchAllSkills: mockSkillsService.fetchAllSkills,
      fetchOwnedSkills: mockSkillsService.fetchOwnedSkills,
      listAllInstalled: mockSkillsService.listAllInstalled,
      backfillSyncState: mockSkillsService.backfillSyncState,
      inspectSyncStatus: mockSkillsService.inspectSyncStatus,
      refreshInstalledSkill: mockSkillsService.refreshInstalledSkill,
      renameSkillDir: mockSkillsService.renameSkillDir,
      clearCache: mockSkillsService.clearCache,
      install: mockSkillsService.install,
      readProjectConfig: mockSkillsService.readProjectConfig,
      writeProjectConfig: mockSkillsService.writeProjectConfig,
      clearProjectConfig: mockSkillsService.clearProjectConfig,
      getThreadSkills: mockSkillsService.getThreadSkills,
      setThreadSkills: mockSkillsService.setThreadSkills,
      clearThreadSkills: mockSkillsService.clearThreadSkills,
      getEnabledSkillsContent: mockSkillsService.getEnabledSkillsContent,
    },
    isUpstreamManagedSkill: mockSkillsService.isUpstreamManagedSkill,
    SkillsApiError,
    isAuthStatus: (status: number | undefined) =>
      status === 401 || status === 403,
  };
});

function installedSkill(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `local:${slug}`,
    slug,
    name: slug,
    displayName: slug,
    description: "",
    source: "local" as const,
    tags: [],
    scope: "seren" as const,
    skillsDir: "/skills",
    dirName: slug,
    path: `/skills/${slug}/SKILL.md`,
    installedAt: 1,
    enabled: true,
    contentHash: "hash",
    ...overrides,
  };
}

describe("slash command palette ordering and fuzzy ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns a skill via a boundary match (`arb` -> `prophet-arb-bot`)", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("prophet-arb-bot"),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions } = await import("@/lib/commands/parser");
    const results = getCompletions("/arb", "chat");

    expect(results.map((r) => r.name)).toContain("prophet-arb-bot");
    expect(results.find((r) => r.name === "prophet-arb-bot")?.isSkill).toBe(
      true,
    );
  });

  it("returns a skill via an initials match (`pab` -> `prophet-arb-bot`)", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("prophet-arb-bot"),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions } = await import("@/lib/commands/parser");
    const results = getCompletions("/pab", "chat");

    expect(results.map((r) => r.name)).toContain("prophet-arb-bot");
  });

  it("uses the Seren catalog slug for managed installed skills with local slug drift", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("skill-creator", {
        name: "Skill Creator",
        dirName: "seren-skill-creator",
        upstreamSource: "seren",
        upstreamSourceUrl: "seren-skills:seren-skill-creator",
      }),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions, matchSkillCommand } = await import(
      "@/lib/commands/parser"
    );

    expect(matchSkillCommand("/seren-skill-creator make a skill")?.skill.slug).toBe(
      "skill-creator",
    );
    expect(getCompletions("/seren-skill", "chat").map((r) => r.name)).toContain(
      "seren-skill-creator",
    );
  });

  it("places skills before built-in commands in the completion list", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("model-arbitrage"),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions } = await import("@/lib/commands/parser");
    const results = getCompletions("/m", "chat");

    const skillIdx = results.findIndex((r) => r.isSkill);
    const builtinIdx = results.findIndex((r) => !r.isSkill);
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(builtinIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(builtinIdx);
  });

  it("does not let a skill shadow a built-in with the same name", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("clear"),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions } = await import("@/lib/commands/parser");
    const results = getCompletions("/clear", "chat");

    const clearEntries = results.filter((r) => r.name === "clear");
    expect(clearEntries).toHaveLength(1);
    expect(clearEntries[0]?.isSkill).toBeFalsy();
  });

  it("returns the empty list when there is no match anywhere", async () => {
    mockSkillsService.listAllInstalled.mockResolvedValue([
      installedSkill("prophet-arb-bot"),
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { getCompletions } = await import("@/lib/commands/parser");
    const results = getCompletions("/xyz123nomatch", "chat");

    expect(results).toEqual([]);
  });
});
