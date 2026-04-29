// ABOUTME: Critical regression test for #1729 — Task subagent assistant
// ABOUTME: messages must not mutate the parent session's currentModelId.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeRuntime = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

describe("#1729 subagent guard — Task subagent message.model does not leak into parent session", () => {
  it("handleAssistantMessage skips chooseUpdatedModelId when payload.parent_tool_use_id is set", () => {
    // Stream-json from Claude Code emits subagent assistant messages on the
    // same stdout as the parent. Subagents default to claude-haiku-4-5, and
    // their envelope has parent_tool_use_id set. Without this guard, the
    // #1635 "message.model is ground truth" rule adopts the subagent's model
    // as the parent session's model and the picker visibly flips to haiku
    // mid-conversation. The guard must wrap the chooseUpdatedModelId call
    // and the session.currentModelId assignment — tool-call / chunk paths
    // are unchanged.
    const fnIdx = claudeRuntime.indexOf("function handleAssistantMessage(");
    expect(fnIdx).toBeGreaterThan(0);
    const region = claudeRuntime.slice(fnIdx, fnIdx + 4000);

    // The guard reads parent_tool_use_id off the envelope.
    expect(region).toMatch(/parent_tool_use_id/);

    // The chooseUpdatedModelId call lives inside the guard, not above it.
    // We pin this by requiring parent_tool_use_id to appear before the
    // chooseUpdatedModelId call site within the function body.
    const parentIdx = region.indexOf("parent_tool_use_id");
    const chooseIdx = region.indexOf("chooseUpdatedModelId(");
    expect(parentIdx).toBeGreaterThan(0);
    expect(chooseIdx).toBeGreaterThan(parentIdx);
  });
});
