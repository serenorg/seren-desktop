// ABOUTME: Regression tests for publisher OAuth reconnect refresh-token repair.
// ABOUTME: Ensures stale provider grants are revoked before fresh authorization.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => Promise<string | null>>(),
  invoke: vi.fn<() => Promise<string>>(),
  openUrl: vi.fn<() => Promise<void>>(),
  revokeConnection: vi.fn(),
}));

vi.mock("@/api", () => ({
  listConnections: vi.fn(),
  listProviders: vi.fn(),
  listStorePublishers: vi.fn(),
  revokeConnection: mocks.revokeConnection,
}));

vi.mock("@/lib/config", () => ({
  apiBase: "https://api.serendb.com",
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getToken: mocks.getToken,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

describe("publisher OAuth reconnect", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Macintosh" },
    });
    mocks.getToken.mockResolvedValue("access-token");
    mocks.invoke.mockResolvedValue("https://accounts.example.test/oauth");
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.revokeConnection.mockResolvedValue({
      data: {},
      response: new Response(null, { status: 200 }),
    });
  });

  it("revokes the stale provider connection before opening refresh-failure reconnect", async () => {
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google", { revokeBeforeConnect: true });

    expect(mocks.revokeConnection).toHaveBeenCalledWith({
      path: { provider: "google" },
      throwOnError: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("get_oauth_redirect_url", {
      bearerToken: "access-token",
      url: "https://api.serendb.com/oauth/google/authorize?redirect_uri=seren%3A%2F%2Foauth%2Fcallback",
    });
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://accounts.example.test/oauth",
    );

    expect(
      mocks.revokeConnection.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.invoke.mock.invocationCallOrder[0]);
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openUrl.mock.invocationCallOrder[0],
    );
  });

  it("does not revoke before a normal first-connect authorization", async () => {
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google");

    expect(mocks.revokeConnection).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });

  it("continues reconnect when the stale connection was already gone", async () => {
    mocks.revokeConnection.mockResolvedValue({
      error: { message: "Connection not found" },
      response: new Response(null, { status: 404 }),
    });
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google", { revokeBeforeConnect: true });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://accounts.example.test/oauth",
    );
  });
});
