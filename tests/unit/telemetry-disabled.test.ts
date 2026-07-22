// ABOUTME: Verifies telemetry stays silent while the persisted setting is off.
// ABOUTME: Covers queue dropping and re-enabling through the real telemetry service.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, getTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getTokenMock: vi.fn(async () => null),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getToken: getTokenMock,
}));

vi.mock("@/lib/tauri-fetch", () => ({
  getTauriFetch: vi.fn(async () => globalThis.fetch),
  shouldSkipRefresh: vi.fn(() => true),
  shouldUseRustGatewayAuth: vi.fn(() => false),
}));

import { TelemetryService } from "@/services/telemetry";

describe("telemetry disabled behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { userAgent: "Seren test runner" });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  });

  it("sends nothing while disabled, drops queued errors, and resumes when enabled", async () => {
    const service = new TelemetryService({
      enabled: false,
      batchIntervalMs: 60_000,
    });

    service.captureError(new Error("disabled error"));
    await service.flush();
    expect(fetchMock).not.toHaveBeenCalled();

    service.setEnabled(true);
    service.captureError(new Error("enabled error"));
    await service.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe(
      "https://api.serendb.com/diagnostics/errors",
    );

    service.captureError(new Error("discarded after disable"));
    service.setEnabled(false);
    await service.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.setEnabled(true);
    await service.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    service.shutdown();
    expect(getTokenMock).toHaveBeenCalled();
  });
});
