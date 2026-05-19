// ABOUTME: Regression tests for expired access tokens with still-valid refresh tokens.
// ABOUTME: Prevents cold-start false sign-out when /auth/me returns 401.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  refreshToken: vi.fn(),
  getToken: vi.fn<() => Promise<string | null>>(),
  getRefreshToken: vi.fn<() => Promise<string | null>>(),
  storeToken: vi.fn<(token: string) => Promise<void>>(),
  storeRefreshToken: vi.fn<(token: string) => Promise<void>>(),
  storeDefaultOrganizationId: vi.fn<(id: string) => Promise<void>>(),
  clearToken: vi.fn<() => Promise<void>>(),
  clearRefreshToken: vi.fn<() => Promise<void>>(),
  clearDefaultOrganizationId: vi.fn<() => Promise<void>>(),
  clearAuthState: vi.fn<() => void>(),
  requestSignInModal: vi.fn<() => void>(),
}));

vi.mock("@/api", () => ({
  getCurrentUser: mocks.getCurrentUser,
  refreshToken: mocks.refreshToken,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getToken: mocks.getToken,
  getRefreshToken: mocks.getRefreshToken,
  storeToken: mocks.storeToken,
  storeRefreshToken: mocks.storeRefreshToken,
  storeDefaultOrganizationId: mocks.storeDefaultOrganizationId,
  clearToken: mocks.clearToken,
  clearRefreshToken: mocks.clearRefreshToken,
  clearDefaultOrganizationId: mocks.clearDefaultOrganizationId,
}));

vi.mock("@/stores/auth.store", () => ({
  clearAuthState: mocks.clearAuthState,
  requestSignInModal: mocks.requestSignInModal,
}));

describe("auth service refresh during login validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses a valid refresh token before declaring the user signed out", async () => {
    mocks.getToken.mockResolvedValue("expired-access-token");
    mocks.getRefreshToken.mockResolvedValue("valid-refresh-token");
    mocks.getCurrentUser
      .mockResolvedValueOnce({
        error: { message: "Unauthorized" },
        response: new Response(null, { status: 401 }),
      })
      .mockResolvedValueOnce({
        data: { data: { id: "user-1", email: "u@test", name: "User" } },
      });
    mocks.refreshToken.mockResolvedValue({
      data: {
        data: {
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
        },
      },
    });

    const { isLoggedIn } = await import("@/services/auth");

    await expect(isLoggedIn()).resolves.toBe(true);

    expect(mocks.refreshToken).toHaveBeenCalledWith({
      body: { refresh_token: "valid-refresh-token" },
      throwOnError: false,
    });
    expect(mocks.storeToken).toHaveBeenCalledWith("fresh-access-token");
    expect(mocks.storeRefreshToken).toHaveBeenCalledWith("fresh-refresh-token");
    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(2);
    expect(mocks.clearToken).not.toHaveBeenCalled();
    expect(mocks.clearAuthState).not.toHaveBeenCalled();
    expect(mocks.requestSignInModal).not.toHaveBeenCalled();
  });
});
