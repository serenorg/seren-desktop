// ABOUTME: Source-level guards for memory recall, error learning, and consolidation wiring.
// ABOUTME: Verifies all authenticated prompt and startup integration points remain connected.

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

  it("consolidates memories after authenticated sync", () => {
    expect(readSource("src/App.tsx")).toContain("consolidateMemories");
  });
});
