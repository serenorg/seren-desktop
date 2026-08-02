// ABOUTME: Pins Gmail account guidance to the production Rust-orchestrated chat path.
// ABOUTME: Prevents the direct-provider fallback from becoming the only protected chat path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve("src/services/orchestrator.ts"), "utf8");

describe("orchestrated chat OAuth account guidance (#3589)", () => {
  it("prepends live per-thread account guidance to Rust conversation context", () => {
    const computeIndex = source.indexOf("await computeAgentOAuthRouting(");
    const guidanceIndex = source.indexOf(
      "buildOAuthAccountConfirmationInstruction(",
    );
    const prependIndex = source.indexOf(
      '{ role: "system", content: oauthAccountGuidance }',
    );
    const invokeIndex = source.indexOf('invoke("orchestrate"');

    expect(computeIndex).toBeGreaterThan(-1);
    expect(guidanceIndex).toBeGreaterThan(-1);
    expect(prependIndex).toBeGreaterThan(-1);
    expect(invokeIndex).toBeGreaterThan(-1);
    expect(computeIndex).toBeLessThan(prependIndex);
    expect(prependIndex).toBeLessThan(invokeIndex);
  });
});
