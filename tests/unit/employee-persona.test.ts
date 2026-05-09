// ABOUTME: Tests for employee persona prompt serialization and edit parsing.
// ABOUTME: Protects SKILL.md/IDENTITY.md/SOUL.md round-trip behavior.

import { describe, expect, it } from "vitest";
import {
  buildEmployeeSystemPrompt,
  extractPersonaSections,
} from "@/lib/employees/persona";

describe("employee persona prompt helpers", () => {
  it("builds marker-first persona prompts when identity or soul is present", () => {
    const prompt = buildEmployeeSystemPrompt({
      name: "Truman",
      slug: "truman",
      skill: "Speak plainly.",
      identity: "# Identity\n\nFamily-office advisor.",
      soul: "# Soul\n\nStewardship first.",
    });

    expect(prompt.startsWith("--- SKILL.md ---\n---\n")).toBe(true);
    expect(prompt).toContain('name: "truman"');
    expect(prompt).toContain("# Truman\n\nSpeak plainly.");
    expect(prompt).toContain("--- IDENTITY.md ---\n\n# Identity");
    expect(prompt).toContain("--- SOUL.md ---\n\n# Soul");
  });

  it("round-trips marker-first persona prompts without leaking frontmatter into SKILL.md", () => {
    const prompt = buildEmployeeSystemPrompt({
      name: "Truman",
      slug: "truman",
      skill: "Speak plainly.",
      identity: "# Identity\n\nFamily-office advisor.",
      soul: "# Soul\n\nStewardship first.",
    });

    expect(extractPersonaSections(prompt)).toEqual({
      skill: "Speak plainly.",
      identity: "# Identity\n\nFamily-office advisor.",
      soul: "# Soul\n\nStewardship first.",
    });
  });

  it("parses legacy desktop prompts that placed section markers after frontmatter", () => {
    const legacyPrompt = [
      "---",
      'name: "truman"',
      'description: "Truman - virtual employee"',
      "---",
      "",
      "# Truman",
      "",
      "--- SKILL.md ---",
      "",
      "Speak plainly.",
      "",
      "--- IDENTITY.md ---",
      "",
      "Family-office advisor.",
    ].join("\n");

    expect(extractPersonaSections(legacyPrompt)).toEqual({
      skill: "Speak plainly.",
      identity: "Family-office advisor.",
      soul: "",
    });
  });

  it("does not split ordinary role text that only quotes a section marker later", () => {
    const prompt = [
      "---",
      'name: "writer"',
      'description: "Writer - virtual employee"',
      "---",
      "",
      "# Writer",
      "",
      "Explain the marker `--- SKILL.md ---` when asked.",
    ].join("\n");

    expect(extractPersonaSections(prompt)).toEqual({
      skill: "Explain the marker `--- SKILL.md ---` when asked.",
      identity: "",
      soul: "",
    });
  });
});
