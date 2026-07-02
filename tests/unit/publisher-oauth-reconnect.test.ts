// ABOUTME: Regression tests for publisher OAuth reconnect refresh-token repair.
// ABOUTME: Ensures stale provider grants are revoked before fresh authorization.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => Promise<string | null>>(),
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listConnections: vi.fn(),
  openUrl: vi.fn<() => Promise<void>>(),
  revokeConnectionById: vi.fn(),
}));

vi.mock("@/api", () => ({
  listConnections: mocks.listConnections,
  listProviders: vi.fn(),
  listStorePublishers: vi.fn(),
  revokeConnectionById: mocks.revokeConnectionById,
}));

vi.mock("@/lib/config", () => ({
  apiBase: "https://api.serendb.com",
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: vi.fn(() => true),
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
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_validation_runtime_info") {
        return {
          isValidation: false,
          controlEnabled: false,
          identifier: "com.serendb.desktop",
          oauthCallbackPort: 8787,
        };
      }
      if (command === "get_desktop_oauth_callback_url") {
        return "http://127.0.0.1:49152/oauth/callback";
      }
      return "https://accounts.example.test/oauth";
    });
    mocks.openUrl.mockResolvedValue(undefined);
    mocks.listConnections.mockResolvedValue({
      data: {
        connections: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider_slug: "google",
            provider_email: "user@example.com",
          },
        ],
      },
    });
    mocks.revokeConnectionById.mockResolvedValue({
      data: {},
      response: new Response(null, { status: 200 }),
    });
  });

  it("revokes the stale provider connection before opening refresh-failure reconnect", async () => {
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google", { revokeBeforeConnect: true });

    expect(mocks.revokeConnectionById).toHaveBeenCalledWith({
      path: { connection_id: "11111111-1111-4111-8111-111111111111" },
      throwOnError: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("get_oauth_redirect_url", {
      bearerToken: "access-token",
      url: "https://api.serendb.com/oauth/google/authorize?redirect_uri=seren%3A%2F%2Foauth%2Fcallback",
    });
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://accounts.example.test/oauth",
    );

    const redirectInvokeOrder = mocks.invoke.mock.invocationCallOrder.find(
      (_order, index) =>
        mocks.invoke.mock.calls[index]?.[0] === "get_oauth_redirect_url",
    );
    expect(redirectInvokeOrder).toBeDefined();
    expect(
      mocks.revokeConnectionById.mock.invocationCallOrder[0],
    ).toBeLessThan(redirectInvokeOrder ?? 0);
    expect(redirectInvokeOrder ?? 0).toBeLessThan(
      mocks.openUrl.mock.invocationCallOrder[0],
    );
  });

  it("does not revoke before a normal first-connect authorization", async () => {
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google");

    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(mocks.revokeConnectionById).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_oauth_redirect_url",
      expect.any(Object),
    );
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });

  it("continues reconnect when the stale connection was already gone", async () => {
    mocks.listConnections.mockResolvedValue({
      data: {
        connections: [],
      },
    });
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google", { revokeBeforeConnect: true });

    expect(mocks.revokeConnectionById).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_oauth_redirect_url",
      expect.any(Object),
    );
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://accounts.example.test/oauth",
    );
  });

  it("does not guess which stale connection to revoke when a provider has multiple connections", async () => {
    mocks.listConnections.mockResolvedValue({
      data: {
        connections: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider_slug: "google",
            provider_email: "first@example.com",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            provider_slug: "google",
            provider_email: "second@example.com",
          },
        ],
      },
    });
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await expect(
      connectPublisher("google", { revokeBeforeConnect: true }),
    ).rejects.toThrow(/Multiple connections found for provider google/);

    expect(mocks.revokeConnectionById).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "get_oauth_redirect_url",
      expect.any(Object),
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("uses loopback callback URL for validation runtime publisher OAuth", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "get_validation_runtime_info") {
        return {
          isValidation: true,
          controlEnabled: true,
          identifier: "com.serendb.desktop.validation",
          oauthCallbackPort: 49152,
        };
      }
      if (command === "get_desktop_oauth_callback_url") {
        return "http://127.0.0.1:49152/oauth/callback";
      }
      return "https://accounts.example.test/oauth";
    });
    const { connectPublisher } = await import("@/services/publisher-oauth");

    await connectPublisher("google");

    expect(mocks.invoke).toHaveBeenCalledWith("get_oauth_redirect_url", {
      bearerToken: "access-token",
      url: "https://api.serendb.com/oauth/google/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Foauth%2Fcallback",
    });
  });
});
