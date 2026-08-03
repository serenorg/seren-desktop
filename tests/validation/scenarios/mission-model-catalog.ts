// ABOUTME: Captures Mission Control's real local-CLI model catalog walkthrough.
// ABOUTME: Uses the validation bridge only for native WebView interaction and evidence.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

const settle = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.waitFor("[data-testid='thread-sidebar']", 30_000);
  await ctx.client.command({
    command: "setRootPath",
    path: "/tmp/seren-model-walkthrough",
  });
  await ctx.client.click("[data-testid='titlebar-mission-control-button']");
  await settle(500);
  await ctx.client.waitFor("[data-testid='run-launch-start']", 10_000);
  await ctx.client.click("details > summary");
  await ctx.client.waitFor("[data-testid='run-model-claude-code']", 10_000);

  for (const agentType of ["gemini", "grok", "claude-codex"]) {
    await ctx.client.click(`[data-testid='run-agent-${agentType}']`);
  }

  await settle(15_000);
  await ctx.writeArtifact(
    "fable-selection.json",
    await ctx.client.select(
      "[data-testid='run-model-claude-code']",
      "claude-fable-5[1m]",
    ),
  );
  await settle(500);
  for (const target of [
    "claude-code",
    "codex",
    "gemini",
    "grok",
    "claude-codex-planner",
    "claude-codex-executor",
  ]) {
    await ctx.writeArtifact(
      `model-${target}.json`,
      await ctx.client.dumpText(`[data-testid='run-model-${target}']`),
    );
  }

  await ctx.writeArtifact(
    "mission-model-catalog-screen.json",
    await ctx.client.screenshot(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );
  await ctx.writeArtifact(
    "mission-model-catalog-native.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact(
    "mission-model-catalog-text.json",
    await ctx.client.dumpText(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
