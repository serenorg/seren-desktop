// ABOUTME: Regression coverage for debug-gating noisy AgentRuntime event receipt logs.
// ABOUTME: Keeps toolCall/toolResult console spam silent unless explicitly enabled.

import { describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_EVENT_DEBUG_KEY,
  shouldLogAgentRuntimeEvent,
} from "@/lib/agent-runtime-debug";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem(key: string) {
      return key === AGENT_RUNTIME_EVENT_DEBUG_KEY ? value : null;
    },
  };
}

describe("AgentRuntime event debug logging", () => {
  it("is silent by default for high-frequency tool events", () => {
    expect(shouldLogAgentRuntimeEvent("toolCall", storageWith(null))).toBe(
      false,
    );
    expect(shouldLogAgentRuntimeEvent("toolResult", storageWith(null))).toBe(
      false,
    );
  });

  it("logs runtime events when the debug toggle is enabled", () => {
    expect(shouldLogAgentRuntimeEvent("toolCall", storageWith("true"))).toBe(
      true,
    );
    expect(shouldLogAgentRuntimeEvent("toolResult", storageWith("1"))).toBe(
      true,
    );
  });

  it("keeps messageChunk suppressed even when event debug logging is enabled", () => {
    expect(
      shouldLogAgentRuntimeEvent("messageChunk", storageWith("true")),
    ).toBe(false);
  });
});
