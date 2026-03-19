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

describe("skills.inspectSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks backfilled upstream skills as bootstrap-required when no local drift exists", async () => {
    const commitSha = "1234567890abcdef1234567890abcdef12345678";
    mockAppFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ sha: commitSha }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: "https://github.com/serenorg/seren-skills/commit/1234567",
          commit: {
            message: "Add missing runtime files",
            committer: { date: "2026-03-18T00:00:00Z" },
          },
          files: [{ filename: "polymarket-maker-rebate-bot/SKILL.md" }],
        }),
      });

    const { skills } = await import("@/services/skills");
    vi.spyOn(skills, "readContent").mockResolvedValue("skill body");

    const status = await skills.inspectSyncStatus({
      slug: "polymarket-maker-rebate-bot",
      name: "Polymarket Maker Rebate Bot",
      description: "desc",
      id: "local:polymarket-maker-rebate-bot",
      source: "local",
      tags: [],
      scope: "seren",
      skillsDir: "/skills",
      dirName: "polymarket-maker-rebate-bot",
      path: "/skills/polymarket-maker-rebate-bot/SKILL.md",
      installedAt: 1,
      enabled: true,
      contentHash: "hash",
      upstreamSource: "serenorg",
      upstreamSourceUrl:
        "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket-maker-rebate-bot/SKILL.md",
      syncState: {
        version: 1,
        upstreamSource: "serenorg",
        upstreamSourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket-maker-rebate-bot/SKILL.md",
        syncedRevision: null,
        syncedAt: 1,
        managedFiles: { "SKILL.md": "1f42523adcc9a31dd7b8ab3b36f098c6a87e7fc7e0760fb3ea7be7cb93420d0d" },
      },
    });

    expect(status).toMatchObject({
      state: "bootstrap-required",
      updateAvailable: false,
      hasLocalChanges: false,
      syncedRevision: null,
      remoteRevision: {
        sha: commitSha,
        shortSha: commitSha.slice(0, 7),
      },
    });
  });
});
