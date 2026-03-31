// ABOUTME: Production bundle smoke tests to catch module ordering and TDZ errors.
// ABOUTME: These tests verify the built app loads without JavaScript initialization errors.

import { test, expect } from "@playwright/test";

test.describe("Production Bundle Integrity", () => {
  test("no ReferenceError or initialization errors on load", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Wait for app to fully initialize
    await page.waitForTimeout(2_000);

    const initErrors = errors.filter(
      (e) =>
        e.includes("ReferenceError") ||
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("is not defined") ||
        e.includes("SyntaxError"),
    );

    expect(initErrors).toEqual([]);
  });

  test("all store modules initialize without circular dependency errors", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Interact with UI to trigger reactive store evaluations
    const sidebar = page.getByTestId("thread-sidebar");
    if (await sidebar.isVisible()) {
      // Click new thread to force thread store reactive evaluation
      const newBtn = page.getByTestId("new-thread-button");
      if (await newBtn.isVisible()) {
        await newBtn.click();
        await page.waitForTimeout(500);
      }

      // Open sessions panel to force session store evaluation
      const sessionsBtn = page.getByTestId("sessions-button");
      if (await sessionsBtn.isVisible()) {
        await sessionsBtn.click();
        await page.waitForTimeout(500);
      }
    }

    const storeErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("is not a function"),
    );

    expect(storeErrors).toEqual([]);
  });

  test("no TDZ crash when restoring a persisted last-active thread", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Seed localStorage with a last-active thread BEFORE the app loads.
    // This triggers the threadStore.refresh() → selectThread() code path
    // that caused TDZ crashes when store chunks evaluated out of order.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "seren:lastActiveThread",
        JSON.stringify({ id: "fake-thread-id", kind: "chat" }),
      );
    });

    // Reload so the app picks up the persisted thread on init
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    const tdzErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("ReferenceError"),
    );

    expect(tdzErrors).toEqual([]);

    // Clean up
    await page.evaluate(() => {
      localStorage.removeItem("seren:lastActiveThread");
    });
  });

  test("no TDZ crash when restoring a persisted last-active agent thread", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem(
        "seren:lastActiveThread",
        JSON.stringify({ id: "fake-agent-thread-id", kind: "agent" }),
      );
    });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    const tdzErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("ReferenceError"),
    );

    expect(tdzErrors).toEqual([]);

    await page.evaluate(() => {
      localStorage.removeItem("seren:lastActiveThread");
    });
  });

  test("navigating between views does not crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Create a thread, then interact with multiple panels
    const newBtn = page.getByTestId("new-thread-button");
    if (await newBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await newBtn.click();

      // Click Seren Agent if the launcher shows
      const serenChat = page.getByTestId("new-seren-chat");
      if (
        await serenChat.isVisible({ timeout: 2_000 }).catch(() => false)
      ) {
        await serenChat.click();
        await page.waitForTimeout(1_000);
      }

      // Open sessions panel
      const sessionsBtn = page.getByTestId("sessions-button");
      if (await sessionsBtn.isVisible()) {
        await sessionsBtn.click();
        await page.waitForTimeout(500);
      }

      // Close panel with Escape
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      // Click thread again to trigger selectThread
      const threadItem = page.getByTestId("thread-item").first();
      if (
        await threadItem.isVisible({ timeout: 2_000 }).catch(() => false)
      ) {
        await threadItem.click();
        await page.waitForTimeout(500);
      }
    }

    const crashErrors = errors.filter(
      (e) =>
        e.includes("Cannot access") ||
        e.includes("before initialization") ||
        e.includes("ReferenceError") ||
        e.includes("TypeError") ||
        e.includes("is not a function"),
    );

    expect(crashErrors).toEqual([]);
  });
});
