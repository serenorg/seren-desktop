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

// --- Bundle integration tests ---

const mockDownloadSkill = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@/api/seren-skills", () => ({
  downloadSkill: mockDownloadSkill,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

function toBase64(value: string): string {
  return btoa(value);
}

function mockSkillBundle(files: Array<{ path: string; content: string }>) {
  return {
    content_hash: "bundle-hash",
    files: files.map((file) => ({
      path: file.path,
      content_b64: toBase64(file.content),
      content_hash: `${file.path}-hash`,
      is_binary: false,
      mode: 0o644,
    })),
    manifest: {},
    skill: {
      created_at: "2026-01-01T00:00:00Z",
      created_by_user_id: "user-1",
      current_version: "1.0.0",
      current_version_id: "version-1",
      deleted_at: null,
      description: "A bot",
      discoverability: "public",
      id: "skill-1",
      name: "Maker Bot",
      owner_kind: "user",
      owner_organization_id: "org-1",
      owner_user_id: "user-1",
      price_cents: 0,
      seren_reward_campaign_id: null,
      skill_folder_name: "polymarket-maker-bot",
      slug: "polymarket-maker-bot",
      sponsor_mode: "skip",
      sponsor_referral_code: null,
      sponsor_static: null,
      status: "published",
      updated_at: "2026-01-01T00:00:00Z",
      visibility: "public",
    },
    skill_md: `---
name: Maker Bot
description: A bot
includes: [polymarket/_shared]
---
# Maker Bot`,
    version: "1.0.0",
  };
}

describe("Seren Skills bundle install with includes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs API bundle files alongside SKILL.md", async () => {
    mockDownloadSkill.mockResolvedValue({
      data: mockSkillBundle([
        { path: "scripts/run.py", content: "print('run')" },
        {
          path: "_deps/polymarket/_shared/utils.py",
          content: "def helper(): pass",
        },
        {
          path: "_deps/polymarket/_shared/config.json",
          content: '{"key": "value"}',
        },
      ]),
    });

    // Mock invoke for get_seren_skills_dir + install_skill + validate_skill_payload
    mockInvoke
      .mockResolvedValueOnce("/skills") // get_seren_skills_dir
      .mockResolvedValueOnce("/skills/polymarket-maker-bot/SKILL.md") // install_skill
      .mockResolvedValueOnce([]); // validate_skill_payload

    const { skills } = await import("@/services/skills");

    const skill = {
      id: "seren:polymarket-maker-bot",
      slug: "polymarket-maker-bot",
      name: "Maker Bot",
      description: "A bot",
      source: "seren" as const,
      sourceUrl: "seren-skills:polymarket-maker-bot",
      tags: [],
    };

    await skills.install(skill, "", "seren", null);

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

    expect(extraFiles.some((f) => f.path === "scripts/run.py")).toBe(true);
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
