// ABOUTME: E2e for the conversation history search overlay — wiring and graceful degrade.
// ABOUTME: Browser mode has no local SQLite index, so this asserts UI wiring + no-crash, not hits.

import { expect, test } from "@playwright/test";

test.describe("Conversation history search", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.waitForLoadState("load");
    (page as unknown as { __errors: string[] }).__errors = errors;
  });

  test("sidebar Search history entry opens the overlay and focuses the input", async ({
    page,
  }) => {
    const button = page.getByTestId("search-history-button");
    await expect(button).toBeVisible({ timeout: 10_000 });
    await button.click();

    await expect(
      page.getByTestId("conversation-search-overlay"),
    ).toBeVisible();
    await expect(page.getByTestId("conversation-search-input")).toBeFocused();
  });

  test("typing a query degrades gracefully to a no-results state without crashing", async ({
    page,
  }) => {
    await page.getByTestId("search-history-button").click();
    const input = page.getByTestId("conversation-search-input");
    await input.fill("updater signing");

    // Browser mode has no local index, so the service returns empty results
    // (never throwing). The overlay shows its no-results state.
    await expect(page.getByText("No matches.")).toBeVisible({
      timeout: 10_000,
    });

    const errors = (page as unknown as { __errors: string[] }).__errors;
    const initErrors = errors.filter(
      (error) =>
        (error.includes("Cannot access") &&
          error.includes("before initialization")) ||
        error.includes("SyntaxError"),
    );
    expect(initErrors).toEqual([]);
  });

  test("Escape closes the overlay", async ({ page }) => {
    await page.getByTestId("search-history-button").click();
    await expect(
      page.getByTestId("conversation-search-overlay"),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      page.getByTestId("conversation-search-overlay"),
    ).toBeHidden();
  });
});
