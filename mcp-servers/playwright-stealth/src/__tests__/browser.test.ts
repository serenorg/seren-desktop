// ABOUTME: Unit tests for multi-browser selection, detection, and configuration.
// ABOUTME: Validates parseBrowserType, isChromiumBased, resolveBrowserName, and listInstalledBrowsers.

import { describe, expect, it, vi } from "vitest";
import {
  detectDefaultBrowser,
  isChromiumBased,
  listInstalledBrowsers,
  parseBrowserType,
  resolveBrowserName,
} from "../browser.js";

describe("detectDefaultBrowser", () => {
  it("returns a system browser name", () => {
    const result = detectDefaultBrowser();
    // Should never return a Playwright-bundled browser when system ones exist
    expect(["chromium", "firefox", "webkit"]).not.toContain(result);
  });

  it("returns a string", () => {
    expect(typeof detectDefaultBrowser()).toBe("string");
  });
});

describe("parseBrowserType", () => {
  it("auto-detects system browser for undefined", () => {
    const result = parseBrowserType(undefined);
    expect(result).toBe(detectDefaultBrowser());
  });

  it("auto-detects system browser for empty string", () => {
    expect(parseBrowserType("")).toBe(detectDefaultBrowser());
  });

  it("auto-detects system browser for whitespace-only string", () => {
    expect(parseBrowserType("   ")).toBe(detectDefaultBrowser());
  });

  it("returns 'chrome' for 'chrome'", () => {
    expect(parseBrowserType("chrome")).toBe("chrome");
  });

  it("returns 'msedge' for 'msedge'", () => {
    expect(parseBrowserType("msedge")).toBe("msedge");
  });

  it("returns 'moz-firefox' for 'moz-firefox'", () => {
    expect(parseBrowserType("moz-firefox")).toBe("moz-firefox");
  });

  it("maps 'edge' alias to 'msedge'", () => {
    expect(parseBrowserType("edge")).toBe("msedge");
  });

  it("is case-insensitive", () => {
    expect(parseBrowserType("Chrome")).toBe("chrome");
    expect(parseBrowserType("MSEDGE")).toBe("msedge");
    expect(parseBrowserType("EDGE")).toBe("msedge");
    expect(parseBrowserType("MOZ-FIREFOX")).toBe("moz-firefox");
  });

  it("trims whitespace", () => {
    expect(parseBrowserType("  chrome  ")).toBe("chrome");
    expect(parseBrowserType("  edge  ")).toBe("msedge");
  });

  it("falls back with stderr warning for unknown value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseBrowserType("safari");
    expect(result).toBe(detectDefaultBrowser());
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown or unsupported BROWSER_TYPE "safari"'),
    );
    spy.mockRestore();
  });

  it("rejects Playwright-bundled browsers with fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseBrowserType("chromium");
    expect(result).toBe(detectDefaultBrowser());
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown or unsupported BROWSER_TYPE "chromium"'),
    );
    spy.mockRestore();
  });

  it("accepts system browser channel variants", () => {
    expect(parseBrowserType("chrome-beta")).toBe("chrome-beta");
    expect(parseBrowserType("msedge-beta")).toBe("msedge-beta");
    expect(parseBrowserType("msedge-dev")).toBe("msedge-dev");
    expect(parseBrowserType("moz-firefox")).toBe("moz-firefox");
  });
});

describe("isChromiumBased", () => {
  it("returns true for 'chromium'", () => {
    expect(isChromiumBased("chromium")).toBe(true);
  });

  it("returns false for 'firefox'", () => {
    expect(isChromiumBased("firefox")).toBe(false);
  });

  it("returns false for 'webkit'", () => {
    expect(isChromiumBased("webkit")).toBe(false);
  });
});

describe("resolveBrowserName", () => {
  it("resolves 'chromium' to 'chromium'", () => {
    expect(resolveBrowserName("chromium")).toBe("chromium");
  });

  it("resolves 'chrome' to 'chromium'", () => {
    expect(resolveBrowserName("chrome")).toBe("chromium");
  });

  it("resolves 'msedge' to 'chromium'", () => {
    expect(resolveBrowserName("msedge")).toBe("chromium");
  });

  it("resolves 'chrome-beta' to 'chromium'", () => {
    expect(resolveBrowserName("chrome-beta")).toBe("chromium");
  });

  it("resolves 'firefox' to 'firefox'", () => {
    expect(resolveBrowserName("firefox")).toBe("firefox");
  });

  it("resolves 'firefox-beta' to 'firefox'", () => {
    expect(resolveBrowserName("firefox-beta")).toBe("firefox");
  });

  it("resolves 'moz-firefox' to 'firefox'", () => {
    expect(resolveBrowserName("moz-firefox")).toBe("firefox");
  });

  it("resolves 'moz-firefox-beta' to 'firefox'", () => {
    expect(resolveBrowserName("moz-firefox-beta")).toBe("firefox");
  });

  it("resolves 'webkit' to 'webkit'", () => {
    expect(resolveBrowserName("webkit")).toBe("webkit");
  });

  it("defaults unknown names to 'chromium'", () => {
    expect(resolveBrowserName("msedge-canary")).toBe("chromium");
  });
});

describe("listInstalledBrowsers", () => {
  it("returns an array", () => {
    const browsers = listInstalledBrowsers();
    expect(Array.isArray(browsers)).toBe(true);
  });

  it("each entry has required fields", () => {
    const browsers = listInstalledBrowsers();
    for (const b of browsers) {
      expect(b).toHaveProperty("name");
      expect(b).toHaveProperty("browserName");
      expect(b).toHaveProperty("executablePath");
      expect(b).toHaveProperty("isChromiumBased");
      expect(b).toHaveProperty("stealthSupported");
      expect(typeof b.name).toBe("string");
      expect(typeof b.browserName).toBe("string");
      expect(typeof b.executablePath).toBe("string");
      expect(typeof b.isChromiumBased).toBe("boolean");
      expect(typeof b.stealthSupported).toBe("boolean");
    }
  });

  it("only returns system-installed browsers", () => {
    const browsers = listInstalledBrowsers();
    const names = browsers.map((b) => b.name);
    // Playwright-bundled browsers must never appear
    expect(names).not.toContain("chromium");
    expect(names).not.toContain("firefox");
    expect(names).not.toContain("webkit");
    expect(names).not.toContain("firefox-beta");
    // Non-browser entries must never appear
    expect(names).not.toContain("ffmpeg");
    expect(names).not.toContain("winldd");
    expect(names).not.toContain("android");
    // Internal variants must never appear
    expect(names).not.toContain("chromium-headless-shell");
    expect(names).not.toContain("bidi-chrome-stable");
    expect(names).not.toContain("webkit-wsl");
  });

  it("stealthSupported matches isChromiumBased", () => {
    const browsers = listInstalledBrowsers();
    for (const b of browsers) {
      expect(b.stealthSupported).toBe(b.isChromiumBased);
    }
  });

  it("isChromiumBased is true only for chromium-engine browsers", () => {
    const browsers = listInstalledBrowsers();
    for (const b of browsers) {
      expect(b.isChromiumBased).toBe(b.browserName === "chromium");
    }
  });
});
