// ABOUTME: Critical regression guards for #1480 — Gemini Agent bottom controls.
// ABOUTME: Guards locked agent controls and Gemini ACP model-catalog passthrough.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - acp-runtime.mjs is a plain ESM harness without type declarations
import { _applyAcpModelState } from "../../bin/browser-local/acp-runtime.mjs";

const agentChatTsx = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
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

  it("uses the model catalog returned by Gemini session/new verbatim", () => {
    const session = {
      currentModelId: "stale-model",
      availableModels: [{ modelId: "stale-model", name: "Stale" }],
      cliModels: [],
    };

    expect(
      _applyAcpModelState(session, {
        currentModelId: "gemini-cli-current",
        availableModels: [
          {
            modelId: "gemini-cli-current",
            name: "Gemini CLI current",
            description: "Returned by the installed CLI",
          },
          { modelId: "gemini-cli-next", name: "Gemini CLI next" },
        ],
      }),
    ).toBe(true);
    expect(session).toEqual({
      currentModelId: "gemini-cli-current",
      availableModels: [
        {
          modelId: "gemini-cli-current",
          name: "Gemini CLI current",
          description: "Returned by the installed CLI",
        },
        { modelId: "gemini-cli-next", name: "Gemini CLI next" },
      ],
      cliModels: [
        {
          modelId: "gemini-cli-current",
          name: "Gemini CLI current",
          description: "Returned by the installed CLI",
        },
        { modelId: "gemini-cli-next", name: "Gemini CLI next" },
      ],
    });
  });
});
