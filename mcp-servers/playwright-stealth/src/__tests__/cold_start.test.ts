// ABOUTME: Regression guard for #1921 — top-level browser detection must not
// ABOUTME: run at module load, otherwise the MCP stdio handshake stalls and the
// ABOUTME: prophet-arb-bot Python child times out before `initialize` returns.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("browser.ts cold-start contract (#1921)", () => {
  let originalBrowserType: string | undefined;

  beforeEach(() => {
    originalBrowserType = process.env.BROWSER_TYPE;
    delete process.env.BROWSER_TYPE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalBrowserType === undefined) {
      delete process.env.BROWSER_TYPE;
    } else {
      process.env.BROWSER_TYPE = originalBrowserType;
    }
    vi.resetModules();
  });

  it("defers BROWSER_TYPE resolution until first getActiveBrowserType() call", async () => {
    // The bug: browser.ts used to resolve `activeBrowserName` at module-load
    // time, which synchronously walked Playwright's registry. On a cold macOS
    // disk that probe can outrun the Python child's MCP-init timeout, so the
    // server never reaches `server.connect(transport)` and the caller sees
    // `TimeoutError: Timed out waiting for response from playwright-stealth MCP`.
    //
    // This test pins the lazy contract: setting BROWSER_TYPE *after* import
    // must still propagate, which is only true when resolution happens on the
    // first getter call rather than at module init.
    const browserModule = await import("../browser.js");
    process.env.BROWSER_TYPE = "msedge";

    expect(browserModule.getActiveBrowserType()).toBe("msedge");
  });
});
