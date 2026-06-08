// ABOUTME: Regression coverage for #2211 titlebar placement of the record prompt.
// ABOUTME: Prevents the prompt from returning to a bottom-right composer overlay.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("record prompt placement (#2211)", () => {
  it("renders from the titlebar before the balance display, not as a fixed bottom overlay", () => {
    const recordPromptSource = source("src/components/meeting/RecordPrompt.tsx");
    const titlebarSource = source("src/components/layout/Titlebar.tsx");

    expect(recordPromptSource).not.toContain("fixed bottom");
    expect(recordPromptSource).not.toContain("right-6");
    expect(titlebarSource.indexOf("<RecordPrompt")).toBeGreaterThan(-1);
    expect(titlebarSource.indexOf("<RecordPrompt")).toBeLessThan(
      titlebarSource.indexOf("<BalanceDisplay"),
    );
  });
});
