// ABOUTME: Source guard for Rust auth refresh lifecycle events.
// ABOUTME: Ensures backend refresh success can repair frontend auth state.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rustAuthSource = readFileSync(resolve("src-tauri/src/auth.rs"), "utf-8");

describe("Rust auth refresh events", () => {
  it("emits auth:token-refreshed after storing refreshed tokens", () => {
    const storeIdx = rustAuthSource.indexOf("store_tokens(app, new_access_token");
    const successLogIdx = rustAuthSource.indexOf(
      "[auth] Token refreshed successfully",
      storeIdx,
    );
    const refreshedEventIdx = rustAuthSource.indexOf(
      'app.emit("auth:token-refreshed"',
      storeIdx,
    );

    expect(storeIdx).toBeGreaterThan(0);
    expect(refreshedEventIdx).toBeGreaterThan(storeIdx);
    expect(refreshedEventIdx).toBeLessThan(successLogIdx);
  });
});
