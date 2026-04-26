// ABOUTME: Source-text regression guards for #1677 — setModel must pass
// ABOUTME: through non-catalog model ids so #1635 ground-truth ids work.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#1677 — setModel passes through non-catalog ids", () => {
  it("setModel does NOT throw on unknown model ids", () => {
    const fnStart = claudeRuntimeSource.indexOf("async function setModel(");
    expect(fnStart, "setModel must exist").toBeGreaterThan(0);
    const fnEnd = claudeRuntimeSource.indexOf("\n  }\n", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnEnd);

    expect(
      fnBody,
      "setModel must not throw 'Unknown Claude model'",
    ).not.toMatch(/throw new Error\(`Unknown Claude model:/);
  });

  it("setModel calls sendControlRequest with the raw modelId regardless of catalog match", () => {
    const fnStart = claudeRuntimeSource.indexOf("async function setModel(");
    const fnEnd = claudeRuntimeSource.indexOf("\n  }\n", fnStart);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnEnd);

    // The control request must reference the raw modelId param so a
    // non-catalog id passes through unchanged to the CLI.
    expect(fnBody).toMatch(/subtype:\s*"set_model"/);
    expect(fnBody).toMatch(/model:\s*modelId/);
  });

  it("setModel falls back to raw modelId for currentModelId when no catalog match", () => {
    const fnStart = claudeRuntimeSource.indexOf("async function setModel(");
    const fnEnd = claudeRuntimeSource.indexOf("\n  }\n", fnStart);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnEnd);

    // `targetModel?.modelId ?? modelId` — keeps catalog-canonical id when
    // available, but doesn't lose a non-catalog id either.
    expect(fnBody).toContain("targetModel?.modelId ?? modelId");
  });

  it("setModel logs a warning (not an error) for non-catalog ids", () => {
    const fnStart = claudeRuntimeSource.indexOf("async function setModel(");
    const fnEnd = claudeRuntimeSource.indexOf("\n  }\n", fnStart);
    const fnBody = claudeRuntimeSource.slice(fnStart, fnEnd);

    // Visibility: passthrough must be observable in logs so we can debug
    // CLI/catalog drift without a crash.
    expect(fnBody).toMatch(/console\.warn\(/);
    expect(fnBody).toContain("not in catalog");
  });
});
