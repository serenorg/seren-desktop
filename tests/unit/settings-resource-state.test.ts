// ABOUTME: Verifies settings resources render failures instead of throwing.
// ABOUTME: Guards the side-panel recovery boundary from routine API errors.

import { describe, expect, it } from "vitest";

import {
  loadedResource,
  loadResourceState,
} from "../../src/components/settings/resource-state";

describe("settings resource state", () => {
  it("returns loaded data after a successful request", async () => {
    await expect(
      loadResourceState(async () => ["slack"], []),
    ).resolves.toEqual({ data: ["slack"], failed: false });
  });

  it("turns a rejected request into renderable failure state", async () => {
    await expect(
      loadResourceState(async () => {
        throw new Error("request failed");
      }, []),
    ).resolves.toEqual({ data: [], failed: true });
  });

  it("creates loaded state without starting a request", () => {
    expect(loadedResource(null)).toEqual({ data: null, failed: false });
  });
});
