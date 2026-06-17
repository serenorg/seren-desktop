// ABOUTME: #2497 Defect 1 — createApiKey() must carry the HTTP status so the
// ABOUTME: auth store can tell a non-transient 401/403 from a retryable 5xx.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createDefaultOrgApiKeyMock } = vi.hoisted(() => ({
  createDefaultOrgApiKeyMock: vi.fn(),
}));

vi.mock("@/api", () => ({
  createDefaultOrgApiKey: createDefaultOrgApiKeyMock,
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  refreshToken: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  clearDefaultOrganizationId: vi.fn(),
  clearRefreshToken: vi.fn(),
  clearToken: vi.fn(),
  getRefreshToken: vi.fn(),
  getToken: vi.fn(),
  isTauriRuntime: vi.fn(() => false),
  storeDefaultOrganizationId: vi.fn(),
  storeRefreshToken: vi.fn(),
  storeToken: vi.fn(),
}));

// Break the auth.ts <-> auth.store circular import for this focused test.
vi.mock("@/stores/auth.store", () => ({
  clearAuthState: vi.fn(),
  requestSignInModal: vi.fn(),
}));

import { ApiKeyProvisioningError, createApiKey } from "@/services/auth";

function errorResult(status: number, body: unknown) {
  return {
    data: undefined,
    error: { message: typeof body === "string" ? body : undefined },
    response: {
      status,
      clone: () => ({ json: async () => body }),
    },
  };
}

describe("createApiKey HTTP status (#2497 Defect 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the api_key on success", async () => {
    createDefaultOrgApiKeyMock.mockResolvedValueOnce({
      data: { data: { api_key: "seren_live_abc" } },
      error: undefined,
      response: { status: 201 },
    });
    await expect(createApiKey()).resolves.toBe("seren_live_abc");
  });

  for (const status of [401, 403, 500]) {
    it(`throws an ApiKeyProvisioningError carrying status ${status}`, async () => {
      createDefaultOrgApiKeyMock.mockResolvedValueOnce(
        errorResult(status, { message: "denied" }),
      );

      const err = await createApiKey().then(
        () => {
          throw new Error("expected createApiKey to reject");
        },
        (e) => e as ApiKeyProvisioningError,
      );

      expect(err).toBeInstanceOf(ApiKeyProvisioningError);
      expect(err.status).toBe(status);
      // Also reachable by the App.tsx `returned HTTP <status>` regex.
      expect(err.message).toMatch(new RegExp(`returned HTTP ${status}`));
    });
  }

  it("is an ApiKeyProvisioningError instance even when no status is present", async () => {
    createDefaultOrgApiKeyMock.mockResolvedValueOnce({
      data: undefined,
      error: { message: "boom" },
      response: undefined,
    });
    await createApiKey().catch((err) => {
      expect(err).toBeInstanceOf(ApiKeyProvisioningError);
      expect(err.status).toBeUndefined();
    });
  });
});
