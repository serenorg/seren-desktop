// ABOUTME: Baseline validation walkthrough scenario for isolated app launch evidence.
// ABOUTME: Captures body text and DOM-raster metadata from the real Tauri WebView.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

export default async function run(ctx: ScenarioContext): Promise<void> {
  await ctx.client.waitFor("body", 30_000);
  const text = await ctx.client.dumpText("body");
  await ctx.writeArtifact("ui-text.json", text);

  const screenshot = await ctx.client.screenshot("body");
  await ctx.writeArtifact("screenshot.json", screenshot);

  const nativeScreenshot = await ctx.client.nativeScreenshot();
  await ctx.writeArtifact("native-screenshot.json", nativeScreenshot);
}
