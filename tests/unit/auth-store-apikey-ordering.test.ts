// ABOUTME: Regression test for #1613 — the SerenDB API key must be provisioned
// ABOUTME: BEFORE authStore.isAuthenticated flips true, so downstream consumers don't race.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSerenApiKeyMock,
  storeSerenApiKeyMock,
  clearSerenApiKeyMock,
  isTauriRuntimeMock,
  isLoggedInMock,
  hasStoredTokenMock,
  createApiKeyMock,
  authLogoutMock,
  initializeGatewayMock,
  resetGatewayMock,
  runtimeHasCapabilityMock,
  getPolicyMock,
  storedKeyRef,
  listenMock,
  eventListeners,
} = vi.hoisted(() => {
  const storedKey: { value: string | null } = { value: null };
  const listeners = new Map<string, (event?: unknown) => unknown>();
  return {
    storedKeyRef: storedKey,
    getSerenApiKeyMock: vi.fn(async () => storedKey.value),
    storeSerenApiKeyMock: vi.fn(async (key: string) => {
      storedKey.value = key;
    }),
    clearSerenApiKeyMock: vi.fn(async () => {
      storedKey.value = null;
    }),
    isTauriRuntimeMock: vi.fn(() => false),
    isLoggedInMock: vi.fn(async () => true),
    hasStoredTokenMock: vi.fn(async () => true),
    createApiKeyMock: vi.fn(async () => "seren-api-key-fresh"),
    authLogoutMock: vi.fn(async () => {}),
    initializeGatewayMock: vi.fn(async () => {}),
    resetGatewayMock: vi.fn(async () => {}),
    runtimeHasCapabilityMock: vi.fn(() => false),
    getPolicyMock: vi.fn(async () => null),
    eventListeners: listeners,
    listenMock: vi.fn(async (event: string, handler: (event?: unknown) => unknown) => {
      listeners.set(event, handler);
      return vi.fn();
    }),
  };
});

vi.mock("@/lib/tauri-bridge", () => ({
  getSerenApiKey: getSerenApiKeyMock,
  storeSerenApiKey: storeSerenApiKeyMock,
  clearSerenApiKey: clearSerenApiKeyMock,
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock("@/services/auth", () => ({
  isLoggedIn: isLoggedInMock,
  hasStoredToken: hasStoredTokenMock,
  createApiKey: createApiKeyMock,
  logout: authLogoutMock,
}));

vi.mock("@/services/mcp-gateway", () => ({
  initializeGateway: initializeGatewayMock,
  resetGateway: resetGatewayMock,
}));

vi.mock("@/lib/runtime", () => ({
  runtimeHasCapability: runtimeHasCapabilityMock,
}));

vi.mock("@/services/organization-policy", () => ({
  getDefaultOrganizationPrivateChatPolicy: getPolicyMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

// reportApiKeyFailure dynamically imports this on the failure path; stub it so
// the tests stay deterministic and the output stays pristine.
vi.mock("@/lib/support/hook", () => ({
  captureSupportError: vi.fn(),
}));

import {
  authStore,
  checkAuth,
  clearAuthState,
  initAuthRuntimeBindings,
  requestSignInModal,
  setAuthenticated,
} from "@/stores/auth.store";

function resetAuthStore() {
  // Drop internal state by calling logout(): resets user, isAuthenticated,
  // mcpConnected, privateChatPolicy, and clears any stored API key.
  // Use the mocked services so this never hits network / Tauri.
  // Returns a Promise; callers can await it.
  storedKeyRef.value = null;
  (authStore as unknown as { isAuthenticated: boolean }).isAuthenticated =
    false;
  (authStore as unknown as { isLoading: boolean }).isLoading = true;
  (authStore as unknown as { user: unknown }).user = null;
  (authStore as unknown as { mcpConnected: boolean }).mcpConnected = false;
  (authStore as unknown as { privateChatPolicy: unknown }).privateChatPolicy =
    null;
  (
    authStore as unknown as { signInModalRequested: boolean }
  ).signInModalRequested = false;
}

describe("auth.store #1613 — API key before isAuthenticated flips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    isTauriRuntimeMock.mockReturnValue(false);
    hasStoredTokenMock.mockResolvedValue(true);
    runtimeHasCapabilityMock.mockReturnValue(false);
    resetAuthStore();
  });

  it("setAuthenticated: stores API key BEFORE flipping isAuthenticated (fresh login)", async () => {
    // Fresh install: no stored key yet.
    storedKeyRef.value = null;

    let authAtStoreTime: boolean | null = null;
    storeSerenApiKeyMock.mockImplementationOnce(async (key: string) => {
      // Capture the reactive auth flag at the exact moment the key lands.
      authAtStoreTime = authStore.isAuthenticated;
      storedKeyRef.value = key;
    });

    expect(authStore.isAuthenticated).toBe(false);

    await setAuthenticated({ id: "u1", email: "u@test", name: "U" });

    // Critical ordering invariant: at the moment the key was written, the
    // user was NOT yet marked authenticated. Anything listening on
    // `isAuthenticated` (Claude memory interceptor — #1613) that reads the
    // key is therefore guaranteed to see it.
    expect(storeSerenApiKeyMock).toHaveBeenCalledTimes(1);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
    expect(authAtStoreTime).toBe(false);

    // Final state: key in the store, flag flipped, user populated.
    expect(storedKeyRef.value).toBe("seren-api-key-fresh");
    expect(authStore.isAuthenticated).toBe(true);
    expect(authStore.user).toEqual({ id: "u1", email: "u@test", name: "U" });
  });

  it("checkAuth: stores API key BEFORE flipping isAuthenticated (cold boot)", async () => {
    storedKeyRef.value = null;
    isLoggedInMock.mockResolvedValueOnce(true);

    let authAtStoreTime: boolean | null = null;
    storeSerenApiKeyMock.mockImplementationOnce(async (key: string) => {
      authAtStoreTime = authStore.isAuthenticated;
      storedKeyRef.value = key;
    });

    expect(authStore.isAuthenticated).toBe(false);

    await checkAuth();

    expect(storeSerenApiKeyMock).toHaveBeenCalledTimes(1);
    expect(authAtStoreTime).toBe(false);
    expect(storedKeyRef.value).toBeTruthy();
    expect(authStore.isAuthenticated).toBe(true);
  });

  it("setAuthenticated: existing stored key — no create call, still no premature flip", async () => {
    // Returning user: key already in the store. We must NOT create a new one
    // and the flag still flips only after ensureApiKey returns.
    storedKeyRef.value = "cached-key";

    let authAtGetTime: boolean | null = null;
    getSerenApiKeyMock.mockImplementationOnce(async () => {
      authAtGetTime = authStore.isAuthenticated;
      return "cached-key";
    });

    await setAuthenticated({ id: "u1", email: "u@test", name: "U" });

    expect(createApiKeyMock).not.toHaveBeenCalled();
    expect(storeSerenApiKeyMock).not.toHaveBeenCalled();
    expect(authAtGetTime).toBe(false);
    expect(authStore.isAuthenticated).toBe(true);
  });

  it("backend token refresh event restores auth after provisioning key and dismisses stale modal", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    storedKeyRef.value = null;

    let authAtStoreTime: boolean | null = null;
    storeSerenApiKeyMock.mockImplementationOnce(async (key: string) => {
      authAtStoreTime = authStore.isAuthenticated;
      storedKeyRef.value = key;
    });

    requestSignInModal();
    clearAuthState();
    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.signInModalRequested).toBe(true);

    await initAuthRuntimeBindings();

    expect(listenMock).toHaveBeenCalledWith(
      "auth:token-refreshed",
      expect.any(Function),
    );

    const onTokenRefreshed = eventListeners.get("auth:token-refreshed");
    expect(onTokenRefreshed).toBeTypeOf("function");
    await onTokenRefreshed?.();

    expect(storeSerenApiKeyMock).toHaveBeenCalledTimes(1);
    expect(createApiKeyMock).toHaveBeenCalledTimes(1);
    expect(authAtStoreTime).toBe(false);
    expect(authStore.isAuthenticated).toBe(true);
    expect(authStore.signInModalRequested).toBe(false);
  });
});

describe("auth.store #2497 — API key provisioning failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventListeners.clear();
    isTauriRuntimeMock.mockReturnValue(false);
    hasStoredTokenMock.mockResolvedValue(true);
    isLoggedInMock.mockResolvedValue(true);
    runtimeHasCapabilityMock.mockReturnValue(false);
    resetAuthStore();
  });

  for (const status of [401, 403]) {
    it(`HTTP ${status} key failure does NOT flip isAuthenticated and raises the sign-in modal`, async () => {
      storedKeyRef.value = null;
      createApiKeyMock.mockRejectedValueOnce(
        Object.assign(new Error(`Forbidden (returned HTTP ${status})`), {
          status,
        }),
      );

      await setAuthenticated({ id: "u1", email: "u@test", name: "U" });

      // Genuine auth/permission failure: the logged-in shell must NOT appear,
      // the key must not be stored, and the user must be told to sign in again.
      expect(authStore.isAuthenticated).toBe(false);
      expect(authStore.signInModalRequested).toBe(true);
      expect(storeSerenApiKeyMock).not.toHaveBeenCalled();
    });
  }

  for (const status of [500, 503]) {
    it(`HTTP ${status} key failure KEEPS the session so chat still works (no forced sign-in)`, async () => {
      storedKeyRef.value = null;
      createApiKeyMock.mockRejectedValueOnce(
        Object.assign(new Error(`Server error (returned HTTP ${status})`), {
          status,
        }),
      );

      await setAuthenticated({ id: "u1", email: "u@test", name: "U" });

      // The JWT is still valid; the SerenDB key is only needed by MCP tools +
      // the Claude memory interceptor, not the primary chat path. Blocking the
      // whole session here would break chat for an otherwise-valid user.
      expect(authStore.isAuthenticated).toBe(true);
      expect(authStore.signInModalRequested).toBe(false);
    });
  }

  it("a status-less (network) key failure also keeps the session", async () => {
    storedKeyRef.value = null;
    createApiKeyMock.mockRejectedValueOnce(new Error("network unreachable"));

    await setAuthenticated({ id: "u1", email: "u@test", name: "U" });

    expect(authStore.isAuthenticated).toBe(true);
    expect(authStore.signInModalRequested).toBe(false);
  });
});
