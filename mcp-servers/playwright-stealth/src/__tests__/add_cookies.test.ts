// ABOUTME: Tests for the playwright_add_cookies tool — verifies an HttpOnly
// ABOUTME: cookie written via addCookies is readable through getCookie.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, getContext, getPage } from "../browser.js";
import { addCookies, getCookie } from "../tools.js";

const ORIGIN = "https://example.test";

async function navigateToOrigin(): Promise<void> {
  const page = await getPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>ok</body></html>",
    });
  });
  await page.goto(`${ORIGIN}/`);
}

describe("addCookies", () => {
  beforeEach(async () => {
    const ctx = await getContext();
    await ctx.clearCookies();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it("writes an HttpOnly cookie that getCookie can read back", async () => {
    await navigateToOrigin();

    const result = await addCookies([
      {
        name: "privy-refresh-token",
        value: "refresh-token-abc",
        domain: "example.test",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    expect(result).toBe("Added 1 cookie(s)");
    const read = await getCookie("privy-refresh-token");
    expect(read).toEqual({ value: "refresh-token-abc" });
  });
});
