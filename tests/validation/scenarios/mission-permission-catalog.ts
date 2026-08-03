// ABOUTME: Captures Mission Control's real provider-native permission catalogs.
// ABOUTME: Uses the validation bridge only for native WebView interaction and evidence.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

const settle = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function ensureMissionControlLaunchOpen(
  ctx: ScenarioContext,
): Promise<void> {
  const missionControl = "[data-testid='titlebar-mission-control-button']";
  const launchStart = "[data-testid='run-launch-start']";

  try {
    await ctx.client.waitFor(launchStart, 1_000);
    return;
  } catch {
    // Mission Control is closed. Avoid toggling an already-open launch form off.
  }

  await ctx.client.waitFor(missionControl, 30_000);
  await ctx.client.click(missionControl);
  try {
    await ctx.client.waitFor(launchStart, 30_000);
  } catch (error) {
    await ctx.writeArtifact(
      "mission-launch-failure-text.json",
      await ctx.client.dumpText("body"),
    );
    await ctx.writeArtifact(
      "mission-launch-failure-native.json",
      await ctx.client.nativeScreenshot(),
    );
    throw error;
  }
}

const expectedModes = {
  "claude-code": ["", "default", "acceptEdits", "plan", "bypassPermissions"],
  codex: ["", "auto", "ask"],
  gemini: ["", "default", "accept-edits", "plan", "yolo"],
  grok: [
    "",
    "default",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
    "plan",
  ],
  "claude-codex": ["", "auto", "ask"],
  lmstudio: ["", "ask", "auto"],
} as const;

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    ctx.validationHome,
    "projects",
    "permission-walkthrough",
  );
  await mkdir(projectPath, { recursive: true });
  await ctx.client.waitFor("[data-testid='thread-sidebar']", 30_000);
  await ctx.client.command({
    command: "setRootPath",
    path: projectPath,
  });
  await ensureMissionControlLaunchOpen(ctx);
  await ctx.client.click("details > summary");
  await ctx.client.waitFor("[data-testid='run-permission-claude-code']", 10_000);

  for (const agentType of ["gemini", "grok", "claude-codex", "lmstudio"]) {
    await ctx.client.click(`[data-testid='run-agent-${agentType}']`);
  }

  await settle(3_000);
  const verifiedModes: Record<string, string[]> = {};
  for (const [agentType, modeIds] of Object.entries(expectedModes)) {
    const selector = `[data-testid='run-permission-${agentType}']`;
    for (const modeId of modeIds) {
      await ctx.client.select(selector, modeId);
    }
    verifiedModes[agentType] = [...modeIds];
    await ctx.client.select(selector, "");
  }
  await ctx.writeArtifact("permission-catalog-verification.json", {
    verifiedModes,
  });

  await ctx.writeArtifact(
    "mission-permission-catalog-screen.json",
    await ctx.client.screenshot(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );
  await ctx.writeArtifact(
    "mission-permission-catalog-native.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact(
    "mission-permission-catalog-text.json",
    await ctx.client.dumpText(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
