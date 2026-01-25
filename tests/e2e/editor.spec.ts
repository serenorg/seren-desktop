import { test, expect } from "@playwright/test";
import { gotoPhase3Playground, clickFileTreeItem } from "./utils";

const SRC_DIR = "/workspace/src";

test.beforeEach(async ({ page }) => {
  await gotoPhase3Playground(page);
  // expand src directory for subsequent tests
  await clickFileTreeItem(page, SRC_DIR);
});

test("editor renders and accepts input", async ({ page }) => {
  await page.getByTestId("monaco-editor").click();
  await page.keyboard.type("\nconst testValue = 99;");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("testValue");
});

test("selecting a file opens it in the editor", async ({ page }) => {
  await clickFileTreeItem(page, `${SRC_DIR}/components`);
  await clickFileTreeItem(page, `${SRC_DIR}/components/Hello.tsx`);
  await expect(page.getByTestId("active-file-path")).toHaveText(
    `${SRC_DIR}/components/Hello.tsx`
  );
  await expect(
    page.locator(`[data-testid="file-tab"][data-file-path="${SRC_DIR}/components/Hello.tsx"]`)
  ).toHaveClass(/active/);
});

test("typing marks tab dirty and shows indicator", async ({ page }) => {
  await page.getByTestId("monaco-editor").click();
  await page.keyboard.type("\n// dirty flag test");
  await expect(
    page.locator(`[data-testid="file-tab"][data-file-path="${SRC_DIR}/App.tsx"]`)
  ).toHaveClass(/dirty/);
});

test("typescript syntax highlighting tokens are rendered", async ({ page }) => {
  const view = page.locator(".monaco-editor .view-lines");
  await expect(view).toContainText("export");
});
