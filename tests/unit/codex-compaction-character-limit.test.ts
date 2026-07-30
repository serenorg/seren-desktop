// ABOUTME: Regression coverage for #3475 — Codex reactive compaction retries
// ABOUTME: must fit the App Server turn/start character limit after prepending context.

import {
  buildAgentCompactionPrepend,
  CODEX_TURN_INPUT_MAX_CHARS,
  maxAgentCompactionPrependChars,
  wrapAgentCompactionPrepend,
} from "@/lib/agent/compaction";
import type { AgentMessage } from "@/stores/agent.store";
import { describe, expect, it } from "vitest";

function message(
  id: string,
  type: "user" | "assistant",
  content: string,
): AgentMessage {
  return { id, type, content, timestamp: 0 };
}

describe("#3475 — Codex compaction retry character budget", () => {
  it("keeps the final retry within turn/start's limit and retains newest context", () => {
    const oldestMarker = "OLDEST_CONTEXT";
    const newestMarker = "NEWEST_PRIOR_CONTEXT";
    const activePrompt = `ACTIVE_FAILED_REQUEST_${"p".repeat(300_000)}`;
    const preserved: AgentMessage[] = [
      message("oldest", "assistant", `${oldestMarker}${"a".repeat(3_000)}`),
    ];

    for (let index = 0; index < 429; index++) {
      preserved.push(
        message(
          `middle-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          `middle-${index}-${"m".repeat(3_000)}`,
        ),
      );
    }
    preserved.push(
      message("newest", "assistant", `${newestMarker}${"n".repeat(3_000)}`),
      message("active", "user", activePrompt),
    );

    const maxChars = maxAgentCompactionPrependChars("codex", activePrompt);
    expect(maxChars).toBeTypeOf("number");

    const prepend = buildAgentCompactionPrepend("bounded summary", preserved, {
      maxChars,
      omitTrailingUser: true,
    });
    const retry = wrapAgentCompactionPrepend(prepend, activePrompt);

    expect(retry.length).toBeLessThanOrEqual(CODEX_TURN_INPUT_MAX_CHARS);
    expect(prepend).toContain(newestMarker);
    expect(prepend).not.toContain(oldestMarker);
    expect(prepend).not.toContain("ACTIVE_FAILED_REQUEST_");
    expect(retry.match(/ACTIVE_FAILED_REQUEST_/g)).toHaveLength(1);
  });

  it("does not impose the Codex character ceiling on other agents", () => {
    expect(
      maxAgentCompactionPrependChars("claude-code", "prompt"),
    ).toBeUndefined();
  });
});
