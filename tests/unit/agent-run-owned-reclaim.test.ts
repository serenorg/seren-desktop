// ABOUTME: Verifies run-owned Claude sessions are fenced from idle reclaim.
// ABOUTME: Confirms releasing run ownership restores the normal reclaim candidate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _getIdleClaudeSessionIds,
  agentStore,
  type ActiveSession,
} from "@/stores/agent.store";
import { setState, state } from "@/lib/agent/runtime";

function session(createdAt: string): ActiveSession {
  return {
    info: {
      agentType: "claude-code",
      status: "ready",
      createdAt,
    },
    role: "serving",
    conversationId: "",
  } as unknown as ActiveSession;
}

describe("run-owned Claude session reclaim", () => {
  beforeEach(() => {
    setState("sessions", {
      owned: session("2026-07-31T00:00:00.000Z"),
      free: session("2026-07-31T00:01:00.000Z"),
    });
    setState("activeSessionId", null);
  });

  afterEach(() => {
    setState("sessions", {});
    setState("activeSessionId", null);
  });

  it("excludes a run-owned ready session while retaining an unowned candidate", () => {
    agentStore.markSessionRunOwned("owned", "run-123");

    expect(state.sessions.owned.ownedByRunId).toBe("run-123");
    expect(_getIdleClaudeSessionIds()).toEqual(["free"]);
  });

  it("releaseSessionRunOwnership makes the session reclaimable again", () => {
    agentStore.markSessionRunOwned("owned", "run-123");
    agentStore.releaseSessionRunOwnership("owned");

    expect(state.sessions.owned.ownedByRunId).toBeUndefined();
    expect(_getIdleClaudeSessionIds()).toEqual(["owned", "free"]);
  });

  it("does not mutate state when ownership targets a missing session", () => {
    agentStore.markSessionRunOwned("missing", "run-123");
    agentStore.releaseSessionRunOwnership("missing");

    expect(Object.keys(state.sessions)).toEqual(["owned", "free"]);
  });
});
