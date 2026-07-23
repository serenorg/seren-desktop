// ABOUTME: Guards acknowledged ACP permission-mode changes used by Happy restoration.
// ABOUTME: A rejected restrictive mode must not be reported or persisted as active.

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — the browser-local runtime is plain ESM without declarations.
import { _applyAcpPermissionMode } from "../../bin/browser-local/acp-runtime.mjs";

describe("ACP permission mode acknowledgement", () => {
  it("keeps the prior mode and emits nothing when session/set_mode rejects", async () => {
    const session = {
      id: "synthetic-session",
      agentType: "gemini",
      agentSessionId: "synthetic-native-session",
      status: "ready",
      currentModeId: "auto_edit",
      currentModelId: "synthetic-model",
      pendingPermissions: new Map(),
      adapter: { buildModes: () => ({ availableModes: [] }) },
    };
    const emit = vi.fn();
    const request = vi.fn(async () => {
      throw new Error("synthetic set_mode rejection");
    });

    await expect(
      _applyAcpPermissionMode(session, "plan", emit, request),
    ).rejects.toThrow("synthetic set_mode rejection");

    expect(request).toHaveBeenCalledWith(
      session,
      "session/set_mode",
      { sessionId: "synthetic-native-session", modeId: "plan" },
      5_000,
    );
    expect(session.currentModeId).toBe("auto_edit");
    expect(emit).not.toHaveBeenCalled();
  });
});
