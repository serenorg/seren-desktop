// ABOUTME: Unit tests for auth-refresh skip detection in tauri-fetch helpers.
// ABOUTME: Ensures path-based matching avoids query-string false positives.

import { describe, expect, it } from "vitest";
import { shouldSkipRefresh } from "@/lib/tauri-fetch";

describe("shouldSkipRefresh", () => {
  it("matches auth endpoints by pathname", () => {
    expect(shouldSkipRefresh("https://api.serendb.com/auth/login")).toBe(true);
    expect(shouldSkipRefresh("https://api.serendb.com/auth/refresh")).toBe(true);
    expect(shouldSkipRefresh("https://api.serendb.com/auth/signup")).toBe(true);
  });

  it("matches auth endpoints with trailing slash", () => {
    expect(shouldSkipRefresh("https://api.serendb.com/auth/refresh/")).toBe(true);
  });

  it("does not match when auth path only appears in query params", () => {
    expect(
      shouldSkipRefresh(
        "https://api.serendb.com/v1/data?next=/auth/refresh&from=/auth/login",
      ),
    ).toBe(false);
  });

  it("handles relative URLs without query false positives", () => {
    expect(shouldSkipRefresh("/v1/data?next=/auth/refresh")).toBe(false);
    expect(shouldSkipRefresh("/auth/refresh?continue=/projects")).toBe(true);
  });
});
