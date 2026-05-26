// ABOUTME: Critical guard for #1960 — large active-skill sets must have a
// ABOUTME: compact prompt form so first-turn Codex prompts do not overflow.
// ABOUTME: #2041 makes compact the default — every active skill ships name +
// ABOUTME: description only unless the caller explicitly opts into full mode.

import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const skillsServiceSource = readFileSync(
  join(process.cwd(), "src/services/skills.ts"),
  "utf8",
);

function methodBody(name: string): string {
  const start = skillsServiceSource.indexOf(`${name}(`);
  expect(start).toBeGreaterThan(0);
  const end = skillsServiceSource.indexOf("\n  },", start);
  expect(end).toBeGreaterThan(start);
  return skillsServiceSource.slice(start, end);
}

const SKILL_MD_BODY_MARKER = "DO-NOT-INLINE-FULL-BODY-IN-COMPACT-MODE";
const SKILL_MD = `---
name: Test Skill
description: A test skill
---
# Test Skill

## When to Use

Use when running the compact-default invariant test.

## Body

${SKILL_MD_BODY_MARKER}
`;

function fakeSkill() {
  return {
    id: "seren:test",
    slug: "test",
    name: "Test Skill",
    description: "A test skill",
    source: "seren" as const,
    sourceUrl: "seren-skills:test",
    tags: [],
    scope: "user" as const,
    skillsDir: "/Users/me/.config/seren/skills",
    dirName: "test",
    path: "",
    installedAt: 0,
    enabled: true,
  };
}

describe("#1960 — compact active-skill prompt context (mode option exists)", () => {
  it("getEnabledSkillsContent accepts a typed mode option", () => {
    const body = methodBody("async getEnabledSkillsContent");

    expect(skillsServiceSource).toContain("EnabledSkillsContentOptions");
    expect(body).toContain("opts?: EnabledSkillsContentOptions");
  });

  it("compact path keeps runtime paths and tells the agent to read SKILL.md on demand", () => {
    const body = methodBody("async getEnabledSkillsContent");

    expect(body).toContain("buildCompactSkillPrompt");
    expect(skillsServiceSource).toContain("Before using this skill, open");
    expect(skillsServiceSource).toContain("SKILL.md");
    expect(skillsServiceSource).toContain("runtimeDir");
  });
});

describe("#2041 — compact is the default; full is explicit opt-in", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_skill_content") return Promise.resolve(SKILL_MD);
      return Promise.resolve(null);
    });
  });

  it("emits compact content (no full body) when called with no opts", async () => {
    // Before #2041: undefined opts → full body inlined → 30 skills paid
    // ~90K tokens of system-prompt overhead per turn. The body marker
    // must NOT appear in the default output; the compact "open SKILL.md"
    // directive MUST appear.
    const { skills } = await import("@/services/skills");
    const content = await skills.getEnabledSkillsContent([
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      fakeSkill() as any,
    ]);
    expect(content).not.toContain(SKILL_MD_BODY_MARKER);
    expect(content).toContain("Before using this skill, open");
  });

  it("emits the full body when the caller explicitly opts into mode: 'full'", async () => {
    // The escape hatch must still work — slash-command invocations and
    // any caller that genuinely needs the full body can request it.
    const { skills } = await import("@/services/skills");
    const content = await skills.getEnabledSkillsContent(
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      [fakeSkill() as any],
      { mode: "full" },
    );
    expect(content).toContain(SKILL_MD_BODY_MARKER);
  });
});
