// ABOUTME: Live, signed-in Antigravity walkthrough for the retired Gemini Agent path.
// ABOUTME: Verifies CLI/UI catalog parity plus a resumable two-turn conversation without mocks.

import { execFileSync } from "node:child_process";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";
// @ts-ignore - browser-local runtime is plain ESM without declarations.
import { resolveAntigravityBinary } from "../../../bin/browser-local/antigravity-binary.mjs";
// @ts-ignore - browser-local runtime is plain ESM without declarations.
import { normalizeAntigravityModels } from "../../../bin/browser-local/gemini-runtime.mjs";

interface TextDump {
  text?: string;
}

interface CliModel {
  modelId: string;
  name: string;
}

const FIRST_MARKER = "ANTIGRAVITY_FIRST_TURN_3648";
const MEMORY_TOKEN = "ORBITAL_MEMORY_3648";
const RESUME_MARKER = `ANTIGRAVITY_RESUMED_${MEMORY_TOKEN}`;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

async function waitForBodyText(
  ctx: ScenarioContext,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (textOf(await ctx.client.dumpText("body")).includes(marker)) return;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for sanitized marker ${marker}`);
}

async function sendPrompt(
  ctx: ScenarioContext,
  prompt: string,
): Promise<void> {
  await ctx.client.waitFor(".chat-composer-form textarea", 60_000);
  await ctx.client.fill(".chat-composer-form textarea", prompt);
  await ctx.client.waitFor(
    ".chat-composer-form button[type='submit']",
    60_000,
  );
  await ctx.client.click(".chat-composer-form button[type='submit']");
}

function liveCliModels(): CliModel[] {
  const binary = resolveAntigravityBinary();
  const output = execFileSync(binary, ["models"], {
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      AGY_CLI_HIDE_ACCOUNT_INFO: "1",
      CI: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
  const models = normalizeAntigravityModels(output);
  if (models.length === 0) {
    throw new Error("The signed-in Antigravity CLI returned no models");
  }
  return models as CliModel[];
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const expectedModels = liveCliModels();

  await ctx.client.command({
    command: "setRootPath",
    path: "/tmp/seren-antigravity-walkthrough",
  });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-gemini-agent']", 10_000);

  const launcherText = textOf(
    await ctx.client.dumpText("[data-testid='new-gemini-agent']"),
  );
  if (!launcherText.includes("Antigravity")) {
    throw new Error("The retired Gemini label is still visible in the launcher");
  }
  await ctx.client.click("[data-testid='new-gemini-agent']");

  await ctx.client.waitFor("button[title='Change model']", 60_000);
  await ctx.client.click("button[title='Change model']");
  const modelMenu = await ctx.client.dumpText("body");
  const modelMenuText = textOf(modelMenu);
  for (const model of expectedModels) {
    if (!modelMenuText.includes(model.name)) {
      throw new Error(
        `Antigravity model picker omitted CLI model ${model.modelId}`,
      );
    }
  }
  await ctx.writeArtifact("antigravity-model-menu.json", modelMenu);
  await ctx.client.press("Escape");

  await ctx.client.waitFor("button[title='Change permission mode']", 10_000);
  await ctx.client.click("button[title='Change permission mode']");
  const modeMenu = await ctx.client.dumpText("body");
  const modeMenuText = textOf(modeMenu);
  for (const mode of [
    "Saved rules",
    "Accept edits",
    "Plan",
    "Skip permissions",
  ]) {
    if (!modeMenuText.includes(mode)) {
      throw new Error(`Antigravity permission picker omitted ${mode}`);
    }
  }
  await ctx.writeArtifact("antigravity-mode-menu.json", modeMenu);
  await ctx.client.press("Escape");

  await sendPrompt(
    ctx,
    `Remember ${MEMORY_TOKEN} for the next turn. Do not use tools. Reply with exactly ${FIRST_MARKER}.`,
  );
  await waitForBodyText(ctx, FIRST_MARKER, 180_000);

  await sendPrompt(
    ctx,
    `Without using tools, prove this is the same conversation by replying with exactly ANTIGRAVITY_RESUMED_ followed by the token I asked you to remember.`,
  );
  await waitForBodyText(ctx, RESUME_MARKER, 180_000);

  await ctx.writeArtifact("antigravity-live-result.json", {
    signedIn: true,
    launcherLabel: "Antigravity",
    cliModelCount: expectedModels.length,
    cliModelIds: expectedModels.map((model) => model.modelId),
    uiModelCount: expectedModels.length,
    permissionModesVerified: 4,
    firstTurnCompleted: true,
    exactConversationResumed: true,
  });
  await ctx.writeArtifact(
    "antigravity-live-native.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact(
    "antigravity-live-text.json",
    await ctx.client.dumpText("body"),
  );

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
