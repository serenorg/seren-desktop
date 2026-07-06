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
});
