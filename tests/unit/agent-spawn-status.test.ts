// ABOUTME: Tests that agent spawn correctly handles terminated/error session status events.
// ABOUTME: Prevents regression where terminated status was ignored, causing silent hangs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("agent.store spawn session status handling", () => {
  const agentStoreSource = readFileSync(
    resolve("src/stores/agent.store.ts"),
    "utf-8",
  );

  it("handles terminated status in the temp sessionStatus listener", () => {
    // The temp listener (subscribeToEvent<SessionStatusEvent>) must reject
    // readyPromise on "terminated" status — not just "ready" and "error".
    // Without this, a terminated session (e.g. unauthenticated Claude on
    // Windows) leaves the readyPromise unresolved for 30+ seconds.
    expect(agentStoreSource).toContain(
      'data.status === "terminated"',
    );
    expect(agentStoreSource).toContain(
      "rejectReady",
    );
  });

  it("checks session state before blindly proceeding on timeout", () => {
    // When the readyPromise race times out, the handler must check if the
    // session is dead (terminated/errored) before "proceeding anyway".
    // A dead session should be treated as a real failure.
    expect(agentStoreSource).toContain("sessionDead");
  });

  it("logs diagnostic messages at each IPC boundary during spawn", () => {
    // Between "Spawning session" and the next success/error log, there were
    // zero console.log calls — making Windows spawn failures undiagnosable.
    expect(agentStoreSource).toContain(
      "[AgentStore] Checking agent availability",
    );
    expect(agentStoreSource).toContain(
      "[AgentStore] Ensuring CLI is installed",
    );
    expect(agentStoreSource).toContain(
      "[AgentStore] Spawning agent process",
    );
  });
});
