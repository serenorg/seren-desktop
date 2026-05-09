// ABOUTME: Regression guard for #1850 — composer surface must not render skill chips or pickers.
// ABOUTME: Mirrors #1844: skill resolution stays in services; composer is for send-time controls only.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(rel), "utf-8");

describe("Composer is free of skill UI (#1850 / #1844)", () => {
  it("SkillAttachmentChips component does not exist", () => {
    expect(existsSync(resolve("src/components/chat/SkillAttachmentChips.tsx"))).toBe(false);
  });

  it("ImageAttachmentBar does not import or render skill UI", () => {
    const source = read("src/components/chat/ImageAttachmentBar.tsx");
    expect(source).not.toMatch(/SkillAttachmentChips/);
    expect(source).not.toMatch(/skillsStore/);
    expect(source).not.toMatch(/seren:open-panel/);
    expect(source).not.toMatch(/projectRoot/);
    expect(source).not.toMatch(/threadId/);
  });

  it("AgentChat and ChatContent do not pass skill-routing props to ImageAttachmentBar", () => {
    for (const file of [
      "src/components/chat/AgentChat.tsx",
      "src/components/chat/ChatContent.tsx",
    ]) {
      const source = read(file);
      const match = source.match(/<ImageAttachmentBar[\s\S]*?\/>/);
      expect(match, `${file} must mount ImageAttachmentBar`).not.toBeNull();
      const usage = match?.[0] ?? "";
      expect(usage).not.toMatch(/projectRoot=/);
      expect(usage).not.toMatch(/threadId=/);
    }
  });
});
