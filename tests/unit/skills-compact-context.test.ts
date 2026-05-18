// ABOUTME: Critical guard for #1960 — large active-skill sets must have a
// ABOUTME: compact prompt form so first-turn Codex prompts do not overflow.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("#1960 — compact active-skill prompt context", () => {
  it("getEnabledSkillsContent accepts a compact mode option", () => {
    const body = methodBody("async getEnabledSkillsContent");

    expect(skillsServiceSource).toContain("EnabledSkillsContentOptions");
    expect(body).toContain("opts?: EnabledSkillsContentOptions");
    expect(body).toContain('opts?.mode === "compact"');
  });

  it("compact mode keeps runtime paths and tells the agent to read SKILL.md on demand", () => {
    const body = methodBody("async getEnabledSkillsContent");

    expect(body).toContain("buildCompactSkillPrompt");
    expect(skillsServiceSource).toContain("Before using this skill, open");
    expect(skillsServiceSource).toContain("SKILL.md");
    expect(skillsServiceSource).toContain("runtimeDir");
  });
});
