// ABOUTME: Tests for employee instruction-file serialization and edit parsing.
// ABOUTME: Protects round-trip across the shared instruction-file vocabulary.

import { describe, expect, it } from "vitest";
import {
  buildEmployeeInstructionFiles,
  extractInstructionSections,
  splitSkillDocument,
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

  it("strips embedded imported-skill frontmatter after a lead-in", () => {
    const sections = extractInstructionSections([
      {
        kind: "skill",
        path: "SKILL.md",
        content:
          "This skill was imported.\n\nSkill instructions:\n\n---\ndescription: Imported helper\nname: imported-helper\n---\n\n## Steps\n\n- Read the request.",
      },
    ]);

    expect(sections.skill).toContain("This skill was imported.");
    expect(sections.skill).toContain("## Steps");
    expect(sections.skill).not.toContain("description:");
    expect(sections.skill).not.toMatch(/^---/);
  });

  it("keeps a legitimate horizontal rule in a skill body", () => {
    const sections = extractInstructionSections([
      {
        kind: "skill",
        path: "SKILL.md",
        content: "Overview\n\n---\n\nContinue here.",
      },
    ]);

    expect(sections.skill).toContain("\n---\n");
  });

  it("splits the runtime prompt from the display document", () => {
    const content =
      "Use the following runtime behavior.\n\nSkill instructions:\n\n---\ndescription: Imported helper\nname: imported-helper\n---\n\n# Imported Skill\n\n## Steps\n\n- Read the request.";

    const result = splitSkillDocument(content);

    expect(result.runtimePrompt).toBe("Use the following runtime behavior.");
    expect(result.document).toMatch(/^# Imported Skill/);
    expect(result.document).toContain("## Steps");
    expect(result.document).not.toContain("Skill instructions:");
    expect(result.document).not.toContain("description:");
    expect(result.document).not.toContain("name:");
    expect(result.document).not.toMatch(/^---/);
  });

  it("returns the complete document when no marker line exists", () => {
    const content = "# Plain Skill\n\nUse short sentences.";

    expect(splitSkillDocument(content)).toEqual({
      runtimePrompt: "",
      document: content,
    });
  });

  it("matches the marker case-insensitively with trailing whitespace", () => {
    const result = splitSkillDocument(
      "Runtime guidance.\n\nSKILL INSTRUCTIONS:   \n\n# Human documentation",
    );

    expect(result.runtimePrompt).toBe("Runtime guidance.");
    expect(result.document).toBe("# Human documentation");
  });

  it("does not split a mid-sentence marker phrase", () => {
    const content =
      "Explain why the phrase Skill instructions: is not a section marker.";

    expect(splitSkillDocument(content)).toEqual({
      runtimePrompt: "",
      document: content,
    });
  });

  it("keeps extractInstructionSections unsplit for edit round-trips", () => {
    const content =
      "Runtime behavior.\n\nSkill instructions:\n\n# Human documentation\n\nKeep this body.";

    expect(
      extractInstructionSections([
        { kind: "skill", path: "SKILL.md", content },
      ]).skill,
    ).toBe(content);
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
