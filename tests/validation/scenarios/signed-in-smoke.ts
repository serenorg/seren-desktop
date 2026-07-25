// ABOUTME: Signs the validation app into a real Gateway account and captures signed-in shell evidence.
// ABOUTME: Credentials are read from env (SEREN_VALIDATION_AGENT_EMAIL/PASSWORD); nothing is hardcoded.

import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface TextDump {
  text?: string;
}

function textOf(value: unknown): string {
  return typeof (value as TextDump)?.text === "string"
    ? ((value as TextDump).text as string)
    : JSON.stringify(value);
}

/**
 * Drives the real SignIn form to a signed-in state via the control client.
 * Login goes to the real Gateway (`api.serendb.com`), so this needs the
 * dedicated validation account. Do not loop retries — a bad password trips the
 * client-side rate limit after 5 attempts.
 */
export async function submitSignIn(
  client: ScenarioContext["client"],
  email: string,
  password: string,
): Promise<void> {
  // Signed-out shell still renders; wait until it is interactive.
  await client.waitFor("[data-testid='new-thread-button']", 30_000);
  // Open the account panel via the titlebar "Sign In" button (no testid; the
  // only visible button whose class contains border-primary/30).
  await client.waitFor("button[class*='border-primary/30']", 10_000);
  await client.click("button[class*='border-primary/30']");
  // The account SlidePanel mounts <SignIn>.
  await client.waitFor("#email", 10_000);
  await client.fill("#email", email);
  await client.fill("#password", password);
  // Scope submit to the SignIn form so a chat composer's submit is never hit.
  await client.click("form:has(#email) button[type='submit']");
}

/** Returns true if the signed-in balance control appears within `timeoutMs`. */
async function waitSignedIn(
  client: ScenarioContext["client"],
  timeoutMs: number,
): Promise<boolean> {
  try {
    await client.waitFor("button[aria-label^='SerenBucks balance']", timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const email = process.env.SEREN_VALIDATION_AGENT_EMAIL;
  const password = process.env.SEREN_VALIDATION_AGENT_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEREN_VALIDATION_AGENT_EMAIL and SEREN_VALIDATION_AGENT_PASSWORD must be set",
    );
  }

  await ctx.writeArtifact(
    "signed-out-shell.json",
    await ctx.client.dumpText("body"),
  );

  await submitSignIn(ctx.client, email, password);
  const signedIn = await waitSignedIn(ctx.client, 20_000);

  // Capture the post-submit state regardless of outcome: on failure the SignIn
  // form shows a destructive error banner; on success the panel closes and the
  // balance control renders.
  const shell = textOf(await ctx.client.dumpText("body"));
  await ctx.writeArtifact("post-submit-shell.json", { text: shell });
  await ctx.writeArtifact(
    "post-submit-screenshot.json",
    await ctx.client.screenshot("body"),
  );
  await ctx.writeArtifact(
    "post-submit-native-screenshot.json",
    await ctx.client.nativeScreenshot(),
  );
  await ctx.writeArtifact("signed-in-result.json", {
    signedIn,
    balanceControlPresent: signedIn,
    signInAffordanceStillVisible: shell.includes("OR SIGN IN WITH EMAIL"),
    account: email,
  });

  if (!signedIn) {
    throw new Error(
      "Sign-in did not complete (balance control absent); see post-submit-shell.json",
    );
  }
}
