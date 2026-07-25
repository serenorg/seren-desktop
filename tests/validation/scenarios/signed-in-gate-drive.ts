// ABOUTME: Signed-in attempt to drive a real authorization-gate suspension and approval card.
// ABOUTME: Best-effort: captures the approval surface or the agent's response either way.

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

// Any of the approval surfaces the gate can raise: the inline card's
// "Approve for this task" button, the shell/gateway modal's same control, or the
// card container. All share these title/class hooks.
const APPROVAL_SELECTORS = [
  "button[title='Pre-approve matching actions for this task, with limits you set']",
  "[class*='border-warning/40']",
  "button[title='Deny this action; the agent adapts and continues']",
];

export default async function run(ctx: ScenarioContext): Promise<void> {
  const email = process.env.SEREN_VALIDATION_AGENT_EMAIL;
  const password = process.env.SEREN_VALIDATION_AGENT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEREN_VALIDATION_AGENT_EMAIL and SEREN_VALIDATION_AGENT_PASSWORD must be set",
    );
  }

  // The validation home is reused across runs (keyed by port), so a prior run's
  // session may already be signed in. Only drive the sign-in form if the
  // auth-gated balance control is not already present.
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
        20_000,
      ))
    ) {
      throw new Error("Sign-in did not complete");
    }
  }

  // Open a general Seren chat (has tool access signed-in).
  await ctx.client.waitFor("[data-testid='new-thread-button']", 15_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  const sawSerenChat = await present(
    ctx.client,
    "[data-testid='new-seren-chat']",
    10_000,
  );
  if (sawSerenChat) await ctx.client.click("[data-testid='new-seren-chat']");
  await ctx.writeArtifact(
    "after-new-chat.json",
    await ctx.client.dumpText("body"),
  );

  // Send a prompt that should drive a gated tool call (shell = always high-risk).
  const composer = await present(
    ctx.client,
    ".chat-composer-form textarea",
    20_000,
  );
  await ctx.writeArtifact("composer-present.json", { composer });
  if (composer) {
    await ctx.client.fill(
      ".chat-composer-form textarea",
      "Run this shell command with your execute_command tool: echo hello-from-validation",
    );
    await ctx.client.click(".chat-composer-form button[type='submit']");
  }

  // Poll for any approval surface for up to ~2 minutes (agent turn + tool call).
  let approvalSeen = false;
  for (let i = 0; i < 8 && !approvalSeen; i++) {
    for (const selector of APPROVAL_SELECTORS) {
      if (await present(ctx.client, selector, 15_000)) {
        approvalSeen = true;
        break;
      }
    }
  }

  const body = textOf(await ctx.client.dumpText("body"));
  await ctx.writeArtifact("gate-drive-body.json", { text: body });
  await ctx.writeArtifact(
    "gate-drive-screenshot.json",
    await ctx.client.screenshot("body"),
  );
  await ctx.writeArtifact(
    "gate-drive-native-screenshot.json",
    await ctx.client.nativeScreenshot(),
  );

  let leaseEditorShown = false;
  let leaseGranted = false;
  let secondPromptAfterGrant = false;
  let commandOutputSeen = false;
  if (approvalSeen) {
    // Open the "Approve for this task" editor — validates the lease controls
    // (duration / max-calls / spend-cap) render live.
    await ctx.client
      .click(
        "button[title='Pre-approve matching actions for this task, with limits you set']",
      )
      .catch(() => undefined);
    leaseEditorShown = await present(ctx.client, "[class*='bg-accent']", 5_000);
    const editorBody = textOf(await ctx.client.dumpText("body"));
    await ctx.writeArtifact("lease-editor-body.json", { text: editorBody });
    await ctx.writeArtifact(
      "lease-editor-screenshot.json",
      await ctx.client.screenshot("body"),
    );

    // Grant the lease: in DOM order the editor's "Grant & approve" (bg-accent)
    // renders before the "Approve once" (bg-accent) action button.
    await ctx.client.click("[class*='bg-accent']").catch(() => undefined);
    leaseGranted = true;

    // The command line queued TWO identical execute_command calls. Under the
    // granted "echo" lease the second must run silently (no second card). Poll
    // ~90s for the echo output and watch for any re-prompt.
    for (let i = 0; i < 6; i++) {
      const b = textOf(await ctx.client.dumpText("body"));
      if (b.includes("hello-from-validation")) commandOutputSeen = true;
      if (b.includes("Confirm Shell Command")) secondPromptAfterGrant = true;
      // ~15s pace between polls (waitFor on an absent selector is a bounded wait).
      await present(ctx.client, "[data-nonexistent-poll-delay]", 15_000);
    }
    await ctx.writeArtifact(
      "post-grant-body.json",
      await ctx.client.dumpText("body"),
    );
    await ctx.writeArtifact(
      "post-grant-screenshot.json",
      await ctx.client.screenshot("body"),
    );
    await ctx.writeArtifact(
      "post-grant-native-screenshot.json",
      await ctx.client.nativeScreenshot(),
    );
  }

  await ctx.writeArtifact("gate-drive-result.json", {
    signedIn: true,
    serenChatOpened: sawSerenChat,
    composerPresent: composer,
    approvalSurfaceSeen: approvalSeen,
    leaseEditorShown,
    leaseGranted,
    commandOutputSeen,
    secondPromptAfterGrant,
    silentReuseUnderLease: leaseGranted && commandOutputSeen && !secondPromptAfterGrant,
  });
}
