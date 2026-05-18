// ABOUTME: Pins the chip-rendering contract for user-message slash invocations.
// ABOUTME: Unknown slugs stay as plain text; known slugs become button chips.

import { describe, expect, it } from "vitest";
import { escapeHtmlWithSkillsAndLinks } from "@/lib/render-markdown";

const KNOWN = new Set(["prophet-arb-bot", "browser-automation"]);

describe("escapeHtmlWithSkillsAndLinks", () => {
  it("renders a chip for a known slug at the start of the message", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="prophet-arb-bot"');
    expect(html).toContain('class="skill-chip"');
    expect(html).toContain("prophet-arb-bot</span>");
  });

  it("preserves args on the same line as a trailing slot", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot check positions",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="prophet-arb-bot"');
    expect(html).toContain('class="skill-chip-args"');
    expect(html).toContain("check positions");
  });

  it("does not chip unknown slugs (random /word in prose)", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/unknown-thing please run",
      KNOWN,
    );
    expect(html).not.toContain("data-skill-slug");
    expect(html).toContain("/unknown-thing please run");
  });

  it("chips a known slug that appears mid-sentence after whitespace", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "remember to use /prophet-arb-bot for this",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="prophet-arb-bot"');
    // Pre- and post-chip prose survive intact.
    expect(html).toContain("remember to use ");
    expect(html).toContain("for this");
  });

  it("keeps URL linkification working alongside chips", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/browser-automation visit https://example.com first",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="browser-automation"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('class="external-link"');
  });

  it("escapes HTML in both the chip slug context and the surrounding text", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot <script>alert('x')</script>",
      KNOWN,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to the plain escape path when no slugs are known", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot run it",
      new Set(),
    );
    expect(html).not.toContain("data-skill-slug");
    expect(html).toContain("/prophet-arb-bot run it");
  });

  it("rejects a slash inside a word as a chip trigger", () => {
    // and/or is prose, not an invocation. The matcher requires a leading
    // whitespace or start-of-string boundary.
    const html = escapeHtmlWithSkillsAndLinks(
      "either prophet-arb-bot/foo or bar",
      KNOWN,
    );
    expect(html).not.toContain("data-skill-slug");
  });

  it("carries the args verbatim on data-skill-args for click recovery", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot check positions",
      KNOWN,
    );
    expect(html).toContain('data-skill-args="check positions"');
  });

  it("emits an empty data-skill-args when there are no args", () => {
    const html = escapeHtmlWithSkillsAndLinks("/prophet-arb-bot", KNOWN);
    expect(html).toContain('data-skill-args=""');
  });

  it("escapes quotes and HTML inside the captured args attribute", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      '/prophet-arb-bot say "hi" <b>',
      KNOWN,
    );
    expect(html).not.toContain('data-skill-args="say "hi"');
    expect(html).toContain("&quot;hi&quot;");
    expect(html).toContain("&lt;b&gt;");
  });

  it("keeps text after a newline that follows /slug args on the first line", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot one\ntwo three",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="prophet-arb-bot"');
    // Args span captures only the first line of args.
    expect(html).toContain("one");
    // Subsequent line is preserved as trailing prose, not lost.
    expect(html).toContain("two three");
  });

  it("chips a known slug at the end of the message with no trailing content", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "please use /prophet-arb-bot",
      KNOWN,
    );
    expect(html).toContain('data-skill-slug="prophet-arb-bot"');
    expect(html).toContain('data-skill-args=""');
    expect(html).toContain("please use ");
    // No empty args span when there are no args.
    expect(html).not.toContain("skill-chip-args");
  });

  it("chips multiple invocations across lines", () => {
    const html = escapeHtmlWithSkillsAndLinks(
      "/prophet-arb-bot one\n/browser-automation two",
      KNOWN,
    );
    expect(
      (html.match(/data-skill-slug=/g) ?? []).length,
    ).toBe(2);
  });
});
