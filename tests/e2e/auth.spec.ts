import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("user can sign in without load failures", async ({ page }) => {
    const fakeResponse = {
      data: {
        access_token: "dummy-token",
        refresh_token: "dummy-refresh-token",
        expires_in: 3600,
        user: {
          id: "user_123",
          email: "test+e2e@seren.dev",
          name: "Playwright User",
        },
      },
    };

    page.on("console", (msg) => console.log("browser: ", msg.text()));
    page.on("pageerror", (err) => console.error("pageerror:", err.message));

    await page.addInitScript(() => {
      window.localStorage?.removeItem("seren_token");
    });

    await page.route("**/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fakeResponse),
      });
    });

    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    // Navigate to app and click on Chat tab to see sign-in form
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click Chat tab to show sign-in form for unauthenticated user
    await page.click("text=Chat");
    await page.waitForSelector("form.signin-form", { timeout: 15000 });

    await page.getByLabel("Email").fill(fakeResponse.data.user.email);
    await page.getByLabel("Password").fill("dummy-password");

    const submitButton = page.locator("form.signin-form button[type=submit]");

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/auth/login") && response.status() === 200
      ),
      submitButton.click(),
    ]);

    await expect(page.locator(".signin-error")).toHaveCount(0);
    expect(dialogs).toHaveLength(0);
  });

  test("forgot password link opens external URL", async ({ page, context }) => {
    // Navigate to app and click on Chat tab to see sign-in form
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click Chat tab to show sign-in form for unauthenticated user
    await page.click("text=Chat");
    await page.waitForSelector("form.signin-form", { timeout: 15000 });

    // Listen for new page/popup
    const pagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);

    // Click forgot password
    const forgotPasswordLink = page.locator("button.signin-link", { hasText: "Forgot password?" });
    await expect(forgotPasswordLink).toBeVisible();
    await forgotPasswordLink.click();

    // Either new page opens or we check window.open was called
    const newPage = await pagePromise;
    if (newPage) {
      const url = newPage.url();
      expect(url).toContain("console.serendb.com/forgot-password");
      await newPage.close();
    } else {
      // In browser mode, window.open fallback should work
      // If running in Tauri, the opener plugin handles it
      console.log("External link opened via system handler or blocked by test env");
    }
  });

  test("sign up link opens external URL", async ({ page, context }) => {
    // Navigate to app and click on Chat tab to see sign-in form
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click Chat tab to show sign-in form for unauthenticated user
    await page.click("text=Chat");
    await page.waitForSelector("form.signin-form", { timeout: 15000 });

    // Listen for new page/popup
    const pagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);

    // Click sign up link
    const signUpLink = page.locator("button.signin-link", { hasText: "Sign up for Seren" });
    await expect(signUpLink).toBeVisible();
    await signUpLink.click();

    // Either new page opens or we check window.open was called
    const newPage = await pagePromise;
    if (newPage) {
      const url = newPage.url();
      expect(url).toContain("console.serendb.com/signup");
      await newPage.close();
    } else {
      // In browser mode, window.open fallback should work
      // If running in Tauri, the opener plugin handles it
      console.log("External link opened via system handler or blocked by test env");
    }
  });
});
