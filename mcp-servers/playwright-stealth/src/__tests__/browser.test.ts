// ABOUTME: Unit tests for multi-browser selection, detection, and configuration.
// ABOUTME: Validates parseBrowserType, isChromiumBased, resolveBrowserName, and listInstalledBrowsers.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledBrowser } from "../browser.js";
import {
  addPageInitPatchIfEnabled,
  applyStealthPluginIfEnabled,
  createSafeStealthPlugin,
  detectDefaultBrowser,
  isChromiumBased,
  launchBrowserWithFallback,
  listInstalledBrowsers,
  parseBrowserType,
  resolveBrowserName,
} from "../browser.js";

const TEST_INSTALLED_BROWSERS: InstalledBrowser[] = [
  {
    name: "chrome",
    browserName: "chromium",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    isChromiumBased: true,
    stealthSupported: true,
  },
  {
    name: "msedge",
    browserName: "chromium",
    executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    isChromiumBased: true,
    stealthSupported: true,
  },
  {
    name: "moz-firefox",
    browserName: "firefox",
    executablePath: "/Applications/Firefox.app/Contents/MacOS/firefox",
    isChromiumBased: false,
    stealthSupported: false,
  },
];

const CONTROLLED_ENV_KEYS = [
  "SEREN_PLAYWRIGHT_HEADLESS",
  "SEREN_PLAYWRIGHT_DISABLE_STEALTH",
  "SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE",
  "SEREN_PLAYWRIGHT_DISABLE_PAGE_INIT_PATCH",
] as const;

const ORIGINAL_ENV = new Map(
  CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of CONTROLLED_ENV_KEYS) {
    const originalValue = ORIGINAL_ENV.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
  vi.restoreAllMocks();
});

describe("detectDefaultBrowser", () => {
  it("returns a system browser name", () => {
    const result = detectDefaultBrowser(TEST_INSTALLED_BROWSERS);
    // Should never return a Playwright-bundled browser when system ones exist
    expect(["chromium", "firefox", "webkit"]).not.toContain(result);
  });

  it("returns a string", () => {
    expect(typeof detectDefaultBrowser(TEST_INSTALLED_BROWSERS)).toBe("string");
  });

  it("fails closed when no supported system browser is detected", () => {
    expect(() => detectDefaultBrowser([])).toThrow(
      "No supported system browser detected",
    );
  });
});

describe("parseBrowserType", () => {
  it("auto-detects system browser for undefined", () => {
    const result = parseBrowserType(undefined, TEST_INSTALLED_BROWSERS);
    expect(result).toBe(detectDefaultBrowser(TEST_INSTALLED_BROWSERS));
  });

  it("auto-detects system browser for empty string", () => {
    expect(parseBrowserType("", TEST_INSTALLED_BROWSERS)).toBe(
      detectDefaultBrowser(TEST_INSTALLED_BROWSERS),
    );
  });

  it("auto-detects system browser for whitespace-only string", () => {
    expect(parseBrowserType("   ", TEST_INSTALLED_BROWSERS)).toBe(
      detectDefaultBrowser(TEST_INSTALLED_BROWSERS),
    );
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

  it("maps 'firefox' alias to 'moz-firefox'", () => {
    expect(parseBrowserType("firefox")).toBe("moz-firefox");
  });

  it("maps 'firefox-beta' alias to 'moz-firefox-beta'", () => {
    expect(parseBrowserType("firefox-beta")).toBe("moz-firefox-beta");
  });

  it("maps 'firefox-nightly' alias to 'moz-firefox-nightly'", () => {
    expect(parseBrowserType("firefox-nightly")).toBe("moz-firefox-nightly");
  });

  it("maps 'chromium' alias to 'chrome'", () => {
    expect(parseBrowserType("chromium")).toBe("chrome");
  });

  it("is case-insensitive", () => {
    expect(parseBrowserType("Chrome")).toBe("chrome");
    expect(parseBrowserType("MSEDGE")).toBe("msedge");
    expect(parseBrowserType("EDGE")).toBe("msedge");
    expect(parseBrowserType("MOZ-FIREFOX")).toBe("moz-firefox");
    expect(parseBrowserType("Firefox")).toBe("moz-firefox");
    expect(parseBrowserType("CHROMIUM")).toBe("chrome");
  });

  it("trims whitespace", () => {
    expect(parseBrowserType("  chrome  ")).toBe("chrome");
    expect(parseBrowserType("  edge  ")).toBe("msedge");
    expect(parseBrowserType("  firefox  ")).toBe("moz-firefox");
  });

  it("falls back with stderr warning for unknown value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = parseBrowserType("safari", TEST_INSTALLED_BROWSERS);
    expect(result).toBe(detectDefaultBrowser(TEST_INSTALLED_BROWSERS));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown or unsupported BROWSER_TYPE "safari"'),
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

describe("createSafeStealthPlugin", () => {
  it("excludes chrome.app and Privy-incompatible evasions by default", () => {
    const plugin = createSafeStealthPlugin();
    expect(plugin.enabledEvasions.has("chrome.app")).toBe(false);
    expect(plugin.enabledEvasions.has("iframe.contentWindow")).toBe(false);
    expect(plugin.enabledEvasions.has("navigator.permissions")).toBe(false);
  });

  it("lets an empty env value opt back into the full stealth evasion set", () => {
    process.env.SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE = "";

    const plugin = createSafeStealthPlugin();

    expect(plugin.enabledEvasions.has("chrome.app")).toBe(false);
    expect(plugin.enabledEvasions.has("iframe.contentWindow")).toBe(true);
    expect(plugin.enabledEvasions.has("navigator.permissions")).toBe(true);
  });

  it("uses env-requested evasions instead of the default disabled set", () => {
    process.env.SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE =
      "navigator.webdriver";

    const plugin = createSafeStealthPlugin();

    expect(plugin.enabledEvasions.has("chrome.app")).toBe(false);
    expect(plugin.enabledEvasions.has("iframe.contentWindow")).toBe(true);
    expect(plugin.enabledEvasions.has("navigator.permissions")).toBe(true);
    expect(plugin.enabledEvasions.has("navigator.webdriver")).toBe(false);
  });

  it("keeps other stealth evasions enabled", () => {
    const plugin = createSafeStealthPlugin();
    // These core evasions must remain active for bot detection bypass
    expect(plugin.enabledEvasions.has("chrome.csi")).toBe(true);
    expect(plugin.enabledEvasions.has("chrome.loadTimes")).toBe(true);
    expect(plugin.enabledEvasions.has("chrome.runtime")).toBe(true);
    expect(plugin.enabledEvasions.has("navigator.webdriver")).toBe(true);
    expect(plugin.enabledEvasions.size).toBeGreaterThan(5);
  });
});

describe("applyStealthPluginIfEnabled", () => {
  it("applies the safe stealth plugin to chromium by default", () => {
    const launcher = { use: vi.fn() };

    const applied = applyStealthPluginIfEnabled("chromium", launcher as never);

    expect(applied).toBe(true);
    expect(launcher.use).toHaveBeenCalledOnce();
    expect(launcher.use).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledEvasions: expect.any(Set),
      }),
    );
  });

  it("does not apply the stealth plugin when disabled by env", () => {
    process.env.SEREN_PLAYWRIGHT_DISABLE_STEALTH = "1";
    const launcher = { use: vi.fn() };

    const applied = applyStealthPluginIfEnabled("chromium", launcher as never);

    expect(applied).toBe(false);
    expect(launcher.use).not.toHaveBeenCalled();
  });
});

describe("addPageInitPatchIfEnabled", () => {
  it("skips the manual init patch by default", async () => {
    const mockPage = { addInitScript: vi.fn() };

    const added = await addPageInitPatchIfEnabled(
      mockPage as never,
      "chromium",
    );

    expect(added).toBe(false);
    expect(mockPage.addInitScript).not.toHaveBeenCalled();
  });

  it("adds the manual init patch when opted back in by env", async () => {
    process.env.SEREN_PLAYWRIGHT_DISABLE_PAGE_INIT_PATCH = "0";
    const mockPage = { addInitScript: vi.fn() };

    const added = await addPageInitPatchIfEnabled(
      mockPage as never,
      "chromium",
    );

    expect(added).toBe(true);
    expect(mockPage.addInitScript).toHaveBeenCalledOnce();
  });
});

describe("launchBrowserWithFallback", () => {
  it("retries the next installed browser in preference order after a launch failure", async () => {
    const launchedBrowser = { close: vi.fn() } as never;
    const launchBrowser = vi
      .fn<
        (
          browserName: string,
          engine: string,
          launchOptions: Record<string, unknown>,
        ) => Promise<unknown>
      >()
      .mockRejectedValueOnce(new Error("chrome failed"))
      .mockResolvedValueOnce(launchedBrowser);

    const result = await launchBrowserWithFallback(
      "chrome",
      [
        {
          name: "chrome",
          browserName: "chromium",
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          isChromiumBased: true,
          stealthSupported: true,
        },
        {
          name: "moz-firefox",
          browserName: "firefox",
          executablePath: "/Applications/Firefox.app/Contents/MacOS/firefox",
          isChromiumBased: false,
          stealthSupported: false,
        },
      ],
      launchBrowser as never,
    );

    expect(result).toEqual({
      browser: launchedBrowser,
      browserName: "moz-firefox",
    });
    expect(launchBrowser).toHaveBeenNthCalledWith(
      1,
      "chrome",
      "chromium",
      expect.objectContaining({
        headless: true,
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    );
    expect(launchBrowser).toHaveBeenNthCalledWith(
      2,
      "moz-firefox",
      "firefox",
      expect.objectContaining({
        headless: true,
        executablePath: "/Applications/Firefox.app/Contents/MacOS/firefox",
      }),
    );
  });

  it("launches headless when SEREN_PLAYWRIGHT_HEADLESS is 1", async () => {
    process.env.SEREN_PLAYWRIGHT_HEADLESS = "1";
    const launchedBrowser = { close: vi.fn() } as never;
    const launchBrowser = vi.fn().mockResolvedValueOnce(launchedBrowser);

    await launchBrowserWithFallback(
      "chrome",
      [
        {
          name: "chrome",
          browserName: "chromium",
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          isChromiumBased: true,
          stealthSupported: true,
        },
      ],
      launchBrowser as never,
    );

    expect(launchBrowser).toHaveBeenCalledWith(
      "chrome",
      "chromium",
      expect.objectContaining({
        headless: true,
      }),
    );
  });

  it("launches headed when SEREN_PLAYWRIGHT_HEADLESS is 0", async () => {
    process.env.SEREN_PLAYWRIGHT_HEADLESS = "0";
    const launchedBrowser = { close: vi.fn() } as never;
    const launchBrowser = vi.fn().mockResolvedValueOnce(launchedBrowser);

    await launchBrowserWithFallback(
      "chrome",
      [
        {
          name: "chrome",
          browserName: "chromium",
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          isChromiumBased: true,
          stealthSupported: true,
        },
      ],
      launchBrowser as never,
    );

    expect(launchBrowser).toHaveBeenCalledWith(
      "chrome",
      "chromium",
      expect.objectContaining({
        headless: false,
      }),
    );
  });

  it("surfaces a combined error when every launch candidate fails", async () => {
    const launchBrowser = vi
      .fn<
        (
          browserName: string,
          engine: string,
          launchOptions: Record<string, unknown>,
        ) => Promise<unknown>
      >()
      .mockRejectedValueOnce(new Error("chrome failed"))
      .mockRejectedValueOnce(new Error("edge failed"))
      .mockRejectedValueOnce(new Error("firefox failed"));

    await expect(
      launchBrowserWithFallback(
        "chrome",
        [
          {
            name: "chrome",
            browserName: "chromium",
            executablePath:
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            isChromiumBased: true,
            stealthSupported: true,
          },
          {
            name: "msedge",
            browserName: "chromium",
            executablePath:
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            isChromiumBased: true,
            stealthSupported: true,
          },
          {
            name: "moz-firefox",
            browserName: "firefox",
            executablePath: "/Applications/Firefox.app/Contents/MacOS/firefox",
            isChromiumBased: false,
            stealthSupported: false,
          },
        ],
        launchBrowser as never,
      ),
    ).rejects.toThrow(
      "Failed to launch any supported browser. Tried 3 candidate(s): chrome: chrome failed; msedge: edge failed; moz-firefox: firefox failed.",
    );
  });

  it("never bare-launches a Playwright-bundled Chromium candidate", async () => {
    const launchBrowser = vi.fn().mockResolvedValueOnce({ close: vi.fn() });

    await expect(
      launchBrowserWithFallback("chromium", [], launchBrowser as never),
    ).rejects.toThrow("Playwright bundled browser");

    expect(launchBrowser).not.toHaveBeenCalled();
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

  it("default browser has a valid executablePath when browsers are detected", () => {
    const browsers = listInstalledBrowsers();
    if (browsers.length === 0) {
      expect(() => detectDefaultBrowser(browsers)).toThrow(
        "No supported system browser detected",
      );
      return;
    }

    const defaultName = detectDefaultBrowser(browsers);
    const match = browsers.find((b) => b.name === defaultName);
    // getBrowser() uses this path to launch directly via executablePath
    // instead of a bare Playwright-managed engine.
    expect(match).toBeDefined();
    expect(match?.executablePath).toBeTruthy();
  });
});
