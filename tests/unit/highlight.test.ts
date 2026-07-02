// ABOUTME: Tests for safe search-result highlighting.
// ABOUTME: Verifies literal query handling without innerHTML.

import { describe, expect, it } from "vitest";
import { highlightTerms } from "@/lib/highlight";

describe("highlightTerms", () => {
  it("returns plain text for an empty query", () => {
    expect(highlightTerms("hello world", "")).toEqual(["hello world"]);
  });

  it("wraps a single matching term", () => {
    expect(highlightTerms("hello world", "world")).toEqual([
      "hello ",
      { mark: "world" },
    ]);
  });

  it("matches case-insensitively while preserving source case", () => {
    expect(highlightTerms("Updater Signing", "signing")).toEqual([
      "Updater ",
      { mark: "Signing" },
    ]);
  });

  it("treats regex metacharacters literally", () => {
    expect(highlightTerms("call foo.*(bar) now", "foo.*(bar)")).toEqual([
      "call ",
      { mark: "foo.*(bar)" },
      " now",
    ]);
  });

  it("returns the whole string when there is no match", () => {
    expect(highlightTerms("hello world", "missing")).toEqual(["hello world"]);
  });

  it("merges overlapping and adjacent matches", () => {
    expect(highlightTerms("signing", "sign signing")).toEqual([
      { mark: "signing" },
    ]);
  });
});
