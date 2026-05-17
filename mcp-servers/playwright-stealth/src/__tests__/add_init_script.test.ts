// ABOUTME: Tests for the playwright_add_init_script tool — verifies a script
// ABOUTME: registered on the context runs before page scripts on navigation.

import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, getPage, resetPage } from "../browser.js";
import { addInitScript, evaluate } from "../tools.js";

const ORIGIN = "https://example.test";

describe("addInitScript", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("runs registered script before page scripts on every navigation", async () => {
    // Fresh page so a previously-installed init script from another test
    // cannot mask whether the new one actually fired.
    await resetPage();
    const page = await getPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<html><body>ok</body></html>",
      });
    });

    const result = await addInitScript(
      "window.localStorage.setItem('seren-session', 'jwt-xyz');",
    );
    expect(result).toBe("Init script registered");

    await page.goto(`${ORIGIN}/`);
    const value = await evaluate(
      "window.localStorage.getItem('seren-session')",
    );
    expect(value).toBe("jwt-xyz");
  });
});
