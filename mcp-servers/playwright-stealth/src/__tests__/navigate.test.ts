// ABOUTME: Tests for navigate load-state defaults and MCP schema options.
// ABOUTME: Guards SPA-safe navigation behavior used by Python subprocess callers.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigateToolDefinition } from "../tool_definitions.js";
import { navigate } from "../tools.js";

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock("../browser.js", () => ({
  closeBrowser: vi.fn(),
  getActiveBrowserType: vi.fn(() => "chrome"),
  getContext: vi.fn(),
  getPage: mocks.getPage,
  listInstalledBrowsers: vi.fn(() => []),
  resetPage: vi.fn(),
  setBrowser: vi.fn(),
}));

describe("navigate", () => {
  beforeEach(() => {
    mocks.goto.mockReset();
    mocks.getPage.mockReset();
    mocks.goto.mockResolvedValue(undefined);
    mocks.getPage.mockResolvedValue({ goto: mocks.goto });
  });

  it("defaults to the load event instead of networkidle", async () => {
    await expect(navigate("https://example.test")).resolves.toBe(
      "Navigated to https://example.test",
    );

    expect(mocks.goto).toHaveBeenCalledWith("https://example.test", {
      waitUntil: "load",
      timeout: 30_000,
    });
  });

  it("passes explicit waitUntil and timeout options through to Playwright", async () => {
    await navigate("https://example.test/create", {
      waitUntil: "domcontentloaded",
      timeout: 12_000,
    });

    expect(mocks.goto).toHaveBeenCalledWith("https://example.test/create", {
      waitUntil: "domcontentloaded",
      timeout: 12_000,
    });
  });

  it("exposes waitUntil and timeout in the MCP tool schema", () => {
    const definition = createNavigateToolDefinition();

    expect(definition.inputSchema.properties.waitUntil).toMatchObject({
      type: "string",
      enum: ["load", "domcontentloaded", "networkidle"],
    });
    expect(definition.inputSchema.properties.timeout).toMatchObject({
      type: "number",
    });
    expect(definition.inputSchema.required).toEqual(["url"]);
  });
});
