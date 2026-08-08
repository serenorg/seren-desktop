// ABOUTME: Signed-in live walkthrough for the Planner + Runner paired agent (#3748).
// ABOUTME: Verifies launcher placement, role enumeration, a hosted pairing end-to-end, and claude-codex regression.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";
import { submitSignIn } from "./signed-in-smoke";

interface TextDump {
  text?: string;
}

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function present(
  client: ScenarioContext["client"],
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await client.waitFor(selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Approve any pending action card so the paired turn can proceed hands-free. */
async function approveIfPrompted(
  client: ScenarioContext["client"],
): Promise<boolean> {
  const approveSelectors = [
    "button[title='Pre-approve matching actions for this task, with limits you set']",
    "button[data-testid='action-approve']",
  ];
  for (const selector of approveSelectors) {
    if (await present(client, selector, 500)) {
      await client.click(selector);
      return true;
    }
  }
  return false;
}

async function waitForBodyText(
  ctx: ScenarioContext,
  needle: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = textOf(await ctx.client.dumpText("body"));
    if (body.includes(needle)) return;
    await approveIfPrompted(ctx.client);
    await sleep(2_000);
  }
  await ctx.writeArtifact(
    `${label}-timeout-screenshot.json`,
    await ctx.client.screenshot("body"),
  );
  throw new Error(`Timed out waiting for "${needle}" during ${label}`);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const email = process.env.SEREN_VALIDATION_AGENT_EMAIL;
  const password = process.env.SEREN_VALIDATION_AGENT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEREN_VALIDATION_AGENT_EMAIL and SEREN_VALIDATION_AGENT_PASSWORD must be set",
    );
  }
  const projectDir = process.env.SEREN_WALKTHROUGH_PROJECT_DIR;
  if (!projectDir || !existsSync(projectDir)) {
    throw new Error("SEREN_WALKTHROUGH_PROJECT_DIR must point at a scratch repo");
  }

  // --- Stage 0: sign in as the validation user -----------------------------
  const alreadySignedIn = await present(
    ctx.client,
    "button[aria-label^='SerenBucks balance']",
    8_000,
  );
  if (!alreadySignedIn) {
    await submitSignIn(ctx.client, email, password);
    if (
      !(await present(
        ctx.client,
        "button[aria-label^='SerenBucks balance']",
        30_000,
      ))
    ) {
      await ctx.writeArtifact(
        "00-signin-failure-screenshot.json",
        await ctx.client.screenshot("body"),
      );
      await ctx.writeArtifact(
        "00-signin-failure-text.json",
        await ctx.client.dumpText("body"),
      );
      throw new Error("Sign-in did not complete");
    }
  }
  await ctx.client.command({ command: "setRootPath", path: projectDir });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);

  // --- Stage 1: launcher placement — directly below Claude + Codex ---------
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-planner-runner-agent']", 10_000);
  await ctx.writeArtifact(
    "01-launcher-menu.json",
    await ctx.client.screenshot("body"),
  );
  const menuText = textOf(await ctx.client.dumpText("body"));
  const codexIdx = menuText.indexOf("Claude + Codex");
  const prIdx = menuText.indexOf("Planner + Runner");
  if (codexIdx < 0 || prIdx < 0 || prIdx < codexIdx) {
    throw new Error(
      `Launcher order wrong: Claude + Codex at ${codexIdx}, Planner + Runner at ${prIdx}`,
    );
  }
  await ctx.writeArtifact("01-launcher-menu-text.json", { menuText });

  // --- Stage 2: launch — default pairing is Claude + Codex -----------------
  await ctx.client.click("[data-testid='new-planner-runner-agent']");
  await ctx.client.waitFor("[data-testid='paired-thread-header']", 120_000);
  await ctx.client.waitFor(".chat-composer-form textarea", 120_000);
  await waitForBodyText(ctx, "Claude is planner and reviewer", 120_000, "stage2");
  await ctx.client.waitFor(
    "[data-testid='paired-agent-selector-planner']",
    30_000,
  );
  await ctx.writeArtifact(
    "02-default-pairing.json",
    await ctx.client.screenshot("body"),
  );

  // --- Stage 3: completeness — the planner dropdown lists the live set -----
  await ctx.client.click("[data-testid='paired-agent-selector-planner']");
  await sleep(700);
  await ctx.writeArtifact(
    "03-planner-agent-menu.json",
    await ctx.client.screenshot("body"),
  );
  const dropdownText = textOf(await ctx.client.dumpText("body"));
  const expectedAgents = [
    "Claude Code",
    "Codex",
    "Antigravity",
    "Grok",
    "LM Studio",
    "Seren Agent",
    "Seren Private Models",
  ];
  const missing = expectedAgents.filter((name) => !dropdownText.includes(name));
  await ctx.writeArtifact("03-planner-agent-menu-text.json", {
    expectedAgents,
    missing,
  });
  if (missing.length > 0) {
    throw new Error(`Planner agent menu missing: ${missing.join(", ")}`);
  }

  // --- Stage 4: hosted pairing — Seren plans, Codex runs -------------------
  await ctx.client.click(
    "[data-testid='paired-agent-option-planner-seren']",
  );
  await waitForBodyText(ctx, "Seren is planner and reviewer", 120_000, "stage4-swap");
  await ctx.writeArtifact(
    "04-hosted-pairing-declaration.json",
    await ctx.client.screenshot("body"),
  );

  const marker = `pr-walkthrough-${Date.now()}`;
  await ctx.client.fill(
    ".chat-composer-form textarea",
    `Create a file named hello.txt in the project root containing exactly "${marker}" and nothing else, then confirm it exists.`,
  );
  await ctx.client.click(".chat-composer-form button[type='submit']");

  await waitForBodyText(ctx, "handed off to Codex", 420_000, "stage4-handoff");
  await ctx.writeArtifact(
    "05-handoff.json",
    await ctx.client.screenshot("body"),
  );
  await waitForBodyText(ctx, "handed back to Seren", 600_000, "stage4-review");
  await ctx.writeArtifact(
    "06-review-complete.json",
    await ctx.client.screenshot("body"),
  );

  const helloPath = path.join(projectDir, "hello.txt");
  const helloContents = existsSync(helloPath)
    ? readFileSync(helloPath, "utf8").trim()
    : null;
  await ctx.writeArtifact("07-real-artifact.json", {
    helloPath,
    helloContents,
    marker,
    matches: helloContents === marker,
  });
  if (helloContents !== marker) {
    throw new Error(
      `Runner did not produce the real artifact: ${helloPath} => ${JSON.stringify(helloContents)}`,
    );
  }

  // --- Stage 5: regression — Claude + Codex unchanged, no agent pills ------
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-claude-codex-agent']", 10_000);
  await ctx.client.click("[data-testid='new-claude-codex-agent']");
  await ctx.client.waitFor("[data-testid='paired-thread-header']", 120_000);
  await waitForBodyText(ctx, "Claude is planner and reviewer", 120_000, "stage5");
  const regressionBody = textOf(await ctx.client.dumpText("body"));
  const hasAgentPills = regressionBody.includes("Planner · Claude Code");
  await ctx.writeArtifact("08-claude-codex-regression.json", {
    declarationUnchanged: regressionBody.includes(
      "Codex is executor for code edits, commands, and tests",
    ),
    agentPillsAbsent: !hasAgentPills,
  });
  await ctx.writeArtifact(
    "08-claude-codex-regression-screenshot.json",
    await ctx.client.screenshot("body"),
  );
  if (hasAgentPills) {
    throw new Error("claude-codex thread must not offer role-agent pills");
  }
}
