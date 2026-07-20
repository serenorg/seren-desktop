// ABOUTME: Regression test for #2313 — per-session force-kill wiring: runtime
// ABOUTME: emits the child PID, and abortTurn escalates to provider_force_kill_session.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const providersSource = readFileSync(
  resolve("src/services/providers.ts"),
  "utf-8",
);
const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#2313 — runtime spawn response carries the agent child PID", () => {
  it("each provider's spawn return includes pid from session.process", () => {
    // The frontend can only force-kill a session if it knows the child PID.
    for (const file of [
      "bin/browser-local/claude-runtime.mjs",
      "bin/browser-local/providers.mjs",
      "bin/browser-local/acp-runtime.mjs",
    ]) {
      const src = readFileSync(resolve(file), "utf-8");
      expect(src, `${file} must report the child pid`).toContain(
        "pid: session.process?.pid",
      );
    }
    // Sanity: the claude spawn return (not just a comment) carries it.
    expect(claudeRuntimeSource).toContain("pid: session.process?.pid ?? null");
  });
});

describe("#2313 — forceKillSession service is native-guarded and invokes the command", () => {
  const start = providersSource.indexOf("export async function forceKillSession");
  const body = providersSource.slice(start, start + 400);

  it("exists and is exported", () => {
    expect(start, "forceKillSession must be exported").toBeGreaterThan(0);
  });

  it("no-ops outside the native runtime and invokes provider_force_kill_session", () => {
    // Browser-local mode has no Rust core — guard so invoke() never runs there.
    expect(body).toContain("isTauriRuntime()");
    expect(body).toContain('invoke<boolean>("provider_force_kill_session"');
  });
});

describe("#2313 — abortTurn escalates to force-kill when the runtime is unreachable", () => {
  const start = agentStoreSource.indexOf(
    "async abortTurn(threadId: string): Promise<void> {",
  );
  const end = agentStoreSource.indexOf("focusProjectSession(", start);
  const body = agentStoreSource.slice(start, end > start ? end : start + 3000);

  it("calls forceKillSession only inside the unreachable-runtime branch", () => {
    // The force-kill lives after the timeout/disconnect guard, so a healthy
    // socket (logical cancel error) does not trigger a process kill.
    const guardIdx = body.indexOf("disconnectLocalProviderRuntime()");
    const killIdx = body.indexOf("forceKillSession(");
    expect(guardIdx, "disconnect guard must exist").toBeGreaterThan(0);
    expect(killIdx, "abortTurn must escalate to forceKillSession").toBeGreaterThan(
      guardIdx,
    );
    // It targets the session's reported PID.
    expect(body).toContain("session.info.pid");
  });
});
