// ABOUTME: Verifies the Mission Control findings layout's coverage boundary.
// ABOUTME: The template source check keeps this test dependency-free while checking DOM order.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const findingsSource = readFileSync(
  resolve("src/components/run/RunFindings.tsx"),
  "utf8",
);

describe("RunFindings coverage placement", () => {
  it("keeps the coverage strip before the findings scroll region", () => {
    const coverageIndex = findingsSource.indexOf(
      'data-testid="coverage-strip"',
    );
    const findingsIndex = findingsSource.indexOf(
      'data-testid="findings-scroll"',
    );

    expect(coverageIndex).toBeGreaterThanOrEqual(0);
    expect(findingsIndex).toBeGreaterThan(coverageIndex);
    expect(findingsSource).toContain("gaps().length");
    expect(findingsSource).toContain("findings().length");
    expect(findingsSource).toContain(
      'class="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-6"',
    );
  });
});
