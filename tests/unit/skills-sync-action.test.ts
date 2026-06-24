// ABOUTME: Tests skillsStore sync-status decision + the syncInstalledSkill consent gate (#2613).
// ABOUTME: The composer Sync button relies on skillNeedsSync; the confirm popup must gate every overwrite.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfirm = vi.hoisted(() => vi.fn().mockResolvedValue(true));

const mockSkillsService = vi.hoisted(() => ({
  fetchAllSkills: vi.fn().mockResolvedValue([]),
  fetchOwnedSkills: vi.fn().mockResolvedValue([]),
  listAllInstalled: vi.fn().mockResolvedValue([]),
  backfillSyncState: vi.fn().mockResolvedValue(0),
  inspectSyncStatus: vi.fn().mockResolvedValue(null),
  refreshInstalledSkill: vi
    .fn()
    .mockResolvedValue({ installed: {}, syncStatus: null }),
  isUpstreamManagedSkill: vi.fn().mockReturnValue(true),
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mockConfirm,
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

function installedSkill(slug: string) {
  return {
    id: `local:${slug}`,
    slug,
    name: slug,
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
  };
}

function status(overrides: Record<string, unknown>) {
  return {
    state: "current",
    updateAvailable: false,
    hasLocalChanges: false,
    syncedRevision: "abc123",
    remoteRevision: null,
    changedLocalFiles: [],
    localManagedState: {},
    missingManagedFiles: [],
    ...overrides,
  };
}

describe("skillNeedsSync decides whether the composer Sync button shows (#2613)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it.each([
    ["update-available", { state: "update-available", updateAvailable: true }],
    ["local edits", { state: "local-changes", hasLocalChanges: true }],
    ["bootstrap-required", { state: "bootstrap-required" }],
  ])("returns true for %s", async (_label, overrides) => {
    const skill = installedSkill("demo");
    mockSkillsService.inspectSyncStatus.mockResolvedValue(status(overrides));

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.loadSyncStatus(skill);

    expect(skillsStore.skillNeedsSync(skill)).toBe(true);
  });

  it("returns false for a current skill", async () => {
    const skill = installedSkill("demo");
    mockSkillsService.inspectSyncStatus.mockResolvedValue(
      status({ state: "current" }),
    );

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.loadSyncStatus(skill);

    expect(skillsStore.skillNeedsSync(skill)).toBe(false);
  });

  it("returns false when the skill has never been inspected", async () => {
    const skill = installedSkill("unseen");
    const { skillsStore } = await import("@/stores/skills.store");

    expect(skillsStore.skillNeedsSync(skill)).toBe(false);
  });

  it("caches null without a network call for non-upstream skills", async () => {
    const skill = installedSkill("local-only");
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(false);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.loadSyncStatus(skill);

    expect(mockSkillsService.inspectSyncStatus).not.toHaveBeenCalled();
    expect(skillsStore.skillNeedsSync(skill)).toBe(false);
  });
});

describe("syncInstalledSkill gates every overwrite on confirmation (#2613)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockConfirm.mockResolvedValue(true);
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(true);
  });

  it("refreshes after the user confirms, passing the verified baseline", async () => {
    const skill = installedSkill("demo");
    const synced = status({ state: "update-available", updateAvailable: true });
    mockSkillsService.inspectSyncStatus.mockResolvedValue(synced);
    mockSkillsService.refreshInstalledSkill.mockResolvedValue({
      installed: skill,
      syncStatus: status({ state: "current" }),
    });

    const { skillsStore } = await import("@/stores/skills.store");
    const result = await skillsStore.syncInstalledSkill(skill);

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockSkillsService.refreshInstalledSkill).toHaveBeenCalledWith(skill, {
      expectedLocalManagedState: synced.localManagedState,
    });
    expect(result.outcome).toBe("synced");
  });

  it("does NOT overwrite when the user cancels the confirmation", async () => {
    const skill = installedSkill("demo");
    mockSkillsService.inspectSyncStatus.mockResolvedValue(
      status({ state: "local-changes", hasLocalChanges: true }),
    );
    mockConfirm.mockResolvedValue(false);

    const { skillsStore } = await import("@/stores/skills.store");
    const result = await skillsStore.syncInstalledSkill(skill);

    expect(mockSkillsService.refreshInstalledSkill).not.toHaveBeenCalled();
    expect(result.outcome).toBe("cancelled");
  });

  it("blocks the sync and reports untracked skills without a refresh", async () => {
    const skill = installedSkill("demo");
    mockSkillsService.inspectSyncStatus.mockResolvedValue(null);

    const { skillsStore } = await import("@/stores/skills.store");
    const result = await skillsStore.syncInstalledSkill(skill);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSkillsService.refreshInstalledSkill).not.toHaveBeenCalled();
    expect(result.outcome).toBe("untracked");
  });

  it("blocks the sync when the sync state could not be verified", async () => {
    const skill = installedSkill("demo");
    mockSkillsService.inspectSyncStatus.mockResolvedValue(
      status({ state: "error", error: "boom" }),
    );

    const { skillsStore } = await import("@/stores/skills.store");
    const result = await skillsStore.syncInstalledSkill(skill);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSkillsService.refreshInstalledSkill).not.toHaveBeenCalled();
    expect(result.outcome).toBe("error");
  });
});
