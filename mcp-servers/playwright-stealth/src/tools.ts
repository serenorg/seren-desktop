// ABOUTME: MCP tool implementations for stealth browser automation.
// ABOUTME: Includes browser discovery and runtime switching tools.

import type { BrowserContext, Page } from "playwright";
import {
  closeBrowser,
  getActiveBrowserType,
  getContext,
  getPage,
  listPages as listBrowserPages,
  listInstalledBrowsers,
  resetPage,
  selectPage as selectBrowserPage,
  setBrowser,
} from "./browser.js";
import type { PageSelector } from "./browser.js";
import type { NavigateOptions } from "./tool_definitions.js";

type CookieInput = Parameters<BrowserContext["addCookies"]>[0][number];
type WaitForSelectorOptions = NonNullable<
  Parameters<Page["waitForSelector"]>[1]
>;

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

export async function navigate(
  url: string,
  options?: NavigateOptions,
): Promise<string> {
  const page = await getPage();
  await page.goto(url, {
    waitUntil: options?.waitUntil ?? "load",
    timeout: options?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
  });
  return `Navigated to ${url}`;
}

export async function screenshot(_name?: string): Promise<string> {
  const page = await getPage();
  const buffer = await page.screenshot({ fullPage: true });
  const base64 = buffer.toString("base64");
  return base64;
}

export async function click(selector: string): Promise<string> {
  const page = await getPage();
  await page.click(selector);
  return `Clicked element: ${selector}`;
}

export async function fill(selector: string, value: string): Promise<string> {
  const page = await getPage();
  await page.fill(selector, value);
  return `Filled ${selector} with: ${value}`;
}

export async function evaluate(script: string): Promise<unknown> {
  const page = await getPage();
  return await page.evaluate(script);
}

// page.context().cookies() reads from the BrowserContext server-side, so
// HttpOnly cookies are visible — unlike document.cookie / page.evaluate
// which only see JS-readable cookies.
export async function getCookie(
  name: string,
): Promise<{ value: string | null }> {
  const page = await getPage();
  const cookies = await page.context().cookies(page.url());
  const match = cookies.find((c) => c.name === name);
  return { value: match ? match.value : null };
}

export async function addCookies(cookies: CookieInput[]): Promise<string> {
  const ctx = await getContext();
  await ctx.addCookies(cookies);
  return `Added ${cookies.length} cookie(s)`;
}

// Registers a script that runs before any page script on every navigation
// in the active context. Used to restore tokens into localStorage/sessionStorage
// before the SPA's bootstrap code runs.
export async function addInitScript(script: string): Promise<string> {
  const ctx = await getContext();
  await ctx.addInitScript(script);
  return "Init script registered";
}

export async function waitForSelector(
  selector: string,
  options?: WaitForSelectorOptions,
): Promise<string> {
  const page = await getPage();
  await page.waitForSelector(selector, options ?? {});
  return `Selector ready: ${selector}`;
}

export async function extractContent(selector?: string): Promise<string> {
  const page = await getPage();
  if (selector) {
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }
    const content = await element.textContent();
    return content || "";
  }
  const content = await page.textContent("body");
  return content || "";
}

export async function navigateBack(): Promise<string> {
  const page = await getPage();
  await page.goBack();
  return "Navigated back";
}

export async function navigateForward(): Promise<string> {
  const page = await getPage();
  await page.goForward();
  return "Navigated forward";
}

export async function selectOption(
  selector: string,
  value: string,
): Promise<string> {
  const page = await getPage();
  await page.selectOption(selector, value);
  return `Selected ${value} in ${selector}`;
}

export async function hover(selector: string): Promise<string> {
  const page = await getPage();
  await page.hover(selector);
  return `Hovered over ${selector}`;
}

export async function pressKey(selector: string, key: string): Promise<string> {
  const page = await getPage();
  await page.press(selector, key);
  return `Pressed ${key} in ${selector}`;
}

export async function close(): Promise<string> {
  await closeBrowser();
  return "Browser closed";
}

export async function reset(): Promise<string> {
  await resetPage();
  return "Page reset";
}

export function listBrowsers(): string {
  const installed = listInstalledBrowsers();
  const active = getActiveBrowserType();
  const result = installed.map((b) => ({
    ...b,
    isActive: b.name === active,
  }));
  return JSON.stringify(result, null, 2);
}

export async function listPages(): Promise<string> {
  const pages = await listBrowserPages();
  return JSON.stringify(pages, null, 2);
}

export async function selectPage(selector: PageSelector): Promise<string> {
  const page = await selectBrowserPage(selector);
  return `Selected page: ${page.url()}`;
}

export async function switchBrowser(browser: string): Promise<string> {
  const info = await setBrowser(browser);
  const stealth = info.stealthSupported ? "enabled" : "not available";
  return `Switched to ${info.name} (${info.browserName} engine). Stealth: ${stealth}`;
}
