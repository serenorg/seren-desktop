// ABOUTME: Verifies provider resolution idempotency and safe approval choice.
// ABOUTME: These tests exercise pure arbitration helpers without runtime mocks.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the provider runtime is plain ESM without declarations.
import { createResolutionTracker } from "../../bin/browser-local/providers.mjs";
// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { selectApprovalOption } from "../../bin/happy-bridge/happy-layer.mjs";

describe("provider resolution arbitration", () => {
  it("returns a success-shaped alreadyResolved result for duplicate responses", () => {
    const tracker = createResolutionTracker();

    expect(tracker.duplicate("session-1", "request-1")).toBeNull();
    tracker.mark("session-1", "request-1");
    expect(tracker.duplicate("session-1", "request-1")).toEqual({
      alreadyResolved: true,
    });
  });

  it("maps approval to the narrowest known allow option", () => {
    expect(
      selectApprovalOption(
        [
          { optionId: "allow_session", kind: "allow_always" },
          { optionId: "allow_once", kind: "allow_once" },
          { optionId: "deny", kind: "reject_once" },
        ],
        true,
      ),
    ).toBe("allow_once");
  });

  it("maps a Codex-style approval denial to the explicit decline option", () => {
    expect(
      selectApprovalOption(
        [
          { optionId: "accept" },
          { optionId: "acceptForSession" },
          { optionId: "decline" },
        ],
        false,
      ),
    ).toBe("decline");
  });

  it("uses the first non-deny option only when no known allow id or kind is offered", () => {
    expect(
      selectApprovalOption(
        [
          { optionId: "custom_allow", description: "custom_allow" },
          { optionId: "reject_once", description: "reject_once" },
        ],
        true,
      ),
    ).toBe("custom_allow");
  });
});
