// ABOUTME: Regression guard for #1836 — JS encoder must collapse `_`, `.`, and
// ABOUTME: any other non-`[a-zA-Z0-9-]` char to `-`, matching the Claude CLI.

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs source is JS; type info isn't generated.
import { encodeProjectDirName } from "../../bin/browser-local/claude-runtime.mjs";

describe("#1836 — encodeProjectDirName matches Claude Code's on-disk naming", () => {
  it("collapses underscores so paths like /Users/x/Foo_Bar/proj resolve to the real dir", () => {
    // Pre-fix: this returned `-Users-x-Foo_Bar-proj`, a dir Claude Code never
    // creates — fork's outputJsonlPath then ENOENT'd.
    expect(
      encodeProjectDirName("/Users/x/Projects/Seren_Projects/seren-bounty"),
    ).toBe("-Users-x-Projects-Seren-Projects-seren-bounty");
  });

  it("collapses dots so /Users/x/.claude/plugins becomes --claude (double dash)", () => {
    expect(encodeProjectDirName("/Users/x/.claude/plugins")).toBe(
      "-Users-x--claude-plugins",
    );
  });

  it("preserves existing dashes inside path segments", () => {
    expect(encodeProjectDirName("/Users/x/Projects/seren-desktop")).toBe(
      "-Users-x-Projects-seren-desktop",
    );
  });
});
