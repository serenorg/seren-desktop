// ABOUTME: Tests for MCP Gateway cache validity logic.
// ABOUTME: Focused on critical caching behavior that affects tool availability.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module
vi.mock("@/lib/fetch", () => ({
  appFetch: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getApiKey: vi.fn().mockResolvedValue("test-api-key"),
}));

describe("MCP Gateway Caching", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it("should use cached data when cache is valid", async () => {
    const { appFetch } = await import("@/lib/fetch");
    const fetchMock = vi.mocked(appFetch);

    // Mock publisher response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "1", slug: "test", name: "Test", is_active: true }],
          pagination: { offset: 0, limit: 100, total: 1 },
        }),
    } as Response);

    // Mock tools response
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          tools: [
            {
              name: "test-tool",
              description: "Test",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          execution_time_ms: 100,
        }),
    } as Response);

    const { initializeGateway, getGatewayTools, isGatewayInitialized } =
      await import("@/services/mcp-gateway");

    // First init - should fetch
    await initializeGateway();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getGatewayTools()).toHaveLength(1);
    expect(isGatewayInitialized()).toBe(true);

    // Second init within TTL - should use cache
    await initializeGateway();
    expect(fetchMock).toHaveBeenCalledTimes(2); // No additional calls
  });

  it("should refetch when cache expires", async () => {
    const { appFetch } = await import("@/lib/fetch");
    const fetchMock = vi.mocked(appFetch);

    // Mock responses for first fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "1", slug: "test", name: "Test", is_active: true }],
          pagination: { offset: 0, limit: 100, total: 1 },
        }),
    } as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          tools: [
            {
              name: "tool-v1",
              description: "Test",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          execution_time_ms: 100,
        }),
    } as Response);

    const { initializeGateway, isGatewayInitialized } = await import(
      "@/services/mcp-gateway"
    );

    await initializeGateway();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Advance time past TTL (10 minutes + 1 second)
    vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
    expect(isGatewayInitialized()).toBe(false);

    // Mock responses for second fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "1", slug: "test", name: "Test", is_active: true }],
          pagination: { offset: 0, limit: 100, total: 1 },
        }),
    } as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          tools: [
            {
              name: "tool-v2",
              description: "Updated",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          execution_time_ms: 100,
        }),
    } as Response);

    // Third init after TTL expired - should refetch
    await initializeGateway();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("should clear cache on reset", async () => {
    const { appFetch } = await import("@/lib/fetch");
    const fetchMock = vi.mocked(appFetch);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [{ id: "1", slug: "test", name: "Test", is_active: true }],
          pagination: { offset: 0, limit: 100, total: 1 },
        }),
    } as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          tools: [
            {
              name: "test-tool",
              description: "Test",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          execution_time_ms: 100,
        }),
    } as Response);

    const {
      initializeGateway,
      resetGateway,
      getGatewayTools,
      isGatewayInitialized,
    } = await import("@/services/mcp-gateway");

    await initializeGateway();
    expect(getGatewayTools()).toHaveLength(1);

    resetGateway();
    expect(getGatewayTools()).toHaveLength(0);
    expect(isGatewayInitialized()).toBe(false);
  });
});
