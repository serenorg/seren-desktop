// ABOUTME: Regression tests for Seren Skills API catalog loading.
// ABOUTME: Guards pagination and generated-client error handling edges.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListSkills = vi.hoisted(() => vi.fn());
const mockDownloadSkill = vi.hoisted(() => vi.fn());
const mockDownloadSkillManifest = vi.hoisted(() => vi.fn());
let storage: Map<string, string>;

vi.mock("@/api/seren-skills", () => ({
  createOrgFolder: vi.fn(),
  downloadSkill: mockDownloadSkill,
  downloadSkillManifest: mockDownloadSkillManifest,
  getAuthorIdentity: vi.fn(),
  getOrgFolder: vi.fn(),
  listSkills: mockListSkills,
  upsertAuthorIdentity: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function skillSummary(slug: string, tags: string[] = []) {
  return {
    created_at: "2026-01-01T00:00:00Z",
    created_by_user_id: "user-1",
    current_version: "1.0.0",
    current_version_id: "version-1",
    deleted_at: null,
    description: "Skill description",
    discoverability: "public",
    folder_slug: null,
    github_mirror_health: "ok",
    id: `skill-${slug}`,
    install_count: 0,
    name: "Test Skill",
    owner_kind: "user",
    owner_organization_id: "org-1",
    owner_user_id: "user-1",
    price_cents: 0,
    seren_bounty_campaign_id: null,
    skill_folder_name: slug,
    slug,
    sponsor_mode: "skip",
    sponsor_referral_code: null,
    sponsor_static: null,
    status: "published",
    updated_at: "2026-01-01T00:00:00Z",
    tags,
    visibility: "public",
  };
}

describe("skills.fetchIndex via Seren Skills API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      clear: vi.fn(() => {
        storage.clear();
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
    });
  });

  it("stops when a paginated catalog response returns an empty page before total", async () => {
    mockListSkills
      .mockResolvedValueOnce({
        data: { skills: [skillSummary("skill-a")], total: 3 },
      })
      .mockResolvedValueOnce({
        data: { skills: [], total: 3 },
      });

    const { skills } = await import("@/services/skills");
    const result = await skills.fetchIndex(true);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "seren:skill-a",
      slug: "skill-a",
      source: "seren",
      sourceUrl: "seren-skills:skill-a",
    });
    expect(mockListSkills).toHaveBeenCalledTimes(2);
    expect(mockListSkills.mock.calls[1][0]).toMatchObject({
      query: { limit: 100, offset: 1 },
    });
  });

  it("preserves frontmatter tags from catalog summaries", async () => {
    mockListSkills.mockResolvedValueOnce({
      data: {
        skills: [skillSummary("recorded-workflow", ["recorded", "unverified"])],
        total: 1,
      },
    });

    const { skills } = await import("@/services/skills");
    const result = await skills.fetchIndex(true);

    expect(result[0]?.tags).toEqual(
      expect.arrayContaining([
        "recorded",
        "unverified",
        "public",
        "published",
      ]),
    );
  });

  it("carries skill_folder_name through as skillFolderName", async () => {
    // Org-namespaced catalog slugs differ from the published folder name.
    // The desktop reconciles installed ↔ catalog by either signal, so the
    // adapter must keep them distinct.
    mockListSkills.mockResolvedValueOnce({
      data: {
        skills: [
          {
            ...skillSummary("pk-lead-intelligence"),
            folder_slug: "autumn",
            slug: "autumn-pk-lead-intelligence",
            skill_folder_name: "pk-lead-intelligence",
          },
        ],
        total: 1,
      },
    });

    const { skills } = await import("@/services/skills");
    const result = await skills.fetchIndex(true);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "autumn-pk-lead-intelligence",
      skillFolderName: "pk-lead-intelligence",
      folderSlug: "autumn",
    });
  });

  it("ignores the legacy catalog cache key", async () => {
    storage.set(
      "seren:skills_index",
      JSON.stringify({
        timestamp: Date.now(),
        data: [{ id: "seren:stale", slug: "stale", name: "Stale" }],
      }),
    );
    mockListSkills.mockResolvedValueOnce({
      data: { skills: [skillSummary("skill-a")], total: 1 },
    });

    const { skills } = await import("@/services/skills");
    const result = await skills.fetchIndex();

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("skill-a");
    expect(mockListSkills).toHaveBeenCalledTimes(1);
  });

  it("throws when the live catalog fails and no fresh cache exists", async () => {
    mockListSkills.mockResolvedValueOnce({
      error: { message: "unavailable" },
      response: { status: 503 },
    });

    const { skills } = await import("@/services/skills");

    await expect(skills.fetchIndex(true)).rejects.toThrow(
      "Failed to list seren-skills catalog: 503",
    );
  });

  it("handles catalog responses wrapped in a data object", async () => {
    mockListSkills.mockResolvedValueOnce({
      data: {
        data: {
          data: {
            data: {
              data: { skills: [skillSummary("skill-a")], total: 1 },
            },
          },
        },
      },
    });

    const { skills } = await import("@/services/skills");
    const result = await skills.fetchIndex(true);

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("skill-a");
  });

  it("throws a clear error for malformed catalog responses", async () => {
    mockListSkills.mockResolvedValueOnce({
      data: { total: 1 },
    });

    const { skills } = await import("@/services/skills");

    await expect(skills.fetchIndex(true)).rejects.toThrow(
      "Unexpected seren-skills catalog response: total",
    );
  });
});

describe("skills.fetchContent via downloadSkillBundleManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function bundle(slug: string) {
    return {
      content_hash: "abc",
      files: [],
      manifest: {},
      skill: skillSummary(slug),
      skill_md: "# Body",
      version: "1.0.0",
    };
  }

  it("unwraps a bundle response wrapped in nested data envelopes", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({
      data: { data: { data: bundle("alpha") } },
    });

    const { skills } = await import("@/services/skills");
    const content = await skills.fetchContent({
      id: "seren:alpha",
      slug: "alpha",
      name: "Alpha",
      description: "",
      source: "seren",
      sourceUrl: "seren-skills:alpha",
      tags: [],
    });

    expect(content).toBe("# Body");
  });

  it("returns the bundle markdown when the response is unwrapped", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({ data: bundle("beta") });

    const { skills } = await import("@/services/skills");
    const content = await skills.fetchContent({
      id: "seren:beta",
      slug: "beta",
      name: "Beta",
      description: "",
      source: "seren",
      sourceUrl: "seren-skills:beta",
      tags: [],
    });

    expect(content).toBe("# Body");
  });

  it("throws when the bundle response cannot be normalized", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({
      data: { content_hash: "abc" },
    });

    const { skills } = await import("@/services/skills");
    await expect(
      skills.fetchContent({
        id: "seren:gamma",
        slug: "gamma",
        name: "Gamma",
        description: "",
        source: "seren",
        sourceUrl: "seren-skills:gamma",
        tags: [],
      }),
    ).rejects.toThrow("Unexpected seren-skills manifest response for gamma");
  });

  it("includes inner envelope keys when a wrapped bundle response cannot be normalized", async () => {
    // Mirror of the production failure: the SDK returned `{ data: <inner> }`
    // and the inner envelope is missing the bundle fields. The error must
    // surface BOTH outer and inner keys so we can root-cause without
    // redeploying the desktop client.
    mockDownloadSkillManifest.mockResolvedValueOnce({
      data: { data: { content_hash: "abc" } },
    });

    const { skills } = await import("@/services/skills");
    await expect(
      skills.fetchContent({
        id: "seren:wrapped",
        slug: "wrapped",
        name: "Wrapped",
        description: "",
        source: "seren",
        sourceUrl: "seren-skills:wrapped",
        tags: [],
      }),
    ).rejects.toThrow(/content_hash/);
  });

  it("surfaces server error envelopes when the bundle body carries an error payload", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({
      data: {
        data: {
          body: {
            error: { code: "PUBLISHER_DENIED", message: "forbidden" },
          },
        },
      },
    });

    const { skills } = await import("@/services/skills");
    await expect(
      skills.fetchContent({
        id: "seren:denied",
        slug: "denied",
        name: "Denied",
        description: "",
        source: "seren",
        sourceUrl: "seren-skills:denied",
        tags: [],
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it("treats publisher ApiResultResponse failures as failed downloads", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({
      data: {
        data: {
          status: 404,
          body: { error: { code: 404, message: "skill not found" } },
          response_bytes: 50,
          execution_time_ms: 33,
          cost: "0",
          asset_symbol: "USDC",
        },
      },
    });

    const { skills } = await import("@/services/skills");
    await expect(
      skills.fetchContent({
        id: "seren:curve-gauge-yield-trader",
        slug: "curve-gauge-yield-trader",
        name: "Curve Gauge Yield Trader",
        description: "",
        source: "seren",
        sourceUrl: "seren-skills:curve-gauge-yield-trader",
        tags: [],
      }),
    ).rejects.toThrow(
      "Failed to download manifest for skill curve-gauge-yield-trader: 404 (skill not found)",
    );
  });

  it("throws when the API returns an error", async () => {
    mockDownloadSkillManifest.mockResolvedValueOnce({
      error: { message: "not found" },
      response: { status: 404 },
    });

    const { skills } = await import("@/services/skills");
    await expect(
      skills.fetchContent({
        id: "seren:delta",
        slug: "delta",
        name: "Delta",
        description: "",
        source: "seren",
        sourceUrl: "seren-skills:delta",
        tags: [],
      }),
    ).rejects.toThrow("Failed to download manifest for skill delta: 404");
  });
});
