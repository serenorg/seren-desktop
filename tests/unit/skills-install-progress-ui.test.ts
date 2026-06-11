// ABOUTME: Pins #2328 skill install progress UI to an accessible progress bar.
// ABOUTME: Large payload installs must show byte-aware progress, not only a static Installing label.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("src/components/sidebar/SkillsExplorer.tsx"),
  "utf-8",
);

describe("SkillsExplorer install progress UI (#2328)", () => {
  it("renders an accessible install progress bar for active catalog installs", () => {
    expect(source).toContain("SkillInstallProgressBar");
    expect(source).toContain('role="progressbar"');
    expect(source).toContain("aria-valuenow");
    expect(source).toContain("installProgressFor(skill.id)");
  });
});
