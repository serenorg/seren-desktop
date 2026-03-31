// ABOUTME: E2E tests for agent spawn lifecycle and error surfacing.
// ABOUTME: Verifies that spawn failures produce actionable UI feedback instead of silent hangs.

import { test, expect } from "@playwright/test";

test.describe("Agent Spawn Feedback", () => {
  test("spawn failure surfaces an error in the UI within 30 seconds", async ({
    page,
  }) => {
    const consoleLogs: string[] = [];
    page.on("console", (msg) => consoleLogs.push(msg.text()));

    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);

    // Try to create a new agent thread — this will attempt to spawn Claude
    const newBtn = page.getByTestId("new-thread-button");
    if (!(await newBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await newBtn.click();

    // Look for the Claude Agent option in the launcher
    const claudeOption = page.getByTestId("new-claude-agent");
    if (!(await claudeOption.isVisible({ timeout: 3_000 }).catch(() => false))) {
      // Might be auto-selected or different UI — try Seren Agent
      const serenAgent = page.getByTestId("new-seren-agent");
      if (
        !(await serenAgent.isVisible({ timeout: 2_000 }).catch(() => false))
      ) {
        test.skip();
        return;
      }
      await serenAgent.click();
    } else {
      await claudeOption.click();
    }

    // Wait up to 30 seconds for either:
    // 1. The agent to become ready (authenticated) — session shows "ready" status
    // 2. An error message to appear in the UI (unauthenticated / not installed)
    //
    // The key assertion: we MUST NOT wait indefinitely with no feedback.
    const errorOrReady = await Promise.race([
      // Success: agent chat area becomes interactive
      page
        .locator("[data-testid='agent-chat-input'], [data-testid='chat-textarea']")
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => "ready" as const)
        .catch(() => null),

      // Failure: an error banner or message appears
      page
        .locator("[data-testid='agent-error'], .agent-error, [role='alert']")
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => "error" as const)
        .catch(() => null),

      // Timeout fallback
      page
        .waitForTimeout(30_000)
        .then(() => "timeout" as const),
    ]);

    // Verify diagnostic logging exists — the spawn path must not be a black hole
    const spawnLogs = consoleLogs.filter(
      (l) =>
        l.includes("[AgentStore] Spawning session") ||
        l.includes("[AgentStore] Checking agent availability") ||
        l.includes("[AgentStore] Ensuring CLI") ||
        l.includes("[AgentStore] Spawning agent process") ||
        l.includes("[AgentStore] Spawn result") ||
        l.includes("[AgentStore] Session ready") ||
        l.includes("[AgentStore] Spawn error") ||
        l.includes("[AgentStore] Session terminated"),
    );

    // At minimum, the spawn attempt should produce diagnostic output
    expect(spawnLogs.length).toBeGreaterThan(0);

    // The UI must not silently hang — either ready or error must appear
    expect(errorOrReady).not.toBe("timeout");

    // No JS crashes during the spawn flow
    const crashErrors = errors.filter(
      (e) =>
        e.includes("ReferenceError") ||
        e.includes("Cannot access") ||
        e.includes("before initialization"),
    );
    expect(crashErrors).toEqual([]);
  });
});
