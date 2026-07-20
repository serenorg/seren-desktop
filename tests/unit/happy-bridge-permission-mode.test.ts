// ABOUTME: Verifies remote permission modes can never silently drop approval prompts.
// ABOUTME: Guards the ActionConfirmation boundary against a remote peer's mode change.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { providerPermissionMode } from "../../bin/happy-bridge/provider-source.mjs";
// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import { isSupportedPermissionMode } from "../../bin/happy-bridge/happy-layer.mjs";

// Mirrors codexApprovalPolicy in bin/browser-local/providers.mjs: only "ask"
// prompts, every other mode runs unattended.
const promptsForApproval = (providerMode: string) => providerMode === "ask";

// The modes a remote peer is allowed to send. Anything outside this set is
// dropped at the bridge boundary before it reaches the provider runtime.
const REMOTE_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "read-only",
  "safe-yolo",
  "yolo",
  "ask",
  "auto",
];

// Modes whose entire purpose is to run without approval prompts. Only these may
// legitimately reach codex's unattended policy.
const EXPLICITLY_UNATTENDED = new Set(["auto", "bypassPermissions", "safe-yolo", "yolo"]);

describe("codex permission mode mapping", () => {
  it("does not let the baseline 'default' mode disable approval prompts", () => {
    // Regression: "default" fell through to "auto" -> approval_policy "never",
    // so an ordinary remote message silently bypassed ActionConfirmation.
    expect(providerPermissionMode("default", "codex")).toBe("ask");
    expect(promptsForApproval(providerPermissionMode("default", "codex"))).toBe(true);
  });

  it("fails closed for modes it does not recognize", () => {
    for (const mode of ["", "unknown", "Default", "AUTO", "acceptEdits"]) {
      expect(providerPermissionMode(mode, "codex")).toBe("ask");
    }
  });

  it("keeps prompting for every remote mode that is not explicitly unattended", () => {
    for (const mode of REMOTE_MODES) {
      const providerMode = providerPermissionMode(mode, "codex");
      expect(promptsForApproval(providerMode)).toBe(!EXPLICITLY_UNATTENDED.has(mode));
    }
  });

  it("still honors modes that explicitly ask to run unattended", () => {
    for (const mode of EXPLICITLY_UNATTENDED) {
      expect(providerPermissionMode(mode, "codex")).toBe("auto");
    }
  });

  it("only accepts remote modes the mapping has a defined answer for", () => {
    for (const mode of REMOTE_MODES) {
      expect(isSupportedPermissionMode(mode)).toBe(true);
    }
    expect(isSupportedPermissionMode("nope")).toBe(false);
  });
});
