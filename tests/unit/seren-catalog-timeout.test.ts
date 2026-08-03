// ABOUTME: Critical regression coverage for the Seren catalog fetch bound.
// ABOUTME: Protects the timeout signal on the discovery call gating Auto sends.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3615 Seren model catalog fetch is bounded", () => {
  it("passes a timeout signal so a stalled connection rejects", () => {
    const source = readSource("src/lib/providers/seren.ts");

    expect(source).toContain("signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)");
  });
});
