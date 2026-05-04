// ABOUTME: Regression tests for Seren Notes id extraction across publisher envelopes.
// ABOUTME: Closes #1775 — "Note created but ID missing from response" after Download Chat.

import { describe, expect, it } from "vitest";

import { extractNoteId } from "@/lib/save-to-notes";

const UUID = "041e7a55-261b-4e6d-8cb4-ef4ad656a54a";

describe("extractNoteId", () => {
  it("finds the id when the gateway returns the upstream NoteDataResponse wrapped in the publisher proxy envelope", () => {
    // {data: {status, body, cost}} where body is the upstream {data: {id, ...}}.
    expect(
      extractNoteId({
        data: {
          status: 201,
          body: { data: { id: UUID, title: "x", format: "markdown" } },
          cost: "0.0005",
        },
      }),
    ).toBe(UUID);
  });

  it("finds the id when the proxy body is JSON-encoded as a string (older gateway build)", () => {
    expect(
      extractNoteId({
        data: {
          status: 201,
          body: JSON.stringify({ data: { id: UUID, title: "x" } }),
          cost: "0.0005",
        },
      }),
    ).toBe(UUID);
  });

  it("finds the id when the gateway adds extra siblings that block the strict outer DataResponse unwrap", () => {
    // request_id at the top level prevents unwrapDataResponse from stripping `data`,
    // which is exactly what made the original payload?.data?.id ?? payload?.id chain
    // resolve to undefined and surface the user-visible "ID missing" error.
    expect(
      extractNoteId({
        request_id: "abc",
        data: {
          status: 201,
          body: { data: { id: UUID } },
          cost: "0.0005",
        },
      }),
    ).toBe(UUID);
  });

  it("finds the id when the upstream body is returned verbatim with no proxy envelope", () => {
    expect(extractNoteId({ data: { id: UUID, title: "x" } })).toBe(UUID);
    expect(extractNoteId({ id: UUID, title: "x" })).toBe(UUID);
  });

  it("rejects non-UUID strings so we never open https://notes.serendb.com/notes/<garbage>", () => {
    expect(extractNoteId({ id: "not-a-uuid" })).toBeUndefined();
    expect(extractNoteId({ data: { id: "12345" } })).toBeUndefined();
    expect(extractNoteId({})).toBeUndefined();
    expect(extractNoteId(null)).toBeUndefined();
    expect(extractNoteId("plain string")).toBeUndefined();
  });
});
