// ABOUTME: Critical contract tests for the Antigravity migration (#3648).
// ABOUTME: Protects verified releases, resumable headless args, and stream event translation.

import { describe, expect, it } from "vitest";
// @ts-ignore - browser-local runtime is plain ESM without declarations.
import { _validateAntigravityManifest } from "../../bin/browser-local/antigravity-binary.mjs";
// @ts-ignore - browser-local runtime is plain ESM without declarations.
import * as antigravityRuntime from "../../bin/browser-local/gemini-runtime.mjs";

const {
  buildAntigravityArgs,
  handleAntigravityEvent,
  normalizeAntigravityModels,
} = antigravityRuntime;

describe("Antigravity verified release contract", () => {
  const manifest = {
    version: "1.1.10",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.10/build/agy.exe",
    sha512: "a".repeat(128),
  };

  it("accepts only a supported Google-hosted artifact with a SHA-512 digest", () => {
    expect(_validateAntigravityManifest(manifest).version).toBe("1.1.10");
    expect(() =>
      _validateAntigravityManifest({
        ...manifest,
        url: "https://example.com/agy.exe",
      }),
    ).toThrow(/untrusted artifact URL/);
    expect(() =>
      _validateAntigravityManifest({ ...manifest, sha512: "abcd" }),
    ).toThrow(/manifest is invalid/);
    expect(() =>
      _validateAntigravityManifest({ ...manifest, version: "1.1.7" }),
    ).toThrow(/below Seren's 1.1.8 minimum/);
  });
});

describe("Antigravity resumable headless contract", () => {
  it("passes the selected model, conversation, mode, and sandbox explicitly", () => {
    const args = buildAntigravityArgs(
      {
        timeoutSecs: 90,
        agentSessionId: "conversation-123",
        currentModelId: "gemini-3.1-pro",
        currentModeId: "accept-edits",
        sandboxMode: "workspace-write",
      },
      "Fix the bug",
    );

    expect(args).toEqual([
      "--print",
      "Fix the bug",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "90s",
      "--conversation",
      "conversation-123",
      "--model",
      "gemini-3.1-pro",
      "--mode",
      "accept-edits",
      "--sandbox",
    ]);
  });

  it("preserves every model printed by the authenticated CLI", () => {
    expect(
      normalizeAntigravityModels(
        [
          "gemini-3.6-flash-high",
          "claude-opus-4-6-thinking",
          "gpt-oss-120b-medium",
        ].join("\n"),
      ),
    ).toEqual([
      { modelId: "gemini-3.6-flash-high", name: "gemini-3.6-flash-high" },
      {
        modelId: "claude-opus-4-6-thinking",
        name: "claude-opus-4-6-thinking",
      },
      { modelId: "gpt-oss-120b-medium", name: "gpt-oss-120b-medium" },
    ]);
  });
});

describe("Antigravity structured stream translation", () => {
  it("captures the native conversation and emits only incremental text", () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const emit = (name: string, payload: Record<string, unknown>) => {
      events.push({ name, payload });
    };
    const session = {
      id: "local-session",
      agentSessionId: undefined,
      currentModelId: null,
      stepText: new Map(),
      assistantText: "",
      resultEvent: null,
      resultError: null,
      usageMeta: null,
    };

    handleAntigravityEvent(emit, session, {
      type: "init",
      conversation_id: "conversation-123",
      model: "gemini-3.1-pro",
    });
    handleAntigravityEvent(emit, session, {
      type: "step_update",
      step_id: "answer",
      step_type: "assistant_message",
      content: "Hello",
    });
    handleAntigravityEvent(emit, session, {
      type: "step_update",
      step_id: "answer",
      step_type: "assistant_message",
      content: "Hello world",
    });
    handleAntigravityEvent(emit, session, {
      type: "result",
      result: "Hello world",
      usage: { input_tokens: 12, output_tokens: 2, cache_read_tokens: 5 },
    });

    expect(session.agentSessionId).toBe("conversation-123");
    expect(session.currentModelId).toBe("gemini-3.1-pro");
    expect(
      events
        .filter((event) => event.name === "provider://message-chunk")
        .map((event) => event.payload.text),
    ).toEqual(["Hello", " world"]);
    expect(session.usageMeta).toEqual({
      usage: { input_tokens: 12, output_tokens: 2, cache_read_tokens: 5 },
    });
  });
});
