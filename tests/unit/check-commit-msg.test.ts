// ABOUTME: Tests for scripts/check-commit-msg.sh — one case per accept/reject category.
// ABOUTME: Critical only per CLAUDE.md; no duplicate scenarios.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../scripts/check-commit-msg.sh");

function run(message: string, env?: Record<string, string>): { ok: boolean; stderr: string } {
  try {
    execFileSync("bash", [SCRIPT, message], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    });
    return { ok: true, stderr: "" };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    return { ok: false, stderr };
  }
}

describe("check-commit-msg.sh — accepts", () => {
  it("type only", () => {
    expect(run("fix: drop dead branch").ok).toBe(true);
  });

  it("type with scope", () => {
    expect(run("fix(agent): drop --resume when first spawn fails").ok).toBe(true);
  });

  it("type with scope and breaking-change marker", () => {
    expect(run("feat(api)!: rename publisher envelope shape").ok).toBe(true);
  });

  it("merge commit (git-generated prefix)", () => {
    expect(run("Merge pull request #1234 from foo/bar").ok).toBe(true);
  });

  it("revert commit (git-generated prefix)", () => {
    expect(run('Revert "feat(x): something"').ok).toBe(true);
  });

  it("fixup/squash commits (git-generated prefix)", () => {
    expect(run("fixup! fix(agent): something").ok).toBe(true);
  });

  it("empty message (git aborts before hook does)", () => {
    expect(run("").ok).toBe(true);
  });
});

describe("check-commit-msg.sh — rejects", () => {
  it("no type prefix at all", () => {
    const r = run("Update default Codex model to GPT-5.5");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("does not follow conventional-commit format");
  });

  it("unknown type", () => {
    expect(run("nope(scope): some change").ok).toBe(false);
  });

  it("missing colon", () => {
    expect(run("fix(agent) missing colon here").ok).toBe(false);
  });

  it("missing description after colon", () => {
    expect(run("fix(agent):").ok).toBe(false);
  });

  it("type with empty parens scope", () => {
    expect(run("fix(): empty scope").ok).toBe(false);
  });
});

describe("check-commit-msg.sh — subject length cap (#1778)", () => {
  // 73 chars: well-formed conventional-commit, one over the default cap.
  const overCap = `fix(agent): ${"a".repeat(73 - "fix(agent): ".length)}`;

  it("rejects subjects longer than the default 72-char cap", () => {
    expect(overCap.length).toBe(73);
    const r = run(overCap);
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Commit subject is 73 chars");
    expect(r.stderr).toContain("max is 72");
  });

  it("respects MAX_SUBJECT_LEN override (so the cap can be tuned, not forked)", () => {
    expect(run(overCap, { MAX_SUBJECT_LEN: "100" }).ok).toBe(true);
  });

  it("does not gate Merge/Revert prefixes on length (git generates these and they can be long)", () => {
    const longMerge = `Merge pull request #1234 from ${"x".repeat(120)}`;
    expect(longMerge.length).toBeGreaterThan(72);
    expect(run(longMerge).ok).toBe(true);
  });
});
