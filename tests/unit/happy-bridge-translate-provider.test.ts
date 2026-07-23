// ABOUTME: Exhaustively verifies provider-runtime to neutral session translation.
// ABOUTME: This is the single authoritative provider-side mapping test.

import { describe, expect, it } from "vitest";

// @ts-expect-error — the bridge seam is plain ESM and has no generated declarations.
import {
  createProviderSource,
  translateProviderEvent,
} from "../../bin/happy-bridge/provider-source.mjs";

const mappings = [
  ["provider://message-chunk", "assistant-delta"],
  ["provider://user-message", "user-message"],
  ["provider://tool-call", "tool-start"],
  ["provider://tool-result", "tool-end"],
  ["provider://diff", "file-diff"],
  ["provider://diff-proposal", "diff-proposal"],
  ["provider://diff-proposal-resolved", "diff-proposal-resolved"],
  ["provider://plan-update", "plan-update"],
  ["provider://permission-request", "permission-request"],
  ["provider://permission-resolved", "permission-resolved"],
  ["provider://prompt-complete", "turn-complete"],
  ["provider://session-status", "status"],
  ["provider://error", "error"],
] as const;

describe("provider-to-neutral session event translation", () => {
  it.each(mappings)("maps %s to %s", (method, kind) => {
    expect(
      translateProviderEvent(method, {
        sessionId: "session-1",
        value: "preserved",
      }),
    ).toEqual({
      kind,
      sessionId: "session-1",
      payload: { value: "preserved" },
    });
  });

  it.each([
    "provider://config-options-update",
    "provider://mcp-degraded",
    "provider://cli-install-progress",
    "provider://unknown",
  ])("drops unmapped event %s", (method) => {
    expect(translateProviderEvent(method, { sessionId: "session-1" })).toBeNull();
  });

  it("drops mapped notifications without a session id", () => {
    expect(translateProviderEvent("provider://message-chunk", { text: "x" })).toBeNull();
  });

  it("preserves remote origin attribution in provider payloads", () => {
    expect(
      translateProviderEvent("provider://permission-resolved", {
        sessionId: "session-1",
        origin: "remote",
        requestId: "request-1",
        resolution: { optionId: "accept", source: "remote" },
      }),
    ).toEqual({
      kind: "permission-resolved",
      sessionId: "session-1",
      payload: {
        origin: "remote",
        requestId: "request-1",
        resolution: { optionId: "accept", source: "remote" },
      },
    });
  });

  it("sends remote origin on bridge prompts and approval responses", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const source = createProviderSource({
      config: { machineName: "test-machine" },
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push([method, params]);
          return method === "provider_submit_prompt"
            ? { accepted: true, sessionId: params.sessionId }
            : [];
        },
        subscribeNotifications: () => () => {},
      },
    });

    await expect(source.sendPrompt("session-1", "hello")).resolves.toEqual({
      accepted: true,
      sessionId: "session-1",
    });
    await source.terminate("session-1");
    await source.respondToPermission("session-1", "request-1", "allow_once");

    expect(calls).toEqual([
      [
        "provider_submit_prompt",
        { sessionId: "session-1", prompt: "hello", origin: "remote" },
      ],
      ["provider_terminate", { sessionId: "session-1" }],
      [
        "provider_respond_to_permission",
        {
          sessionId: "session-1",
          requestId: "request-1",
          optionId: "allow_once",
          origin: "remote",
        },
      ],
    ]);
  });

  it("fails closed when the provider does not explicitly accept a prompt", async () => {
    const source = createProviderSource({
      config: { machineName: "test-machine" },
      client: {
        call: async () => ({ accepted: false }),
        subscribeNotifications: () => () => {},
      },
    });

    await expect(source.sendPrompt("session-1", "hello")).rejects.toThrow(
      /did not acknowledge prompt acceptance/,
    );
  });

  it("marks exact restores and applies persisted permission mode before returning", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const source = createProviderSource({
      config: { machineName: "test-machine" },
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push([method, params]);
          if (method === "provider_spawn") {
            return {
              id: "local-session",
              agentType: "codex",
              cwd: "/project",
              status: "ready",
              agentSessionId: "native-session",
              reused: true,
              owned: false,
            };
          }
          return null;
        },
        subscribeNotifications: () => () => {},
      },
    });

    await expect(
      source.spawn({
        agentType: "codex",
        cwd: "/project",
        localSessionId: "local-session",
        resumeAgentSessionId: "native-session",
        initialModelId: "model-1",
        permissionMode: "bypassPermissions",
      }),
    ).resolves.toMatchObject({
      sessionId: "local-session",
      agentSessionId: "native-session",
      reused: true,
      owned: false,
    });

    expect(calls).toEqual([
      [
        "provider_spawn",
        expect.objectContaining({
          localSessionId: "local-session",
          resumeAgentSessionId: "native-session",
          requireExactResume: true,
          suppressHistoryReplay: true,
          freshContextReset: false,
          initialModelId: "model-1",
        }),
      ],
      [
        "provider_set_permission_mode",
        {
          sessionId: "local-session",
          mode: "auto",
        },
      ],
    ]);
  });

  it("requires a native ID from a fresh context-reset spawn", async () => {
    const source = createProviderSource({
      config: { machineName: "test-machine" },
      client: {
        call: async () => ({
          id: "local-session",
          agentType: "claude-code",
          cwd: "/project",
          status: "ready",
          owned: true,
        }),
        subscribeNotifications: () => () => {},
      },
    });

    await expect(
      source.spawn({
        agentType: "claude-code",
        cwd: "/project",
        localSessionId: "local-session",
        freshContextReset: true,
      }),
    ).rejects.toThrow(/did not produce a native agent session ID/);
  });

  it("retires a reused ACP provider when saved permission mode is rejected", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const source = createProviderSource({
      config: { machineName: "test-machine" },
      client: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push([method, params]);
          if (method === "provider_spawn") {
            return {
              id: "local-acp-session",
              agentType: "gemini",
              cwd: "/project",
              status: "ready",
              agentSessionId: "fresh-acp-native",
              reused: true,
              owned: false,
            };
          }
          if (method === "provider_set_permission_mode") {
            throw new Error("synthetic ACP set_mode rejection");
          }
          return null;
        },
        subscribeNotifications: () => () => {},
      },
    });

    await expect(
      source.spawn({
        agentType: "gemini",
        cwd: "/project",
        localSessionId: "local-acp-session",
        freshContextReset: true,
        permissionMode: "plan",
      }),
    ).rejects.toThrow("synthetic ACP set_mode rejection");

    expect(calls).toEqual([
      ["provider_spawn", expect.objectContaining({ freshContextReset: true })],
      [
        "provider_set_permission_mode",
        { sessionId: "local-acp-session", mode: "plan" },
      ],
      ["provider_terminate", { sessionId: "local-acp-session" }],
    ]);
  });
});
