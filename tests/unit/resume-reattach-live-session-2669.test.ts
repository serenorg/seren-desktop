// ABOUTME: Regression test for #2669 — resumeAgentConversation must re-attach to
// ABOUTME: a live runtime session before reaping it, so in-flight background subagents survive.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

/**
 * Slice an indent-2 `async <name>(` method body out of the (7000+ line)
 * agent.store.ts so greps don't match unrelated occurrences elsewhere. The
 * body ends at the next indent-2 method declaration (`\n  async ` / `\n  <id>(`).
 */
function extractMethodBody(name: string): string {
  const start = agentStoreSource.indexOf(`async ${name}(`);
  if (start < 0) return "";
  const rest = agentStoreSource.slice(start + 1);
  const nextAsync = rest.indexOf("\n  async ");
  return nextAsync < 0 ? agentStoreSource.slice(start) : rest.slice(0, nextAsync);
}

describe("#2669 — resume re-attaches to a live session instead of reaping it", () => {
  const resumeBody = extractMethodBody("resumeAgentConversation");
  const reattachBody = extractMethodBody("reattachLiveSession");

  it("resumeAgentConversation attempts re-attach BEFORE the pre-emptive terminate", () => {
    expect(resumeBody, "resume body must be non-empty").not.toBe("");

    const reattachAt = resumeBody.indexOf("reattachLiveSession(conversationId)");
    const terminateAt = resumeBody.indexOf(
      "providerService.terminateSession(conversationId)",
    );

    expect(reattachAt, "resume must call reattachLiveSession").toBeGreaterThan(
      -1,
    );
    expect(terminateAt, "resume still has the pre-emptive terminate").toBeGreaterThan(
      -1,
    );
    expect(
      reattachAt,
      "re-attach must be attempted before the pre-emptive terminate so a live session is never reaped",
    ).toBeLessThan(terminateAt);
  });

  it("a successful re-attach short-circuits resume (no terminate, no respawn)", () => {
    // The early return on `reattached` must sit between the re-attach call and
    // the terminate, so the reap is skipped entirely when adoption succeeds.
    expect(resumeBody).toMatch(/if \(reattached\)[\s\S]*return conversationId;/);
  });

  it("reattachLiveSession queries the runtime and never reaps", () => {
    expect(reattachBody, "reattachLiveSession must exist").not.toBe("");
    // It asks the runtime which sessions are live...
    expect(reattachBody).toContain("providerService.listSessions()");
    // ...adopts one into the store...
    expect(reattachBody).toContain('setState("sessions", conversationId');
    // ...and NEVER terminates: adopting a live tree is the whole point.
    expect(
      reattachBody.includes("terminateSession"),
      "reattachLiveSession must never call terminateSession — that would reap the live background work it exists to preserve",
    ).toBe(false);
  });

  it("reattach bails out for a dead session so the caller can respawn", () => {
    // A terminated/errored backend session is not adoptable — fall back to the
    // normal teardown+respawn path by returning false.
    expect(reattachBody).toContain('liveInfo.status === "terminated"');
    expect(reattachBody).toContain('liveInfo.status === "error"');
    expect(reattachBody).toContain("return false");
  });
});
