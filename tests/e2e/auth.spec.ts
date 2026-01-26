import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("user can sign in without load failures", async ({ page }) => {
    const fakeUser = {
      token: "dummy-token",
      user: {
        id: "user_123",
        email: "test+e2e@seren.dev",
        name: "Playwright User",
      },
    };

    page.on("console", (msg) => console.log("browser: ", msg.text()));
    page.on("pageerror", (err) => console.error("pageerror:", err.message));

    await page.addInitScript(() => {
      window.localStorage?.removeItem("seren_token");
    });

    await page.route("**/auth/verify-email", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fakeUser),
      });
    });

    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await page.goto("/?panel=account");
    await page.waitForSelector("form.signin-form", { timeout: 15000 });

    await page.getByLabel("Email").fill(fakeUser.user.email);
    await page.getByLabel("Password").fill("dummy-password");

    const submitButton = page.locator("form.signin-form button[type=submit]");

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/auth/verify-email") && response.status() === 200
      ),
      submitButton.click(),
    ]);

    await expect(page.locator(".signin-error")).toHaveCount(0);
    expect(dialogs).toHaveLength(0);
  });
});
