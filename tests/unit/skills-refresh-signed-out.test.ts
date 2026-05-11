// ABOUTME: Regression test that refreshAvailable populates the public catalog
// ABOUTME: when the auth store reports signed-out. Guards against #1860.

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

const mockAuthState = vi.hoisted(() => ({
  isAuthenticated: false,
}));

vi.mock("solid-js/store", () => ({
  createStore: <T extends Record<string, unknown>>(initial: T) => {
    const state = { ...initial } as Record<string, unknown>;
    const setState = (...args: unknown[]) => {
      if (args.length === 2 && typeof args[0] === "string") {
        state[args[0] as string] = args[1];
      }
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
  authStore: mockAuthState,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.isAuthenticated = false;
});

describe("skillsStore.refreshAvailable when signed out (#1860)", () => {
  it("fetches the public catalog even when the user is not authenticated", async () => {
    mockSkillsService.fetchAllSkills.mockResolvedValueOnce([
      {
        id: "seren:public-skill",
        slug: "public-skill",
        name: "Public Skill",
        description: "Visible without sign-in",
        source: "seren",
        sourceUrl: "seren-skills:public-skill",
        tags: [],
      },
    ]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshAvailable();

    expect(mockSkillsService.fetchAllSkills).toHaveBeenCalledTimes(1);
  });
});
