// ABOUTME: Verifies Mission Control's LM Studio picker against the live local inventory.
// ABOUTME: Exercises the native app with the LM Studio server stopped and no simulated state.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
// @ts-ignore - the provider runtime is plain ESM.
import { resolveLmsBinary } from "../../../bin/browser-local/lmstudio-runtime.mjs";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface LmsModelRecord {
  type?: string;
  modelKey?: string;
  displayName?: string;
}

const execFileAsync = promisify(execFile);
const settle = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function assertDefaultServerStopped(): Promise<void> {
  try {
    const response = await fetch("http://127.0.0.1:1234/v1/models", {
      signal: AbortSignal.timeout(1_000),
    });
    throw new Error(
      `LM Studio server unexpectedly answered with HTTP ${response.status}`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("LM Studio server unexpectedly answered")
    ) {
      throw error;
    }
  }
}

async function ensureMissionControlLaunchOpen(
  ctx: ScenarioContext,
): Promise<void> {
  const launchStart = "[data-testid='run-launch-start']";
  try {
    await ctx.client.waitFor(launchStart, 1_000);
    return;
  } catch {
    // Mission Control is closed. Avoid toggling an already-open launch form off.
  }

  await ctx.client.waitFor(
    "[data-testid='titlebar-mission-control-button']",
    30_000,
  );
  await ctx.client.click("[data-testid='titlebar-mission-control-button']");
  await ctx.client.waitFor(launchStart, 30_000);
}

async function ensureAdvancedControlsOpen(
  ctx: ScenarioContext,
): Promise<void> {
  const advancedSelector = "[data-testid='run-isolation-mode']";
  try {
    await ctx.client.waitFor(advancedSelector, 1_000);
    return;
  } catch {
    // Advanced controls are collapsed. Avoid closing an already-open panel.
  }

  await ctx.client.click("details > summary");
  await ctx.client.waitFor(advancedSelector, 10_000);
}

async function ensureLmStudioSelected(ctx: ScenarioContext): Promise<void> {
  const modelSelector = "[data-testid='run-model-lmstudio']";
  try {
    await ctx.client.waitFor(modelSelector, 500);
    return;
  } catch {
    // LM Studio is opt-in. Enable it before validating its model picker.
  }

  await ctx.client.click("[data-testid='run-agent-lmstudio']");
  await ctx.client.waitFor(modelSelector, 10_000);
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
  const llms = records.filter(
    (model): model is LmsModelRecord & { modelKey: string } =>
      (model.type == null || model.type === "llm") &&
      typeof model.modelKey === "string" &&
      model.modelKey.trim().length > 0,
  );
  return {
    ids: llms.map((model) => model.modelKey.trim()),
    names: llms.map((model) =>
      typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : model.modelKey.trim(),
    ),
  };
}

async function waitForModel(
  ctx: ScenarioContext,
  selector: string,
  modelId: string,
  timeoutMs = 30_000,
): Promise<number> {
  const started = Date.now();
  let lastRefreshAt = started;
  let refreshCount = 0;
  let lastError: unknown;
  while (Date.now() - started <= timeoutMs) {
    try {
      await ctx.client.select(selector, modelId);
      return refreshCount;
    } catch (error) {
      lastError = error;
      if (Date.now() - lastRefreshAt >= 5_000) {
        await ctx.client.click("details > summary");
        await settle(100);
        await ctx.client.click("details > summary");
        await ctx.client.waitFor(selector, 10_000);
        refreshCount += 1;
        lastRefreshAt = Date.now();
      }
      await settle(250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for LM Studio model ${modelId}`);
}

async function renderedModelIds(
  ctx: ScenarioContext,
  selector: string,
): Promise<string[]> {
  try {
    await ctx.client.select(selector, "__missing_validation_model__");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const marker = "Available: ";
    const start = message.indexOf(marker);
    if (start >= 0) {
      return message
        .slice(start + marker.length)
        .trim()
        .split(", ")
        .filter(Boolean);
    }
    throw error;
  }
  throw new Error("The validation-only missing model unexpectedly existed");
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    ctx.validationHome,
    "projects",
    "lmstudio-model-walkthrough",
  );
  await mkdir(projectPath, { recursive: true });
  await assertDefaultServerStopped();
  const expected = await liveLmsInventory();
  if (expected.ids.length === 0) {
    throw new Error("The live LM Studio inventory contains no downloaded LLMs");
  }

  await ctx.client.waitFor("[data-testid='thread-sidebar']", 30_000);
  await ctx.client.command({ command: "setRootPath", path: projectPath });
  await ensureMissionControlLaunchOpen(ctx);
  await ensureAdvancedControlsOpen(ctx);
  await ensureLmStudioSelected(ctx);

  const selector = "[data-testid='run-model-lmstudio']";
  const advancedControlsRefreshes = await waitForModel(
    ctx,
    selector,
    expected.ids[0],
  );
  const renderedIds = await renderedModelIds(ctx, selector);
  if (JSON.stringify(renderedIds) !== JSON.stringify(expected.ids)) {
    throw new Error(
      `Mission Control LM Studio models differ from lms: expected ${expected.ids.join(", ")}; rendered ${renderedIds.join(", ")}`,
    );
  }

  for (const modelId of expected.ids) {
    await ctx.client.select(selector, modelId);
  }
  await ctx.client.select(selector, expected.ids[0]);
  await assertDefaultServerStopped();

  await ctx.writeArtifact("lmstudio-model-catalog-verification.json", {
    serverStoppedBefore: true,
    serverStoppedAfter: true,
    expectedIds: expected.ids,
    expectedNames: expected.names,
    renderedIds,
    exactOrder: true,
    advancedControlsRefreshes,
    pinnedDefaultId: expected.ids[0],
    opaqueSystemDefaultPresent: false,
  });
  await ctx.writeArtifact(
    "lmstudio-model-catalog-text.json",
    await ctx.client.dumpText(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );
  await ctx.writeArtifact(
    "lmstudio-model-catalog-screen.json",
    await ctx.client.screenshot(
      "[data-testid='mission-launch-scroll-region']",
    ),
  );
  await ctx.writeArtifact(
    "lmstudio-model-catalog-native.json",
    await ctx.client.nativeScreenshot(),
  );

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
