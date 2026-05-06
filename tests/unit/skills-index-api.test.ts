// ABOUTME: Regression tests for Seren Skills API catalog loading.
// ABOUTME: Guards pagination and generated-client error handling edges.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListSkills = vi.hoisted(() => vi.fn());
const mockDownloadSkill = vi.hoisted(() => vi.fn());
let storage: Map<string, string>;

vi.mock("@/api/seren-skills", () => ({
  downloadSkill: mockDownloadSkill,
  listSkills: mockListSkills,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

function skillSummary(slug: string) {
  return {
    created_at: "2026-01-01T00:00:00Z",
    created_by_user_id: "user-1",
    current_version: "1.0.0",
    current_version_id: "version-1",
    deleted_at: null,
    description: "Skill description",
    discoverability: "public",
    id: `skill-${slug}`,
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

describe("skills.fetchContent via downloadSkillBundle", () => {
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
    mockDownloadSkill.mockResolvedValueOnce({
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
    mockDownloadSkill.mockResolvedValueOnce({ data: bundle("beta") });

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
    mockDownloadSkill.mockResolvedValueOnce({
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
    ).rejects.toThrow("Unexpected seren-skills bundle response for gamma");
  });

  it("throws when the API returns an error", async () => {
    mockDownloadSkill.mockResolvedValueOnce({
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
    ).rejects.toThrow("Failed to download skill delta: 404");
  });
});
