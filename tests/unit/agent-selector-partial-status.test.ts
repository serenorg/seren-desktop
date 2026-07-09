// ABOUTME: Guards #2862 against render crashes from partial agent status frames.
// ABOUTME: Paired/direct selectors must tolerate missing arrays during runtime startup.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

describe("agent selector partial-status guards (#2862)", () => {
  const agentEffort = source("src/components/chat/AgentEffortSelector.tsx");
  const pairedEffort = source("src/components/chat/PairedEffortSelector.tsx");
  const agentModel = source("src/components/chat/AgentModelSelector.tsx");
  const pairedModel = source("src/components/chat/PairedModelSelector.tsx");
  const agentFastMode = source("src/components/chat/AgentFastModeSelector.tsx");
  const pairedFastMode = source(
    "src/components/chat/PairedFastModeSelector.tsx",
  );

  it("does not dereference config option arrays directly in effort selectors", () => {
    for (const selector of [agentEffort, pairedEffort]) {
      expect(selector).toContain("const optionValues = () =>");
      expect(selector).toContain("Array.isArray(values) ? values : []");
      expect(selector).toContain("<For each={optionValues()}>");
      expect(selector).not.toContain("opt.options.find");
      expect(selector).not.toContain("option()?.options ?? []");
    }
  });

  it("normalizes model lists before rendering selector menus", () => {
    for (const selector of [agentModel, pairedModel]) {
      expect(selector).toContain("Array.isArray(models) ? models : []");
    }
  });

  it("normalizes availableModels before .find in the fast-mode selector (#2866)", () => {
    // option() runs ungated inside <Show when={option()}> and calls
    // availableModels().find(...), so a non-array availableModels must be
    // normalized to [] rather than dereferenced.
    expect(agentFastMode).toContain("Array.isArray(models) ? models : []");
    expect(agentFastMode).not.toContain(
      "props.session?.availableModels ?? []",
    );
    expect(pairedFastMode).toContain("Array.isArray(models) ? models : []");
  });
});

describe("configOptions non-array guards (#2869)", () => {
  const agentEffort = source("src/components/chat/AgentEffortSelector.tsx");
  const agentFastMode = source("src/components/chat/AgentFastModeSelector.tsx");
  const pairedEffort = source("src/components/chat/PairedEffortSelector.tsx");
  const pairedFastMode = source(
    "src/components/chat/PairedFastModeSelector.tsx",
  );
  const agentStore = source("src/stores/agent.store.ts");

  it("normalizes configOptions before .find in every effort/fast-mode selector", () => {
    // `configOptions?.find(...)` only guards null/undefined; a truthy
    // non-array partial frame reaches `.find` and throws, tripping the
    // workspace-recovery boundary. Each reader must normalize to [] first.
    for (const selector of [
      agentEffort,
      agentFastMode,
      pairedEffort,
      pairedFastMode,
    ]) {
      expect(selector).toContain("Array.isArray(options) ? options : []");
      expect(selector).toContain("configOptions().find");
      expect(selector).not.toContain("configOptions?.find");
    }
  });

  it("only writes array-shaped status list fields into session state", () => {
    // Root cause: handleStatusChange stored whatever the frame carried. The
    // write must be gated on Array.isArray so no reader ever sees a non-array.
    expect(agentStore).toContain("Array.isArray(data?.configOptions)");
    expect(agentStore).toContain("Array.isArray(models.availableModels)");
    expect(agentStore).toContain("Array.isArray(modes.availableModes)");
    // The bare unguarded write-gate must be gone.
    expect(agentStore).not.toContain("if (data?.configOptions) {");
  });

  it("ignores a configOptionsUpdate frame whose configOptions is not an array", () => {
    // incoming.map(...) throws on a non-array before it can even be stored.
    const idx = agentStore.indexOf('case "configOptionsUpdate":');
    expect(idx).toBeGreaterThan(0);
    const body = agentStore.slice(idx, idx + 700);
    expect(body).toContain("if (!Array.isArray(incoming)) break;");
  });
});
