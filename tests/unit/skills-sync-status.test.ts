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
    const skillSourceUrl =
      "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket-maker-rebate-bot/SKILL.md";
    const lastModified = "2026-03-18T00:00:00Z";

    // R2 is the sole source of truth for revision metadata (#1515).
    // The synthetic revision SHA is the R2 lastModified ISO string itself.
    mockAppFetch.mockImplementation(async (url: string) => {
      if (url.includes("/skills/index.json")) {
        return {
          ok: true,
          json: async () => ({
            version: "2",
            updatedAt: lastModified,
            skills: [
              {
                slug: "polymarket-maker-rebate-bot",
                name: "Polymarket Maker Rebate Bot",
                description: "desc",
                source: "serenorg",
                sourceUrl: skillSourceUrl,
                tags: [],
                lastModified,
              },
            ],
            tree: ["polymarket-maker-rebate-bot/SKILL.md"],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
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
      upstreamSourceUrl: skillSourceUrl,
      syncState: {
        version: 1,
        upstreamSource: "serenorg",
        upstreamSourceUrl: skillSourceUrl,
        syncedRevision: null,
        syncedAt: 1,
        managedFiles: {
          "SKILL.md":
            "1f42523adcc9a31dd7b8ab3b36f098c6a87e7fc7e0760fb3ea7be7cb93420d0d",
        },
      },
    });

    expect(status).toMatchObject({
      state: "bootstrap-required",
      updateAvailable: false,
      hasLocalChanges: false,
      syncedRevision: null,
      remoteRevision: {
        sha: lastModified,
        shortSha: lastModified.slice(0, 10),
      },
    });
  });
});
