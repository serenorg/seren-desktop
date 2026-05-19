// ABOUTME: Tests display-name resolution for catalog-backed installed skills.
// ABOUTME: Keeps marketplace and installed rows visually consistent.

import { describe, expect, it } from "vitest";
import {
  resolveSkillListDisplayName,
  primarySkillCommandSlug,
  skillCommandAliases,
  skillDisplayName,
  skillMatchesCommandAlias,
  skillsShareCommandAlias,
} from "@/lib/skills/display";
import type { InstalledSkill, Skill } from "@/lib/skills/types";

function catalogSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "seren:grid-trader",
    slug: "grid-trader",
    name: "Grid Trader",
    description: "Trade a grid",
    source: "seren",
    sourceUrl: "seren-skills:grid-trader",
    tags: [],
    ...overrides,
  };
}

function installedSkill(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    ...catalogSkill({
      id: "local:grid-trader",
      name: "Coinbase Grid Trader",
      source: "local",
    }),
    scope: "seren",
    skillsDir: "/skills",
    dirName: "grid-trader",
    path: "/skills/grid-trader/SKILL.md",
    installedAt: 1,
    enabled: true,
    contentHash: "hash",
    upstreamSource: "seren",
    upstreamSourceUrl: "seren-skills:grid-trader",
    ...overrides,
  };
}

describe("skill display helpers", () => {
  it("uses the catalog name for a Seren-managed installed skill", () => {
    expect(
      resolveSkillListDisplayName(installedSkill(), [catalogSkill()]),
    ).toBe("Grid Trader");
  });

  it("matches catalog rows by directory name after local slug drift", () => {
    const installed = installedSkill({
      slug: "coinbase-grid-trader",
      name: "Coinbase Grid Trader",
      dirName: "grid-trader",
    });

    expect(resolveSkillListDisplayName(installed, [catalogSkill()])).toBe(
      "Grid Trader",
    );
  });

  it("falls back to local metadata for non-catalog installs", () => {
    const installed = installedSkill({
      upstreamSource: undefined,
      upstreamSourceUrl: undefined,
      syncState: null,
    });

    expect(resolveSkillListDisplayName(installed, [catalogSkill()])).toBe(
      "Coinbase Grid Trader",
    );
  });

  it("falls back to slug when a skill has no name", () => {
    expect(skillDisplayName(catalogSkill({ name: "", slug: "grid-trader" }))).toBe(
      "grid-trader",
    );
  });

  it("prefers the catalog slug for command identity", () => {
    const installed = installedSkill({
      slug: "coinbase-grid-trader",
      dirName: "grid-trader",
      upstreamSourceUrl: "seren-skills:grid-trader",
    });

    expect(skillCommandAliases(installed)).toEqual([
      "grid-trader",
      "coinbase-grid-trader",
    ]);
    expect(primarySkillCommandSlug(installed)).toBe("grid-trader");
    expect(skillMatchesCommandAlias(installed, "coinbase-grid-trader")).toBe(
      true,
    );
    expect(skillMatchesCommandAlias(installed, "grid-trader")).toBe(true);
  });

  it("matches an installed skill to a catalog payload by shared command alias", () => {
    const installed = installedSkill({
      slug: "coinbase-grid-trader",
      dirName: "grid-trader",
      upstreamSourceUrl: "seren-skills:grid-trader",
    });

    expect(skillsShareCommandAlias(installed, catalogSkill())).toBe(true);
  });
});
