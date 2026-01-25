import { test, expect } from "@playwright/test";
import { gotoPhase3Playground, clickFileTreeItem } from "./utils";

const SRC_DIR = "/workspace/src";

test.beforeEach(async ({ page }) => {
  await gotoPhase3Playground(page);
  await clickFileTreeItem(page, SRC_DIR);
});

test("typing triggers inline completions that can be accepted", async ({ page }) => {
  const editorView = page.locator(".monaco-editor .view-lines");
  await page.getByTestId("monaco-editor").click();
  await editorView.click({ position: { x: 200, y: 140 } });
  await page.keyboard.type("\nconsole.");
  await page.waitForTimeout(500);
  await page.keyboard.press("Tab");
  await expect(editorView).toContainText("console.log('Seren inline completion')");
});
