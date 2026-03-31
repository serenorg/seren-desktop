// ABOUTME: Verifies vite.config manualChunks groups all store modules into a single chunk.
// ABOUTME: Prevents TDZ crashes from cross-chunk store access in production bundles.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("store chunk co-location", () => {
  const viteConfig = readFileSync(resolve("vite.config.ts"), "utf-8");

  it("manualChunks assigns all src/stores/ modules to a 'stores' chunk", () => {
    // All store modules must be in the same chunk to prevent TDZ crashes
    // when one store accesses another during initialization.
    expect(viteConfig).toContain('id.includes("/src/stores/")');
    expect(viteConfig).toContain('return "stores"');
  });

  it("thread.store.ts does not import session.store (TDZ guard)", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(
      path.resolve("src/stores/thread.store.ts"),
      "utf-8",
    );
    expect(source).not.toContain("session.store");
    expect(source).not.toContain("sessionStore");
  });
});
