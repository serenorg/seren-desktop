import { test, expect } from "@playwright/test";
import { gotoPhase3Playground, clickFileTreeItem } from "./utils";

const SRC_DIR = "/workspace/src";

test.beforeEach(async ({ page }) => {
  await gotoPhase3Playground(page);
  await clickFileTreeItem(page, SRC_DIR);
});

test("opening files creates tabs and highlights active tab", async ({ page }) => {
  await clickFileTreeItem(page, `${SRC_DIR}/components`);
  await clickFileTreeItem(page, `${SRC_DIR}/components/Hello.tsx`);
  const tabs = page.locator('[data-testid="file-tab"]');
  await expect(tabs).toHaveCount(2);
  await expect(
    page.locator(`[data-testid="file-tab"][data-file-path="${SRC_DIR}/components/Hello.tsx"]`)
  ).toHaveClass(/active/);
});

test("dirty indicator shows for unsaved files", async ({ page }) => {
  await page.getByTestId("monaco-editor").click();
  await page.keyboard.type("\n// unsaved change");
  const dirtyIndicator = page
    .locator(`[data-testid="file-tab"][data-file-path="${SRC_DIR}/App.tsx"]`)
    .locator(".file-tab-dirty-indicator");
  await expect(dirtyIndicator).toBeVisible();
});

test("tab closes when clicking the close button", async ({ page }) => {
  await clickFileTreeItem(page, `${SRC_DIR}/components`);
  await clickFileTreeItem(page, `${SRC_DIR}/components/Hello.tsx`);
  const tabLocator = page.locator(
    `[data-testid=\"file-tab\"][data-file-path=\"${SRC_DIR}/components/Hello.tsx\"]`
  );
  await tabLocator.locator('[data-testid="file-tab-close"]').click();
  await expect(tabLocator).toHaveCount(0);
});
