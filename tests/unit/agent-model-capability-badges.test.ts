// ABOUTME: Source-level guard for #2058 — the agent model picker must render
// ABOUTME: read-only capability badges from runtime model flags.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const selectorSource = readFileSync(
  resolve("src/components/chat/AgentModelSelector.tsx"),
  "utf-8",
);
const fastSelectorSource = readFileSync(
  resolve("src/components/chat/AgentFastModeSelector.tsx"),
  "utf-8",
);
const pairedFastSelectorSource = readFileSync(
  resolve("src/components/chat/PairedFastModeSelector.tsx"),
  "utf-8",
);
const chatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("#2058 agent model capability UI", () => {
  it("renders Fast, Auto, and Adaptive badges from model capability flags", () => {
    expect(selectorSource).toContain("capabilityBadges");
    expect(selectorSource).toContain("supportsFastMode");
    expect(selectorSource).toContain("supportsAutoMode");
    expect(selectorSource).toContain("supportsAdaptiveThinking");
    expect(selectorSource).toContain('label: "Fast"');
    expect(selectorSource).toContain('label: "Auto"');
    expect(selectorSource).toContain('label: "Adaptive"');
  });

  it("mounts the fast-mode selector next to the model/mode/effort controls", () => {
    expect(chatSource).toContain("AgentFastModeSelector");
    expect(fastSelectorSource).toContain('id === "fast_mode"');
    expect(fastSelectorSource).toContain("supportsFastMode");
    expect(fastSelectorSource).toMatch(/setConfigOption\(\s*"fast_mode"/);
    expect(chatSource).toContain("PairedFastModeSelector");
    expect(pairedFastSelectorSource).toContain('id === "fast_mode"');
    expect(pairedFastSelectorSource).toContain("supportsFastMode");
    expect(pairedFastSelectorSource).toMatch(
      /setPairedConfigOption\(\s*props\.pairedRole,\s*"fast_mode"/,
    );
  });
});
