// ABOUTME: Critical regression guards for #1480 — Gemini Agent bottom controls.
// ABOUTME: Three load-bearing assertions only, each guarding a specific footgun.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentChatTsx = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);
const geminiRuntimeMjs = readFileSync(
  resolve("bin/browser-local/gemini-runtime.mjs"),
  "utf-8",
);

describe("Gemini Agent #1480 — bottom-control regression guards", () => {
  it("lockedAgentType filter accepts gemini (not just codex/claude-code)", () => {
    // The filter at line 272/276 was: `=== "codex" || === "claude-code"`,
    // which silently dropped gemini and returned the default selectedAgentType.
    // The filter must include gemini in BOTH places (threadType and sessionAgent).
    const lockedAgentTypeIdx = agentChatTsx.indexOf(
      "const lockedAgentType =",
    );
    expect(lockedAgentTypeIdx).toBeGreaterThan(-1);
    // Find the closing of this createMemo block.
    const memoBlock = agentChatTsx.slice(lockedAgentTypeIdx, lockedAgentTypeIdx + 800);
    // Two distinct includes of "gemini" — one for threadType, one for sessionAgent.
    const matches = memoBlock.match(/threadType === "gemini"|sessionAgent === "gemini"/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("lockedAgentName returns 'Gemini' for the gemini agent type", () => {
    // The previous shape was a binary ternary `codex ? "Codex" : "Claude Code"`,
    // which silently rendered "Claude Code" for any unrecognized agent type.
    const lockedAgentNameIdx = agentChatTsx.indexOf("const lockedAgentName");
    expect(lockedAgentNameIdx).toBeGreaterThan(-1);
    const fnBlock = agentChatTsx.slice(lockedAgentNameIdx, lockedAgentNameIdx + 400);
    expect(fnBlock).toMatch(/case\s+"gemini":\s*\n\s*return\s+"Gemini"/);
  });

  it("gemini-runtime advertises a non-empty availableModels list", () => {
    // The model picker only renders when availableModels.length > 0.
    // buildSessionStatus must report at least one model so the UI shows
    // the "Gemini 2.5 Pro" label instead of falling through to the
    // hidden-picker / wrong-label state.
    expect(geminiRuntimeMjs).toContain("GEMINI_AVAILABLE_MODELS");
    expect(geminiRuntimeMjs).toContain("gemini-2.5-pro");
    // buildSessionStatus must reference the constant, not the empty array.
    const buildIdx = geminiRuntimeMjs.indexOf("function buildSessionStatus");
    expect(buildIdx).toBeGreaterThan(-1);
    const fn = geminiRuntimeMjs.slice(buildIdx, buildIdx + 800);
    expect(fn).toContain("availableModels: GEMINI_AVAILABLE_MODELS");
    // Negative: must NOT be the empty array literal anymore.
    expect(fn).not.toMatch(/availableModels:\s*\[\s*\]/);
  });
});
