// ABOUTME: Verifies mobile thread titles derived from a first prompt stay renderable.
// ABOUTME: Protects word-boundary truncation and astral characters from being split.

import { describe, expect, it } from "vitest";
// @ts-expect-error — the happy bridge layer is plain ESM without declarations.
import { deriveHappySessionTitle } from "../../bin/happy-bridge/happy-layer.mjs";

describe("happy session title", () => {
  it("keeps a short prompt as-is and collapses whitespace", () => {
    expect(deriveHappySessionTitle("  check\n the  ledger ")).toBe(
      "check the ledger",
    );
  });

  it("ignores non-string and empty input", () => {
    expect(deriveHappySessionTitle(null)).toBeNull();
    expect(deriveHappySessionTitle("   ")).toBeNull();
  });

  it("truncates on a word boundary", () => {
    const title = deriveHappySessionTitle(
      "investigate every unpaid invoice across the billing system",
    );
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });

  it("never leaves a lone surrogate before the ellipsis", () => {
    // The 30th code unit lands inside the emoji's surrogate pair.
    const title = deriveHappySessionTitle(`${"の".repeat(29)}🚀tail`);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("�");
    for (const codeUnit of [...title].map((char) => char.codePointAt(0))) {
      expect(codeUnit >= 0xd800 && codeUnit <= 0xdfff).toBe(false);
    }
  });
});
