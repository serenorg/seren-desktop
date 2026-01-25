import { test, expect } from "@playwright/test";
import { gotoPhase3Playground, clickFileTreeItem } from "./utils";

const SRC_DIR = "/workspace/src";

test.beforeEach(async ({ page }) => {
  await gotoPhase3Playground(page);
});

test("file tree renders directories", async ({ page }) => {
  const directories = page.locator('[data-testid="file-tree-item"][data-file-type="directory"]');
  await expect(directories).toContainText(["src"]);
});

test("directories expand and collapse", async ({ page }) => {
  const childSelector = `[data-testid="file-tree-item"][data-file-path="${SRC_DIR}/App.tsx"]`;
  await expect(page.locator(childSelector)).toHaveCount(0);
  await clickFileTreeItem(page, SRC_DIR);
  await expect(page.locator(childSelector)).toHaveCount(1);
  await clickFileTreeItem(page, SRC_DIR);
  await expect(page.locator(childSelector)).toHaveCount(0);
});

test("selecting a file opens a tab", async ({ page }) => {
  await clickFileTreeItem(page, SRC_DIR);
  await clickFileTreeItem(page, `${SRC_DIR}/components`);
  await clickFileTreeItem(page, `${SRC_DIR}/components/Hello.tsx`);
  await expect(
    page.locator(`[data-testid=\"file-tab\"][data-file-path=\"${SRC_DIR}/components/Hello.tsx\"]`)
  ).toHaveCount(1);
});
