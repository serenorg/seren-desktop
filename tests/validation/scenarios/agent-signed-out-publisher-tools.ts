// ABOUTME: Verifies a signed-out agent spawn visibly prompts for Seren auth.
// ABOUTME: Runs against the isolated real Tauri app with no mocked services.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface DumpTextResult {
  text?: string;
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.command({ command: "setRootPath", path: process.cwd() });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-codex-agent']", 10_000);
  await ctx.client.click("[data-testid='new-codex-agent']");

  const dialogSelector =
    "[role='dialog'][aria-labelledby='session-expired-modal-title']";
  await ctx.client.waitFor(dialogSelector, 60_000);
  const dialog = (await ctx.client.dumpText(dialogSelector)) as DumpTextResult;
  const text = dialog.text ?? "";
  if (
    !text.includes("Sign in to continue") ||
    !text.includes("Your Seren session has expired")
  ) {
    throw new Error(`Unexpected signed-out publisher-tools prompt: ${text}`);
  }

  await ctx.writeArtifact("signed-out-modal-text.json", dialog);
  await ctx.writeArtifact(
    "signed-out-modal-screenshot.json",
    await ctx.client.nativeScreenshot(),
  );
}
