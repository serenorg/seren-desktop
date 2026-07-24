// ABOUTME: Source-level guards for memory recall and error-learning wiring.
// ABOUTME: Verifies prompt integrations remain connected and lifecycle jobs stay server-owned.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readSource = (path: string) => readFileSync(resolve(path), "utf-8");

describe("memory recall wiring", () => {
  it("injects recall into the orchestrator and chat paths", () => {
    expect(readSource("src/services/orchestrator.ts")).toContain(
      "recallMemoryContext(",
    );
    const chatSource = readSource("src/services/chat.ts");
    expect(chatSource).toContain("recallMemoryContext(");
    expect(chatSource).toContain("learnFromErrorMemory(");
  });

  it("injects recall into agent prompt context", () => {
    const source = readSource("src/stores/agent.store.ts");
    const start = source.indexOf("async buildPromptContext(");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 5000)).toContain(
      "recallMemoryContext(",
    );
  });

  it("gates every memory injection point on the conversation privacy flags", () => {
    // isMemoryExcluded covers both the per-conversation opt-out and Privileged
    // Matter Mode. A path that recalls without checking it replays memories
    // from other conversations into a thread the operator walled off.
    for (const path of [
      "src/services/chat.ts",
      "src/services/orchestrator.ts",
      "src/stores/agent.store.ts",
    ]) {
      expect(readSource(path), path).toContain(
        "privacyStore.isMemoryExcluded(",
      );
    }
  });

  it("leaves memory consolidation and synchronization server-owned", () => {
    const memorySource = readSource("src/services/memory.ts");
    const appSource = readSource("src/App.tsx");
    expect(memorySource).not.toContain("MEMORY_SYNC_INTERVAL_MS");
    expect(memorySource).not.toContain("consolidateJob(");
    expect(memorySource).not.toContain("syncStatus(");
    expect(appSource).not.toContain("startMemorySyncLoop");
  });
});
