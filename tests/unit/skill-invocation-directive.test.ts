// ABOUTME: Tests for the shared skill-invocation directive builder used by
// ABOUTME: AgentChat, ChatContent, and the sidebar Run button.

import { describe, expect, it } from "vitest";
import {
  buildSkillInvocationDirective,
  buildSkillInvocationDisplay,
} from "@/lib/skills/invoke";

describe("buildSkillInvocationDirective", () => {
  const slug = "polymarket-trader";
  const content = "# Polymarket Trader\nDo the thing.";

  it("wraps SKILL.md content in a skill-invocation block when content is loaded", () => {
    const directive = buildSkillInvocationDirective({ slug, content });
    expect(directive).toContain(`<skill-invocation name="${slug}">`);
    expect(directive).toContain(
      `The user has invoked the /${slug} skill. Execute it by following the skill instructions below.`,
    );
    expect(directive).toContain(content);
    expect(directive).toContain("</skill-invocation>");
  });

  it("embeds the user's args inside the invocation block when provided", () => {
    const directive = buildSkillInvocationDirective({
      slug,
      content,
      args: "buy YES at 0.42",
    });
    expect(directive).toContain("User request: buy YES at 0.42");
  });

  it("falls back to a /slug args string when SKILL.md content is missing", () => {
    expect(
      buildSkillInvocationDirective({ slug, content: null, args: "do x" }),
    ).toBe(`/${slug} do x`);
  });

  it("falls back to bare /slug when both content and args are missing", () => {
    expect(buildSkillInvocationDirective({ slug, content: null })).toBe(
      `/${slug}`,
    );
  });
});

describe("buildSkillInvocationDisplay", () => {
  const slug = "polymarket-trader";

  it("renders as /slug when no args are supplied", () => {
    expect(buildSkillInvocationDisplay(slug)).toBe(`/${slug}`);
  });

  it("appends args after a single space when supplied", () => {
    expect(buildSkillInvocationDisplay(slug, "buy YES")).toBe(
      `/${slug} buy YES`,
    );
  });
});
