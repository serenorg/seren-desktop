// ABOUTME: Ensures logout asks Rust to revoke active session leases before clearing auth storage.
// ABOUTME: A local event log verifies the security-sensitive ordering without any network request.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { events, mocks } = vi.hoisted(() => {
  const eventLog: string[] = [];
  return {
    events: eventLog,
    mocks: {
      revokeAllCredentialLeases: vi.fn(async () => eventLog.push("revoke")),
      clearToken: vi.fn(async () => eventLog.push("clear-token")),
      clearRefreshToken: vi.fn(async () => eventLog.push("clear-refresh")),
      clearDefaultOrganizationId: vi.fn(async () => eventLog.push("clear-org")),
    },
  };
});

vi.mock("@/api", () => ({
  createDefaultOrgApiKey: vi.fn(),
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  refreshToken: vi.fn(),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  clearDefaultOrganizationId: mocks.clearDefaultOrganizationId,
  clearRefreshToken: mocks.clearRefreshToken,
  clearToken: mocks.clearToken,
  getRefreshToken: vi.fn(),
  getToken: vi.fn(),
  isTauriRuntime: vi.fn(() => false),
  storeDefaultOrganizationId: vi.fn(),
  storeRefreshToken: vi.fn(),
  storeToken: vi.fn(),
}));

vi.mock("@/services/credential-lease", () => ({
  revokeAllCredentialLeases: mocks.revokeAllCredentialLeases,
}));

vi.mock("@/stores/auth.store", () => ({
  clearAuthState: vi.fn(),
  requestSignInModal: vi.fn(),
}));

import { logout } from "@/services/auth";

describe("logout credential lease revocation (#3194)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
  });

  it("revokes all leases before clearing stored authentication", async () => {
    await logout();

    expect(events).toEqual(["revoke", "clear-token", "clear-refresh", "clear-org"]);
  });
});
