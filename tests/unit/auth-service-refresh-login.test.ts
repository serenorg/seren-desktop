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
  isTauriRuntime: vi.fn<() => boolean>(),
  invoke: vi.fn(),
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
  isTauriRuntime: mocks.isTauriRuntime,
}));

vi.mock("@/stores/auth.store", () => ({
  clearAuthState: mocks.clearAuthState,
  requestSignInModal: mocks.requestSignInModal,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("auth service refresh during login validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.isTauriRuntime.mockReturnValue(false);
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

  it("shares concurrent Tauri refresh calls through one backend invoke", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.getRefreshToken.mockResolvedValue("valid-refresh-token");
    const refresh = deferred<boolean>();
    mocks.invoke.mockReturnValue(refresh.promise);

    const { refreshAccessToken } = await import("@/services/auth");

    const callers = [
      refreshAccessToken(),
      refreshAccessToken({ promptOnFailure: false }),
      refreshAccessToken(),
    ];
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("refresh_session");

    refresh.resolve(true);

    await expect(Promise.all(callers)).resolves.toEqual([true, true, true]);
    // The token-presence gate runs once for the deduped in-flight refresh.
    expect(mocks.getRefreshToken).toHaveBeenCalledTimes(1);
    expect(mocks.refreshToken).not.toHaveBeenCalled();
    expect(mocks.clearAuthState).not.toHaveBeenCalled();
    expect(mocks.requestSignInModal).not.toHaveBeenCalled();
  });

  it("never raises the sign-in modal for a signed-out user (Tauri, no refresh token)", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.getRefreshToken.mockResolvedValue(null);

    const { refreshAccessToken } = await import("@/services/auth");

    await expect(refreshAccessToken()).resolves.toBe(false);

    // No session to refresh: the backend is never invoked and the
    // "session expired" modal must stay closed.
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.requestSignInModal).not.toHaveBeenCalled();
    expect(mocks.clearAuthState).toHaveBeenCalledTimes(1);
  });

  it("never raises the sign-in modal for a signed-out user (browser, no refresh token)", async () => {
    mocks.isTauriRuntime.mockReturnValue(false);
    mocks.getRefreshToken.mockResolvedValue(null);

    const { refreshAccessToken } = await import("@/services/auth");

    await expect(refreshAccessToken()).resolves.toBe(false);

    expect(mocks.refreshToken).not.toHaveBeenCalled();
    expect(mocks.requestSignInModal).not.toHaveBeenCalled();
    expect(mocks.clearAuthState).toHaveBeenCalledTimes(1);
  });

  it("raises the sign-in modal when a present refresh token is rejected (genuine expiry)", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.getRefreshToken.mockResolvedValue("expired-refresh-token");
    mocks.invoke.mockResolvedValue(false);

    const { refreshAccessToken } = await import("@/services/auth");

    await expect(refreshAccessToken()).resolves.toBe(false);

    expect(mocks.invoke).toHaveBeenCalledWith("refresh_session");
    expect(mocks.clearAuthState).toHaveBeenCalledTimes(1);
    expect(mocks.requestSignInModal).toHaveBeenCalledTimes(1);
  });

  it("does not raise the modal on genuine expiry when prompting is disabled", async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.getRefreshToken.mockResolvedValue("expired-refresh-token");
    mocks.invoke.mockResolvedValue(false);

    const { refreshAccessToken } = await import("@/services/auth");

    await expect(
      refreshAccessToken({ promptOnFailure: false }),
    ).resolves.toBe(false);

    expect(mocks.clearAuthState).toHaveBeenCalledTimes(1);
    expect(mocks.requestSignInModal).not.toHaveBeenCalled();
  });
});
