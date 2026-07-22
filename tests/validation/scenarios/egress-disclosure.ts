// ABOUTME: Verifies the live data-destination disclosure and settings reactions.
// ABOUTME: Exercises only signed-out UI paths reachable in the hermetic validation app.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface TextDump {
  text?: string;
}

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? (value as TextDump).text as string
    : JSON.stringify(value);
}

async function capturePanel(
  ctx: ScenarioContext,
  stage: string,
): Promise<string> {
  const panel = await ctx.client.dumpText(
    "[data-testid='data-destinations-panel']",
  );
  await ctx.writeArtifact(`${stage}-panel.json`, panel);
  await ctx.writeArtifact(
    `${stage}-panel-screenshot.json`,
    await ctx.client.screenshot("[data-testid='data-destinations-panel']"),
  );
  return textOf(panel);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-seren-chat']", 10_000);
  await ctx.client.click("[data-testid='new-seren-chat']");
  await ctx.client.waitFor(
    "[data-testid='data-destinations-panel']",
    30_000,
  );
  const before = await capturePanel(ctx, "before-settings-flip");

  await ctx.client.click("button[title='Settings']");
  await ctx.client.waitFor("[data-testid='settings-section-sync']", 10_000);
  await ctx.client.click("[data-testid='settings-section-sync']");
  await ctx.client.waitFor("[data-testid='history-sync-enabled']", 10_000);
  await ctx.client.click("[data-testid='history-sync-enabled']");

  await ctx.client.click("[data-testid='settings-section-general']");
  await ctx.client.waitFor("[data-testid='telemetry-enabled']", 10_000);
  await ctx.client.click("[data-testid='telemetry-enabled']");
  await ctx.writeArtifact(
    "settings-after-flips.json",
    await ctx.client.dumpText("main"),
  );
  await ctx.writeArtifact(
    "settings-after-flips-screenshot.json",
    await ctx.client.screenshot("main"),
  );

  await ctx.client.click("button[title='Close panel']");
  await ctx.client.waitFor(
    "[data-testid='data-destinations-panel']",
    10_000,
  );
  const after = await capturePanel(ctx, "after-settings-flip");
  await ctx.writeArtifact("settings-flip-summary.json", {
    changed: before !== after,
    before,
    after,
  });

  if (before === after) {
    throw new Error("The data-destination panel did not react to settings changes");
  }
  if (!after.includes("Disabled; queued diagnostics are discarded")) {
    throw new Error("The telemetry disclosure did not show its disabled state");
  }

  await ctx.writeArtifact(
    "after-settings-flip-native-screenshot.json",
    await ctx.client.nativeScreenshot(),
  );
}
