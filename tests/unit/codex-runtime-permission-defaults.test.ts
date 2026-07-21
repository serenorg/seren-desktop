// ABOUTME: Focused guards for Codex permission/sandbox mapping used by paired executor spawns.
// ABOUTME: Pins #2886 so app settings values produce the intended Codex thread/start params.

import { describe, expect, it } from "vitest";

const modulePath = new URL(
  "../../bin/browser-local/providers.mjs",
  import.meta.url,
).href;
const {
  _codexApprovalPolicy: codexApprovalPolicy,
  _codexNetworkConfigOverride: codexNetworkConfigOverride,
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

  it("keeps legacy runtime full-access while separating network from filesystem scope", () => {
    expect(sandboxFromMode("danger-full-access", false)).toBe(
      "danger-full-access",
    );
    expect(sandboxFromMode("workspace-write", true)).toBe("workspace-write");
  });

  it("applies network access as a workspace sandbox option", () => {
    expect(codexNetworkConfigOverride(true)).toBe(
      "sandbox_workspace_write.network_access=true",
    );
    expect(codexNetworkConfigOverride(false)).toBe(
      "sandbox_workspace_write.network_access=false",
    );
  });
});
