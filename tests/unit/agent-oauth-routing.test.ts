import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  listConnections: vi.fn(),
  listProviders: vi.fn(),
  listStorePublishers: vi.fn(),
}));

vi.mock("@/api", () => ({
  listConnections: mocks.listConnections,
  listProviders: mocks.listProviders,
  listStorePublishers: mocks.listStorePublishers,
  revokeConnectionById: vi.fn(),
  setDefaultConnection: vi.fn(),
}));
vi.mock("@/lib/tauri-bridge", () => ({ getToken: mocks.getToken }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const connections = [
  { id: "conn-default", provider_slug: "google", provider_email: "default@example.com", is_valid: true, is_default: true },
  { id: "conn-other", provider_slug: "google", provider_email: "other@example.com", is_valid: true, is_default: false },
];

const accountRouting = (
  activeConnectionId: string | null,
  selectionSource: "thread" | "default" | "sole" | "ambiguous",
  rows = connections,
) => ({
  providerSlug: "google",
  providerName: "Google",
  activeConnectionId,
  selectionSource,
  connections: rows.map((connection) => ({
    connectionId: connection.id,
    label: connection.provider_email,
    isDefault: connection.is_default,
  })),
});

describe("computeAgentOAuthRouting", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getToken.mockResolvedValue("token");
    mocks.listConnections.mockResolvedValue({ data: { connections } });
    mocks.listProviders.mockResolvedValue({ data: { providers: [{ id: "google-provider", slug: "google", name: "Google" }] } });
    mocks.listStorePublishers.mockResolvedValue({ data: { data: [{ slug: "gmail", oauth_provider_id: "google-provider" }] } });
  });

  it("prefers an explicit thread selection over the default", async () => {
    const { setThreadOAuthConnectionId } = await import("@/stores/oauth-account.store");
    setThreadOAuthConnectionId("thread-routing", "google", "conn-other");
    const { computeAgentOAuthRouting } = await import("@/services/publisher-oauth");
    await expect(computeAgentOAuthRouting("thread-routing")).resolves.toEqual({
      publishers: { gmail: "conn-other", google: "conn-other" },
      ambiguous: {},
      accounts: {
        gmail: accountRouting("conn-other", "thread"),
        google: accountRouting("conn-other", "thread"),
      },
      available: true,
    });
  });

  it("uses the default, then the sole connection", async () => {
    const { computeAgentOAuthRouting } = await import("@/services/publisher-oauth");
    await expect(computeAgentOAuthRouting("thread-default")).resolves.toEqual({
      publishers: { gmail: "conn-default", google: "conn-default" },
      ambiguous: {},
      accounts: {
        gmail: accountRouting("conn-default", "default"),
        google: accountRouting("conn-default", "default"),
      },
      available: true,
    });

    mocks.listConnections.mockResolvedValue({
      data: { connections: [connections[1]] },
    });
    await expect(computeAgentOAuthRouting("thread-sole")).resolves.toEqual({
      publishers: { gmail: "conn-other", google: "conn-other" },
      ambiguous: {},
      accounts: {
        gmail: accountRouting("conn-other", "sole", [connections[1]]),
        google: accountRouting("conn-other", "sole", [connections[1]]),
      },
      available: true,
    });
  });

  it("marks multiple connections without a default or selection ambiguous", async () => {
    mocks.listConnections.mockResolvedValue({
      data: { connections: connections.map((connection) => ({ ...connection, is_default: false })) },
    });
    const { computeAgentOAuthRouting } = await import("@/services/publisher-oauth");
    await expect(computeAgentOAuthRouting("thread-ambiguous")).resolves.toEqual({
      publishers: {},
      ambiguous: {
        gmail: expect.stringContaining("Multiple Google accounts are connected"),
        google: expect.stringContaining("Multiple Google accounts are connected"),
      },
      accounts: {
        gmail: accountRouting(null, "ambiguous", connections.map((connection) => ({ ...connection, is_default: false }))),
        google: accountRouting(null, "ambiguous", connections.map((connection) => ({ ...connection, is_default: false }))),
      },
      available: true,
    });
  });

  it("marks routing unavailable when account discovery fails", async () => {
    mocks.listConnections.mockResolvedValue({ error: "offline" });
    const { computeAgentOAuthRouting } = await import("@/services/publisher-oauth");
    await expect(computeAgentOAuthRouting("thread-error")).resolves.toEqual({
      publishers: {},
      ambiguous: {},
      available: false,
    });
  });
});
