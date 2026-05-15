// ABOUTME: Tests for the playwright_get_cookie tool — verifies HttpOnly cookies
// ABOUTME: are readable via BrowserContext where document.cookie cannot see them.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, getContext, getPage } from "../browser.js";
import { getCookie } from "../tools.js";

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

describe("getCookie", () => {
  beforeEach(async () => {
    const ctx = await getContext();
    await ctx.clearCookies();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it("returns the value of an HttpOnly cookie scoped to the active origin", async () => {
    await navigateToOrigin();
    const ctx = await getContext();
    await ctx.addCookies([
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

    const result = await getCookie("privy-refresh-token");
    expect(result).toEqual({ value: "refresh-token-abc" });
  });

  it("returns { value: null } when no cookie with that name exists", async () => {
    await navigateToOrigin();

    const result = await getCookie("nonexistent-cookie");
    expect(result).toEqual({ value: null });
  });
});
