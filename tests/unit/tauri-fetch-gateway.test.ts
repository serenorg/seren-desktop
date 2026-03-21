// ABOUTME: Unit tests for Seren Gateway bridge routing in tauri-fetch.
// ABOUTME: Verifies when requests should bypass webview CORS via the Rust bridge.

import { beforeEach, describe, expect, it, vi } from "vitest";

const isTauriRuntimeMock = vi.fn<() => boolean>();

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: isTauriRuntimeMock,
}));

describe("tauri-fetch gateway helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    isTauriRuntimeMock.mockReset();
  });

  it("detects Seren Gateway requests by origin", async () => {
    const { isGatewayApiRequest } = await import("@/lib/tauri-fetch");

    expect(isGatewayApiRequest("https://api.serendb.com/projects")).toBe(true);
    expect(isGatewayApiRequest("/organizations/default/api-keys")).toBe(true);
    expect(isGatewayApiRequest("https://mcp.serendb.com/mcp")).toBe(false);
  });

  it("uses the Rust bridge only for gateway requests in Tauri", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const { shouldUseRustGatewayBridge } = await import("@/lib/tauri-fetch");

    expect(
      shouldUseRustGatewayBridge("https://api.serendb.com/projects"),
    ).toBe(true);
    expect(
      shouldUseRustGatewayBridge("https://mcp.serendb.com/mcp"),
    ).toBe(false);
  });

  it("keeps auth/login and auth/refresh on the caller-managed path", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const { shouldUseRustGatewayAuth } = await import("@/lib/tauri-fetch");

    expect(
      shouldUseRustGatewayAuth("https://api.serendb.com/organizations/default"),
    ).toBe(true);
    expect(shouldUseRustGatewayAuth("https://api.serendb.com/auth/login")).toBe(
      false,
    );
    expect(
      shouldUseRustGatewayAuth("https://api.serendb.com/auth/refresh"),
    ).toBe(false);
  });
});
