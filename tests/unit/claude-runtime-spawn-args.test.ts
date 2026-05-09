// ABOUTME: Critical guard for #1854 — buildClaudeArgs must preserve the [1m]
// ABOUTME: suffix on --model so 1M-tier sessions actually request the wide window.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const { _buildClaudeArgs: buildClaudeArgs } = await import(
  /* @vite-ignore */ modulePath
);

describe("buildClaudeArgs — --model arg preservation (#1854)", () => {
  it("emits --model with the literal [1m]-suffixed id, no stripping", () => {
    // The 1M-tier upstream contract requires the bracketed suffix to reach
    // the spawned `claude` CLI verbatim — Anthropic gates the wide window on
    // it. If a future refactor splits, normalises, or canonicalises the
    // model id before push, every 1M session silently demotes to 200K and
    // the gauge denominator goes wrong without any user-visible signal.
    const args: string[] = buildClaudeArgs({
      sessionId: "test-session-id",
      resumeSessionId: null,
      preferredModel: "claude-opus-4-7[1m]",
      mcpConfigJson: null,
      effort: "default",
    });

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("claude-opus-4-7[1m]");
  });

  it("omits --model entirely when preferredModel is falsy", () => {
    // Cold-start callers may pass no model; we must not push --model with
    // an empty value (the CLI rejects an empty model arg).
    const args: string[] = buildClaudeArgs({
      sessionId: "test-session-id",
      resumeSessionId: null,
      preferredModel: undefined,
      mcpConfigJson: null,
      effort: "default",
    });

    expect(args.indexOf("--model")).toBe(-1);
  });
});
