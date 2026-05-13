// ABOUTME: Tests for employee instruction-file serialization and edit parsing.
// ABOUTME: Protects round-trip across the shared instruction-file vocabulary.

import { describe, expect, it } from "vitest";
import {
  buildEmployeeInstructionFiles,
  extractInstructionSections,
} from "@/lib/employees/instructions";

const EMPTY = {
  skill: "",
  identity: "",
  soul: "",
  agents: "",
  user: "",
  memory: "",
  tools: "",
  heartbeat: "",
  eval: "",
};

describe("employee instruction-file helpers", () => {
  it("builds typed instructions for skill, identity, and soul", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Speak plainly.",
      identity: "# Identity\n\nSenior advisor.",
      soul: "# Soul\n\nStewardship first.",
    });

    expect(instructions.map((item) => item.kind)).toEqual([
      "identity",
      "soul",
      "skill",
    ]);
    expect(instructions[2]).toMatchObject({
      kind: "skill",
      path: "SKILL.md",
    });
    expect(instructions[2].content).toContain('name: "atlas"');
    expect(instructions[2].content).toContain("# Atlas\n\nSpeak plainly.");
  });

  it("round-trips typed instructions without leaking frontmatter into SKILL.md", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Speak plainly.",
      identity: "# Identity\n\nSenior advisor.",
      soul: "# Soul\n\nStewardship first.",
    });

    expect(extractInstructionSections(instructions)).toEqual({
      ...EMPTY,
      skill: "Speak plainly.",
      identity: "# Identity\n\nSenior advisor.",
      soul: "# Soul\n\nStewardship first.",
    });
  });

  it("preserves user-authored SKILL.md headings on edit", () => {
    const sections = extractInstructionSections([
      {
        kind: "skill",
        path: "SKILL.md",
        content: "# Keep this heading\n\nDo the work.",
      },
    ]);

    expect(sections).toEqual({
      ...EMPTY,
      skill: "# Keep this heading\n\nDo the work.",
    });
  });

  it("preserves non-generated SKILL.md frontmatter on edit", () => {
    const sections = extractInstructionSections([
      {
        kind: "skill",
        path: "SKILL.md",
        content:
          '---\nname: "imported-skill"\ndescription: "Imported package"\n---\n# Imported Skill\n\nDo the work.',
      },
    ]);

    expect(sections).toEqual({
      ...EMPTY,
      skill:
        '---\nname: "imported-skill"\ndescription: "Imported package"\n---\n# Imported Skill\n\nDo the work.',
    });
  });

  it("does not split ordinary skill text that quotes old marker syntax", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Writer",
      slug: "writer",
      skill: "Explain the marker `--- SKILL.md ---` when asked.",
    });

    expect(extractInstructionSections(instructions)).toEqual({
      ...EMPTY,
      skill: "Explain the marker `--- SKILL.md ---` when asked.",
    });
  });

  it("emits the shared instruction-file vocabulary when supplied", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Plain speech.",
      identity: "Senior advisor.",
      soul: "Stewardship first.",
      agents: "Discipline rule.",
      user: "Timezone UTC.",
      memory: "Memory rule.",
      tools: "Tool rule.",
      heartbeat: "Heartbeat rule.",
      eval: "Eval rule.",
    });

    expect(instructions.map((item) => item.kind)).toEqual([
      "identity",
      "soul",
      "skill",
      "agents",
      "user",
      "tools",
      "memory",
      "heartbeat",
      "eval",
    ]);
    expect(extractInstructionSections(instructions)).toEqual({
      skill: "Plain speech.",
      identity: "Senior advisor.",
      soul: "Stewardship first.",
      agents: "Discipline rule.",
      user: "Timezone UTC.",
      memory: "Memory rule.",
      tools: "Tool rule.",
      heartbeat: "Heartbeat rule.",
      eval: "Eval rule.",
    });
  });

  it("skips empty optional sections", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Plain speech.",
      agents: "  ",
      memory: "",
      tools: "Use web_search sparingly.",
    });

    expect(instructions.map((item) => item.kind)).toEqual(["skill", "tools"]);
  });

  it("returns a SKILL-only instruction when no optional sections are supplied", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Plain speech.",
    });

    expect(instructions).toHaveLength(1);
    expect(instructions[0].kind).toBe("skill");
    expect(extractInstructionSections(instructions)).toEqual({
      ...EMPTY,
      skill: "Plain speech.",
    });
  });

  it("orders optional sections AGENTS -> USER -> TOOLS -> MEMORY consistently", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Plain speech.",
      agents: "Agents rule.",
      user: "User rule.",
      tools: "Tools rule.",
      memory: "Memory rule.",
    });

    const kinds = instructions.map((item) => item.kind);
    expect(kinds.indexOf("agents")).toBeGreaterThan(-1);
    expect(kinds.indexOf("user")).toBeGreaterThan(kinds.indexOf("agents"));
    expect(kinds.indexOf("tools")).toBeGreaterThan(kinds.indexOf("user"));
    expect(kinds.indexOf("memory")).toBeGreaterThan(kinds.indexOf("tools"));
  });

  it("round-trips eval instructions without making them required", () => {
    const instructions = buildEmployeeInstructionFiles({
      name: "Atlas",
      slug: "atlas",
      skill: "Plain speech.",
      eval: "name = \"smoke\"",
    });

    expect(instructions.map((item) => item.kind)).toEqual(["skill", "eval"]);
    expect(extractInstructionSections(instructions)).toEqual({
      ...EMPTY,
      skill: "Plain speech.",
      eval: 'name = "smoke"',
    });
  });
});
