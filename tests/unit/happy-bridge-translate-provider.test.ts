// ABOUTME: Exhaustively verifies provider-runtime to neutral session translation.
// ABOUTME: This is the single authoritative provider-side mapping test.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { translateProviderEvent } from "../../bin/happy-bridge/provider-source.mjs";

const mappings = [
  ["provider://message-chunk", "assistant-delta"],
  ["provider://user-message", "user-message"],
  ["provider://tool-call", "tool-start"],
  ["provider://tool-result", "tool-end"],
  ["provider://diff", "file-diff"],
  ["provider://diff-proposal", "diff-proposal"],
  ["provider://diff-proposal-resolved", "diff-proposal-resolved"],
  ["provider://plan-update", "plan-update"],
  ["provider://permission-request", "permission-request"],
  ["provider://permission-resolved", "permission-resolved"],
  ["provider://prompt-complete", "turn-complete"],
  ["provider://session-status", "status"],
  ["provider://error", "error"],
] as const;

describe("provider-to-neutral session event translation", () => {
  it.each(mappings)("maps %s to %s", (method, kind) => {
    expect(
      translateProviderEvent(method, {
        sessionId: "session-1",
        value: "preserved",
      }),
    ).toEqual({
      kind,
      sessionId: "session-1",
      payload: { value: "preserved" },
    });
  });

  it.each([
    "provider://config-options-update",
    "provider://mcp-degraded",
    "provider://cli-install-progress",
    "provider://unknown",
  ])("drops unmapped event %s", (method) => {
    expect(translateProviderEvent(method, { sessionId: "session-1" })).toBeNull();
  });

  it("drops mapped notifications without a session id", () => {
    expect(translateProviderEvent("provider://message-chunk", { text: "x" })).toBeNull();
  });
});
