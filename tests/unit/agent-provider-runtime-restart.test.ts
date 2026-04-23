// ABOUTME: Source-level regression tests for #1631 — cross-thread provider-runtime
// ABOUTME: crash handling. The restart listener invalidates every serving pointer
// ABOUTME: and auto-re-dispatches threads with `turnInFlight === true`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1631 — provider-runtime://restarted cross-thread handling", () => {
  it("subscribe function exists and is wired from initialize()", () => {
    expect(agentStoreSource).toContain(
      "function subscribeToProviderRuntimeRestarted(",
    );
    expect(agentStoreSource).toContain("subscribeToProviderRuntimeRestarted()");
  });

  it("handler listens on the Rust event name", () => {
    expect(agentStoreSource).toContain('"provider-runtime://restarted"');
  });

  it("handler clears every session and the active pointer", () => {
    // The restart listener deletes all live sessions (they belong to the
    // dead subprocess) and nulls out activeSessionId.
    const idx = agentStoreSource.indexOf(
      "function subscribeToProviderRuntimeRestarted(",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 3500);
    expect(body).toContain("delete draft.sessions[id]");
    expect(body).toContain('setState("activeSessionId", null)');
  });

  it("handler branches on turnInFlight and re-dispatches lastPromptText", () => {
    const idx = agentStoreSource.indexOf(
      "function subscribeToProviderRuntimeRestarted(",
    );
    const body = agentStoreSource.slice(idx, idx + 3500);
    expect(body).toContain("ts?.turnInFlight");
    expect(body).toContain("ts.lastPromptText");
    expect(body).toContain("agentStore.sendPrompt(");
  });

  it("re-dispatch arms the 60s crash budget with crash_ceiling classification", () => {
    const idx = agentStoreSource.indexOf(
      "function subscribeToProviderRuntimeRestarted(",
    );
    const body = agentStoreSource.slice(idx, idx + 3500);
    expect(body).toContain("BUDGET_CRASH_MS");
    expect(body).toContain('"crash_ceiling"');
  });
});
