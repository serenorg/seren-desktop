// ABOUTME: Unit tests for one-time 401 refresh/retry behavior in fetch wrappers.
// ABOUTME: Covers both direct appFetch and generated client custom fetch config.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => Promise<string | null>>(),
  getTauriFetch: vi.fn<() => Promise<typeof globalThis.fetch>>(),
  shouldSkipRefresh: vi.fn<(input: RequestInfo | URL) => boolean>(),
  refreshAccessToken: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getToken: mocks.getToken,
}));

vi.mock("@/lib/tauri-fetch", () => ({
  getTauriFetch: mocks.getTauriFetch,
  shouldSkipRefresh: mocks.shouldSkipRefresh,
}));

vi.mock("@/services/auth", () => ({
  refreshAccessToken: mocks.refreshAccessToken,
}));

describe("fetch retry behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getToken.mockReset();
    mocks.getTauriFetch.mockReset();
    mocks.shouldSkipRefresh.mockReset();
    mocks.refreshAccessToken.mockReset();

    mocks.shouldSkipRefresh.mockReturnValue(false);
  });

  it("appFetch retries once with refreshed bearer token", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    mocks.getTauriFetch.mockResolvedValue(fetchMock);
    mocks.refreshAccessToken.mockResolvedValue(true);
    mocks.getToken.mockResolvedValue("new-token");

    const { appFetch } = await import("@/lib/fetch");
    const response = await appFetch("https://api.serendb.com/projects", {
      headers: { Authorization: "Bearer old-token" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);

    const firstRequest = fetchMock.mock.calls[0]?.[0] as Request;
    const secondRequest = fetchMock.mock.calls[1]?.[0] as Request;
    expect(firstRequest.headers.get("Authorization")).toBe("Bearer old-token");
    expect(secondRequest.headers.get("Authorization")).toBe("Bearer new-token");
    expect(response.status).toBe(200);
  });

  it("appFetch does not retry when endpoint is in refresh skip list", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));

    mocks.getTauriFetch.mockResolvedValue(fetchMock);
    mocks.shouldSkipRefresh.mockReturnValue(true);

    const { appFetch } = await import("@/lib/fetch");
    const response = await appFetch("https://api.serendb.com/auth/refresh", {
      method: "POST",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it("generated client fetch retries only once on repeated 401", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("still unauthorized", { status: 401 }));

    mocks.getTauriFetch.mockResolvedValue(fetchMock);
    mocks.refreshAccessToken.mockResolvedValue(true);
    mocks.getToken.mockResolvedValue("new-token");

    const { createClientConfig } = await import("@/api/client-config");
    const config = createClientConfig();
    const clientFetch = config.fetch as typeof globalThis.fetch;

    const response = await clientFetch("https://api.serendb.com/projects", {
      headers: { Authorization: "Bearer old-token" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);

    const secondRequest = fetchMock.mock.calls[1]?.[0] as Request;
    expect(secondRequest.headers.get("Authorization")).toBe("Bearer new-token");
    expect(response.status).toBe(401);
  });
});
