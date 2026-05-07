// ABOUTME: Test that refresh() auto-refreshes stale upstream-managed skills.
// ABOUTME: Verifies concurrency guard (#1289), summary tracking, #1155, and #1558.

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

const mockAuthState = vi.hoisted(() => ({
  isAuthenticated: true,
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
  mockAuthState.isAuthenticated = true;
});

function installedSkill(slug: string) {
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
  };
}

describe("skills auto-sync on refresh (#1155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls refreshInstalledSkill when an upstream-managed skill has updateAvailable", async () => {
    const staleSkill = {
      slug: "polymarket-maker-rebate-bot",
      scope: "seren" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "seren", syncedRevision: "abc123", syncedAt: 1, managedFiles: {} },
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
      scope: "seren" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "seren", syncedRevision: null, syncedAt: 1, managedFiles: { "SKILL.md": "hash" } },
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
      scope: "seren" as const,
      path: "/skills/polymarket-maker-rebate-bot",
      syncState: { upstreamSource: "seren", syncedRevision: "abc123", syncedAt: 1, managedFiles: { "SKILL.md": "hash" } },
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

describe("refresh() concurrency guard and summary (#1289)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("concurrent refresh() calls coalesce into a single execution", async () => {
    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([]);

    const { skillsStore } = await import("@/stores/skills.store");

    const [r1, r2, r3] = await Promise.all([
      skillsStore.refresh(true),
      skillsStore.refresh(true),
      skillsStore.refresh(true),
    ]);

    // All three callers get a result
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();

    // But the underlying fetch only ran once
    expect(mockSkillsService.fetchAllSkills).toHaveBeenCalledTimes(1);
  });

  it("returns accurate summary counts", async () => {
    const updatedSkill = {
      slug: "skill-a",
      scope: "seren" as const,
      path: "/skills/skill-a",
      syncState: { upstreamSource: "seren", syncedRevision: "aaa", syncedAt: 1, managedFiles: {} },
    };
    const currentSkill = {
      slug: "skill-b",
      scope: "seren" as const,
      path: "/skills/skill-b",
      syncState: { upstreamSource: "seren", syncedRevision: "bbb", syncedAt: 1, managedFiles: {} },
    };
    const failingSkill = {
      slug: "skill-c",
      scope: "seren" as const,
      path: "/skills/skill-c",
      syncState: { upstreamSource: "seren", syncedRevision: "ccc", syncedAt: 1, managedFiles: {} },
    };

    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([updatedSkill, currentSkill, failingSkill]);
    mockSkillsService.isUpstreamManagedSkill.mockReturnValue(true);
    mockSkillsService.inspectSyncStatus
      .mockResolvedValueOnce({ updateAvailable: true, hasLocalChanges: false })
      .mockResolvedValueOnce({ updateAvailable: false, hasLocalChanges: false, state: "current" })
      .mockRejectedValueOnce(new Error("Failed to fetch remote revision: 403"));
    mockSkillsService.refreshInstalledSkill.mockResolvedValue({ installed: updatedSkill, syncStatus: null });

    const { skillsStore } = await import("@/stores/skills.store");
    const summary = await skillsStore.refresh();

    expect(summary).toEqual({ updated: 1, alreadyCurrent: 1, failed: 1 });
  });

  it("allows a new refresh after the previous one completes", async () => {
    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([]);

    const { skillsStore } = await import("@/stores/skills.store");

    await skillsStore.refresh(true);
    await skillsStore.refresh(true);

    // Two sequential calls should each execute
    expect(mockSkillsService.fetchAllSkills).toHaveBeenCalledTimes(2);
  });

  it("skips owned private skill refresh while signed out", async () => {
    mockAuthState.isAuthenticated = false;
    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh(true);

    expect(mockSkillsService.fetchOwnedSkills).not.toHaveBeenCalled();
  });
});

describe("clearCacheAndRefresh runs full sync (#1558)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("runs installed-skill sync, not just catalog refresh", async () => {
    mockSkillsService.fetchAllSkills.mockResolvedValue([]);
    mockSkillsService.listAllInstalled.mockResolvedValue([]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.clearCacheAndRefresh();

    expect(mockSkillsService.clearCache).toHaveBeenCalled();
    expect(mockSkillsService.listAllInstalled).toHaveBeenCalled();
  });
});

describe("setAvailableCatalog merge keeps bulk-fetched entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not drop entries that are absent from a paginated update", async () => {
    const bulk = [
      { id: "seren:a", slug: "a", name: "A", description: "", source: "seren" as const, sourceUrl: "seren-skills:a", tags: [] },
      { id: "seren:b", slug: "b", name: "B", description: "", source: "seren" as const, sourceUrl: "seren-skills:b", tags: [] },
      { id: "seren:c", slug: "c", name: "C", description: "", source: "seren" as const, sourceUrl: "seren-skills:c", tags: [] },
    ];
    mockSkillsService.fetchAllSkills.mockResolvedValue(bulk);
    mockSkillsService.listAllInstalled.mockResolvedValue([]);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh(true);
    expect(skillsStore.available).toHaveLength(3);

    skillsStore.setAvailableCatalog([bulk[0], bulk[1]]);
    expect(skillsStore.available.map((s) => s.id).sort()).toEqual([
      "seren:a",
      "seren:b",
      "seren:c",
    ]);
  });

  it("clears remote catalog entries on reset", async () => {
    const privateSkill = {
      id: "seren:private",
      slug: "private",
      name: "Private",
      description: "",
      source: "seren" as const,
      sourceUrl: "seren-skills:private",
      tags: [],
      publisher: {
        createdByUserId: "user-1",
        ownerUserId: "user-1",
        visibility: "private" as const,
        discoverability: "unlisted" as const,
        publishStatus: "published" as const,
      },
    };

    const { skillsStore } = await import("@/stores/skills.store");
    skillsStore.setAvailableCatalog([privateSkill]);
    expect(skillsStore.available).toHaveLength(1);

    skillsStore.resetRemoteCatalog();

    expect(skillsStore.available).toHaveLength(0);
    expect(skillsStore.selectedId).toBeNull();
  });
});

describe("install coalesces concurrent calls for the same scope+slug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("returns the same promise for two concurrent calls and only invokes the service once", async () => {
    const installed = {
      slug: "demo",
      dirName: "demo",
      scope: "seren" as const,
      source: "local",
      path: "/skills/demo/SKILL.md",
    };
    let resolveInstall: (value: typeof installed) => void = () => {};
    mockSkillsService.install.mockImplementation(
      () =>
        new Promise<typeof installed>((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const skillInput = {
      id: "seren:demo",
      slug: "demo",
      name: "Demo",
      description: "",
      source: "seren" as const,
      sourceUrl: "seren-skills:demo",
      tags: [],
    };

    const { skillsStore } = await import("@/stores/skills.store");
    const first = skillsStore.install(skillInput, "# body", "seren");
    const second = skillsStore.install(skillInput, "# body", "seren");
    resolveInstall(installed);
    const [a, b] = await Promise.all([first, second]);

    expect(mockSkillsService.install).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(skillsStore.installed.filter((s) => s.path === installed.path)).toHaveLength(1);
  });
});

describe("thread skill attach/detach materializes effective defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("adds a thread skill without dropping inherited project defaults", async () => {
    const base = installedSkill("base");
    const extra = installedSkill("extra");
    mockSkillsService.listAllInstalled.mockResolvedValue([base, extra]);
    mockSkillsService.readProjectConfig.mockResolvedValue({
      version: 1,
      skills: { enabled: ["seren:base"] },
    });
    mockSkillsService.getThreadSkills.mockResolvedValue(null);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();
    await skillsStore.attachSkillToThread(
      "/test/project",
      "thread-1",
      extra.path,
    );

    expect(mockSkillsService.setThreadSkills).toHaveBeenCalledWith(
      "/test/project",
      "thread-1",
      ["seren:base", "seren:extra"],
    );
  });

  it("detaches from inherited defaults by writing an explicit thread override", async () => {
    const base = installedSkill("base");
    const extra = installedSkill("extra");
    mockSkillsService.listAllInstalled.mockResolvedValue([base, extra]);
    mockSkillsService.readProjectConfig.mockResolvedValue({
      version: 1,
      skills: { enabled: ["seren:base", "seren:extra"] },
    });
    mockSkillsService.getThreadSkills.mockResolvedValue(null);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refreshInstalled();
    await skillsStore.detachSkillFromThread(
      "/test/project",
      "thread-1",
      extra.path,
    );

    expect(mockSkillsService.setThreadSkills).toHaveBeenCalledWith(
      "/test/project",
      "thread-1",
      ["seren:base"],
    );
  });

});

describe("backfill triggers for slug/dirName mismatch (#1558)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("triggers backfill when installed slug differs from marketplace slug but dirName matches", async () => {
    const installedSkill = {
      slug: "saas-short-trader",
      dirName: "alpaca-saas-short-trader",
      scope: "seren" as const,
      source: "seren",
      path: "/skills/alpaca-saas-short-trader/SKILL.md",
      syncState: undefined,
    };
    const catalogEntry = {
      slug: "alpaca-saas-short-trader",
      source: "seren",
      sourceUrl: "seren-skills:alpaca-saas-short-trader",
    };

    mockSkillsService.fetchAllSkills.mockResolvedValue([catalogEntry]);
    mockSkillsService.listAllInstalled.mockResolvedValue([installedSkill]);
    mockSkillsService.backfillSyncState.mockResolvedValue(1);

    const { skillsStore } = await import("@/stores/skills.store");
    await skillsStore.refresh();

    expect(mockSkillsService.backfillSyncState).toHaveBeenCalled();
  });
});
