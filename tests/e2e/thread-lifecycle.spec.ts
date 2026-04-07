// ABOUTME: E2e tests for thread creation, selection, and lifecycle.
// ABOUTME: Guards against TDZ crashes (#1334) and selectThread regressions.

import { test, expect } from "@playwright/test";

test.describe("Thread Lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    (page as any).__capturedErrors = errors;
  });

  test("app loads without module initialization errors", async ({ page }) => {
    const errors = (page as any).__capturedErrors as string[];

    // Only fail on TDZ / module initialization errors, not expected browser-mode errors
    const initErrors = errors.filter(
      (e) =>
        (e.includes("Cannot access") && e.includes("before initialization")) ||
        e.includes("SyntaxError"),
    );

    expect(initErrors).toEqual([]);
  });

  test("sidebar renders without TDZ crash", async ({ page }) => {
    const sidebar = page.getByTestId("thread-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const newButton = page.getByTestId("new-thread-button");
    await expect(newButton).toBeVisible();
    await expect(newButton).toBeEnabled();
  });

  test("clicking new thread button opens launcher", async ({ page }) => {
    const newButton = page.getByTestId("new-thread-button");
    await expect(newButton).toBeVisible({ timeout: 10_000 });
    await newButton.click();

    const launcher = page.getByTestId("new-seren-chat");
    await expect(launcher).toBeVisible({ timeout: 5_000 });
  });

  test("creating a chat thread adds it to the sidebar", async ({ page }) => {
    const threadsBefore = await page.getByTestId("thread-item").count();

    await page.getByTestId("new-thread-button").click();
    await page.getByTestId("new-seren-chat").click();

    await expect(page.getByTestId("thread-item")).toHaveCount(
      threadsBefore + 1,
      { timeout: 10_000 },
    );
  });

  test("selecting a thread does not throw ReferenceError", async ({
    page,
  }) => {
    const errors = (page as any).__capturedErrors as string[];

    // Create a thread
    await page.getByTestId("new-thread-button").click();
    await page.getByTestId("new-seren-chat").click();
    await expect(page.getByTestId("thread-item").first()).toBeVisible({
      timeout: 10_000,
    });

    // Click the thread item
    await page.getByTestId("thread-item").first().click();
    await page.waitForTimeout(500);

    // No TDZ / ReferenceError should have occurred
    const tdzErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") && e.includes("before initialization"),
    );
    expect(tdzErrors).toEqual([]);
  });

  test("clicking thread items repeatedly does not crash", async ({ page }) => {
    const errors = (page as any).__capturedErrors as string[];

    // Create a thread
    await page.getByTestId("new-thread-button").click();
    await page.getByTestId("new-seren-chat").click();
    await expect(page.getByTestId("thread-item").first()).toBeVisible({
      timeout: 10_000,
    });

    // Click the thread item multiple times (simulates rapid re-selection)
    const threadItem = page.getByTestId("thread-item").first();
    for (let i = 0; i < 3; i++) {
      await threadItem.click();
      await page.waitForTimeout(200);
    }

    const tdzErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") && e.includes("before initialization"),
    );
    expect(tdzErrors).toEqual([]);
  });
});
