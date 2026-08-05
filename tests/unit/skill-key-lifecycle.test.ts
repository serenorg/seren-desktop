// ABOUTME: Regression coverage for #3690/#3694/#3696 — skill-key provisioning
// ABOUTME: must roll back orphaned keys and honor session invalidation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const {
  getSerenSkillApiKeyMock,
  storeSerenSkillApiKeyMock,
  createDefaultOrgApiKeyMock,
  listDefaultOrgApiKeysMock,
  revokeDefaultOrgApiKeyMock,
} = vi.hoisted(() => ({
  getSerenSkillApiKeyMock: vi.fn(async (): Promise<string | null> => null),
  storeSerenSkillApiKeyMock: vi.fn(async (_key: string) => {}),
  createDefaultOrgApiKeyMock: vi.fn(async () => ({
    data: {
      data: {
        id: "00000000-0000-0000-0000-000000000001",
        key_id: "sknew",
        api_key: "seren_sknew_secret",
        name: "Seren Desktop Skills",
        scopes: ["publisher:*"],
        key_type: "publisher",
      },
    },
    error: undefined,
    response: { ok: true },
  })),
  listDefaultOrgApiKeysMock: vi.fn(async () => ({ data: { data: [] } })),
  revokeDefaultOrgApiKeyMock: vi.fn(async () => ({
    error: undefined,
    response: { ok: true },
  })),
}));

vi.mock("@/lib/tauri-bridge", () => ({
  getSerenApiKey: vi.fn(async () => null),
  getSerenSkillApiKey: getSerenSkillApiKeyMock,
  storeSerenApiKey: vi.fn(async () => {}),
  storeSerenSkillApiKey: storeSerenSkillApiKeyMock,
}));

vi.mock("@/api", () => ({
  createDefaultOrgApiKey: createDefaultOrgApiKeyMock,
  listDefaultOrgApiKeys: listDefaultOrgApiKeysMock,
  revokeDefaultOrgApiKey: revokeDefaultOrgApiKeyMock,
}));

import { ensureSkillApiKey } from "@/services/desktop-api-access";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("skill key lifecycle (#3690)", () => {
  it("revokes the created key when the local store write fails (#3694)", async () => {
    storeSerenSkillApiKeyMock.mockRejectedValueOnce(
      new Error("keychain write denied"),
    );

    await expect(ensureSkillApiKey()).rejects.toThrow("keychain write denied");
    expect(revokeDefaultOrgApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("revokes instead of storing when the session went stale mid-flight (#3696)", async () => {
    await ensureSkillApiKey({ isCurrent: () => false });

    expect(storeSerenSkillApiKeyMock).not.toHaveBeenCalled();
    expect(revokeDefaultOrgApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("stores the key for a still-current session", async () => {
    await ensureSkillApiKey({ isCurrent: () => true });

    expect(storeSerenSkillApiKeyMock).toHaveBeenCalledTimes(1);
    expect(revokeDefaultOrgApiKeyMock).not.toHaveBeenCalled();
  });
});

describe("memory interceptor retry wiring (#3690)", () => {
  it("re-runs the start effect when a later provisioning succeeds", () => {
    const appSource = readFileSync("src/App.tsx", "utf8");
    const authSource = readFileSync("src/stores/auth.store.ts", "utf8");

    // The effect must track the provisioning counter — isAuthenticated stays
    // true across refreshes and never re-fires the effect on its own.
    expect(appSource).toContain("void authStore.skillKeyEpoch;");
    expect(authSource).toContain('setState("skillKeyEpoch", (count) => count + 1)');
    // The counter only advances on success, inside the guarded provisioner.
    expect(authSource).toContain(
      "ensureSkillApiKey({ isCurrent: () => !authEpochChanged(epoch) })",
    );
  });
});
