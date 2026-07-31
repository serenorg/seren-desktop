// ABOUTME: Critical regression coverage for stale Desktop automation keys (#3520).
// ABOUTME: Pins scope-drift detection and safe replacement/revocation behavior.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDefaultOrgApiKey: vi.fn(),
  listDefaultOrgApiKeys: vi.fn(),
  revokeDefaultOrgApiKey: vi.fn(),
  getSerenApiKey: vi.fn(),
  storeSerenApiKey: vi.fn(),
}));

vi.mock("@/api", () => ({
  createDefaultOrgApiKey: mocks.createDefaultOrgApiKey,
  listDefaultOrgApiKeys: mocks.listDefaultOrgApiKeys,
  revokeDefaultOrgApiKey: mocks.revokeDefaultOrgApiKey,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getSerenApiKey: mocks.getSerenApiKey,
  storeSerenApiKey: mocks.storeSerenApiKey,
}));

import {
  getDesktopApiKeyStatus,
  repairDesktopApiKey,
} from "@/services/desktop-api-access";

const staleRecord = {
  created_at: "2026-07-01T12:00:00Z",
  expires_at: null,
  id: "00000000-0000-4000-8000-000000000001",
  key_id: "legacy",
  key_prefix: "seren_legacy_",
  key_type: "user" as const,
  last_used_at: "2026-07-30T12:00:00Z",
  name: "Seren Desktop",
  organization_id: "00000000-0000-4000-8000-000000000010",
  revoked_at: null,
  scopes: ["publisher:*"],
};

const replacementRecord = {
  api_key: "seren_replacement_secret",
  created_at: "2026-08-01T12:00:00Z",
  expires_at: null,
  id: "00000000-0000-4000-8000-000000000002",
  key_id: "replacement",
  key_type: "user" as const,
  name: "Seren Desktop",
  organization_id: "00000000-0000-4000-8000-000000000010",
  scopes: ["publisher:*", "managed-deployment:update"],
};

describe("Desktop API access reconciliation (#3520)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSerenApiKey.mockResolvedValue("seren_legacy_secret");
    mocks.listDefaultOrgApiKeys.mockResolvedValue({
      data: { data: [staleRecord] },
      error: undefined,
      response: { ok: true, status: 200 },
    });
    mocks.createDefaultOrgApiKey.mockResolvedValue({
      data: { data: replacementRecord },
      error: undefined,
      response: { ok: true, status: 201 },
    });
    mocks.storeSerenApiKey.mockResolvedValue(undefined);
    mocks.revokeDefaultOrgApiKey.mockResolvedValue({
      data: {},
      error: undefined,
      response: { ok: true, status: 200 },
    });
  });

  it("detects a pre-#3490 key, replaces it, and returns a green scope state", async () => {
    const stale = await getDesktopApiKeyStatus();

    expect(stale.state).toBe("outdated");
    expect(stale.missingScopes).toEqual(["managed-deployment:update"]);
    expect(stale.unexpectedScopes).toEqual([]);
    expect(stale.maskedValue).toBe("seren_legacy_••••••••");
    expect(JSON.stringify(stale)).not.toContain("seren_legacy_secret");

    const repaired = await repairDesktopApiKey(stale);

    expect(repaired.status.state).toBe("current");
    expect(repaired.status.missingScopes).toEqual([]);
    expect(repaired.warning).toBeNull();
    expect(mocks.createDefaultOrgApiKey).toHaveBeenCalledWith({
      body: {
        name: "Seren Desktop",
        key_type: undefined,
        agent_identity_id: undefined,
        scopes: ["publisher:*", "managed-deployment:update"],
      },
      throwOnError: false,
    });
    expect(mocks.storeSerenApiKey).toHaveBeenCalledWith(
      "seren_replacement_secret",
    );
    expect(mocks.revokeDefaultOrgApiKey).toHaveBeenCalledWith({
      path: { key_id: staleRecord.id },
      throwOnError: false,
    });
    expect(
      mocks.storeSerenApiKey.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.revokeDefaultOrgApiKey.mock.invocationCallOrder[0]);
  });

  it("flags elevated scopes that are not part of Desktop's required set", async () => {
    mocks.listDefaultOrgApiKeys.mockResolvedValueOnce({
      data: {
        data: [
          {
            ...staleRecord,
            scopes: [
              "publisher:*",
              "managed-deployment:update",
              "managed-deployment:*",
            ],
          },
        ],
      },
      error: undefined,
      response: { ok: true, status: 200 },
    });

    const status = await getDesktopApiKeyStatus();

    expect(status.state).toBe("outdated");
    expect(status.missingScopes).toEqual([]);
    expect(status.unexpectedScopes).toEqual(["managed-deployment:*"]);
  });
});
