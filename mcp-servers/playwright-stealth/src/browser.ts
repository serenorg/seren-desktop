// ABOUTME: Stealth browser management with multi-browser support and runtime switching.
// ABOUTME: Detects installed browsers via Playwright registry; supports Chromium, Firefox, WebKit, Chrome, Edge channels.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Browser, BrowserContext, BrowserType, Page } from "playwright";
import { chromium, firefox, webkit } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InstalledBrowser {
  /** Registry name (e.g. "chromium", "chrome", "msedge", "firefox") */
  name: string;
  /** Engine name: "chromium" | "firefox" | "webkit" */
  browserName: string;
  /** Absolute path to the browser executable */
  executablePath: string;
  /** Whether the browser is Chromium-based (stealth applies) */
  isChromiumBased: boolean;
  /** Whether stealth evasions are supported */
  stealthSupported: boolean;
}

type BrowserEngine = "chromium" | "firefox" | "webkit";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Registry entries to exclude — internal dev/CI tools, not user-facing browsers. */
const EXCLUDED_NAMES = new Set([
  "chromium-headless-shell",
  "chromium-tip-of-tree",
  "chromium-tip-of-tree-headless-shell",
  "webkit-wsl",
  "bidi-chrome-stable",
  "bidi-chrome-canary",
  "ffmpeg",
  "winldd",
  "android",
]);

/** Default user agents per browser engine. */
const DEFAULT_USER_AGENTS: Record<BrowserEngine, string> = {
  chromium:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefox:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  webkit:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
};

// ── Browser Detection ──────────────────────────────────────────────────────────

/** Minimal shape of Playwright's internal registry executable. */
interface RegistryExecutable {
  name: string;
  browserName: string | undefined;
  executablePath(): string;
}

const require_ = createRequire(import.meta.url);

/** Query Playwright's internal registry for installed browsers. */
export function listInstalledBrowsers(): InstalledBrowser[] {
  const coreDir = dirname(require_.resolve("playwright-core/package.json"));
  const registryPath = `${coreDir}/lib/server/registry/index.js`;

  let registry: { registry: { executables(): RegistryExecutable[] } };
  try {
    registry = require_(registryPath);
  } catch {
    console.error(
      "[playwright-stealth] Failed to load Playwright registry. Browser detection unavailable.",
    );
    return [];
  }

  const results: InstalledBrowser[] = [];

  for (const exe of registry.registry.executables()) {
    if (!exe.browserName) continue;
    if (EXCLUDED_NAMES.has(exe.name)) continue;

    let exePath: string;
    try {
      exePath = exe.executablePath();
    } catch {
      continue;
    }

    if (!exePath || !existsSync(exePath)) continue;

    results.push({
      name: exe.name,
      browserName: exe.browserName,
      executablePath: exePath,
      isChromiumBased: exe.browserName === "chromium",
      stealthSupported: exe.browserName === "chromium",
    });
  }

  return results;
}

// ── Browser Selection ──────────────────────────────────────────────────────────

export function isChromiumBased(browserName: string): boolean {
  return browserName === "chromium";
}

/** Resolve the engine name for a given browser name. */
export function resolveBrowserName(name: string): BrowserEngine {
  if (
    name === "firefox" ||
    name === "firefox-beta" ||
    name.startsWith("moz-firefox")
  ) {
    return "firefox";
  }
  if (name === "webkit") return "webkit";
  return "chromium";
}

/** Validate and normalize a browser type string. Falls back to "chromium". */
export function parseBrowserType(value: string | undefined): string {
  if (!value) return "chromium";

  const normalized = value.toLowerCase().trim();
  if (!normalized) return "chromium";

  // Accept "edge" as alias for "msedge"
  if (normalized === "edge") return "msedge";

  const known = new Set([
    "chromium",
    "firefox",
    "webkit",
    "chrome",
    "chrome-beta",
    "chrome-dev",
    "chrome-canary",
    "msedge",
    "msedge-beta",
    "msedge-dev",
    "msedge-canary",
    "moz-firefox",
    "moz-firefox-beta",
    "moz-firefox-nightly",
    "firefox-beta",
  ]);

  if (known.has(normalized)) return normalized;

  console.error(
    `[playwright-stealth] Unknown BROWSER_TYPE "${value}". Falling back to chromium.`,
  );
  return "chromium";
}

/** Get the playwright-extra launcher for a browser engine. */
function getLauncher(
  browserName: BrowserEngine,
): BrowserType & { use(plugin: unknown): void } {
  if (browserName === "firefox")
    return firefox as BrowserType & { use(plugin: unknown): void };
  if (browserName === "webkit")
    return webkit as BrowserType & { use(plugin: unknown): void };
  return chromium as BrowserType & { use(plugin: unknown): void };
}

// ── State ──────────────────────────────────────────────────────────────────────

let activeBrowserName: string = parseBrowserType(process.env.BROWSER_TYPE);
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let stealthApplied = false;

// ── Public API ─────────────────────────────────────────────────────────────────

export function getActiveBrowserType(): string {
  return activeBrowserName;
}

/** Switch to a different browser. Closes the current browser if open. */
export async function setBrowser(
  name: string,
): Promise<{ name: string; browserName: string; stealthSupported: boolean }> {
  const normalized = parseBrowserType(name);

  const installed = listInstalledBrowsers();
  const match = installed.find((b) => b.name === normalized);
  if (!match) {
    const available = installed.map((b) => b.name).join(", ");
    throw new Error(
      `Browser "${normalized}" is not installed. Available: ${available}`,
    );
  }

  await closeBrowser();

  activeBrowserName = normalized;
  stealthApplied = false;

  const engine = resolveBrowserName(normalized);
  return {
    name: normalized,
    browserName: engine,
    stealthSupported: isChromiumBased(engine),
  };
}

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const engine = resolveBrowserName(activeBrowserName);
    const launcher = getLauncher(engine);

    if (isChromiumBased(engine) && !stealthApplied) {
      (chromium as BrowserType & { use(plugin: unknown): void }).use(
        StealthPlugin(),
      );
      stealthApplied = true;
    }

    const launchOptions: Record<string, unknown> = {
      headless: true,
    };

    if (isChromiumBased(engine)) {
      launchOptions.args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ];
    }

    // Channel browsers (chrome, msedge, etc.) need the channel option
    if (activeBrowserName !== engine) {
      launchOptions.channel = activeBrowserName;
    }

    try {
      browser = await launcher.launch(launchOptions);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isChannel = activeBrowserName !== engine;
      const hint = isChannel
        ? `Ensure ${activeBrowserName} is installed on this system.`
        : `Run 'npx playwright install ${activeBrowserName}' to install it.`;
      throw new Error(`Failed to launch ${activeBrowserName}: ${msg}. ${hint}`);
    }
  }
  return browser;
}

export async function getContext(): Promise<BrowserContext> {
  if (!context) {
    const b = await getBrowser();
    const engine = resolveBrowserName(activeBrowserName);
    context = await b.newContext({
      userAgent: DEFAULT_USER_AGENTS[engine],
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
  }
  return context;
}

export async function getPage(): Promise<Page> {
  if (!page) {
    const ctx = await getContext();
    page = await ctx.newPage();

    const engine = resolveBrowserName(activeBrowserName);
    if (isChromiumBased(engine)) {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => false,
        });

        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });

        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });

        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (
          parameters: PermissionDescriptor,
        ) =>
          parameters.name === "notifications"
            ? Promise.resolve({
                state: Notification.permission,
              } as PermissionStatus)
            : originalQuery(parameters);
      });
    }
  }
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (page) {
    await page.close();
    page = null;
  }
  if (context) {
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function resetPage(): Promise<void> {
  if (page) {
    await page.close();
    page = null;
  }
}
