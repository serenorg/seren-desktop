// ABOUTME: Critical regression test for catalog name humanization.
// ABOUTME: Guards against slug-style names rendering raw in the SkillsExplorer.

import { describe, expect, it } from "vitest";
import { humanizeSkillName } from "@/lib/skills/parser";

describe("humanizeSkillName", () => {
  it("humanizes a slug-style name with hyphens", () => {
    // Real catalog example: plausibleai-backtester has name="backtester"
    expect(humanizeSkillName("backtester")).toBe("Backtester");
    expect(humanizeSkillName("bot-rasta-coach")).toBe("Bot Rasta Coach");
    expect(humanizeSkillName("polymarket-maker-rebate-bot")).toBe(
      "Polymarket Maker Rebate Bot",
    );
  });

  it("returns names that already have spaces or capitalization unchanged", () => {
    // Catalog skills with proper display-name in frontmatter
    expect(humanizeSkillName("Kraken 1099-DA Tax")).toBe("Kraken 1099-DA Tax");
    expect(humanizeSkillName("AI Governance Assessment")).toBe(
      "AI Governance Assessment",
    );
  });

  it("falls back to humanizing the slug when name is empty", () => {
    expect(humanizeSkillName("", "egeria-cmintro-loan")).toBe(
      "Egeria Cmintro Loan",
    );
  });

  it("returns 'Unnamed Skill' when both name and fallback slug are empty", () => {
    expect(humanizeSkillName("")).toBe("Unnamed Skill");
  });
});
