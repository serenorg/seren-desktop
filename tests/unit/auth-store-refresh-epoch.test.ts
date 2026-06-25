// ABOUTME: Regression coverage for backend auth event ordering.
// ABOUTME: Ensures late token-refreshed handlers cannot undo session-expired state.

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event?: unknown) => unknown>();
  return {
    clearSerenApiKey: vi.fn(async () => {}),
    getSerenApiKey: vi.fn(async () => "seren-api-key"),
    storeSerenApiKey: vi.fn(async () => {}),
    isTauriRuntime: vi.fn(() => true),
    isLoggedIn: vi.fn(async () => true),
    hasStoredToken: vi.fn(async () => true),
    createApiKey: vi.fn(async () => "seren-api-key-fresh"),
    authLogout: vi.fn(async () => {}),
    initializeGateway: vi.fn(async () => {}),
    resetGateway: vi.fn(async () => {}),
    runtimeHasCapability: vi.fn(() => false),
    getPolicy: vi.fn(),
    resetRemoteCatalog: vi.fn(),
    eventListeners: listeners,
    listen: vi.fn(async (event: string, handler: (event?: unknown) => unknown) => {
      listeners.set(event, handler);
      return vi.fn();
    }),
  };
});

vi.mock("@/lib/tauri-bridge", () => ({
  clearSerenApiKey: mocks.clearSerenApiKey,
  getSerenApiKey: mocks.getSerenApiKey,
  storeSerenApiKey: mocks.storeSerenApiKey,
  isTauriRuntime: mocks.isTauriRuntime,
}));

vi.mock("@/services/auth", () => ({
  isLoggedIn: mocks.isLoggedIn,
  hasStoredToken: mocks.hasStoredToken,
  createApiKey: mocks.createApiKey,
  logout: mocks.authLogout,
}));

vi.mock("@/services/mcp-gateway", () => ({
  initializeGateway: mocks.initializeGateway,
  resetGateway: mocks.resetGateway,
}));

vi.mock("@/lib/runtime", () => ({
  runtimeHasCapability: mocks.runtimeHasCapability,
}));

vi.mock("@/services/organization-policy", () => ({
  getDefaultOrganizationPrivateChatPolicy: mocks.getPolicy,
}));

vi.mock("@/stores/skills.store", () => ({
  skillsStore: { resetRemoteCatalog: mocks.resetRemoteCatalog },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
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

describe("auth.store backend refresh event ordering", () => {
  it("keeps session-expired state when token-refreshed resolves late", async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.eventListeners.clear();
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.hasStoredToken.mockResolvedValue(true);
    mocks.runtimeHasCapability.mockReturnValue(false);

    const policy = deferred<null>();
    mocks.getPolicy.mockReturnValue(policy.promise);

    const { authStore, initAuthRuntimeBindings } = await import(
      "@/stores/auth.store"
    );
    (authStore as unknown as { isAuthenticated: boolean }).isAuthenticated =
      true;
    (
      authStore as unknown as { signInModalRequested: boolean }
    ).signInModalRequested = false;

    await initAuthRuntimeBindings();

    const onTokenRefreshed = mocks.eventListeners.get("auth:token-refreshed");
    const onSessionExpired = mocks.eventListeners.get("auth:session-expired");
    expect(onTokenRefreshed).toBeTypeOf("function");
    expect(onSessionExpired).toBeTypeOf("function");

    const tokenRefreshedPromise = onTokenRefreshed?.() as Promise<void>;
    await Promise.resolve();

    onSessionExpired?.();
    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.signInModalRequested).toBe(true);

    policy.resolve(null);
    await tokenRefreshedPromise;

    expect(mocks.createApiKey).not.toHaveBeenCalled();
    expect(authStore.isAuthenticated).toBe(false);
    expect(authStore.signInModalRequested).toBe(true);
  });
});
