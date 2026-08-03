// ABOUTME: Replays the LM Studio failure against the signed-out native app.
// ABOUTME: Verifies the complete live model picker and a real local chat turn.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
// @ts-ignore - the provider runtime is plain ESM.
import { resolveLmsBinary } from "../../../bin/browser-local/lmstudio-runtime.mjs";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface TextDump {
  text?: string;
}

interface LmsModelRecord {
  type?: string;
  modelKey?: string;
  displayName?: string;
}

interface LoadedModelRecord extends LmsModelRecord {
  contextLength?: number;
}

const MARKER = "LMSTUDIO_SCHEMA_OK_3657";
const SCHEMA_ERROR = "JSON schema conversion failed";
const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

async function assertSignedOut(ctx: ScenarioContext): Promise<void> {
  let signedIn = false;
  try {
    await ctx.client.waitFor(
      "button[aria-label^='SerenBucks balance']",
      1_000,
    );
    signedIn = true;
  } catch {
    // The balance control is the signed-in source of truth.
  }
  if (signedIn) {
    throw new Error(
      "Walkthrough profile is signed in; expected signed-out LM Studio",
    );
  }
}

async function liveLmsInventory(): Promise<{
  ids: string[];
  names: string[];
}> {
  const { stdout } = await execFileAsync(resolveLmsBinary(), [
    "ls",
    "--llm",
    "--json",
  ]);
  const records = JSON.parse(stdout) as LmsModelRecord[];
  if (!Array.isArray(records)) {
    throw new Error("lms ls --llm --json did not return an array");
  }
  const models = records.filter(
    (model): model is LmsModelRecord & { modelKey: string } =>
      (model.type == null || model.type === "llm") &&
      typeof model.modelKey === "string" &&
      model.modelKey.trim().length > 0,
  );
  return {
    ids: models.map((model) => model.modelKey.trim()),
    names: models.map((model) =>
      typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : model.modelKey.trim(),
    ),
  };
}

async function ensureFirstModelLoadedAtOriginalContext(
  modelId: string,
): Promise<void> {
  const binary = resolveLmsBinary();
  const { stdout } = await execFileAsync(binary, ["ps", "--json"]);
  const loaded = JSON.parse(stdout) as LoadedModelRecord[];
  if (
    Array.isArray(loaded) &&
    loaded.some(
      (model) => model.modelKey === modelId && model.contextLength === 8_192,
    )
  ) {
    return;
  }
  await execFileAsync(binary, [
    "load",
    modelId,
    "--context-length",
    "8192",
    "--ttl",
    "3600",
    "--identifier",
    "issue3657-walkthrough",
    "--yes",
  ]);
}

async function waitForOutcome(
  ctx: ScenarioContext,
  timeoutMs: number,
): Promise<
  "completed" | "schema-error" | "sign-in-required" | "runtime-error"
> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    try {
      const assistantText = textOf(
        await ctx.client.dumpText(
          "[data-message-role='assistant'] .chat-message-content",
        ),
      );
      if (assistantText.includes(MARKER)) return "completed";
    } catch {
      // The assistant row does not exist until the local model responds.
    }
    const body = textOf(await ctx.client.dumpText("body"));
    if (body.includes(SCHEMA_ERROR) || body.includes("Error resolving ref")) {
      return "schema-error";
    }
    if (
      body.includes("Sign in to continue") ||
      body.includes("Sign in to Seren")
    ) {
      return "sign-in-required";
    }
    if (
      body.includes("LM Studio chat completion HTTP") ||
      body.includes("Internal Server Error")
    ) {
      return "runtime-error";
    }
    await sleep(1_000);
  }
  throw new Error("Timed out waiting for the LM Studio schema walkthrough outcome");
}

async function openModelMenu(ctx: ScenarioContext): Promise<void> {
  try {
    await ctx.client.waitFor("[data-testid='agent-model-menu']", 200);
    return;
  } catch {
    // Closed menus are opened through the real picker button below.
  }
  await ctx.client.waitFor("button[title='Change model']", 60_000);
  await ctx.client.click("button[title='Change model']");
  await ctx.client.waitFor("[data-testid='agent-model-menu']", 10_000);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    ctx.validationHome,
    "projects",
    "lmstudio-schema-walkthrough",
  );
  await mkdir(projectPath, { recursive: true });
  const inventory = await liveLmsInventory();
  if (inventory.ids.length === 0) {
    throw new Error("The live LM Studio inventory contains no downloaded LLMs");
  }
  await ensureFirstModelLoadedAtOriginalContext(inventory.ids[0]);

  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await assertSignedOut(ctx);
  await ctx.client.command({ command: "setRootPath", path: projectPath });
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-lmstudio-agent']", 10_000);
  await ctx.writeArtifact(
    "lmstudio-launcher-screen.json",
    await ctx.client.screenshot("[data-testid='new-lmstudio-agent']"),
  );
  await ctx.client.click("[data-testid='new-lmstudio-agent']");
  await ctx.client.waitFor(".chat-composer-form textarea", 60_000);
  await sleep(2_000);

  await openModelMenu(ctx);
  const menuText = textOf(
    await ctx.client.dumpText("[data-testid='agent-model-menu']"),
  );
  let menuCursor = -1;
  for (const modelName of inventory.names) {
    const nextIndex = menuText.indexOf(modelName, menuCursor + 1);
    if (nextIndex <= menuCursor) {
      throw new Error(
        "LM Studio model picker did not match the ordered live lms inventory",
      );
    }
    menuCursor = nextIndex;
  }

  await openModelMenu(ctx);
  await ctx.writeArtifact(
    "lmstudio-model-menu-screen.json",
    await ctx.client.screenshot("body"),
  );
  await openModelMenu(ctx);
  try {
    await ctx.client.waitFor(
      `[data-testid='agent-model-menu'] > button:nth-of-type(${inventory.names.length + 1})`,
      500,
    );
    throw new Error("LM Studio model picker contains an option absent from lms");
  } catch (error) {
    if (
      error instanceof Error &&
      !error.message.includes("Timed out waiting for visible selector")
    ) {
      throw error;
    }
  }
  try {
    await ctx.client.waitFor("[data-testid='agent-model-menu']", 200);
    await ctx.client.click("button[title='Change model']");
  } catch {
    // The portal may already have closed after the absence check.
  }

  await ctx.client.fill(
    ".chat-composer-form textarea",
    `Do not call tools. Reply with exactly ${MARKER}.`,
  );
  await ctx.client.click(".chat-composer-form button[type='submit']");
  const outcome = await waitForOutcome(ctx, 240_000);
  await ctx.writeArtifact(
    "lmstudio-schema-fixed-screen.json",
    await ctx.client.screenshot(".chat-surface > div.flex-1.min-h-0"),
  );
  await ctx.writeArtifact("lmstudio-schema-result.json", {
    signedIn: false,
    serenSignInRequired: false,
    platform: process.platform,
    liveModelCount: inventory.ids.length,
    liveModelIds: inventory.ids,
    renderedModelCount: inventory.ids.length,
    exactModelOrder: true,
    everyLiveModelRendered: true,
    originalContextLength: 8_192,
    outcome,
    schemaConversionErrorVisible: outcome === "schema-error",
  });

  if (outcome !== "completed") {
    throw new Error(
      outcome === "sign-in-required"
        ? "LM Studio incorrectly required Seren sign-in"
        : outcome === "runtime-error"
          ? "LM Studio returned a runtime error instead of a local response"
          : "The fixed app still surfaced the LM Studio schema error",
    );
  }

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
