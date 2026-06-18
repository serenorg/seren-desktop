// ABOUTME: Critical DocReader envelope tests for Gateway transport-200 publisher failures.
// ABOUTME: Prevents upstream 5xx responses from being misreported as empty documents.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@/lib/providers/types";

const mockAppFetch = vi.hoisted(() => vi.fn());
const mockGetToken = vi.hoisted(() => vi.fn());
const mockShouldUseRustGatewayAuth = vi.hoisted(() => vi.fn());
const mockUpdateBalanceFromError = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fetch", () => ({ appFetch: mockAppFetch }));
vi.mock("@/services/auth", () => ({ getToken: mockGetToken }));
vi.mock("@/lib/tauri-fetch", () => ({
  shouldUseRustGatewayAuth: mockShouldUseRustGatewayAuth,
}));
vi.mock("@/stores/wallet.store", () => ({
  updateBalanceFromError: mockUpdateBalanceFromError,
}));
vi.mock("@/lib/config", () => ({ apiBase: "https://api.serendb.com" }));

function makeJsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  } as unknown as Response;
}

const attachment: Attachment = {
  name: "resume.docx",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  base64: "ZmFrZQ==",
};

describe("readDocument", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetToken.mockResolvedValue("test-token");
    mockShouldUseRustGatewayAuth.mockReturnValue(false);
  });

  it("surfaces publisher-inner 5xx errors before trying to extract text", async () => {
    mockAppFetch.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          status: 500,
          body: { message: "Internal Server Error" },
          response_bytes: 35,
          execution_time_ms: 104,
          cost: "0",
          asset_symbol: "USDC",
          payment_source: "prepaid_balance",
        },
      }),
    );

    const { readDocument } = await import("@/services/docreader");

    await expect(readDocument(attachment)).rejects.toThrow(
      "DocReader service failed (500): Internal Server Error",
    );
  });
});
