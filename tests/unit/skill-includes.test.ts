// ABOUTME: Tests for SKILL.md includes field parsing and shared dependency bundling.
// ABOUTME: Validates that declared includes paths are fetched and installed under _deps/.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkillMd } from "@/lib/skills/parser";

// --- Parser tests (no mocks needed) ---

describe("parseSkillMd includes field", () => {
  it("parses inline array includes", () => {
    const raw = `---
name: My Skill
description: A skill
includes: [polymarket/_shared, common/utils]
---
# My Skill`;
    const parsed = parseSkillMd(raw);
    expect(parsed.metadata.includes).toEqual([
      "polymarket/_shared",
      "common/utils",
    ]);
  });

  it("parses multiline array includes", () => {
    const raw = `---
name: My Skill
description: A skill
includes:
- polymarket/_shared
- common/utils
---
# My Skill`;
    const parsed = parseSkillMd(raw);
    expect(parsed.metadata.includes).toEqual([
      "polymarket/_shared",
      "common/utils",
    ]);
  });

  it("returns undefined includes when not declared", () => {
    const raw = `---
name: My Skill
description: A skill
---
# My Skill`;
    const parsed = parseSkillMd(raw);
    expect(parsed.metadata.includes).toBeUndefined();
  });

  it("parses empty includes array", () => {
    const raw = `---
name: My Skill
description: A skill
includes: []
---
# My Skill`;
    const parsed = parseSkillMd(raw);
    expect(parsed.metadata.includes).toEqual([]);
  });
});

// --- Fetch integration tests ---

const mockAppFetch = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fetch", () => ({
  appFetch: mockAppFetch,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/services/catalog", () => ({
  catalog: {},
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

describe("fetchUpstreamSkillBundle with includes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches includes files under _deps/ prefix alongside skill payload", async () => {
    const skillMdContent = `---
name: Maker Bot
description: A bot
includes: [polymarket/_shared]
---
# Maker Bot`;

    const skillSourceUrl =
      "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/polymarket-maker-bot/SKILL.md";

    mockAppFetch.mockImplementation(async (url: string) => {
      // SKILL.md fetch (cache-busted sourceUrl)
      if (url.startsWith(skillSourceUrl)) {
        return { ok: true, text: async () => skillMdContent };
      }
      // R2 skills index — single source of truth for tree + revision (#1515)
      if (url.includes("/skills/index.json")) {
        return {
          ok: true,
          json: async () => ({
            version: "2",
            updatedAt: "2026-01-01T00:00:00Z",
            skills: [
              {
                slug: "polymarket-maker-bot",
                name: "Maker Bot",
                description: "A bot",
                source: "serenorg",
                sourceUrl: skillSourceUrl,
                tags: [],
                lastModified: "2026-01-01T00:00:00Z",
              },
            ],
            tree: [
              "polymarket/polymarket-maker-bot/SKILL.md",
              "polymarket/polymarket-maker-bot/scripts/run.py",
              "polymarket/_shared/utils.py",
              "polymarket/_shared/config.json",
            ],
          }),
        };
      }
      // Raw file fetches (payload + includes)
      if (url.includes("scripts/run.py")) {
        return { ok: true, text: async () => "print('run')" };
      }
      if (url.includes("_shared/utils.py")) {
        return { ok: true, text: async () => "def helper(): pass" };
      }
      if (url.includes("_shared/config.json")) {
        return { ok: true, text: async () => '{"key": "value"}' };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // Mock invoke for get_seren_skills_dir + install_skill + validate_skill_payload
    mockInvoke
      .mockResolvedValueOnce("/skills") // get_seren_skills_dir
      .mockResolvedValueOnce("/skills/polymarket-maker-bot/SKILL.md") // install_skill
      .mockResolvedValueOnce([]); // validate_skill_payload

    const { skills } = await import("@/services/skills");

    const skill = {
      id: "serenorg:polymarket-maker-bot",
      slug: "polymarket-maker-bot",
      name: "Maker Bot",
      description: "A bot",
      source: "serenorg" as const,
      sourceUrl:
        "https://raw.githubusercontent.com/serenorg/seren-skills/main/polymarket/polymarket-maker-bot/SKILL.md",
      tags: [],
    };

    await skills.install(skill, skillMdContent, "seren", null);

    // Find the install_skill call
    const installCall = mockInvoke.mock.calls.find(
      (call: unknown[]) => call[0] === "install_skill",
    );
    expect(installCall).toBeDefined();

    const args = installCall![1] as Record<string, unknown>;
    const extraFilesJson = args.extraFiles as string;
    expect(extraFilesJson).toBeDefined();

    const extraFiles = JSON.parse(extraFilesJson) as Array<{
      path: string;
      content: string;
    }>;

    // Should have the skill's own payload file
    expect(extraFiles.some((f) => f.path === "scripts/run.py")).toBe(true);

    // Should have includes files under _deps/
    expect(
      extraFiles.some(
        (f) => f.path === "_deps/polymarket/_shared/utils.py",
      ),
    ).toBe(true);
    expect(
      extraFiles.some(
        (f) => f.path === "_deps/polymarket/_shared/config.json",
      ),
    ).toBe(true);
  });
});
