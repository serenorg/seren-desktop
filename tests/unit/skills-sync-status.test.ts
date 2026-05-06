import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDownloadSkill = vi.hoisted(() => vi.fn());

vi.mock("@/api/seren-skills", () => ({
  downloadSkill: mockDownloadSkill,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("skills.inspectSyncStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks backfilled upstream skills as bootstrap-required when no local drift exists", async () => {
    const skillSourceUrl = "seren-skills:polymarket-maker-rebate-bot";
    const lastModified = "2026-03-18T00:00:00Z";

    mockDownloadSkill.mockResolvedValue({
      data: {
        content_hash: lastModified,
        files: [],
        manifest: {},
        skill: {
          created_at: lastModified,
          created_by_user_id: "user-1",
          current_version: "1.0.0",
          current_version_id: "version-1",
          deleted_at: null,
          description: "desc",
          discoverability: "public",
          id: "skill-1",
          name: "Polymarket Maker Rebate Bot",
          owner_kind: "user",
          owner_organization_id: "org-1",
          owner_user_id: "user-1",
          price_cents: 0,
          seren_bounty_campaign_id: null,
          skill_folder_name: "polymarket-maker-rebate-bot",
          slug: "polymarket-maker-rebate-bot",
          sponsor_mode: "skip",
          sponsor_referral_code: null,
          sponsor_static: null,
          status: "published",
          updated_at: lastModified,
          visibility: "public",
        },
        skill_md: "skill body",
        version: "1.0.0",
      },
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
      upstreamSource: "seren",
      upstreamSourceUrl: skillSourceUrl,
      syncState: {
        version: 1,
        upstreamSource: "seren",
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

  it("keeps legacy serenorg repo sync state refreshable through the Seren Skills API", async () => {
    const lastModified = "2026-03-19T00:00:00Z";
    mockDownloadSkill.mockResolvedValue({
      data: {
        content_hash: lastModified,
        files: [],
        manifest: {},
        skill: {
          created_at: lastModified,
          created_by_user_id: "user-1",
          current_version: "1.0.0",
          current_version_id: "version-1",
          deleted_at: null,
          description: "desc",
          discoverability: "public",
          id: "skill-1",
          name: "Polymarket Maker Rebate Bot",
          owner_kind: "user",
          owner_organization_id: "org-1",
          owner_user_id: "user-1",
          price_cents: 0,
          seren_bounty_campaign_id: null,
          skill_folder_name: "polymarket-maker-rebate-bot",
          slug: "polymarket-maker-rebate-bot",
          sponsor_mode: "skip",
          sponsor_referral_code: null,
          sponsor_static: null,
          status: "published",
          updated_at: lastModified,
          visibility: "public",
        },
        skill_md: "skill body",
        version: "1.0.0",
      },
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
      upstreamSource: "serenorg" as never,
      upstreamSourceUrl:
        "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/polymarket-maker-rebate-bot/SKILL.md",
      syncState: {
        version: 1,
        upstreamSource: "serenorg" as never,
        upstreamSourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/polymarket-maker-rebate-bot/SKILL.md",
        syncedRevision: "old-revision",
        syncedAt: 1,
        managedFiles: {
          "SKILL.md":
            "1f42523adcc9a31dd7b8ab3b36f098c6a87e7fc7e0760fb3ea7be7cb93420d0d",
        },
      },
    });

    expect(mockDownloadSkill).toHaveBeenCalledWith({
      path: { slug: "polymarket-maker-rebate-bot" },
      throwOnError: false,
    });
    expect(status).toMatchObject({
      state: "update-available",
      updateAvailable: true,
      remoteRevision: {
        sha: lastModified,
      },
    });
  });

  it("treats removed legacy publisher sync state as unmanaged", async () => {
    const { skills } = await import("@/services/skills");

    const status = await skills.inspectSyncStatus({
      slug: "legacy-publisher-skill",
      name: "Legacy Publisher Skill",
      description: "desc",
      id: "local:legacy-publisher-skill",
      source: "local",
      tags: [],
      scope: "seren",
      skillsDir: "/skills",
      dirName: "legacy-publisher-skill",
      path: "/skills/legacy-publisher-skill/SKILL.md",
      installedAt: 1,
      enabled: true,
      contentHash: "hash",
      upstreamSource: "seren",
      upstreamSourceUrl: "https://api.seren.com/publishers/deleted/skill.md",
      syncState: {
        version: 1,
        upstreamSource: "seren",
        upstreamSourceUrl: "https://api.seren.com/publishers/deleted/skill.md",
        syncedRevision: "old-revision",
        syncedAt: 1,
        managedFiles: { "SKILL.md": "hash" },
      },
    });

    expect(status).toBeNull();
    expect(mockDownloadSkill).not.toHaveBeenCalled();
  });
});
