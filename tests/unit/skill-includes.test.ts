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

    mockAppFetch
      // SKILL.md
      .mockResolvedValueOnce({
        ok: true,
        text: async () => skillMdContent,
      })
      // Tree API
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tree: [
            {
              path: "polymarket/polymarket-maker-bot/SKILL.md",
              type: "blob",
            },
            {
              path: "polymarket/polymarket-maker-bot/scripts/run.py",
              type: "blob",
            },
            { path: "polymarket/_shared/utils.py", type: "blob" },
            { path: "polymarket/_shared/config.json", type: "blob" },
          ],
        }),
      })
      // Revision list
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ sha: "abc123" }],
      })
      // Revision detail
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sha: "abc123",
          commit: { message: "update", committer: { date: "2026-01-01" } },
          files: [],
        }),
      })
      // Payload file: scripts/run.py
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "print('run')",
      })
      // Includes file: _shared/utils.py
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "def helper(): pass",
      })
      // Includes file: _shared/config.json
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{"key": "value"}',
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
