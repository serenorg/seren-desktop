import { expect, Page } from "@playwright/test";

export const PHASE3_URL = "/?test=phase3";

export async function gotoPhase3Playground(page: Page): Promise<void> {
  await page.goto(PHASE3_URL);
  await expect(page.getByTestId("phase3-playground")).toBeVisible();
}

export async function clickFileTreeItem(page: Page, filePath: string): Promise<void> {
  await page.locator(`[data-testid="file-tree-item"][data-file-path="${filePath}"]`).first().click();
}
