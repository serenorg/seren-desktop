// ABOUTME: Coverage for #3441 — the provider-runtime://failed listener. The runtime
// ABOUTME: is gone for good, so sessions drop and in-flight turns surface a retryable error.

import { describe, expect, it } from "vitest";
import {
  PROVIDER_RUNTIME_FAILED_MESSAGE,
  planProviderRuntimeFailure,
} from "@/stores/agent.store";
import { readSource } from "./source-text";

const agentStoreSource = readSource("src/stores/agent.store.ts");
const browserLocalRuntimeSource = readSource("src/lib/browser-local-runtime.ts");

describe("#3441 — planProviderRuntimeFailure store transition", () => {
  it("drops every live session and fails only threads with an in-flight turn", () => {
    const plan = planProviderRuntimeFailure(
      {
        "session-a": { conversationId: "thread-a" },
        "session-b": { conversationId: "thread-b" },
        "session-c": { conversationId: "thread-c" },
      },
      {
        "thread-a": { turnInFlight: true },
        "thread-b": { turnInFlight: false },
        // thread-c has no thread state at all — cold thread, nothing pending.
      },
    );

    expect(plan.droppedSessionIds.sort()).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    expect(plan.failedThreadIds).toEqual(["thread-a"]);
  });

  it("collapses serving+standby sessions of one thread into a single failure", () => {
    const plan = planProviderRuntimeFailure(
      {
        serving: { conversationId: "thread-a" },
        standby: { conversationId: "thread-a" },
      },
      { "thread-a": { turnInFlight: true } },
    );

    expect(plan.droppedSessionIds.sort()).toEqual(["serving", "standby"]);
    expect(plan.failedThreadIds).toEqual(["thread-a"]);
  });

  it("produces an empty plan when no sessions are live", () => {
    expect(planProviderRuntimeFailure({}, {})).toEqual({
      droppedSessionIds: [],
      failedThreadIds: [],
    });
  });

  it("terminal message tells the user what happened and what to do", () => {
    expect(PROVIDER_RUNTIME_FAILED_MESSAGE).toContain("could not be restarted");
    expect(PROVIDER_RUNTIME_FAILED_MESSAGE).toContain("Retry");
    expect(PROVIDER_RUNTIME_FAILED_MESSAGE).toContain("restart Seren");
  });
});

describe("#3441 — provider-runtime://failed listener wiring", () => {
  it("subscribe function exists and is wired from initialize()", () => {
    expect(agentStoreSource).toContain(
      "function subscribeToProviderRuntimeFailed(",
    );
    expect(agentStoreSource).toContain("subscribeToProviderRuntimeFailed()");
  });

  it("handler listens on the Rust event name", () => {
    expect(agentStoreSource).toContain('"provider-runtime://failed"');
  });

  it("handler applies the plan: terminal error, session teardown, lease revoke", () => {
    const idx = agentStoreSource.indexOf(
      "function subscribeToProviderRuntimeFailed(",
    );
    expect(idx).toBeGreaterThan(0);
    const body = agentStoreSource.slice(idx, idx + 3000);
    expect(body).toContain("planProviderRuntimeFailure(");
    expect(body).toContain('"crash_ceiling"');
    expect(body).toContain("PROVIDER_RUNTIME_FAILED_MESSAGE");
    expect(body).toContain("terminatedSessionIds.add(id)");
    expect(body).toContain("delete draft.sessions[id]");
    expect(body).toContain('setState("activeSessionId", null)');
    expect(body).toContain("revokeCredentialLease(id)");
  });

  it("listener is disposed alongside the other runtime side-channels", () => {
    const disposeStart = agentStoreSource.indexOf(
      "function disposeAgentStoreSideChannelListeners()",
    );
    expect(disposeStart).toBeGreaterThan(0);
    const disposeBody = agentStoreSource.slice(disposeStart, disposeStart + 1200);
    expect(disposeBody).toContain("providerRuntimeFailedListener = null;");
    expect(disposeBody).toContain(
      'disposeTauriListener(failedListener, "provider-runtime failed")',
    );
  });

  it("browser-local runtime client invalidates its cached config on failure", () => {
    const idx = browserLocalRuntimeSource.indexOf(
      'listen("provider-runtime://failed"',
    );
    expect(idx).toBeGreaterThan(0);
    const body = browserLocalRuntimeSource.slice(idx, idx + 400);
    expect(body).toContain("disconnectLocalProviderRuntime()");
  });
});
