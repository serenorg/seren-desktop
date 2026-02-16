// ABOUTME: MCP tool implementations for stealth browser automation

import { closeBrowser, getPage, resetPage } from "./browser.js";

export async function navigate(url: string): Promise<string> {
  const page = await getPage();
  await page.goto(url, { waitUntil: "networkidle" });
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
