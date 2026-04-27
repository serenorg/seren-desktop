// ABOUTME: Regression coverage for live publisher-backed skill de-duplication.
// ABOUTME: Ensures wrappers keep repo content while retaining publisher metadata.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAppFetch = vi.hoisted(() => vi.fn());
const mockCatalogList = vi.hoisted(() => vi.fn());

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
  catalog: {
    list: mockCatalogList,
  },
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  });
}

describe("skills.fetchAllSkills publisher-backed de-dupe", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installLocalStorageMock();
  });

  it("canonicalizes publisher wrappers but preserves seren-skills content", async () => {
    mockAppFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: "2",
        updatedAt: "2026-04-27T00:00:00Z",
        skills: [
          {
            slug: "seren-seren-bounty",
            name: "seren-bounty",
            description: "Repo wrapper for SerenBounty",
            source: "serenorg",
            sourceUrl:
              "https://raw.githubusercontent.com/serenorg/seren-skills/main/seren/seren-bounty/SKILL.md",
            tags: [],
          },
        ],
        tree: [],
      }),
    });

    mockCatalogList.mockResolvedValue([
      {
        slug: "seren-bounty",
        name: "SerenBounty",
        resource_name: "SerenBounty",
        description: "Live publisher-backed bounty protocol",
        publisher_type: "mcp",
        categories: ["bounties"],
        capabilities: ["bounty-creation"],
        endpoints: [
          {
            method: "POST",
            path: "/events/ingest",
            description: "Ingest bounty protocol events",
          },
        ],
        mcp_endpoint: "https://api.example.com/mcp",
        is_active: true,
      },
      {
        slug: "seren-swarm",
        name: "SerenSwarm",
        resource_name: "SerenSwarm",
        description: "Separate collaborative bounty network",
        publisher_type: "mcp",
        categories: ["bounties"],
        is_active: true,
      },
    ]);

    const { skills } = await import("@/services/skills");

    const allSkills = await skills.fetchAllSkills(true);

    expect(allSkills.map((skill) => skill.slug)).toEqual([
      "seren-bounty",
      "seren-swarm",
    ]);
    expect(allSkills.find((skill) => skill.slug === "seren-bounty")).toMatchObject(
      {
        id: "serenorg:seren-bounty",
        source: "serenorg",
        sourceUrl:
          "https://raw.githubusercontent.com/serenorg/seren-skills/main/seren/seren-bounty/SKILL.md",
        description: "Repo wrapper for SerenBounty",
        publisherSlug: "seren-bounty",
        publisherName: "SerenBounty",
        publisherDescription: "Live publisher-backed bounty protocol",
        publisherType: "mcp",
        publisherCapabilities: ["bounty-creation"],
        publisherEndpoints: [
          {
            method: "POST",
            path: "/events/ingest",
            description: "Ingest bounty protocol events",
          },
        ],
        publisherMcpEndpoint: "https://api.example.com/mcp",
      },
    );
    expect(
      allSkills.find((skill) => skill.slug === "seren-bounty")
        ?.publisherSourceUrl,
    ).toContain("/publishers/seren-bounty/skill.md");
  });
});
