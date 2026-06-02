// ABOUTME: Regression test for #2089 — Anthropic provider must preserve
// ABOUTME: image_url and document content blocks instead of stripping them to text.

import { beforeEach, describe, expect, it, vi } from "vitest";

const appFetchMock = vi.fn<typeof fetch>();

vi.mock("@/lib/fetch", () => ({
  appFetch: appFetchMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readPostedBody(): Promise<Record<string, unknown>> {
  expect(appFetchMock).toHaveBeenCalledTimes(1);
  const init = appFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  const raw = init?.body;
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string);
}

describe("anthropic provider — multimodal payload (#2089)", () => {
  beforeEach(() => {
    appFetchMock.mockReset();
    appFetchMock.mockResolvedValue(
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );
  });

  it("converts data-URL image_url blocks to Anthropic image source", async () => {
    const { anthropicProvider } = await import("@/lib/providers/anthropic");

    await anthropicProvider.sendMessage(
      {
        model: "claude-3-5-sonnet-20241022",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,aGVsbG8=",
                },
              },
              { type: "text", text: "what's in this image?" },
            ],
          },
        ],
      },
      "sk-ant-test",
    );

    const body = await readPostedBody();
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aGVsbG8=",
        },
      },
      { type: "text", text: "what's in this image?" },
    ]);
  });

  it("converts https image_url blocks to Anthropic URL source", async () => {
    const { anthropicProvider } = await import("@/lib/providers/anthropic");

    await anthropicProvider.sendMessage(
      {
        model: "claude-3-5-sonnet-20241022",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/cat.jpg" },
              },
              { type: "text", text: "describe" },
            ],
          },
        ],
      },
      "sk-ant-test",
    );

    const body = await readPostedBody();
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/cat.jpg" },
    });
  });

  it("preserves Anthropic-native document (PDF) blocks unchanged", async () => {
    const { anthropicProvider } = await import("@/lib/providers/anthropic");

    await anthropicProvider.sendMessage(
      {
        model: "claude-3-5-sonnet-20241022",
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0=",
                },
              },
              { type: "text", text: "summarize" },
            ],
          },
        ],
      },
      "sk-ant-test",
    );

    const body = await readPostedBody();
    const messages = body.messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0].content[0]).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0=",
      },
    });
    expect(messages[0].content[1]).toEqual({
      type: "text",
      text: "summarize",
    });
  });

  it("keeps plain-string system message as a string", async () => {
    const { anthropicProvider } = await import("@/lib/providers/anthropic");

    await anthropicProvider.sendMessage(
      {
        model: "claude-3-5-sonnet-20241022",
        stream: false,
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
      },
      "sk-ant-test",
    );

    const body = await readPostedBody();
    expect(body.system).toBe("you are helpful");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
  });
});
