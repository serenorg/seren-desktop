// ABOUTME: Regression coverage for live publisher-backed skill de-duplication.
// ABOUTME: Ensures seren-skills wrappers do not duplicate live publisher records.

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

  it("prefers the live publisher skill over the seren-skills wrapper", async () => {
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
        source: "seren",
        description: "Live publisher-backed bounty protocol",
      },
    );
  });
});
