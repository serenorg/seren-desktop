// ABOUTME: Replays the #2862 paired-agent launch path in the real validation app.
// ABOUTME: Captures evidence that the workspace recovery fallback is not shown.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface DumpTextResult {
  text?: string;
}

const RECOVERY_TEXT = "Workspace is recovering.";

function dumpTextValue(value: unknown): string {
  return typeof (value as DumpTextResult)?.text === "string"
    ? ((value as DumpTextResult).text as string)
    : JSON.stringify(value);
}

async function assertNoWorkspaceRecovery(
  ctx: ScenarioContext,
  stage: string,
): Promise<void> {
  const text = await ctx.client.dumpText("body");
  const bodyText = dumpTextValue(text);
  await ctx.writeArtifact(`${stage}-text.json`, text);
  if (bodyText.includes(RECOVERY_TEXT)) {
    await ctx.writeArtifact(
      `${stage}-recovery-screenshot.json`,
      await ctx.client.screenshot("body"),
    );
    throw new Error(`${RECOVERY_TEXT} appeared during ${stage}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.command({
    command: "setRootPath",
    path: process.cwd(),
  });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await assertNoWorkspaceRecovery(ctx, "initial");

  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-claude-codex-agent']", 10_000);
  await ctx.client.click("[data-testid='new-claude-codex-agent']");

  await ctx.client.waitFor("[data-testid='paired-thread-header']", 60_000);
  await ctx.client.waitFor(".chat-composer-form textarea", 60_000);
  await assertNoWorkspaceRecovery(ctx, "paired-created");

  await ctx.client.fill(
    ".chat-composer-form textarea",
    "What models are you using?",
  );
  await ctx.client.click(".chat-composer-form button[type='submit']");

  await sleep(15_000);
  await ctx.client.waitFor("[data-testid='paired-thread-header']", 60_000);
  await assertNoWorkspaceRecovery(ctx, "paired-after-prompt");

  await ctx.writeArtifact(
    "paired-after-prompt-screenshot.json",
    await ctx.client.screenshot("body"),
  );
}
