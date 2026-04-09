// ABOUTME: Tests that skill payload file fetching fails loudly on network errors.
// ABOUTME: Prevents silent fallback to stale tree cache during install/refresh
// ABOUTME: (#1215, #1293, #1515 — R2 as sole source of truth for tree/revision).

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

  it("throws when R2 index fetch fails instead of using stale cache", async () => {
    // SKILL.md fetch succeeds; R2 index fetch fails with a network error.
    // Every other fetch is an R2 index retry that also fails, so the whole
    // refresh aborts rather than silently succeeding with stale cached files.
    mockAppFetch.mockImplementation(async (url: string) => {
      if (url.includes("/SKILL.md")) {
        return {
          ok: true,
          text: async () => "---\nname: Test Skill\n---\nContent",
        };
      }
      if (url.includes("/skills/index.json")) {
        throw new Error("Network error");
      }
      throw new Error(`Unexpected fetch: ${url}`);
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
    const testSkillSourceUrl =
      "https://raw.githubusercontent.com/serenorg/seren-skills/main/test/skill/SKILL.md";

    mockAppFetch.mockImplementation(async (url: string) => {
      // SKILL.md content (cache-busted sourceUrl)
      if (url.startsWith(testSkillSourceUrl)) {
        return {
          ok: true,
          text: async () => "---\nname: Test Skill\n---\nContent",
        };
      }
      // R2 skills index — provides tree + revision in a single payload (#1515)
      if (url.includes("/skills/index.json")) {
        return {
          ok: true,
          json: async () => ({
            version: "2",
            updatedAt: "2026-01-01T00:00:00Z",
            skills: [
              {
                slug: "test-skill",
                name: "Test Skill",
                description: "desc",
                source: "serenorg",
                sourceUrl: testSkillSourceUrl,
                tags: [],
                lastModified: "2026-01-01T00:00:00Z",
              },
            ],
            tree: [
              "test/skill/SKILL.md",
              "test/skill/agent.py",
              "test/skill/config.json",
              "test/skill/serendb_storage.py",
            ],
          }),
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

  it("throws when R2 index returns non-OK status", async () => {
    // SKILL.md fetches succeed; R2 index fetch returns 403 (e.g. bucket ACL
    // misconfiguration). The refresh must abort, not silently succeed with
    // stale cached files.
    mockAppFetch.mockImplementation(async (url: string) => {
      if (url.includes("/SKILL.md")) {
        return {
          ok: true,
          text: async () => "---\nname: Test Skill\n---\nContent",
        };
      }
      if (url.includes("/skills/index.json")) {
        return { ok: false, status: 403 };
      }
      throw new Error(`Unexpected fetch: ${url}`);
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
