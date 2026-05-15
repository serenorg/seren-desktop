// ABOUTME: Regression for serenorg/seren-skills#570 — verify the runtime
// directory note tells Windows users how to translate Unix-style commands.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

const SKILL_MD = `---
name: Test Skill
description: A test
---
# Test Skill
Run \`python3 scripts/agent.py\` from \`~/.config/seren/skills/test\`.`;

type FakeOverrides = {
  skillsDir?: string;
  dirName?: string;
};

function fakeSkill(overrides: FakeOverrides = {}) {
  return {
    id: "seren:test",
    slug: "test",
    name: "Test Skill",
    description: "A test",
    source: "seren" as const,
    sourceUrl: "seren-skills:test",
    tags: [],
    scope: "user" as const,
    skillsDir: overrides.skillsDir ?? "/Users/me/.config/seren/skills",
    dirName: overrides.dirName ?? "test",
    path: "",
    installedAt: 0,
    enabled: true,
  };
}

describe("skill runtime directory injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_skill_content") return Promise.resolve(SKILL_MD);
      return Promise.resolve(null);
    });
  });

  it("emits the absolute runtime dir on Unix and adds no Windows translation note", async () => {
    const { skills } = await import("@/services/skills");
    const content = await skills.getEnabledSkillsContent([
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      fakeSkill() as any,
    ]);

    expect(content).toContain(
      "**Skill runtime directory:** `/Users/me/.config/seren/skills/test`",
    );
    expect(content).not.toMatch(/Platform:[*\s]*Windows/i);
  });

  it("emits a Windows translation note when skillsDir is a Windows path", async () => {
    const { skills } = await import("@/services/skills");
    const content = await skills.getEnabledSkillsContent([
      fakeSkill({
        skillsDir: "C:\\Users\\Unkno\\AppData\\Local\\SerenDesktop\\skills",
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      }) as any,
    ]);

    expect(content).toContain(
      "**Skill runtime directory:** `C:\\Users\\Unkno\\AppData\\Local\\SerenDesktop\\skills\\test`",
    );
    expect(content).toMatch(/Platform:[*\s]*Windows/i);
    expect(content.toLowerCase()).toContain("python3");
    expect(content.toLowerCase()).toContain("python");
    expect(content.toLowerCase()).toContain("~/.config/seren/skills");
  });
});
