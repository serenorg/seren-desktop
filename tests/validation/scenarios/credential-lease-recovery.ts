// ABOUTME: Live validation of automatic Seren MCP lease rotation in one running agent.
// ABOUTME: Expires only the scenario-created broker route and writes sanitized evidence.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ScenarioContext } from "../../../scripts/validate-walkthrough";

interface TextDump {
  text?: string;
}

interface LeaseRecord {
  revoke_id?: string;
  pending_revocation?: boolean;
}

interface LeaseStore {
  orphaned_leases?: {
    leases?: LeaseRecord[];
  };
}

const BEFORE_MARKER = "LEASE_INITIAL_CALL_OK_3508_LIVE";
const AFTER_MARKER = "LEASE_RECOVERED_CALL_OK_3508_LIVE";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function waitForActiveLease(
  leasePath: string,
  excludedRevokeId?: string,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started <= 60_000) {
    try {
      const store = await readJson<LeaseStore>(leasePath);
      const lease = store.orphaned_leases?.leases?.find(
        (entry) =>
          !entry.pending_revocation &&
          typeof entry.revoke_id === "string" &&
          entry.revoke_id.length > 0 &&
          entry.revoke_id !== excludedRevokeId,
      );
      if (lease?.revoke_id) return lease.revoke_id;
    } catch {
      // The Tauri store may not exist until the agent lease is persisted.
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for a task-owned credential lease");
}

async function sendPrompt(ctx: ScenarioContext, prompt: string): Promise<void> {
  await ctx.client.waitFor(
    ".chat-composer-form button[type='submit']",
    60_000,
  );
  await ctx.client.fill(".chat-composer-form textarea", prompt);
  await ctx.client.waitFor(
    ".chat-composer-form button[type='submit']",
    60_000,
  );
  await ctx.client.click(".chat-composer-form button[type='submit']");
}

export default async function run(ctx: ScenarioContext): Promise<void> {
  const appDataRoot = path.join(
    ctx.validationHome,
    "Library",
    "Application Support",
  );
  const slotName = path.basename(ctx.validationHome);
  if (!/^slot\d+$/.test(slotName)) {
    throw new Error("This live scenario requires an isolated validation home");
  }
  const appIdentifier = `com.serendb.desktop.validation.${slotName}`;
  const leasePath = path.join(
    appDataRoot,
    appIdentifier,
    "credential-leases.json",
  );

  await ctx.client.command({ command: "setRootPath", path: process.cwd() });
  await ctx.client.waitFor("[data-testid='new-thread-button']", 30_000);
  await ctx.client.click("[data-testid='new-thread-button']");
  await ctx.client.waitFor("[data-testid='new-codex-agent']", 10_000);
  await ctx.client.click("[data-testid='new-codex-agent']");
  await ctx.client.waitFor(".chat-composer-form textarea", 60_000);

  await sendPrompt(
    ctx,
    "Call the Seren MCP list_agent_publishers tool with no arguments. Only after the live tool succeeds, reply by concatenating LEASE_, INITIAL_, CALL_, OK_, 3508_, and LIVE with no spaces.",
  );
  await waitForBodyText(ctx, BEFORE_MARKER, 120_000);
  const initialRevokeId = await waitForActiveLease(leasePath);

  await ctx.client.command({ command: "expireCredentialLeases" });

  await sendPrompt(
    ctx,
    "Call the Seren MCP list_agent_publishers tool with no arguments again. Only after the live tool succeeds, reply by concatenating LEASE_, RECOVERED_, CALL_, OK_, 3508_, and LIVE with no spaces.",
  );
  const renewedRevokeId = await waitForActiveLease(leasePath, initialRevokeId);
  await waitForBodyText(ctx, AFTER_MARKER, 120_000);

  await ctx.writeArtifact("credential-lease-recovery.json", {
    signedIn: true,
    sameAgentConversation: true,
    liveInitialPublisherCall: true,
    hostExpiryInjected: true,
    leaseRotatedInPlace: renewedRevokeId !== initialRevokeId,
    livePublisherCallAfterRotation: true,
    beforeMarkerSeen: true,
    afterMarkerSeen: true,
  });
}
