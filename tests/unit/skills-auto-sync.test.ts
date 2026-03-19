// ABOUTME: Test that refresh() auto-refreshes stale upstream-managed skills.
// ABOUTME: Verifies the fix for #1155 — skills must not stay stale after startup/periodic refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstalled = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mockAvailable = vi.hoisted(() => [] as Array<Record<string, unknown>>);

const mockSkillsService = vi.hoisted(() => ({
  fetchAllSkills: vi.fn().mockResolvedValue([]),
  listAllInstalled: vi.fn().mockResolvedValue([]),
  backfillSyncState: vi.fn().mockResolvedValue(0),
  inspectSyncStatus: vi.fn().mockResolvedValue({ updateAvailable: false }),
  refreshInstalledSkill: vi.fn().mockResolvedValue({ installed: {}, syncStatus: null }),
  isUpstreamManagedSkill: vi.fn().mockReturnValue(false),
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

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/services/skills", () => ({
  skills: {
    fetchAllSkills: mockSkillsService.fetchAllSkills,
    listAllInstalled: mockSkillsService.listAllInstalled,
    backfillSyncState: mockSkillsService.backfillSyncState,
    inspectSyncStatus: mockSkillsService.inspectSyncStatus,
    refreshInstalledSkill: mockSkillsService.refreshInstalledSkill,
  },
  isUpstreamManagedSkill: mockSkillsService.isUpstreamManagedSkill,
}));

describe("skills auto-sync on refresh (#1155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls refreshInstalledSkill when an upstream-managed skill has updateAvailable", async () => {
    const staleSkill = {
      slug: "polymarket-maker-rebate-bot",
      scope: "serenorg" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "serenorg/seren-skills", syncedRevision: "abc123", syncedAt: 1, managedFiles: {} },
    };

    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([staleSkill]);
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(true);
    mockSkillsService.inspectSyncStatus.mockResolvedValue({ updateAvailable: true, syncedRevision: "abc123" });
    mockSkillsService.refreshInstalledSkill.mockResolvedValue({ installed: staleSkill, syncStatus: null });

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh();

    expect(mockSkillsService.inspectSyncStatus).toHaveBeenCalledWith(staleSkill);
    expect(mockSkillsService.refreshInstalledSkill).toHaveBeenCalledWith(staleSkill);
  });

  it("calls refreshInstalledSkill when an upstream-managed skill needs bootstrap refresh", async () => {
    const backfilledSkill = {
      slug: "polymarket-maker-rebate-bot",
      scope: "serenorg" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "serenorg/seren-skills", syncedRevision: null, syncedAt: 1, managedFiles: { "SKILL.md": "hash" } },
    };

    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([backfilledSkill]);
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(true);
    mockSkillsService.inspectSyncStatus.mockResolvedValue({
      state: "bootstrap-required",
      updateAvailable: false,
      hasLocalChanges: false,
      syncedRevision: null,
    });
    mockSkillsService.refreshInstalledSkill.mockResolvedValue({ installed: backfilledSkill, syncStatus: null });

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh();

    expect(mockSkillsService.inspectSyncStatus).toHaveBeenCalledWith(backfilledSkill);
    expect(mockSkillsService.refreshInstalledSkill).toHaveBeenCalledWith(backfilledSkill);
  });

  it("does not auto-refresh when local managed files have changed", async () => {
    const editedSkill = {
      slug: "polymarket-maker-rebate-bot",
      scope: "serenorg" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "serenorg/seren-skills", syncedRevision: "abc123", syncedAt: 1, managedFiles: { "SKILL.md": "hash" } },
    };

    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([editedSkill]);
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(true);
    mockSkillsService.inspectSyncStatus.mockResolvedValue({
      state: "local-changes",
      updateAvailable: true,
      hasLocalChanges: true,
      syncedRevision: "abc123",
    });

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh();

    expect(mockSkillsService.inspectSyncStatus).toHaveBeenCalledWith(editedSkill);
    expect(mockSkillsService.refreshInstalledSkill).not.toHaveBeenCalled();
  });
});
