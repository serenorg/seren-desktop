// ABOUTME: Critical guard for #1776 — post-init overwrite of session.currentModelId
// ABOUTME: must route through chooseUpdatedModelId so the [1m] suffix is preserved.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#1776 — post-init currentModelId resolution preserves [1m]", () => {
  it("spawnSession routes the inferred init.model through chooseUpdatedModelId", () => {
    // Anthropic echoes the bare resolved id (e.g. claude-opus-4-7) in
    // initResult.model even when the session was spawned with --model
    // claude-opus-4-7[1m]. Resolving the bare echo via inferCurrentModelId
    // alone clobbers the [1m] suffix and leaves the picker (and the next
    // setModel arg) on the 200K-tier id while the session is actually
    // running on 1M. chooseUpdatedModelId carries the existing #1763
    // [1m]-preservation guard — reuse it here so spawn-time and per-message
    // resolution agree on the tier marker.
    const spawnAnchor = "augmentWithLegacyOpus(\n        normalizeModelRecords(initResult),\n      );";
    const idx = claudeRuntimeSource.indexOf(spawnAnchor);
    expect(idx, "spawnSession post-init block must exist").toBeGreaterThan(0);

    const block = claudeRuntimeSource.slice(idx, idx + 1200);
    expect(block).toContain("chooseUpdatedModelId(");
    expect(block).toContain("session.currentModelId,");
    expect(block).toContain("inferredFromInit");
  });

  it("forkSession applies the same chooseUpdatedModelId protection symmetrically", () => {
    // The fork path (#1635 resume + branch) repeats the post-init resolution
    // for the temporary control session it spins up to derive a resumable
    // agentSessionId. Without the same [1m]-preservation logic, forking a
    // 1M-tier conversation drops the suffix on the new branch.
    const forkAnchor =
      'tempSession.availableModelRecords = augmentWithLegacyOpus(';
    const idx = claudeRuntimeSource.indexOf(forkAnchor);
    expect(idx, "forkSession post-init block must exist").toBeGreaterThan(0);

    const block = claudeRuntimeSource.slice(idx, idx + 1200);
    expect(block).toContain("chooseUpdatedModelId(");
    expect(block).toContain("tempSession.currentModelId,");
  });

  it("DEFAULT_PREFERRED_MODEL is the [1m]-tier Opus 4.7 id", () => {
    // The fresh-thread fallback must default to the 1M-tier variant so the
    // picker shows it as the default selection out of the box. Combined with
    // the chooseUpdatedModelId reuse above, this gives fresh threads a 1M
    // window without requiring picker discovery.
    expect(claudeRuntimeSource).toContain(
      'const DEFAULT_PREFERRED_MODEL = "claude-opus-4-7[1m]";',
    );
  });
});
