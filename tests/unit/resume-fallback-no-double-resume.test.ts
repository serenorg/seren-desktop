// ABOUTME: Regression test for #1656 — resumeAgentConversation must not retry
// ABOUTME: with the same bad --resume session ID after the first spawn fails.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

/**
 * Slice the body of `resumeAgentConversation` so we can grep within it without
 * matching unrelated occurrences elsewhere in the (5000+ line) file. End-of-
 * function is the next `\n  async ` (indent-2 method declaration); brittle
 * only against an indentation refactor of the whole file, which would catch
 * many tests at once.
 */
function extractResumeAgentConversationBody(): string {
  const start = agentStoreSource.indexOf("async resumeAgentConversation(");
  if (start < 0) return "";
  const after = agentStoreSource.indexOf("\n  async ", start + 1);
  return after < 0
    ? agentStoreSource.slice(start)
    : agentStoreSource.slice(start, after);
}

describe("#1656 — resume-fallback drops --resume immediately", () => {
  const body = extractResumeAgentConversationBody();

  it("contains exactly ONE `resumeAgentSessionId:` reference inside the function", () => {
    // The initial spawn at line ~2371 references resumeAgentSessionId. The
    // BUG was a second reference at line ~2394 — the wasted middle attempt
    // that retried with the same bad ID. After the fix, exactly one
    // reference remains.
    expect(body, "function body must be non-empty").not.toBe("");
    const matches = body.match(/resumeAgentSessionId:/g) ?? [];
    expect(
      matches.length,
      "resumeAgentConversation must reference resumeAgentSessionId exactly once (initial spawn). A second reference indicates the wasted middle retry has been reintroduced.",
    ).toBe(1);
  });

  it("first fallback path no longer carries `resumeAgentSessionId`", () => {
    // The fallback that runs after the initial spawn fails MUST NOT pass
    // a resume id. The fix collapses the prior two fallback branches into
    // one fresh-spawn branch.
    expect(body).toContain("Claude resume failed, spawning fresh session");
    // The previous middle-attempt log line is gone.
    expect(body).not.toContain(
      "Resume fallback also failed — spawning without --resume",
    );
  });

  it("fallback uses persisted history seeding (loadPersistedAgentHistory)", () => {
    // Without the resume CLI session, the fresh session must seed from
    // SQLite-persisted history so the user keeps their transcript context.
    expect(body).toContain("loadPersistedAgentHistory(conversationId)");
    expect(body).toContain("persisted.messages.length > 0");
  });
});
