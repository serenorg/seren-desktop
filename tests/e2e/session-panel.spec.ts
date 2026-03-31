// ABOUTME: E2e tests for the Sessions panel slide-out.
// ABOUTME: Verifies session panel opens without TDZ crash and renders correctly.

import { test, expect } from "@playwright/test";

test.describe("Session Panel", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    (page as any).__capturedErrors = errors;
  });

  test("sessions button is visible in sidebar", async ({ page }) => {
    const sessionsBtn = page.getByTestId("sessions-button");
    await expect(sessionsBtn).toBeVisible({ timeout: 10_000 });
    await expect(sessionsBtn).toContainText("Sessions");
  });

  test("clicking sessions button opens panel without errors", async ({
    page,
  }) => {
    const errors = (page as any).__capturedErrors as string[];

    await page.getByTestId("sessions-button").click();

    // The sessions panel should appear with "Sessions" heading
    const heading = page.locator("h2", { hasText: "Sessions" });
    await expect(heading).toBeVisible({ timeout: 5_000 });

    // No TDZ errors
    const tdzErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") || e.includes("before initialization"),
    );
    expect(tdzErrors).toEqual([]);
  });

  test("sessions panel shows new button and empty state", async ({ page }) => {
    await page.getByTestId("sessions-button").click();

    // "+ New" button should be visible
    const newBtn = page.locator("button", { hasText: "+ New" });
    await expect(newBtn).toBeVisible({ timeout: 5_000 });

    // Empty state should show
    const emptyText = page.locator("text=No sessions yet");
    await expect(emptyText).toBeVisible();
  });
});
