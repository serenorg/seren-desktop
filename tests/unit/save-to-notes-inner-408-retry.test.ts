// ABOUTME: Verifies the publisher-inner 408 retry path in saveToSerenNotes.
// ABOUTME: Closes the cold-start half of #1775 — Gateway returns transport 200
// ABOUTME: with the upstream status carried inside the envelope.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAppFetch = vi.hoisted(() => vi.fn());
const mockOpenExternalLink = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn());
const mockShouldUseRustGatewayAuth = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fetch", () => ({ appFetch: mockAppFetch }));
vi.mock("@/lib/external-link", () => ({
  openExternalLink: mockOpenExternalLink,
}));
vi.mock("@/services/auth", () => ({ getToken: mockGetToken }));
vi.mock("@/lib/tauri-fetch", () => ({
  shouldUseRustGatewayAuth: mockShouldUseRustGatewayAuth,
}));
vi.mock("@/lib/config", () => ({ API_BASE: "https://api.serendb.com" }));

const UUID = "041e7a55-261b-4e6d-8cb4-ef4ad656a54a";

function makeResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

describe("saveToSerenNotes — publisher-inner 408 cold-start retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue("test-token");
    mockShouldUseRustGatewayAuth.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries when the gateway envelope reports inner 408 and opens the URL after the upstream warms up", async () => {
    // First attempt: the exact envelope captured from Taariq's console — gateway
    // wrapped the upstream's 30s timeout in a publisher-proxy DataResponse.
    // Second attempt: upstream warmed up, returns the documented NoteDataResponse
    // (status 201) inside the same envelope.
    mockAppFetch
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            status: 408,
            body: "",
            response_bytes: 0,
            execution_time_ms: 30054,
            cost: "0",
            asset_symbol: "USDC",
            payment_source: "prepaid_balance",
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          data: {
            status: 201,
            body: { data: { id: UUID, title: "Chat", format: "markdown" } },
            cost: "0.0005",
          },
        }),
      );

    const { saveToSerenNotes } = await import("@/lib/save-to-notes");
    const promise = saveToSerenNotes("Chat History", "# hi");

    // First fetch fires before any timer.
    await Promise.resolve();
    expect(mockAppFetch).toHaveBeenCalledTimes(1);

    // The retry sleep is 10s; advance past it and let the second fetch land.
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockAppFetch).toHaveBeenCalledTimes(2);
    expect(mockOpenExternalLink).toHaveBeenCalledWith(
      `https://notes.serendb.com/notes/${UUID}`,
    );
  });

  it("throws 'Seren Notes timed out' after all retries see inner 408", async () => {
    // Three responses (initial + 10s + 20s retries), all cold.
    for (let i = 0; i < 3; i++) {
      mockAppFetch.mockResolvedValueOnce(
        makeResponse({
          data: { status: 408, body: "", execution_time_ms: 30054, cost: "0" },
        }),
      );
    }

    const { saveToSerenNotes } = await import("@/lib/save-to-notes");
    const promise = saveToSerenNotes("Chat History", "# hi").catch(
      (e: Error) => e,
    );

    // Drain both retry sleeps, then await the rejection.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = (await promise) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Seren Notes timed out");
    expect(mockAppFetch).toHaveBeenCalledTimes(3);
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
  });
});
