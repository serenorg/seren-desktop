// ABOUTME: Verifies renderer lease helpers issue the exact Rust command names.
// ABOUTME: The invoke spy observes the command boundary without creating any real credential.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  createCredentialLease,
  revokeAllCredentialLeases,
  revokeCredentialLease,
} from "@/services/credential-lease";

describe("credential lease renderer bridge (#3194)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and revokes a session lease through the Rust command boundary", async () => {
    invokeMock.mockResolvedValueOnce({
      sessionId: "session-a",
      keyId: "key-a",
      apiKey: "session-only-value",
      expiresAt: "2030-01-01T00:00:00Z",
    });

    await createCredentialLease("session-a");
    await revokeCredentialLease("session-a");
    await revokeAllCredentialLeases();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "credential_lease_create", {
      sessionId: "session-a",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "credential_lease_revoke", {
      sessionId: "session-a",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "credential_lease_revoke_all");
  });
});
