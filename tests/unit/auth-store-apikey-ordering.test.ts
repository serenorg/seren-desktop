// ABOUTME: Regression test for #1613 — the SerenDB API key must be provisioned
// ABOUTME: BEFORE authStore.isAuthenticated flips true, so downstream consumers don't race.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSerenApiKeyMock,
  storeSerenApiKeyMock,
  clearSerenApiKeyMock,
  isTauriRuntimeMock,
  isLoggedInMock,
  createApiKeyMock,
  authLogoutMock,
  initializeGatewayMock,
  resetGatewayMock,
  addSerenDbServerMock,
  removeSerenDbServerMock,
  runtimeHasCapabilityMock,
  getPolicyMock,
  storedKeyRef,
} = vi.hoisted(() => {
  const storedKey: { value: string | null } = { value: null };
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
    createApiKeyMock: vi.fn(async () => "seren-api-key-fresh"),
    authLogoutMock: vi.fn(async () => {}),
    initializeGatewayMock: vi.fn(async () => {}),
    resetGatewayMock: vi.fn(async () => {}),
    addSerenDbServerMock: vi.fn(async () => {}),
    removeSerenDbServerMock: vi.fn(async () => {}),
    runtimeHasCapabilityMock: vi.fn(() => false),
    getPolicyMock: vi.fn(async () => null),
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
  createApiKey: createApiKeyMock,
  logout: authLogoutMock,
}));

vi.mock("@/services/mcp-gateway", () => ({
  initializeGateway: initializeGatewayMock,
  resetGateway: resetGatewayMock,
}));

vi.mock("@/lib/mcp/serendb", () => ({
  addSerenDbServer: addSerenDbServerMock,
  removeSerenDbServer: removeSerenDbServerMock,
}));

vi.mock("@/lib/runtime", () => ({
  runtimeHasCapability: runtimeHasCapabilityMock,
}));

vi.mock("@/services/organization-policy", () => ({
  getDefaultOrganizationPrivateChatPolicy: getPolicyMock,
}));

import { authStore, checkAuth, setAuthenticated } from "@/stores/auth.store";

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
}

describe("auth.store #1613 — API key before isAuthenticated flips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
