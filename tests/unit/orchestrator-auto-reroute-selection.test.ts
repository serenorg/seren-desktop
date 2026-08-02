// ABOUTME: Critical regression coverage for Auto-mode reroute selection.
// ABOUTME: Protects Auto threads from being pinned to a fallback model.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3602 Auto reroute keeps the thread on Auto", () => {
  it("gates picker mirrors and persisted selection on the routing mode", () => {
    const source = readSource("src/services/orchestrator.ts");

    // An automatic fallback must not rewrite an Auto thread's persisted
    // selection or the visible picker — Auto re-routes on the next task.
    expect(source).toContain(
      "(reroutedConv?.selectedModel ?? providerStore.activeModel) ===",
    );
    expect(source).toContain("if (!threadIsAuto) {");
  });

  it("still labels the current attempt with the concrete fallback model", () => {
    const source = readSource("src/services/orchestrator.ts");

    // The streaming state carries the model actually serving this attempt,
    // so the runtime row shows the fallback without changing routing mode.
    expect(source).toContain("modelId: event.to_model,");
  });
});
