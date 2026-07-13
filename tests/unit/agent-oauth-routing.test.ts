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
    });
  });

  it("uses the default, then the sole connection", async () => {
    const { computeAgentOAuthRouting } = await import("@/services/publisher-oauth");
    await expect(computeAgentOAuthRouting("thread-default")).resolves.toEqual({
      publishers: { gmail: "conn-default", google: "conn-default" },
      ambiguous: {},
    });

    mocks.listConnections.mockResolvedValue({
      data: { connections: [connections[1]] },
    });
    await expect(computeAgentOAuthRouting("thread-sole")).resolves.toEqual({
      publishers: { gmail: "conn-other", google: "conn-other" },
      ambiguous: {},
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
    });
  });
});
