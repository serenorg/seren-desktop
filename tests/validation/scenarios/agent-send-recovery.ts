// ABOUTME: Reproduces the single-agent Send -> "Workspace is recovering" crash.
// ABOUTME: Provider-agnostic: exercises both Claude Code and Codex send paths.

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

async function exerciseAgent(
  ctx: ScenarioContext,
  newAgentTestId: string,
  label: string,
): Promise<void> {
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor(`[data-testid='${newAgentTestId}']`, 10_000);
  await ctx.client.click(`[data-testid='${newAgentTestId}']`);

  await ctx.client.waitFor(".chat-composer-form textarea", 60_000);
  await assertNoWorkspaceRecovery(ctx, `${label}-created`);

  await ctx.client.fill(".chat-composer-form textarea", "Hello world!");
  await ctx.client.click(".chat-composer-form button[type='submit']");

  // The crash fires on the turnInFlight flip and again as status frames stream
  // in during the turn. Poll across the whole active-turn window.
  for (let i = 0; i < 12; i += 1) {
    await sleep(2_500);
    await assertNoWorkspaceRecovery(ctx, `${label}-turn-${i}`);
  }

  await ctx.writeArtifact(
    `${label}-after-prompt-screenshot.json`,
    await ctx.client.screenshot("body"),
  );
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.command({ command: "setRootPath", path: process.cwd() });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await assertNoWorkspaceRecovery(ctx, "initial");

  await exerciseAgent(ctx, "new-claude-agent", "claude");
  await exerciseAgent(ctx, "new-codex-agent", "codex");
}
