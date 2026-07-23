// ABOUTME: Pins the renderer's read-only bridge to the trusted sandbox status command.
// ABOUTME: Keeps Settings from inferring effective confinement from its requested mode.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib/browser-local-runtime", () => ({
  isLocalProviderRuntime: () => false,
  onRuntimeEvent: vi.fn(),
  runtimeInvoke: vi.fn(),
}));

vi.mock("@/lib/runtime", () => ({
  runtimeHasCapability: () => false,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

import { getAgentSandboxStatus } from "@/services/providers";

describe("agent sandbox status renderer bridge", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns the Rust-sourced effective status shape", async () => {
    const expected = {
      backend: "seatbelt",
      spec_available: true,
      enforced_at_launch: true,
      fail_closed: true,
      effective_mode: "workspace-write",
      network_enabled: false,
      detail: "Seatbelt enforcement is applied when the agent process launches.",
    };
    invokeMock.mockResolvedValue(expected);

    await expect(
      getAgentSandboxStatus("workspace-write", "/workspace", false),
    ).resolves.toEqual(expected);
    expect(invokeMock).toHaveBeenCalledWith("agent_sandbox_status", {
      mode: "workspace-write",
      projectRoot: "/workspace",
      networkEnabled: false,
    });
  });
});
