// ABOUTME: Critical guard for #1772 — standby-success drain in promptComplete must
// ABOUTME: pivot via standbySessionId backref, not conversationId (which never matches).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1772 — standby-success drain looks up serving via standbySessionId", () => {
  it("standby branch of promptComplete pivots through standbySessionId, not conversationId", () => {
    // The standby is spawned with conversationId = info.id (its own session
    // id). It only inherits the serving's conversationId during
    // promoteStandbyAndDispatch — AFTER promotion. At seed-completion time
    // the standby's conversationId never matches the serving's, so a
    // conversationId pivot returns zero matches: predictiveCompactInFlight
    // stays stuck and #1749-enqueued prompts strand forever.
    const branchAnchor =
      'if (state.sessions[sessionId]?.role === "standby") {';
    const branchStart = agentStoreSource.indexOf(branchAnchor);
    expect(branchStart, "standby branch must exist").toBeGreaterThan(0);

    // Slice up to the standby branch's break — just before the regular
    // (non-standby) promptComplete handling begins.
    const branchEnd = agentStoreSource.indexOf(
      "// Flush any buffered tool events",
      branchStart,
    );
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branchBody = agentStoreSource.slice(branchStart, branchEnd);

    expect(
      branchBody,
      "lookup must pivot through standbySessionId backref",
    ).toContain("s.standbySessionId === sessionId");
    expect(
      branchBody,
      "the broken conversationId pivot must not return",
    ).not.toContain("s.conversationId === owner.conversationId");
  });

  it("the matched serving session has predictiveCompactInFlight cleared and pendingPrompts drained", () => {
    // Once the serving is found via the standbySessionId backref, the block
    // must (a) clear the in-flight flag and (b) hand the head of the queue
    // to a setTimeout(0)-deferred sendPrompt — same shape as the abort
    // drain (#1769). Synchronous re-entry has caused store-update bugs.
    const branchAnchor =
      'if (state.sessions[sessionId]?.role === "standby") {';
    const branchStart = agentStoreSource.indexOf(branchAnchor);
    const branchEnd = agentStoreSource.indexOf(
      "// Flush any buffered tool events",
      branchStart,
    );
    const branchBody = agentStoreSource.slice(branchStart, branchEnd);

    expect(branchBody).toContain(
      'setState("sessions", sid, "predictiveCompactInFlight", false)',
    );
    expect(branchBody).toMatch(
      /setState\("sessions",\s*drainTarget,\s*"pendingPrompts",\s*remaining\)/,
    );
    expect(branchBody).toContain("setTimeout(");
    expect(branchBody).toContain(
      "this.sendPrompt(\n                  nextPrompt,\n                  undefined,\n                  undefined,\n                  drainTarget,\n                )",
    );
  });
});
