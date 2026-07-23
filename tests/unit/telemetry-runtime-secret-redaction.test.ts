// ABOUTME: Verifies runtime Seren secret values are removed before telemetry leaves the app.
// ABOUTME: Uses the real telemetry service and observes only its outbound request body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const CANARY_ENV_NAME = "SEREN_TELEMETRY_CANARY_SECRET";
const CANARY_VALUE = "telemetry-runtime-canary";
const originalCanary = process.env[CANARY_ENV_NAME];

afterEach(() => {
  if (originalCanary === undefined) {
    delete process.env[CANARY_ENV_NAME];
  } else {
    process.env[CANARY_ENV_NAME] = originalCanary;
  }
});

describe("telemetry runtime secret redaction", () => {
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

  it("redacts a current SEREN_*_SECRET value from error and context payloads", async () => {
    process.env[CANARY_ENV_NAME] = CANARY_VALUE;
    const service = new TelemetryService({ enabled: true });

    service.captureError(new Error(`failure contains ${CANARY_VALUE}`), {
      nested: { value: CANARY_VALUE },
    });
    await service.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const body = await request.text();
    expect(body).not.toContain(CANARY_VALUE);
    expect(body).toContain("[REDACTED]");
    service.shutdown();
  });
});
