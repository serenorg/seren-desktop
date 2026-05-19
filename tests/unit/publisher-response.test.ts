// ABOUTME: Regression tests for Seren publisher response envelope helpers.

import { describe, expect, it } from "vitest";

import {
  isPublisherErrorEnvelope,
  publisherErrorMessage,
  publisherStatus,
  unwrapDataResponse,
  unwrapPublisherBody,
} from "@/lib/publisher-response";

describe("publisher response helpers", () => {
  it("unwraps Seren DataResponse payloads", () => {
    expect(unwrapDataResponse({ data: { ok: true } })).toEqual({ ok: true });
    expect(
      unwrapDataResponse({
        data: [{ id: "a" }],
        pagination: { count: 1 },
      }),
    ).toEqual([{ id: "a" }]);
  });

  it("does not strip upstream protocol payloads with top-level data fields", () => {
    const openAiList = {
      object: "list",
      data: [{ id: "model-a" }],
      model: "model-a",
      usage: { total_tokens: 1 },
    };

    expect(unwrapDataResponse(openAiList)).toBe(openAiList);
  });

  it("unwraps the inner publisher proxy body after DataResponse", () => {
    const wrapped = {
      data: {
        status: 200,
        body: { choices: [{ message: { content: "hello" } }] },
        cost: "0.000001",
      },
    };

    expect(publisherStatus(wrapped)).toBe(200);
    expect(unwrapPublisherBody(wrapped)).toEqual({
      choices: [{ message: { content: "hello" } }],
    });
  });

  it("does not strip objects that carry `body` without a publisher `status`", () => {
    const toolResult = {
      name: "web_search",
      body: { query: "news" },
    };

    expect(unwrapPublisherBody(toolResult)).toEqual(toolResult);
  });

  it("unwraps a legacy raw publisher envelope without DataResponse", () => {
    const legacy = {
      status: 200,
      body: { choices: [{ message: { content: "legacy" } }] },
      cost: "0.000002",
    };

    expect(publisherStatus(legacy)).toBe(200);
    expect(unwrapPublisherBody(legacy)).toEqual({
      choices: [{ message: { content: "legacy" } }],
    });
  });

  it("detects numeric and string-coded publisher error bodies", () => {
    const numeric = { error: { code: 404, message: "not found" } };
    const stringCode = {
      error: { code: "PUBLISHER_DENIED", message: "forbidden" },
    };

    expect(isPublisherErrorEnvelope(numeric)).toBe(true);
    expect(isPublisherErrorEnvelope(stringCode)).toBe(true);
    expect(publisherErrorMessage(stringCode)).toBe("forbidden");
    expect(isPublisherErrorEnvelope({ error: "plain text" })).toBe(false);
  });
});
