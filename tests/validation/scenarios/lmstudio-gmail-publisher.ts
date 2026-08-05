// ABOUTME: Drives a signed-in LM Studio agent through live Gmail publisher discovery and read-only search.
// ABOUTME: Verifies the complete local model and agent catalogs without exposing mailbox or account data.

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
// @ts-ignore - the provider runtime is plain ESM.
import { resolveLmsBinary } from "../../../bin/browser-local/lmstudio-runtime.mjs";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";
import { submitSignIn } from "./signed-in-smoke";

interface TextDump {
  text?: string;
  rows?: Array<{ text?: string }>;
}

interface LiveAgent {
  type?: string;
  available?: boolean;
}

interface LmsModelRecord {
  type?: string;
  modelKey?: string;
  displayName?: string;
  trainedForToolUse?: boolean;
}

interface LoadedModelRecord extends LmsModelRecord {
  contextLength?: number;
}

const MARKER = "GMAIL_PUBLISHER_SEARCH_OK_3719";
const QUERY = 'subject:"__SEREN_VALIDATION_3719_DO_NOT_CREATE__"';
const TOOL_SEQUENCE = [
  "list_agent_publishers",
  "list_mcp_tools",
  "call_publisher",
] as const;
const AGENT_TEST_IDS: Record<string, string> = {
  "claude-code": "new-claude-agent",
  codex: "new-codex-agent",
  "claude-codex": "new-claude-codex-agent",
  gemini: "new-gemini-agent",
  grok: "new-grok-agent",
  lmstudio: "new-lmstudio-agent",
};
const execFileAsync = promisify(execFile);
const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function captureNativeScreen(
  ctx: ScenarioContext,
  name: string,
): Promise<void> {
  await ctx.writeArtifact(name, await ctx.client.nativeScreenshot());
}

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

async function liveLmsInventory(): Promise<{
  ids: string[];
  names: string[];
  toolModelIds: string[];
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
    toolModelIds: models
      .filter((model) => model.trainedForToolUse === true)
      .map((model) => model.modelKey.trim()),
  };
}

async function selectLoadedToolModel(
  toolModelIds: string[],
): Promise<{ modelId: string; contextLength: number }> {
  const binary = resolveLmsBinary();
  const { stdout } = await execFileAsync(binary, ["ps", "--json"]);
  const loaded = JSON.parse(stdout) as LoadedModelRecord[];
  const ready = Array.isArray(loaded)
    ? loaded.find(
        (model) =>
          typeof model.modelKey === "string" &&
          toolModelIds.includes(model.modelKey) &&
          model.contextLength === 8_192,
      )
    : undefined;
  if (!ready?.modelKey) {
    throw new Error(
      "The walkthrough needs a tool-trained LM Studio model loaded at the reproduced 8,192-token context",
    );
  }
  return { modelId: ready.modelKey, contextLength: ready.contextLength ?? 0 };
}

async function openModelMenu(ctx: ScenarioContext): Promise<void> {
  try {
    await ctx.client.waitFor("[data-testid='agent-model-menu']", 200);
    return;
  } catch {
    // Open the real model picker below.
  }
  await ctx.client.waitFor("button[title='Change model']", 60_000);
  await ctx.client.click("button[title='Change model']");
  await ctx.client.waitFor("[data-testid='agent-model-menu']", 10_000);
}

function pendingToolName(dump: TextDump): (typeof TOOL_SEQUENCE)[number] | null {
  const rowTexts = (dump.rows ?? []).map((row) => row.text?.trim() ?? "");
  const pendingIndex = rowTexts.lastIndexOf("Pending");
  const lastTerminalIndex = Math.max(
    rowTexts.lastIndexOf("Completed"),
    rowTexts.lastIndexOf("Failed"),
  );
  const searchStart = pendingIndex >= 0 ? pendingIndex - 1 : rowTexts.length - 1;
  const searchFloor =
    pendingIndex >= 0
      ? Math.max(0, pendingIndex - 30)
      : Math.max(0, lastTerminalIndex + 1);
  for (let index = searchStart; index >= searchFloor; index -= 1) {
    const candidate = rowTexts[index];
    const canonical = TOOL_SEQUENCE.find(
      (tool) => candidate === tool || candidate.endsWith(`__${tool}`),
    );
    if (canonical) return canonical;
    if (["Completed", "Failed", "Pending"].includes(rowTexts[index])) break;
  }
  return null;
}

async function approveRoutingSequence(ctx: ScenarioContext): Promise<void> {
  const approvalSelector = "button[title='Run this tool call one time.']";
  const approved = new Set<(typeof TOOL_SEQUENCE)[number]>();
  const started = Date.now();
  let approvalCount = 0;
  while (Date.now() - started <= 300_000 && approvalCount < 8) {
    const dump = (await ctx.client.dumpText("body")) as TextDump;
    const body = textOf(dump);
    if (
      body.includes("not in the configured endpoint allowlist") ||
      body.includes("LM Studio chat completion HTTP")
    ) {
      throw new Error("Publisher routing surfaced the original failure");
    }
    try {
      await ctx.client.waitFor(approvalSelector, 500);
      const pendingDump = (await ctx.client.dumpText("body")) as TextDump;
      const pendingBody = textOf(pendingDump);
      const pendingTool = pendingToolName(pendingDump);
      if (!pendingTool) {
        await ctx.writeArtifact(
          "failure-unresolved-approval.json",
          pendingDump,
        );
        throw new Error("Could not resolve the pending publisher routing tool");
      }
      if (pendingBody.includes("/gmail/v1/")) {
        throw new Error(
          "Gmail execution attempted a guessed REST path instead of a generated tool",
        );
      }
      if (pendingTool === "call_publisher") {
        if (
          !approved.has("list_agent_publishers") ||
          !approved.has("list_mcp_tools")
        ) {
          throw new Error("call_publisher ran before both discovery milestones");
        }
        await captureNativeScreen(
          ctx,
          "05-call_publisher-approval-screen.json",
        );
      } else if (!approved.has(pendingTool)) {
        const step = pendingTool === "list_agent_publishers" ? "03" : "04";
        await captureNativeScreen(
          ctx,
          `${step}-${pendingTool}-approval-screen.json`,
        );
      }
      await ctx.client.click(approvalSelector);
      approved.add(pendingTool);
      approvalCount += 1;
      await sleep(750);
      if (pendingTool === "call_publisher") return;
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.includes("Timed out waiting for visible selector")
      ) {
        throw error;
      }
    }
    await sleep(500);
  }
  throw new Error("Timed out before approving the live Gmail publisher route");
}

async function waitForMarker(ctx: ScenarioContext): Promise<string> {
  const started = Date.now();
  while (Date.now() - started <= 240_000) {
    const dump = (await ctx.client.dumpText("body")) as TextDump;
    const body = textOf(dump);
    const rowTexts = (dump.rows ?? [])
      .map((row) => row.text?.trim())
      .filter((text): text is string => Boolean(text));
    const callIndex = rowTexts.lastIndexOf("call_publisher");
    if (
      callIndex >= 0 &&
      rowTexts.slice(callIndex, callIndex + 8).includes("Failed")
    ) {
      try {
        await ctx.client.click("button:has(.text-red-500)");
      } catch {
        // The failure is still captured below when the card cannot expand.
      }
      await ctx.writeArtifact(
        "failure-call-publisher.json",
        await ctx.client.dumpText("body"),
      );
      throw new Error("The live Gmail call_publisher tool failed");
    }
    if (rowTexts.includes(MARKER)) return body;
    if (
      body.includes("not in the configured endpoint allowlist") ||
      body.includes("LM Studio chat completion HTTP")
    ) {
      throw new Error("The final publisher round surfaced a runtime error");
    }
    await sleep(1_000);
  }
  throw new Error("Timed out waiting for the live Gmail publisher marker");
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const projectPath = path.join(
    ctx.validationHome,
    "projects",
    "lmstudio-gmail-publisher",
  );
  await mkdir(projectPath, { recursive: true });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  try {
    await ctx.client.waitFor("button[aria-label^='SerenBucks balance']", 1_000);
  } catch {
    const email = process.env.SEREN_VALIDATION_AGENT_EMAIL?.trim();
    const password = process.env.SEREN_VALIDATION_AGENT_PASSWORD;
    if (!email || !password) {
      throw new Error("Dedicated validation credentials are required");
    }
    if (email.toLowerCase().endsWith("@serendb.com")) {
      throw new Error("Production-domain identities are prohibited in validation");
    }
    await submitSignIn(ctx.client, email, password);
  }
  await ctx.client.waitFor("button[aria-label^='SerenBucks balance']", 20_000);
  await ctx.client.command({ command: "setRootPath", path: projectPath });

  const liveAgents = (await ctx.client.command({
    command: "readState",
    invokeName: "provider_get_available_agents",
  })) as LiveAgent[];
  if (!Array.isArray(liveAgents)) {
    throw new Error("The native provider runtime did not return an agent list");
  }
  const availableAgentTypes = liveAgents
    .filter(
      (agent): agent is LiveAgent & { type: string } =>
        agent.available === true && typeof agent.type === "string",
    )
    .map((agent) => agent.type);
  const missingPresentation = availableAgentTypes.filter(
    (type) => AGENT_TEST_IDS[type] == null,
  );
  if (missingPresentation.length > 0) {
    throw new Error(
      `The launcher has no presentation mapping for ${missingPresentation.join(", ")}`,
    );
  }

  const inventory = await liveLmsInventory();
  if (inventory.ids.length === 0) {
    throw new Error("The live LM Studio inventory contains no downloaded LLMs");
  }
  const selectedModel = await selectLoadedToolModel(inventory.toolModelIds);

  await ctx.client.click("[data-testid='new-thread-button']");
  for (const type of availableAgentTypes) {
    await ctx.client.waitFor(`[data-testid='${AGENT_TEST_IDS[type]}']`, 10_000);
  }
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
  await openModelMenu(ctx);
  await captureNativeScreen(ctx, "01-live-model-menu-screen.json");
  const modelIndex = inventory.ids.indexOf(selectedModel.modelId);
  if (modelIndex < 0) {
    throw new Error("The loaded tool model is absent from the live model picker");
  }
  await ctx.client.click(
    `[data-testid='agent-model-menu'] > button:nth-of-type(${modelIndex + 1})`,
  );

  const prompt = [
    "Use the live Seren gateway and complete these read-only milestones in order:",
    "1. Call list_agent_publishers with no arguments and confirm gmail exists.",
    "2. Call list_mcp_tools for publisher gmail.",
    `3. Call call_publisher for the currently routed Gmail account with publisher gmail, tool get_messages, and tool_args {\"q\":${JSON.stringify(QUERY)},\"maxResults\":1,\"enriched\":false}.`,
    "If a discovery result was trimmed for local context, you may repeat that read-only discovery call.",
    "Do not call account-identity tools. Do not send, draft, modify, trash, delete, or display mailbox/account data.",
    `Only after get_messages succeeds, reply with exactly ${MARKER}.`,
  ].join("\n");
  await ctx.client.fill(".chat-composer-form textarea", prompt);
  await captureNativeScreen(ctx, "02-read-only-prompt-screen.json");
  await ctx.client.click(".chat-composer-form button[type='submit']");

  await approveRoutingSequence(ctx);
  const completedBody = await waitForMarker(ctx);
  await sleep(1_000);
  await captureNativeScreen(ctx, "06-gmail-publisher-success-screen.json");
  await ctx.writeArtifact(
    "06-gmail-publisher-marker.json",
    await ctx.client.screenshot(".chat-message-content:last-of-type"),
  );
  await ctx.writeArtifact("lmstudio-gmail-publisher-result.json", {
    signedIn: true,
    platform: process.platform,
    liveAgentTypes: availableAgentTypes,
    everyLiveAgentRendered: true,
    liveModelCount: inventory.ids.length,
    liveModelIds: inventory.ids,
    exactModelOrder: true,
    everyLiveModelRendered: true,
    selectedToolModelId: selectedModel.modelId,
    selectedContextLength: selectedModel.contextLength,
    liveAccountRoutingUsed: true,
    livePublisherDiscovery: true,
    liveGmailToolEnumeration: true,
    generatedGmailReadTool: "get_messages",
    liveGmailReadSucceeded: true,
    endpointAllowlistErrorVisible: completedBody.includes(
      "not in the configured endpoint allowlist",
    ),
    markerSeen: completedBody.includes(MARKER),
  });

  if (process.env.SEREN_VALIDATION_HOLD_OPEN === "1") {
    await new Promise<void>(() => {});
  }
}
