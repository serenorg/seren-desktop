// ABOUTME: Tests that skill payload file fetching fails loudly on network errors.
// ABOUTME: Prevents silent fallback to stale tree cache during install/refresh (#1215).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAppFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fetch", () => ({
  appFetch: mockAppFetch,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/services/catalog", () => ({
  catalog: {},
}));

describe("fetchRepoSkillPayloadFiles stale cache prevention (#1215)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("throws when tree API fetch fails instead of using stale cache", async () => {
    // First call: SKILL.md fetch succeeds
    // Second call: tree API fetch fails (network error)
    // Third call: revision fetch succeeds
    mockAppFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "---\nname: Test Skill\n---\nContent",
      })
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ sha: "abc123" }],
      });

    const { skills } = await import("@/services/skills");

    // refreshInstalledSkill calls fetchUpstreamSkillBundle which calls
    // fetchRepoSkillPayloadFiles. If the tree fetch fails, the whole
    // refresh must fail — not silently succeed with stale files.
    await expect(
      skills.refreshInstalledSkill({
        slug: "test-skill",
        name: "Test Skill",
        description: "desc",
        id: "local:test-skill",
        source: "local",
        tags: [],
        scope: "seren",
        skillsDir: "/skills",
        dirName: "test-skill",
        path: "/skills/test-skill/SKILL.md",
        installedAt: 1,
        enabled: true,
        contentHash: "hash",
        upstreamSource: "serenorg",
        upstreamSourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
        syncState: {
          version: 1,
          upstreamSource: "serenorg",
          upstreamSourceUrl:
            "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
          syncedRevision: "old-sha",
          syncedAt: 1,
          managedFiles: { "SKILL.md": "oldhash" },
        },
      }),
    ).rejects.toThrow();
  });

  it("throws when any individual payload file fails to fetch (#1293)", async () => {
    // Simulates the serendb_storage.py bug: tree has 3 files, but one
    // returns HTTP 500. The sync must abort — not silently proceed with
    // 2/3 files and wipe the missing one from the runtime directory.
    const treeWithFiles = [
      { path: "test/skill/agent.py", type: "blob" },
      { path: "test/skill/config.json", type: "blob" },
      { path: "test/skill/serendb_storage.py", type: "blob" },
    ];

    mockAppFetch.mockImplementation(async (url: string) => {
      // SKILL.md content
      if (url.includes("/SKILL.md")) {
        return { ok: true, text: async () => "---\nname: Test Skill\n---\nContent" };
      }
      // Tree API
      if (url.includes("git/trees/")) {
        return { ok: true, json: async () => ({ tree: treeWithFiles }) };
      }
      // Commits list API
      if (url.includes("/commits?")) {
        return { ok: true, json: async () => [{ sha: "abc123" }] };
      }
      // Commit detail API
      if (url.includes("/commits/abc123")) {
        return {
          ok: true,
          json: async () => ({ commit: { committer: { date: "2026-01-01" }, message: "test" } }),
        };
      }
      // Raw file fetches — fail serendb_storage.py
      if (url.includes("serendb_storage.py")) {
        return { ok: false, status: 500 };
      }
      return { ok: true, text: async () => "file content" };
    });

    const { skills } = await import("@/services/skills");

    await expect(
      skills.refreshInstalledSkill({
        slug: "test-skill",
        name: "Test Skill",
        description: "desc",
        id: "local:test-skill",
        source: "local",
        tags: [],
        scope: "seren",
        skillsDir: "/skills",
        dirName: "test-skill",
        path: "/skills/test-skill/SKILL.md",
        installedAt: 1,
        enabled: true,
        contentHash: "hash",
        upstreamSource: "serenorg",
        upstreamSourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
        syncState: {
          version: 1,
          upstreamSource: "serenorg",
          upstreamSourceUrl:
            "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
          syncedRevision: "old-sha",
          syncedAt: 1,
          managedFiles: { "SKILL.md": "oldhash" },
        },
      }),
    ).rejects.toThrow(/Failed to fetch.*payload files/);
  });

  it("throws when tree API returns non-OK status", async () => {
    mockAppFetch
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "---\nname: Test Skill\n---\nContent",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ sha: "abc123" }],
      });

    const { skills } = await import("@/services/skills");

    await expect(
      skills.refreshInstalledSkill({
        slug: "test-skill",
        name: "Test Skill",
        description: "desc",
        id: "local:test-skill",
        source: "local",
        tags: [],
        scope: "seren",
        skillsDir: "/skills",
        dirName: "test-skill",
        path: "/skills/test-skill/SKILL.md",
        installedAt: 1,
        enabled: true,
        contentHash: "hash",
        upstreamSource: "serenorg",
        upstreamSourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
        syncState: {
          version: 1,
          upstreamSource: "serenorg",
          upstreamSourceUrl:
            "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md",
          syncedRevision: "old-sha",
          syncedAt: 1,
          managedFiles: { "SKILL.md": "oldhash" },
        },
      }),
    ).rejects.toThrow(/Failed to fetch repo tree/);
  });
});
