// ABOUTME: Walks the real Grok launcher and unauthenticated ACP spawn path in the validation app.
// ABOUTME: Captures evidence that Grok fails closed with sign-in guidance and no workspace recovery.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface DumpTextResult {
  text?: string;
}

const RECOVERY_TEXT = "Workspace is recovering.";
const AUTH_MESSAGES = [
  "Grok sign-in required",
  "Grok authentication required",
  "No supported Grok authentication method",
];

function dumpTextValue(value: unknown): string {
  return typeof (value as DumpTextResult)?.text === "string"
    ? ((value as DumpTextResult).text as string)
    : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.command({ command: "setRootPath", path: process.cwd() });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-grok-agent']", 10_000);

  const launcherText = await ctx.client.dumpText("body");
  const launcherBody = dumpTextValue(launcherText);
  if (!launcherBody.includes("Grok") || !launcherBody.includes("xAI")) {
    throw new Error("Grok launcher row or xAI description was not visible");
  }
  await ctx.writeArtifact("grok-launcher-text.json", launcherText);
  await ctx.writeArtifact(
    "grok-launcher-screenshot.json",
    await ctx.client.screenshot("body"),
  );

  await ctx.client.click("[data-testid='new-grok-agent']");

  let finalText: unknown = null;
  let finalBody = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(500);
    finalText = await ctx.client.dumpText("body");
    finalBody = dumpTextValue(finalText);
    if (finalBody.includes(RECOVERY_TEXT)) {
      throw new Error(`${RECOVERY_TEXT} appeared during Grok launch`);
    }
    if (AUTH_MESSAGES.some((message) => finalBody.includes(message))) break;
  }

  if (!AUTH_MESSAGES.some((message) => finalBody.includes(message))) {
    throw new Error("Grok launch did not surface its authentication guidance");
  }

  await ctx.writeArtifact("grok-auth-required-text.json", finalText);
  await ctx.writeArtifact(
    "grok-auth-required-screenshot.json",
    await ctx.client.screenshot("body"),
  );
  await ctx.writeArtifact(
    "grok-auth-required-native-screenshot.json",
    await ctx.client.nativeScreenshot(),
  );
}
