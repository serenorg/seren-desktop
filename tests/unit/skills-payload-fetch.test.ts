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
