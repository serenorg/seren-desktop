// ABOUTME: Guards the curated release-notes mechanism in the release workflow.
// ABOUTME: Curated notes must be picked up automatically, never hand-edited post-publish.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const releaseWorkflow = readFileSync(
  join(root, ".github/workflows/release.yml"),
  "utf8",
);

describe("curated release notes", () => {
  it("reads a per-tag curated file from .github/release-notes when present", () => {
    // The release body was hand-edited after publish for good releases and
    // left as the raw commit dump otherwise. The workflow must pick up a
    // curated changelog automatically so the format cannot regress by neglect.
    expect(releaseWorkflow).toContain(
      'CURATED=".github/release-notes/${GITHUB_REF_NAME}.md"',
    );
    expect(releaseWorkflow).toMatch(/if \[ -f "\$CURATED" \]; then\s+.*cat "\$CURATED"/s);
  });

  it("still falls back to the commit list when no curated file exists", () => {
    expect(releaseWorkflow).toMatch(/git log .*--pretty=format:"- %s"/);
  });

  it("always appends the Installation and Note footer regardless of source", () => {
    // The footer is single-sourced in the workflow, so a curated file only
    // supplies the What's New body and cannot drift the install instructions.
    const gen = releaseWorkflow.slice(
      releaseWorkflow.indexOf("Generate release notes"),
      releaseWorkflow.indexOf("> release_notes.md"),
    );
    const curatedAt = gen.indexOf('cat "$CURATED"');
    const installAt = gen.indexOf('echo "## Installation"');
    const noteAt = gen.indexOf('echo "## Note"');
    expect(curatedAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThan(curatedAt);
    expect(noteAt).toBeGreaterThan(installAt);
  });

  it("keeps any committed curated file to the changelog only, no duplicated footer", () => {
    // A curated file must not carry its own Installation/Note — the workflow
    // appends those. If it did, the published body would show them twice.
    const dir = join(root, ".github/release-notes");
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const body = readFileSync(join(dir, file), "utf8");
      expect(body, `${file} must start with the What's New heading`).toMatch(
        /^## What's New/,
      );
      expect(body, `${file} must not carry its own Installation footer`).not.toContain(
        "## Installation",
      );
    }
  });
});
