// ABOUTME: Stealth browser management with multi-browser support and runtime switching.
// ABOUTME: Detects installed browsers without using Playwright-managed browser binaries.

import { existsSync } from "node:fs";
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

export type BrowserEngine = "chromium" | "firefox" | "webkit";

// ── Constants ──────────────────────────────────────────────────────────────────

/** System-installed browsers — the only ones we use. */
const SYSTEM_BROWSERS = new Set([
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
]);

const PLAYWRIGHT_BUNDLED_BROWSER_NAMES = new Set([
  "chromium",
  "firefox",
  "webkit",
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

export const PLAYWRIGHT_HEADLESS_ENV = "SEREN_PLAYWRIGHT_HEADLESS";
export const DISABLE_STEALTH_ENV = "SEREN_PLAYWRIGHT_DISABLE_STEALTH";
export const STEALTH_EVASIONS_DISABLE_ENV =
  "SEREN_PLAYWRIGHT_STEALTH_EVASIONS_DISABLE";
export const DISABLE_PAGE_INIT_PATCH_ENV =
  "SEREN_PLAYWRIGHT_DISABLE_PAGE_INIT_PATCH";
export const CONNECT_CDP_URL_ENV = "PLAYWRIGHT_MCP_CONNECT_CDP_URL";
const DEFAULT_DISABLED_STEALTH_EVASIONS = [
  "iframe.contentWindow",
  "navigator.permissions",
];
const CDP_CONNECT_TIMEOUT_MS = 120_000;

// ── Browser Detection ──────────────────────────────────────────────────────────

interface SystemBrowserCandidate {
  name: string;
  browserName: BrowserEngine;
  executablePaths: string[];
}

function candidate(
  name: string,
  browserName: BrowserEngine,
  ...executablePaths: string[]
): SystemBrowserCandidate {
  return { name, browserName, executablePaths };
}

function chromiumCandidate(
  name: string,
  ...executablePaths: string[]
): SystemBrowserCandidate {
  return candidate(name, "chromium", ...executablePaths);
}

function firefoxCandidate(
  name: string,
  ...executablePaths: string[]
): SystemBrowserCandidate {
  return candidate(name, "firefox", ...executablePaths);
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function macApp(appName: string, executableName = appName): string {
  return `/Applications/${appName}.app/Contents/MacOS/${executableName}`;
}

function windowsPaths(productPath: string, executableName: string): string[] {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean) as string[];
  return roots.map((root) => `${root}\\${productPath}\\${executableName}`);
}

function browserCandidatesForPlatform(): SystemBrowserCandidate[] {
  if (process.platform === "darwin") {
    return [
      chromiumCandidate(
        "chrome",
        macApp("Google Chrome"),
        macApp("Google Chrome for Testing"),
      ),
      chromiumCandidate("chrome-beta", macApp("Google Chrome Beta")),
      chromiumCandidate("chrome-dev", macApp("Google Chrome Dev")),
      chromiumCandidate("chrome-canary", macApp("Google Chrome Canary")),
      chromiumCandidate("msedge", macApp("Microsoft Edge")),
      chromiumCandidate("msedge-beta", macApp("Microsoft Edge Beta")),
      chromiumCandidate("msedge-dev", macApp("Microsoft Edge Dev")),
      chromiumCandidate("msedge-canary", macApp("Microsoft Edge Canary")),
      firefoxCandidate("moz-firefox", macApp("Firefox", "firefox")),
      firefoxCandidate(
        "moz-firefox-beta",
        macApp("Firefox Developer Edition", "firefox"),
      ),
      firefoxCandidate(
        "moz-firefox-nightly",
        macApp("Firefox Nightly", "firefox"),
      ),
    ];
  }

  if (process.platform === "win32") {
    return [
      chromiumCandidate(
        "chrome",
        ...windowsPaths("Google\\Chrome\\Application", "chrome.exe"),
      ),
      chromiumCandidate(
        "chrome-beta",
        ...windowsPaths("Google\\Chrome Beta\\Application", "chrome.exe"),
      ),
      chromiumCandidate(
        "chrome-dev",
        ...windowsPaths("Google\\Chrome Dev\\Application", "chrome.exe"),
      ),
      chromiumCandidate(
        "chrome-canary",
        ...windowsPaths("Google\\Chrome SxS\\Application", "chrome.exe"),
      ),
      chromiumCandidate(
        "msedge",
        ...windowsPaths("Microsoft\\Edge\\Application", "msedge.exe"),
      ),
      chromiumCandidate(
        "msedge-beta",
        ...windowsPaths("Microsoft\\Edge Beta\\Application", "msedge.exe"),
      ),
      chromiumCandidate(
        "msedge-dev",
        ...windowsPaths("Microsoft\\Edge Dev\\Application", "msedge.exe"),
      ),
      chromiumCandidate(
        "msedge-canary",
        ...windowsPaths("Microsoft\\Edge SxS\\Application", "msedge.exe"),
      ),
      firefoxCandidate(
        "moz-firefox",
        ...windowsPaths("Mozilla Firefox", "firefox.exe"),
      ),
      firefoxCandidate(
        "moz-firefox-beta",
        ...windowsPaths("Mozilla Firefox Beta", "firefox.exe"),
      ),
      firefoxCandidate(
        "moz-firefox-nightly",
        ...windowsPaths("Firefox Nightly", "firefox.exe"),
      ),
    ];
  }

  return [
    chromiumCandidate(
      "chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/snap/bin/chromium",
    ),
    chromiumCandidate(
      "chrome-beta",
      "/usr/bin/google-chrome-beta",
      "/opt/google/chrome-beta/chrome",
    ),
    chromiumCandidate(
      "chrome-dev",
      "/usr/bin/google-chrome-unstable",
      "/opt/google/chrome-unstable/chrome",
    ),
    chromiumCandidate(
      "msedge",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge",
    ),
    chromiumCandidate(
      "msedge-beta",
      "/usr/bin/microsoft-edge-beta",
      "/opt/microsoft/msedge-beta/msedge",
    ),
    chromiumCandidate(
      "msedge-dev",
      "/usr/bin/microsoft-edge-dev",
      "/opt/microsoft/msedge-dev/msedge",
    ),
    firefoxCandidate("moz-firefox", "/usr/bin/firefox", "/snap/bin/firefox"),
    firefoxCandidate("moz-firefox-beta", "/usr/bin/firefox-beta"),
    firefoxCandidate("moz-firefox-nightly", "/usr/bin/firefox-nightly"),
  ];
}

/** Detect supported system browsers without consulting Playwright-managed binaries. */
export function listInstalledBrowsers(): InstalledBrowser[] {
  const results: InstalledBrowser[] = [];

  for (const exe of browserCandidatesForPlatform()) {
    if (!SYSTEM_BROWSERS.has(exe.name)) continue;
    const exePath = firstExistingPath(exe.executablePaths);
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

/**
 * Preferred system browser order. Playwright-bundled test browsers
 * ("chromium", "firefox", "webkit") are never used — they get flagged
 * by bot detection because they are identifiable automation binaries.
 */
const SYSTEM_BROWSER_PREFERENCE = [
  "chrome",
  "msedge",
  "moz-firefox",
  "chrome-beta",
  "msedge-beta",
  "moz-firefox-beta",
  "moz-firefox-nightly",
  "chrome-dev",
  "chrome-canary",
  "msedge-dev",
  "msedge-canary",
];

/** Detect the best available system browser. */
export function detectDefaultBrowser(
  installed: InstalledBrowser[] = listInstalledBrowsers(),
): string {
  const installedNames = new Set(installed.map((b) => b.name));

  for (const name of SYSTEM_BROWSER_PREFERENCE) {
    if (installedNames.has(name)) return name;
  }

  if (installed.length > 0) return installed[0].name;

  throw new Error(
    "[playwright-stealth] No supported system browser detected. " +
      "Install Google Chrome, Microsoft Edge, or Mozilla Firefox. " +
      "Playwright bundled browsers (chromium, firefox, webkit) are not supported by this MCP.",
  );
}

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

/** Common aliases → system channel names. */
const BROWSER_ALIASES: Record<string, string> = {
  edge: "msedge",
  firefox: "moz-firefox",
  "firefox-beta": "moz-firefox-beta",
  "firefox-nightly": "moz-firefox-nightly",
  chromium: "chrome",
};

/** Validate and normalize a browser type string. Auto-detects if not set. */
export function parseBrowserType(
  value: string | undefined,
  installed?: InstalledBrowser[],
): string {
  if (!value) return detectDefaultBrowser(installed);

  const normalized = value.toLowerCase().trim();
  if (!normalized) return detectDefaultBrowser(installed);

  const aliased = BROWSER_ALIASES[normalized];
  if (aliased) return aliased;

  if (SYSTEM_BROWSERS.has(normalized)) return normalized;

  const fallback = detectDefaultBrowser(installed);
  console.error(
    `[playwright-stealth] Unknown or unsupported BROWSER_TYPE "${value}". Falling back to ${fallback}.`,
  );
  return fallback;
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

function getLaunchCandidateNames(
  preferredName: string,
  installed: InstalledBrowser[],
): string[] {
  const installedNames = new Set(installed.map((b) => b.name));
  const candidates = [preferredName];

  for (const name of SYSTEM_BROWSER_PREFERENCE) {
    if (name === preferredName) continue;
    if (installedNames.has(name)) candidates.push(name);
  }

  for (const browser of installed) {
    if (!candidates.includes(browser.name)) candidates.push(browser.name);
  }

  return candidates;
}

function buildLaunchOptions(
  browserName: string,
  engine: BrowserEngine,
  installed: InstalledBrowser[],
): Record<string, unknown> {
  const launchOptions: Record<string, unknown> = {
    headless: shouldLaunchHeadless(),
  };

  if (isChromiumBased(engine)) {
    launchOptions.args = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ];
  }

  const match = installed.find((b) => b.name === browserName);
  if (match) {
    launchOptions.executablePath = match.executablePath;
  } else if (PLAYWRIGHT_BUNDLED_BROWSER_NAMES.has(browserName)) {
    throw new Error(
      `Playwright bundled browser "${browserName}" is not supported. Install and select a system browser instead.`,
    );
  } else if (browserName !== engine) {
    launchOptions.channel = browserName;
  }

  return launchOptions;
}

export async function launchBrowserWithFallback(
  preferredName: string,
  installed: InstalledBrowser[],
  launchBrowser: (
    browserName: string,
    engine: BrowserEngine,
    launchOptions: Record<string, unknown>,
  ) => Promise<Browser>,
): Promise<{ browser: Browser; browserName: string }> {
  const candidates = getLaunchCandidateNames(preferredName, installed);
  const failures: string[] = [];

  for (const browserName of candidates) {
    const engine = resolveBrowserName(browserName);

    try {
      const launchOptions = buildLaunchOptions(browserName, engine, installed);
      const launchedBrowser = await launchBrowser(
        browserName,
        engine,
        launchOptions,
      );
      return { browser: launchedBrowser, browserName };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${browserName}: ${msg}`);
    }
  }

  throw new Error(
    `Failed to launch any supported browser. Tried ${failures.length} candidate(s): ${failures.join("; ")}.`,
  );
}

// ── State ──────────────────────────────────────────────────────────────────────

// Lazy: probing installed browser paths during module load can outrun the MCP
// stdio `initialize` handshake on slow disks. Resolve on first read instead
// (#1921).
type BrowserConnectionMode = "launch" | "cdp";

let activeBrowserName: string | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let browserConnectionMode: BrowserConnectionMode | null = null;
let stealthApplied = false;
let nextPageId = 1;
const pageIds = new WeakMap<Page, string>();

export interface BrowserPageInfo {
  id: string;
  index: number;
  url: string;
  title: string;
  isActive: boolean;
}

export type PageSelector = {
  id?: string;
  index?: number;
  urlContains?: string;
  titleContains?: string;
};

export type BrowserStartupMode =
  | { mode: "cdp"; cdpUrl: string }
  | { mode: "launch" };

// ── Public API ─────────────────────────────────────────────────────────────────

export function getConfiguredCdpUrl(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): string | null {
  const envUrl = env[CONNECT_CDP_URL_ENV]?.trim();
  if (envUrl) return envUrl;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cdp-url" || arg === "--connect-cdp-url") {
      const value = argv[i + 1]?.trim();
      if (value && !value.startsWith("--")) return value;
      continue;
    }

    for (const prefix of ["--cdp-url=", "--connect-cdp-url="]) {
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length).trim();
        return value || null;
      }
    }
  }

  return null;
}

export function resolveBrowserStartupMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): BrowserStartupMode {
  const cdpUrl = getConfiguredCdpUrl(env, argv);
  return cdpUrl ? { mode: "cdp", cdpUrl } : { mode: "launch" };
}

export function getActiveBrowserType(): string {
  if (activeBrowserName === null) {
    activeBrowserName =
      resolveBrowserStartupMode().mode === "cdp"
        ? "chromium-cdp"
        : parseBrowserType(process.env.BROWSER_TYPE);
  }
  return activeBrowserName;
}

/** Switch to a different browser. Closes the current browser if open. */
export async function setBrowser(
  name: string,
): Promise<{ name: string; browserName: string; stealthSupported: boolean }> {
  if (resolveBrowserStartupMode().mode === "cdp") {
    throw new Error(
      `Cannot switch browsers while ${CONNECT_CDP_URL_ENV} or --cdp-url is set. CDP attach mode uses the already-running Chromium browser.`,
    );
  }

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

/**
 * Creates a StealthPlugin with evasions safe for packaged macOS apps.
 * The `chrome.app` evasion module lives in a directory named "chrome.app".
 * macOS notarization rejects unsigned .app bundles, so our signing script
 * (scripts/sign-embedded-runtime.ts) removes all fake .app directories
 * inside node_modules.  Disabling this single evasion avoids the missing
 * dependency error at runtime while keeping all other stealth evasions
 * intact.  See: https://github.com/serenorg/seren-desktop/issues/1276
 */
export function createSafeStealthPlugin(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof StealthPlugin> {
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete("chrome.app");
  for (const evasion of getDisabledStealthEvasions(env)) {
    stealth.enabledEvasions.delete(evasion);
  }
  return stealth;
}

export function shouldLaunchHeadless(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PLAYWRIGHT_HEADLESS_ENV] !== "0";
}

export function shouldApplyStealthPlugin(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DISABLE_STEALTH_ENV] !== "1";
}

export function getDisabledStealthEvasions(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[STEALTH_EVASIONS_DISABLE_ENV];
  if (raw === undefined) return [...DEFAULT_DISABLED_STEALTH_EVASIONS];

  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function applyStealthPluginIfEnabled(
  engine: BrowserEngine,
  launcher: BrowserType & { use(plugin: unknown): void },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isChromiumBased(engine) || !shouldApplyStealthPlugin(env)) {
    return false;
  }

  launcher.use(createSafeStealthPlugin(env));
  return true;
}

export function shouldApplyPageInitPatch(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DISABLE_PAGE_INIT_PATCH_ENV] === "0";
}

export async function addPageInitPatchIfEnabled(
  targetPage: Page,
  engine: BrowserEngine,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isChromiumBased(engine) || !shouldApplyPageInitPatch(env)) {
    return false;
  }

  await targetPage.addInitScript(() => {
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
    window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
      parameters.name === "notifications"
        ? Promise.resolve({
            state: Notification.permission,
          } as PermissionStatus)
        : originalQuery(parameters);
  });
  return true;
}

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const startupMode = resolveBrowserStartupMode();

    if (startupMode.mode === "cdp") {
      try {
        browser = await chromium.connectOverCDP(startupMode.cdpUrl, {
          timeout: CDP_CONNECT_TIMEOUT_MS,
        });
        browserConnectionMode = "cdp";
        activeBrowserName = "chromium-cdp";
        return browser;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to connect to Chromium over CDP at ${startupMode.cdpUrl}: ${msg}. Ensure the browser was launched with --remote-debugging-port and the endpoint is reachable.`,
        );
      }
    }

    const installed = listInstalledBrowsers();
    try {
      const launched = await launchBrowserWithFallback(
        getActiveBrowserType(),
        installed,
        async (_browserName, engine, launchOptions) => {
          if (
            !stealthApplied &&
            applyStealthPluginIfEnabled(
              engine,
              chromium as BrowserType & { use(plugin: unknown): void },
            )
          ) {
            stealthApplied = true;
          }

          const launcher = getLauncher(engine);
          return launcher.launch(launchOptions);
        },
      );
      browser = launched.browser;
      browserConnectionMode = "launch";
      activeBrowserName = launched.browserName;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${msg} Ensure at least one supported system browser is installed and launchable.`,
      );
    }
  }
  return browser;
}

export function getDefaultBrowserContext(b: Browser): BrowserContext {
  const [defaultContext] = b.contexts();
  if (!defaultContext) {
    throw new Error(
      "Attached CDP browser has no default context. Launch Chrome or Edge with a normal profile and --remote-debugging-port, then retry.",
    );
  }
  return defaultContext;
}

export async function getContext(): Promise<BrowserContext> {
  if (!context) {
    const b = await getBrowser();
    if (browserConnectionMode === "cdp") {
      context = getDefaultBrowserContext(b);
      return context;
    }

    const engine = resolveBrowserName(getActiveBrowserType());
    context = await b.newContext({
      userAgent: DEFAULT_USER_AGENTS[engine],
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
  }
  return context;
}

function reusablePages(ctx: BrowserContext): Page[] {
  return ctx.pages().filter((candidate) => !candidate.isClosed());
}

function idForPage(targetPage: Page): string {
  const existing = pageIds.get(targetPage);
  if (existing) return existing;

  const id = `page-${nextPageId}`;
  nextPageId += 1;
  pageIds.set(targetPage, id);
  return id;
}

async function safePageTitle(targetPage: Page): Promise<string> {
  try {
    return await targetPage.title();
  } catch {
    return "";
  }
}

export async function getPage(): Promise<Page> {
  if (page?.isClosed()) {
    page = null;
  }

  if (!page) {
    const ctx = await getContext();
    const existingPage = reusablePages(ctx)[0];
    page = existingPage ?? (await ctx.newPage());

    const engine = resolveBrowserName(getActiveBrowserType());
    await addPageInitPatchIfEnabled(page, engine);
  }
  return page;
}

export async function listPages(): Promise<BrowserPageInfo[]> {
  const ctx = await getContext();
  const pages = reusablePages(ctx);

  return Promise.all(
    pages.map(async (targetPage, index) => ({
      id: idForPage(targetPage),
      index,
      url: targetPage.url(),
      title: await safePageTitle(targetPage),
      isActive: targetPage === page,
    })),
  );
}

export async function selectPage(selector: PageSelector): Promise<Page> {
  const hasSelector =
    selector.id !== undefined ||
    selector.index !== undefined ||
    selector.urlContains !== undefined ||
    selector.titleContains !== undefined;

  if (!hasSelector) {
    throw new Error(
      "Select a page by id, index, urlContains, or titleContains. Use playwright_list_pages first.",
    );
  }

  const ctx = await getContext();
  const pages = reusablePages(ctx);
  const pageInfos = await Promise.all(
    pages.map(async (targetPage, index) => ({
      targetPage,
      info: {
        id: idForPage(targetPage),
        index,
        url: targetPage.url(),
        title: await safePageTitle(targetPage),
      },
    })),
  );

  const match = pageInfos.find(({ info }) => {
    if (selector.id !== undefined) return info.id === selector.id;
    if (selector.index !== undefined) return info.index === selector.index;
    if (selector.urlContains !== undefined)
      return info.url.includes(selector.urlContains);
    if (selector.titleContains !== undefined)
      return info.title.includes(selector.titleContains);
    return false;
  });

  if (!match) {
    throw new Error(
      `No matching page found. Available pages: ${pageInfos
        .map(({ info }) => `${info.id}[${info.index}] ${info.url}`)
        .join("; ")}`,
    );
  }

  page = match.targetPage;
  await page.bringToFront().catch(() => undefined);

  const engine = resolveBrowserName(getActiveBrowserType());
  await addPageInitPatchIfEnabled(page, engine);

  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browserConnectionMode === "cdp") {
    if (browser) {
      const remoteBrowser = browser as Browser & {
        disconnect?: () => Promise<void> | void;
      };
      if (typeof remoteBrowser.disconnect === "function") {
        await remoteBrowser.disconnect();
      } else {
        await browser.close();
      }
    }
    page = null;
    context = null;
    browser = null;
    browserConnectionMode = null;
    activeBrowserName = null;
    return;
  }

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
  browserConnectionMode = null;
}

export async function resetPage(): Promise<void> {
  if (page) {
    if (browserConnectionMode !== "cdp") {
      await page.close();
    }
    page = null;
  }
}
