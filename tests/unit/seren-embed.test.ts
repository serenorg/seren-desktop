// ABOUTME: Critical endpoint-contract coverage for the shared semantic search embedding client.
// ABOUTME: Guards transcript/code search from drifting back to the SerenEmbed pipeline publisher.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appFetch: vi.fn<typeof globalThis.fetch>(),
  shouldUseRustGatewayAuth: vi.fn<(input: RequestInfo | URL) => boolean>(),
  getToken: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("@/lib/fetch", () => ({
  appFetch: mocks.appFetch,
}));

vi.mock("@/lib/tauri-fetch", () => ({
  shouldUseRustGatewayAuth: mocks.shouldUseRustGatewayAuth,
}));

vi.mock("@/services/auth", () => ({
  getToken: mocks.getToken,
}));

describe("seren embedding client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.shouldUseRustGatewayAuth.mockReturnValue(false);
    mocks.getToken.mockResolvedValue("access-token");
  });

  it("calls the direct OpenAI embeddings publisher and unwraps gateway envelopes", async () => {
    const embedding = Array.from({ length: 1536 }, (_, index) => index / 1536);
    mocks.appFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            status: 200,
            body: {
              object: "list",
              data: [{ object: "embedding", embedding, index: 0 }],
              model: "text-embedding-3-small",
              usage: { prompt_tokens: 1, total_tokens: 1 },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { embedTexts } = await import("@/services/seren-embed");
    const result = await embedTexts(["reconciliation"]);

    expect(mocks.appFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.appFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.serendb.com/publishers/openai-embeddings/embeddings",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      input: ["reconciliation"],
      model: "text-embedding-3-small",
    });
    expect(result.data[0].embedding).toEqual(embedding);
  });
});
