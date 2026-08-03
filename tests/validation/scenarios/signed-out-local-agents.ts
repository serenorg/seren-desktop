// ABOUTME: Launches every live local agent while the native app is signed out.
// ABOUTME: Guards against Seren authentication blocking provider-owned CLIs.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface TextDump {
  text?: string;
}

interface LiveAgent {
  type?: string;
  name?: string;
  available?: boolean;
}

const TARGETS = [
  {
    type: "claude-code",
    testId: "new-claude-agent",
    label: "Claude Code",
  },
  { type: "codex", testId: "new-codex-agent", label: "Codex" },
  { type: "gemini", testId: "new-gemini-agent", label: "Antigravity" },
  { type: "grok", testId: "new-grok-agent", label: "Grok" },
  {
    type: "claude-codex",
    testId: "new-claude-codex-agent",
    label: "Claude + Codex",
  },
  { type: "lmstudio", testId: "new-lmstudio-agent", label: "LM Studio" },
] as const;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

async function assertSignedOut(ctx: ScenarioContext): Promise<void> {
  try {
    await ctx.client.waitFor(
      "button[aria-label^='SerenBucks balance']",
      1_000,
    );
    throw new Error("Walkthrough profile is signed in");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Walkthrough profile is signed in"
    ) {
      throw error;
    }
  }
}

async function assertNoSerenSignInModal(
  ctx: ScenarioContext,
  agentType: string,
): Promise<void> {
  try {
    await ctx.client.waitFor(
      "[role='dialog'] #session-expired-modal-title",
      200,
    );
    throw new Error(`${agentType} opened the Seren sign-in modal`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `${agentType} opened the Seren sign-in modal`
    ) {
      throw error;
    }
  }
}

async function waitForAgentThread(
  ctx: ScenarioContext,
  target: (typeof TARGETS)[number],
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 180_000) {
    await assertNoSerenSignInModal(ctx, target.type);
    try {
      const label = textOf(
        await ctx.client.dumpText("button[title='Switch provider']"),
      );
      if (label.includes(target.label)) return;
    } catch {
      // The thread provider control mounts only after the local spawn succeeds.
    }
    const body = textOf(await ctx.client.dumpText("body"));
    if (
      body.includes(`${target.label} sign-in required`) ||
      body.includes("Authentication expired. Please log in")
    ) {
      throw new Error(`${target.type} requested upstream CLI authentication`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${target.type} to launch`);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    ctx.validationHome,
    "projects",
    "signed-out-local-agents",
  );
  await mkdir(projectPath, { recursive: true });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await assertSignedOut(ctx);
  await ctx.client.command({ command: "setRootPath", path: projectPath });

  const liveAgents = (await ctx.client.command({
    command: "readState",
    invokeName: "provider_get_available_agents",
  })) as LiveAgent[];
  if (!Array.isArray(liveAgents)) {
    throw new Error("The native provider runtime did not return an agent list");
  }
  const liveTypes = liveAgents
    .filter((agent): agent is LiveAgent & { type: string } =>
      Boolean(agent.type),
    )
    .map((agent) => agent.type);
  const expectedTypes = TARGETS.map((target) => target.type);
  if (
    liveTypes.length !== expectedTypes.length ||
    expectedTypes.some((type) => !liveTypes.includes(type))
  ) {
    throw new Error(
      `Local launcher coverage does not match the live runtime: ${liveTypes.join(", ")}`,
    );
  }

  const launched: string[] = [];
  for (const target of TARGETS) {
    await ctx.client.click("[data-testid='new-thread-button']");
    await ctx.client.waitFor(`[data-testid='${target.testId}']`, 10_000);
    await ctx.client.click(`[data-testid='${target.testId}']`);
    await waitForAgentThread(ctx, target);
    await sleep(750);
    await assertSignedOut(ctx);
    await assertNoSerenSignInModal(ctx, target.type);
    launched.push(target.type);
    await ctx.writeArtifact(
      `signed-out-${target.type}-screen.json`,
      await ctx.client.nativeScreenshot(),
    );
  }

  await sleep(2_000);
  await assertSignedOut(ctx);
  await assertNoSerenSignInModal(ctx, "completed local-agent walkthrough");

  await ctx.writeArtifact("signed-out-local-agents-result.json", {
    signedIn: false,
    liveAgentTypes: liveTypes,
    launchedAgentTypes: launched,
    everyLiveLocalAgentLaunched: launched.length === liveTypes.length,
    serenSignInModalShown: false,
    postLaunchObservationMs: 2_000,
  });

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
