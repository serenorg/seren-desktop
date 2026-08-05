// ABOUTME: Live signed-in release verification for #3683 (picker = live catalog)
// ABOUTME: and #3704/#3688 (validator guard directions) against the real Gateway.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";
import { submitSignIn } from "./signed-in-smoke";

interface TextDump {
  text?: string;
}

const PICKER_DROPDOWN_SELECTOR = "div[class*='min-w-[320px]']";
const MODEL_LIST_SELECTOR = `${PICKER_DROPDOWN_SELECTOR} div[class*='overflow-y-auto']`;
const MODEL_ROW_SELECTOR = `${MODEL_LIST_SELECTOR} button`;
const PICKER_TRIGGER_SELECTOR =
  ".chat-composer-form button[class*='bg-popover']";
const MARKER = "[unverified]";
const OUTAGE_REWRITE = "I could not verify that the service is unavailable.";
const SELF_DESCRIPTION =
  "I don't have direct introspective access to my exact model identifier.";
const GUARDED_CLAIM = "I cannot access your Gmail account.";

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
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

async function pause(
  client: ScenarioContext["client"],
  ms: number,
): Promise<void> {
  await present(client, "[data-nonexistent-poll-delay]", ms);
}

async function bodyText(ctx: ScenarioContext): Promise<string> {
  return textOf(await ctx.client.dumpText("body"));
}

async function waitForReplyAfter(
  ctx: ScenarioContext,
  afterAnchor: string,
  maxPolls = 36,
): Promise<string> {
  let previous = "";
  let stable = 0;
  for (let i = 0; i < maxPolls; i++) {
    await pause(ctx.client, 5_000);
    const body = await bodyText(ctx);
    const anchorIndex = body.lastIndexOf(afterAnchor);
    const region = anchorIndex >= 0 ? body.slice(anchorIndex) : "";
    if (region.length > afterAnchor.length + 10 && region === previous) {
      stable += 1;
      if (stable >= 2) return region;
    } else {
      stable = 0;
    }
    previous = region;
  }
  return previous;
}

async function sendPrompt(
  ctx: ScenarioContext,
  prompt: string,
  anchor: string,
): Promise<string> {
  await ctx.client.fill(".chat-composer-form textarea", prompt);
  await ctx.client.click(".chat-composer-form button[type='submit']");
  return waitForReplyAfter(ctx, anchor);
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  // 1. Signed-in shell (reuse persisted session or drive the real form).
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  const alreadySignedIn = await present(
    ctx.client,
    "button[aria-label^='SerenBucks balance']",
    10_000,
  );
  if (!alreadySignedIn) {
    const email = process.env.SEREN_VALIDATION_AGENT_EMAIL;
    const password = process.env.SEREN_VALIDATION_AGENT_PASSWORD;
    if (!email || !password) {
      throw new Error(
        "No persisted session and SEREN_VALIDATION_AGENT_EMAIL/PASSWORD are unset",
      );
    }
    await submitSignIn(ctx.client, email, password);
    if (
      !(await present(
        ctx.client,
        "button[aria-label^='SerenBucks balance']",
        20_000,
      ))
    ) {
      throw new Error("Sign-in did not complete");
    }
  }

  // 2. New Seren Agent thread.
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-seren-chat']", 10_000);
  await ctx.client.click("[data-testid='new-seren-chat']");
  await ctx.client.waitFor(".chat-composer-form textarea", 20_000);

  // 3. #3683 completeness: the rendered Seren list must equal the live
  //    publisher catalog, both with and WITHOUT a search query.
  await ctx.client.waitFor(PICKER_TRIGGER_SELECTOR, 10_000);
  await ctx.client.click(PICKER_TRIGGER_SELECTOR);
  await ctx.client.waitFor("input[placeholder='Search models']", 10_000);
  await pause(ctx.client, 3_000);
  const emptyQueryList = textOf(await ctx.client.dumpText(MODEL_LIST_SELECTOR));
  await ctx.writeArtifact("01-picker-empty-query.json", {
    renderedList: emptyQueryList,
  });
  await ctx.writeArtifact(
    "01-picker-screenshot.json",
    await ctx.client.screenshot("body"),
  );

  // Search that previously expanded into the OpenRouter catalog (#3683 repro
  // used a DeepSeek alias). The filtered list must stay inside the live set.
  await ctx.client.fill("input[placeholder='Search models']", "DeepSeek");
  await pause(ctx.client, 1_500);
  const deepseekQueryList = textOf(
    await ctx.client.dumpText(MODEL_LIST_SELECTOR),
  );
  await ctx.writeArtifact("02-picker-deepseek-query.json", {
    renderedList: deepseekQueryList,
  });
  await ctx.writeArtifact(
    "02-picker-deepseek-screenshot.json",
    await ctx.client.screenshot("body"),
  );
  if (/latest|~/.test(deepseekQueryList)) {
    throw new Error(
      `Search still surfaces alias IDs outside the live catalog: ${deepseekQueryList}`,
    );
  }

  // 4. Select GLM 5.2 (advertised) and prove the routing works end-to-end.
  await ctx.client.fill("input[placeholder='Search models']", "GLM 5.2");
  await pause(ctx.client, 1_500);
  await ctx.client.click(MODEL_ROW_SELECTOR);
  await pause(ctx.client, 1_000);
  const trigger = textOf(await ctx.client.dumpText(PICKER_TRIGGER_SELECTOR));
  if (!/GLM 5\.2/i.test(trigger)) {
    throw new Error(`Model selection did not commit GLM 5.2: ${trigger}`);
  }

  // 5. Validator guard, both directions, via deterministic echo prompts
  //    through the REAL model + validation pipeline:
  //    (a) self-description must render untouched (#3687/#3688);
  const selfRegion = await sendPrompt(
    ctx,
    `Reply with exactly this sentence and nothing else: ${SELF_DESCRIPTION}`,
    "Reply with exactly this sentence",
  );
  await ctx.writeArtifact("03-self-description-region.json", {
    text: selfRegion,
  });
  await ctx.writeArtifact(
    "03-self-description-native.json",
    await ctx.client.nativeScreenshot(),
  );
  const selfAssistant = selfRegion.slice(
    selfRegion.indexOf(SELF_DESCRIPTION) + SELF_DESCRIPTION.length,
  );
  const selfUntouched =
    selfAssistant.includes(SELF_DESCRIPTION) && !selfAssistant.includes(MARKER);

  //    (b) a named-service access denial must be rewritten (#3704) because no
  //    verification evidence exists in this thread.
  const guardRegion = await sendPrompt(
    ctx,
    `Now reply with exactly this sentence and nothing else: ${GUARDED_CLAIM}`,
    "Now reply with exactly this sentence",
  );
  await ctx.writeArtifact("04-guarded-claim-region.json", { text: guardRegion });
  await ctx.writeArtifact(
    "04-guarded-claim-native.json",
    await ctx.client.nativeScreenshot(),
  );
  const guardAssistant = guardRegion.slice(
    guardRegion.indexOf(GUARDED_CLAIM) + GUARDED_CLAIM.length,
  );
  const guardRewritten =
    guardAssistant.includes(MARKER) && guardAssistant.includes(OUTAGE_REWRITE);

  const result = {
    reusedSession: alreadySignedIn,
    modelCommitted: trigger,
    selfDescriptionUntouched: selfUntouched,
    guardedClaimRewritten: guardRewritten,
  };
  await ctx.writeArtifact("05-assertions.json", result);

  if (!selfUntouched || !guardRewritten) {
    throw new Error(`Validator guard verification failed: ${JSON.stringify(result)}`);
  }
}
