// ABOUTME: Focused guards for Codex permission/sandbox mapping used by paired executor spawns.
// ABOUTME: Pins #2886 so app settings values produce the intended Codex thread/start params.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/providers.mjs",
  import.meta.url,
).href;
const {
  _codexApprovalPolicy: codexApprovalPolicy,
  _modeFromApprovalPolicy: modeFromApprovalPolicy,
  _sandboxFromMode: sandboxFromMode,
} = await import(/* @vite-ignore */ modulePath);

describe("Codex permission defaults (#2886)", () => {
  it("maps the paired executor policy to Permission Mode: Auto", () => {
    expect(modeFromApprovalPolicy("on-failure")).toBe("auto");
    expect(codexApprovalPolicy("auto")).toBe("never");
  });

  it("keeps explicitly ask-shaped policies on Suggest", () => {
    expect(modeFromApprovalPolicy("on-request")).toBe("ask");
    expect(modeFromApprovalPolicy("untrusted")).toBe("ask");
    expect(codexApprovalPolicy("ask")).toBe("on-request");
  });
});

describe("Codex sandbox mapping (#2886)", () => {
  it("honors the app settings full-access value", () => {
    expect(sandboxFromMode("full-access", false)).toBe("danger-full-access");
  });

  it("keeps legacy runtime full-access and network-enabled sessions full access", () => {
    expect(sandboxFromMode("danger-full-access", false)).toBe(
      "danger-full-access",
    );
    expect(sandboxFromMode("workspace-write", true)).toBe("danger-full-access");
  });
});
