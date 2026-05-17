// ABOUTME: Critical tests for the skill-install race fix (#1917).
// ABOUTME: Verifies failed-payload skills are filtered from slash-command matching
// ABOUTME: and from system-prompt injection so the agent never sees a partially-installed skill.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSkillsService = vi.hoisted(() => ({
  fetchAllSkills: vi.fn().mockResolvedValue([]),
  fetchOwnedSkills: vi.fn().mockResolvedValue([]),
  listAllInstalled: vi.fn().mockResolvedValue([]),
  backfillSyncState: vi.fn().mockResolvedValue(0),
  inspectSyncStatus: vi.fn().mockResolvedValue({ updateAvailable: false }),
  refreshInstalledSkill: vi.fn().mockResolvedValue({ installed: {}, syncStatus: null }),
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

describe("skill-install race fix (#1917)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("matchSkillCommand returns null for a skill flagged payloadStatus='failed'", async () => {
    const failed = installedSkill("prophet-arb-bot", {
      payloadStatus: "failed",
      missingPayloadFiles: ["scripts/agent.py"],
    });
    mockSkillsService.listAllInstalled.mockResolvedValue([failed]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { matchSkillCommand } = await import("@/lib/commands/parser");
    const match = matchSkillCommand("/prophet-arb-bot");

    expect(match).toBeNull();
  });

  it("matchSkillCommand returns the skill normally when payloadStatus is 'ready' or absent", async () => {
    const ready = installedSkill("prophet-arb-bot", { payloadStatus: "ready" });
    const legacy = installedSkill("legacy-skill"); // payloadStatus undefined — back-compat
    mockSkillsService.listAllInstalled.mockResolvedValue([ready, legacy]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();

    const { matchSkillCommand } = await import("@/lib/commands/parser");

    expect(matchSkillCommand("/prophet-arb-bot")?.skill.slug).toBe("prophet-arb-bot");
    expect(matchSkillCommand("/legacy-skill")?.skill.slug).toBe("legacy-skill");
  });

  it("resolveSkillCommand refreshes installed skills before letting a slash skill fall through", async () => {
    const ready = installedSkill("prophet-arb-bot", { payloadStatus: "ready" });
    mockSkillsService.listAllInstalled.mockResolvedValue([ready]);

    const { matchSkillCommand, resolveSkillCommand } = await import(
      "@/lib/commands/parser"
    );

    expect(matchSkillCommand("/prophet-arb-bot")).toBeNull();

    const match = await resolveSkillCommand("/prophet-arb-bot");

    expect(mockSkillsService.listAllInstalled).toHaveBeenCalledTimes(1);
    expect(match?.skill.slug).toBe("prophet-arb-bot");
  });

  it("getThreadSkills filters out skills with payloadStatus='failed' so the system prompt never sees them", async () => {
    const ready = installedSkill("ready-skill", { payloadStatus: "ready" });
    const failed = installedSkill("prophet-arb-bot", {
      payloadStatus: "failed",
      missingPayloadFiles: ["scripts/agent.py"],
    });
    mockSkillsService.listAllInstalled.mockResolvedValue([ready, failed]);
    mockSkillsService.readProjectConfig.mockResolvedValue({
      version: 1,
      skills: { enabled: ["seren:ready-skill", "seren:prophet-arb-bot"] },
    });
    mockSkillsService.getThreadSkills.mockResolvedValue(null);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();
    await skillsStore.ensureContextLoaded("/test/project", "thread-1");

    const effective = skillsStore.getThreadSkills("/test/project", "thread-1");

    const slugs = effective.map((s) => s.slug);
    expect(slugs).toContain("ready-skill");
    expect(slugs).not.toContain("prophet-arb-bot");
  });
});
