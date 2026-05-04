// ABOUTME: Regression tests for #1625 — agent sessions must read from and
// ABOUTME: write to Seren memory (same path as chat). Covers spawn bootstrap,
// ABOUTME: per-turn storeAssistantResponse, and post-compaction re-bootstrap.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("#1625 — agent spawnSession bootstraps Seren memory context", () => {
  it("imports bootstrapMemoryContext + storeAssistantResponse from @/services/memory", () => {
    expect(agentStoreSource).toContain(
      'from "@/services/memory"',
    );
    expect(agentStoreSource).toContain("bootstrapMemoryContext");
    expect(agentStoreSource).toContain("storeAssistantResponse");
  });

  it("spawnSession calls bootstrapMemoryContext when memoryEnabled is true", () => {
    const spawnSessionStart = agentStoreSource.indexOf("async spawnSession(");
    expect(spawnSessionStart, "spawnSession must exist").toBeGreaterThan(0);
    // Bound the window to the first 5000 chars of spawnSession so we don't
    // false-match against unrelated occurrences elsewhere in the file.
    const spawnWindow = agentStoreSource.slice(
      spawnSessionStart,
      spawnSessionStart + 5000,
    );
    expect(spawnWindow).toContain("settingsStore.settings.memoryEnabled");
    expect(spawnWindow).toContain("bootstrapMemoryContext()");
  });

  it("spawnSession merges memory context with any caller-supplied bootstrap", () => {
    // Compaction passes no bootstrapPromptContext — without merging, memory
    // would be skipped after compaction spawn. Inverse: resumeAgentConversation
    // DOES pass bootstrapPromptContext — without merging, memory would shadow
    // the caller's replay context.
    expect(agentStoreSource).toContain("finalBootstrapContext");
    // The final context must be what gets attached to the session state.
    expect(agentStoreSource).toContain(
      "bootstrapPromptContext: finalBootstrapContext,",
    );
  });

  it("spawnSession memory bootstrap is best-effort (catches error)", () => {
    // A memory service outage must not block spawn.
    const spawnSessionStart = agentStoreSource.indexOf("async spawnSession(");
    const spawnWindow = agentStoreSource.slice(
      spawnSessionStart,
      spawnSessionStart + 5000,
    );
    expect(spawnWindow).toContain("memory bootstrap failed (non-fatal)");
  });
});

describe("#1625 — finalizeStreamingContent writes assistant turns to memory", () => {
  it("finalizeStreamingContent accepts an isReplay option", () => {
    // Replay emissions must NOT re-write to memory; only live turns write.
    expect(agentStoreSource).toContain(
      "finalizeStreamingContent(sessionId: string, opts?: { isReplay?: boolean })",
    );
    expect(agentStoreSource).toContain("const isReplay = opts?.isReplay");
  });

  it("non-replay path calls storeAssistantResponse with the agent tag", () => {
    // The ONLY acceptable call of storeAssistantResponse in this file is the
    // one gated on !isReplay + memoryEnabled + non-empty + !auth-error.
    expect(agentStoreSource).toContain("!isReplay &&");
    expect(agentStoreSource).toContain("storeAssistantResponse(");
    expect(agentStoreSource).toContain("agent:${session.info.agentType}");
  });

  it("caller passes isHistoryReplay flag into finalizeStreamingContent", () => {
    // The promptComplete handler knows whether this is a replay; the helper
    // does not, so the caller must propagate the flag — otherwise every
    // replayed session flood-writes duplicates to cloud memory.
    expect(agentStoreSource).toContain(
      "this.finalizeStreamingContent(sessionId, { isReplay: isHistoryReplay })",
    );
  });
});

describe("#1625 — post-compaction re-bootstrap (via spawnSession)", () => {
  it("compactAgentConversation reuses spawnSession, so memory re-bootstraps automatically", () => {
    // compactAgentConversation calls this.spawnSession(...) to create the
    // new session after compaction. Because memory bootstrap now lives
    // inside spawnSession, the new post-compaction session automatically
    // pulls fresh memory — no separate wiring needed. Guard against a
    // regression that moves the bootstrap into a caller-specific path.
    const compactFnStart = agentStoreSource.indexOf(
      "async compactAgentConversation(",
    );
    expect(compactFnStart, "compactAgentConversation must exist").toBeGreaterThan(
      0,
    );
    // Slice to the next function so growth in compactAgentConversation
    // doesn't push the spawnSession call past a fixed window.
    const compactFnEnd = agentStoreSource.indexOf(
      "async compactAndRetry(",
      compactFnStart,
    );
    expect(compactFnEnd, "compactAndRetry must exist").toBeGreaterThan(
      compactFnStart,
    );
    const compactBody = agentStoreSource.slice(compactFnStart, compactFnEnd);
    expect(compactBody).toContain("await this.spawnSession(");
  });
});
