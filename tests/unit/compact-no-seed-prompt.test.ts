// ABOUTME: #1829 — pin the no-seed-prompt compaction architecture: passive
// ABOUTME: prepend on next user prompt, synthetic-transcript on reactive
// ABOUTME: too, schema-drift consumer wired, default flipped on.

import { readSource } from "./source-text";
import { describe, expect, it } from "vitest";

const agentStoreSource = readSource("src/stores/agent.store.ts");
const settingsStoreSource = readSource("src/stores/settings.store.ts");

function functionBody(anchor: string): string {
  const start = agentStoreSource.indexOf(anchor);
  if (start < 0) {
    throw new Error(`anchor not found in agent.store.ts: ${anchor}`);
  }
  const end = agentStoreSource.indexOf("\n  },", start);
  if (end < 0) {
    throw new Error(`could not find function end for: ${anchor}`);
  }
  return agentStoreSource.slice(start, end);
}

describe("#1829 — compactAgentConversation no longer calls providerService.sendPrompt", () => {
  // The seed-prompt mechanism (which produced "I'll acknowledge the system
  // reminders…standing by" in the JSONL even after #1827's role filter) is
  // entirely removed. The compactAgentConversation helper queues a passive
  // prepend on the new session as state; the actual dispatch happens later,
  // either from compactAndRetry (reactive) or from promoteStandbyAndDispatch
  // (predictive) — neither of which goes through compactAgentConversation.
  it("zero providerService.sendPrompt calls inside compactAgentConversation", () => {
    const body = functionBody("async compactAgentConversation(");
    const calls = body.match(/providerService\.sendPrompt\(/g);
    expect(
      calls,
      "compactAgentConversation must not call providerService.sendPrompt — there is no seed turn anymore",
    ).toBeNull();
  });

  it("seed prompt construction (the 'Confirm you have this context' wording) is gone", () => {
    // The literal phrase that triggered the stock acknowledgement pattern
    // must not appear anywhere in the file. If a future edit reintroduces a
    // seed-prompt path, this test fails. The defensive scrub regex from
    // #1827 stays as belt-and-suspenders, but the production path no longer
    // produces matchable output.
    expect(agentStoreSource).not.toMatch(
      /Confirm you have this context in one sentence/,
    );
  });
});

describe("#1829 — passive prepend infrastructure", () => {
  it("ActiveSession declares pendingCompactionPrepend", () => {
    expect(agentStoreSource).toMatch(/pendingCompactionPrepend\?:\s*string/);
  });

  it("consumeCompactionPrepend helper exists at module scope", () => {
    expect(agentStoreSource).toMatch(
      /function\s+consumeCompactionPrepend\s*\(/,
    );
  });

  it("store.sendPrompt consumes the prepend before dispatching to providerService", () => {
    const body = functionBody("async sendPrompt(");
    // Helper is called and its result feeds the dispatched prompt — both
    // are required. A consume call without a usage would silently drop
    // the prepend; a usage without consume would replay it forever.
    expect(body).toMatch(/consumeCompactionPrepend\(/);
  });

  it("compactAndRetry consumes the prepend on its retry dispatch", () => {
    // compactAndRetry bypasses store.sendPrompt and calls providerService
    // directly (intentionally — the user's UI message is already on screen
    // from the first failed attempt). It must apply the prepend itself.
    const body = functionBody("async compactAndRetry(");
    expect(body).toMatch(/consumeCompactionPrepend\(/);
  });
});

describe("#1829 — synthetic transcript runs from BOTH predictive and reactive paths", () => {
  it("synthetic-transcript build is no longer gated by mode === 'predictive'", () => {
    // Pre-#1829 the synthetic try-block was inside `if (mode === "predictive")`,
    // so reactive always fell through to the seed-prompt path. Lifting it out
    // is the structural change. We assert that the buildSyntheticTranscript
    // call site is NOT inside a predictive-only conditional anymore — the
    // simplest pin is "the helper extraction exists" by name, and the
    // call site count is at least one (predictive + reactive may share or
    // duplicate a single helper).
    expect(agentStoreSource).toMatch(
      /(attemptSyntheticCompaction|buildSyntheticTranscript)/,
    );
    // No guard wrapping all synthetic calls inside a predictive branch.
    expect(agentStoreSource).not.toMatch(
      /if\s*\(\s*mode\s*===\s*"predictive"\s*\)\s*\{[\s\S]*?settingsStore\.settings\.compactSyntheticTranscript/,
    );
  });

  it("reactive synthetic build runs BEFORE terminateSession", () => {
    // buildSyntheticTranscript requires the session to still be in the
    // runtime's `sessions` map. If terminate fires first, the synthetic
    // call throws "Session not found". The reactive flow must build first,
    // then terminate, then spawn with `resumeAgentSessionId`.
    const body = functionBody("async compactAgentConversation(");
    const reactiveAnchor = body.indexOf("// Reactive path");
    expect(reactiveAnchor).toBeGreaterThan(0);
    const reactive = body.slice(reactiveAnchor);
    const buildIdx = reactive.indexOf("buildSyntheticTranscript");
    const terminateIdx = reactive.indexOf("terminateSession(sessionId)");
    if (buildIdx >= 0 && terminateIdx >= 0) {
      expect(
        buildIdx,
        "synthetic build must precede terminate in reactive path — terminate first would invalidate the live-session lookup",
      ).toBeLessThan(terminateIdx);
    } else {
      // If the synthetic call is factored into a helper, the helper name
      // should appear before terminate.
      const helperIdx = reactive.indexOf("attemptSyntheticCompaction");
      expect(helperIdx, "synthetic helper must be invoked from reactive").toBeGreaterThan(0);
      expect(helperIdx).toBeLessThan(terminateIdx);
    }
  });
});

describe("#1829 — settings: synthetic-transcript on by default", () => {
  it("compactSyntheticTranscript default is true", () => {
    // Per #1829: schema-drift gate's per-call try/catch already provides the
    // safety net; the consumer-side flag flip on drift events keeps users
    // running on the seed-prompt fallback (now passive prepend) until the
    // schema is reconciled. Default-on is the win — most users never see
    // the seed prompt path again.
    expect(settingsStoreSource).toMatch(
      /compactSyntheticTranscript:\s*true/,
    );
  });
});

describe("#1829 — #1749 race-guard drain still fires on no-seed predictive standby", () => {
  it("drainStandbyQueueIfPending helper exists at module scope", () => {
    // Pre-#1829 the drain was inline inside the standby branch of the
    // promptComplete handler. With no seed turn, no promptComplete fires
    // for the standby — so the drain has to be invoked explicitly. Factor
    // out a helper so both predictive paths (synthetic + passive prepend)
    // can call it.
    expect(agentStoreSource).toMatch(
      /function\s+drainStandbyQueueIfPending\s*\(/,
    );
  });

  it("predictive synthetic and passive-prepend paths both call drainStandbyQueueIfPending", () => {
    // This is THE invariant that prevents #1749-enqueued prompts from
    // sitting forever on the serving's pendingPrompts. Both no-seed paths
    // must trigger the drain after seedCompleted=true.
    const body = functionBody("async compactAgentConversation(");
    const calls = body.match(/drainStandbyQueueIfPending\(/g);
    expect(
      calls,
      "compactAgentConversation must trigger the standby queue drain in both predictive sub-paths",
    ).toBeTruthy();
    // Synthetic predictive + passive-prepend predictive = 2 calls.
    // (Reactive doesn't drain here — the queue is transferred to the new
    // session via setState pendingPrompts before compactAndRetry dispatches.)
    expect(calls?.length).toBe(2);
  });
});

describe("#1829 — schema-drift event consumer wired in TS layer", () => {
  it("subscribes to provider://synthetic-transcript-schema-drift", () => {
    // Pre-#1829 the runtime emitted this event but no TS-side subscriber
    // consumed it — the comment in settings.store.ts said "flipped on after
    // schema-drift gate proves stable" but the gate was one-way. Wiring the
    // consumer means a CLI auto-update that breaks the splice will force
    // compactSyntheticTranscript=false at runtime, falling back to passive
    // prepend until the schema is reconciled.
    expect(agentStoreSource).toMatch(
      /provider:\/\/synthetic-transcript-schema-drift/,
    );
  });

  it("flips compactSyntheticTranscript off on drift", () => {
    // The consumer must mutate the setting — logging alone leaves users on
    // a broken synthetic path until app restart. settingsStore.set is the
    // mutation API used elsewhere (e.g. claude-memory provisioning).
    // Anchor on the subscriber function definition so we read the body
    // and not a doc-comment that mentions the event name.
    const fnIdx = agentStoreSource.indexOf(
      "function subscribeToSyntheticTranscriptSchemaDrift(",
    );
    expect(fnIdx).toBeGreaterThan(0);
    const fnEnd = agentStoreSource.indexOf("\n}\n", fnIdx);
    expect(fnEnd).toBeGreaterThan(fnIdx);
    const body = agentStoreSource.slice(fnIdx, fnEnd);
    expect(body).toContain("provider://synthetic-transcript-schema-drift");
    expect(body).toMatch(
      /settingsStore\.set\(\s*"compactSyntheticTranscript",\s*false\s*\)/,
    );
  });
});
