// ABOUTME: Tests for the playwright_wait_for_selector tool — verifies it
// ABOUTME: resolves on asynchronous element insert and rejects on timeout.

import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, getPage, resetPage } from "../browser.js";
import { waitForSelector } from "../tools.js";

const ORIGIN = "https://example.test";

async function navigateWithBody(body: string): Promise<void> {
  await resetPage();
  const page = await getPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<html><body>${body}</body></html>`,
    });
  });
  await page.goto(`${ORIGIN}/`);
}

describe("waitForSelector", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("resolves once an asynchronously-inserted selector becomes visible", async () => {
    await navigateWithBody(
      "<script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'hi'; document.body.appendChild(d); }, 50);</script>",
    );

    const result = await waitForSelector("#late", { timeout: 5000 });
    expect(result).toBe("Selector ready: #late");
  });

  it("rejects when the selector never appears within the timeout", async () => {
    await navigateWithBody("<div>empty</div>");

    await expect(waitForSelector("#never", { timeout: 250 })).rejects.toThrow();
  });
});
