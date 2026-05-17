import { beforeEach, describe, expect, it, vi } from "vitest";
import { suggestPublishers } from "@/api";
import type { PublisherResponse } from "@/api";
import {
  catalog,
  formatMcpDiscoveryStatus,
  normalizeMcpDiscoveryStatus,
  transformPublisher,
} from "@/services/catalog";

vi.mock("@/api", () => ({
  getStorePublisher: vi.fn(),
  listStorePublishers: vi.fn(),
  suggestPublishers: vi.fn(),
}));

function publisherResponse(
  overrides: Partial<PublisherResponse> & {
    mcp_discovery?: unknown;
  } = {},
): PublisherResponse {
  return {
    allowed_passthrough_headers: [],
    billing_model: "prepaid_credits",
    capabilities: [],
    categories: [],
    created_at: "2026-05-16T00:00:00Z",
    gateway_fee_percent: "0",
    id: "publisher-id",
    is_active: true,
    is_verified: false,
    name: "MCP Search",
    ownership_tracking_enabled: false,
    passthrough_header_rewrite: {},
    publisher_category: "integration",
    publisher_type: "individual",
    request_content_type: "application/json",
    slug: "mcp-search",
    total_queries: 0,
    total_revenue_atomic: 0,
    unique_agents_served: 0,
    updated_at: "2026-05-16T00:00:00Z",
    upstream_headers: {},
    use_cases: [],
    wallet_address: "0x1111111111111111111111111111111111111111",
    wallet_network_id: "eip155:1",
    ...overrides,
  } as PublisherResponse;
}

describe("publisher catalog MCP discovery status", () => {
  beforeEach(() => {
    vi.mocked(suggestPublishers).mockReset();
  });

  it("carries MCP discovery error state into normalized publishers", () => {
    const publisher = transformPublisher(
      publisherResponse({
        integration_type: "mcp",
        mcp_discovery: {
          last_attempt_at: "2026-05-16T12:05:00Z",
          last_success_at: "2026-05-16T12:00:00Z",
          error: "timed\nout",
        },
      }),
    );

    expect(publisher.publisher_type).toBe("mcp");
    expect(publisher.mcp_discovery).toEqual({
      last_attempt_at: "2026-05-16T12:05:00Z",
      last_success_at: "2026-05-16T12:00:00Z",
      error: "timed out",
    });
    expect(formatMcpDiscoveryStatus(publisher)).toBe(
      "MCP discovery failed: timed out",
    );
  });

  it("strips terminal controls and caps discovery error length", () => {
    const publisher = transformPublisher(
      publisherResponse({
        integration_type: "mcp",
        mcp_discovery: {
          error: `bad\u0001\u001b[31mred\u001b[0m\u202e${"x".repeat(600)}`,
        },
      }),
    );

    expect(publisher.mcp_discovery?.error).toHaveLength(500);
    expect(publisher.mcp_discovery?.error).not.toContain("\u0001");
    expect(publisher.mcp_discovery?.error).not.toContain("\u001b");
    expect(publisher.mcp_discovery?.error).not.toContain("[31m");
    expect(publisher.mcp_discovery?.error).not.toContain("[0m");
    expect(publisher.mcp_discovery?.error).not.toContain("\u202e");
  });

  it("omits discovery copy when the publisher has no discovery error", () => {
    const publisher = transformPublisher(
      publisherResponse({
        integration_type: "mcp",
        mcp_discovery: {
          last_attempt_at: "2026-05-16T12:05:00Z",
          last_success_at: "2026-05-16T12:05:00Z",
          error: null,
        },
      }),
    );

    expect(formatMcpDiscoveryStatus(publisher)).toBeNull();
  });

  it("treats absent or empty discovery errors as no badge copy", () => {
    expect(
      formatMcpDiscoveryStatus(transformPublisher(publisherResponse())),
    ).toBeNull();

    const publisher = transformPublisher(
      publisherResponse({
        integration_type: "mcp",
        mcp_discovery: {
          last_attempt_at: "2026-05-16T12:05:00Z",
          error: " \n\t ",
        },
      }),
    );

    expect(publisher.mcp_discovery?.error).toBeNull();
    expect(formatMcpDiscoveryStatus(publisher)).toBeNull();
  });

  it("ignores malformed discovery payloads without throwing", () => {
    expect(normalizeMcpDiscoveryStatus("not an object")).toBeNull();
    expect(
      normalizeMcpDiscoveryStatus({
        last_attempt_at: 123,
        last_success_at: false,
        error: { message: "timed out" },
      }),
    ).toEqual({
      last_attempt_at: null,
      last_success_at: null,
      error: null,
    });
  });

  it("carries untyped MCP discovery errors from publisher suggestions", async () => {
    vi.mocked(suggestPublishers).mockResolvedValue({
      data: {
        data: {
          publishers: [
            {
              capabilities: [],
              description: "Search tools",
              match_reason: "Relevant MCP tools",
              mcp_discovery: { error: "failed\n\nschema parse" },
              name: "MCP Search",
              pricing: null,
              score: 0.9,
              slug: "mcp-search",
            },
          ],
        },
      },
      error: undefined,
    } as never);

    const publishers = await catalog.suggest("search");

    expect(publishers).toHaveLength(1);
    expect(publishers[0]?.mcp_discovery?.error).toBe("failed schema parse");
    expect(formatMcpDiscoveryStatus(publishers[0]!)).toBe(
      "MCP discovery failed: failed schema parse",
    );
  });
});
