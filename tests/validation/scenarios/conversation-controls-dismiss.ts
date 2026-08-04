// ABOUTME: Live macOS walkthrough for dismissing new-agent conversation controls.
// ABOUTME: Verifies runtime launcher parity and per-conversation reset without mocks.

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface LiveAgent {
  type?: string;
  available?: boolean;
}

interface TextDump {
  text?: string;
}

const AGENT_TARGETS = [
  { type: "claude-code", testId: "new-claude-agent" },
  { type: "codex", testId: "new-codex-agent" },
  { type: "claude-codex", testId: "new-claude-codex-agent" },
  { type: "gemini", testId: "new-gemini-agent" },
  { type: "grok", testId: "new-grok-agent" },
  { type: "lmstudio", testId: "new-lmstudio-agent" },
] as const;

const PANEL_SELECTOR =
  "[data-testid='data-destinations-panel']:not([hidden])";
const DISMISS_SELECTOR = `${PANEL_SELECTOR} [data-testid='dismiss-conversation-controls']`;

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

async function isVisible(
  ctx: ScenarioContext,
  selector: string,
  timeoutMs = 500,
): Promise<boolean> {
  try {
    await ctx.client.waitFor(selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function openLauncher(ctx: ScenarioContext): Promise<void> {
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
}

async function launchAgent(
  ctx: ScenarioContext,
  target: (typeof AGENT_TARGETS)[number],
): Promise<void> {
  await ctx.client.waitFor(`[data-testid='${target.testId}']`, 10_000);
  await ctx.client.click(`[data-testid='${target.testId}']`);
  await ctx.client.waitFor(".chat-composer-form textarea", 120_000);
  await ctx.client.waitFor(PANEL_SELECTOR, 30_000);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    os.tmpdir(),
    "seren-conversation-controls-walkthrough",
  );
  await mkdir(projectPath, { recursive: true });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.command({ command: "setRootPath", path: projectPath });

  const liveAgents = (await ctx.client.command({
    command: "readState",
    invokeName: "provider_get_available_agents",
  })) as LiveAgent[];
  if (!Array.isArray(liveAgents)) {
    throw new Error("The native provider runtime did not return an agent list");
  }

  const availableTypes = liveAgents
    .filter((agent) => agent.available === true && typeof agent.type === "string")
    .map((agent) => agent.type as string);
  const unknownTypes = availableTypes.filter(
    (type) => !AGENT_TARGETS.some((target) => target.type === type),
  );
  if (unknownTypes.length > 0) {
    throw new Error(
      `The live runtime advertised unmapped agent types: ${unknownTypes.join(", ")}`,
    );
  }

  await openLauncher(ctx);
  const visibleTypes: string[] = [];
  for (const target of AGENT_TARGETS) {
    const expected = availableTypes.includes(target.type);
    if (
      await isVisible(
        ctx,
        `[data-testid='${target.testId}']`,
        expected ? 10_000 : 500,
      )
    ) {
      visibleTypes.push(target.type);
    }
  }
  if (
    availableTypes.length !== visibleTypes.length ||
    availableTypes.some((type) => !visibleTypes.includes(type))
  ) {
    throw new Error(
      `New-agent menu does not match the live runtime. Runtime: ${availableTypes.join(", ")}; UI: ${visibleTypes.join(", ")}`,
    );
  }
  await ctx.writeArtifact("agent-launcher-parity.json", {
    liveAvailableAgentTypes: availableTypes,
    visibleAgentTypes: visibleTypes,
    complete: true,
  });
  await ctx.writeArtifact(
    "agent-launcher-screen.json",
    await ctx.client.nativeScreenshot(),
  );

  const target =
    AGENT_TARGETS.find(
      (candidate) =>
        candidate.type === "codex" && visibleTypes.includes(candidate.type),
    ) ?? AGENT_TARGETS.find((candidate) => visibleTypes.includes(candidate.type));
  if (!target) {
    throw new Error("No live local agent was available for the walkthrough");
  }

  await launchAgent(ctx, target);
  const beforeDismiss = await ctx.client.dumpText(PANEL_SELECTOR);
  if (!textOf(beforeDismiss).includes("Conversation controls")) {
    throw new Error("The new-agent conversation controls were not visible");
  }
  await ctx.writeArtifact("before-dismiss-text.json", beforeDismiss);
  await ctx.writeArtifact(
    "before-dismiss-panel.json",
    await ctx.client.screenshot(PANEL_SELECTOR),
  );
  await ctx.writeArtifact(
    "before-dismiss-native.json",
    await ctx.client.nativeScreenshot(),
  );

  await ctx.client.click(DISMISS_SELECTOR);
  if (await isVisible(ctx, PANEL_SELECTOR, 1_000)) {
    throw new Error("Conversation controls remained visible after dismissal");
  }
  await ctx.writeArtifact(
    "after-dismiss-native.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact(
    "after-dismiss-text.json",
    await ctx.client.dumpText("body"),
  );

  await openLauncher(ctx);
  await launchAgent(ctx, target);
  const nextConversation = await ctx.client.dumpText(PANEL_SELECTOR);
  if (!textOf(nextConversation).includes("Conversation controls")) {
    throw new Error("A new agent did not receive its own conversation controls");
  }
  await ctx.writeArtifact("next-conversation-text.json", nextConversation);
  await ctx.writeArtifact(
    "next-conversation-native.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact("conversation-controls-dismiss-result.json", {
    affectedOs: process.platform,
    agentType: target.type,
    launcherCatalogVerifiedAgainstLiveRuntime: true,
    controlsVisibleOnNewAgent: true,
    controlsHiddenAfterDismiss: true,
    controlsVisibleOnNextAgent: true,
  });

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
