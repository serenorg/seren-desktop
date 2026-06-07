// ABOUTME: Critical guard for #1776 — post-init overwrite of session.currentModelId
// ABOUTME: must route through chooseUpdatedModelId so the [1m] suffix is preserved.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const claudeRuntimeSource = readSource("bin/browser-local/claude-runtime.mjs");

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

  it("forkSession delegates [1m] preservation to the next spawnSession boot — no temp init block", () => {
    // #1825: forkSession no longer spins up a temporary control session to
    // derive a resumable id; it writes the forked JSONL directly. The
    // [1m]-preservation logic is therefore single-sourced in spawnSession's
    // post-init block (asserted above) — the next user spawn against the
    // forked JSONL applies it. Asserting the absence of a duplicate fork-side
    // block locks in the single-source invariant and prevents the temp
    // helper from being reintroduced as a "just to derive currentModelId"
    // shortcut, which would re-open the JSONL-flush race the fix closed.
    const fnIdx = claudeRuntimeSource.indexOf("async function forkSession(");
    expect(fnIdx, "forkSession function missing").toBeGreaterThan(0);
    const bodyEnd = claudeRuntimeSource.indexOf(
      "\n  async function ",
      fnIdx + 30,
    );
    const fnBody = claudeRuntimeSource.slice(
      fnIdx,
      bodyEnd > 0 ? bodyEnd : fnIdx + 4000,
    );
    expect(fnBody).not.toContain("augmentWithLegacyOpus(");
    expect(fnBody).not.toContain("tempSession");
    expect(fnBody).not.toContain("chooseUpdatedModelId(");
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
